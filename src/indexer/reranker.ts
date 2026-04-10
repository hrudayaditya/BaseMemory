import type { ChunkKind, ChunkMetadata, ChunkSymbolKind } from "../native/index.js";

import type { SearchTaskType } from "./search-recipes.js";

export const DEFAULT_LOCAL_CROSS_ENCODER_TOKENIZER = "cross-encoder/ms-marco-MiniLM-L-6-v2";
// Transformers.js v2 loads ONNX weights from a compatible mirror. The Xenova
// repo provides the quantized ONNX graph for the same cross-encoder.
export const DEFAULT_LOCAL_CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface RerankerCandidate {
  id: string;
  baseScore: number;
  metadata: ChunkMetadata;
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  relation?: "caller" | "callee";
  content: string;
}

export interface RerankerResult {
  candidates: RerankerCandidate[];
  applied: boolean;
  backend: string | null;
  failedBackend?: string | null;
}

interface ScoredCandidate {
  candidate: RerankerCandidate;
  score: number;
  originalIndex: number;
}

interface CrossEncoderPair {
  text: string;
  textPair: string;
}

type CrossEncoderScorer = (pairs: CrossEncoderPair[]) => Promise<number[]>;

type CrossEncoderLoader = () => Promise<CrossEncoderScorer | null>;

interface SequenceClassificationLogits {
  data: ArrayLike<number>;
  dims: number[];
}

interface SequenceClassificationOutput {
  logits: SequenceClassificationLogits;
}

interface SequenceClassificationConfig {
  model_type?: string;
  id2label?: Record<string, string> | string[];
}

interface SequenceClassificationModel {
  (inputs: unknown): Promise<SequenceClassificationOutput>;
  config?: SequenceClassificationConfig;
}

interface SequenceTokenizer {
  (
    text: string | string[],
    options?: {
      text_pair?: string | string[];
      padding?: boolean;
      truncation?: boolean;
    }
  ): Promise<unknown> | unknown;
}

interface TransformersModule {
  AutoConfig: {
    from_pretrained(model: string): Promise<SequenceClassificationConfig>;
  };
  AutoTokenizer: {
    from_pretrained(model: string): Promise<SequenceTokenizer>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(
      model: string,
      options?: {
        quantized?: boolean;
        config?: SequenceClassificationConfig;
        model_file_name?: string;
      }
    ): Promise<SequenceClassificationModel>;
  };
}

export interface SearchRerankerBackend {
  readonly name: string;
  rerank(query: string, candidates: RerankerCandidate[], taskType: SearchTaskType): Promise<RerankerCandidate[]>;
}

function stableSigmoid(logit: number): number {
  if (!Number.isFinite(logit)) {
    return logit > 0 ? 1 : 0;
  }

  if (logit >= 0) {
    const scaled = Math.exp(-logit);
    return 1 / (1 + scaled);
  }

  const scaled = Math.exp(logit);
  return scaled / (1 + scaled);
}

function buildCrossEncoderDocument(candidate: RerankerCandidate): string {
  const prefixParts: string[] = [];

  if (candidate.metadata.name) {
    prefixParts.push(`[name: ${candidate.metadata.name}]`);
  }

  if (candidate.chunkKind) {
    prefixParts.push(`[kind: ${candidate.chunkKind}]`);
  }

  // Symbol kind is more semantically precise than chunk role, so surface it
  // separately instead of overloading the chunk-kind slot.
  if (candidate.symbolKind) {
    prefixParts.push(`[symbol: ${candidate.symbolKind}]`);
  }

  if (candidate.relation) {
    prefixParts.push(`[relation: ${candidate.relation}]`);
  }

  if (prefixParts.length === 0) {
    return candidate.content;
  }

  if (candidate.content.length === 0) {
    return prefixParts.join(" ");
  }

  return `${prefixParts.join(" ")} ${candidate.content}`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function splitPath(filePath: string): Set<string> {
  return new Set(
    filePath
      .toLowerCase()
      .split(/[/._-]+/)
      .filter((token) => token.length > 1)
  );
}

function looksLikeTestPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return lowered.includes("test") || lowered.includes("__tests__") || lowered.includes("spec");
}

function isTestCandidate(candidate: RerankerCandidate): boolean {
  if (candidate.chunkKind !== undefined) {
    return candidate.chunkKind === "Test";
  }
  return looksLikeTestPath(candidate.metadata.filePath);
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let matches = 0;
  for (const token of left) {
    if (right.has(token)) {
      matches += 1;
    }
  }
  return matches;
}

function selectPositiveLabelIndex(
  id2label: SequenceClassificationConfig["id2label"],
  width: number
): number {
  if (width <= 1) {
    return 0;
  }

  const labels = Array.from({ length: width }, (_, index) => {
    if (Array.isArray(id2label)) {
      return id2label[index] ?? "";
    }

    if (id2label && typeof id2label === "object") {
      return id2label[String(index)] ?? "";
    }

    return "";
  }).map((label) => label.toLowerCase());

  const relevantIndex = labels.findIndex((label) =>
    label.includes("relevant") ||
    label.includes("positive") ||
    label.includes("entailment") ||
    label === "label_1"
  );

  if (relevantIndex >= 0) {
    return relevantIndex;
  }

  return Math.min(1, width - 1);
}

function extractCrossEncoderScores(
  output: SequenceClassificationOutput,
  config?: SequenceClassificationConfig
): number[] {
  const dims = output.logits.dims;
  const data = Array.from(output.logits.data);
  const batchSize = dims[0] ?? data.length;
  const width = dims[1] ?? 1;

  if (width <= 1) {
    return data.slice(0, batchSize);
  }

  const positiveIndex = selectPositiveLabelIndex(config?.id2label, width);
  const scores: number[] = [];

  for (let row = 0; row < batchSize; row += 1) {
    const offset = row * width;
    scores.push(data[offset + positiveIndex] ?? Number.NEGATIVE_INFINITY);
  }

  return scores;
}

async function loadTransformersCrossEncoderScorer(): Promise<CrossEncoderScorer | null> {
  try {
    const transformersModule = await import("@xenova/transformers") as TransformersModule;
    const [config, tokenizer] = await Promise.all([
      transformersModule.AutoConfig.from_pretrained(DEFAULT_LOCAL_CROSS_ENCODER_TOKENIZER),
      transformersModule.AutoTokenizer.from_pretrained(DEFAULT_LOCAL_CROSS_ENCODER_TOKENIZER),
    ]);
    const model = await transformersModule.AutoModelForSequenceClassification.from_pretrained(
      DEFAULT_LOCAL_CROSS_ENCODER_MODEL,
      {
        quantized: false,
        config,
        model_file_name: "model_uint8",
      }
    );

    return async (pairs: CrossEncoderPair[]): Promise<number[]> => {
      const texts = pairs.map((pair) => pair.text);
      const textPairs = pairs.map((pair) => pair.textPair);
      const modelInputs = await tokenizer(texts, {
        text_pair: textPairs,
        padding: true,
        truncation: true,
      });
      const output = await model(modelInputs);
      return extractCrossEncoderScores(output, model.config);
    };
  } catch {
    return null;
  }
}

function computeHeuristicJointScore(
  query: string,
  candidate: RerankerCandidate,
  taskType: SearchTaskType
): number {
  if (taskType === "general") {
    // Preserve the existing stack order when the real cross-encoder is not
    // available. General-mode heuristics should not silently rewrite ranking.
    return candidate.baseScore;
  }

  const queryTokens = tokenize(query);
  const pathTokens = splitPath(candidate.metadata.filePath);
  const nameTokens = tokenize(candidate.metadata.name ?? "");
  const contentTokens = tokenize(candidate.content);
  const normalizedQuery = query.toLowerCase();
  const normalizedContent = candidate.content.toLowerCase();
  const normalizedName = (candidate.metadata.name ?? "").toLowerCase();

  const nameOverlap = overlapCount(queryTokens, nameTokens);
  const pathOverlap = overlapCount(queryTokens, pathTokens);
  const contentOverlap = overlapCount(queryTokens, contentTokens);
  const exactNameBoost = normalizedName.length > 0 && normalizedQuery.includes(normalizedName) ? 0.4 : 0;
  const contentPhraseBoost = normalizedContent.includes(normalizedQuery) ? 0.25 : 0;
  const isTest = isTestCandidate(candidate);

  let taskBias = 0;
  if (taskType === "definition") {
    taskBias += exactNameBoost + nameOverlap * 0.16 + pathOverlap * 0.05;
  } else if (taskType === "bug") {
    const errorTraceBoost =
      /\b(?:error|exception|stack|trace|abort)\b/.test(normalizedQuery) &&
      /\b(?:error|exception|throw|abort|fail)\b/.test(normalizedContent)
        ? 0.14
        : 0;
    taskBias += contentOverlap * 0.12 + pathOverlap * 0.06 + nameOverlap * 0.05;
    taskBias += contentPhraseBoost + exactNameBoost * 0.5 + errorTraceBoost;
    taskBias += isTest ? 0.04 : 0;
  } else if (taskType === "semantic") {
    taskBias += contentOverlap * 0.1 + contentPhraseBoost;
  } else if (taskType === "test_debug") {
    taskBias += isTest ? 0.18 : -0.04;
    taskBias += contentOverlap * 0.08 + pathOverlap * 0.05;
  }

  return (
    candidate.baseScore * 0.6 +
    contentOverlap * 0.06 +
    pathOverlap * 0.04 +
    nameOverlap * 0.08 +
    exactNameBoost +
    contentPhraseBoost +
    taskBias
  );
}

export class HeuristicLocalRerankerBackend implements SearchRerankerBackend {
  readonly name = "heuristic-local";

  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    taskType: SearchTaskType
  ): Promise<RerankerCandidate[]> {
    const scored: ScoredCandidate[] = candidates.map((candidate, originalIndex) => ({
      candidate,
      score: computeHeuristicJointScore(query, candidate, taskType),
      originalIndex,
    }));

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.candidate.baseScore !== left.candidate.baseScore) {
        return right.candidate.baseScore - left.candidate.baseScore;
      }
      if (left.originalIndex !== right.originalIndex) {
        return left.originalIndex - right.originalIndex;
      }
      return left.candidate.id.localeCompare(right.candidate.id);
    });

    return scored.map((entry) => ({
      ...entry.candidate,
      baseScore: entry.score,
    }));
  }
}

export class TransformersCrossEncoderBackend implements SearchRerankerBackend {
  readonly name = "transformers-cross-encoder";
  private scorerPromise: Promise<CrossEncoderScorer | null> | null = null;

  constructor(private readonly loader: CrossEncoderLoader = loadTransformersCrossEncoderScorer) {}

  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    _taskType: SearchTaskType
  ): Promise<RerankerCandidate[]> {
    const scorer = await this.getScorer();
    if (!scorer) {
      throw new Error("transformers backend unavailable");
    }

    const scores = await scorer(
      candidates.map((candidate) => ({
        text: query,
        textPair: buildCrossEncoderDocument(candidate),
      }))
    );

    const scored: ScoredCandidate[] = candidates.map((candidate, index) => ({
      candidate,
      score: stableSigmoid(Number(scores[index] ?? Number.NEGATIVE_INFINITY)),
      originalIndex: index,
    }));

    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.candidate.baseScore !== left.candidate.baseScore) {
        return right.candidate.baseScore - left.candidate.baseScore;
      }
      return left.originalIndex - right.originalIndex;
    });

    return scored.map((entry) => ({
      ...entry.candidate,
      baseScore: entry.score,
    }));
  }

  private async getScorer(): Promise<CrossEncoderScorer | null> {
    if (!this.scorerPromise) {
      this.scorerPromise = this.loader();
    }
    return this.scorerPromise;
  }
}

export class SearchReranker {
  private readonly backends: SearchRerankerBackend[];

  constructor(backends?: SearchRerankerBackend[]) {
    this.backends = backends ?? [
      new TransformersCrossEncoderBackend(),
      new HeuristicLocalRerankerBackend(),
    ];
  }

  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    taskType: SearchTaskType
  ): Promise<RerankerResult> {
    if (candidates.length < 2) {
      return {
        candidates,
        applied: false,
        backend: null,
      };
    }

    let failedBackend: string | null = null;

    for (const backend of this.backends) {
      try {
        const reranked = await backend.rerank(query, candidates, taskType);
        return {
          candidates: reranked,
          applied: true,
          backend: backend.name,
          failedBackend,
        };
      } catch {
        failedBackend = backend.name;
      }
    }

    return {
      candidates,
      applied: false,
      backend: null,
      failedBackend,
    };
  }
}
