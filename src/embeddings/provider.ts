import { EmbeddingProviderModelInfo, BaseModelInfo } from "../config/schema.js";
import { ConfiguredProviderInfo, CustomModelInfo, ProviderCredentials } from "./detector.js";

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  totalTokensUsed: number;
}

type EmbeddingInputType = "query" | "document";

export interface EmbeddingProviderInterface {
  embedQuery(query: string): Promise<EmbeddingResult>;
  embedDocument(document: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
  getModelInfo(): BaseModelInfo;
}

export interface VoyageProviderConfig {
  voyageApiKey?: string;
  voyageModelId?: string;
}

const ARCTIC_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const VOYAGE_EMBEDDING_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_DEFAULT_MODEL_ID = "voyage-code-2";
const VOYAGE_MAX_BATCH_SIZE = 128;
const OLLAMA_MAX_CONCURRENT_REQUESTS = 4;
const GOOGLE_MAX_CONCURRENT_BATCHES = 4;
const DEFAULT_EMBEDDING_MAX_ATTEMPTS = 3;
const DEFAULT_EMBEDDING_BACKOFF_BASE_MS = 1_000;
const DEFAULT_EMBEDDING_BACKOFF_JITTER_MS = 200;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
const OLLAMA_EMBEDDING_TIMEOUT_MS = 60_000;
const VOYAGE_MAX_ATTEMPTS = 3;
const VOYAGE_BACKOFF_BASE_MS = 1_000;
const VOYAGE_BACKOFF_JITTER_MS = 200;
const VOYAGE_TIMEOUT_MS = 30_000;

const VOYAGE_MODEL_SPECS: Record<string, BaseModelInfo> = {
  "voyage-code-2": {
    model: "voyage-code-2",
    dimensions: 1536,
    maxTokens: 16_000,
    costPer1MTokens: 0.12,
  },
  "voyage-code-3": {
    model: "voyage-code-3",
    dimensions: 1024,
    maxTokens: 32_000,
    costPer1MTokens: 0.18,
  },
};

function normalizeEmbeddingVector(raw: number[]): number[] {
  return Array.from(Float32Array.from(raw));
}

function estimateTokenCount(texts: string[]): number {
  return texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
}

function emptyEmbeddingBatchResult(): EmbeddingBatchResult {
  return {
    embeddings: [],
    totalTokensUsed: 0,
  };
}

function jitteredBackoffDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_EMBEDDING_BACKOFF_BASE_MS,
  jitterMs = DEFAULT_EMBEDDING_BACKOFF_JITTER_MS
): number {
  const baseDelay = baseDelayMs * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * ((jitterMs * 2) + 1)) - jitterMs;
  return Math.max(0, baseDelay + jitter);
}

export class EmbeddingTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingTransientError";
  }
}

export class EmbeddingPermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingPermanentError";
  }
}

export class EmbeddingValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingValidationError";
  }
}

interface AdaptedEmbeddingPayload {
  embeddings: number[][];
  totalTokensUsed?: number;
}

interface EmbeddingHttpRequestOptions {
  providerLabel: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  expectedEmbeddingCount: number;
  expectedDimensions: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffJitterMs?: number;
  tokenEstimateTexts: string[];
  responseAdapter: (payload: unknown) => AdaptedEmbeddingPayload;
  nonRetryableErrorFactory?: (message: string) => Error;
}

function ensureArrayOfNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function throwMalformedEmbeddingResponse(providerLabel: string, message: string): never {
  throw new EmbeddingValidationError(`${providerLabel} embedding API returned malformed response: ${message}`);
}

function adaptOpenAICompatibleEmbeddingResponse(
  payload: unknown,
  providerLabel: string
): AdaptedEmbeddingPayload {
  if (!payload || typeof payload !== "object") {
    throwMalformedEmbeddingResponse(providerLabel, "expected an object payload");
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throwMalformedEmbeddingResponse(providerLabel, "missing data[] embeddings array");
  }

  const embeddings = data.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throwMalformedEmbeddingResponse(providerLabel, `data[${index}] is not an object`);
    }

    const embedding = (entry as { embedding?: unknown }).embedding;
    if (!ensureArrayOfNumbers(embedding)) {
      throwMalformedEmbeddingResponse(providerLabel, `data[${index}].embedding is not a numeric vector`);
    }

    return embedding;
  });

  const usage = (payload as { usage?: { total_tokens?: unknown } }).usage;
  return {
    embeddings,
    totalTokensUsed: typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined,
  };
}

function adaptVoyageEmbeddingResponse(payload: unknown, providerLabel: string): AdaptedEmbeddingPayload {
  if (isVoyageEmbeddingsResponse(payload)) {
    return {
      embeddings: payload.embeddings,
      totalTokensUsed: payload.total_tokens,
    };
  }

  return adaptOpenAICompatibleEmbeddingResponse(payload, providerLabel);
}

function adaptGoogleEmbeddingResponse(payload: unknown, providerLabel: string): AdaptedEmbeddingPayload {
  if (!payload || typeof payload !== "object") {
    throwMalformedEmbeddingResponse(providerLabel, "expected an object payload");
  }

  const embeddings = (payload as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings)) {
    throwMalformedEmbeddingResponse(providerLabel, "missing embeddings[] array");
  }

  return {
    embeddings: embeddings.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throwMalformedEmbeddingResponse(providerLabel, `embeddings[${index}] is not an object`);
      }

      const values = (entry as { values?: unknown }).values;
      if (!ensureArrayOfNumbers(values)) {
        throwMalformedEmbeddingResponse(providerLabel, `embeddings[${index}].values is not a numeric vector`);
      }

      return values;
    }),
  };
}

function adaptOllamaEmbeddingResponse(payload: unknown, providerLabel: string): AdaptedEmbeddingPayload {
  if (!payload || typeof payload !== "object") {
    throwMalformedEmbeddingResponse(providerLabel, "expected an object payload");
  }

  const embedding = (payload as { embedding?: unknown }).embedding;
  if (!ensureArrayOfNumbers(embedding)) {
    throwMalformedEmbeddingResponse(providerLabel, "missing embedding vector");
  }

  return {
    embeddings: [embedding],
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableEmbeddingError(error: unknown): boolean {
  return error instanceof EmbeddingTransientError;
}

function normalizeRetryableFetchError(
  providerLabel: string,
  error: unknown,
  timeoutMs: number
): EmbeddingTransientError {
  if (error instanceof EmbeddingTransientError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new EmbeddingTransientError(
      `${providerLabel} embedding request timed out after ${timeoutMs}ms`,
      { cause: error }
    );
  }

  if (error instanceof Error) {
    return new EmbeddingTransientError(
      `${providerLabel} embedding request failed: ${error.message}`,
      { cause: error }
    );
  }

  return new EmbeddingTransientError(
    `${providerLabel} embedding request failed: ${String(error)}`
  );
}

async function parseJsonPayload(providerLabel: string, response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw new EmbeddingValidationError(
      `${providerLabel} embedding API returned malformed JSON`,
      { cause: error }
    );
  }
}

async function executeEmbeddingRequest(
  options: EmbeddingHttpRequestOptions
): Promise<EmbeddingBatchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    throw normalizeRetryableFetchError(options.providerLabel, error, timeoutMs);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const message = `${options.providerLabel} embedding API error: ${response.status} - ${errorText || response.statusText || "unknown error"}`;

    if (response.status === 429 || response.status >= 500) {
      throw new EmbeddingTransientError(message);
    }

    if (options.nonRetryableErrorFactory) {
      throw options.nonRetryableErrorFactory(message);
    }

    throw new EmbeddingPermanentError(message);
  }

  const payload = await parseJsonPayload(options.providerLabel, response);
  const adapted = options.responseAdapter(payload);
  const embeddings = adapted.embeddings.map((embedding, index) => {
    if (!ensureArrayOfNumbers(embedding)) {
      throw new EmbeddingValidationError(
        `${options.providerLabel} embedding API returned a non-numeric vector at index ${index}`
      );
    }

    if (embedding.length !== options.expectedDimensions) {
      throw new EmbeddingValidationError(
        `Dimension mismatch: expected ${options.expectedDimensions} dimensions for ` +
        `${options.providerLabel}, but received ${embedding.length}`
      );
    }

    return normalizeEmbeddingVector(embedding);
  });

  if (embeddings.length !== options.expectedEmbeddingCount) {
    throw new EmbeddingValidationError(
      `Embedding count mismatch: sent ${options.expectedEmbeddingCount} texts but received ${embeddings.length} embeddings`
    );
  }

  return {
    embeddings,
    totalTokensUsed: adapted.totalTokensUsed ?? estimateTokenCount(options.tokenEstimateTexts),
  };
}

async function requestEmbeddingsWithRetry(
  options: EmbeddingHttpRequestOptions
): Promise<EmbeddingBatchResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_EMBEDDING_MAX_ATTEMPTS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await executeEmbeddingRequest(options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryableEmbeddingError(lastError) || attempt === maxAttempts) {
        throw lastError;
      }

      await sleep(
        jitteredBackoffDelayMs(
          attempt,
          options.backoffBaseMs ?? DEFAULT_EMBEDDING_BACKOFF_BASE_MS,
          options.backoffJitterMs ?? DEFAULT_EMBEDDING_BACKOFF_JITTER_MS
        )
      );
    }
  }

  throw lastError ?? new EmbeddingTransientError(`${options.providerLabel} embedding request failed`);
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function isVoyageEmbeddingsResponse(
  payload: unknown
): payload is { embeddings: number[][]; total_tokens?: number } {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const embeddings = (payload as { embeddings?: unknown }).embeddings;
  return Array.isArray(embeddings) && embeddings.every((embedding) =>
    Array.isArray(embedding) && embedding.every((value) => typeof value === "number")
  );
}

export class VoyageEmbeddingProvider {
  private readonly apiKey?: string;
  private readonly modelInfo: BaseModelInfo;
  private readonly hasUsableApiKey: boolean;

  constructor(config: VoyageProviderConfig) {
    this.apiKey = config.voyageApiKey?.trim() || undefined;
    const modelId = config.voyageModelId?.trim() || VOYAGE_DEFAULT_MODEL_ID;
    this.modelInfo = VOYAGE_MODEL_SPECS[modelId] ?? {
      model: modelId,
      dimensions: 1024,
      maxTokens: 32_000,
      costPer1MTokens: 0,
    };
    this.hasUsableApiKey = Boolean(this.apiKey);

    if (!this.hasUsableApiKey) {
      console.warn(
        `[voyage-embeddings] voyageApiKey is missing; ${this.modelInfo.model} embeddings are disabled until a key is configured.`
      );
    }
  }

  async embedQuery(query: string): Promise<EmbeddingResult | null> {
    const result = await this.embedTexts([query], "query");
    if (!result) {
      return null;
    }

    return {
      embedding: result.embeddings[0] ?? [],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult | null> {
    const result = await this.embedTexts([document], "document");
    if (!result) {
      return null;
    }

    return {
      embedding: result.embeddings[0] ?? [],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult | null> {
    return this.embedTexts(texts, "document");
  }

  getModelInfo(): BaseModelInfo {
    return this.modelInfo;
  }

  private async embedTexts(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingBatchResult | null> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalTokensUsed: 0,
      };
    }

    if (!this.hasUsableApiKey) {
      return null;
    }

    const embeddings: number[][] = [];
    let totalTokensUsed = 0;
    const totalBatches = Math.ceil(texts.length / VOYAGE_MAX_BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      const start = batchIndex * VOYAGE_MAX_BATCH_SIZE;
      const batch = texts.slice(start, start + VOYAGE_MAX_BATCH_SIZE);
      const batchResult = await this.executeBatchRequest(batch, inputType);

      embeddings.push(...batchResult.embeddings);
      totalTokensUsed += batchResult.totalTokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }

  private async executeBatchRequest(
    batch: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingBatchResult> {
    return requestEmbeddingsWithRetry({
      providerLabel: "Voyage",
      url: VOYAGE_EMBEDDING_ENDPOINT,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        input: batch,
        model: this.modelInfo.model,
        input_type: inputType,
      },
      expectedEmbeddingCount: batch.length,
      expectedDimensions: this.modelInfo.dimensions,
      timeoutMs: VOYAGE_TIMEOUT_MS,
      maxAttempts: VOYAGE_MAX_ATTEMPTS,
      backoffBaseMs: VOYAGE_BACKOFF_BASE_MS,
      backoffJitterMs: VOYAGE_BACKOFF_JITTER_MS,
      tokenEstimateTexts: batch,
      responseAdapter: (payload) => adaptVoyageEmbeddingResponse(payload, "Voyage"),
    });
  }
}

export function createVoyageEmbeddingProvider(config: VoyageProviderConfig): VoyageEmbeddingProvider {
  return new VoyageEmbeddingProvider(config);
}

/**
 * Thrown by CustomEmbeddingProvider for HTTP 4xx errors (except 429 rate limit).
 * The Indexer's pRetry config uses instanceof to bail immediately on these errors
 * instead of retrying — preventing long retry loops on bad API keys or invalid models.
 */
export class CustomProviderNonRetryableError extends EmbeddingPermanentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CustomProviderNonRetryableError";
  }
}

export function createEmbeddingProvider(
  configuredProviderInfo: ConfiguredProviderInfo,
): EmbeddingProviderInterface {
  switch (configuredProviderInfo.provider) {
    case "github-copilot":
      return new GitHubCopilotEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "openai":
      return new OpenAIEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "google":
      return new GoogleEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "ollama":
      return new OllamaEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    case "custom":
      return new CustomEmbeddingProvider(configuredProviderInfo.credentials, configuredProviderInfo.modelInfo);
    default: {
      const _exhaustive: never = configuredProviderInfo;
      throw new Error(`Unsupported embedding provider: ${(_exhaustive as ConfiguredProviderInfo).provider}`);
    }
  }
}

class GitHubCopilotEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['github-copilot']
  ) { }

  private getToken(): string {
    if (!this.credentials.refreshToken) {
      throw new Error("No OAuth token available for GitHub");
    }
    return this.credentials.refreshToken;
  }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return emptyEmbeddingBatchResult();
    }

    const token = this.getToken();
    return requestEmbeddingsWithRetry({
      providerLabel: "GitHub Copilot",
      url: `${this.credentials.baseUrl}/inference/embeddings`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: {
        model: `openai/${this.modelInfo.model}`,
        input: texts,
      },
      expectedEmbeddingCount: texts.length,
      expectedDimensions: this.modelInfo.dimensions,
      tokenEstimateTexts: texts,
      responseAdapter: (payload) => adaptOpenAICompatibleEmbeddingResponse(payload, "GitHub Copilot"),
    });
  }

  getModelInfo(): BaseModelInfo {
    return this.modelInfo;
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['openai']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return emptyEmbeddingBatchResult();
    }

    return requestEmbeddingsWithRetry({
      providerLabel: "OpenAI",
      url: `${this.credentials.baseUrl}/embeddings`,
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        model: this.modelInfo.model,
        input: texts,
      },
      expectedEmbeddingCount: texts.length,
      expectedDimensions: this.modelInfo.dimensions,
      tokenEstimateTexts: texts,
      responseAdapter: (payload) => adaptOpenAICompatibleEmbeddingResponse(payload, "OpenAI"),
    });
  }

  getModelInfo(): BaseModelInfo {
    return this.modelInfo;
  }
}

class GoogleEmbeddingProvider implements EmbeddingProviderInterface {
  private static readonly BATCH_SIZE = 20;

  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['google']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "CODE_RETRIEVAL_QUERY" : undefined;
    const result = await this.embedWithTaskType([query], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    const result = await this.embedWithTaskType([document], taskType);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return emptyEmbeddingBatchResult();
    }

    const taskType = this.modelInfo.taskAble ? "RETRIEVAL_DOCUMENT" : undefined;
    return this.embedWithTaskType(texts, taskType);
  }

  /**
   * Embeds texts using the Google embedContent API.
   * Sends multiple texts as parts in batched requests (up to BATCH_SIZE per call).
   * When taskType is provided (gemini-embedding-001), includes it in the request
   * for task-specific embedding optimization.
   */
  private async embedWithTaskType(
    texts: string[],
    taskType?: string
  ): Promise<EmbeddingBatchResult> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += GoogleEmbeddingProvider.BATCH_SIZE) {
      batches.push(texts.slice(i, i + GoogleEmbeddingProvider.BATCH_SIZE));
    }

    const batchResults = await mapWithConcurrency(
      batches,
      GOOGLE_MAX_CONCURRENT_BATCHES,
      async (batch) => {
        const requests = batch.map((text) => ({
          model: `models/${this.modelInfo.model}`,
          content: {
            parts: [{ text }],
          },
          taskType,
          outputDimensionality: this.modelInfo.dimensions,
        }));

        return requestEmbeddingsWithRetry({
          providerLabel: "Google",
          url: `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents?key=${this.credentials.apiKey}`,
          headers: {
            "Content-Type": "application/json",
          },
          body: { requests },
          expectedEmbeddingCount: batch.length,
          expectedDimensions: this.modelInfo.dimensions,
          tokenEstimateTexts: batch,
          responseAdapter: (payload) => adaptGoogleEmbeddingResponse(payload, "Google"),
        });
      }
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.totalTokensUsed, 0),
    };
  }

  getModelInfo(): BaseModelInfo {
    return this.modelInfo;
  }
}

class OllamaEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: EmbeddingProviderModelInfo['ollama']
  ) { }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([query]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([document]);
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return emptyEmbeddingBatchResult();
    }

    const results = await mapWithConcurrency(
      texts,
      OLLAMA_MAX_CONCURRENT_REQUESTS,
      async (text) => {
        const result = await requestEmbeddingsWithRetry({
          providerLabel: "Ollama",
          url: `${this.credentials.baseUrl}/api/embeddings`,
          headers: {
            "Content-Type": "application/json",
          },
          body: {
            model: this.modelInfo.model,
            prompt: text,
          },
          expectedEmbeddingCount: 1,
          expectedDimensions: this.modelInfo.dimensions,
          timeoutMs: OLLAMA_EMBEDDING_TIMEOUT_MS,
          tokenEstimateTexts: [text],
          responseAdapter: (payload) => adaptOllamaEmbeddingResponse(payload, "Ollama"),
        });

        return {
          embedding: result.embeddings[0] ?? [],
          tokensUsed: result.totalTokensUsed,
        };
      }
    );

    return {
      embeddings: results.map((r) => r.embedding),
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    };
  }

  getModelInfo(): BaseModelInfo {
    return this.modelInfo;
  }
}

/**
 * Custom OpenAI-compatible embedding provider.
 * Works with any server that implements the OpenAI /v1/embeddings API format
 * (llama.cpp, vLLM, text-embeddings-inference, LiteLLM, etc.).
 */
class CustomEmbeddingProvider implements EmbeddingProviderInterface {
  constructor(
    private credentials: ProviderCredentials,
    private modelInfo: CustomModelInfo
  ) { }

  private splitIntoRequestBatches(texts: string[]): string[][] {
    const maxBatchSize = this.modelInfo.maxBatchSize;

    if (!maxBatchSize || texts.length <= maxBatchSize) {
      return [texts];
    }

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += maxBatchSize) {
      batches.push(texts.slice(i, i + maxBatchSize));
    }
    return batches;
  }

  private prepareTextsForInputType(
    texts: string[],
    inputType: EmbeddingInputType
  ): string[] {
    if (this.modelInfo.model === "snowflake-arctic-embed2" && inputType === "query") {
      return texts.map((text) => `${ARCTIC_QUERY_PREFIX}${text}`);
    }

    return texts;
  }

  private async embedRequest(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return emptyEmbeddingBatchResult();
    }

    const preparedTexts = this.prepareTextsForInputType(texts, inputType);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.credentials.apiKey) {
      headers.Authorization = `Bearer ${this.credentials.apiKey}`;
    }

    const baseUrl = this.credentials.baseUrl ?? "";
    return requestEmbeddingsWithRetry({
      providerLabel: "Custom",
      url: `${baseUrl}/embeddings`,
      headers,
      body: {
        model: this.modelInfo.model,
        input: preparedTexts,
      },
      expectedEmbeddingCount: preparedTexts.length,
      expectedDimensions: this.modelInfo.dimensions,
      timeoutMs: this.modelInfo.timeoutMs,
      tokenEstimateTexts: texts,
      responseAdapter: (payload) => adaptOpenAICompatibleEmbeddingResponse(payload, "Custom"),
      nonRetryableErrorFactory: (message) => new CustomProviderNonRetryableError(
        message.replace("Custom embedding API error:", "Custom embedding API error (non-retryable):")
      ),
    });
  }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    const result = await this.embedBatchInternal([query], "query");
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedDocument(document: string): Promise<EmbeddingResult> {
    const result = await this.embedBatchInternal([document], "document");
    return {
      embedding: result.embeddings[0],
      tokensUsed: result.totalTokensUsed,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    return this.embedBatchInternal(texts, "document");
  }

  private async embedBatchInternal(
    texts: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingBatchResult> {
    const requestBatches = this.splitIntoRequestBatches(texts);
    const embeddings: number[][] = [];
    let totalTokensUsed = 0;

    for (const batch of requestBatches) {
      const result = await this.embedRequest(batch, inputType);
      embeddings.push(...result.embeddings);
      totalTokensUsed += result.totalTokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }

  getModelInfo(): CustomModelInfo {
    return this.modelInfo;
  }
}
