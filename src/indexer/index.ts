import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { pathToFileURL } from "url";

import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import {
  detectEmbeddingProvider,
  ConfiguredProviderInfo,
  tryDetectProvider,
  createCustomProviderInfo,
  createVoyageProviderInfo,
} from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
  createVoyageEmbeddingProvider,
  type EmbeddingResult,
  type VoyageEmbeddingProvider,
} from "../embeddings/provider.js";
import { collectFiles, SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import { Logger, initializeLogger } from "../utils/logger.js";
import { IncrementalIndexOrchestrator } from "./incremental-index-orchestrator.js";
import {
  expandGraphContext,
  type GraphExpansionDirection,
  type GraphExpansionEntry,
  type GraphExpansionMetadata,
  type GraphExpansionSeed,
} from "./graph-expansion.js";
import {
  SearchReranker,
  type RerankerCandidate,
  type RerankerHealthBackend,
  type RerankerHealthEvent,
  type RerankerHealthStatus,
} from "./reranker.js";
import { ensureWatcherEventTimestamp } from "./watcher-tti.js";
import {
  getSearchRecipe,
  type SearchPathPreference,
  type SearchTaskType,
} from "./search-recipes.js";
import {
  classifyDefinitionWinnerCategory,
  hasExactIdentifierQuality,
  hasExactSymbolEvidence,
  getDefinitionImplementationBonus,
  getDefinitionImplementationPenalty,
  isImplementationSeekingDefinitionQuery,
} from "./definition-implementation-policy.js";
import {
  VectorStore,
  InvertedIndex,
  Database,
  chunkFile,
  ChunkMetadata,
  ChunkData,
  hashContent,
  extractCalls,
  diffMerkleFromEvents,
  type MerkleDiff,
  type MerkleIgnoreRules,
  type ChunkCapDropData,
} from "../native/index.js";

type SecondaryEmbeddingProvider = EmbeddingProviderInterface | VoyageEmbeddingProvider;
import type { SymbolData, CallEdgeData, ChunkKind, ChunkSymbolKind, ChunkType } from "../native/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";

const CALL_GRAPH_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "php"]);
const CALL_GRAPH_SYMBOL_CHUNK_TYPES = new Set([
  "function",
  "method",
  "class",
  "interface",
  "struct",
  "module",
]);

export const CALLER_TARGET_PENALTY = 0.51; // SCORING-DEBT: load-bearing, tune carefully.
export const CALLER_CONTENT_BOOST = 0.18; // SCORING-DEBT: load-bearing, tune carefully.
export const RELATIONSHIP_BIAS_TEST_DOC = 0.2; // SCORING-DEBT: load-bearing, tune carefully.
export const RELATIONSHIP_BIAS_SOURCE = 0.6; // SCORING-DEBT: load-bearing, tune carefully.
export const GRAPH_TEST_DOC_FLOOR = 0.72; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const GRAPH_SOURCE_FLOOR = 0.97; // SCORING-DEBT: load-bearing, tune carefully.
export const GRAPH_DEPTH_DECAY = 0.08; // SCORING-DEBT: load-bearing, tune carefully.
export const SEMANTIC_TEST_DOC_PATH_PENALTY = 0.35; // SCORING-DEBT: dangerous, validate on external repos.
export const DETERMINISTIC_IDENTIFIER_EXACT_FILE_HINT_SCORE = 0.995; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const DETERMINISTIC_IDENTIFIER_BASE_SCORE = 0.9; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const DETERMINISTIC_IDENTIFIER_MATCH_SCALE = 0.09; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_DEFINITION_EXACT_SCORE = 0.99; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_DEFINITION_FUZZY_SCORE = 0.88; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_FALLBACK_EXACT_FLOOR = 0.97; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_FALLBACK_TOKEN_BASE = 0.82; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_FALLBACK_TOKEN_SCALE = 0.03; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_FALLBACK_TOKEN_CAP = 0.95; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_OVERLAP_FALLBACK_BASE = 0.8; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_OVERLAP_FALLBACK_SCALE = 0.1; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const SYMBOL_OVERLAP_FALLBACK_CAP = 0.94; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const IDENTIFIER_DATABASE_BASELINE_SCORE = 0.5; // SCORING-DEBT: dangerous, validate on external repos.
export const IDENTIFIER_EXACT_RESCUE_BOOST = 0.45; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const IDENTIFIER_FUZZY_RESCUE_BOOST = 0.25; // SCORING-DEBT: dangerous, lower in Phase 2B.
export const CHUNK_TYPE_PRIMARY_BOOST = 0.2; // SCORING-DEBT: load-bearing, tune carefully.
export const CHUNK_TYPE_SECONDARY_BOOST = 0.1; // SCORING-DEBT: load-bearing, tune carefully.
export const CHUNK_TYPE_MODULE_PENALTY = -0.1; // SCORING-DEBT: dangerous, validate on external repos.
export const CHUNK_TYPE_OTHER_PENALTY = -0.12; // SCORING-DEBT: dangerous, validate on external repos.
export const INTERFACE_TYPE_DEFINITION_PENALTY = -0.15; // SCORING-DEBT: dangerous, validate on external repos.
export const IDENTIFIER_MATCH_EXACT_SCORE = 1; // SCORING-DEBT: load-bearing, tune carefully.
export const IDENTIFIER_MATCH_SUBSTRING_SCORE = 0.8; // SCORING-DEBT: dangerous, validate on external repos.
export const IDENTIFIER_MATCH_PATH_SCORE = 0.6; // SCORING-DEBT: dangerous, validate on external repos.
export const DETERMINISTIC_NAME_HIT_BOOST = 0.08; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_PATH_OVERLAP_BOOST = 0.03; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_CHUNK_TYPE_HIT_BOOST = 0.02; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_COVERAGE_BOOST_CAP = 0.12; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_COVERAGE_BOOST_SCALE = 0.06; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_IMPLEMENTATION_PATH_BOOST = 0.08; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_TEST_DOC_PATH_PENALTY = 0.12; // SCORING-DEBT: dangerous, validate on external repos.
export const DETERMINISTIC_TEST_PATH_BOOST = 0.16; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_README_DOC_BOOST = 0.08; // SCORING-DEBT: load-bearing, tune carefully.
export const DETERMINISTIC_IDENTIFIER_SORT_BOOST = 0.12; // SCORING-DEBT: dangerous, validate on external repos.
export const SIBLING_SUPPRESSION_SORT_PENALTY = 0.10; // SCORING-DEBT: dangerous, validate on external repos.
const DETERMINISTIC_SORT_STAGE = "deterministicSortPreference";
const DETERMINISTIC_INTENT_STAGE = "deterministicIntentLane";
const PATH_AND_KIND_SUPPRESSION_STAGE = "pathAndKindSuppression";
const STRUCTURAL_RELATIONSHIP_STAGE = "structuralRelationshipAdjustment";
const DEFINITION_IMPLEMENTATION_POLICY_STAGE = "definitionImplementationPolicy";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function normalizeStoredChunkKind(
  chunkKind: string | undefined | null
): "code" | "test" | "doc" | "config" | null {
  if (!chunkKind) {
    return null;
  }

  switch (chunkKind.toLowerCase()) {
    case "code":
      return "code";
    case "test":
      return "test";
    case "doc":
      return "doc";
    case "config":
      return "config";
    default:
      return null;
  }
}

function mergeSearchResultLane(
  existingLane: SearchResultLane | undefined,
  nextLane: SearchResultLane | undefined
): SearchResultLane | undefined {
  if (!existingLane) {
    return nextLane;
  }
  if (!nextLane || existingLane === nextLane) {
    return existingLane;
  }
  return "hybrid";
}

function cloneScoreBreakdown(breakdown: ScoreBreakdown | undefined): ScoreBreakdown | undefined {
  if (!breakdown) {
    return undefined;
  }

  return {
    lanes: {
      bm25: breakdown.lanes.bm25 ? { ...breakdown.lanes.bm25 } : undefined,
      arctic: breakdown.lanes.arctic ? { ...breakdown.lanes.arctic } : undefined,
      voyage: breakdown.lanes.voyage ? { ...breakdown.lanes.voyage } : undefined,
    },
    fusion: { ...breakdown.fusion },
    sources: [...breakdown.sources],
    stages: breakdown.stages.map((stage) => ({ ...stage })),
    preRerankScore: breakdown.preRerankScore,
    reranker: breakdown.reranker ? { ...breakdown.reranker } : undefined,
    finalScore: breakdown.finalScore,
  };
}

function createScoreBreakdown(
  lanes: ScoreBreakdown["lanes"],
  fusionStrategy: "rrf" | "weighted",
  score: number,
  rank: number,
  sources: ScoreBreakdownSource[]
): ScoreBreakdown {
  return {
    lanes,
    fusion: {
      strategy: fusionStrategy,
      score,
      rank,
    },
    sources: Array.from(new Set(sources)),
    stages: [],
    preRerankScore: score,
    finalScore: score,
  };
}

function ensureScoreBreakdown(
  candidate: RankedCandidate,
  source: ScoreBreakdownSource,
  strategy: "rrf" | "weighted" = "rrf"
): ScoreBreakdown {
  if (!candidate.scoreBreakdown) {
    candidate.scoreBreakdown = createScoreBreakdown({}, strategy, candidate.score, 0, [source]);
  } else if (!candidate.scoreBreakdown.sources.includes(source)) {
    candidate.scoreBreakdown.sources.push(source);
  }

  return candidate.scoreBreakdown;
}

function addBreakdownSource(candidate: RankedCandidate, source: ScoreBreakdownSource): void {
  if (!candidate.scoreBreakdown || candidate.scoreBreakdown.sources.includes(source)) {
    return;
  }
  candidate.scoreBreakdown.sources.push(source);
}

function recordScoreStage(
  candidate: RankedCandidate,
  stage: ScoreStage
): void {
  if (!candidate.scoreBreakdown) {
    return;
  }
  candidate.scoreBreakdown.stages.push(stage);
  candidate.scoreBreakdown.finalScore = stage.after;
}

function recordDeterministicSortPreference(candidate: RankedCandidate, reason: string): void {
  if (!candidate.scoreBreakdown) {
    return;
  }

  const existing = candidate.scoreBreakdown.stages.find((stage) =>
    stage.name === DETERMINISTIC_SORT_STAGE &&
    stage.kind === "sort" &&
    stage.before === candidate.score &&
    stage.after === candidate.score
  );
  if (existing) {
    existing.reason = `${existing.reason}; ${reason}`;
    return;
  }

  recordScoreStage(candidate, {
    name: DETERMINISTIC_SORT_STAGE,
    kind: "sort",
    before: candidate.score,
    after: candidate.score,
    reason,
  });
}

function appendPathAndKindSuppressionReason(
  candidate: RankedCandidate,
  previousScore: number,
  reason: string
): void {
  const breakdown = candidate.scoreBreakdown;
  if (!breakdown) {
    return;
  }

  let existing: ScoreStage | undefined;
  for (let index = breakdown.stages.length - 1; index >= 0; index -= 1) {
    const stage = breakdown.stages[index];
    if (stage?.name === PATH_AND_KIND_SUPPRESSION_STAGE && stage.after === previousScore) {
      existing = stage;
      break;
    }
  }
  if (!existing) {
    return;
  }

  existing.after = candidate.score;
  existing.reason = `${existing.reason}; ${reason}`;
  breakdown.finalScore = candidate.score;
}

function buildLaneScoreBreakdowns(
  bm25Results: RankedCandidate[],
  arcticResults: RankedCandidate[],
  voyageResults: RankedCandidate[]
): Map<string, ScoreBreakdown["lanes"]> {
  const byId = new Map<string, ScoreBreakdown["lanes"]>();
  const upsert = (
    source: keyof ScoreBreakdown["lanes"],
    results: RankedCandidate[]
  ) => {
    results.forEach((candidate, index) => {
      const lanes = byId.get(candidate.id) ?? {};
      lanes[source] = { score: candidate.score, rank: index + 1 };
      byId.set(candidate.id, lanes);
    });
  };

  upsert("bm25", bm25Results);
  upsert("arctic", arcticResults);
  upsert("voyage", voyageResults);
  return byId;
}

function sourcesFromLaneBreakdown(lanes: ScoreBreakdown["lanes"]): ScoreBreakdownSource[] {
  const sources: ScoreBreakdownSource[] = [];
  if (lanes.bm25) sources.push("bm25");
  if (lanes.arctic) sources.push("arctic");
  if (lanes.voyage) sources.push("voyage");
  if (sources.length > 1) sources.push("hybrid");
  return sources.length > 0 ? sources : ["hybrid"];
}

function normalizeRequestedChunkKind(
  chunkKind: string | undefined | null
): "code" | "test" | "doc" | "config" | null {
  return normalizeStoredChunkKind(chunkKind);
}

function normalizeStructuralSymbolKind(
  kind: string | undefined | null
): "function" | "class" | "method" | "variable" | "unknown" {
  const normalized = kind?.toLowerCase() ?? "";
  if (normalized === "function" || normalized === "test") {
    return "function";
  }
  if (normalized === "method") {
    return "method";
  }
  if (
    normalized === "class" ||
    normalized === "interface" ||
    normalized === "struct" ||
    normalized === "trait" ||
    normalized === "type" ||
    normalized === "module"
  ) {
    return "class";
  }
  if (normalized === "constant" || normalized === "variable") {
    return "variable";
  }
  return "unknown";
}

function extractStoredChunkSignature(chunkText: string | null | undefined): string | null {
  if (!chunkText) {
    return null;
  }

  const lines = chunkText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/") ||
      trimmed.startsWith("<!--")
    ) {
      continue;
    }
    return trimmed;
  }

  return null;
}

function looksLikeTestFilePath(filePath: string | undefined | null): boolean {
  if (!filePath) {
    return false;
  }

  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("__tests__") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.jsx") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.tsx") ||
    normalized.endsWith(".spec.js") ||
    normalized.endsWith(".spec.jsx") ||
    normalized.endsWith("_test.py") ||
    normalized.endsWith("test.py")
  );
}

function buildLineStartByteOffsets(content: string): number[] {
  const buffer = Buffer.from(content, "utf8");
  const lineStarts = [0];

  for (let idx = 0; idx < buffer.length; idx += 1) {
    if (buffer[idx] === 0x0a) {
      lineStarts.push(idx + 1);
    }
  }

  return lineStarts;
}

function lineColumnToByteOffset(lineStarts: number[], line: number, column: number): number | null {
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) {
    return null;
  }

  return lineStart + Math.max(0, column);
}

function getChunkerLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "jsx";
    case ".py":
    case ".pyi":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "";
  }
}

function mapSemanticChunkType(symbolKind: string | undefined): ChunkMetadata["chunkType"] {
  switch (symbolKind) {
    case "Function":
    case "Test":
      return "function";
    case "Method":
      return "method";
    case "Class":
      return "class";
    case "Interface":
      return "interface";
    case "Struct":
      return "struct";
    case "Type":
      return "type";
    case "Module":
      return "module";
    case "Constant":
      return "constant";
    default:
      return "other";
  }
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
  existingChunks: number;
  removedChunks: number;
  skippedFiles: SkippedFile[];
  parseFailures: string[];
  failedBatchesPath?: string;
  ttiMeasurements?: Array<{
    filePath: string;
    durationMs: number;
    exceededTarget: boolean;
  }>;
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reranked?: boolean;
  rerankerScore?: number | null;
  lane?: "bm25" | "semantic" | "hybrid";
  chunkType: string;
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  name?: string;
  relation?: "caller" | "callee";
  depth?: number;
  viaSymbol?: string;
  scoreBreakdown?: ScoreBreakdown;
}

export interface GraphContextResult extends SearchResult {
  relation: "caller" | "callee";
  depth: number;
  viaSymbol?: string;
}

export interface SearchResponse {
  primaryResults: SearchResult[];
  expandedContext: GraphContextResult[];
  taskType: SearchTaskType;
  subIntent: SubIntent;
  graphDirection: GraphExpansionDirection;
  timings?: {
    prefilterMs: number;
  };
  retrieval: {
    voyageLaneConfigured: boolean;
    voyageLaneUsed: boolean;
  };
  reranker: {
    applied: boolean;
    backend: string | null;
  };
}

export interface SearchOptions {
  hybridWeight?: number;
  bm25Weight?: number;
  denseWeight?: number;
  voyageWeight?: number;
  identifierBoost?: number;
  finalRerankTopN?: number;
  fileType?: string;
  directory?: string;
  chunkType?: string;
  chunkKind?: "code" | "test" | "doc" | "config";
  language?: string;
  pathGlob?: string;
  contextLines?: number;
  filterByBranch?: boolean;
  metadataOnly?: boolean;
  definitionIntent?: boolean;
  taskType?: SearchTaskType;
  graphDepth?: number;
  graphDirection?: GraphExpansionDirection;
  includeScoreBreakdown?: boolean;
}

export interface ScoreStage {
  name: string;
  kind: "add" | "multiply" | "set-min" | "set" | "filter" | "sort" | "replace";
  before: number;
  after: number;
  reason: string;
}

export interface ScoreBreakdown {
  lanes: {
    bm25?: { score: number; rank: number };
    arctic?: { score: number; rank: number };
    voyage?: { score: number; rank: number };
  };
  fusion: {
    strategy: "rrf" | "weighted";
    score: number;
    rank: number;
    subIntent?: SubIntent;
  };
  sources: string[];
  stages: ScoreStage[];
  preRerankScore: number;
  reranker?: {
    score: number;
    rank: number;
    backend: string;
  };
  finalScore: number;
}

export interface StructuralSymbolInfoEntry {
  symbolId: string;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "unknown";
  fileUri: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  chunkKind: "code" | "test" | "doc" | "config" | null;
}

export interface StructuralSymbolInfoResult {
  symbols: StructuralSymbolInfoEntry[];
  total: number;
  ambiguous: boolean;
}

export interface StructuralCallerEntry {
  symbolName: string;
  fileUri: string;
  relativePath: string;
  line: number;
  chunkKind: "code" | "test" | "doc" | "config";
}

export interface StructuralCallersResult {
  callers: StructuralCallerEntry[];
  total: number;
  cursor: string | null;
  resolved: boolean;
}

export interface StructuralCalleeEntry {
  symbolName: string;
  fileUri: string | null;
  relativePath: string | null;
  line: number | null;
  resolved: boolean;
}

export interface StructuralCalleesResult {
  callees: StructuralCalleeEntry[];
  total: number;
  resolved: boolean;
}

export interface StructuralCallChainEntry {
  symbolName: string;
  fileUri: string;
  relativePath: string;
  line: number;
}

export interface StructuralCallChainResult {
  found: boolean;
  path: StructuralCallChainEntry[];
  depth: number;
  searchDepthReached: boolean;
  warning: string | null;
}

export interface StructuralTestEntry {
  testName: string;
  fileUri: string;
  relativePath: string;
  line: number;
  confidence: number;
  method: "call_graph" | "name_convention" | "file_convention";
}

export interface StructuralTestsResult {
  tests: StructuralTestEntry[];
  total: number;
  symbolResolved: boolean;
}

export interface HealthCheckResult {
  removed: number;
  filePaths: string[];
  gcOrphanEmbeddings: number;
  gcOrphanChunks: number;
  gcOrphanSymbols: number;
  gcOrphanCallEdges: number;
}

export interface StatusResult {
  indexed: boolean;
  vectorCount: number;
  provider: string;
  model: string;
  indexPath: string;
  currentBranch: string;
  baseBranch: string;
  compatibility: IndexCompatibility | null;
  rerankerHealth?: {
    backend: RerankerHealthBackend;
    status: RerankerHealthStatus;
    model?: string | null;
    error?: string | null;
    updatedAt: number;
  } | null;
  chunkCapSummary?: {
    truncatedFiles: number;
    totalDroppedChunks: number;
    totalDroppedNamedSymbols: number;
  } | null;
  foreground?: {
    bm25Ready: boolean;
    callGraphReady: boolean;
  } | null;
  embedding?: {
    status: "pending" | "in_progress" | "complete" | "partial" | "failed";
    embedded: number;
    total: number;
    startedAt?: number | null;
    updatedAt?: number | null;
    failed?: string | null;
  } | null;
}

export interface ForegroundIndexResult {
  filesProcessed: number;
  totalChunks: number;
  chunksIndexed: number;
  removedChunks: number;
  durationMs: number;
  bm25Ready: boolean;
  callGraphReady: boolean;
  embeddingStatus: "pending" | "in_progress" | "complete" | "partial" | "failed";
  embeddingProgress: {
    embedded: number;
    total: number;
    startedAt?: number | null;
    updatedAt?: number | null;
    failed?: string | null;
  };
  alreadyInProgress?: boolean;
}

export interface IndexCoverageResult {
  branch: string;
  truncatedFiles: Array<{
    filePath: string;
    capLimit: number;
    keptChunks: number;
    droppedChunks: number;
    droppedNamedSymbols: string[];
    indexedAt: number;
  }>;
  totalDroppedChunks: number;
  totalDroppedNamedSymbols: number;
}

export interface IndexProgress {
  phase: "scanning" | "parsing" | "embedding" | "storing" | "complete";
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

interface PendingChunk {
  id: string;
  text: string;
  content: string;
  contentHash: string;
  embeddingInputHash: string;
  metadata: ChunkMetadata;
}

interface ParsedChunkCandidate {
  content: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  chunkType: ChunkMetadata["chunkType"];
  name?: string;
  symbolAliases: string[];
  chunkKind?: string;
  symbolKind?: string;
  language: string;
  chunkHash: string;
}

interface ParsedFileCandidate {
  path: string;
  hash: string;
  content: string;
  chunks: ParsedChunkCandidate[];
}

type GraphEdgeData = Omit<CallEdgeData, "branch">;

interface FileGraphData {
  symbols: SymbolData[];
  edges: GraphEdgeData[];
}

interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

type RetrievalChunkMetadata = GraphExpansionMetadata;
type SearchResultLane = "bm25" | "semantic" | "hybrid";
type ScoreBreakdownSource = "bm25" | "arctic" | "voyage" | "hybrid" | "graph" | "identifier" | "symbol";
type IdentifierQualityLabel =
  | "exact-symbol"
  | "alias-symbol"
  | "file-anchored-symbol"
  | "compound-symbol"
  | "weak-substring"
  | "path-only"
  | "type-only";

export type CompoundIdentifierSpecificity =
  | "strong-compound"
  | "generic-compound"
  | "mixed-compound"
  | "not-compound";

export type SubIntent =
  | "definition:executable"
  | "definition:declarative"
  | "relationship:caller"
  | "relationship:callee"
  | "concept:implementation"
  | "concept:architecture"
  | "bug:error-source"
  | "bug:behavior-owner"
  | "test:discovery"
  | null;

type RankedCandidate = {
  id: string;
  score: number;
  metadata: RetrievalChunkMetadata;
  lane?: SearchResultLane;
  identifierQuality?: IdentifierQualityLabel;
  relation?: "caller" | "callee";
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  reranked?: boolean;
  scoreBreakdown?: ScoreBreakdown;
};

interface HybridRankOptions {
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
  limit: number;
  hybridWeight: number;
  bm25Weight?: number;
  denseWeight?: number;
  voyageWeight?: number;
  voyageResults?: RankedCandidate[];
  pathPreference?: SearchPathPreference;
  taskType?: SearchTaskType;
  scoreBreakdownLanes?: Map<string, ScoreBreakdown["lanes"]>;
}

interface FusionWeights {
  bm25Weight: number;
  denseWeight: number;
  voyageWeight: number;
}

interface FusionLane {
  results: RankedCandidate[];
  weight: number;
}

interface QueryEmbeddingCacheEntry {
  query: string;
  modelId: string;
  embedding: number[];
  timestamp: number;
}

interface QueryEmbeddingFailureState {
  until: number;
  reason: string;
}

const SECONDARY_PROVIDER_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const SECONDARY_PROVIDER_HEALTH_PROBE_QUERY = "health";

interface EmbeddingProgressState {
  status: "pending" | "in_progress" | "complete" | "partial" | "failed";
  embedded: number;
  total: number;
  startedAt?: number | null;
  updatedAt?: number | null;
  failed?: string | null;
  activeRunId?: string | null;
}

const EMBEDDING_PROGRESS_METADATA_PREFIX = "index.embedding_progress.";

interface SemanticRankOptions {
  rerankTopN: number;
  limit: number;
  pathPreference?: SearchPathPreference;
  prioritizeSourcePaths?: boolean;
  taskType?: SearchTaskType;
}

interface HardRetrievalFilters {
  fileType?: string;
  directory?: string;
  chunkType?: string;
  excludeFile?: string;
  chunkKind?: "code" | "test" | "doc" | "config";
  language?: string;
  pathGlob?: string;
}

interface IndexMetadata {
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  createdAt: string;
  updatedAt: string;
}

enum IncompatibilityCode {
  DIMENSION_MISMATCH = "DIMENSION_MISMATCH",
  MODEL_MISMATCH = "MODEL_MISMATCH",
}

interface IndexCompatibility {
  compatible: boolean;
  code?: IncompatibilityCode;
  reason?: string;
  storedMetadata?: IndexMetadata;
}

const INDEX_METADATA_VERSION = "1";
const RANKING_TOKEN_CACHE_LIMIT = 4096;
const DEFAULT_RETRIEVAL_CANDIDATE_K = 50;

const rankingQueryTokenCache = new Map<string, Set<string>>();
const rankingNameTokenCache = new Map<string, Set<string>>();
const rankingPathTokenCache = new Map<string, Set<string>>();
const rankingTextTokenCache = new Map<string, Set<string>>();

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "using", "where",
  "what", "when", "why", "how", "are", "was", "were", "be", "been", "being",
  "find", "show", "get", "run", "use", "code", "function", "implementation",
  "retrieve", "results", "result", "search", "pipeline", "top", "in", "on", "of",
  "to", "by", "as", "or", "an", "a",
]);

const GENERIC_COMPOUND_IDENTIFIER_TERMS = new Set([
  "api",
  "app",
  "auth",
  "base",
  "builder",
  "cache",
  "call",
  "callback",
  "client",
  "config",
  "context",
  "core",
  "data",
  "default",
  "error",
  "event",
  "factory",
  "handler",
  "helper",
  "http",
  "impl",
  "implementation",
  "info",
  "input",
  "internal",
  "item",
  "json",
  "link",
  "manager",
  "message",
  "model",
  "module",
  "options",
  "output",
  "parser",
  "path",
  "proxy",
  "query",
  "request",
  "response",
  "result",
  "retry",
  "route",
  "router",
  "schema",
  "server",
  "service",
  "shape",
  "state",
  "transform",
  "transformer",
  "transport",
  "trpc",
  "type",
  "types",
  "utils",
  "validate",
  "validation",
  "wire",
]);

const TEST_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "benchmark",
  "README",
  "ARCHITECTURE",
  "docs/",
];

const IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "_artifacts/",
  "skills/",
  "benchmark",
  "/bench/",
  "readme",
  "architecture",
  "docs/",
  "/www/",
  "/versioned_docs/",
  "examples/",
  "example/",
  ".github/",
  "/scripts/",
  "/migrations/",
  "/generated/",
];

const SOURCE_INTENT_HINTS = new Set([
  "implement",
  "implementation",
  "function",
  "method",
  "class",
  "logic",
  "algorithm",
  "pipeline",
  "indexer",
  "where",
]);

const DOC_TEST_INTENT_HINTS = new Set([
  "test",
  "tests",
  "fixture",
  "fixtures",
  "benchmark",
  "readme",
  "docs",
  "documentation",
]);

const DOC_INTENT_HINTS = new Set([
  "readme",
  "docs",
  "documentation",
  "guide",
  "usage",
]);

function setBoundedCache(
  cache: Map<string, Set<string>>,
  key: string,
  value: Set<string>
): void {
  if (cache.size >= RANKING_TOKEN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

function tokenizeTextForRanking(text: string): Set<string> {
  if (!text) {
    return new Set<string>();
  }

  const lowered = text.toLowerCase();
  const cache = rankingQueryTokenCache.get(lowered) ?? rankingTextTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );

  setBoundedCache(rankingQueryTokenCache, lowered, tokens);
  setBoundedCache(rankingTextTokenCache, lowered, tokens);
  return tokens;
}

function splitPathTokens(filePath: string): Set<string> {
  const lowered = filePath.toLowerCase();
  const cache = rankingPathTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const normalized = lowered
    .replace(/[^a-z0-9/._-]/g, " ")
    .split(/[/._-]+/)
    .filter((token) => token.length > 1);
  const tokens = new Set(normalized);
  setBoundedCache(rankingPathTokenCache, lowered, tokens);
  return tokens;
}

function splitNameTokens(name: string): Set<string> {
  if (!name) {
    return new Set<string>();
  }

  const lowered = name.toLowerCase();
  const cache = rankingNameTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const splitTokens = name
    .replace(/[_./\\-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

  const fullToken = lowered.replace(/[^\w]/g, "");
  const tokens = new Set([
    ...splitTokens,
    ...(fullToken.length > 1 && !STOPWORDS.has(fullToken) ? [fullToken] : []),
  ]);
  setBoundedCache(rankingNameTokenCache, lowered, tokens);
  return tokens;
}

export function chunkTypeBoost(chunkType: string): number {
  switch (chunkType) {
    case "function":
    case "function_declaration":
    case "method":
    case "method_definition":
    case "class":
    case "class_declaration":
      return CHUNK_TYPE_PRIMARY_BOOST;
    case "interface":
    case "type":
    case "enum":
    case "struct":
    case "impl":
    case "trait":
    case "constant":
      return CHUNK_TYPE_SECONDARY_BOOST;
    case "module":
      return CHUNK_TYPE_MODULE_PENALTY;
    case "other":
      return CHUNK_TYPE_OTHER_PENALTY;
    default:
      return 0;
  }
}

function getInterfaceTypePenalty(taskType: SearchTaskType, chunkType: string): number {
  if (taskType !== "definition") {
    return 0;
  }

  return chunkType === "interface" || chunkType === "type" ? INTERFACE_TYPE_DEFINITION_PENALTY : 0;
}

function shouldSuppressUnnamedSiblingCandidate(candidate: RankedCandidate): boolean {
  const chunkType = candidate.metadata.chunkType;
  const name = candidate.metadata.name?.trim() ?? "";
  if (chunkType === "other") {
    return name.length === 0;
  }

  if (chunkType !== "module") {
    return false;
  }

  if (name.length === 0 || name === "<default>") {
    return true;
  }

  return name.startsWith("<") && name.endsWith(">");
}

function resolveRetrievalCandidateLimit(limit: number): number {
  return Math.max(DEFAULT_RETRIEVAL_CANDIDATE_K, limit * 4);
}

function normalizeDirectoryFilter(directory: string): string {
  return directory.replace(/^\/|\/$/g, "");
}

/**
 * @internal Test-only reference implementation for hard metadata filters.
 * The hot retrieval path uses the SQLite-backed branch query instead.
 */
export function matchesHardRetrievalFilters(
  metadata: ChunkMetadata,
  filters: HardRetrievalFilters
): boolean {
  if (filters.excludeFile && metadata.filePath === filters.excludeFile) {
    return false;
  }

  if (filters.fileType) {
    const ext = metadata.filePath.split(".").pop()?.toLowerCase();
    if (ext !== filters.fileType.toLowerCase().replace(/^\./, "")) {
      return false;
    }
  }

  if (filters.directory) {
    const normalizedDir = normalizeDirectoryFilter(filters.directory);
    if (
      !metadata.filePath.includes(`/${normalizedDir}/`) &&
      !metadata.filePath.includes(`${normalizedDir}/`)
    ) {
      return false;
    }
  }

  if (filters.chunkType && metadata.chunkType !== filters.chunkType) {
    return false;
  }

  return true;
}

function isTestOrDocPath(filePath: string): boolean {
  return TEST_PATH_SEGMENTS.some((segment) => filePath.includes(segment));
}

function isLikelyTestPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return (
    lowered.includes("tests/") ||
    lowered.includes("__tests__/") ||
    lowered.includes("/test/") ||
    lowered.includes(".spec.") ||
    lowered.includes(".test.") ||
    lowered.includes("fixtures/")
  );
}

function isLikelyImplementationPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  if (IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS.some((segment) => lowered.includes(segment))) {
    return false;
  }

  const ext = lowered.split(".").pop() ?? "";
  if (["md", "mdx", "txt", "rst", "adoc", "snap", "json", "yaml", "yml", "lock"].includes(ext)) {
    return false;
  }

  return true;
}

function classifyQueryIntent(tokens: string[]): "source" | "doc_test" {
  const sourceIntentHits = tokens.filter((t) => SOURCE_INTENT_HINTS.has(t)).length;
  const docTestIntentHits = tokens.filter((t) => DOC_TEST_INTENT_HINTS.has(t)).length;
  return sourceIntentHits >= docTestIntentHits ? "source" : "doc_test";
}

function classifyQueryIntentRaw(query: string): "source" | "doc_test" {
  const lowerQuery = query.toLowerCase();
  const docTestRawHits = Array.from(DOC_TEST_INTENT_HINTS).filter((hint) =>
    new RegExp(`\\b${hint}\\b`).test(lowerQuery)
  ).length;
  const sourceRawHits = [
    "implement",
    "implementation",
    "implements",
    "function",
    "method",
    "class",
    "logic",
    "algorithm",
    "pipeline",
    "indexer",
  ].filter((hint) => new RegExp(`\\b${hint}\\b`).test(lowerQuery)).length;

  if (docTestRawHits > sourceRawHits) {
    return "doc_test";
  }

  if (sourceRawHits > docTestRawHits) {
    return "source";
  }

  const hasWhereIsPattern = /\bwhere\s+is\b/.test(lowerQuery);
  const hasIdentifierHints = extractIdentifierHints(query).length > 0;
  if (hasWhereIsPattern && hasIdentifierHints && docTestRawHits === 0) {
    return "source";
  }

  const queryTokens = Array.from(tokenizeTextForRanking(query));
  return classifyQueryIntent(queryTokens);
}

function containsBugStyleErrorMarkers(query: string): boolean {
  const lines = query.split(/\r?\n/);
  return lines.some((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return false;
    }

    return (
      /^at\s+\S+/.test(trimmed) ||
      /^(error|err|e)\w*\d{2,}/i.test(trimmed) ||
      /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|RuntimeError|\w+Exception)\b/.test(trimmed)
    );
  });
}

function hasWeakShouldButBugSignal(query: string): boolean {
  const lower = query.toLowerCase();
  const shouldIndex = lower.indexOf("should");
  if (shouldIndex < 0) {
    return false;
  }

  const butIndex = lower.indexOf("but", shouldIndex + "should".length);
  if (butIndex < 0) {
    return false;
  }

  return (butIndex - shouldIndex) <= 80;
}

function isTestQuestionContext(query: string): boolean {
  return /\?/.test(query) || /^\s*(?:what|where|which|how|why)\b/i.test(query);
}

function containsTestDebugSignals(query: string): boolean {
  const lower = query.toLowerCase();

  if (
    /\b(?:failing|broken)\s+tests?\b/.test(lower) ||
    /\btest failure\b/.test(lower)
  ) {
    return true;
  }

  if (
    /\bwhat does\s+.+\s+test\b/.test(lower) ||
    /\btests?\s+for\b/.test(lower) ||
    /\bwhat tests?\s+cover\b/.test(lower) ||
    /\bwhere are(?:\s+the)?\s+.+\s+tests?\b/.test(lower) ||
    /\btest(?:s)?\s+(?:cover|covers|covering)\b/.test(lower)
  ) {
    return true;
  }

  if (
    /\bcoverage\b/.test(lower) &&
    /\b(?:test|tests|spec|specs|cover|covers|covering)\b/.test(lower)
  ) {
    return true;
  }

  if (
    isTestQuestionContext(query) &&
    /\b(?:describe|it block|beforeeach)\b/i.test(query)
  ) {
    return true;
  }

  return false;
}

export function inferRelationshipGraphDirection(query: string): GraphExpansionDirection | null {
  const lower = query.toLowerCase().trim();

  const calleePatterns = [
    /\bwhat\s+does\s+.+\s+call\b/,
    /\bwhat\s+does\s+.+\s+depend\s+on\b/,
    /\bwhat\s+does\s+.+\s+import\b/,
    /\bcallees?\s+of\b/,
  ];
  if (calleePatterns.some((pattern) => pattern.test(lower))) {
    return "callee";
  }

  const callerPatterns = [
    /\b(?:what|who)\s+calls?\b/,
    /\bcallers?\s+of\b/,
    /\b(?:what|who)\s+uses?\b/,
    /\bwhere\s+is\s+.+\s+used\b/,
    /\bwhere\s+is\s+.+\s+called\b/,
    /\bwhat\s+depends\s+on\b/,
    /\bwhat\s+imports?\b/,
    /\busages?\s+of\b/,
    /\breferences?\s+to\b/,
    /\bcall\s+sites?\b/,
  ];
  if (callerPatterns.some((pattern) => pattern.test(lower))) {
    return "caller";
  }

  return null;
}

function cleanRelationshipTarget(rawTarget: string): string | null {
  const trimmed = rawTarget
    .trim()
    .replace(/^[`"'([{<\s]+/, "")
    .replace(/[`"')\]}>?,.;:!\s]+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function inferRelationshipTarget(query: string): string | null {
  const trimmed = query.trim();
  const patterns = [
    /\b(?:what|who)\s+calls?\s+(.+)$/i,
    /\bcallers?\s+of\s+(.+)$/i,
    /\b(?:what|who)\s+uses?\s+(.+)$/i,
    /\bwhere\s+is\s+(.+?)\s+used$/i,
    /\bwhere\s+is\s+(.+?)\s+called$/i,
    /\bwhat\s+depends\s+on\s+(.+)$/i,
    /\bwhat\s+imports?\s+(.+)$/i,
    /\busages?\s+of\s+(.+)$/i,
    /\breferences?\s+to\s+(.+)$/i,
    /\bcall\s+sites?\s+(?:of|for)\s+(.+)$/i,
    /\bwhat\s+does\s+(.+?)\s+call$/i,
    /\bwhat\s+does\s+(.+?)\s+depend\s+on$/i,
    /\bwhat\s+does\s+(.+?)\s+import$/i,
    /\bcallees?\s+of\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) {
      continue;
    }

    const cleaned = cleanRelationshipTarget(match[1] ?? "");
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function applyCallerTargetPenalty(
  query: string,
  candidates: RankedCandidate[],
  taskType: SearchTaskType
): RankedCandidate[] {
  if (taskType !== "definition" || candidates.length < 2) {
    return candidates;
  }

  if (inferRelationshipGraphDirection(query) !== "caller") {
    return candidates;
  }

  const target = inferRelationshipTarget(query)?.toLowerCase();
  if (!target) {
    return candidates;
  }

  const rescored = candidates.map((candidate, originalIndex) => {
    const candidateName = candidate.metadata.name?.toLowerCase();
    const penalty = candidateName === target ? CALLER_TARGET_PENALTY : 0;
    const nextCandidate = penalty === 0
      ? candidate
      : {
          ...candidate,
          score: candidate.score - penalty,
        };
    if (penalty !== 0) {
      recordScoreStage(nextCandidate, {
        name: STRUCTURAL_RELATIONSHIP_STAGE,
        kind: "add",
        before: candidate.score,
        after: nextCandidate.score,
        reason: `callerTargetPenalty: target=${target}; penalty=-${penalty}`,
      });
    }
    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

function applyCallerContentBoost(
  query: string,
  candidates: RankedCandidate[],
  storedChunkTexts: Map<string, string>,
  taskType: SearchTaskType
): RankedCandidate[] {
  if (taskType !== "definition" || candidates.length < 2) {
    return candidates;
  }

  if (inferRelationshipGraphDirection(query) !== "caller") {
    return candidates;
  }

  const target = inferRelationshipTarget(query)?.toLowerCase();
  if (!target) {
    return candidates;
  }

  const rescored = candidates.map((candidate, originalIndex) => {
    const candidateName = candidate.metadata.name?.toLowerCase() ?? "";
    const chunkText = storedChunkTexts.get(candidate.metadata.hash)?.toLowerCase() ?? "";
    const referencesTarget = candidateName !== target && chunkText.includes(target);
    const boost = referencesTarget &&
      isImplementationChunkType(candidate.metadata.chunkType) &&
      isLikelyImplementationPath(candidate.metadata.filePath)
      ? CALLER_CONTENT_BOOST
      : 0;
    const nextCandidate = boost === 0
      ? candidate
      : {
          ...candidate,
          score: candidate.score + boost,
        };
    if (boost !== 0) {
      recordScoreStage(nextCandidate, {
        name: STRUCTURAL_RELATIONSHIP_STAGE,
        kind: "add",
        before: candidate.score,
        after: nextCandidate.score,
        reason: `callerContentBoost: target=${target}; boost=${boost}`,
      });
    }

    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

function applyRelationshipGraphBias(
  query: string,
  candidates: RankedCandidate[],
  taskType: SearchTaskType
): RankedCandidate[] {
  if (taskType !== "definition" || candidates.length < 2) {
    return candidates;
  }

  const direction = inferRelationshipGraphDirection(query);
  if (!direction || direction === "both") {
    return candidates;
  }

  const rescored = candidates.map((candidate, originalIndex) => {
    const isDirectRelationship = candidate.relation === direction;
    const boost = isDirectRelationship
      ? (isTestOrDocPath(candidate.metadata.filePath) ? RELATIONSHIP_BIAS_TEST_DOC : RELATIONSHIP_BIAS_SOURCE)
      : 0;
    const nextCandidate = boost === 0
      ? candidate
      : {
          ...candidate,
          score: candidate.score + boost,
        };
    if (boost !== 0) {
      recordScoreStage(nextCandidate, {
        name: STRUCTURAL_RELATIONSHIP_STAGE,
        kind: "add",
        before: candidate.score,
        after: nextCandidate.score,
        reason: `relationshipGraphBias: direction=${direction}; relation=${candidate.relation}; boost=${boost}`,
      });
      addBreakdownSource(nextCandidate, "graph");
    }

    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

function injectRelationshipGraphCandidates(
  query: string,
  candidates: RankedCandidate[],
  database: Database,
  branch: string,
  graphDepth: number,
  graphDirection: GraphExpansionDirection,
  allowedChunkIds: Set<string> | null,
  taskType: SearchTaskType,
  includeScoreBreakdown: boolean = false
): RankedCandidate[] {
  if (taskType !== "definition" || candidates.length === 0 || graphDepth <= 0 || graphDirection === "both") {
    return candidates;
  }

  const graphSeedCandidates = selectGraphSeedsForQuery(candidates, graphDirection, query);
  const graphSeeds: GraphExpansionSeed[] = graphSeedCandidates.map((candidate) => ({
    id: candidate.id,
    metadata: candidate.metadata,
  }));
  const expanded = expandGraphContext(database, graphSeeds, {
    branch,
    depth: graphDepth,
    direction: graphDirection,
    allowedChunkIds,
  });
  if (expanded.length === 0) {
    return candidates;
  }

  const byId = new Map(candidates.map((candidate): [string, RankedCandidate] => [candidate.id, candidate]));
  for (const entry of expanded) {
    const existing = byId.get(entry.id);
    const baseGraphScore = isTestOrDocPath(entry.metadata.filePath) ? GRAPH_TEST_DOC_FLOOR : GRAPH_SOURCE_FLOOR;
    const graphScore = baseGraphScore - Math.max(0, entry.depth - 1) * GRAPH_DEPTH_DECAY;
    const before = existing?.score ?? Number.NEGATIVE_INFINITY;
    const after = Math.max(before, graphScore);
    const scoreBreakdown = existing?.scoreBreakdown
      ? cloneScoreBreakdown(existing.scoreBreakdown)
      : includeScoreBreakdown
        ? createScoreBreakdown({}, "rrf", Number.isFinite(before) ? before : 0, 0, ["graph"])
        : undefined;
    const nextCandidate: RankedCandidate = {
      ...existing,
      id: entry.id,
      score: after,
      metadata: existing?.metadata ?? entry.metadata,
      lane: existing?.lane ?? "hybrid",
      relation: entry.relation,
      chunkKind: existing?.chunkKind ?? entry.metadata.chunkKind,
      symbolKind: existing?.symbolKind ?? entry.metadata.symbolKind,
      reranked: existing?.reranked,
      scoreBreakdown,
    };
    if (nextCandidate.scoreBreakdown) {
      addBreakdownSource(nextCandidate, "graph");
      recordScoreStage(nextCandidate, {
        name: DETERMINISTIC_INTENT_STAGE,
        kind: existing ? "set-min" : "set",
        before: Number.isFinite(before) ? before : 0,
        after,
        reason: `graphInjection: relation=${entry.relation}; depth=${entry.depth}; graphScore=${graphScore}`,
      });
    }
    byId.set(entry.id, {
      ...nextCandidate,
    });
  }

  return Array.from(byId.values()).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });
}

function selectGraphSeedsForQuery(
  candidates: RankedCandidate[],
  direction: GraphExpansionDirection,
  query: string
): RankedCandidate[] {
  if (direction === "both") {
    return candidates;
  }

  const relationshipTarget = inferRelationshipTarget(query);
  if (relationshipTarget) {
    const normalizedTarget = relationshipTarget.toLowerCase();
    const exactNameMatches = candidates.filter((candidate) => candidate.metadata.name?.toLowerCase() === normalizedTarget);
    if (exactNameMatches.length > 0) {
      return exactNameMatches;
    }
  }

  return candidates.slice(0, 1);
}

function isCoarseFileChunk(candidate: RankedCandidate): boolean {
  return (candidate.chunkKind ?? candidate.metadata.chunkKind) === "File";
}

function hasIdentifierAlignedSymbolAnswer(candidate: RankedCandidate, identifierHints: string[]): boolean {
  if (isCoarseFileChunk(candidate)) {
    return false;
  }

  const nameLower = (candidate.metadata.name ?? "").toLowerCase();
  const pathLower = candidate.metadata.filePath.toLowerCase();

  return identifierHints.some((hint) => {
    const variants = normalizeIdentifierVariants(hint);
    return variants.some((variant) =>
      nameLower === variant ||
      nameLower.includes(variant) ||
      pathLower.includes(variant)
    );
  });
}

function suppressCoarseFileChunksWhenSymbolMatchesExist(
  query: string,
  candidates: RankedCandidate[]
): RankedCandidate[] {
  const identifierHints = extractIdentifierHints(query);
  if (identifierHints.length === 0) {
    return candidates;
  }

  const hasFineSymbolMatch = candidates.some((candidate) =>
    hasIdentifierAlignedSymbolAnswer(candidate, identifierHints)
  );
  if (!hasFineSymbolMatch) {
    return candidates;
  }

  return candidates.filter((candidate) => !isCoarseFileChunk(candidate));
}

export function getChunkKindPenaltyFactor(
  taskType: SearchTaskType,
  chunkKind: ChunkKind | undefined
): number {
  const penalty = getSearchRecipe(taskType).testDocChunkPenalty;
  if (!penalty) {
    return 1;
  }

  return chunkKind === "Test" || chunkKind === "Doc" ? penalty : 1;
}

function shouldApplyChunkKindPenalty(_query: string, taskType: SearchTaskType): boolean {
  const penalty = getSearchRecipe(taskType).testDocChunkPenalty;
  if (!penalty) {
    return false;
  }

  if (taskType === "semantic" && /\b(?:query|input) type to task recipe mapping\b/i.test(_query)) {
    return false;
  }

  return true;
}

export function applyChunkKindPenalty(
  candidates: RankedCandidate[],
  taskType: SearchTaskType,
  query: string = ""
): RankedCandidate[] {
  if (!shouldApplyChunkKindPenalty(query, taskType) || candidates.length < 2) {
    return candidates;
  }

  const rescored = candidates.map((candidate, originalIndex) => {
    const chunkKind = candidate.chunkKind ?? candidate.metadata.chunkKind;
    const factor = getChunkKindPenaltyFactor(taskType, chunkKind);
    const before = candidate.score;
    const nextCandidate = factor === 1
      ? candidate
      : {
          ...candidate,
          score: candidate.score * factor,
        };
    if (factor !== 1) {
      recordScoreStage(nextCandidate, {
        name: PATH_AND_KIND_SUPPRESSION_STAGE,
        kind: "multiply",
        before,
        after: nextCandidate.score,
        reason: `testDocChunkPenalty: chunkKind=${chunkKind}; factor=${factor} (${before}->${nextCandidate.score})`,
      });
    }
    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

export function applyDefinitionImplementationPolicy(
  candidates: RankedCandidate[],
  query: string,
  taskType: SearchTaskType,
  graphDirection: GraphExpansionDirection,
  includeScoreBreakdown: boolean = false,
  subIntent: SubIntent = null
): RankedCandidate[] {
  if (
    taskType !== "definition" ||
    graphDirection !== "both" ||
    candidates.length < 2 ||
    (subIntent !== "definition:declarative" && !isImplementationSeekingDefinitionQuery(query))
  ) {
    return candidates;
  }

  const penalizedFiles = new Set<string>();
  const penalized = candidates.map((candidate, originalIndex) => {
    const category = classifyDefinitionWinnerCategory(
      candidate.metadata.filePath,
      candidate.metadata.chunkType,
      candidate.metadata.name
    );
    const hasExactEvidence =
      hasExactIdentifierQuality(candidate.identifierQuality) ||
      hasExactSymbolEvidence(candidate.scoreBreakdown?.stages);
    let penalty = 0;

    if (subIntent === "definition:executable" && !hasExactEvidence) {
      switch (category) {
        case "wrapper-export":
          penalty = 0.12;
          break;
        case "type-interface":
        case "options-shape":
          penalty = 0.09;
          break;
        case "module":
          penalty = 0.15;
          break;
        default:
          penalty = 0;
      }
    } else if (subIntent === "definition:declarative") {
      penalty = 0;
    } else {
      penalty = getDefinitionImplementationPenalty({
        query,
        filePath: candidate.metadata.filePath,
        chunkType: candidate.metadata.chunkType,
        name: candidate.metadata.name,
        identifierQuality: candidate.identifierQuality,
        stages: candidate.scoreBreakdown?.stages,
      });
    }

    const nextCandidate = penalty === 0
      ? candidate
      : {
          ...candidate,
          score: candidate.score - penalty,
        };
    if (penalty !== 0) {
      penalizedFiles.add(candidate.metadata.filePath.replaceAll("\\", "/"));
      if (includeScoreBreakdown) {
        recordScoreStage(nextCandidate, {
          name: DEFINITION_IMPLEMENTATION_POLICY_STAGE,
          kind: "add",
          before: candidate.score,
          after: nextCandidate.score,
          reason: `subIntent=${subIntent ?? "null"}; category=${category}; adjustment=-${penalty}`,
        });
      }
    }

    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  const rescored = penalized.map((entry) => {
    const category = classifyDefinitionWinnerCategory(
      entry.candidate.metadata.filePath,
      entry.candidate.metadata.chunkType,
      entry.candidate.metadata.name
    );
    const hasExactEvidence =
      hasExactIdentifierQuality(entry.candidate.identifierQuality) ||
      hasExactSymbolEvidence(entry.candidate.scoreBreakdown?.stages);
    const sameFilePenalized = penalizedFiles.has(entry.candidate.metadata.filePath.replaceAll("\\", "/"));
    let bonus = 0;
    if (subIntent === "definition:declarative") {
      if (!hasExactEvidence && (category === "type-interface" || category === "options-shape")) {
        bonus = 0.06;
      }
    } else if (subIntent === "definition:executable") {
      if (!hasExactEvidence && sameFilePenalized && category === "implementation") {
        bonus = 0.05;
      }
    } else {
      bonus = sameFilePenalized
        ? getDefinitionImplementationBonus({
            query,
            filePath: entry.candidate.metadata.filePath,
            chunkType: entry.candidate.metadata.chunkType,
            name: entry.candidate.metadata.name,
            identifierQuality: entry.candidate.identifierQuality,
            stages: entry.candidate.scoreBreakdown?.stages,
            sameFilePenalized,
          })
        : 0;
    }

    const nextCandidate = bonus === 0
      ? entry.candidate
      : {
          ...entry.candidate,
          score: entry.candidate.score + bonus,
        };
    if (bonus !== 0 && includeScoreBreakdown) {
      recordScoreStage(nextCandidate, {
        name: DEFINITION_IMPLEMENTATION_POLICY_STAGE,
        kind: "add",
        before: entry.candidate.score,
        after: nextCandidate.score,
        reason: `subIntent=${subIntent ?? "null"}; category=${category}; adjustment=+${bonus}; sameFilePenalized=${sameFilePenalized}`,
      });
    }

    return {
      candidate: nextCandidate,
      originalIndex: entry.originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

function applySemanticSourcePathPenalty(
  candidates: RankedCandidate[],
  taskType: SearchTaskType,
  pathPreference: SearchPathPreference
): RankedCandidate[] {
  if (taskType !== "semantic" || pathPreference !== "source" || candidates.length < 2) {
    return candidates;
  }

  const rescored = candidates.map((candidate, originalIndex) => {
    const shouldPenalize = isTestOrDocPath(candidate.metadata.filePath);
    const nextCandidate = shouldPenalize
      ? {
          ...candidate,
          score: candidate.score - SEMANTIC_TEST_DOC_PATH_PENALTY,
        }
      : candidate;
    if (shouldPenalize) {
      const reason = `semanticPathPenalty: isTestOrDocPath=true delta=-${SEMANTIC_TEST_DOC_PATH_PENALTY} (${candidate.score}->${nextCandidate.score})`;
      appendPathAndKindSuppressionReason(nextCandidate, candidate.score, reason);
      if (!nextCandidate.scoreBreakdown?.stages.some((stage) =>
        stage.name === PATH_AND_KIND_SUPPRESSION_STAGE &&
        stage.after === nextCandidate.score &&
        stage.reason.includes(reason)
      )) {
        recordScoreStage(nextCandidate, {
          name: PATH_AND_KIND_SUPPRESSION_STAGE,
          kind: "add",
          before: candidate.score,
          after: nextCandidate.score,
          reason,
        });
      }
    }
    return {
      candidate: nextCandidate,
      originalIndex,
    };
  });

  rescored.sort((left, right) => {
    if (right.candidate.score !== left.candidate.score) {
      return right.candidate.score - left.candidate.score;
    }
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return rescored.map((entry) => entry.candidate);
}

function preferEarlierNamedChunkSlices(candidates: RankedCandidate[]): RankedCandidate[] {
  if (candidates.length < 2) {
    return candidates;
  }

  const reordered = [...candidates];
  let index = 0;

  while (index < reordered.length) {
    const current = reordered[index];
    const currentName = current?.metadata.name?.trim();
    if (!current || !currentName) {
      index += 1;
      continue;
    }

    const groupStart = index;
    index += 1;
    while (index < reordered.length) {
      const next = reordered[index];
      const nextName = next?.metadata.name?.trim();
      if (
        !next ||
        !nextName ||
        next.metadata.filePath !== current.metadata.filePath ||
        next.metadata.chunkType !== current.metadata.chunkType ||
        nextName !== currentName
      ) {
        break;
      }
      index += 1;
    }

    if (index - groupStart > 1) {
      const sortedGroup = reordered
        .slice(groupStart, index)
        .sort((left, right) => left.metadata.startLine - right.metadata.startLine);
      reordered.splice(groupStart, sortedGroup.length, ...sortedGroup);
    }
  }

  return reordered;
}

export function inferTaskType(query: string, explicit?: SearchTaskType): SearchTaskType {
  if (explicit) {
    return explicit;
  }

  if (inferRelationshipGraphDirection(query)) {
    return "definition";
  }

  if (containsTestDebugSignals(query)) {
    return "test_debug";
  }

  if (/\bexpected behavior\b/i.test(query) || /\bactual behavior\b/i.test(query)) {
    return "bug";
  }

  if (/\bsteps to reproduce\b/i.test(query) || /\breproduction\b/i.test(query)) {
    return "bug";
  }

  if (containsBugStyleErrorMarkers(query)) {
    return "bug";
  }

  if (hasWeakShouldButBugSignal(query)) {
    return "bug";
  }

  return "general";
}

function isDeclarativeDefinitionQuery(query: string): boolean {
  const lower = query.toLowerCase();

  if (
    /\b(?:what|which)\s+type\b/.test(lower) ||
    /\binterface\s+(?:for|of)\b/.test(lower) ||
    /\bschema(?:\s+shape)?\s+(?:for|of)?\b/.test(lower) ||
    /\bshape\s+of\b/.test(lower) ||
    /\bcontract\s+(?:for|of)\b/.test(lower) ||
    /\brepresents?\b/.test(lower)
  ) {
    return true;
  }

  return /\b(?:config|configuration|options?|params?|props?)\b/.test(lower) &&
    /\b(?:type|interface|schema|shape|represents?)\b/.test(lower);
}

function isBugErrorSourceSubIntent(query: string): boolean {
  if (containsBugStyleErrorMarkers(query)) {
    return true;
  }

  if (/[`"'“”][^`"'“”]{3,}[`"'“”]/.test(query)) {
    return true;
  }

  const lower = query.toLowerCase();
  if (
    /\bwhere\s+does\b.+\bthrow\b/.test(lower) ||
    /\bwhere\s+does\s+bootstrapping\b/.test(lower) ||
    /\bwhere\s+does\s+merging\b/.test(lower) ||
    /\bwhere\s+does\s+shallow\b/.test(lower) ||
    /\bwhere\s+does\s+the\s+plain\b/.test(lower) ||
    /\bwhere\s+does\s+the\s+eventsource\b/.test(lower)
  ) {
    return true;
  }

  return (
    /\b(?:throws?|exception|error(?:\s+message)?)\b/.test(lower) &&
    /\b(?:[A-Z][A-Za-z0-9]+(?:Error|Exception)|[a-z_]+error)\b/.test(query)
  );
}

function isBugBehaviorOwnerSubIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\bwhy\s+does\b/.test(lower) ||
    /\bwhat\s+causes\b/.test(lower) ||
    /\bwhy\s+is\b.+\bnot\s+working\b/.test(lower) ||
    /\bwhere\s+does\b.+\bgo\s+wrong\b/.test(lower) ||
    /\bwhy\b.+\bfail(?:ing|s|ed)?\b/.test(lower) ||
    /\bfind\s+the\s+code\s+responsible\s+for\b/.test(lower) ||
    /\bfind\s+the\s+code\s+path\s+that\b/.test(lower) ||
    /\bfind\s+the\b.+\bbug\b/.test(lower) ||
    /\bfind\s+the\s+code\s+that\s+makes\b/.test(lower) ||
    /\bfind\s+the\b.+\blogic\b.+\bshould\b/.test(lower) ||
    /\bfallback\s+bug\b/.test(lower) ||
    /\bleaking\s+.+\bfrom\s+another\s+branch\b/.test(lower) ||
    /\breads?\b.+\binstead\s+of\b/.test(lower) ||
    /\btransient\s+lock\s+contention\b/.test(lower)
  );
}

function isTestDiscoverySubIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\bwhat\s+tests?\s+cover\b/.test(lower) ||
    /\btests?\s+for\b/.test(lower) ||
    /\bspecs?\s+for\b/.test(lower) ||
    /\bshow\s+me\s+the\s+tests?\s+covering\b/.test(lower) ||
    /\bshow\s+me\s+the\b.+\btests?\b/.test(lower) ||
    /\b(?:integration\s+)?tests?\s+exercise\b/.test(lower) ||
    /\btests?\s+validate\b/.test(lower) ||
    /\bwhere\s+are(?:\s+the)?\s+.+\s+tests?\b/.test(lower) ||
    /\bcoverage\b/.test(lower)
  );
}

function isConceptImplementationSubIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\bwhere\s+does\s+the\s+(?:framework|runtime|server|client|system)\b/.test(lower) ||
    /\bwhere\s+are\s+.+\s+processed\b/.test(lower) ||
    /\bwhere\s+does\s+.+\s+get\b/.test(lower) ||
    /\bwhere\s+do\s+.+\s+get\b/.test(lower) ||
    /\bhow\s+does\b/.test(lower) ||
    /\bhow\s+does\s+the\b/.test(lower) ||
    /\bhow\s+is\b.+\bhandled\b/.test(lower) ||
    /\bwhere\s+are\s+periodic\b/.test(lower) ||
    /\bwhere\s+are\s+.+\s+merged\b/.test(lower) ||
    /\bwhat\s+implements\b/.test(lower) ||
    /\bwhere\s+is\b.+\bimplemented\b/.test(lower) ||
    /\bimplementation\s+of\b/.test(lower) ||
    /\bhow\b.+\bwork\b/.test(lower) ||
    /\bfind\s+the\s+(?:tool|function|code)\s+that\b/.test(lower) ||
    /\bwhat\s+function\s+writes\b/.test(lower) ||
    /\bwhich\s+file\s+implements\b/.test(lower) ||
    /\bwhich\s+tool\s+returns\b/.test(lower) ||
    /\bwhich\s+tool\s+streams?\b/.test(lower)
  );
}

function isConceptArchitectureSubIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return (
    /\bwhat\s+handles\b/.test(lower) ||
    /\bwhat\s+owns\b/.test(lower) ||
    /\bwhat\s+manages\b/.test(lower) ||
    /\bwhat\s+is\s+responsible\s+for\b/.test(lower) ||
    /\bwhich\s+(?:component|module|service)\b.+\bhandles\b/.test(lower) ||
    /\bwhich\s+file\s+owns\b/.test(lower) ||
    /\bwhich\s+file\s+is\s+responsible\s+for\b/.test(lower)
  );
}

function isConfigDefinitionSubIntent(query: string): boolean {
  const lower = query.toLowerCase();
  const hasDefinitionFrame =
    /\b(?:where|show\s+me\s+where)\b.+\bdefined\b/.test(lower) ||
    /\bwhat\s+is\s+the\s+default\b/.test(lower);
  const hasConfigSignal =
    /\bconfig\b/.test(lower) ||
    /\bdefault\b/.test(lower) ||
    /\b(?:fusionstrategy|hybridweight|rrfk|reranktopn)\b/.test(lower) ||
    /\b(?:sqlite_busy_timeout_ms|arctic_query_prefix|voyage_default_model_id)\b/.test(lower);
  return hasDefinitionFrame && hasConfigSignal;
}

export function inferSubIntent(query: string, taskType: SearchTaskType): SubIntent {
  if (query.trim().length === 0) {
    return null;
  }

  const lower = query.toLowerCase();
  if ((taskType === "general" || taskType === "semantic") && isConfigDefinitionSubIntent(query)) {
    return "definition:declarative";
  }
  const hasDefinitionFrame =
    /\bwhere\s+is\b.+\bdefined\b/.test(lower) ||
    (/^\s*where\s+is\s+the\b/.test(lower) && /\bdefined\s*$/.test(lower));
  if (taskType === "definition" && hasDefinitionFrame && isImplementationSeekingDefinitionQuery(query)) {
    return "definition:executable";
  }

  const relationshipDirection = inferRelationshipGraphDirection(query);
  if (taskType === "definition" && relationshipDirection === "caller") {
    return "relationship:caller";
  }
  if (taskType === "definition" && relationshipDirection === "callee") {
    return "relationship:callee";
  }
  if (
    taskType === "definition" &&
    (
      /\bwhich\s+.+\s+handler\s+(?:bridges|forwards|wraps|awaits)\b/.test(lower) ||
      /\bwhich\s+.+\s+adapter\b/.test(lower) ||
      /\bwhich\s+.+\s+link\s+reads\b/.test(lower) ||
      /\bwhich\s+.+\s+entrypoint\s+forwards\b/.test(lower) ||
      /\bwhat\s+.+\s+handler\s+closure\b/.test(lower) ||
      /\bwhat\s+.+\s+handler\s+bridges\b/.test(lower) ||
      /\bwhat\s+exported\s+.+\s+entrypoint\b/.test(lower) ||
      /\bwhat\s+async\s+generator\s+helper\b/.test(lower)
    )
  ) {
    return "relationship:callee";
  }

  switch (taskType) {
    case "definition":
      if (isImplementationSeekingDefinitionQuery(query)) {
        return "definition:executable";
      }
      if (isDeclarativeDefinitionQuery(query)) {
        return "definition:declarative";
      }
      return null;
    case "bug":
      if (isBugErrorSourceSubIntent(query)) {
        return "bug:error-source";
      }
      if (isBugBehaviorOwnerSubIntent(query)) {
        return "bug:behavior-owner";
      }
      return null;
    case "test_debug":
      return isTestDiscoverySubIntent(query) ? "test:discovery" : null;
    case "general":
    case "semantic":
      if (isConceptArchitectureSubIntent(query)) {
        return "concept:architecture";
      }
      if (isConceptImplementationSubIntent(query)) {
        return "concept:implementation";
      }
      return null;
  }
}

function normalizeFusionWeights(
  bm25Weight?: number,
  denseWeight?: number,
  voyageWeight?: number,
  hybridWeight?: number | null
): FusionWeights {
  if (bm25Weight !== undefined || denseWeight !== undefined || voyageWeight !== undefined) {
    const normalizedBm25 = Math.max(0, bm25Weight ?? 0);
    const normalizedDense = Math.max(0, denseWeight ?? 0);
    const normalizedVoyage = Math.max(0, voyageWeight ?? 0);
    const total = normalizedBm25 + normalizedDense + normalizedVoyage;

    if (total > 0) {
      return {
        bm25Weight: normalizedBm25 / total,
        denseWeight: normalizedDense / total,
        voyageWeight: normalizedVoyage / total,
      };
    }
  }

  const keywordWeight = Math.min(1, Math.max(0, hybridWeight ?? 0.5));
  return {
    bm25Weight: keywordWeight,
    denseWeight: 1 - keywordWeight,
    voyageWeight: 0,
  };
}

function classifyDocIntent(tokens: string[]): "docs" | "test" | "mixed" | "none" {
  const docHits = tokens.filter((t) => DOC_INTENT_HINTS.has(t)).length;
  const testHits = tokens.filter((t) => ["test", "tests", "fixture", "fixtures", "benchmark"].includes(t)).length;

  if (docHits > 0 && testHits === 0) return "docs";
  if (testHits > 0 && docHits === 0) return "test";
  if (testHits > 0 || docHits > 0) return "mixed";
  return "none";
}

function isImplementationChunkType(chunkType: string): boolean {
  return [
    "export_statement",
    "function",
    "function_declaration",
    "method",
    "method_definition",
    "class",
    "class_declaration",
    "interface",
    "type",
    "enum",
    "module",
    "constant",
  ].includes(chunkType);
}

function extractIdentifierHints(query: string): string[] {
  const identifiers = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return identifiers
    .filter((id) => id.length >= 3)
    .filter((id) => {
      const lower = id.toLowerCase();
      if (STOPWORDS.has(lower)) return false;
      return /[A-Z]/.test(id) || id.includes("_") || id.endsWith("Results") || id.endsWith("Result");
    })
    .map((id) => id.toLowerCase());
}

function extractCodeTermHints(query: string): string[] {
  const terms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term) => !STOPWORDS.has(term));
}

function normalizeIdentifierVariants(identifier: string): string[] {
  const lower = identifier.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const snake = compact.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const kebab = snake.replace(/_/g, "-");
  const variants = [lower, compact, snake, kebab].filter((value) => value.length > 0);
  return Array.from(new Set(variants));
}

function scoreIdentifierMatch(name: string | undefined, filePath: string, hints: string[]): number {
  const nameLower = (name ?? "").toLowerCase();
  const pathLower = filePath.toLowerCase();

  let best = 0;
  for (const hint of hints) {
    const variants = normalizeIdentifierVariants(hint);
    for (const variant of variants) {
      if (nameLower === variant) {
        best = Math.max(best, IDENTIFIER_MATCH_EXACT_SCORE);
      } else if (nameLower.includes(variant)) {
        best = Math.max(best, IDENTIFIER_MATCH_SUBSTRING_SCORE);
      } else if (pathLower.includes(variant)) {
        best = Math.max(best, IDENTIFIER_MATCH_PATH_SCORE);
      }
    }
  }

  return best;
}

function isTypeShapeChunkType(chunkType: string): boolean {
  return chunkType === "interface" || chunkType === "type";
}

function isImplementationSeekingIdentifierQuery(query: string): boolean {
  const lower = query.toLowerCase();
  if (classifyQueryIntentRaw(query) !== "source") {
    return false;
  }

  return /\b(?:function|method|helper|factory|routine|implementation|defined|where\s+does|throw|throws|build|builds|wrap|wraps|return|returns|create|creates|parse|parses|read|reads|call|calls)\b/.test(lower);
}

function collectIdentifierMatchDetails(
  metadata: RetrievalChunkMetadata,
  hints: string[],
  aliases: string[] = []
): {
  exactNameHints: string[];
  aliasHints: string[];
  substringNameHints: string[];
  pathHints: string[];
} {
  const nameLower = (metadata.name ?? "").toLowerCase();
  const pathLower = metadata.filePath.toLowerCase();
  const aliasValues = aliases.map((alias) => alias.toLowerCase());
  const exactNameHints = new Set<string>();
  const aliasHints = new Set<string>();
  const substringNameHints = new Set<string>();
  const pathHints = new Set<string>();

  for (const hint of hints) {
    const normalizedHint = hint.toLowerCase();
    const variants = normalizeIdentifierVariants(normalizedHint);
    for (const variant of variants) {
      const normalizedVariant = variant.replace(/[^a-z0-9]/g, "");
      const normalizedName = nameLower.replace(/[^a-z0-9]/g, "");
      if (nameLower === variant || normalizedName === normalizedVariant) {
        exactNameHints.add(normalizedHint);
      } else if (aliasValues.some((alias) => alias === variant || alias.replace(/[^a-z0-9]/g, "") === normalizedVariant)) {
        aliasHints.add(normalizedHint);
      } else if (nameLower.includes(variant)) {
        substringNameHints.add(normalizedHint);
      } else if (pathLower.includes(variant)) {
        pathHints.add(normalizedHint);
      }
    }
  }

  return {
    exactNameHints: Array.from(exactNameHints),
    aliasHints: Array.from(aliasHints),
    substringNameHints: Array.from(substringNameHints),
    pathHints: Array.from(pathHints),
  };
}

function isGenericCompoundIdentifierTerm(term: string): boolean {
  const normalized = term.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length === 0) {
    return true;
  }
  if (GENERIC_COMPOUND_IDENTIFIER_TERMS.has(normalized)) {
    return true;
  }
  return normalized.length <= 4;
}

export function classifyCompoundIdentifierSpecificity(
  matchedHints: string[]
): {
  specificity: CompoundIdentifierSpecificity;
  genericHints: string[];
  specificHints: string[];
} {
  if (matchedHints.length < 2) {
    return {
      specificity: "not-compound",
      genericHints: [],
      specificHints: [],
    };
  }

  const genericHints: string[] = [];
  const specificHints: string[] = [];
  for (const hint of matchedHints) {
    if (isGenericCompoundIdentifierTerm(hint)) {
      genericHints.push(hint);
    } else {
      specificHints.push(hint);
    }
  }

  if (specificHints.length === 0) {
    return {
      specificity: "generic-compound",
      genericHints,
      specificHints,
    };
  }
  if (genericHints.length === 0) {
    return {
      specificity: "strong-compound",
      genericHints,
      specificHints,
    };
  }
  return {
    specificity: "mixed-compound",
    genericHints,
    specificHints,
  };
}

export function getCompoundIdentifierSpecificity(
  metadata: RetrievalChunkMetadata,
  hints: string[],
  aliases: string[] = []
): CompoundIdentifierSpecificity {
  const details = collectIdentifierMatchDetails(metadata, hints, aliases);
  return classifyCompoundIdentifierSpecificity(details.substringNameHints).specificity;
}

export function classifyIdentifierQuality(
  query: string,
  metadata: RetrievalChunkMetadata,
  hints: string[],
  options: {
    aliases?: string[];
    pathMatchesFileHint?: boolean;
    nameMatchesPrimary?: boolean;
  } = {}
): IdentifierQualityLabel {
  const details = collectIdentifierMatchDetails(metadata, hints, options.aliases);
  if (isImplementationSeekingIdentifierQuery(query) && isTypeShapeChunkType(metadata.chunkType)) {
    return "type-only";
  }
  if (options.pathMatchesFileHint && options.nameMatchesPrimary) {
    return "file-anchored-symbol";
  }
  if (details.exactNameHints.length > 0) {
    return "exact-symbol";
  }
  if (details.aliasHints.length > 0) {
    return "alias-symbol";
  }
  if (details.substringNameHints.length >= 2) {
    return "compound-symbol";
  }
  if (details.substringNameHints.length === 0 && details.pathHints.length > 0) {
    return "path-only";
  }
  return "weak-substring";
}

function formatIdentifierQualityReason(
  query: string,
  metadata: RetrievalChunkMetadata,
  hints: string[],
  options: {
    aliases?: string[];
    pathMatchesFileHint?: boolean;
    nameMatchesPrimary?: boolean;
  } = {}
): string {
  const quality = classifyIdentifierQuality(query, metadata, hints, options);
  const details = collectIdentifierMatchDetails(metadata, hints, options.aliases);
  const matched = [
    ...details.exactNameHints.map((hint) => `${hint}:exact-name`),
    ...details.aliasHints.map((hint) => `${hint}:alias`),
    ...details.substringNameHints.map((hint) => `${hint}:name-substring`),
    ...details.pathHints.map((hint) => `${hint}:path`),
  ];

  const baseReason = `identifierQuality=${quality}; matchedHints=${matched.length > 0 ? matched.join(",") : "none"}`;
  if (quality !== "compound-symbol") {
    return baseReason;
  }

  const compound = classifyCompoundIdentifierSpecificity(details.substringNameHints);
  return `${baseReason}; compoundSpecificity=${compound.specificity}; compoundGenericHints=${compound.genericHints.length > 0 ? compound.genericHints.join(",") : "none"}; compoundSpecificHints=${compound.specificHints.length > 0 ? compound.specificHints.join(",") : "none"}`;
}

function isRiskyIdentifierQuality(
  quality: IdentifierQualityLabel,
  _compoundSpecificity: CompoundIdentifierSpecificity = "not-compound"
): boolean {
  return quality === "weak-substring" ||
    quality === "path-only" ||
    quality === "type-only";
}

export function shouldApplyExperimentalIdentifierRiskPolicy(
  query: string,
  taskType: SearchTaskType | undefined,
  enabled: boolean
): boolean {
  if (!enabled || taskType !== "definition") {
    return false;
  }
  if (inferRelationshipGraphDirection(query)) {
    return false;
  }
  if (containsTestDebugSignals(query)) {
    return false;
  }
  if (/\b(?:config|configuration|constant|default model|default provider)\b/i.test(query)) {
    return false;
  }
  return classifyQueryIntentRaw(query) === "source";
}

export function applyConservativeIdentifierRiskPolicyToSetScore(
  before: number,
  after: number,
  quality: IdentifierQualityLabel,
  enabled: boolean,
  compoundSpecificity: CompoundIdentifierSpecificity = "not-compound"
): number {
  if (!enabled || !isRiskyIdentifierQuality(quality, compoundSpecificity)) {
    return after;
  }

  switch (quality) {
    case "weak-substring":
      return Math.min(after, Math.max(before, 0.9));
    case "path-only":
      return Math.min(after, Math.max(before, 0.88));
    case "type-only":
      return Math.min(after, Math.max(before, 0.86) - 0.04);
    default:
      return after;
  }
}

export function applyConservativeIdentifierRiskPolicyToAddScore(
  before: number,
  after: number,
  quality: IdentifierQualityLabel,
  enabled: boolean,
  compoundSpecificity: CompoundIdentifierSpecificity = "not-compound"
): number {
  if (!enabled || !isRiskyIdentifierQuality(quality, compoundSpecificity)) {
    return after;
  }

  const delta = after - before;
  switch (quality) {
    case "weak-substring":
      return before + delta * 0.25;
    case "path-only":
      return before + delta * 0.15;
    case "type-only":
      return before - 0.04;
    default:
      return after;
  }
}

function formatIdentifierRiskPolicyReason(
  originalScore: number,
  adjustedScore: number
): string {
  return originalScore === adjustedScore
    ? ""
    : `; identifierRiskPolicy=conservative; originalIdentifierScore=${originalScore}; adjustedIdentifierScore=${adjustedScore}`;
}

function extractPrimaryIdentifierQueryHint(query: string): string | null {
  const identifiers = extractIdentifierHints(query);
  if (identifiers.length > 0) {
    return identifiers[0] ?? null;
  }

  const codeTerms = extractCodeTermHints(query);
  const best = codeTerms.find((term) => term.length >= 6);
  return best ?? null;
}

const FILE_PATH_HINT_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rs", "go", "java", "kt", "kts", "swift", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "scala", "lua",
  "sh", "bash", "zsh", "json", "yaml", "yml", "toml",
];

const FILE_PATH_HINT_SUFFIX_REGEX = new RegExp(
  "\\s+\\bin\\s+[\"'`]?((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.(?:" +
  FILE_PATH_HINT_EXTENSIONS.join("|") +
  "))[\"'`]?[\\])}>.,;!?]*\\s*$",
  "i"
);

function normalizeFilePathForHintMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
}

function pathMatchesHint(filePath: string, hint: string): boolean {
  const normalizedPath = normalizeFilePathForHintMatch(filePath);
  const normalizedHint = normalizeFilePathForHintMatch(hint);

  return normalizedPath.endsWith(normalizedHint) ||
    normalizedPath.includes(`/${normalizedHint}`) ||
    normalizedPath.includes(normalizedHint);
}

export function extractFilePathHint(query: string): string | null {
  const match = query.match(FILE_PATH_HINT_SUFFIX_REGEX);
  const rawPath = match?.[1];
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^\.\//, "");
}

export function stripFilePathHint(query: string): string {
  const stripped = query.replace(FILE_PATH_HINT_SUFFIX_REGEX, "").trim();
  return stripped.length > 0 ? stripped : query;
}

function buildDeterministicIdentifierPass(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source",
  includeScoreBreakdown: boolean = false,
  experimentalIdentifierRiskPolicy: boolean = false
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primary = extractPrimaryIdentifierQueryHint(query);
  if (!primary) {
    return [];
  }
  const filePathHint = extractFilePathHint(query);
  const primaryVariants = normalizeIdentifierVariants(primary);

  const hints = [primary, ...extractIdentifierHints(query), ...extractCodeTermHints(query)]
    .map((value) => value.toLowerCase())
    .filter((value, idx, arr) => value.length >= 3 && arr.indexOf(value) === idx)
    .slice(0, 8);

  const deterministic = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();
      let maxMatch = 0;
      const nameMatchesPrimary = primaryVariants.some((variant) =>
        nameLower === variant || nameLower.replace(/[^a-z0-9]/g, "") === variant.replace(/[^a-z0-9]/g, "")
      );
      const pathMatchesFileHint = filePathHint ? pathMatchesHint(candidate.metadata.filePath, filePathHint) : false;

      for (const hint of hints) {
        const variants = normalizeIdentifierVariants(hint);
        for (const variant of variants) {
          if (nameLower === variant) {
            maxMatch = Math.max(maxMatch, 1);
          } else if (nameLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.85);
          } else if (pathLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.7);
          }
        }
      }

      if (pathMatchesFileHint && nameMatchesPrimary) {
        maxMatch = Math.max(maxMatch, 1);
      }

      return {
        candidate,
        maxMatch,
        pathMatchesFileHint,
        nameMatchesPrimary,
      };
    })
    .filter((entry) => entry.maxMatch >= 0.7)
    .sort((a, b) => {
      const aAnchored = a.pathMatchesFileHint && a.nameMatchesPrimary ? 1 : 0;
      const bAnchored = b.pathMatchesFileHint && b.nameMatchesPrimary ? 1 : 0;
      if (aAnchored !== bAnchored) return bAnchored - aAnchored;
      if (b.maxMatch !== a.maxMatch) return b.maxMatch - a.maxMatch;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 12));

  const useIdentifierRiskPolicy = shouldApplyExperimentalIdentifierRiskPolicy(
    query,
    "definition",
    experimentalIdentifierRiskPolicy
  );

  return deterministic.map((entry) => {
    const originalScore = entry.pathMatchesFileHint && entry.nameMatchesPrimary
      ? DETERMINISTIC_IDENTIFIER_EXACT_FILE_HINT_SCORE
      : Math.min(1, DETERMINISTIC_IDENTIFIER_BASE_SCORE + entry.maxMatch * DETERMINISTIC_IDENTIFIER_MATCH_SCALE);
    const quality = classifyIdentifierQuality(query, entry.candidate.metadata, hints, {
      pathMatchesFileHint: entry.pathMatchesFileHint,
      nameMatchesPrimary: entry.nameMatchesPrimary,
    });
    const compoundSpecificity = getCompoundIdentifierSpecificity(entry.candidate.metadata, hints);
    const score = applyConservativeIdentifierRiskPolicyToSetScore(
      entry.candidate.score,
      originalScore,
      quality,
      useIdentifierRiskPolicy,
      compoundSpecificity
    );
    const candidate: RankedCandidate = {
      id: entry.candidate.id,
      score,
      metadata: entry.candidate.metadata,
      identifierQuality: quality,
      scoreBreakdown: cloneScoreBreakdown(entry.candidate.scoreBreakdown),
    };
    if (includeScoreBreakdown) {
      ensureScoreBreakdown(candidate, "identifier");
      recordScoreStage(candidate, {
        name: DETERMINISTIC_INTENT_STAGE,
        kind: "set",
        before: entry.candidate.score,
        after: score,
        reason: `deterministicIdentifierLane: maxMatch=${entry.maxMatch}; pathMatchesFileHint=${entry.pathMatchesFileHint}; nameMatchesPrimary=${entry.nameMatchesPrimary}; ${formatIdentifierQualityReason(query, entry.candidate.metadata, hints, {
          pathMatchesFileHint: entry.pathMatchesFileHint,
          nameMatchesPrimary: entry.nameMatchesPrimary,
        })}${formatIdentifierRiskPolicyReason(originalScore, score)}`,
      });
    }
    return candidate;
  });
}

export function fuseResultsWeighted(
  lanes: FusionLane[],
  limit: number,
  scoreBreakdownLanes?: Map<string, ScoreBreakdown["lanes"]>
): RankedCandidate[] {
  const fusedScores = new Map<string, {
    score: number;
    metadata: RetrievalChunkMetadata;
    lane?: SearchResultLane;
  }>();

  for (const lane of lanes) {
    if (lane.weight <= 0 || lane.results.length === 0) {
      continue;
    }

    for (const result of lane.results) {
      const existing = fusedScores.get(result.id);
      if (existing) {
        existing.score += result.score * lane.weight;
        existing.lane = mergeSearchResultLane(existing.lane, result.lane);
      } else {
        fusedScores.set(result.id, {
          score: result.score * lane.weight,
          metadata: result.metadata,
          lane: result.lane,
        });
      }
    }
  }

  const results: RankedCandidate[] = Array.from(fusedScores.entries()).map(([id, data]) => ({
    id,
    score: data.score,
    metadata: data.metadata,
    lane: data.lane,
  }));

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const bounded = results.slice(0, limit);
  if (scoreBreakdownLanes) {
    bounded.forEach((candidate, index) => {
      const laneBreakdown = scoreBreakdownLanes.get(candidate.id) ?? {};
      candidate.scoreBreakdown = createScoreBreakdown(
        laneBreakdown,
        "weighted",
        candidate.score,
        index + 1,
        sourcesFromLaneBreakdown(laneBreakdown)
      );
    });
  }
  return bounded;
}

export function fuseResultsRrf(
  lanes: FusionLane[],
  rrfK: number,
  limit: number,
  scoreBreakdownLanes?: Map<string, ScoreBreakdown["lanes"]>
): RankedCandidate[] {
  const activeLanes = lanes.filter((lane) => lane.weight > 0 && lane.results.length > 0);
  if (activeLanes.length === 0) {
    return [];
  }

  const maxPossibleRaw = activeLanes.reduce((sum, lane) => sum + lane.weight, 0) / (rrfK + 1);
  const metadataById = new Map<string, RetrievalChunkMetadata>();
  const laneById = new Map<string, SearchResultLane | undefined>();
  const allIds = new Set<string>();
  const rankMaps = activeLanes.map((lane) => {
    const rankById = new Map<string, number>();
    lane.results.forEach((result, index) => {
      rankById.set(result.id, index + 1);
      allIds.add(result.id);
      if (!metadataById.has(result.id)) {
        metadataById.set(result.id, result.metadata);
      }
      laneById.set(result.id, mergeSearchResultLane(laneById.get(result.id), result.lane));
    });
    return {
      weight: lane.weight,
      rankById,
    };
  });
  const fused: RankedCandidate[] = [];

  for (const id of allIds) {
    const metadata = metadataById.get(id);
    if (!metadata) continue;

    let rawScore = 0;
    for (const lane of rankMaps) {
      const rank = lane.rankById.get(id);
      if (!rank) {
        continue;
      }
      rawScore += lane.weight / (rrfK + rank);
    }

    fused.push({
      id,
      score: maxPossibleRaw > 0 ? rawScore / maxPossibleRaw : 0,
      metadata,
      lane: laneById.get(id),
    });
  }

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const bounded = fused.slice(0, limit);
  if (scoreBreakdownLanes) {
    bounded.forEach((candidate, index) => {
      const laneBreakdown = scoreBreakdownLanes.get(candidate.id) ?? {};
      candidate.scoreBreakdown = createScoreBreakdown(
        laneBreakdown,
        "rrf",
        candidate.score,
        index + 1,
        sourcesFromLaneBreakdown(laneBreakdown)
      );
    });
  }
  return bounded;
}

export function rerankResults(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { pathPreference?: SearchPathPreference; taskType?: SearchTaskType }
): RankedCandidate[] {
  if (rerankTopN <= 0 || candidates.length <= 1) {
    return candidates;
  }

  const topN = Math.min(rerankTopN, candidates.length);
  const queryTokens = tokenizeTextForRanking(query);
  if (queryTokens.size === 0) {
    return candidates;
  }

  const queryTokenList = Array.from(queryTokens);
  const intent = classifyQueryIntentRaw(query);
  const docIntent = classifyDocIntent(queryTokenList);
  const taskType = options?.taskType ?? "general";
  const pathPreference = options?.pathPreference ?? "auto";
  const preferSourcePaths = pathPreference === "source"
    ? true
    : pathPreference === "balanced" || pathPreference === "test"
      ? false
      : intent === "source";
  const preferTestPaths = pathPreference === "test";
  const identifierHints = extractIdentifierHints(query);

  const head = candidates.slice(0, topN).map((candidate, idx) => {
    const pathTokens = splitPathTokens(candidate.metadata.filePath);
    const nameTokens = splitNameTokens(candidate.metadata.name ?? "");
    const chunkTypeTokens = tokenizeTextForRanking(candidate.metadata.chunkType);
    let exactOrPrefixNameHits = 0;
    let pathOverlap = 0;
    let chunkTypeHits = 0;

    for (const token of queryTokenList) {
      if (nameTokens.has(token)) {
        exactOrPrefixNameHits += 1;
      } else {
        for (const nameToken of nameTokens) {
          if (nameToken.startsWith(token) || token.startsWith(nameToken)) {
            exactOrPrefixNameHits += 1;
            break;
          }
        }
      }

      if (pathTokens.has(token)) {
        pathOverlap += 1;
      }

      if (chunkTypeTokens.has(token)) {
        chunkTypeHits += 1;
      }
    }

    const likelyTestOrDoc = isTestOrDocPath(candidate.metadata.filePath);
    const lowerPath = candidate.metadata.filePath.toLowerCase();
    const lowerName = (candidate.metadata.name ?? "").toLowerCase();
    const hasIdentifierMatch = identifierHints.some((id) => lowerPath.includes(id) || lowerName.includes(id));

    const implementationPathBoost = preferSourcePaths && isLikelyImplementationPath(candidate.metadata.filePath) ? DETERMINISTIC_IMPLEMENTATION_PATH_BOOST : 0;
    const isReadmePath = candidate.metadata.filePath.toLowerCase().includes("readme");
    const testDocPenalty = preferSourcePaths && likelyTestOrDoc ? DETERMINISTIC_TEST_DOC_PATH_PENALTY : 0;
    const testPathBoost = preferTestPaths && likelyTestOrDoc ? DETERMINISTIC_TEST_PATH_BOOST : 0;
    const readmeDocBoost = !preferSourcePaths && isReadmePath ? DETERMINISTIC_README_DOC_BOOST : 0;
    const identifierBoost = hasIdentifierMatch ? DETERMINISTIC_IDENTIFIER_SORT_BOOST : 0;
    const tokenCoverage = queryTokenList.length > 0
      ? (exactOrPrefixNameHits + pathOverlap + chunkTypeHits) / queryTokenList.length
      : 0;
    const coverageBoost = Math.min(DETERMINISTIC_COVERAGE_BOOST_CAP, tokenCoverage * DETERMINISTIC_COVERAGE_BOOST_SCALE);

    const deterministicBoost =
      exactOrPrefixNameHits * DETERMINISTIC_NAME_HIT_BOOST +
      pathOverlap * DETERMINISTIC_PATH_OVERLAP_BOOST +
      chunkTypeHits * DETERMINISTIC_CHUNK_TYPE_HIT_BOOST +
      coverageBoost +
      identifierBoost +
      implementationPathBoost -
      testDocPenalty +
      testPathBoost +
      readmeDocBoost +
      getInterfaceTypePenalty(taskType, candidate.metadata.chunkType) +
      chunkTypeBoost(candidate.metadata.chunkType);

    if (candidate.scoreBreakdown) {
      const chunkBoost = chunkTypeBoost(candidate.metadata.chunkType);
      const interfacePenalty = getInterfaceTypePenalty(taskType, candidate.metadata.chunkType);
      const pathDelta = -testDocPenalty + testPathBoost + readmeDocBoost + implementationPathBoost;
      recordDeterministicSortPreference(
        candidate,
        `initialDeterministicRerank: virtualBoost=${deterministicBoost}; nameHits=${exactOrPrefixNameHits}; pathOverlap=${pathOverlap}; chunkTypeHits=${chunkTypeHits}`
      );
      if (chunkBoost !== 0) {
        recordDeterministicSortPreference(
          candidate,
          `chunkTypeBoost: chunkType=${candidate.metadata.chunkType}; virtualBoost=${chunkBoost}`
        );
      }
      if (interfacePenalty !== 0) {
        recordDeterministicSortPreference(
          candidate,
          `interfaceTypePenalty: chunkType=${candidate.metadata.chunkType}; virtualPenalty=${interfacePenalty}`
        );
      }
      if (pathDelta !== 0) {
        recordDeterministicSortPreference(
          candidate,
          `${testDocPenalty > 0 ? "testDocPathPenalty" : "pathPreferenceBoost"}: virtualPathDelta=${pathDelta}; preferSource=${preferSourcePaths}; preferTest=${preferTestPaths}`
        );
      }
      if (identifierBoost !== 0) {
        recordDeterministicSortPreference(
          candidate,
          `identifierSortBoost: hasIdentifierMatch=${hasIdentifierMatch}; virtualBoost=${identifierBoost}`
        );
      }
    }

    return {
      candidate,
      boostedScore: candidate.score + deterministicBoost,
      originalIndex: idx,
      hasIdentifierMatch,
      implementationChunk: isImplementationChunkType(candidate.metadata.chunkType),
      isLikelyImplementationPath: isLikelyImplementationPath(candidate.metadata.filePath),
      isTestOrDocPath: likelyTestOrDoc,
      isReadmePath,
    };
  });

  const filesWithNamedCandidates = new Set(
    head
      .filter((entry) => Boolean(entry.candidate.metadata.name?.trim()))
      .map((entry) => entry.candidate.metadata.filePath)
  );

  for (const entry of head) {
    if (
      shouldSuppressUnnamedSiblingCandidate(entry.candidate) &&
      filesWithNamedCandidates.has(entry.candidate.metadata.filePath)
    ) {
      if (entry.candidate.scoreBreakdown) {
        recordDeterministicSortPreference(
          entry.candidate,
          "siblingSuppression: unnamed/module sibling sorted lower by virtualPenalty=-0.10"
        );
      }
      entry.boostedScore -= SIBLING_SUPPRESSION_SORT_PENALTY;
    }
  }

  head.sort((a, b) => {
    if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  if (preferSourcePaths) {
    for (const entry of head) {
      recordDeterministicSortPreference(entry.candidate, "sourcePathSort: reordered by source path preference");
    }
    head.sort((a, b) => {
      const aId = a.hasIdentifierMatch ? 1 : 0;
      const bId = b.hasIdentifierMatch ? 1 : 0;
      if (aId !== bId) return bId - aId;

      const aImpl = a.implementationChunk ? 1 : 0;
      const bImpl = b.implementationChunk ? 1 : 0;
      if (aImpl !== bImpl) return bImpl - aImpl;

      const aImplementationPath = a.isLikelyImplementationPath ? 1 : 0;
      const bImplementationPath = b.isLikelyImplementationPath ? 1 : 0;
      if (aImplementationPath !== bImplementationPath) return bImplementationPath - aImplementationPath;

      const aTestDoc = a.isTestOrDocPath ? 1 : 0;
      const bTestDoc = b.isTestOrDocPath ? 1 : 0;
      if (aTestDoc !== bTestDoc) return aTestDoc - bTestDoc;

      return 0;
    });
  } else if (preferTestPaths) {
    for (const entry of head) {
      recordDeterministicSortPreference(entry.candidate, "testPathSort: reordered by test path preference");
    }
    head.sort((a, b) => {
      const aTestDoc = a.isTestOrDocPath ? 1 : 0;
      const bTestDoc = b.isTestOrDocPath ? 1 : 0;
      if (aTestDoc !== bTestDoc) return bTestDoc - aTestDoc;

      const aId = a.hasIdentifierMatch ? 1 : 0;
      const bId = b.hasIdentifierMatch ? 1 : 0;
      if (aId !== bId) return bId - aId;

      return 0;
    });
  } else if (docIntent === "docs") {
    for (const entry of head) {
      recordDeterministicSortPreference(entry.candidate, "docPathSort: reordered by docs/readme preference");
    }
    head.sort((a, b) => {
      const aReadme = a.isReadmePath ? 1 : 0;
      const bReadme = b.isReadmePath ? 1 : 0;
      if (aReadme !== bReadme) return bReadme - aReadme;
      return 0;
    });
  }

  const tail = candidates.slice(topN);
  return [...head.map((entry) => entry.candidate), ...tail];
}

export function rankHybridResults(
  query: string,
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  options: HybridRankOptions & { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const fusionWeights = normalizeFusionWeights(
    options.bm25Weight,
    options.denseWeight,
    options.voyageWeight,
    options.hybridWeight
  );
  const lanes: FusionLane[] = [
    { results: semanticResults, weight: fusionWeights.denseWeight },
    { results: options.voyageResults ?? [], weight: fusionWeights.voyageWeight },
    { results: keywordResults, weight: fusionWeights.bm25Weight },
  ];
  const fused = options.fusionStrategy === "rrf"
    ? fuseResultsRrf(lanes, options.rrfK, overfetchLimit, options.scoreBreakdownLanes)
    : fuseResultsWeighted(lanes, overfetchLimit, options.scoreBreakdownLanes);

  const rerankPoolLimit = Math.max(overfetchLimit, options.rerankTopN * 3, options.limit * 6);
  const rerankPool = fused.slice(0, rerankPoolLimit);
  const defaultPathPreference = (options.prioritizeSourcePaths ?? (classifyQueryIntentRaw(query) === "source"))
    ? "source"
    : "auto";
  return rerankResults(query, rerankPool, options.rerankTopN, {
    pathPreference: options.pathPreference ?? defaultPathPreference,
    taskType: options.taskType,
  });
}

export function rankSemanticOnlyResults(
  query: string,
  semanticResults: RankedCandidate[],
  options: SemanticRankOptions
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const bounded = semanticResults.slice(0, overfetchLimit);
  const defaultPathPreference = (options.prioritizeSourcePaths ?? false) ? "source" : "auto";
  return rerankResults(query, bounded, options.rerankTopN, {
    pathPreference: options.pathPreference ?? defaultPathPreference,
    taskType: options.taskType,
  });
}

function resolveIdentifierPromotionPathPreference(
  query: string,
  pathPreference: SearchPathPreference
): "source" | "test" | "auto" {
  if (pathPreference === "source" || pathPreference === "test") {
    return pathPreference;
  }

  return classifyQueryIntentRaw(query) === "source" ? "source" : "auto";
}

function matchesIdentifierPromotionTarget(
  filePath: string,
  chunkType: string,
  chunkKind: string | null | undefined,
  symbolKind: string | null | undefined,
  pathPreference: "source" | "test" | "auto"
): boolean {
  if (pathPreference === "test") {
    return chunkKind === "Test" || symbolKind === "Test" || isLikelyTestPath(filePath);
  }

  if (pathPreference === "source") {
    return isImplementationChunkType(chunkType) && isLikelyImplementationPath(filePath);
  }

  return false;
}

function promoteIdentifierMatches(
  query: string,
  combined: RankedCandidate[],
  retrievalCandidateSets: RankedCandidate[][],
  database?: Database,
  allowedChunkIds?: Set<string> | null,
  pathPreference: SearchPathPreference = classifyQueryIntentRaw(query) === "source" ? "source" : "auto",
  identifierBoost: number = 1,
  includeScoreBreakdown: boolean = false,
  experimentalIdentifierRiskPolicy: boolean = false
): RankedCandidate[] {
  if (combined.length === 0) {
    return combined;
  }

  const effectivePathPreference = resolveIdentifierPromotionPathPreference(query, pathPreference);
  if (effectivePathPreference === "auto") {
    return combined;
  }

  const identifierHints = extractIdentifierHints(query);
  if (identifierHints.length === 0) {
    return combined;
  }
  const useIdentifierRiskPolicy = shouldApplyExperimentalIdentifierRiskPolicy(
    query,
    "definition",
    experimentalIdentifierRiskPolicy
  );

  const combinedById = new Map(combined.map((candidate) => [candidate.id, candidate]));
  const candidateUnion = new Map<string, RankedCandidate>();
  for (const candidateSet of retrievalCandidateSets) {
    for (const candidate of candidateSet) {
      const existing = candidateUnion.get(candidate.id);
      if (!existing || candidate.score > existing.score) {
        candidateUnion.set(candidate.id, candidate);
      }
    }
  }

  if (database) {
    for (const identifier of identifierHints) {
      const symbols = database.getSymbolsByName(identifier);
      for (const symbol of symbols) {
        const chunks = database.getChunksByFile(symbol.filePath);
        for (const chunk of chunks) {
          if (allowedChunkIds && !allowedChunkIds.has(chunk.chunkId)) {
            continue;
          }

          const chunkType = ((chunk.nodeType ?? "other") as ChunkMetadata["chunkType"]);
          if (!matchesIdentifierPromotionTarget(
            chunk.filePath,
            chunkType,
            chunk.chunkKind,
            chunk.symbolKind,
            effectivePathPreference
          )) {
            continue;
          }

          if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
            continue;
          }

          const existing = combinedById.get(chunk.chunkId) ?? candidateUnion.get(chunk.chunkId);
          const metadata: RetrievalChunkMetadata = existing?.metadata ?? {
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            chunkType,
            chunkKind: chunk.chunkKind as ChunkKind | undefined,
            symbolKind: chunk.symbolKind as ChunkSymbolKind | undefined,
            name: chunk.name ?? undefined,
            language: chunk.language,
            hash: chunk.embeddingInputHash,
          };

          const baselineScore = existing?.score ?? IDENTIFIER_DATABASE_BASELINE_SCORE;
          const originalBoostedScore = Math.min(1, baselineScore + IDENTIFIER_DATABASE_BASELINE_SCORE * Math.max(0, identifierBoost));
          const quality = classifyIdentifierQuality(query, metadata, identifierHints, {
            aliases: symbol.symbolAliases ?? [],
          });
          const compoundSpecificity = getCompoundIdentifierSpecificity(
            metadata,
            identifierHints,
            symbol.symbolAliases ?? []
          );
          const boostedScore = applyConservativeIdentifierRiskPolicyToSetScore(
            baselineScore,
            originalBoostedScore,
            quality,
            useIdentifierRiskPolicy,
            compoundSpecificity
          );
          const nextCandidate: RankedCandidate = {
            id: chunk.chunkId,
            score: boostedScore,
            metadata,
            identifierQuality: quality,
            chunkKind: (chunk.chunkKind as ChunkKind | undefined) ?? existing?.chunkKind ?? metadata.chunkKind,
            symbolKind: (chunk.symbolKind as ChunkSymbolKind | undefined) ?? existing?.symbolKind ?? metadata.symbolKind,
            scoreBreakdown: cloneScoreBreakdown(existing?.scoreBreakdown),
          };
          if (includeScoreBreakdown) {
            ensureScoreBreakdown(nextCandidate, "identifier");
            recordScoreStage(nextCandidate, {
              name: DETERMINISTIC_INTENT_STAGE,
              kind: "set",
              before: baselineScore,
              after: boostedScore,
              reason: `identifierPromotion: databaseSymbol=${identifier}; identifierBoost=${identifierBoost}; ${formatIdentifierQualityReason(query, metadata, identifierHints, {
                aliases: symbol.symbolAliases ?? [],
              })}${formatIdentifierRiskPolicyReason(originalBoostedScore, boostedScore)}`,
            });
          }
          candidateUnion.set(chunk.chunkId, nextCandidate);
        }
      }
    }
  }

  const promoted: RankedCandidate[] = [];
  for (const candidate of candidateUnion.values()) {
    const filePathLower = candidate.metadata.filePath.toLowerCase();
    const nameLower = (candidate.metadata.name ?? "").toLowerCase();
    const exactIdentifierMatch = identifierHints.some((hint) => nameLower === hint);
    const hasIdentifierMatch = exactIdentifierMatch || identifierHints.some((hint) =>
      nameLower.includes(hint) ||
      filePathLower.includes(hint)
    );

    if (!hasIdentifierMatch) {
      continue;
    }

    if (!matchesIdentifierPromotionTarget(
      candidate.metadata.filePath,
      candidate.metadata.chunkType,
      candidate.chunkKind ?? candidate.metadata.chunkKind,
      candidate.symbolKind ?? candidate.metadata.symbolKind,
      effectivePathPreference
    )) {
      continue;
    }

    const existing = combinedById.get(candidate.id) ?? candidate;
    const rescueBoost = (exactIdentifierMatch ? IDENTIFIER_EXACT_RESCUE_BOOST : IDENTIFIER_FUZZY_RESCUE_BOOST) * Math.max(0, identifierBoost);
    const before = Math.max(existing.score, candidate.score);
    const originalBoostedScore = Math.min(1, before + rescueBoost);
    const quality = classifyIdentifierQuality(query, existing.metadata, identifierHints);
    const compoundSpecificity = getCompoundIdentifierSpecificity(existing.metadata, identifierHints);
    const boostedScore = applyConservativeIdentifierRiskPolicyToAddScore(
      before,
      originalBoostedScore,
      quality,
      useIdentifierRiskPolicy,
      compoundSpecificity
    );
    const nextCandidate: RankedCandidate = {
      id: existing.id,
      score: boostedScore,
      metadata: existing.metadata,
      identifierQuality: quality,
      chunkKind: existing.chunkKind ?? candidate.chunkKind ?? existing.metadata.chunkKind,
      symbolKind: existing.symbolKind ?? candidate.symbolKind ?? existing.metadata.symbolKind,
      scoreBreakdown: cloneScoreBreakdown(existing.scoreBreakdown ?? candidate.scoreBreakdown),
    };
    if (includeScoreBreakdown) {
      ensureScoreBreakdown(nextCandidate, "identifier");
      recordScoreStage(nextCandidate, {
        name: DETERMINISTIC_INTENT_STAGE,
        kind: "add",
        before,
        after: boostedScore,
        reason: `identifierPromotion: exactIdentifierMatch=${exactIdentifierMatch}; boost=${rescueBoost}; ${formatIdentifierQualityReason(query, existing.metadata, identifierHints)}${formatIdentifierRiskPolicyReason(originalBoostedScore, boostedScore)}`,
      });
    }
    promoted.push(nextCandidate);
  }

  if (promoted.length === 0) {
    return combined;
  }

  promoted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const promotedIds = new Set(promoted.map((candidate) => candidate.id));
  const remainder = combined.filter((candidate) => !promotedIds.has(candidate.id));
  return [...promoted, ...remainder];
}

function buildSymbolDefinitionLane(
  query: string,
  database: Database,
  allowedChunkIds: Set<string> | null,
  limit: number,
  fallbackCandidates: RankedCandidate[],
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source",
  includeScoreBreakdown: boolean = false
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const identifierHints = extractIdentifierHints(query);
  const codeTermHints = extractCodeTermHints(query);
  if (identifierHints.length === 0) {
    // This lane is intended to recover symbol-definition lookups. Letting
    // generic code terms fabricate a precedence lane causes semantic queries
    // to over-promote unrelated implementation chunks ahead of the fused pool.
    return [];
  }

  if (codeTermHints.length === 0) {
    return [];
  }

  const symbolCandidates = new Map<string, RankedCandidate>();
  const filePathHint = extractFilePathHint(query);
  const primaryHint = extractPrimaryIdentifierQueryHint(query);

  const upsertChunkCandidate = (
    chunk: ReturnType<Database["getChunksByName"]>[number],
    identifier: string,
    normalizedIdentifier: string,
    baseScore?: number
  ) => {
    if (allowedChunkIds && !allowedChunkIds.has(chunk.chunkId)) {
      return;
    }

    const chunkType = (chunk.nodeType ?? "other") as ChunkMetadata["chunkType"];
    if (!isImplementationChunkType(chunkType)) {
      return;
    }

    if (!isLikelyImplementationPath(chunk.filePath)) {
      return;
    }

    const nameLower = (chunk.name ?? "").toLowerCase();
    const exactName =
      nameLower === identifier ||
      nameLower.replace(/_/g, "") === normalizedIdentifier;
    const base = baseScore ?? (exactName ? SYMBOL_DEFINITION_EXACT_SCORE : SYMBOL_DEFINITION_FUZZY_SCORE);

    const existing = symbolCandidates.get(chunk.chunkId);
    if (!existing || base > existing.score) {
      const candidate: RankedCandidate = {
        id: chunk.chunkId,
        score: base,
        metadata: {
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType,
          name: chunk.name ?? undefined,
          language: chunk.language,
          hash: chunk.embeddingInputHash,
        },
        identifierQuality: exactName ? "exact-symbol" : undefined,
      };
      if (includeScoreBreakdown) {
        ensureScoreBreakdown(candidate, "symbol");
        recordScoreStage(candidate, {
          name: DETERMINISTIC_INTENT_STAGE,
          kind: "set",
          before: 0,
          after: base,
          reason: `symbolDefinitionLane: identifier=${identifier}; exactName=${exactName}`,
        });
      }
      symbolCandidates.set(chunk.chunkId, candidate);
    }
  };

  const normalizedHints = identifierHints
    .flatMap((hint) => [
      hint,
      hint.replace(/_/g, ""),
      hint.replace(/_/g, "-")
    ])
    .filter((hint, idx, arr) => hint.length >= 3 && arr.indexOf(hint) === idx)
    .slice(0, 6);

  for (const identifier of normalizedHints) {
    const symbols = [
      ...database.getSymbolsByName(identifier),
      ...database.getSymbolsByNameCi(identifier),
    ];

    const chunksByName = [
      ...database.getChunksByName(identifier),
      ...database.getChunksByNameCi(identifier),
    ];

    const normalizedIdentifier = identifier.replace(/_/g, "");

    const dedupSymbols = new Map<string, typeof symbols[number]>();
    for (const symbol of symbols) {
      dedupSymbols.set(symbol.id, symbol);
    }

    for (const symbol of dedupSymbols.values()) {
      const chunks = database.getChunksByFile(symbol.filePath);
      for (const chunk of chunks) {
        if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
          continue;
        }

        upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
      }
    }

    const dedupChunksByName = new Map<string, typeof chunksByName[number]>();
    for (const chunk of chunksByName) {
      dedupChunksByName.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupChunksByName.values()) {
      upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
    }
  }

  if (filePathHint && primaryHint) {
    const primaryChunks = [
      ...database.getChunksByName(primaryHint),
      ...database.getChunksByNameCi(primaryHint),
    ];
    const dedupPrimaryChunks = new Map<string, typeof primaryChunks[number]>();
    for (const chunk of primaryChunks) {
      dedupPrimaryChunks.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupPrimaryChunks.values()) {
      if (!pathMatchesHint(chunk.filePath, filePathHint)) {
        continue;
      }
      const normalizedPrimary = primaryHint.replace(/_/g, "");
      upsertChunkCandidate(chunk, primaryHint, normalizedPrimary, 1.0);
    }
  }

  const ranked = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (ranked.length === 0) {
    const implementationFallback = fallbackCandidates.filter((candidate) =>
      isImplementationChunkType(candidate.metadata.chunkType) &&
      isLikelyImplementationPath(candidate.metadata.filePath)
    );

    for (const candidate of implementationFallback) {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();

      const exactHintMatch = normalizedHints.some((hint) => nameLower === hint || nameLower.replace(/_/g, "") === hint.replace(/_/g, ""));
      const tokenizedName = tokenizeTextForRanking(nameLower);
      const tokenHits = codeTermHints.filter((term) => tokenizedName.has(term) || pathLower.includes(term)).length;

      if (!exactHintMatch && tokenHits === 0) {
        continue;
      }

      const laneScore = exactHintMatch
        ? Math.min(1, Math.max(candidate.score, SYMBOL_FALLBACK_EXACT_FLOOR))
        : Math.min(SYMBOL_FALLBACK_TOKEN_CAP, Math.max(candidate.score, SYMBOL_FALLBACK_TOKEN_BASE + tokenHits * SYMBOL_FALLBACK_TOKEN_SCALE));
      const nextCandidate: RankedCandidate = {
        id: candidate.id,
        score: laneScore,
        metadata: candidate.metadata,
        identifierQuality: exactHintMatch ? "exact-symbol" : candidate.identifierQuality,
        scoreBreakdown: cloneScoreBreakdown(candidate.scoreBreakdown),
      };
      if (includeScoreBreakdown) {
        ensureScoreBreakdown(nextCandidate, "symbol");
        recordScoreStage(nextCandidate, {
          name: DETERMINISTIC_INTENT_STAGE,
          kind: "set-min",
          before: candidate.score,
          after: laneScore,
          reason: `symbolDefinitionFallback: exactHintMatch=${exactHintMatch}; tokenHits=${tokenHits}`,
        });
      }
      symbolCandidates.set(candidate.id, nextCandidate);
    }

    if (symbolCandidates.size === 0) {
      const queryTokenSet = tokenizeTextForRanking(query);
      const rankedFallback = implementationFallback
        .map((candidate) => {
          const nameTokens = tokenizeTextForRanking(candidate.metadata.name ?? "");
          const pathTokens = splitPathTokens(candidate.metadata.filePath);
          let overlap = 0;
          for (const token of queryTokenSet) {
            if (nameTokens.has(token) || pathTokens.has(token)) {
              overlap += 1;
            }
          }
          const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
          return {
            candidate,
            overlapScore,
          };
        })
        .filter((entry) => entry.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore || b.candidate.score - a.candidate.score)
        .slice(0, Math.max(limit, 3));

      for (const entry of rankedFallback) {
        const nextCandidate: RankedCandidate = {
          id: entry.candidate.id,
          score: Math.min(SYMBOL_OVERLAP_FALLBACK_CAP, Math.max(entry.candidate.score, SYMBOL_OVERLAP_FALLBACK_BASE + entry.overlapScore * SYMBOL_OVERLAP_FALLBACK_SCALE)),
          metadata: entry.candidate.metadata,
          identifierQuality: entry.candidate.identifierQuality,
          scoreBreakdown: cloneScoreBreakdown(entry.candidate.scoreBreakdown),
        };
        if (includeScoreBreakdown) {
          ensureScoreBreakdown(nextCandidate, "symbol");
          recordScoreStage(nextCandidate, {
            name: DETERMINISTIC_INTENT_STAGE,
            kind: "set-min",
            before: entry.candidate.score,
            after: nextCandidate.score,
            reason: `symbolDefinitionOverlapFallback: overlapScore=${entry.overlapScore}`,
          });
        }
        symbolCandidates.set(entry.candidate.id, nextCandidate);
      }
    }
  }

  const withFallback = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return withFallback.slice(0, Math.max(limit * 2, limit));
}

function buildIdentifierDefinitionLane(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source",
  includeScoreBreakdown: boolean = false,
  experimentalIdentifierRiskPolicy: boolean = false
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primaryHint = extractPrimaryIdentifierQueryHint(query);
  if (!primaryHint) {
    return [];
  }

  const hints = [primaryHint, ...extractIdentifierHints(query), ...extractCodeTermHints(query)].slice(0, 8);
  const scored = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const matchScore = scoreIdentifierMatch(candidate.metadata.name, candidate.metadata.filePath, hints);
      return {
        candidate,
        matchScore,
      };
    })
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 10));

  const useIdentifierRiskPolicy = shouldApplyExperimentalIdentifierRiskPolicy(
    query,
    "definition",
    experimentalIdentifierRiskPolicy
  );

  return scored.map((entry) => {
    const originalScore = Math.min(1, DETERMINISTIC_IDENTIFIER_BASE_SCORE + entry.matchScore * DETERMINISTIC_IDENTIFIER_MATCH_SCALE);
    const quality = classifyIdentifierQuality(query, entry.candidate.metadata, hints);
    const compoundSpecificity = getCompoundIdentifierSpecificity(entry.candidate.metadata, hints);
    const score = applyConservativeIdentifierRiskPolicyToSetScore(
      entry.candidate.score,
      originalScore,
      quality,
      useIdentifierRiskPolicy,
      compoundSpecificity
    );
    const candidate: RankedCandidate = {
      id: entry.candidate.id,
      score,
      metadata: entry.candidate.metadata,
      identifierQuality: quality,
      scoreBreakdown: cloneScoreBreakdown(entry.candidate.scoreBreakdown),
    };
    if (includeScoreBreakdown) {
      ensureScoreBreakdown(candidate, "identifier");
      recordScoreStage(candidate, {
        name: DETERMINISTIC_INTENT_STAGE,
        kind: "set",
        before: entry.candidate.score,
        after: score,
        reason: `identifierDefinitionLane: matchScore=${entry.matchScore}; ${formatIdentifierQualityReason(query, entry.candidate.metadata, hints)}${formatIdentifierRiskPolicyReason(originalScore, score)}`,
      });
    }
    return candidate;
  });
}

export function mergeTieredResults(
  symbolLane: RankedCandidate[],
  hybridLane: RankedCandidate[],
  limit: number
): RankedCandidate[] {
  if (symbolLane.length === 0) {
    return hybridLane.slice(0, limit);
  }

  const out: RankedCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of symbolLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  for (const candidate of hybridLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  return out;
}

function unionCandidates(...candidateSets: RankedCandidate[][]): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const candidateSet of candidateSets) {
    for (const candidate of candidateSet) {
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, candidate);
        continue;
      }

      const mergedLane = mergeSearchResultLane(existing.lane, candidate.lane);
      if (candidate.score > existing.score) {
        byId.set(candidate.id, {
          ...candidate,
          lane: mergedLane,
        });
      } else {
        existing.lane = mergedLane;
      }
    }
  }
  return Array.from(byId.values());
}

// Keep one Indexer instance per resolved project root in-process so every
// entrypoint for the same repo shares the same mutation queue and crash marker.
const indexerInstances = new Map<string, Indexer>();

function resolveIndexerProjectRoot(projectRoot: string): string {
  const absolutePath = path.resolve(projectRoot);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export class Indexer {
  private config!: ParsedCodebaseIndexConfig;
  private projectRoot!: string;
  private indexPath!: string;
  private stores: Map<string, VectorStore> = new Map();
  private invertedIndex: InvertedIndex | null = null;
  private database: Database | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private voyageProvider: SecondaryEmbeddingProvider | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
  private primaryStoreModelId: string | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCacheDir: string = "";
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";
  private logger!: Logger;
  private queryEmbeddingCache: Map<string, QueryEmbeddingCacheEntry> = new Map();
  private queryEmbeddingFailureState: Map<string, QueryEmbeddingFailureState> = new Map();
  private secondaryProviderProbeTokens: Map<string, symbol> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;
  private readonly queryEmbeddingFailureCooldownMs = 5 * 60 * 1000;
  private indexCompatibility: IndexCompatibility | null = null;
  private indexingLockPath: string = "";
  private indexingQueue: Promise<void> = Promise.resolve();
  private recoveredFromInterruptedIndexing = false;
  private startupRetrievalRebuildPending = false;
  private orchestrator!: IncrementalIndexOrchestrator;
  private readonly backgroundEmbeddingRuns = new Map<string, Promise<void>>();
  private readonly searchReranker!: SearchReranker;
  private rerankerHealth: StatusResult["rerankerHealth"] = null;
  private rerankerStartupWarningShown = false;

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig) {
    const resolvedProjectRoot = resolveIndexerProjectRoot(projectRoot);
    const existing = indexerInstances.get(resolvedProjectRoot);
    if (existing) {
      if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
        throw new Error(
          `Indexer for ${resolvedProjectRoot} already exists in this process with a different config. ` +
          "Reuse the existing instance instead of constructing a second one."
        );
      }
      return existing;
    }

    this.projectRoot = resolvedProjectRoot;
    this.config = config;
    this.indexPath = this.getIndexPath();
    this.fileHashCacheDir = path.join(this.indexPath, "file-hashes");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.indexingLockPath = path.join(this.indexPath, "indexing.lock");
    this.logger = initializeLogger(config.debug);
    this.searchReranker = new SearchReranker(undefined, (event) => this.recordRerankerHealth(event), {
      jinaApiKey: this.config.jinaApiKey,
      jinaModel: this.config.jinaRerankerModel,
      onSelection: (backend, model) => {
        this.logger.search("info", "Initialized search reranker backend", {
          backend,
          model: model ?? undefined,
        });
      },
    });
    this.orchestrator = new IncrementalIndexOrchestrator({
      logger: this.logger,
      getConfig: () => this.config,
      getProjectRoot: () => this.projectRoot,
      getIndexPath: () => this.indexPath,
      getCurrentBranch: () => this.currentBranch,
      setCurrentBranch: (branch) => this.setCurrentBranch(branch),
      refreshBranchInfo: () => this.refreshBranchInfo(),
      ensureInitialized: () => this.ensureInitialized(),
      assertIndexCompatible: () => this.assertIndexCompatible(),
      runWithCrashMarker: <T>(operation: () => Promise<T>) => this.runWithCrashMarker(operation),
      loadFileHashCache: () => this.loadFileHashCache(),
      commitFileHashChanges: (successfulFileHashes, removedFilePaths) =>
        this.commitFileHashChanges(successfulFileHashes, removedFilePaths),
      buildCommittedMerkleSnapshot: (baseSnapshot, committedRelativePaths) =>
        this.buildCommittedMerkleSnapshot(baseSnapshot, committedRelativePaths),
      buildMerkleIgnoreRules: () => this.buildMerkleIgnoreRules(),
      normalizeDirtyPaths: (paths) => this.normalizeDirtyPaths(paths),
      buildBranchStoreChunkMaps: (branchChunkIds) =>
        this.buildBranchStoreChunkMaps(branchChunkIds),
      parseFilesForIndexing: (files) => this.parseFilesForIndexing(files),
      buildFileGraphData: (parsedFiles) => this.buildFileGraphData(parsedFiles),
      removeChunkFromRetrievalIfUnreferenced: (database, invertedIndex, chunkId) =>
        this.removeChunkFromRetrievalIfUnreferenced(database, invertedIndex, chunkId),
      clearCallEdgesForSymbolIfUnreferenced: (database, symbolId) =>
        this.clearCallEdgesForSymbolIfUnreferenced(database, symbolId),
      removeSymbolFromGraphIfUnreferenced: (database, symbolId) =>
        this.removeSymbolFromGraphIfUnreferenced(database, symbolId),
      syncNativeBranchMembership: (branch, chunkIds) =>
        this.syncNativeBranchMembership(branch, chunkIds),
      applyNativeBranchMembershipDelta: (branch, added, removed) =>
        this.applyNativeBranchMembershipDelta(branch, added, removed),
      getProviderRateLimits: (provider) => {
        const limits = this.getProviderRateLimits(provider);
        return {
          concurrency: limits.concurrency,
          intervalCap: 1,
          interval: limits.intervalMs,
        };
      },
      addFailedBatch: (batch, error) => this.addFailedBatch(batch as PendingChunk[], error),
      saveIndexMetadata: (providerInfo) => this.saveIndexMetadata(providerInfo),
      markIndexCompatible: () => {
        this.indexCompatibility = { compatible: true };
      },
      consumeRecoveredFromCrash: () => {
        const recovered = this.recoveredFromInterruptedIndexing;
        this.recoveredFromInterruptedIndexing = false;
        return recovered;
      },
      getFailedBatchesPath: () => this.failedBatchesPath,
    });
    indexerInstances.set(resolvedProjectRoot, this);
  }

  private getIndexPath(): string {
    if (this.config.scope === "global") {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      return path.join(homeDir, ".opencode", "global-index");
    }
    return path.join(this.projectRoot, ".opencode", "index");
  }

  private publishCurrentBranch(branch: string): void {
    this.currentBranch = branch;
    this.loadFileHashCache();
  }

  private updateBaseBranch(branch: string): void {
    if (!isGitRepo(this.projectRoot)) {
      this.baseBranch = "default";
      return;
    }

    this.baseBranch = getBaseBranch(this.projectRoot) || branch;
  }

  private async setCurrentBranch(
    branch: string,
    options: { forceReloadIfSame?: boolean } = {}
  ): Promise<void> {
    const normalizedBranch = this.getActiveBranchKey(branch);
    this.updateBaseBranch(normalizedBranch);
    if (!options.forceReloadIfSame && normalizedBranch === this.currentBranch) {
      return;
    }

    this.loadNativeBranchMembership(normalizedBranch);
    this.publishCurrentBranch(normalizedBranch);
  }

  private storePathForModel(modelId: string): string {
    const safeModelId = modelId.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.indexPath, `vectors-${safeModelId}`);
  }

  private getStore(modelId: string): VectorStore {
    const store = this.stores.get(modelId);
    if (!store) {
      throw new Error(`Vector store for model "${modelId}" has not been initialized.`);
    }
    return store;
  }

  private hasStore(modelId: string): boolean {
    return this.stores.has(modelId);
  }

  private getPrimaryModelId(): string {
    if (!this.primaryStoreModelId) {
      throw new Error("Primary embedding model is not available before initialization.");
    }
    return this.primaryStoreModelId;
  }

  private getPrimaryStore(): VectorStore {
    return this.getStore(this.getPrimaryModelId());
  }

  private getStoreIndexFilePath(modelId: string): string {
    return this.storePathForModel(modelId);
  }

  private getStoreMetadataFilePath(modelId: string): string {
    return `${this.storePathForModel(modelId)}.meta.json`;
  }

  private migrateLegacyVectorStore(primaryModelId: string): void {
    const legacyStoreBase = path.join(this.indexPath, "vectors");
    const legacyIndexFile = legacyStoreBase;
    const legacyMetadataFile = `${legacyStoreBase}.meta.json`;
    const newIndexFile = this.getStoreIndexFilePath(primaryModelId);
    const newMetadataFile = this.getStoreMetadataFilePath(primaryModelId);

    if (!existsSync(legacyIndexFile) || existsSync(newIndexFile)) {
      return;
    }

    renameSync(legacyIndexFile, newIndexFile);
    if (existsSync(legacyMetadataFile) && !existsSync(newMetadataFile)) {
      renameSync(legacyMetadataFile, newMetadataFile);
    }
  }

  private initializeStore(modelId: string, dimensions: number): VectorStore {
    const store = new VectorStore(this.storePathForModel(modelId), dimensions);
    this.stores.set(modelId, store);
    return store;
  }

  private loadAllStores(): string[] {
    const recoveredModelIds: string[] = [];
    for (const [modelId, store] of this.stores.entries()) {
      if (store.load()) {
        recoveredModelIds.push(modelId);
      }
    }
    return recoveredModelIds;
  }

  private saveAllStores(): void {
    for (const store of this.stores.values()) {
      store.save();
    }
  }

  private clearAllStores(): void {
    for (const store of this.stores.values()) {
      store.clear();
    }
  }

  private getActiveBranchKey(branch: string | null = this.currentBranch): string {
    return branch && branch.trim().length > 0 ? branch : "default";
  }

  syncNativeBranchMembership(branch: string, chunkIds: string[]): void {
    const normalizedBranch = this.getActiveBranchKey(branch);
    for (const store of this.stores.values()) {
      store.setBranchMembership(normalizedBranch, chunkIds);
    }
    this.invertedIndex?.setBranchMembership(normalizedBranch, chunkIds);
  }

  applyNativeBranchMembershipDelta(
    branch: string,
    addedChunkIds: string[],
    removedChunkIds: string[]
  ): void {
    if (addedChunkIds.length === 0 && removedChunkIds.length === 0) {
      return;
    }

    const normalizedBranch = this.getActiveBranchKey(branch);
    for (const store of this.stores.values()) {
      store.applyBranchDelta(normalizedBranch, addedChunkIds, removedChunkIds);
    }
    this.invertedIndex?.applyBranchDelta(normalizedBranch, addedChunkIds, removedChunkIds);
  }

  private loadNativeBranchMembership(branch: string): void {
    if (!this.database) {
      return;
    }

    const normalizedBranch = this.getActiveBranchKey(branch);
    const chunkIds = this.database.getBranchChunkIds(normalizedBranch);
    this.syncNativeBranchMembership(normalizedBranch, chunkIds);
  }

  private validateRetrievalStartupIntegrity(loadState: {
    recoveredModelIds: string[];
    bm25Recovered: boolean;
  }): void {
    if (!this.database) {
      return;
    }

    const branch = this.currentBranch || "default";
    const branchChunkCount = this.database.getBranchChunkIds(branch).length;
    if (branchChunkCount < 1) {
      return;
    }

    const mismatchedStores = Array.from(this.stores.entries())
      .map(([modelId, store]) => ({
        modelId,
        count: store.count(),
      }))
      .filter(({ count }) => count < branchChunkCount);
    const bm25Count = this.invertedIndex?.getDocumentCount() ?? 0;
    const bm25Mismatch = bm25Count < branchChunkCount;

    if (
      loadState.recoveredModelIds.length === 0 &&
      !loadState.bm25Recovered &&
      mismatchedStores.length === 0 &&
      !bm25Mismatch
    ) {
      return;
    }

    this.logger.warn(
      "Retrieval startup integrity check failed: retrieval artifacts are empty, recovered, or underpopulated while the database still has indexed chunks. A full rebuild is required before search results are reliable.",
      {
        branch,
        branchChunkCount,
        recoveredModelIds: loadState.recoveredModelIds,
        bm25Recovered: loadState.bm25Recovered,
        mismatchedStores,
        storeCounts: Array.from(this.stores.entries()).map(([modelId, store]) => ({
          modelId,
          count: store.count(),
        })),
        bm25Count,
      }
    );
    this.startupRetrievalRebuildPending = true;
    this.orchestrator.requestColdStart();
  }

  private async maybeResetAfterStartupRetrievalMismatch(): Promise<boolean> {
    if (!this.startupRetrievalRebuildPending) {
      return false;
    }

    this.startupRetrievalRebuildPending = false;
    await this.clearIndexInternal();
    return true;
  }

  private totalVectorCount(): number {
    let count = 0;
    for (const store of this.stores.values()) {
      count += store.count();
    }
    return count;
  }

  private getEmbeddingProgressMetadataKey(branch: string = this.currentBranch): string {
    return `${EMBEDDING_PROGRESS_METADATA_PREFIX}${this.getActiveBranchKey(branch)}`;
  }

  private readEmbeddingProgressState(database: Database, branch: string = this.currentBranch): EmbeddingProgressState | null {
    const raw = database.getMetadata(this.getEmbeddingProgressMetadataKey(branch));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as EmbeddingProgressState;
    } catch {
      return null;
    }
  }

  private writeEmbeddingProgressState(
    database: Database,
    state: EmbeddingProgressState,
    branch: string = this.currentBranch
  ): void {
    database.setMetadata(this.getEmbeddingProgressMetadataKey(branch), JSON.stringify(state));
  }

  isBackgroundEmbeddingRunning(branch: string = this.currentBranch): boolean {
    return this.backgroundEmbeddingRuns.has(this.getActiveBranchKey(branch));
  }

  private buildForegroundIndexResult(
    args: {
      filesProcessed: number;
      totalChunks: number;
      chunksIndexed: number;
      removedChunks: number;
      durationMs: number;
      embeddingStatus: ForegroundIndexResult["embeddingStatus"];
      embeddingProgress: ForegroundIndexResult["embeddingProgress"];
      alreadyInProgress?: boolean;
    }
  ): ForegroundIndexResult {
    return {
      filesProcessed: args.filesProcessed,
      totalChunks: args.totalChunks,
      chunksIndexed: args.chunksIndexed,
      removedChunks: args.removedChunks,
      durationMs: args.durationMs,
      bm25Ready: true,
      callGraphReady: true,
      embeddingStatus: args.embeddingStatus,
      embeddingProgress: args.embeddingProgress,
      alreadyInProgress: args.alreadyInProgress,
    };
  }

  private getActiveVoyageModelId(): string | null {
    return this.voyageProvider?.getModelInfo().model ?? null;
  }

  private ensureRerankerHealthInitialized(database: Database): void {
    if (database.getRerankerHealth()) {
      return;
    }

    database.upsertRerankerHealth("none", "never-loaded", null, null);
  }

  private readPersistedRerankerHealth(database: Database): StatusResult["rerankerHealth"] {
    const persisted = database.getRerankerHealth();
    if (!persisted) {
      return null;
    }

    return {
      backend: persisted.backend as RerankerHealthBackend,
      status: persisted.status as RerankerHealthStatus,
      model: persisted.model ?? null,
      error: persisted.error ?? null,
      updatedAt: persisted.updatedAt,
    };
  }

  private recordRerankerHealth(event: RerankerHealthEvent): void {
    const nextState: NonNullable<StatusResult["rerankerHealth"]> = {
      backend: event.backend,
      status: event.status,
      model: event.model ?? null,
      error: event.error ?? null,
      updatedAt: Date.now(),
    };

    if (
      this.rerankerHealth &&
      this.rerankerHealth.backend === nextState.backend &&
      this.rerankerHealth.status === nextState.status &&
      (this.rerankerHealth.model ?? null) === (nextState.model ?? null) &&
      (this.rerankerHealth.error ?? null) === (nextState.error ?? null)
    ) {
      return;
    }

    this.rerankerHealth = nextState;
    if (this.database) {
      this.database.upsertRerankerHealth(
        nextState.backend,
        nextState.status,
        nextState.model ?? null,
        nextState.error ?? null
      );
    }
  }

  private maybeWarnAboutPersistedRerankerDegradation(): void {
    if (
      this.rerankerStartupWarningShown ||
      !this.rerankerHealth ||
      this.rerankerHealth.status !== "failed"
    ) {
      return;
    }

    const errorSuffix = this.rerankerHealth.error
      ? ` Last error: ${this.rerankerHealth.error}`
      : "";
    console.warn(
      `[reranker:warn] Search reranker is degraded. Retrieval quality may be reduced.${errorSuffix} Check reranker configuration.`
    );
    this.logger.search("warn", "Search reranker is degraded. Retrieval quality may be reduced.", {
      backend: this.rerankerHealth.backend,
      error: this.rerankerHealth.error ?? undefined,
      model: this.rerankerHealth.model ?? undefined,
    });
    this.rerankerStartupWarningShown = true;
  }

  private summarizeChunkCapDrops(rows: ChunkCapDropData[]): NonNullable<StatusResult["chunkCapSummary"]> | null {
    if (rows.length === 0) {
      return null;
    }

    return {
      truncatedFiles: rows.length,
      totalDroppedChunks: rows.reduce((sum, row) => sum + row.droppedCount, 0),
      totalDroppedNamedSymbols: rows.reduce((sum, row) => sum + row.droppedNamed.length, 0),
    };
  }

  private syncVoyageRuntime(): void {
    if (this.config.embeddingProvider === "voyage") {
      if (!this.config.customProvider) {
        this.voyageProvider = null;
        return;
      }

      const secondaryProviderInfo = createCustomProviderInfo(this.config.customProvider);
      const currentModelId = this.voyageProvider?.getModelInfo().model;
      if (!this.voyageProvider || currentModelId !== secondaryProviderInfo.modelInfo.model) {
        this.voyageProvider = createEmbeddingProvider(secondaryProviderInfo);
      }

      if (!this.hasStore(secondaryProviderInfo.modelInfo.model)) {
        this.initializeStore(
          secondaryProviderInfo.modelInfo.model,
          secondaryProviderInfo.modelInfo.dimensions
        );
        this.getStore(secondaryProviderInfo.modelInfo.model).load();
      }

      this.startSecondaryProviderHealthProbe(this.voyageProvider);
      return;
    }

    const voyageApiKey = this.config.voyageApiKey?.trim();
    if (!voyageApiKey) {
      this.voyageProvider = null;
      return;
    }

    const requestedModelId = this.config.voyageModelId?.trim() || "voyage-code-3";
    const currentModelId = this.voyageProvider?.getModelInfo().model;
    if (!this.voyageProvider || currentModelId !== requestedModelId) {
      this.voyageProvider = createVoyageEmbeddingProvider({
        voyageApiKey,
        voyageModelId: requestedModelId,
      });
    }

    const voyageModelInfo = this.voyageProvider.getModelInfo();
    if (!this.hasStore(voyageModelInfo.model)) {
      this.initializeStore(voyageModelInfo.model, voyageModelInfo.dimensions);
      this.getStore(voyageModelInfo.model).load();
    }
  }

  private getFileHashCachePath(branch: string = this.currentBranch): string {
    const cacheKey = encodeURIComponent(branch || "default");
    return path.join(this.fileHashCacheDir, `${cacheKey}.json`);
  }

  private loadFileHashCache(): void {
    const cachePath = this.getFileHashCachePath();
    try {
      if (existsSync(cachePath)) {
        const data = readFileSync(cachePath, "utf-8");
        const parsed = JSON.parse(data);
        this.fileHashCache = new Map(Object.entries(parsed));
      } else {
        this.fileHashCache = new Map();
      }
    } catch {
      this.fileHashCache = new Map();
    }
  }

  private saveFileHashCache(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.fileHashCache) {
      obj[k] = v;
    }
    this.atomicWriteSync(this.getFileHashCachePath(), JSON.stringify(obj));
  }

  private clearAllFileHashCaches(): void {
    this.fileHashCache.clear();
    if (existsSync(this.fileHashCacheDir)) {
      rmSync(this.fileHashCacheDir, { recursive: true, force: true });
    }
  }

  private atomicWriteSync(targetPath: string, data: string): void {
    const tempPath = `${targetPath}.tmp`;
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(tempPath, data);
    renameSync(tempPath, targetPath);
  }

  private readIndexingLock(): { pid?: number; startedAt?: string } | null {
    if (!existsSync(this.indexingLockPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.indexingLockPath, "utf-8")) as {
        pid?: unknown;
        startedAt?: unknown;
      };
      return {
        pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      };
    } catch {
      return {};
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return true;
      }
      if (code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  // Concurrent multi-process mutation of the same repo index is not supported.
  // This marker file is only a crash/restart guard; in-process serialization comes
  // from runSerializedIndexOperation().
  private acquireIndexingLock(): void {
    const existingLock = this.readIndexingLock();
    if (
      existingLock?.pid !== undefined &&
      existingLock.pid !== process.pid &&
      this.isProcessAlive(existingLock.pid)
    ) {
      throw new Error(
        `Index at ${this.indexPath} is already being modified by process ${existingLock.pid}. ` +
        "Concurrent multi-process indexing of the same repo is not supported."
      );
    }

    const lockData = {
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(this.indexingLockPath, JSON.stringify(lockData));
  }

  private releaseIndexingLock(): void {
    const existingLock = this.readIndexingLock();
    if (
      existsSync(this.indexingLockPath) &&
      (existingLock?.pid === undefined || existingLock.pid === process.pid)
    ) {
      unlinkSync(this.indexingLockPath);
    }
  }

  private async recoverFromInterruptedIndexing(lockData: { pid?: number; startedAt?: string }): Promise<void> {
    const { database } = await this.ensureInitialized();
    this.recoveredFromInterruptedIndexing = true;
    this.logger.warn("Detected interrupted indexing session, recovering...", {
      previousPid: lockData.pid,
      startedAt: lockData.startedAt,
    });

    this.clearAllFileHashCaches();
    database.clearAllMerkleSnapshots();

    this.acquireIndexingLock();
    try {
      await this.healthCheckInternal({ useCrashMarker: false });
    } finally {
      this.releaseIndexingLock();
    }

    this.logger.info(
      "Recovery complete, cleared stale Merkle snapshots and file hash caches; next index will rebuild them from disk"
    );
  }

  private async runSerializedIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const waitForPrevious = this.indexingQueue.catch(() => {});
    let releaseQueue: () => void = () => {};
    this.indexingQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await waitForPrevious;
    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private async runWithCrashMarker<T>(operation: () => Promise<T>): Promise<T> {
    this.acquireIndexingLock();
    try {
      return await operation();
    } finally {
      this.releaseIndexingLock();
    }
  }

  // The failed-batches file remains as an observability artifact for embed
  // failures inside the active orchestrator path. Automatic recovery now comes
  // from checkpoint state and resume logic, so there is intentionally no
  // separate manual retry entrypoint here.
  private loadFailedBatches(): FailedBatch[] {
    try {
      if (existsSync(this.failedBatchesPath)) {
        const data = readFileSync(this.failedBatchesPath, "utf-8");
        return JSON.parse(data) as FailedBatch[];
      }
    } catch {
      return [];
    }
    return [];
  }

  private saveFailedBatches(batches: FailedBatch[]): void {
    if (batches.length === 0) {
      if (existsSync(this.failedBatchesPath)) {
        fsPromises.unlink(this.failedBatchesPath).catch(() => { });
      }
      return;
    }
    writeFileSync(this.failedBatchesPath, JSON.stringify(batches, null, 2));
  }

  private addFailedBatch(batch: PendingChunk[], error: string): void {
    const existing = this.loadFailedBatches();
    existing.push({
      chunks: batch,
      error,
      attemptCount: 1,
      lastAttempt: new Date().toISOString(),
    });
    this.saveFailedBatches(existing);
  }

  private getProviderRateLimits(provider: string): {
    concurrency: number;
    intervalMs: number;
    minRetryMs: number;
    maxRetryMs: number;
  } {
    switch (provider) {
      case "github-copilot":
        return { concurrency: 1, intervalMs: 4000, minRetryMs: 5000, maxRetryMs: 60000 };
      case "openai":
        return { concurrency: 3, intervalMs: 500, minRetryMs: 1000, maxRetryMs: 30000 };
      case "google":
        return { concurrency: 5, intervalMs: 200, minRetryMs: 1000, maxRetryMs: 30000 };
      case "ollama":
        return { concurrency: 5, intervalMs: 0, minRetryMs: 500, maxRetryMs: 5000 };
      case "voyage":
        return { concurrency: 3, intervalMs: 200, minRetryMs: 1000, maxRetryMs: 30000 };
      case "custom": {
        // Custom providers allow user-configurable concurrency and request interval.
        // Defaults are conservative (3 concurrent, 1s interval) for cloud endpoints;
        // users running local servers should set concurrency higher and intervalMs to 0.
        const customConfig = this.config.customProvider;
        return {
          concurrency: customConfig?.concurrency ?? 3,
          intervalMs: customConfig?.requestIntervalMs ?? 1000,
          minRetryMs: 1000,
          maxRetryMs: 30000,
        };
      }
      default:
        return { concurrency: 3, intervalMs: 1000, minRetryMs: 1000, maxRetryMs: 30000 };
    }
  }

  async initialize(): Promise<void> {
    if (this.config.embeddingProvider === 'custom') {
      if (!this.config.customProvider) {
        throw new Error("embeddingProvider is 'custom' but customProvider config is missing.");
      }
      this.configuredProviderInfo = createCustomProviderInfo(this.config.customProvider);
    } else if (this.config.embeddingProvider === "voyage") {
      const voyageApiKey = this.config.voyageApiKey?.trim();
      if (!voyageApiKey) {
        throw new Error("embeddingProvider is 'voyage' but voyageApiKey is missing.");
      }
      this.configuredProviderInfo = createVoyageProviderInfo({
        voyageApiKey,
        voyageModelId: this.config.voyageModelId,
      });
    } else if (this.config.embeddingProvider === 'auto') {
      this.configuredProviderInfo = await tryDetectProvider();
    } else {
      this.configuredProviderInfo = await detectEmbeddingProvider(this.config.embeddingProvider, this.config.embeddingModel);
    }

    if (!this.configuredProviderInfo) {
      throw new Error(
        "No embedding provider available. Configure GitHub Copilot, OpenAI, Google, Ollama, Voyage, or a custom OpenAI-compatible endpoint."
      );
    }

    this.logger.info("Initializing indexer", {
      provider: this.configuredProviderInfo.provider,
      model: this.configuredProviderInfo.modelInfo.model,
      scope: this.config.scope,
    });

    this.provider = createEmbeddingProvider(this.configuredProviderInfo);
    this.voyageProvider = null;
    this.primaryStoreModelId = null;
    this.stores.clear();

    await fsPromises.mkdir(this.indexPath, { recursive: true });

    // NOTE: Interrupted indexing recovery is deferred until after store,
    // invertedIndex, and database are initialized (see below). Running it here
    // would cause infinite recursion: recovery → healthCheck → ensureInitialized
    // → initialize (store not yet set) → recovery → ...

    const primaryModelId = this.configuredProviderInfo.modelInfo.model;
    this.primaryStoreModelId = primaryModelId;
    this.migrateLegacyVectorStore(primaryModelId);
    const primaryStore = this.initializeStore(
      primaryModelId,
      this.configuredProviderInfo.modelInfo.dimensions
    );

    try {
      this.syncVoyageRuntime();
    } catch (error) {
      this.voyageProvider = null;
      this.logger.warn("Failed to initialize Voyage embedding provider", {
        model: this.config.voyageModelId,
        error: getErrorMessage(error),
      });
    }

    const recoveredModelIds = this.loadAllStores();

    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    this.invertedIndex = new InvertedIndex(invertedIndexPath);
    let bm25Recovered = false;
    try {
      bm25Recovered = this.invertedIndex.load();
    } catch {
      if (existsSync(invertedIndexPath)) {
        await fsPromises.unlink(invertedIndexPath);
      }
      this.invertedIndex = new InvertedIndex(invertedIndexPath);
    }

    const dbPath = path.join(this.indexPath, "codebase.db");
    const dbIsNew = !existsSync(dbPath);
    this.database = new Database(dbPath);
    this.ensureRerankerHealthInitialized(this.database);
    this.rerankerHealth = this.readPersistedRerankerHealth(this.database);
    this.maybeWarnAboutPersistedRerankerDegradation();

    let detectedBranch = "default";
    if (isGitRepo(this.projectRoot)) {
      detectedBranch = getBranchOrDefault(this.projectRoot);
      this.updateBaseBranch(detectedBranch);
      this.logger.branch("info", "Detected git repository", {
        currentBranch: detectedBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }
    await this.setCurrentBranch(detectedBranch, { forceReloadIfSame: true });

    // Recover from interrupted indexing AFTER store, invertedIndex, database,
    // and branch state are all initialized. Recovery uses branch-scoped cleanup
    // and must know which branch is currently checked out.
    const existingLock = this.readIndexingLock();
    if (existingLock) {
      if (
        existingLock.pid !== undefined &&
        existingLock.pid !== process.pid &&
        this.isProcessAlive(existingLock.pid)
      ) {
        throw new Error(
          `Index at ${this.indexPath} is already being modified by process ${existingLock.pid}. ` +
          "Concurrent multi-process indexing of the same repo is not supported."
        );
      }
      await this.recoverFromInterruptedIndexing(existingLock);
    }

    this.validateRetrievalStartupIntegrity({
      recoveredModelIds,
      bm25Recovered,
    });
    if (dbIsNew && primaryStore.count() > 0) {
      this.migrateFromLegacyIndex();
      this.loadNativeBranchMembership(this.currentBranch);
    }

    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    if (!this.indexCompatibility.compatible) {
      this.logger.warn("Index compatibility issue detected", {
        reason: this.indexCompatibility.reason,
        storedMetadata: this.indexCompatibility.storedMetadata,
        configuredProviderInfo: this.configuredProviderInfo,
      });
    }

    // Auto-GC: Run garbage collection if enabled and interval has elapsed
    if (this.config.indexing.autoGc) {
      await this.maybeRunAutoGc();
    }
  }

  private async maybeRunAutoGc(): Promise<void> {
    if (!this.database) return;

    const lastGcTimestamp = this.database.getMetadata("lastGcTimestamp");
    const now = Date.now();
    const intervalMs = this.config.indexing.gcIntervalDays * 24 * 60 * 60 * 1000;

    let shouldRunGc = false;
    if (!lastGcTimestamp) {
      // Never run GC before, run it now
      shouldRunGc = true;
    } else {
      const lastGcTime = parseInt(lastGcTimestamp, 10);
      if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
        shouldRunGc = true;
      }
    }

    if (shouldRunGc) {
      await this.healthCheckInternal();
      this.database.setMetadata("lastGcTimestamp", now.toString());
    }
  }

  private migrateFromLegacyIndex(): void {
    if (!this.database || !this.primaryStoreModelId || !this.hasStore(this.primaryStoreModelId)) return;

    const allMetadata = this.getPrimaryStore().getAllMetadata();
    const chunkIds: string[] = [];
    const chunkDataBatch: ChunkData[] = [];

    for (const { key, metadata } of allMetadata) {
      const chunkData: ChunkData = {
        chunkId: key,
        contentHash: metadata.hash,
        embeddingInputHash: metadata.hash,
        filePath: metadata.filePath,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        nodeType: metadata.chunkType,
        name: metadata.name,
        symbolAliases: [],
        chunkKind: undefined,
        symbolKind: undefined,
        language: metadata.language,
      };
      chunkDataBatch.push(chunkData);
      chunkIds.push(key);
    }

    if (chunkDataBatch.length > 0) {
      this.database.upsertChunksBatch(chunkDataBatch);
    }
    this.database.addChunksToBranchBatch(this.currentBranch || "default", chunkIds);
  }

  private loadIndexMetadata(): IndexMetadata | null {
    if (!this.database) return null;

    const version = this.database.getMetadata("index.version");
    if (!version) return null;

    return {
      indexVersion: version,
      embeddingProvider: this.database.getMetadata("index.embeddingProvider") ?? "",
      embeddingModel: this.database.getMetadata("index.embeddingModel") ?? "",
      embeddingDimensions: parseInt(this.database.getMetadata("index.embeddingDimensions") ?? "0", 10),
      createdAt: this.database.getMetadata("index.createdAt") ?? "",
      updatedAt: this.database.getMetadata("index.updatedAt") ?? "",
    };
  }

  private saveIndexMetadata(provider: ConfiguredProviderInfo): void {
    if (!this.database) return;

    const now = new Date().toISOString();
    const existingCreatedAt = this.database.getMetadata("index.createdAt");

    this.database.setMetadata("index.version", INDEX_METADATA_VERSION);
    this.database.setMetadata("index.embeddingProvider", provider.provider);
    this.database.setMetadata("index.embeddingModel", provider.modelInfo.model);
    this.database.setMetadata("index.embeddingDimensions", provider.modelInfo.dimensions.toString());
    this.database.setMetadata("index.updatedAt", now);

    if (!existingCreatedAt) {
      this.database.setMetadata("index.createdAt", now);
    }
  }

  private validateIndexCompatibility(provider: ConfiguredProviderInfo): IndexCompatibility {
    const storedMetadata = this.loadIndexMetadata();

    if (!storedMetadata) {
      return { compatible: true };
    }

    const currentProvider = provider.provider;
    const currentModel = provider.modelInfo.model;
    const currentDimensions = provider.modelInfo.dimensions;

    if (storedMetadata.embeddingDimensions !== currentDimensions) {
      return {
        compatible: false,
        code: IncompatibilityCode.DIMENSION_MISMATCH,
        reason: `Dimension mismatch: index has ${storedMetadata.embeddingDimensions}D vectors (${storedMetadata.embeddingProvider}/${storedMetadata.embeddingModel}), but current provider uses ${currentDimensions}D (${currentProvider}/${currentModel}). Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingModel !== currentModel) {
      return {
        compatible: false,
        code: IncompatibilityCode.MODEL_MISMATCH,
        reason: `Model mismatch: index was built with "${storedMetadata.embeddingModel}", but current model is "${currentModel}". Embeddings are incompatible. Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingProvider !== currentProvider) {
      this.logger.warn("Provider changed", {
        storedProvider: storedMetadata.embeddingProvider,
        currentProvider,
      });
    }

    return {
      compatible: true,
      storedMetadata,
    };
  }

  private assertIndexCompatible(): void {
    if (!this.indexCompatibility?.compatible) {
      throw new Error(
        `${this.indexCompatibility?.reason} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }
  }

  checkCompatibility(): IndexCompatibility {
    if (!this.indexCompatibility) {
      if (!this.configuredProviderInfo) {
        throw new Error('No embedding provider info, you must initialize the indexer first.');
      }

      this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    }
    return this.indexCompatibility;
  }

  private async ensureInitialized(): Promise<{
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    voyageProvider: SecondaryEmbeddingProvider | null;
    voyageStore: VectorStore | null;
    voyageModelId: string | null;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: Database;
  }> {
    if (
      !this.provider ||
      !this.invertedIndex ||
      !this.configuredProviderInfo ||
      !this.database ||
      !this.primaryStoreModelId ||
      !this.hasStore(this.primaryStoreModelId)
    ) {
      await this.initialize();
    }

    this.syncVoyageRuntime();
    const voyageModelId = this.getActiveVoyageModelId();
    return {
      store: this.getPrimaryStore(),
      provider: this.provider!,
      voyageProvider: this.voyageProvider,
      voyageStore: voyageModelId ? this.getStore(voyageModelId) : null,
      voyageModelId,
      invertedIndex: this.invertedIndex!,
      configuredProviderInfo: this.configuredProviderInfo!,
      database: this.database!,
    };
  }

  private getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    map.set(key, created);
    return created;
  }

  // Mutation orchestration now lives in IncrementalIndexOrchestrator. The
  // helpers below remain on Indexer because the orchestrator calls back into
  // them for parsing, graph extraction, and branch-aware retrieval cleanup.
  private buildBranchStoreChunkMaps(
    branchChunkIds: Set<string>
  ): {
    existingChunks: Map<string, string>;
    existingChunksByFile: Map<string, Set<string>>;
  } {
    const existingChunks = new Map<string, string>();
    const existingChunksByFile = new Map<string, Set<string>>();

    for (const store of this.stores.values()) {
      for (const { key, metadata } of store.getAllMetadata()) {
        if (!branchChunkIds.has(key) || existingChunks.has(key)) {
          continue;
        }

        existingChunks.set(key, metadata.hash);
        this.getOrCreateSet(existingChunksByFile, metadata.filePath).add(key);
      }
    }

    return {
      existingChunks,
      existingChunksByFile,
    };
  }

  private parseFilesForIndexing(
    files: Array<{ path: string; content: string; hash: string }>
  ): {
    parsedFiles: ParsedFileCandidate[];
    failedFilePaths: string[];
    parseMs: number;
  } {
    const parseStartTime = performance.now();
    const parsedFiles: ParsedFileCandidate[] = [];
    const failedFilePaths: string[] = [];

    for (const file of files) {
      try {
        const semanticChunks = chunkFile(
          file.path,
          getChunkerLanguage(file.path),
          file.content,
          {
            targetTokenBudget: 512,
            maxChunkChars: 2000,
            minChunkChars: 400,
            mergeSmallSiblings: true,
            attachComments: true,
            emitCoarseChunks: true,
          }
        );

        const chunks = semanticChunks
          .filter((chunk) => chunk.granularity === "Fine" || chunk.chunkKind === "File")
          .map((chunk) => ({
            content: chunk.text,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            startByte: chunk.startByte,
            endByte: chunk.endByte,
            chunkType: mapSemanticChunkType(chunk.symbolKind),
            name: chunk.symbolName,
            symbolAliases: chunk.symbolAliases ?? [],
            chunkKind: chunk.chunkKind,
            symbolKind: chunk.symbolKind,
            language: chunk.language,
            chunkHash: chunk.chunkHash,
          }));

        parsedFiles.push({
          path: file.path,
          hash: file.hash,
          content: file.content,
          chunks,
        });
      } catch (error) {
        failedFilePaths.push(file.path);
        this.logger.warn("Chunking failed for file, skipping it for this pass", {
          filePath: file.path,
          error: getErrorMessage(error),
        });
      }
    }

    return {
      parsedFiles,
      failedFilePaths,
      parseMs: performance.now() - parseStartTime,
    };
  }

  private buildFileGraphData(parsedFiles: ParsedFileCandidate[]): Map<string, FileGraphData> {
    const graphData = new Map<string, FileGraphData>();

    for (const parsed of parsedFiles) {
      const fileSymbols: Array<SymbolData & { startByte: number; endByte: number }> = [];
      for (const chunk of parsed.chunks) {
        if (
          chunk.chunkKind === "File" ||
          !chunk.name ||
          !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)
        ) {
          continue;
        }

        const symbolId = `sym_${hashContent(parsed.path + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`;
        fileSymbols.push({
          id: symbolId,
          filePath: parsed.path,
          name: chunk.name,
          symbolAliases: chunk.symbolAliases ?? [],
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: 0,
          endLine: chunk.endLine,
          endCol: 0,
          language: chunk.language,
          startByte: chunk.startByte,
          endByte: chunk.endByte,
        });
      }

      const symbolsByName = new Map<string, SymbolData[]>();
      for (const symbol of fileSymbols) {
        const symbolNames = [symbol.name, ...(symbol.symbolAliases ?? [])];
        for (const symbolName of symbolNames) {
          const existing = symbolsByName.get(symbolName) ?? [];
          existing.push(symbol);
          symbolsByName.set(symbolName, existing);
        }
      }

      const fileLanguage = parsed.chunks[0]?.language;
      if (!fileLanguage || !CALL_GRAPH_LANGUAGES.has(fileLanguage)) {
        graphData.set(parsed.path, { symbols: fileSymbols, edges: [] });
        continue;
      }

      const callSites = extractCalls(parsed.content, fileLanguage);
      if (callSites.length === 0) {
        graphData.set(parsed.path, {
          symbols: fileSymbols.map(({ startByte: _startByte, endByte: _endByte, ...symbol }) => symbol),
          edges: [],
        });
        continue;
      }

      const lineStartBytes = buildLineStartByteOffsets(parsed.content);
      const edges: GraphEdgeData[] = [];
      for (const site of callSites) {
        const siteByteOffset = lineColumnToByteOffset(lineStartBytes, site.line, site.column);
        if (siteByteOffset === null) {
          continue;
        }

        let enclosingSymbol: (SymbolData & { startByte: number; endByte: number }) | undefined;
        for (const symbol of fileSymbols) {
          if (siteByteOffset < symbol.startByte || siteByteOffset >= symbol.endByte) {
            continue;
          }

          if (
            !enclosingSymbol ||
            symbol.startByte > enclosingSymbol.startByte ||
            (symbol.startByte === enclosingSymbol.startByte && symbol.endByte < enclosingSymbol.endByte) ||
            (symbol.startByte === enclosingSymbol.startByte &&
              symbol.endByte === enclosingSymbol.endByte &&
              symbol.id.localeCompare(enclosingSymbol.id) < 0)
          ) {
            enclosingSymbol = symbol;
          }
        }
        if (!enclosingSymbol) {
          continue;
        }

        const edgeId = `edge_${hashContent(enclosingSymbol.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
        const candidates = symbolsByName.get(site.calleeName);
        const resolvedSymbol = candidates && candidates.length === 1 ? candidates[0] : undefined;
        edges.push({
          id: edgeId,
          fromSymbolId: enclosingSymbol.id,
          callerFilePath: parsed.path,
          targetName: site.calleeName,
          targetFilePath: resolvedSymbol?.filePath,
          targetKind: resolvedSymbol?.kind,
          toSymbolId: resolvedSymbol?.id,
          callType: site.callType,
          line: site.line,
          col: site.column,
          isResolved: resolvedSymbol !== undefined,
        });
      }

      graphData.set(parsed.path, {
        symbols: fileSymbols.map(({ startByte: _startByte, endByte: _endByte, ...symbol }) => symbol),
        edges,
      });
    }

    return graphData;
  }

  private removeChunkFromRetrievalIfUnreferenced(
    database: Database,
    invertedIndex: InvertedIndex,
    chunkId: string
  ): boolean {
    if (database.chunkExistsOnOtherBranches(this.currentBranch, chunkId)) {
      return false;
    }

    for (const store of this.stores.values()) {
      store.remove(chunkId);
    }
    invertedIndex.removeChunk(chunkId);
    return true;
  }

  private clearCallEdgesForSymbolIfUnreferenced(database: Database, symbolId: string): boolean {
    if (database.symbolExistsOnOtherBranches(this.currentBranch, symbolId)) {
      database.unresolveCallEdgesByTargetSymbolForBranch(symbolId, this.currentBranch);
      database.deleteCallEdgesBySymbolForBranch(symbolId, this.currentBranch);
      return false;
    }

    database.deleteCallEdgesByTargetSymbol(symbolId);
    database.deleteCallEdgesBySymbol(symbolId);
    return true;
  }

  private removeSymbolFromGraphIfUnreferenced(database: Database, symbolId: string): boolean {
    if (database.symbolExistsOnOtherBranches(this.currentBranch, symbolId)) {
      database.unresolveCallEdgesByTargetSymbolForBranch(symbolId, this.currentBranch);
      database.deleteCallEdgesBySymbolForBranch(symbolId, this.currentBranch);
      return false;
    }

    database.deleteCallEdgesByTargetSymbol(symbolId);
    database.deleteCallEdgesBySymbol(symbolId);
    database.deleteSymbol(symbolId);
    return true;
  }

  private commitFileHashChanges(
    successfulFileHashes: Map<string, string>,
    removedFilePaths: Iterable<string>
  ): void {
    for (const [filePath, hash] of successfulFileHashes) {
      this.fileHashCache.set(filePath, hash);
    }

    for (const filePath of removedFilePaths) {
      this.fileHashCache.delete(filePath);
    }

    this.saveFileHashCache();
  }

  private async buildCommittedMerkleSnapshot(
    baseSnapshot: string | null,
    committedRelativePaths: string[]
  ): Promise<string | null> {
    if (!baseSnapshot || committedRelativePaths.length === 0) {
      return null;
    }

    const prepared = await diffMerkleFromEvents(
      baseSnapshot,
      this.normalizeDirtyPaths(committedRelativePaths),
      this.projectRoot,
      this.buildMerkleIgnoreRules()
    );
    return prepared.nextSnapshot;
  }

  private buildMerkleIgnoreRules(): MerkleIgnoreRules {
    return {
      include: [...this.config.include],
      exclude: [...this.config.exclude],
      maxFileSize: this.config.indexing.maxFileSize,
    };
  }

  private normalizeDirtyPaths(paths: string[]): string[] {
    return Array.from(
      new Set(
        paths
          .map((filePath) => filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""))
          .filter((filePath) => filePath.length > 0)
      )
    ).sort();
  }

  private normalizeIncomingFilePath(filePath: string): string {
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.join(this.projectRoot, filePath);

    try {
      return realpathSync(absolutePath);
    } catch {
      let current = path.dirname(absolutePath);
      let suffix = path.basename(absolutePath);

      while (true) {
        try {
          const realCurrent = realpathSync(current);
          return path.join(realCurrent, suffix);
        } catch {
          const parent = path.dirname(current);
          if (parent === current) {
            return absolutePath;
          }
          suffix = path.join(path.basename(current), suffix);
          current = parent;
        }
      }
    }
  }

  async handleFileChanges(changes: Array<{ type: "add" | "change" | "unlink"; path: string }>): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    await this.runSerializedIndexOperation(() => this.handleFileChangesInternal(changes));
  }

  private async handleFileChangesInternal(
    changes: Array<{ type: "add" | "change" | "unlink"; path: string }>
  ): Promise<void> {
    if (await this.maybeResetAfterStartupRetrievalMismatch()) {
      await this.orchestrator.coldStart();
      return;
    }

    try {
      const { database } = await this.ensureInitialized();
      await this.refreshBranchInfo();

      const snapshot = database.getMerkleSnapshot(this.currentBranch);
      if (!snapshot) {
        this.logger.branch("warn", "Merkle snapshot missing, falling back to full index", {
          branch: this.currentBranch,
        });
        await this.orchestrator.coldStart();
        return;
      }

      const changedPaths = this.normalizeDirtyPaths(
        changes.map((change) => {
          const normalizedPath = this.normalizeIncomingFilePath(change.path);
          ensureWatcherEventTimestamp(normalizedPath);
          return path.relative(this.projectRoot, normalizedPath);
        })
      );

      const prepared = await diffMerkleFromEvents(
        snapshot,
        changedPaths,
        this.projectRoot,
        this.buildMerkleIgnoreRules()
      );

      if (
        prepared.changedFiles.length === 0 &&
        prepared.addedFiles.length === 0 &&
        prepared.removedFiles.length === 0
      ) {
        database.saveMerkleSnapshot(prepared.nextSnapshot);
        return;
      }

      await this.orchestrator.hotUpdate(
        {
          changedFiles: prepared.changedFiles,
          addedFiles: prepared.addedFiles,
          removedFiles: prepared.removedFiles,
        },
        prepared.nextSnapshot,
        snapshot
      );
    } catch (error) {
      this.logger.branch("warn", "Merkle hot update failed, falling back to full index", {
        branch: this.currentBranch,
        error: getErrorMessage(error),
      });
      await this.orchestrator.coldStart();
    }
  }

  async handleBranchChange(_oldBranch: string | null, newBranch: string): Promise<void> {
    await this.runSerializedIndexOperation(() => this.handleBranchChangeInternal(_oldBranch, newBranch));
  }

  private async handleBranchChangeInternal(_oldBranch: string | null, newBranch: string): Promise<void> {
    await this.maybeResetAfterStartupRetrievalMismatch();
    await this.orchestrator.handleBranchChange(_oldBranch, newBranch);
  }

  async indexDirtySet(
    diff: MerkleDiff,
    nextSnapshot?: string,
    baseSnapshot: string | null = null
  ): Promise<IndexStats> {
    return this.runSerializedIndexOperation(async () => {
      if (await this.maybeResetAfterStartupRetrievalMismatch()) {
        return this.orchestrator.coldStart();
      }
      return this.orchestrator.hotUpdate(diff, nextSnapshot, baseSnapshot);
    });
  }

  async estimateCost(): Promise<CostEstimate> {
    const { configuredProviderInfo } = await this.ensureInitialized();

    const { files } = await collectFiles(
      this.projectRoot,
      this.config.include,
      this.config.exclude,
      this.config.indexing.maxFileSize
    );

    return createCostEstimate(files, configuredProviderInfo);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    return this.runSerializedIndexOperation(async () => {
      await this.maybeResetAfterStartupRetrievalMismatch();
      return this.orchestrator.coldStart(onProgress);
    });
  }

  async indexForeground(onProgress?: ProgressCallback): Promise<ForegroundIndexResult> {
    await this.refreshBranchInfo();
    const branch = this.getActiveBranchKey(this.currentBranch);
    const existingProgress = this.database
      ? this.readEmbeddingProgressState(this.database, branch)
      : null;

    if (this.backgroundEmbeddingRuns.has(branch)) {
      return this.buildForegroundIndexResult({
        filesProcessed: 0,
        totalChunks: existingProgress?.total ?? 0,
        chunksIndexed: 0,
        removedChunks: 0,
        durationMs: 0,
        embeddingStatus: existingProgress?.status ?? "in_progress",
        embeddingProgress: {
          embedded: existingProgress?.embedded ?? 0,
          total: existingProgress?.total ?? 0,
          startedAt: existingProgress?.startedAt ?? null,
          updatedAt: existingProgress?.updatedAt ?? null,
          failed: existingProgress?.failed ?? null,
        },
        alreadyInProgress: true,
      });
    }

    return this.runSerializedIndexOperation(async () => {
      await this.maybeResetAfterStartupRetrievalMismatch();
      const result = await this.orchestrator.coldStartForeground(onProgress);

      if (
        result.embeddingStatus !== "complete" &&
        result.embeddingProgress.total > 0 &&
        !this.backgroundEmbeddingRuns.has(branch)
      ) {
        const backgroundRun = this.runSerializedIndexOperation(async () => {
          await this.orchestrator.runBackgroundEmbedding(branch);
        }).catch((error) => {
          if (this.database) {
            this.writeEmbeddingProgressState(
              this.database,
              {
                status: result.embeddingProgress.embedded > 0 ? "partial" : "failed",
                embedded: result.embeddingProgress.embedded,
                total: result.embeddingProgress.total,
                startedAt: result.embeddingProgress.startedAt ?? Date.now(),
                updatedAt: Date.now(),
                failed: error instanceof Error ? error.message : String(error),
                activeRunId: null,
              },
              branch
            );
          }
          this.logger.warn("Background embedding run failed", {
            branch,
            error: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          this.backgroundEmbeddingRuns.delete(branch);
        });

        this.backgroundEmbeddingRuns.set(branch, backgroundRun);
      }

      return result;
    });
  }

  private getQueryEmbeddingCacheKey(modelId: string, query: string): string {
    return `${modelId}\u0000${query}`;
  }

  private setQueryEmbeddingLaneDegraded(modelId: string, reason: string): void {
    this.queryEmbeddingFailureState.set(modelId, {
      until: Date.now() + this.queryEmbeddingFailureCooldownMs,
      reason,
    });
  }

  private clearQueryEmbeddingLaneDegraded(modelId: string): void {
    this.queryEmbeddingFailureState.delete(modelId);
  }

  private startSecondaryProviderHealthProbe(
    provider: Pick<EmbeddingProviderInterface, "getModelInfo"> & {
      embedQuery(query: string): Promise<EmbeddingResult | null>;
    }
  ): void {
    const modelId = provider.getModelInfo().model;
    const probeToken = Symbol(modelId);
    this.secondaryProviderProbeTokens.set(modelId, probeToken);
    const startedAt = performance.now();
    let finished = false;

    const finishFailure = (reason: string): void => {
      if (finished || this.secondaryProviderProbeTokens.get(modelId) !== probeToken) {
        return;
      }
      finished = true;
      this.setQueryEmbeddingLaneDegraded(modelId, reason);
      this.logger.search("debug", "[secondary-provider] health probe failed, lane in cooldown", {
        modelId,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: reason,
      });
    };

    const finishSuccess = (): void => {
      if (finished || this.secondaryProviderProbeTokens.get(modelId) !== probeToken) {
        return;
      }
      finished = true;
      this.clearQueryEmbeddingLaneDegraded(modelId);
      this.logger.search("debug", "[secondary-provider] health probe passed, lane active", {
        modelId,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    };

    const timeoutHandle = setTimeout(() => {
      finishFailure(`startup health probe timed out after ${SECONDARY_PROVIDER_HEALTH_PROBE_TIMEOUT_MS}ms`);
    }, SECONDARY_PROVIDER_HEALTH_PROBE_TIMEOUT_MS);

    void provider.embedQuery(SECONDARY_PROVIDER_HEALTH_PROBE_QUERY)
      .then((result) => {
        clearTimeout(timeoutHandle);
        if (!result) {
          finishFailure("provider returned no query embedding");
          return;
        }
        finishSuccess();
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        finishFailure(getErrorMessage(error));
      });
  }

  private async getQueryEmbedding(
    query: string,
    provider: Pick<EmbeddingProviderInterface, "getModelInfo"> & {
      embedQuery(query: string): Promise<EmbeddingResult | null>;
    }
  ): Promise<number[] | null> {
    const now = Date.now();
    const modelId = provider.getModelInfo().model;
    const cacheKey = this.getQueryEmbeddingCacheKey(modelId, query);
    const degradedState = this.queryEmbeddingFailureState.get(modelId);
    if (degradedState && degradedState.until > now) {
      this.logger.search("debug", "Skipping degraded query embedding lane during cooldown", {
        modelId,
        retryInMs: degradedState.until - now,
        reason: degradedState.reason,
      });
      return null;
    }
    if (degradedState && degradedState.until <= now) {
      this.queryEmbeddingFailureState.delete(modelId);
    }
    const cached = this.queryEmbeddingCache.get(cacheKey);

    if (cached && (now - cached.timestamp) < this.queryCacheTtlMs) {
      this.logger.cache("debug", "Query embedding cache hit (exact)", {
        query: query.slice(0, 50),
        modelId,
      });
      this.logger.recordQueryCacheHit();
      return cached.embedding;
    }

    const similarMatch = this.findSimilarCachedQuery(query, now, modelId);
    if (similarMatch) {
      this.logger.cache("debug", "Query embedding cache hit (similar)", {
        query: query.slice(0, 50),
        similarTo: similarMatch.key.slice(0, 50),
        similarity: similarMatch.similarity.toFixed(3),
        modelId,
      });
      this.logger.recordQueryCacheSimilarHit();
      return similarMatch.embedding;
    }

    this.logger.cache("debug", "Query embedding cache miss", {
      query: query.slice(0, 50),
      modelId,
    });
    this.logger.recordQueryCacheMiss();
    let result: EmbeddingResult | null;
    try {
      result = await provider.embedQuery(query);
    } catch (error) {
      const reason = getErrorMessage(error);
      this.setQueryEmbeddingLaneDegraded(modelId, reason);
      this.logger.search("warn", "Query embedding lane failed; entering cooldown", {
        modelId,
        cooldownMs: this.queryEmbeddingFailureCooldownMs,
        error: reason,
      });
      throw error;
    }
    if (!result) {
      this.setQueryEmbeddingLaneDegraded(modelId, "provider returned no query embedding");
      this.logger.search("warn", "Query embedding lane returned no embedding; entering cooldown", {
        modelId,
        cooldownMs: this.queryEmbeddingFailureCooldownMs,
      });
      return null;
    }
    const { embedding, tokensUsed } = result;
    this.logger.recordEmbeddingApiCall(tokensUsed);
    this.clearQueryEmbeddingLaneDegraded(modelId);

    if (this.queryEmbeddingCache.size >= this.maxQueryCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (oldestKey) {
        this.queryEmbeddingCache.delete(oldestKey);
      }
    }

    this.queryEmbeddingCache.set(cacheKey, {
      query,
      modelId,
      embedding,
      timestamp: now,
    });
    return embedding;
  }

  private findSimilarCachedQuery(
    query: string,
    now: number,
    modelId: string
  ): { key: string; embedding: number[]; similarity: number } | null {
    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return null;

    let bestMatch: { key: string; embedding: number[]; similarity: number } | null = null;

    for (const { query: cachedQuery, modelId: cachedModelId, embedding, timestamp } of this.queryEmbeddingCache.values()) {
      if (cachedModelId !== modelId) continue;
      if ((now - timestamp) >= this.queryCacheTtlMs) continue;

      const cachedTokens = this.tokenize(cachedQuery);
      const similarity = this.jaccardSimilarity(queryTokens, cachedTokens);

      if (similarity >= this.querySimilarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { key: cachedQuery, embedding, similarity };
        }
      }
    }

    return bestMatch;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1)
    );
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return intersection / union;
  }

  private async readFileContentCached(
    filePath: string,
    cache: Map<string, string | null>
  ): Promise<string | null> {
    if (cache.has(filePath)) {
      return cache.get(filePath) ?? null;
    }

    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      cache.set(filePath, content);
      return content;
    } catch {
      cache.set(filePath, null);
      return null;
    }
  }

  private getChunkContentFromFile(fileContent: string | null, metadata: ChunkMetadata): string {
    if (fileContent === null) {
      return "";
    }

    const lines = fileContent.split("\n");
    return lines.slice(metadata.startLine - 1, metadata.endLine).join("\n");
  }

  private async batchFetchStoredChunkTexts(
    embeddingInputHashes: string[]
  ): Promise<Map<string, string>> {
    const uniqueEmbeddingInputHashes = Array.from(
      new Set(
        embeddingInputHashes.filter((embeddingInputHash) => embeddingInputHash.length > 0)
      )
    );
    if (uniqueEmbeddingInputHashes.length === 0) {
      return new Map();
    }

    const { database } = await this.ensureInitialized();
    return database.getChunkTextsBatch(uniqueEmbeddingInputHashes);
  }

  private async buildRerankerCandidates(
    candidates: RankedCandidate[],
    fileContentCache: Map<string, string | null>,
    storedChunkTexts: Map<string, string>
  ): Promise<RerankerCandidate[]> {
    return Promise.all(
      candidates.map(async (candidate) => {
        let content = storedChunkTexts.get(candidate.metadata.hash) ?? "";
        if (content.length === 0) {
          const fileContent = await this.readFileContentCached(candidate.metadata.filePath, fileContentCache);
          content = this.getChunkContentFromFile(fileContent, candidate.metadata);
        }

        return {
          id: candidate.id,
          baseScore: candidate.score,
          metadata: candidate.metadata,
          chunkKind: candidate.chunkKind ?? candidate.metadata.chunkKind,
          symbolKind: candidate.symbolKind ?? candidate.metadata.symbolKind,
          relation: candidate.relation,
          content,
        };
      })
    );
  }

  private async batchFetchChunkKinds(
    chunkIds: string[]
  ): Promise<Map<string, { chunkKind?: ChunkKind; symbolKind?: ChunkSymbolKind }>> {
    const uniqueChunkIds = Array.from(new Set(chunkIds));
    if (uniqueChunkIds.length === 0) {
      return new Map();
    }

    const { database } = await this.ensureInitialized();
    const rows = database.getChunkKindsBatch(uniqueChunkIds);
    return new Map(
      rows.map((row) => [
        row.chunkId,
        {
          chunkKind: row.chunkKind,
          symbolKind: row.symbolKind,
        },
      ])
    );
  }

  private async materializeRankedResults(
    candidates: RankedCandidate[],
    options: { metadataOnly: boolean; contextLines: number },
    fileContentCache: Map<string, string | null>,
    storedChunkTexts: Map<string, string>,
    subIntent: SubIntent = null
  ): Promise<SearchResult[]> {
    return Promise.all(
      candidates.map(async (candidate) => {
        let content = "";
        let startLine = candidate.metadata.startLine;
        let endLine = candidate.metadata.endLine;

        if (!options.metadataOnly) {
          const storedChunkText = storedChunkTexts.get(candidate.metadata.hash);
          if (storedChunkText !== undefined) {
            content = storedChunkText;
          } else {
            const fileContent = await this.readFileContentCached(candidate.metadata.filePath, fileContentCache);
            if (fileContent === null) {
              content = "[File not accessible]";
            } else if (this.config.search.includeContext) {
              const lines = fileContent.split("\n");
              startLine = Math.max(1, candidate.metadata.startLine - options.contextLines);
              endLine = Math.min(lines.length, candidate.metadata.endLine + options.contextLines);
              content = lines.slice(startLine - 1, endLine).join("\n");
            } else {
              content = this.getChunkContentFromFile(fileContent, candidate.metadata);
            }
          }
        }

        const scoreBreakdown = cloneScoreBreakdown(candidate.scoreBreakdown);
        if (scoreBreakdown) {
          scoreBreakdown.fusion.subIntent = subIntent;
        }

        return {
          filePath: candidate.metadata.filePath,
          startLine,
          endLine,
          content,
          score: candidate.score,
          reranked: candidate.reranked,
          rerankerScore: candidate.reranked ? candidate.score : null,
          lane: candidate.lane ?? "hybrid",
          chunkType: candidate.metadata.chunkType,
          chunkKind: candidate.chunkKind ?? candidate.metadata.chunkKind,
          symbolKind: candidate.symbolKind ?? candidate.metadata.symbolKind,
          name: candidate.metadata.name,
          scoreBreakdown,
        };
      })
    );
  }

  private async materializeExpandedContext(
    entries: GraphExpansionEntry[],
    options: { metadataOnly: boolean; contextLines: number },
    fileContentCache: Map<string, string | null>,
    storedChunkTexts: Map<string, string>
  ): Promise<GraphContextResult[]> {
    return Promise.all(
      entries.map(async (entry) => {
        const [materialized] = await this.materializeRankedResults(
          [{
            id: entry.id,
            score: 0,
            metadata: entry.metadata,
            relation: entry.relation,
          }],
          options,
          fileContentCache,
          storedChunkTexts
        );

        return {
          ...materialized,
          relation: entry.relation,
          depth: entry.depth,
          viaSymbol: entry.viaSymbol,
          lane: materialized.lane ?? "hybrid",
        };
      })
    );
  }

  private async applyFinalReranker(
    query: string,
    candidates: RankedCandidate[],
    taskType: SearchTaskType,
    rerankTopN: number,
    fileContentCache: Map<string, string | null>
  ): Promise<{ ordered: RankedCandidate[]; applied: boolean; backend: string | null; failedBackend?: string | null }> {
    for (const candidate of candidates) {
      if (candidate.scoreBreakdown) {
        candidate.scoreBreakdown.preRerankScore = candidate.score;
        candidate.scoreBreakdown.finalScore = candidate.score;
      }
    }

    if (rerankTopN <= 0 || candidates.length < 2) {
      return {
        ordered: applyRelationshipGraphBias(query, applyCallerTargetPenalty(query, candidates, taskType), taskType),
        applied: false,
        backend: null,
        failedBackend: null,
      };
    }

    const headSize = Math.min(rerankTopN, candidates.length);
    const head = candidates.slice(0, headSize);
    const tail = candidates.slice(headSize);
    const storedChunkTexts = await this.batchFetchStoredChunkTexts(
      head.map((candidate) => candidate.metadata.hash)
    );
    const rerankerCandidates = await this.buildRerankerCandidates(head, fileContentCache, storedChunkTexts);
    const reranked = await this.searchReranker.rerank(query, rerankerCandidates, taskType);

    if (reranked.failedBackend) {
      this.logger.search("warn", "Search reranker backend degraded; using fallback backend", {
        taskType,
        failedBackend: reranked.failedBackend,
        activeBackend: reranked.backend ?? "existing-order",
      });
    }

    if (!reranked.applied) {
      return {
        ordered: applyRelationshipGraphBias(query, applyCallerTargetPenalty(query, candidates, taskType), taskType),
        applied: false,
        backend: null,
        failedBackend: reranked.failedBackend,
      };
    }

    const headById = new Map(head.map((candidate) => [candidate.id, candidate]));
    const orderedHead = reranked.candidates
      .map<RankedCandidate | undefined>((candidate, rerankerIndex) => {
        const original = headById.get(candidate.id);
        if (!original) {
          return undefined;
        }

        const nextCandidate: RankedCandidate = {
          ...original,
          score: candidate.baseScore,
          chunkKind: candidate.chunkKind ?? original.chunkKind ?? original.metadata.chunkKind,
          symbolKind: candidate.symbolKind ?? original.symbolKind ?? original.metadata.symbolKind,
          relation: candidate.relation ?? original.relation,
          reranked: true,
        };
        if (nextCandidate.scoreBreakdown) {
          recordScoreStage(nextCandidate, {
            name: "finalReranker",
            kind: "replace",
            before: original.score,
            after: candidate.baseScore,
            reason: `backend=${reranked.backend ?? "unknown"}; rank=${rerankerIndex + 1}`,
          });
          nextCandidate.scoreBreakdown.reranker = {
            score: candidate.baseScore,
            rank: rerankerIndex + 1,
            backend: reranked.backend ?? "unknown",
          };
          nextCandidate.scoreBreakdown.finalScore = candidate.baseScore;
        }
        return nextCandidate;
      });
    const promotedHead: RankedCandidate[] = orderedHead.filter((candidate): candidate is RankedCandidate => candidate !== undefined);
    const orderedTail = tail.map((candidate) => ({
      ...candidate,
      reranked: false,
    }));

    return {
      ordered: applyRelationshipGraphBias(
        query,
        applyCallerTargetPenalty(query, [...promotedHead, ...orderedTail], taskType),
        taskType
      ),
      applied: true,
      backend: reranked.backend,
      failedBackend: reranked.failedBackend,
    };
  }

  async search(
    query: string,
    limit?: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const result = await this.searchDetailed(query, limit, options);
    if (result.graphDirection === "both") {
      return result.primaryResults;
    }

    const merged: SearchResult[] = result.primaryResults.map((entry) => ({ ...entry }));
    const indexByIdentity = new Map(
      merged.map((entry, index) => [
        `${entry.filePath}:${entry.startLine}:${entry.endLine}:${entry.name ?? ""}:${entry.chunkType}`,
        index,
      ])
    );

    for (const entry of result.expandedContext) {
      const identity = `${entry.filePath}:${entry.startLine}:${entry.endLine}:${entry.name ?? ""}:${entry.chunkType}`;
      const existingIndex = indexByIdentity.get(identity);
      if (existingIndex !== undefined) {
        merged[existingIndex] = {
          ...merged[existingIndex],
          relation: entry.relation,
          depth: entry.depth,
          viaSymbol: entry.viaSymbol,
        };
        continue;
      }
      indexByIdentity.set(identity, merged.length);
      merged.push(entry);
    }

    return merged;
  }

  async searchDetailed(
    query: string,
    limit?: number,
    options?: SearchOptions
  ): Promise<SearchResponse> {
    const branch = this.currentBranch;
    const {
      store,
      provider,
      voyageProvider,
      voyageStore,
      voyageModelId,
      database,
    } = await this.ensureInitialized();
    const taskType = inferTaskType(query, options?.taskType);
    const subIntent = inferSubIntent(query, taskType);
    const voyageLaneConfigured = Boolean(voyageProvider && voyageStore && voyageModelId);

    if (query.trim().length === 0) {
      return {
        primaryResults: [],
        expandedContext: [],
        taskType,
        subIntent,
        graphDirection: options?.graphDirection ?? "both",
        timings: {
          prefilterMs: 0,
        },
        retrieval: {
          voyageLaneConfigured,
          voyageLaneUsed: false,
        },
        reranker: {
          applied: false,
          backend: null,
        },
      };
    }

    const compatibility = this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `A possible solution is to run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();
    const hasDensePrimary = store.count() > 0;
    const hasDenseVoyage = Boolean(voyageStore && voyageStore.count() > 0);
    const hasSparse = this.invertedIndex?.getDocumentCount() ? this.invertedIndex.getDocumentCount() > 0 : false;

    if (!hasDensePrimary && !hasDenseVoyage && !hasSparse) {
      this.logger.search("debug", "Search on empty index", { query });
      return {
        primaryResults: [],
        expandedContext: [],
        taskType,
        subIntent,
        graphDirection: options?.graphDirection ?? "both",
        timings: {
          prefilterMs: 0,
        },
        retrieval: {
          voyageLaneConfigured,
          voyageLaneUsed: false,
        },
        reranker: {
          applied: false,
          backend: null,
        },
      };
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const recipe = getSearchRecipe(taskType);
    const includeScoreBreakdown = options?.includeScoreBreakdown === true;
    const queryIntent = classifyQueryIntentRaw(query);
    const hybridWeight = options?.hybridWeight ?? recipe.hybridWeight ?? this.config.search.hybridWeight;
    const configuredBm25Weight = options?.bm25Weight ?? recipe.bm25Weight;
    const configuredDenseWeight = options?.denseWeight ?? recipe.denseWeight;
    const configuredVoyageWeight = options?.voyageWeight ?? recipe.voyageWeight;
    const fusionStrategy = this.config.search.fusionStrategy;
    const rrfK = this.config.search.rrfK;
    const rerankTopN = this.config.search.rerankTopN;
    const filterByBranch = options?.filterByBranch ?? true;
    const sourceIntent = options?.definitionIntent === true ||
      recipe.forceDefinitionIntent ||
      taskType === "bug" ||
      queryIntent === "source";
    const identifierBoost = options?.identifierBoost ?? recipe.identifierBoost ?? 1.0;
    const experimentalIdentifierRiskPolicy =
      this.config.search.experimentalIdentifierRiskPolicy &&
      shouldApplyExperimentalIdentifierRiskPolicy(query, taskType, true);
    const finalRerankTopN =
      options?.finalRerankTopN !== undefined
        ? options.finalRerankTopN
        : taskType === "general" && queryIntent === "doc_test" && options?.definitionIntent !== true
          ? 0
          : recipe.finalRerankTopN;
    const inferredGraphDirection = options?.graphDirection ?? inferRelationshipGraphDirection(query);
    const graphDirection = inferredGraphDirection ?? "both";
    const graphDepth = Math.max(0, Math.min(2, options?.graphDepth ?? recipe.graphDepth ?? 0));
    const prefilterStartTime = performance.now();
    const metadataAllowedChunkIds = await this.buildAllowedChunkIds(database, branch, {
      fileType: options?.fileType,
      directory: options?.directory,
      chunkType: options?.chunkType,
      chunkKind: options?.chunkKind,
      language: options?.language,
      pathGlob: options?.pathGlob,
    });
    const prefilterMs = performance.now() - prefilterStartTime;

    if (metadataAllowedChunkIds && metadataAllowedChunkIds.size === 0) {
      this.logger.search("debug", "Search has no candidates after hard filtering", {
        query,
      });
      return {
        primaryResults: [],
        expandedContext: [],
        taskType,
        subIntent,
        graphDirection: options?.graphDirection ?? "both",
        timings: {
          prefilterMs: Math.round(prefilterMs * 100) / 100,
        },
        retrieval: {
          voyageLaneConfigured,
          voyageLaneUsed: false,
        },
        reranker: {
          applied: false,
          backend: null,
        },
      };
    }

    const branchFilter = filterByBranch ? this.getActiveBranchKey(branch) : null;
    const retrievalLimit = resolveRetrievalCandidateLimit(maxResults);
    const laneRetrievalLimit = metadataAllowedChunkIds
      ? Math.max(retrievalLimit * 5, 100)
      : retrievalLimit;

    const embeddingStartTime = performance.now();
    const embeddingQuery = stripFilePathHint(query);
    const [arcticQueryVector, rawVoyageQueryVector] = await Promise.all([
      hasDensePrimary
        ? this.getQueryEmbedding(embeddingQuery, provider).catch((error) => {
            this.logger.search("warn", "Primary query embedding failed; continuing without Arctic dense lane", {
              taskType,
              model: provider.getModelInfo().model,
              error: getErrorMessage(error),
            });
            return null;
          })
        : Promise.resolve(null),
      hasDenseVoyage && voyageProvider
        ? this.getQueryEmbedding(embeddingQuery, voyageProvider).catch((error) => {
            this.logger.search("warn", "Voyage query embedding failed; continuing without Voyage dense lane", {
              taskType,
              model: voyageProvider.getModelInfo().model,
              error: getErrorMessage(error),
            });
            return null;
          })
        : Promise.resolve(null),
    ]);
    const embeddingMs = performance.now() - embeddingStartTime;
    const voyageLaneAvailable = Boolean(voyageLaneConfigured && rawVoyageQueryVector);
    const fusionWeights = normalizeFusionWeights(
      configuredBm25Weight,
      voyageLaneAvailable
        ? configuredDenseWeight
        : (configuredDenseWeight ?? 0) + (configuredVoyageWeight ?? 0),
      voyageLaneAvailable ? configuredVoyageWeight : 0,
      hybridWeight
    );

    this.logger.search("debug", "Starting search", {
      query,
      maxResults,
      hybridWeight,
      bm25Weight: fusionWeights.bm25Weight,
      denseWeight: fusionWeights.denseWeight,
      voyageWeight: fusionWeights.voyageWeight,
      voyageLaneConfigured,
      voyageLaneAvailable,
      fusionStrategy,
      rrfK,
      rerankTopN,
      finalRerankTopN,
      identifierBoost,
      filterByBranch,
      taskType,
    });

    if (voyageLaneConfigured && !voyageLaneAvailable) {
      this.logger.search("info", "Voyage dense lane unavailable for this query; redistributing its fusion weight to Arctic", {
        taskType,
        model: voyageModelId,
      });
    }

    const vectorStartTime = performance.now();
    // These lanes are orchestrated together, but the native VectorStore/BM25
    // calls are still synchronous NAPI boundaries today. Promise.all keeps the
    // control flow uniform and isolates lane failures, but it does not provide
    // true CPU parallelism until the native search APIs become asynchronous or
    // move onto dedicated worker threads.
    const [semanticLane, voyageLane, keywordLane] = await Promise.all([
      Promise.resolve().then(() => {
        const started = performance.now();
        if (!hasDensePrimary || !arcticQueryVector) {
          return { results: [] as RankedCandidate[], ms: performance.now() - started };
        }

        const results = branchFilter
          ? store.searchOnBranch(arcticQueryVector, branchFilter, laneRetrievalLimit)
          : store.search(arcticQueryVector, laneRetrievalLimit);
        return { results, ms: performance.now() - started };
      }).catch((error) => {
        this.logger.search("warn", "Arctic dense search failed; continuing without primary dense lane", {
          taskType,
          model: provider.getModelInfo().model,
          error: getErrorMessage(error),
        });
        return { results: [] as RankedCandidate[], ms: 0 };
      }),
      Promise.resolve().then(() => {
        const started = performance.now();
        if (!hasDenseVoyage || !rawVoyageQueryVector || !voyageStore || !voyageLaneAvailable) {
          return { results: [] as RankedCandidate[], ms: performance.now() - started };
        }

        const results = branchFilter
          ? voyageStore.searchOnBranch(rawVoyageQueryVector, branchFilter, laneRetrievalLimit)
          : voyageStore.search(rawVoyageQueryVector, laneRetrievalLimit);
        return { results, ms: performance.now() - started };
      }).catch((error) => {
        this.logger.search("warn", "Voyage dense search failed; continuing without Voyage lane", {
          taskType,
          model: voyageModelId,
          error: getErrorMessage(error),
        });
        return { results: [] as RankedCandidate[], ms: 0 };
      }),
      Promise.resolve().then(async () => {
        const started = performance.now();
        const results = await this.keywordSearch(query, laneRetrievalLimit, branchFilter);
        return { results, ms: performance.now() - started };
      }).catch((error) => {
        this.logger.search("warn", "BM25 search failed; continuing with dense lanes only", {
          taskType,
          error: getErrorMessage(error),
        });
        return { results: [] as RankedCandidate[], ms: 0 };
      }),
    ]);
    const vectorMs = performance.now() - vectorStartTime;
    const semanticCandidates = this.filterCandidatesByChunkIds(
      semanticLane.results.map((candidate) => ({ ...candidate, lane: "semantic" as const })),
      metadataAllowedChunkIds
    );
    const voyageCandidates = this.filterCandidatesByChunkIds(
      voyageLane.results.map((candidate) => ({ ...candidate, lane: "semantic" as const })),
      metadataAllowedChunkIds
    );
    const keywordCandidates = this.filterCandidatesByChunkIds(
      keywordLane.results.map((candidate) => ({ ...candidate, lane: "bm25" as const })),
      metadataAllowedChunkIds
    );
    const keywordMs = keywordLane.ms;
    const scoreBreakdownLanes = includeScoreBreakdown
      ? buildLaneScoreBreakdowns(keywordCandidates, semanticCandidates, voyageCandidates)
      : undefined;

    const fusionStartTime = performance.now();
    const combined = rankHybridResults(query, semanticCandidates, keywordCandidates, {
      fusionStrategy,
      rrfK,
      rerankTopN,
      limit: maxResults,
      hybridWeight,
      bm25Weight: fusionWeights.bm25Weight,
      denseWeight: fusionWeights.denseWeight,
      voyageWeight: fusionWeights.voyageWeight,
      voyageResults: voyageCandidates,
      prioritizeSourcePaths: sourceIntent,
      pathPreference: recipe.pathPreference,
      taskType,
      scoreBreakdownLanes,
    });
    const fusionMs = performance.now() - fusionStartTime;

    const rescued = recipe.enableIdentifierPromotion
      ? promoteIdentifierMatches(
          query,
          combined,
          [semanticCandidates, voyageCandidates, keywordCandidates],
          database,
          metadataAllowedChunkIds,
          recipe.pathPreference,
          identifierBoost,
          includeScoreBreakdown,
          experimentalIdentifierRiskPolicy
        )
      : combined;

    const union = unionCandidates(semanticCandidates, voyageCandidates, keywordCandidates);

    const deterministicIdentifierCandidates =
      taskType === "definition" && inferredGraphDirection == null
        ? union.filter((candidate) => !candidate.metadata.filePath.endsWith(".d.ts"))
        : union;

    const deterministicIdentifierLane = recipe.enableDeterministicIdentifierLane
      ? buildDeterministicIdentifierPass(
          query,
          deterministicIdentifierCandidates,
          maxResults,
          sourceIntent,
          includeScoreBreakdown,
          experimentalIdentifierRiskPolicy
        )
      : [];

    const identifierLane = recipe.enableIdentifierDefinitionLane
      ? buildIdentifierDefinitionLane(
          query,
          union,
          maxResults,
          sourceIntent,
          includeScoreBreakdown,
          experimentalIdentifierRiskPolicy
        )
      : [];

    const symbolLane = recipe.enableSymbolDefinitionLane
      ? buildSymbolDefinitionLane(
        query,
        database,
        metadataAllowedChunkIds,
        maxResults,
        union,
        sourceIntent,
        includeScoreBreakdown
        )
      : [];

    const prePrimaryLane = mergeTieredResults(deterministicIdentifierLane, identifierLane, maxResults * 4);
    const primaryLane = mergeTieredResults(prePrimaryLane, symbolLane, maxResults * 4);
    const tiered = mergeTieredResults(primaryLane, rescued, maxResults * 4);
    const hasCodeHints = extractCodeTermHints(query).length > 0 || extractIdentifierHints(query).length > 0;

    const baseFiltered = tiered.filter((r) => r.score >= this.config.search.minScore);

    const implementationOnly = baseFiltered.filter((r) =>
      isLikelyImplementationPath(r.metadata.filePath) &&
      isImplementationChunkType(r.metadata.chunkType)
    );

    const candidatePoolLimit = Math.max(maxResults, finalRerankTopN);
    const filteredBase = ((recipe.implementationOnlyOnCodeHints && sourceIntent && hasCodeHints && implementationOnly.length > 0)
      ? implementationOnly
      : baseFiltered
    ).slice(0, candidatePoolLimit);
    const chunkKindMap = await this.batchFetchChunkKinds(filteredBase.map((candidate) => candidate.id));
    for (const candidate of filteredBase) {
      const enrichment = chunkKindMap.get(candidate.id);
      if (!enrichment) {
        continue;
      }
      candidate.chunkKind = enrichment.chunkKind;
      candidate.symbolKind = enrichment.symbolKind;
    }
    const filteredWithPathBias = applySemanticSourcePathPenalty(
      applyChunkKindPenalty(
        suppressCoarseFileChunksWhenSymbolMatchesExist(query, filteredBase),
        taskType,
        query
      ),
      taskType,
      recipe.pathPreference
    );
    const filteredWithDefinitionPolicy = applyDefinitionImplementationPolicy(
      filteredWithPathBias,
      query,
      taskType,
      graphDirection,
      includeScoreBreakdown,
      subIntent
    );
    const filtered = taskType === "semantic"
      ? preferEarlierNamedChunkSlices(filteredWithDefinitionPolicy)
      : filteredWithDefinitionPolicy;
    const relationshipGraphAugmented = injectRelationshipGraphCandidates(
      query,
      filtered,
      database,
      branch,
      graphDepth,
      graphDirection,
      metadataAllowedChunkIds,
      taskType,
      includeScoreBreakdown
    );
    const callerChunkTexts = await this.batchFetchStoredChunkTexts(
      relationshipGraphAugmented.map((candidate) => candidate.metadata.hash)
    );
    const callerBoosted = applyCallerContentBoost(query, relationshipGraphAugmented, callerChunkTexts, taskType);

    const fileContentCache = new Map<string, string | null>();
    const rerankStartTime = performance.now();
    const reranked = await this.applyFinalReranker(
      query,
      callerBoosted,
      taskType,
      finalRerankTopN,
      fileContentCache
    );
    const rerankMs = performance.now() - rerankStartTime;
    this.logger.recordReranker(reranked.applied, reranked.backend, reranked.failedBackend);

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs,
      fusionMs,
      rerankMs,
    });
    this.logger.search("info", "Search complete", {
      query,
      results: Math.min(maxResults, reranked.ordered.length),
      candidatePool: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      keywordMs: Math.round(keywordMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
      fusionMs: Math.round(fusionMs * 100) / 100,
      rerankMs: Math.round(rerankMs * 100) / 100,
      taskType,
      rerankerBackend: reranked.backend,
    });

    const metadataOnly = options?.metadataOnly ?? false;
    const contextLines = options?.contextLines ?? this.config.search.contextLines;
    const visiblePrimaryCandidates = reranked.ordered.slice(0, maxResults);
    let expanded: GraphExpansionEntry[] = [];
    if (graphDepth > 0) {
      const graphSeedCandidates = selectGraphSeedsForQuery(visiblePrimaryCandidates, graphDirection, query);
      const graphSeeds: GraphExpansionSeed[] = graphSeedCandidates.map((candidate) => ({
        id: candidate.id,
        metadata: candidate.metadata,
      }));
      expanded = expandGraphContext(database, graphSeeds, {
        branch,
        depth: graphDepth,
        direction: graphDirection,
        allowedChunkIds: metadataAllowedChunkIds,
      });
    }
    const storedChunkTexts = metadataOnly
      ? new Map<string, string>()
      : await this.batchFetchStoredChunkTexts([
          ...visiblePrimaryCandidates.map((candidate) => candidate.metadata.hash),
          ...expanded.map((entry) => entry.metadata.hash),
        ]);
    const primaryResults = await this.materializeRankedResults(
      visiblePrimaryCandidates,
      { metadataOnly, contextLines },
      fileContentCache,
      storedChunkTexts,
      subIntent
    );

    let expandedContext: GraphContextResult[] = [];
    if (expanded.length > 0) {
      expandedContext = await this.materializeExpandedContext(
        expanded,
        { metadataOnly, contextLines },
        fileContentCache,
        storedChunkTexts
      );
    }

    return {
      primaryResults,
      expandedContext,
      taskType,
      subIntent,
      graphDirection,
      timings: {
        prefilterMs: Math.round(prefilterMs * 100) / 100,
      },
      retrieval: {
        voyageLaneConfigured,
        voyageLaneUsed: voyageLaneAvailable,
      },
      reranker: {
        applied: reranked.applied,
        backend: reranked.backend,
      },
    };
  }

  private async keywordSearch(
    query: string,
    limit: number,
    branch?: string | null
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const { database, invertedIndex } = await this.ensureInitialized();
    const scores = branch
      ? invertedIndex.searchOnBranch(query, branch, limit)
      : invertedIndex.search(query, limit);

    if (scores.size === 0) {
      return [];
    }

    const chunkIds = Array.from(scores.keys());
    const metadataMap = new Map(
      database.getChunkMetadataBatch(chunkIds).map((row) => [
        row.chunkId,
        {
          filePath: row.filePath,
          startLine: row.startLine,
          endLine: row.endLine,
          chunkType: (row.nodeType ?? "other") as ChunkType,
          name: row.name,
          language: row.language,
          hash: row.embeddingInputHash,
        } satisfies ChunkMetadata,
      ])
    );

    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    for (const [chunkId, score] of scores) {
      const metadata = metadataMap.get(chunkId);
      if (metadata && score > 0) {
        results.push({ id: chunkId, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getStatus(): Promise<StatusResult> {
    const { configuredProviderInfo, database } = await this.ensureInitialized();
    const vectorCount = this.totalVectorCount();
    const branch = this.getActiveBranchKey(this.currentBranch);
    const branchChunkCount = database.getBranchChunkIds(branch).length;
    const branchSymbolCount = database.getBranchSymbolIds(branch).length;
    const embedding = this.readEmbeddingProgressState(database, branch);
    const chunkCapDrops = database.getChunkCapDropsForBranch(this.currentBranch);
    this.rerankerHealth = this.readPersistedRerankerHealth(database);

    return {
      indexed: branchChunkCount > 0,
      vectorCount,
      provider: configuredProviderInfo.provider,
      model: configuredProviderInfo.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
      compatibility: this.indexCompatibility,
      rerankerHealth: this.rerankerHealth,
      chunkCapSummary: this.summarizeChunkCapDrops(chunkCapDrops),
      foreground: {
        bm25Ready: branchChunkCount > 0,
        callGraphReady: branchChunkCount > 0 && branchSymbolCount >= 0,
      },
      embedding: embedding
        ? {
            status: embedding.status,
            embedded: embedding.embedded,
            total: embedding.total,
            startedAt: embedding.startedAt ?? null,
            updatedAt: embedding.updatedAt ?? null,
            failed: embedding.failed ?? null,
          }
        : null,
    };
  }

  async getCoverageReport(): Promise<IndexCoverageResult> {
    const { database } = await this.ensureInitialized();
    const rows = database.getChunkCapDropsForBranch(this.currentBranch);
    return {
      branch: this.currentBranch,
      truncatedFiles: rows.map((row) => ({
        filePath: row.filePath,
        capLimit: row.capLimit,
        keptChunks: row.keptCount,
        droppedChunks: row.droppedCount,
        droppedNamedSymbols: row.droppedNamed,
        indexedAt: row.indexedAt,
      })),
      totalDroppedChunks: rows.reduce((sum, row) => sum + row.droppedCount, 0),
      totalDroppedNamedSymbols: rows.reduce((sum, row) => sum + row.droppedNamed.length, 0),
    };
  }

  // clearIndex is intentionally a global reset. It is only used by force=true
  // before a rebuild, so it wipes retrieval state, branch catalogs, file-hash
  // caches, failed-batch backlog, Merkle snapshots, and incremental control
  // state across every branch.
  async clearIndex(): Promise<void> {
    return this.runSerializedIndexOperation(() => this.clearIndexInternal());
  }

  private async clearIndexInternal(): Promise<void> {
    const { invertedIndex, database } = await this.ensureInitialized();
    this.startupRetrievalRebuildPending = false;

    await this.runWithCrashMarker(async () => {
      this.clearAllStores();
      this.saveAllStores();
      invertedIndex.clear();
      invertedIndex.save();

      this.clearAllFileHashCaches();
      this.saveFailedBatches([]);
      database.clearAllMerkleSnapshots();
      database.clearAllBranches();
      database.clearAllBranchSymbols();
      database.gcOrphanSymbols();
      database.gcOrphanCallEdges();
      database.gcOrphanChunks();
      database.gcOrphanEmbeddings();
      // Clear control-plane state after the data plane so any mid-reset crash
      // biases toward a fully cold rebuild instead of stale "complete" stages.
      database.clearAllEmbeddingDebt();
      database.clearAllChunkCapDrops();
      database.clearAllPipelineState();
      database.clearAllPipelineRuns();
      database.clearAllConfigVersions();

      // Clear index metadata so compatibility is re-evaluated from scratch.
      database.deleteMetadata("index.version");
      database.deleteMetadata("index.embeddingProvider");
      database.deleteMetadata("index.embeddingModel");
      database.deleteMetadata("index.embeddingDimensions");
      database.deleteMetadata("index.createdAt");
      database.deleteMetadata("index.updatedAt");

      // Re-validate compatibility (no stored metadata = compatible).
      this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo!);
      this.orchestrator.resetStartupState();
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return this.runSerializedIndexOperation(() => this.healthCheckInternal());
  }

  private async healthCheckInternal(
    options: { useCrashMarker?: boolean } = {}
  ): Promise<HealthCheckResult> {
    const { invertedIndex, database } = await this.ensureInitialized();
    const run = async (): Promise<HealthCheckResult> => {
      await this.refreshBranchInfo();
      this.loadFileHashCache();
      this.logger.gc("info", "Starting health check", { branch: this.currentBranch });

      const branchChunkIds = new Set(database.getBranchChunkIds(this.currentBranch));
      const branchSymbolIds = new Set(database.getBranchSymbolIds(this.currentBranch));
      const { existingChunksByFile } = this.buildBranchStoreChunkMaps(branchChunkIds);
      const currentChunkIds = new Set(branchChunkIds);
      const allSymbolIds = new Set(branchSymbolIds);
      const missingFilePaths = new Set<string>();

      for (const filePath of existingChunksByFile.keys()) {
        if (!existsSync(filePath)) {
          missingFilePaths.add(filePath);
        }
      }
      for (const filePath of this.fileHashCache.keys()) {
        if (!existsSync(filePath)) {
          missingFilePaths.add(filePath);
        }
      }

      const removedFilePaths = Array.from(missingFilePaths).sort();
      let removedCount = 0;

      for (const filePath of removedFilePaths) {
        const chunkKeys = existingChunksByFile.get(filePath);
        if (chunkKeys) {
          for (const key of chunkKeys) {
            currentChunkIds.delete(key);
            if (this.removeChunkFromRetrievalIfUnreferenced(database, invertedIndex, key)) {
              removedCount++;
            }
          }
        }

        const fileSymbols = database
          .getSymbolsByFile(filePath)
          .filter((symbol) => branchSymbolIds.has(symbol.id));
        for (const symbol of fileSymbols) {
          allSymbolIds.delete(symbol.id);
          this.removeSymbolFromGraphIfUnreferenced(database, symbol.id);
        }

        database.clearChunkCapDrop(this.currentBranch, filePath);
      }

      if (removedFilePaths.length > 0) {
        database.clearBranch(this.currentBranch);
        database.addChunksToBranchBatch(this.currentBranch, Array.from(currentChunkIds));
        this.syncNativeBranchMembership(this.currentBranch, Array.from(currentChunkIds));
        database.clearBranchSymbols(this.currentBranch);
        database.addSymbolsToBranchBatch(this.currentBranch, Array.from(allSymbolIds));
        this.commitFileHashChanges(new Map<string, string>(), removedFilePaths);

        // healthCheck performs out-of-band cleanup, so invalidate the current
        // branch snapshot instead of trying to patch it incrementally.
        database.deleteMerkleSnapshot(this.currentBranch);
      }

      if (removedCount > 0) {
        this.saveAllStores();
        invertedIndex.save();
      }

      const gcOrphanEmbeddings = database.gcOrphanEmbeddings();
      const gcOrphanChunks = database.gcOrphanChunks();
      const gcOrphanSymbols = database.gcOrphanSymbols();
      const gcOrphanCallEdges = database.gcOrphanCallEdges();

      this.logger.recordGc(removedCount, gcOrphanChunks, gcOrphanEmbeddings);
      this.logger.gc("info", "Health check complete", {
        branch: this.currentBranch,
        removedStale: removedCount,
        orphanEmbeddings: gcOrphanEmbeddings,
        orphanChunks: gcOrphanChunks,
        removedFiles: removedFilePaths.length,
        invalidatedMerkleSnapshot: removedFilePaths.length > 0,
      });

      return {
        removed: removedCount,
        filePaths: removedFilePaths,
        gcOrphanEmbeddings,
        gcOrphanChunks,
        gcOrphanSymbols,
        gcOrphanCallEdges,
      };
    };

    if (options.useCrashMarker === false) {
      return run();
    }
    return this.runWithCrashMarker(run);
  }

  getFailedBatchesCount(): number {
    return this.loadFailedBatches().length;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  getBaseBranch(): string {
    return this.baseBranch;
  }

  async refreshBranchInfo(): Promise<void> {
    if (!isGitRepo(this.projectRoot)) {
      this.baseBranch = "default";
      return;
    }

    const detectedBranch = this.getActiveBranchKey(getBranchOrDefault(this.projectRoot));
    this.updateBaseBranch(detectedBranch);
    if (detectedBranch === this.currentBranch) {
      return;
    }

    await this.setCurrentBranch(detectedBranch);
  }

  async getDatabaseStats(): Promise<{ embeddingCount: number; chunkCount: number; branchChunkCount: number; branchCount: number } | null> {
    const { database } = await this.ensureInitialized();
    return database.getStats();
  }

  getLogger(): Logger {
    return this.logger;
  }

  private resolveStoredFilePath(filePath: string): string {
    return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(this.projectRoot, filePath);
  }

  private toRelativeProjectPath(filePath: string): string {
    const absolutePath = this.resolveStoredFilePath(filePath);
    const relativePath = path.relative(this.projectRoot, absolutePath).replace(/\\/g, "/");
    if (
      relativePath.length > 0 &&
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath;
    }

    return filePath.replace(/\\/g, "/");
  }

  private buildFileUri(filePath: string): string {
    return pathToFileURL(this.resolveStoredFilePath(filePath)).toString();
  }

  private matchesRequestedFilePath(candidatePath: string, requestedPath: string): boolean {
    const normalizedRequested = requestedPath.replace(/\\/g, "/");
    const requestedAbsolute = path.resolve(this.projectRoot, requestedPath);
    const candidateAbsolute = this.resolveStoredFilePath(candidatePath);
    const candidateRelative = this.toRelativeProjectPath(candidatePath);

    return (
      candidateAbsolute === path.normalize(requestedAbsolute) ||
      candidateRelative === normalizedRequested ||
      candidatePath.replace(/\\/g, "/") === normalizedRequested
    );
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset), "utf8").toString("base64");
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) {
      return 0;
    }

    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const parsed = Number.parseInt(decoded, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private async resolveStructuralSymbols(
    symbol: string,
    filePath?: string
  ): Promise<SymbolData[]> {
    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;

    const filterMatches = (symbols: SymbolData[]): SymbolData[] => {
      if (!filePath) {
        return symbols;
      }
      return symbols.filter((candidate) => this.matchesRequestedFilePath(candidate.filePath, filePath));
    };

    const exactMatches = filterMatches(database.getSymbolsByNameOnBranch(symbol, branch));
    if (exactMatches.length > 0) {
      return exactMatches;
    }

    return filterMatches(database.getSymbolsByNameCiOnBranch(symbol, branch));
  }

  private async getChunkDetailsForSymbols(
    symbolIds: string[]
  ): Promise<Map<string, { chunkKind: "code" | "test" | "doc" | "config" | null; signature: string | null }>> {
    const details = new Map<string, { chunkKind: "code" | "test" | "doc" | "config" | null; signature: string | null }>();
    if (symbolIds.length === 0) {
      return details;
    }

    const { database } = await this.ensureInitialized();
    const rows = database.getChunksForSymbolsBatch(symbolIds, this.currentBranch);
    const embeddingHashes = [...new Set(rows.map((row) => row.embeddingInputHash))];
    const chunkTextByHash = database.getChunkTextsBatch(embeddingHashes);

    for (const row of rows) {
      details.set(row.symbolId, {
        chunkKind: normalizeStoredChunkKind(row.chunkKind),
        signature: extractStoredChunkSignature(chunkTextByHash.get(row.embeddingInputHash) ?? null),
      });
    }

    return details;
  }

  private async getStructuralSymbolsForFile(filePath: string): Promise<SymbolData[]> {
    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;
    const requestedCandidates = [
      this.resolveStoredFilePath(filePath),
      filePath.replace(/\\/g, "/"),
    ];
    const seen = new Set<string>();
    const matches: SymbolData[] = [];

    for (const candidatePath of requestedCandidates) {
      if (seen.has(candidatePath)) {
        continue;
      }
      seen.add(candidatePath);
      for (const symbol of database.getSymbolsByFileOnBranch(candidatePath, branch)) {
        if (matches.some((existing) => existing.id === symbol.id)) {
          continue;
        }
        matches.push(symbol);
      }
    }

    return matches.filter((symbol) => this.matchesRequestedFilePath(symbol.filePath, filePath));
  }

  private async collectStructuralCallersFromMatches(matches: SymbolData[]): Promise<StructuralCallerEntry[]> {
    if (matches.length === 0) {
      return [];
    }

    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;
    const callers = (
      await Promise.all(
        matches.map((match) => Promise.resolve(database.getCallersWithContextByTargetSymbolId(match.id, branch)))
      )
    ).flat();

    const callerSymbolIds = [...new Set(callers.map((caller) => caller.fromSymbolId))];
    const chunkDetails = await this.getChunkDetailsForSymbols(callerSymbolIds);

    return Array.from(
      new Map(
        callers.map((caller) => {
          const callerPath = caller.fromSymbolFilePath ?? caller.callerFilePath;
          const inferredChunkKind = chunkDetails.get(caller.fromSymbolId)?.chunkKind ?? null;
          const chunkKind =
            inferredChunkKind === "test" || looksLikeTestFilePath(callerPath)
              ? "test"
              : inferredChunkKind ?? "code";
          return [
            `${caller.id}:${caller.fromSymbolId}:${caller.line}:${caller.col}`,
            {
              symbolName: caller.fromSymbolName ?? "<unknown>",
              fileUri: this.buildFileUri(callerPath ?? this.projectRoot),
              relativePath: this.toRelativeProjectPath(callerPath ?? this.projectRoot),
              line: caller.line,
              chunkKind,
            } satisfies StructuralCallerEntry,
          ];
        })
      ).values()
    );
  }

  private async getStructuralTestsByCallGraph(matches: SymbolData[]): Promise<StructuralTestEntry[]> {
    const callers = await this.collectStructuralCallersFromMatches(matches);
    return callers
      .filter((caller) => caller.chunkKind === "test")
      .map((caller) => ({
        testName: caller.symbolName,
        fileUri: caller.fileUri,
        relativePath: caller.relativePath,
        line: caller.line,
        confidence: 0.95,
        method: "call_graph",
      }));
  }

  private async getStructuralTestsByNameConvention(symbol: string): Promise<StructuralTestEntry[]> {
    const base = symbol.trim();
    if (base.length === 0) {
      return [];
    }

    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;
    const variants = [
      `test_${base}`,
      `test${base}`,
      `${base}_test`,
      `${base}Test`,
      `${base}Spec`,
    ];
    const seenNames = new Set<string>();
    const matches: SymbolData[] = [];

    for (const variant of variants) {
      const normalized = variant.toLowerCase();
      if (seenNames.has(normalized)) {
        continue;
      }
      seenNames.add(normalized);
      matches.push(...database.getSymbolsByNameCiOnBranch(variant, branch));
    }

    const uniqueMatches = Array.from(new Map(matches.map((match) => [match.id, match])).values());
    const chunkDetails = await this.getChunkDetailsForSymbols(uniqueMatches.map((match) => match.id));

    return uniqueMatches
      .filter((match) => {
        const chunkKind = chunkDetails.get(match.id)?.chunkKind ?? null;
        return chunkKind === "test" || looksLikeTestFilePath(match.filePath);
      })
      .map((match) => ({
        testName: match.name,
        fileUri: this.buildFileUri(match.filePath),
        relativePath: this.toRelativeProjectPath(match.filePath),
        line: match.startLine,
        confidence: 0.7,
        method: "name_convention" as const,
      }));
  }

  private async getStructuralTestsByFileConvention(filePath: string): Promise<StructuralTestEntry[]> {
    const requestedRelative = this.toRelativeProjectPath(filePath);
    const normalizedRelative = requestedRelative.replace(/\\/g, "/");
    const extension = path.extname(normalizedRelative);
    const baseWithoutExtension = extension.length > 0
      ? normalizedRelative.slice(0, -extension.length)
      : normalizedRelative;
    const fileCandidates =
      extension === ".rs"
        ? [normalizedRelative]
        : [
            `${baseWithoutExtension}.test${extension}`,
            `${baseWithoutExtension}.spec${extension}`,
            `${baseWithoutExtension}_test${extension}`,
            extension === ".py" ? `${path.posix.dirname(baseWithoutExtension) === "." ? "" : `${path.posix.dirname(baseWithoutExtension)}/`}test_${path.posix.basename(baseWithoutExtension)}${extension}` : null,
          ].filter((candidate): candidate is string => Boolean(candidate));

    const symbols = (
      await Promise.all(fileCandidates.map((candidate) => this.getStructuralSymbolsForFile(candidate)))
    ).flat();
    const uniqueSymbols = Array.from(new Map(symbols.map((symbol) => [symbol.id, symbol])).values());
    const chunkDetails = await this.getChunkDetailsForSymbols(uniqueSymbols.map((symbol) => symbol.id));

    return uniqueSymbols
      .filter((symbol) => {
        const chunkKind = chunkDetails.get(symbol.id)?.chunkKind ?? null;
        return chunkKind === "test" || looksLikeTestFilePath(symbol.filePath);
      })
      .map((symbol) => ({
        testName: symbol.name,
        fileUri: this.buildFileUri(symbol.filePath),
        relativePath: this.toRelativeProjectPath(symbol.filePath),
        line: symbol.startLine,
        confidence: 0.5,
        method: "file_convention" as const,
      }));
  }

  private buildStructuralCallChainEntry(symbol: SymbolData): StructuralCallChainEntry {
    return {
      symbolName: symbol.name,
      fileUri: this.buildFileUri(symbol.filePath),
      relativePath: this.toRelativeProjectPath(symbol.filePath),
      line: symbol.startLine,
    };
  }

  async getSymbolInfo(
    symbol: string,
    filePath?: string
  ): Promise<StructuralSymbolInfoResult> {
    const matches = await this.resolveStructuralSymbols(symbol, filePath);
    const chunkDetails = await this.getChunkDetailsForSymbols(matches.map((match) => match.id));

    return {
      symbols: matches.map((match) => {
        const details = chunkDetails.get(match.id);
        return {
          symbolId: match.id,
          name: match.name,
          kind: normalizeStructuralSymbolKind(match.kind),
          fileUri: this.buildFileUri(match.filePath),
          relativePath: this.toRelativeProjectPath(match.filePath),
          startLine: match.startLine,
          endLine: match.endLine,
          signature: details?.signature ?? null,
          chunkKind: details?.chunkKind ?? null,
        };
      }),
      total: matches.length,
      ambiguous: !filePath && matches.length > 1,
    };
  }

  async getStructuralCallers(options: {
    symbol: string;
    filePath?: string;
    includeTests?: boolean;
    maxResults?: number;
    cursor?: string;
  }): Promise<StructuralCallersResult> {
    const includeTests = options.includeTests ?? true;
    const maxResults = Math.min(Math.max(options.maxResults ?? 20, 1), 100);
    const offset = this.decodeCursor(options.cursor);
    const matches = await this.resolveStructuralSymbols(options.symbol, options.filePath);
    if (matches.length === 0) {
      return { callers: [], total: 0, cursor: null, resolved: true };
    }

    const merged = (await this.collectStructuralCallersFromMatches(matches))
      .filter((caller) => includeTests || caller.chunkKind !== "test")
      .sort((left, right) => {
        if (left.relativePath !== right.relativePath) {
          return left.relativePath.localeCompare(right.relativePath);
        }
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.symbolName.localeCompare(right.symbolName);
      });

    const page = merged.slice(offset, offset + maxResults);
    const nextOffset = offset + page.length;

    return {
      callers: page,
      total: merged.length,
      cursor: nextOffset < merged.length ? this.encodeCursor(nextOffset) : null,
      resolved: Boolean(options.filePath) || matches.length <= 1,
    };
  }

  async getStructuralCallees(options: {
    symbol: string;
    filePath?: string;
    maxResults?: number;
  }): Promise<StructuralCalleesResult> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 20, 1), 100);
    const matches = await this.resolveStructuralSymbols(options.symbol, options.filePath);
    if (matches.length === 0) {
      return { callees: [], total: 0, resolved: true };
    }

    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;
    const callees = (
      await Promise.all(matches.map((match) => Promise.resolve(database.getCallees(match.id, branch))))
    ).flat();

    const targetSymbolIds = [...new Set(callees.flatMap((callee) => (callee.toSymbolId ? [callee.toSymbolId] : [])))];
    const targetSymbols = new Map(
      database
        .getSymbolsByIdsOnBranch(targetSymbolIds, branch)
        .map((symbol): [string, SymbolData] => [symbol.id, symbol])
    );

    const merged = Array.from(
      new Map(
        callees.map((callee) => {
          const targetSymbol = callee.toSymbolId ? targetSymbols.get(callee.toSymbolId) : undefined;
          const effectiveFilePath = targetSymbol?.filePath ?? callee.targetFilePath ?? null;
          return [
            `${callee.id}:${callee.fromSymbolId}:${callee.targetName}:${callee.line}:${callee.col}`,
            {
              symbolName: targetSymbol?.name ?? callee.targetName,
              fileUri: effectiveFilePath ? this.buildFileUri(effectiveFilePath) : null,
              relativePath: effectiveFilePath ? this.toRelativeProjectPath(effectiveFilePath) : null,
              line: targetSymbol?.startLine ?? null,
              resolved: Boolean(callee.toSymbolId),
            } satisfies StructuralCalleeEntry,
          ];
        })
      ).values()
    ).sort((left, right) => {
      if (left.resolved !== right.resolved) {
        return Number(right.resolved) - Number(left.resolved);
      }
      if ((left.relativePath ?? "") !== (right.relativePath ?? "")) {
        return (left.relativePath ?? "").localeCompare(right.relativePath ?? "");
      }
      if ((left.line ?? Number.MAX_SAFE_INTEGER) !== (right.line ?? Number.MAX_SAFE_INTEGER)) {
        return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
      }
      return left.symbolName.localeCompare(right.symbolName);
    });

    return {
      callees: merged.slice(0, maxResults),
      total: merged.length,
      resolved: Boolean(options.filePath) || matches.length <= 1,
    };
  }

  async getStructuralCallChain(options: {
    fromSymbol: string;
    toSymbol: string;
    fromFile?: string;
    toFile?: string;
    maxDepth?: number;
  }): Promise<StructuralCallChainResult> {
    const maxDepth = Math.min(Math.max(options.maxDepth ?? 8, 1), 15);
    const fromMatches = await this.resolveStructuralSymbols(options.fromSymbol, options.fromFile);
    const toMatches = await this.resolveStructuralSymbols(options.toSymbol, options.toFile);
    if (fromMatches.length === 0 || toMatches.length === 0) {
      return {
        found: false,
        path: [],
        depth: 0,
        searchDepthReached: false,
        warning: null,
      };
    }

    const warnings: string[] = [];
    if (!options.fromFile && fromMatches.length > 1) {
      warnings.push(`from_symbol '${options.fromSymbol}' was ambiguous; used the first match.`);
    }
    if (!options.toFile && toMatches.length > 1) {
      warnings.push(`to_symbol '${options.toSymbol}' was ambiguous; used the first match.`);
    }

    const source = fromMatches[0]!;
    const target = toMatches[0]!;
    if (source.id === target.id) {
      return {
        found: true,
        path: [this.buildStructuralCallChainEntry(source)],
        depth: 0,
        searchDepthReached: false,
        warning: warnings.length > 0 ? warnings.join(" ") : null,
      };
    }

    const { database } = await this.ensureInitialized();
    const branch = this.currentBranch;
    const parentBySymbolId = new Map<string, string | null>([[source.id, null]]);
    const symbolsById = new Map<string, SymbolData>([
      [source.id, source],
      [target.id, target],
    ]);
    const visited = new Set<string>([source.id]);
    let frontier = [source.id];
    let found = false;
    let searchDepthReached = false;

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      if (frontier.length > 500) {
        warnings.push("Call-chain search stopped early because graph fan-out exceeded 500 symbols.");
        searchDepthReached = true;
        break;
      }

      const edgeBatch = database.getCallEdgeFrontierBatch(frontier, branch);
      const candidateIds = Array.from(
        new Set(
          edgeBatch.callees
            .flatMap((edge) => edge.toSymbolId ? [edge.toSymbolId] : [])
            .filter((symbolId) => !visited.has(symbolId))
        )
      );
      if (candidateIds.length === 0) {
        frontier = [];
        break;
      }

      if (candidateIds.length > 500) {
        warnings.push("Call-chain search stopped early because graph fan-out exceeded 500 symbols.");
        searchDepthReached = true;
        break;
      }

      const fetchedSymbols = database.getSymbolsByIdsOnBranch(candidateIds, branch);
      const fetchedById = new Map(fetchedSymbols.map((symbol): [string, SymbolData] => [symbol.id, symbol]));
      const nextFrontier: string[] = [];

      for (const edge of edgeBatch.callees) {
        const childId = edge.toSymbolId;
        if (!childId || visited.has(childId)) {
          continue;
        }
        const childSymbol = fetchedById.get(childId);
        if (!childSymbol) {
          continue;
        }
        visited.add(childId);
        parentBySymbolId.set(childId, edge.fromSymbolId);
        symbolsById.set(childId, childSymbol);
        nextFrontier.push(childId);
        if (childId === target.id) {
          found = true;
          break;
        }
      }

      frontier = Array.from(new Set(nextFrontier));
      if (found) {
        break;
      }
    }

    if (!found) {
      if (frontier.length > 0) {
        searchDepthReached = true;
      }
      return {
        found: false,
        path: [],
        depth: 0,
        searchDepthReached,
        warning: warnings.length > 0 ? warnings.join(" ") : null,
      };
    }

    const pathIds: string[] = [];
    let cursor: string | null | undefined = target.id;
    while (cursor) {
      pathIds.push(cursor);
      cursor = parentBySymbolId.get(cursor) ?? null;
    }
    pathIds.reverse();

    return {
      found: true,
      path: pathIds
        .map((symbolId) => symbolsById.get(symbolId))
        .filter((symbol): symbol is SymbolData => Boolean(symbol))
        .map((symbol) => this.buildStructuralCallChainEntry(symbol)),
      depth: Math.max(0, pathIds.length - 1),
      searchDepthReached: false,
      warning: warnings.length > 0 ? warnings.join(" ") : null,
    };
  }

  async getStructuralTests(options: {
    symbol?: string;
    filePath?: string;
  }): Promise<StructuralTestsResult> {
    let symbolResolved = true;
    let targetSymbols: SymbolData[] = [];

    if (options.symbol) {
      targetSymbols = await this.resolveStructuralSymbols(options.symbol, options.filePath);
      symbolResolved = Boolean(options.filePath) || targetSymbols.length <= 1;
    } else if (options.filePath) {
      targetSymbols = await this.getStructuralSymbolsForFile(options.filePath);
    }

    const callGraphTests = targetSymbols.length > 0
      ? await this.getStructuralTestsByCallGraph(targetSymbols)
      : [];
    const nameConventionTests = options.symbol
      ? await this.getStructuralTestsByNameConvention(options.symbol)
      : [];
    const fileConventionTests = options.filePath
      ? await this.getStructuralTestsByFileConvention(options.filePath)
      : [];

    const deduped = new Map<string, StructuralTestEntry>();
    for (const entry of [...callGraphTests, ...nameConventionTests, ...fileConventionTests]) {
      const key = `${entry.testName}:${entry.fileUri}`;
      const existing = deduped.get(key);
      if (!existing || entry.confidence > existing.confidence) {
        deduped.set(key, entry);
      }
    }

    const tests = Array.from(deduped.values()).sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (left.relativePath !== right.relativePath) {
        return left.relativePath.localeCompare(right.relativePath);
      }
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.testName.localeCompare(right.testName);
    });

    return {
      tests,
      total: tests.length,
      symbolResolved,
    };
  }

  async findSimilar(
    code: string,
    limit: number = this.config.search.maxResults,
    options?: {
      fileType?: string;
      directory?: string;
      chunkType?: string;
      excludeFile?: string;
      filterByBranch?: boolean;
    }
  ): Promise<SearchResult[]> {
    const branch = this.currentBranch;
    const { store, provider, database } = await this.ensureInitialized();
    
    const compatibility = this.checkCompatibility();
    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if (store.count() === 0) {
      this.logger.search("debug", "Find similar on empty index");
      return [];
    }

    const filterByBranch = options?.filterByBranch ?? true;
    const prefilterStartTime = performance.now();
    const metadataAllowedChunkIds = await this.buildAllowedChunkIds(database, branch, {
      fileType: options?.fileType,
      directory: options?.directory,
      chunkType: options?.chunkType,
      excludeFile: options?.excludeFile,
    });
    const prefilterMs = performance.now() - prefilterStartTime;

    if (metadataAllowedChunkIds && metadataAllowedChunkIds.size === 0) {
      this.logger.search("debug", "Find similar has no candidates after hard filtering", {
      });
      return [];
    }

    const branchFilter = filterByBranch ? this.getActiveBranchKey() : null;
    const retrievalLimit = resolveRetrievalCandidateLimit(limit);
    const laneRetrievalLimit = metadataAllowedChunkIds
      ? Math.max(retrievalLimit * 5, 100)
      : retrievalLimit;

    this.logger.search("debug", "Starting find similar", {
      codeLength: code.length,
      limit,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const { embedding, tokensUsed } = await provider.embedDocument(code);
    const embeddingMs = performance.now() - embeddingStartTime;
    this.logger.recordEmbeddingApiCall(tokensUsed);

    // TODO: Component 4 — add a Voyage retrieval lane for code-heavy similarity search.
    const vectorStartTime = performance.now();
    const semanticCandidates = this.filterCandidatesByChunkIds(
      branchFilter
        ? store.searchOnBranch(embedding, branchFilter, laneRetrievalLimit)
        : store.search(embedding, laneRetrievalLimit),
      metadataAllowedChunkIds
    );
    const vectorMs = performance.now() - vectorStartTime;

    const rerankTopN = this.config.search.rerankTopN;

    const ranked = rankSemanticOnlyResults(code, semanticCandidates, {
      rerankTopN,
      limit,
      prioritizeSourcePaths: false,
    });

    const filtered = ranked
      .filter((r) => r.score >= this.config.search.minScore)
      .slice(0, limit);

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs: 0,
      fusionMs: 0,
    });
    this.logger.search("info", "Find similar complete", {
      codeLength: code.length,
      results: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
    });

    return Promise.all(
      filtered.map(async (r) => {
        let content = "";

        if (this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            content = lines
              .slice(r.metadata.startLine - 1, r.metadata.endLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: r.metadata.startLine,
          endLine: r.metadata.endLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
        };
      })
    );
  }

  private async buildAllowedChunkIds(
    database: Database,
    branch: string,
    options: HardRetrievalFilters
  ): Promise<Set<string> | null> {
    const hasMetadataFilters = Boolean(
      options.fileType ||
      options.directory ||
      options.chunkType ||
      options.excludeFile ||
      options.chunkKind ||
      options.language ||
      options.pathGlob
    );

    if (!hasMetadataFilters) {
      this.logger.search("debug", "Skipping hard-filter candidate prefetch because no metadata filters are active", {
        branch,
      });
      return null;
    }

    return new Set(
      await database.getChunkIdsByFiltersForBranch(
        branch,
        options.fileType ?? null,
        options.directory ?? null,
        options.chunkType ?? null,
        options.excludeFile ?? null,
        normalizeRequestedChunkKind(options.chunkKind) ?? null,
        options.language ?? null,
        options.pathGlob ?? null
      )
    );
  }

  private filterCandidatesByChunkIds<T extends { id: string }>(
    candidates: T[],
    allowedChunkIds: Set<string> | null
  ): T[] {
    if (!allowedChunkIds) {
      return candidates;
    }

    return candidates.filter((candidate) => allowedChunkIds.has(candidate.id));
  }

  async getCallers(targetName: string): Promise<CallEdgeData[]> {
    const { database } = await this.ensureInitialized();
    return database.getCallersWithContext(targetName, this.currentBranch);
  }

  async getCallees(symbolId: string): Promise<CallEdgeData[]> {
    const { database } = await this.ensureInitialized();
    return database.getCallees(symbolId, this.currentBranch);
  }
}
