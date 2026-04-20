import type { SearchConfig } from "../config/schema.js";
import type { SearchTaskType } from "../indexer/search-recipes.js";

export type GoldenQueryType =
  | "definition"
  | "identifier-heavy"
  | "implementation-intent"
  | "similarity"
  | "keyword-heavy"
  | "config-lookup"
  | "config-constant-lookup"
  | "test-discovery"
  | "bug-report"
  | "bug-error-lookup"
  | "cross-file-relationship"
  | "file-intent"
  | "concept";

export type GoldenQuerySource = "curated" | "generated";

export interface GoldenExpected {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  startLine?: number;
  endLine?: number;
  branch?: string;
}

export interface GoldenQuery {
  id: string;
  query: string;
  queryType?: GoldenQueryType;
  source?: GoldenQuerySource;
  heuristic?: string;
  taskType?: SearchTaskType;
  expected: GoldenExpected;
}

export interface GoldenDataset {
  version: string;
  name: string;
  description?: string;
  queries: GoldenQuery[];
}

export interface EvalBudget {
  name: string;
  baselinePath?: string;
  failOnMissingBaseline: boolean;
  thresholds: {
    hitAt1MaxDrop?: number;
    hitAt5MaxDrop?: number;
    mrrAt10MaxDrop?: number;
    combinedRecallAt10MaxDrop?: number;
    expansionHitRateMaxDrop?: number;
    p95LatencyMaxMultiplier?: number;
    p95LatencyMaxAbsoluteMs?: number;
    minHitAt1?: number;
    minHitAt5?: number;
    minMrrAt10?: number;
  };
}

export interface EvalRecipeOverrides {
  bm25Weight?: number;
  denseWeight?: number;
  voyageWeight?: number;
  identifierBoost?: number;
  graphDepth?: number;
  finalRerankTopN?: number;
}

export interface EvalSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
}

export type FailureBucket =
  | "wrong-file"
  | "wrong-symbol"
  | "docs-tests-outranking-source"
  | "no-relevant-hit-top-k";

export interface PerQueryEvalResult {
  id: string;
  query: string;
  queryType?: GoldenQueryType;
  source?: GoldenQuerySource;
  heuristic?: string;
  effectiveTaskType?: string;
  effectiveFinalRerankTopN?: number;
  effectiveGraphDepth?: number;
  latencyMs: number;
  prefilterMs?: number;
  fileHitAt1: boolean;
  fileHitAt3: boolean;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  fileHitAt10: boolean;
  hitAt10: boolean;
  expandedHit?: boolean;
  expandedRecallAtK?: number;
  expandedRelations?: string[];
  reciprocalRankAt10: number;
  ndcgAt10: number;
  failureBucket?: FailureBucket;
  results: EvalSearchResult[];
}

export interface EvalMetrics {
  fileHitAt1: number;
  fileHitAt3: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  fileHitAt10: number;
  hitAt10: number;
  combinedRecallAt10: number;
  expansionHitRate: number;
  mrrAt10: number;
  ndcgAt10: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
  };
  tokenEstimate: {
    queryTokens: number;
    embeddingTokensUsed: number;
  };
  embedding: {
    callCount: number;
    estimatedCostUsd: number;
    costPer1MTokensUsd: number;
  };
  reranker?: {
    appliedCount: number;
    failureCount: number;
    backendUsage: Record<string, number>;
    lastMs: number;
  };
  failureBuckets: Record<FailureBucket, number>;
}

export interface EvalSearchConfig
  extends Pick<SearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN"> {
  useQueryTypes: boolean;
  taskTypeOverride?: SearchTaskType;
  recipeOverrides?: EvalRecipeOverrides;
  effectiveTaskType: string;
  effectiveFinalRerankTopN: number;
  effectiveGraphDepth: number;
}

export interface EvalSummary {
  generatedAt: string;
  projectRoot: string;
  datasetPath: string;
  datasetName: string;
  datasetVersion: string;
  queryCount: number;
  topK: number;
  searchConfig: EvalSearchConfig;
  metrics: EvalMetrics;
}

export interface MetricDelta {
  current: number;
  baseline: number;
  absolute: number;
  relativePct: number;
}

export interface EvalComparison {
  againstPath: string;
  deltas: {
    hitAt1: MetricDelta;
    hitAt3: MetricDelta;
    hitAt5: MetricDelta;
    hitAt10: MetricDelta;
    combinedRecallAt10: MetricDelta;
    expansionHitRate: MetricDelta;
    mrrAt10: MetricDelta;
    ndcgAt10: MetricDelta;
    latencyP50Ms: MetricDelta;
    latencyP95Ms: MetricDelta;
    latencyP99Ms: MetricDelta;
    embeddingCallCount: MetricDelta;
    estimatedCostUsd: MetricDelta;
  };
}

export interface EvalGateViolation {
  metric: string;
  message: string;
}

export interface EvalGateRegression {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  threshold: number;
}

export interface EvalGateResult {
  passed: boolean;
  budgetName?: string;
  violations: EvalGateViolation[];
  regressions: EvalGateRegression[];
}

export interface EvalRecipeOverrideSweep {
  bm25Weight?: number[];
  denseWeight?: number[];
  voyageWeight?: number[];
  identifierBoost?: number[];
  graphDepth?: number[];
  finalRerankTopN?: number[];
}

export interface SweepDefinition {
  fusionStrategy?: Array<"rrf" | "weighted">;
  hybridWeight?: number[];
  rrfK?: number[];
  rerankTopN?: number[];
  taskType?: SearchTaskType[];
  recipeOverrides?: EvalRecipeOverrideSweep;
}

export interface SweepRunSummary {
  searchConfig: EvalSummary["searchConfig"];
  summary: EvalSummary;
  comparison?: EvalComparison;
  gate?: EvalGateResult;
}

export interface SweepAggregateReport {
  generatedAt: string;
  againstPath?: string;
  runCount: number;
  runs: SweepRunSummary[];
  gatePassed?: boolean;
  failedGateRuns?: number;
  bestByHitAt5?: SweepRunSummary;
  bestByMrrAt10?: SweepRunSummary;
  bestByP95Latency?: SweepRunSummary;
}

export interface EvalRunOptions {
  projectRoot: string;
  datasetPath: string;
  configPath?: string;
  outputRoot: string;
  againstPath?: string;
  ciMode: boolean;
  budgetPath?: string;
  reindex: boolean;
  taskTypeOverride?: SearchTaskType;
  searchOverrides?: Partial<Pick<SearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>;
  recipeOverrides?: EvalRecipeOverrides;
}
