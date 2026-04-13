import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

import { ParsedCodebaseIndexConfig } from "../config/schema.js";
import { detectEmbeddingProvider, ConfiguredProviderInfo, tryDetectProvider, createCustomProviderInfo } from "../embeddings/detector.js";
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
import { SearchReranker, type RerankerCandidate } from "./reranker.js";
import { ensureWatcherEventTimestamp } from "./watcher-tti.js";
import {
  getSearchRecipe,
  type SearchPathPreference,
  type SearchTaskType,
} from "./search-recipes.js";
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
} from "../native/index.js";
import type { SymbolData, CallEdgeData, ChunkKind, ChunkSymbolKind } from "../native/index.js";
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
  chunkType: string;
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  name?: string;
  relation?: "caller" | "callee";
  depth?: number;
  viaSymbol?: string;
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
  graphDirection: GraphExpansionDirection;
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
  contextLines?: number;
  filterByBranch?: boolean;
  metadataOnly?: boolean;
  definitionIntent?: boolean;
  taskType?: SearchTaskType;
  graphDepth?: number;
  graphDirection?: GraphExpansionDirection;
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

type RankedCandidate = {
  id: string;
  score: number;
  metadata: RetrievalChunkMetadata;
  relation?: "caller" | "callee";
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  reranked?: boolean;
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

interface SemanticRankOptions {
  rerankTopN: number;
  limit: number;
  pathPreference?: SearchPathPreference;
  prioritizeSourcePaths?: boolean;
}

interface HardRetrievalFilters {
  fileType?: string;
  directory?: string;
  chunkType?: string;
  excludeFile?: string;
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
  "benchmark",
  "readme",
  "architecture",
  "docs/",
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

function chunkTypeBoost(chunkType: string): number {
  switch (chunkType) {
    case "function":
    case "function_declaration":
    case "method":
    case "method_definition":
    case "class":
    case "class_declaration":
      return 0.2;
    case "interface":
    case "type":
    case "enum":
    case "struct":
    case "impl":
    case "trait":
    case "module":
    case "constant":
      return 0.1;
    default:
      return 0;
  }
}

function resolveRetrievalCandidateLimit(limit: number): number {
  return Math.max(DEFAULT_RETRIEVAL_CANDIDATE_K, limit * 4);
}

function normalizeDirectoryFilter(directory: string): string {
  return directory.replace(/^\/|\/$/g, "");
}

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
        best = Math.max(best, 1);
      } else if (nameLower.includes(variant)) {
        best = Math.max(best, 0.8);
      } else if (pathLower.includes(variant)) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
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
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
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

  return deterministic.map((entry) => ({
    id: entry.candidate.id,
    score: entry.pathMatchesFileHint && entry.nameMatchesPrimary
      ? 0.995
      : Math.min(1, 0.9 + entry.maxMatch * 0.09),
    metadata: entry.candidate.metadata,
  }));
}

export function fuseResultsWeighted(
  lanes: FusionLane[],
  limit: number
): RankedCandidate[] {
  const fusedScores = new Map<string, { score: number; metadata: RetrievalChunkMetadata }>();

  for (const lane of lanes) {
    if (lane.weight <= 0 || lane.results.length === 0) {
      continue;
    }

    for (const result of lane.results) {
      const existing = fusedScores.get(result.id);
      if (existing) {
        existing.score += result.score * lane.weight;
      } else {
        fusedScores.set(result.id, {
          score: result.score * lane.weight,
          metadata: result.metadata,
        });
      }
    }
  }

  const results = Array.from(fusedScores.entries()).map(([id, data]) => ({
    id,
    score: data.score,
    metadata: data.metadata,
  }));

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, limit);
}

export function fuseResultsRrf(
  lanes: FusionLane[],
  rrfK: number,
  limit: number
): RankedCandidate[] {
  const activeLanes = lanes.filter((lane) => lane.weight > 0 && lane.results.length > 0);
  if (activeLanes.length === 0) {
    return [];
  }

  const maxPossibleRaw = activeLanes.reduce((sum, lane) => sum + lane.weight, 0) / (rrfK + 1);
  const metadataById = new Map<string, RetrievalChunkMetadata>();
  const allIds = new Set<string>();
  const rankMaps = activeLanes.map((lane) => {
    const rankById = new Map<string, number>();
    lane.results.forEach((result, index) => {
      rankById.set(result.id, index + 1);
      allIds.add(result.id);
      if (!metadataById.has(result.id)) {
        metadataById.set(result.id, result.metadata);
      }
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
    });
  }

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused.slice(0, limit);
}

export function rerankResults(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { pathPreference?: SearchPathPreference }
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

    const implementationPathBoost = preferSourcePaths && isLikelyImplementationPath(candidate.metadata.filePath) ? 0.08 : 0;
    const isReadmePath = candidate.metadata.filePath.toLowerCase().includes("readme");
    const testDocPenalty = preferSourcePaths && likelyTestOrDoc ? 0.12 : 0;
    const testPathBoost = preferTestPaths && likelyTestOrDoc ? 0.16 : 0;
    const readmeDocBoost = !preferSourcePaths && isReadmePath ? 0.08 : 0;
    const identifierBoost = hasIdentifierMatch ? 0.12 : 0;
    const tokenCoverage = queryTokenList.length > 0
      ? (exactOrPrefixNameHits + pathOverlap + chunkTypeHits) / queryTokenList.length
      : 0;
    const coverageBoost = Math.min(0.12, tokenCoverage * 0.06);

    const deterministicBoost =
      exactOrPrefixNameHits * 0.08 +
      pathOverlap * 0.03 +
      chunkTypeHits * 0.02 +
      coverageBoost +
      identifierBoost +
      implementationPathBoost -
      testDocPenalty +
      testPathBoost +
      readmeDocBoost +
      chunkTypeBoost(candidate.metadata.chunkType);

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

  head.sort((a, b) => {
    if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  if (preferSourcePaths) {
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
    ? fuseResultsRrf(lanes, options.rrfK, overfetchLimit)
    : fuseResultsWeighted(lanes, overfetchLimit);

  const rerankPoolLimit = Math.max(overfetchLimit, options.rerankTopN * 3, options.limit * 6);
  const rerankPool = fused.slice(0, rerankPoolLimit);
  const defaultPathPreference = (options.prioritizeSourcePaths ?? (classifyQueryIntentRaw(query) === "source"))
    ? "source"
    : "auto";
  return rerankResults(query, rerankPool, options.rerankTopN, {
    pathPreference: options.pathPreference ?? defaultPathPreference,
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
  identifierBoost: number = 1
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

          const baselineScore = existing?.score ?? 0.5;
          candidateUnion.set(chunk.chunkId, {
            id: chunk.chunkId,
            score: Math.min(1, baselineScore + 0.5 * Math.max(0, identifierBoost)),
            metadata,
            chunkKind: (chunk.chunkKind as ChunkKind | undefined) ?? existing?.chunkKind ?? metadata.chunkKind,
            symbolKind: (chunk.symbolKind as ChunkSymbolKind | undefined) ?? existing?.symbolKind ?? metadata.symbolKind,
          });
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
    const rescueBoost = (exactIdentifierMatch ? 0.45 : 0.25) * Math.max(0, identifierBoost);
    const boostedScore = Math.min(1, Math.max(existing.score, candidate.score) + rescueBoost);
    promoted.push({
      id: existing.id,
      score: boostedScore,
      metadata: existing.metadata,
      chunkKind: existing.chunkKind ?? candidate.chunkKind ?? existing.metadata.chunkKind,
      symbolKind: existing.symbolKind ?? candidate.symbolKind ?? existing.metadata.symbolKind,
    });
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
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
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
    const base = baseScore ?? (exactName ? 0.99 : 0.88);

    const existing = symbolCandidates.get(chunk.chunkId);
    if (!existing || base > existing.score) {
      symbolCandidates.set(chunk.chunkId, {
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
      });
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
        ? Math.min(1, Math.max(candidate.score, 0.97))
        : Math.min(0.95, Math.max(candidate.score, 0.82 + tokenHits * 0.03));
      symbolCandidates.set(candidate.id, {
        id: candidate.id,
        score: laneScore,
        metadata: candidate.metadata,
      });
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
        symbolCandidates.set(entry.candidate.id, {
          id: entry.candidate.id,
          score: Math.min(0.94, Math.max(entry.candidate.score, 0.8 + entry.overlapScore * 0.1)),
          metadata: entry.candidate.metadata,
        });
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
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
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

  return scored.map((entry) => ({
    id: entry.candidate.id,
    score: Math.min(1, 0.9 + entry.matchScore * 0.09),
    metadata: entry.candidate.metadata,
  }));
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
      if (!existing || candidate.score > existing.score) {
        byId.set(candidate.id, candidate);
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
  private voyageProvider: VoyageEmbeddingProvider | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
  private primaryStoreModelId: string | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCacheDir: string = "";
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";
  private logger!: Logger;
  private queryEmbeddingCache: Map<string, QueryEmbeddingCacheEntry> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;
  private indexCompatibility: IndexCompatibility | null = null;
  private indexingLockPath: string = "";
  private indexingQueue: Promise<void> = Promise.resolve();
  private recoveredFromInterruptedIndexing = false;
  private startupRetrievalRebuildPending = false;
  private orchestrator!: IncrementalIndexOrchestrator;
  private readonly searchReranker = new SearchReranker();

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
    this.orchestrator = new IncrementalIndexOrchestrator({
      logger: this.logger,
      getConfig: () => this.config,
      getProjectRoot: () => this.projectRoot,
      getIndexPath: () => this.indexPath,
      getCurrentBranch: () => this.currentBranch,
      setCurrentBranch: (branch) => {
        this.loadNativeBranchMembership(branch);
        this.publishCurrentBranch(branch);
      },
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
      .filter(([_modelId, store]) => store.count() === 0)
      .map(([modelId, store]) => ({ modelId, count: store.count() }));
    const bm25Count = this.invertedIndex?.getDocumentCount() ?? 0;
    const bm25Mismatch = bm25Count === 0;

    if (
      loadState.recoveredModelIds.length === 0 &&
      !loadState.bm25Recovered &&
      mismatchedStores.length === 0 &&
      !bm25Mismatch
    ) {
      return;
    }

    this.logger.warn(
      "Retrieval startup integrity check failed: retrieval artifacts are empty or recovered while the database still has indexed chunks. A full rebuild is required before search results are reliable.",
      {
      branch,
      branchChunkCount,
      recoveredModelIds: loadState.recoveredModelIds,
      bm25Recovered: loadState.bm25Recovered,
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

  private getActiveVoyageModelId(): string | null {
    return this.voyageProvider?.getModelInfo().model ?? null;
  }

  private syncVoyageRuntime(): void {
    const voyageApiKey = this.config.voyageApiKey?.trim();
    if (!voyageApiKey) {
      this.voyageProvider = null;
      return;
    }

    const requestedModelId = this.config.voyageModelId?.trim() || "voyage-code-2";
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
    } else if (this.config.embeddingProvider === 'auto') {
      this.configuredProviderInfo = await tryDetectProvider();
    } else {
      this.configuredProviderInfo = await detectEmbeddingProvider(this.config.embeddingProvider, this.config.embeddingModel);
    }

    if (!this.configuredProviderInfo) {
      throw new Error(
        "No embedding provider available. Configure GitHub Copilot, OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint."
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

    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
      this.logger.branch("info", "Detected git repository", {
        currentBranch: this.currentBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }

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
    this.loadNativeBranchMembership(this.currentBranch);

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
    voyageProvider: VoyageEmbeddingProvider | null;
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
        const existing = symbolsByName.get(symbol.name) ?? [];
        existing.push(symbol);
        symbolsByName.set(symbol.name, existing);
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
      this.refreshBranchInfo();

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

  private getQueryEmbeddingCacheKey(modelId: string, query: string): string {
    return `${modelId}\u0000${query}`;
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
    const result = await provider.embedQuery(query);
    if (!result) {
      return null;
    }
    const { embedding, tokensUsed } = result;
    this.logger.recordEmbeddingApiCall(tokensUsed);

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
    storedChunkTexts: Map<string, string>
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

        return {
          filePath: candidate.metadata.filePath,
          startLine,
          endLine,
          content,
          score: candidate.score,
          reranked: candidate.reranked,
          chunkType: candidate.metadata.chunkType,
          chunkKind: candidate.chunkKind ?? candidate.metadata.chunkKind,
          symbolKind: candidate.symbolKind ?? candidate.metadata.symbolKind,
          name: candidate.metadata.name,
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
    if (rerankTopN <= 0 || candidates.length < 2) {
      return {
        ordered: candidates,
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

    if (!reranked.applied) {
      if (reranked.failedBackend) {
        this.logger.search("warn", "Search reranker backend failed; using existing order", {
          taskType,
          backend: reranked.failedBackend,
        });
      }

      return {
        ordered: candidates,
        applied: false,
        backend: null,
        failedBackend: reranked.failedBackend,
      };
    }

    const headById = new Map(head.map((candidate) => [candidate.id, candidate]));
    const orderedHead = reranked.candidates
      .map<RankedCandidate | undefined>((candidate) => {
        const original = headById.get(candidate.id);
        if (!original) {
          return undefined;
        }

        return {
          ...original,
          score: candidate.baseScore,
          chunkKind: candidate.chunkKind ?? original.chunkKind ?? original.metadata.chunkKind,
          symbolKind: candidate.symbolKind ?? original.symbolKind ?? original.metadata.symbolKind,
          relation: candidate.relation ?? original.relation,
          reranked: true,
        };
      });
    const promotedHead: RankedCandidate[] = orderedHead.filter((candidate): candidate is RankedCandidate => candidate !== undefined);
    const orderedTail = tail.map((candidate) => ({
      ...candidate,
      reranked: false,
    }));

    return {
      ordered: [...promotedHead, ...orderedTail],
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
    const voyageLaneConfigured = Boolean(voyageProvider && voyageStore && voyageModelId);

    if (query.trim().length === 0) {
      return {
        primaryResults: [],
        expandedContext: [],
        taskType,
        graphDirection: options?.graphDirection ?? "both",
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

    if (store.count() === 0) {
      this.logger.search("debug", "Search on empty index", { query });
      return {
        primaryResults: [],
        expandedContext: [],
        taskType,
        graphDirection: options?.graphDirection ?? "both",
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
    const finalRerankTopN =
      options?.finalRerankTopN !== undefined
        ? options.finalRerankTopN
        : taskType === "general" && queryIntent === "doc_test" && options?.definitionIntent !== true
          ? 0
          : recipe.finalRerankTopN;
    const prefilterStartTime = performance.now();
    const metadataAllowedChunkIds = this.buildAllowedChunkIds(store, {
      fileType: options?.fileType,
      directory: options?.directory,
      chunkType: options?.chunkType,
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
        graphDirection: options?.graphDirection ?? "both",
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
      this.getQueryEmbedding(embeddingQuery, provider).catch((error) => {
        this.logger.search("warn", "Primary query embedding failed; continuing without Arctic dense lane", {
          taskType,
          model: provider.getModelInfo().model,
          error: getErrorMessage(error),
        });
        return null;
      }),
      voyageProvider
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
        if (!arcticQueryVector) {
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
        if (!rawVoyageQueryVector || !voyageStore || !voyageLaneAvailable) {
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
      semanticLane.results,
      metadataAllowedChunkIds
    );
    const voyageCandidates = this.filterCandidatesByChunkIds(
      voyageLane.results,
      metadataAllowedChunkIds
    );
    const keywordCandidates = this.filterCandidatesByChunkIds(
      keywordLane.results,
      metadataAllowedChunkIds
    );
    const keywordMs = keywordLane.ms;

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
          identifierBoost
        )
      : combined;

    const union = unionCandidates(semanticCandidates, voyageCandidates, keywordCandidates);

    const deterministicIdentifierLane = recipe.enableDeterministicIdentifierLane
      ? buildDeterministicIdentifierPass(
          query,
          union,
          maxResults,
          sourceIntent
        )
      : [];

    const identifierLane = recipe.enableIdentifierDefinitionLane
      ? buildIdentifierDefinitionLane(
          query,
          union,
          maxResults,
          sourceIntent
        )
      : [];

    const symbolLane = recipe.enableSymbolDefinitionLane
      ? buildSymbolDefinitionLane(
        query,
        database,
        metadataAllowedChunkIds,
        maxResults,
        union,
        sourceIntent
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
    const filtered = suppressCoarseFileChunksWhenSymbolMatchesExist(query, filteredBase);

    const fileContentCache = new Map<string, string | null>();
    const rerankStartTime = performance.now();
    const reranked = await this.applyFinalReranker(
      query,
      filtered,
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
    const graphDirection = options?.graphDirection ?? inferRelationshipGraphDirection(query) ?? "both";
    const graphDepth = Math.max(0, Math.min(2, options?.graphDepth ?? recipe.graphDepth ?? 0));
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
      storedChunkTexts
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
      graphDirection,
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
    const { store, invertedIndex } = await this.ensureInitialized();
    const scores = branch
      ? invertedIndex.searchOnBranch(query, branch, limit)
      : invertedIndex.search(query, limit);

    if (scores.size === 0) {
      return [];
    }

    // Only fetch metadata for chunks returned by BM25 (O(n) where n = result count)
    // instead of getAllMetadata() which fetches ALL chunks in the index
    const chunkIds = Array.from(scores.keys());
    const metadataMap = store.getMetadataBatch(chunkIds);

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
    const { configuredProviderInfo } = await this.ensureInitialized();
    const vectorCount = this.totalVectorCount();

    return {
      indexed: vectorCount > 0,
      vectorCount,
      provider: configuredProviderInfo.provider,
      model: configuredProviderInfo.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
      compatibility: this.indexCompatibility,
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
      this.refreshBranchInfo();
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

  refreshBranchInfo(): void {
    if (isGitRepo(this.projectRoot)) {
      const previousBranch = this.currentBranch;
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
      if (this.currentBranch !== previousBranch) {
        this.loadFileHashCache();
      }
    }
  }

  async getDatabaseStats(): Promise<{ embeddingCount: number; chunkCount: number; branchChunkCount: number; branchCount: number } | null> {
    const { database } = await this.ensureInitialized();
    return database.getStats();
  }

  getLogger(): Logger {
    return this.logger;
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
    const { store, provider } = await this.ensureInitialized();
    
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
    const metadataAllowedChunkIds = this.buildAllowedChunkIds(store, {
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

  private buildAllowedChunkIds(
    store: VectorStore,
    options: HardRetrievalFilters
  ): Set<string> | null {
    const hasMetadataFilters = Boolean(
      options.fileType || options.directory || options.chunkType || options.excludeFile
    );

    if (!hasMetadataFilters) {
      return null;
    }

    const allowedChunkIds = new Set<string>();

    for (const { key, metadata } of store.getAllMetadata()) {
      if (matchesHardRetrievalFilters(metadata, options)) {
        allowedChunkIds.add(key);
      }
    }

    return allowedChunkIds;
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
