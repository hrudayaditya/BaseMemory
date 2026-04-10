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

function jitteredBackoffDelayMs(attempt: number): number {
  const baseDelay = VOYAGE_BACKOFF_BASE_MS * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * ((VOYAGE_BACKOFF_JITTER_MS * 2) + 1)) - VOYAGE_BACKOFF_JITTER_MS;
  return Math.max(0, baseDelay + jitter);
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

function isOpenAICompatibleEmbeddingResponse(
  payload: unknown
): payload is { data: Array<{ embedding: number[] }>; usage?: { total_tokens?: number } } {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) && data.every((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const embedding = (entry as { embedding?: unknown }).embedding;
    return Array.isArray(embedding) && embedding.every((value) => typeof value === "number");
  });
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
      const batchResult = await this.embedBatchWithRetry(batch, inputType, batchIndex, totalBatches);

      if (!batchResult) {
        return null;
      }

      embeddings.push(...batchResult.embeddings);
      totalTokensUsed += batchResult.totalTokensUsed;
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }

  private async embedBatchWithRetry(
    batch: string[],
    inputType: EmbeddingInputType,
    batchIndex: number,
    totalBatches: number
  ): Promise<EmbeddingBatchResult | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= VOYAGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.executeBatchRequest(batch, inputType);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === VOYAGE_MAX_ATTEMPTS) {
          break;
        }

        await this.sleep(jitteredBackoffDelayMs(attempt));
      }
    }

    console.error(
      `[voyage-embeddings] Failed batch ${batchIndex + 1}/${totalBatches} (${batch.length} texts) ` +
      `after ${VOYAGE_MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`
    );
    return null;
  }

  private async executeBatchRequest(
    batch: string[],
    inputType: EmbeddingInputType
  ): Promise<EmbeddingBatchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VOYAGE_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(VOYAGE_EMBEDDING_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: batch,
          model: this.modelInfo.model,
          input_type: inputType,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Voyage embedding API request timed out after ${VOYAGE_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Voyage embedding API error: ${response.status} - ${errorText}`);
    }

    const payload = await response.json() as unknown;
    let embeddings: number[][];
    let totalTokensUsed: number;

    if (isVoyageEmbeddingsResponse(payload)) {
      embeddings = payload.embeddings.map((embedding) => normalizeEmbeddingVector(embedding));
      totalTokensUsed = payload.total_tokens ?? estimateTokenCount(batch);
    } else if (isOpenAICompatibleEmbeddingResponse(payload)) {
      embeddings = payload.data.map((entry) => normalizeEmbeddingVector(entry.embedding));
      totalTokensUsed = payload.usage?.total_tokens ?? estimateTokenCount(batch);
    } else {
      throw new Error("Voyage embedding API returned unexpected response format");
    }

    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: sent ${batch.length} texts but received ${embeddings.length} embeddings`
      );
    }

    if (embeddings.length > 0 && embeddings[0]?.length !== this.modelInfo.dimensions) {
      throw new Error(
        `Dimension mismatch: expected ${this.modelInfo.dimensions} dimensions for ${this.modelInfo.model}, ` +
        `but received ${embeddings[0]?.length ?? 0}`
      );
    }

    return {
      embeddings,
      totalTokensUsed,
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
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
export class CustomProviderNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomProviderNonRetryableError';
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
    const token = this.getToken();

    const response = await fetch(`${this.credentials.baseUrl}/inference/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        model: `openai/${this.modelInfo.model}`,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub Copilot embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return {
      embeddings: data.data.map((d) => d.embedding),
      totalTokensUsed: data.usage.total_tokens,
    };
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
    const response = await fetch(`${this.credentials.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelInfo.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return {
      embeddings: data.data.map((d) => d.embedding),
      totalTokensUsed: data.usage.total_tokens,
    };
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

    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const requests = batch.map((text) => ({
          model: `models/${this.modelInfo.model}`,
          content: {
            parts: [{ text }],
          },
          taskType,
          outputDimensionality: this.modelInfo.dimensions,
        }));

        const response = await fetch(
          `${this.credentials.baseUrl}/models/${this.modelInfo.model}:batchEmbedContents?key=${this.credentials.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ requests }),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Google embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embeddings: Array<{ values: number[] }>;
        };

        return {
          embeddings: data.embeddings.map((e) => e.values),
          tokensUsed: batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        };
      })
    );

    return {
      embeddings: batchResults.flatMap((r) => r.embeddings),
      totalTokensUsed: batchResults.reduce((sum, r) => sum + r.tokensUsed, 0),
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
    const results = await Promise.all(
      texts.map(async (text) => {
        const response = await fetch(`${this.credentials.baseUrl}/api/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.modelInfo.model,
            prompt: text,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Ollama embedding API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as {
          embedding: number[];
        };

        return {
          embedding: data.embedding,
          tokensUsed: Math.ceil(text.length / 4),
        };
      })
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
      return {
        embeddings: [],
        totalTokensUsed: 0,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.credentials.apiKey) {
      headers["Authorization"] = `Bearer ${this.credentials.apiKey}`;
    }

    // baseUrl is already normalized (trailing slashes stripped) by parseConfig().
    const baseUrl = this.credentials.baseUrl ?? '';
    const timeoutMs = this.modelInfo.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const preparedTexts = this.prepareTextsForInputType(texts, inputType);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.modelInfo.model,
          input: preparedTexts,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Custom embedding API request timed out after ${timeoutMs}ms for ${baseUrl}/embeddings`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      // Throw non-retryable error for client errors (4xx) except 429 (rate limit).
      // The Indexer uses pRetry which retries all errors by default; marking 4xx as
      // non-retryable prevents long retry loops on bad API keys or invalid models.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new CustomProviderNonRetryableError(`Custom embedding API error (non-retryable): ${response.status} - ${errorText}`);
      }
      throw new Error(`Custom embedding API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      data?: Array<{ embedding: number[] }>;
      usage?: { total_tokens: number };
    };

    if (data.data && Array.isArray(data.data)) {
      // Always validate dimensions — the vector store is initialized with a fixed
      // dimension count, so mismatched vectors will corrupt the index or crash usearch.
      if (data.data.length > 0) {
        const actualDims = data.data[0].embedding.length;
        if (actualDims !== this.modelInfo.dimensions) {
          throw new Error(
            `Dimension mismatch: customProvider.dimensions is ${this.modelInfo.dimensions}, ` +
            `but the API returned vectors with ${actualDims} dimensions. ` +
            `Update your config to match the model's actual output dimensions.`
          );
        }
      }

      // Validate the server returned exactly as many embeddings as we sent texts.
      // A mismatch would cause undefined vectors in store.addBatch, corrupting the index.
      if (data.data.length !== preparedTexts.length) {
        throw new Error(
          `Embedding count mismatch: sent ${preparedTexts.length} texts but received ${data.data.length} embeddings. ` +
          `The custom embedding server may not support batch input.`
        );
      }

      return {
        embeddings: data.data.map((d) => d.embedding),
        // Rough estimate: ~4 chars per token. Used as fallback when the server
        // doesn't return usage.total_tokens (e.g. llama.cpp, some vLLM configs).
        totalTokensUsed: data.usage?.total_tokens ?? texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
      };
    }

    // Fallback: some servers return a flat embedding array for single inputs
    throw new Error("Custom embedding API returned unexpected response format. Expected OpenAI-compatible format with data[].embedding.");
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
