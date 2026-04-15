import { existsSync, readFileSync } from "fs";
import * as path from "path";

import PQueue from "p-queue";
import pRetry from "p-retry";

import type { ConfiguredProviderInfo } from "../embeddings/detector.js";
import {
  buildMerkleSnapshot,
  createDynamicBatches,
  diffMerkleSnapshots,
  generateChunkId,
  hashContent,
  prepareEmbeddingInput,
  type ChunkData,
  type ChunkMetadata,
  type ChunkSymbolKind,
  type Database,
  type EmbeddingDebtData,
  type InvertedIndex,
  type MerkleDiff,
  type MerkleIgnoreRules,
  type SymbolData,
  type CallEdgeData,
  type VectorStore,
} from "../native/index.js";
import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { Logger } from "../utils/logger.js";
import {
  CustomProviderNonRetryableError,
  type EmbeddingProviderInterface,
  type VoyageEmbeddingProvider,
} from "../embeddings/provider.js";
import {
  type ConfigVersion,
  getCurrentConfigVersion,
  hashConfigVersion,
  hashEmbedConfig,
} from "./config-version.js";
import {
  CheckpointManager,
  type PipelineRunType,
} from "./checkpoint-manager.js";
import {
  JobQueue,
  type IndexJob,
  LOW_PRIORITY_STARVATION_THRESHOLD_MS,
  type JobQueueDrainOptions,
} from "./job-queue.js";
import type { IndexStats, ProgressCallback } from "./index.js";
import {
  clearWatcherEventTimestamp,
  consumeWatcherEventTimestamp,
} from "./watcher-tti.js";

export interface OrchestratorParsedChunk {
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

export interface OrchestratorParsedFile {
  path: string;
  hash: string;
  content: string;
  chunks: OrchestratorParsedChunk[];
}

type OrchestratorGraphEdgeData = Omit<CallEdgeData, "branch">;

export interface OrchestratorFileGraphData {
  symbols: SymbolData[];
  edges: OrchestratorGraphEdgeData[];
}

export interface InitializationResources {
  store: VectorStore;
  provider: EmbeddingProviderInterface;
  voyageProvider: VoyageEmbeddingProvider | null;
  voyageStore: VectorStore | null;
  voyageModelId: string | null;
  invertedIndex: InvertedIndex;
  configuredProviderInfo: ConfiguredProviderInfo;
  database: Database;
}

export interface IncrementalIndexOrchestratorHost {
  logger: Logger;
  getConfig(): ParsedCodebaseIndexConfig;
  getProjectRoot(): string;
  getIndexPath(): string;
  getCurrentBranch(): string;
  setCurrentBranch(branch: string): Promise<void>;
  refreshBranchInfo(): Promise<void>;
  ensureInitialized(): Promise<InitializationResources>;
  assertIndexCompatible(): void;
  runWithCrashMarker<T>(operation: () => Promise<T>): Promise<T>;
  loadFileHashCache(): void;
  commitFileHashChanges(
    successfulFileHashes: Map<string, string>,
    removedFilePaths: Iterable<string>
  ): void;
  buildCommittedMerkleSnapshot(
    baseSnapshot: string | null,
    committedRelativePaths: string[]
  ): Promise<string | null>;
  buildMerkleIgnoreRules(): MerkleIgnoreRules;
  normalizeDirtyPaths(paths: string[]): string[];
  buildBranchStoreChunkMaps(
    branchChunkIds: Set<string>
  ): {
    existingChunks: Map<string, string>;
    existingChunksByFile: Map<string, Set<string>>;
  };
  parseFilesForIndexing(
    files: Array<{ path: string; content: string; hash: string }>
  ): {
    parsedFiles: OrchestratorParsedFile[];
    failedFilePaths: string[];
    parseMs: number;
  };
  buildFileGraphData(parsedFiles: OrchestratorParsedFile[]): Map<string, OrchestratorFileGraphData>;
  removeChunkFromRetrievalIfUnreferenced(
    database: Database,
    invertedIndex: InvertedIndex,
    chunkId: string
  ): boolean;
  clearCallEdgesForSymbolIfUnreferenced(database: Database, symbolId: string): boolean;
  removeSymbolFromGraphIfUnreferenced(database: Database, symbolId: string): boolean;
  syncNativeBranchMembership(branch: string, chunkIds: string[]): void;
  applyNativeBranchMembershipDelta(branch: string, added: string[], removed: string[]): void;
  getProviderRateLimits(provider: string): {
    concurrency: number;
    intervalCap: number;
    interval: number;
  };
  addFailedBatch(batch: EmbeddingWorkChunk[], error: string): void;
  saveIndexMetadata(providerInfo: ConfiguredProviderInfo): void;
  markIndexCompatible(): void;
  consumeRecoveredFromCrash(): boolean;
  getFailedBatchesPath(): string;
}

interface SnapshotNode {
  path: string;
  kind: "file" | "directory";
  hash: string;
  parent_path?: string | null;
  size_bytes?: number | null;
}

interface SnapshotDocument {
  branch: string;
  root_hash: string;
  nodes: Record<string, SnapshotNode>;
}

interface FileJobPlan {
  parsedFile: OrchestratorParsedFile | null;
  currentChunks: ChunkRecord[];
  dirtyChunks: EmbeddingWorkChunk[];
  voyageDebtChunks: EmbeddingWorkChunk[];
  removedChunkIds: Set<string>;
  oldChunkIds: Set<string>;
  oldSymbolIds: Set<string>;
  newSymbolIds: Set<string>;
  primaryMaterializedChunkIds: Set<string>;
  embedStageInputHash: string;
  indexStageInputHash: string;
  chunkRan: boolean;
  indexNeedsUpdate: boolean;
  indexStarted: boolean;
  activeVoyageDebt: EmbeddingDebtData | null;
}

interface ChunkRecord {
  chunkId: string;
  contentHash: string;
  embeddingInputHash: string;
  embeddingText?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  chunkKind?: string;
  symbolKind?: string;
  language: string;
  text: string;
  chunkHash: string;
}

interface EmbeddingWorkChunk {
  id: string;
  text: string;
  content: string;
  contentHash: string;
  embeddingInputHash: string;
  metadata: ChunkMetadata;
}

interface ReplayableFileState {
  filePath: string;
  fileContentHash: string;
}

interface ReplayExpectedStageHashes {
  chunk: string;
  embed: string;
  index: string;
  graph: string;
}

interface RunFinalizationReplayResult {
  replayed: boolean;
  reopenedFiles: string[];
}

interface RunContext {
  startTime: number;
  branch: string;
  runId: string;
  runType: PipelineRunType;
  configVersion: ConfigVersion;
  configHash: string;
  store: VectorStore;
  provider: EmbeddingProviderInterface;
  voyageProvider: VoyageEmbeddingProvider | null;
  voyageStore: VectorStore | null;
  voyageModelId: string | null;
  invertedIndex: InvertedIndex;
  database: Database;
  configuredProviderInfo: ConfiguredProviderInfo;
  forceFreshPrimaryEmbeddings: boolean;
  forceFreshVoyageEmbeddings: boolean;
  branchChunkIds: Set<string>;
  currentChunkIds: Set<string>;
  existingChunks: Map<string, string>;
  existingChunksByFile: Map<string, Set<string>>;
  branchSymbolIds: Set<string>;
  allSymbolIds: Set<string>;
  successfulFileHashes: Map<string, string>;
  observedSnapshotFiles: Map<string, { hash: string; sizeBytes: number }>;
  removedAbsolutePaths: Set<string>;
  removedRelativePaths: Set<string>;
  pendingIndexCompletions: Map<string, { fileContentHash: string; inputHash: string }>;
  oldChunkIdsForTouchedFiles: Set<string>;
  oldSymbolIdsForTouchedFiles: Set<string>;
  activeVoyageDebtByFile: Map<string, EmbeddingDebtData>;
  initialVoyageDebtFiles: Set<string>;
  healedVoyageDebtFiles: Set<string>;
  failedFiles: Set<string>;
  deferredHotUpdatePaths: Set<string>;
  stats: IndexStats;
  baseSnapshot: string | null;
  fileHashes: Map<string, string>;
}

type StoredConfigRecord = NonNullable<
  ReturnType<CheckpointManager["getActiveConfigVersion"]>
>;

interface ConfigRebuildPlan {
  resetChunk: boolean;
  resetEmbed: boolean;
  resetIndex: boolean;
  resetGraph: boolean;
  forceFreshPrimaryEmbeddings: boolean;
  forceFreshVoyageEmbeddings: boolean;
}

const COLD_START_BATCH_SIZE = 50;
export const TTI_TARGET_MS = 2_000;
const RESUME_STALENESS_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const FINISHED_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

function parseSnapshotDocument(snapshot: string): SnapshotDocument {
  return JSON.parse(snapshot) as SnapshotDocument;
}

function createEmptySnapshotDocument(branch: string): SnapshotDocument {
  return {
    branch,
    root_hash: hashContent(""),
    nodes: {
      "": {
        path: "",
        parent_path: null,
        kind: "directory",
        hash: hashContent(""),
        size_bytes: null,
      },
    },
  };
}

function parentPathForSnapshot(pathValue: string): string | null {
  if (!pathValue) {
    return null;
  }

  const index = pathValue.lastIndexOf("/");
  if (index === -1) {
    return "";
  }

  return pathValue.slice(0, index);
}

function ensureSnapshotParentDirectories(
  nodes: Map<string, SnapshotNode>,
  filePath: string
): void {
  const segments = filePath.split("/");
  let current = "";

  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index] ?? "";
    if (!nodes.has(current)) {
      nodes.set(current, {
        path: current,
        parent_path: parentPathForSnapshot(current),
        kind: "directory",
        hash: "",
        size_bytes: null,
      });
    }
  }
}

function removeEmptyAncestorDirectories(
  nodes: Map<string, SnapshotNode>,
  filePath: string
): void {
  let current = parentPathForSnapshot(filePath);

  while (current !== null) {
    if (current === "") {
      return;
    }

    const hasChildren = Array.from(nodes.values()).some(
      (node) => node.parent_path === current
    );
    if (hasChildren) {
      return;
    }

    nodes.delete(current);
    current = parentPathForSnapshot(current);
  }
}

function buildSnapshotChildMap(nodes: Map<string, SnapshotNode>): Map<string, string[]> {
  const childMap = new Map<string, string[]>();

  for (const [nodePath, node] of nodes) {
    if (node.parent_path === undefined || node.parent_path === null) {
      continue;
    }

    const existingChildren = childMap.get(node.parent_path) ?? [];
    existingChildren.push(nodePath);
    childMap.set(node.parent_path, existingChildren);
  }

  for (const children of childMap.values()) {
    children.sort((left, right) => left.localeCompare(right));
  }

  return childMap;
}

function snapshotPathDepth(pathValue: string): number {
  if (!pathValue) {
    return 0;
  }

  return pathValue.split("/").length;
}

function computeSnapshotDirectoryHash(
  nodes: Map<string, SnapshotNode>,
  childMap: Map<string, string[]>,
  directoryPath: string
): string {
  let payload = "";
  const children = childMap.get(directoryPath) ?? [];

  for (const childPath of children) {
    const child = nodes.get(childPath);
    if (!child) {
      continue;
    }

    payload += `${child.kind}:${childPath}:${child.hash}\n`;
  }

  return hashContent(payload);
}

function recomputeSnapshotDirectoryHashes(nodes: Map<string, SnapshotNode>): void {
  const childMap = buildSnapshotChildMap(nodes);
  const directories = Array.from(nodes.values())
    .filter((node) => node.kind === "directory")
    .map((node) => node.path)
    .sort((left, right) => {
      const depthDelta = snapshotPathDepth(right) - snapshotPathDepth(left);
      return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
    });

  for (const directoryPath of directories) {
    const node = nodes.get(directoryPath);
    if (!node || node.kind !== "directory") {
      continue;
    }

    node.hash = computeSnapshotDirectoryHash(nodes, childMap, directoryPath);
    nodes.set(directoryPath, node);
  }
}

function serializeSnapshotDocument(document: SnapshotDocument): string {
  const sortedNodes = Object.fromEntries(
    Object.entries(document.nodes).sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify({
    branch: document.branch,
    root_hash: document.root_hash,
    nodes: sortedNodes,
  });
}

function getFilePathsFromSnapshot(snapshot: string | null): string[] {
  if (!snapshot) {
    return [];
  }

  return Object.values(parseSnapshotDocument(snapshot).nodes)
    .filter((node) => node.kind === "file")
    .map((node) => node.path);
}

function buildSnapshotFromObservedFileState(args: {
  branch: string;
  baseSnapshot: string | null;
  observedFiles: Map<string, { hash: string; sizeBytes: number }>;
  removedRelativePaths: Iterable<string>;
}): string {
  const document = args.baseSnapshot
    ? parseSnapshotDocument(args.baseSnapshot)
    : createEmptySnapshotDocument(args.branch);
  const nodes = new Map<string, SnapshotNode>(Object.entries(document.nodes));

  if (!nodes.has("")) {
    nodes.set("", {
      path: "",
      parent_path: null,
      kind: "directory",
      hash: hashContent(""),
      size_bytes: null,
    });
  }

  for (const relativePath of args.removedRelativePaths) {
    nodes.delete(relativePath);
    removeEmptyAncestorDirectories(nodes, relativePath);
  }

  for (const [relativePath, observed] of args.observedFiles) {
    ensureSnapshotParentDirectories(nodes, relativePath);
    nodes.set(relativePath, {
      path: relativePath,
      parent_path: parentPathForSnapshot(relativePath),
      kind: "file",
      hash: observed.hash,
      size_bytes: observed.sizeBytes,
    });
  }

  recomputeSnapshotDirectoryHashes(nodes);

  const root = nodes.get("");
  document.branch = args.branch;
  document.root_hash = root?.hash ?? hashContent("");
  document.nodes = Object.fromEntries(
    Array.from(nodes.entries()).sort(([left], [right]) => left.localeCompare(right))
  );

  return serializeSnapshotDocument(document);
}

function extractFileHashesFromSnapshot(snapshot: string): Map<string, string> {
  const document = parseSnapshotDocument(snapshot);
  const files = new Map<string, string>();

  for (const node of Object.values(document.nodes)) {
    if (node.kind === "file") {
      files.set(node.path, node.hash);
    }
  }

  return files;
}

function toAbsoluteFileHashes(
  projectRoot: string,
  snapshot: string
): Map<string, string> {
  const relativeHashes = extractFileHashesFromSnapshot(snapshot);
  const absoluteHashes = new Map<string, string>();

  for (const [relativePath, hash] of relativeHashes) {
    absoluteHashes.set(path.join(projectRoot, relativePath), hash);
  }

  return absoluteHashes;
}

function toRelativePath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function toAbsolutePath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

export function buildChunkStageInputHash(
  fileContentHash: string,
  chunkerVersion: string
): string {
  return hashContent(fileContentHash + chunkerVersion);
}

export function buildChunkEmbedInputHash(
  embeddingInputHash: string,
  embedConfigHash: string
): string {
  return hashContent(embeddingInputHash + embedConfigHash);
}

// pipeline_state is keyed per file, so EMBED identity must be aggregated from the
// file's current chunks rather than stored per chunk.
export function buildEmbedStageInputHash(
  embeddingInputHashes: string[],
  embedConfigHash: string
): string {
  const chunkInputs = [...embeddingInputHashes]
    .sort()
    .map((embeddingInputHash) =>
      buildChunkEmbedInputHash(embeddingInputHash, embedConfigHash)
    );
  return hashContent([embedConfigHash, ...chunkInputs].join("\n"));
}

// INDEX does not have an independent invalidation dimension in this codebase,
// but pipeline_state requires a concrete non-null hash. We persist the current
// file-level embed identity so the checkpoint row stays verifiable.
export function buildIndexStageInputHash(
  embeddingInputHashes: string[],
  embedConfigHash: string
): string {
  return buildEmbedStageInputHash(embeddingInputHashes, embedConfigHash);
}

export function buildGraphStageInputHash(
  fileContentHash: string,
  graphExtractorVersion: string
): string {
  return hashContent(fileContentHash + graphExtractorVersion);
}

export function applyChunkFilters(
  chunks: OrchestratorParsedChunk[],
  config: ParsedCodebaseIndexConfig
): {
  chunks: OrchestratorParsedChunk[];
  capped: boolean;
  eligibleCount: number;
  droppedCount: number;
  droppedNamedCount: number;
  droppedAnonymousCount: number;
  droppedNamedSymbols: string[];
} {
  const eligible = chunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => !(config.indexing.semanticOnly && chunk.chunkType === "other"));
  const maxChunksPerFile = config.indexing.maxChunksPerFile;

  if (eligible.length <= maxChunksPerFile) {
    return {
      chunks: eligible.map(({ chunk }) => chunk),
      capped: false,
      eligibleCount: eligible.length,
      droppedCount: 0,
      droppedNamedCount: 0,
      droppedAnonymousCount: 0,
      droppedNamedSymbols: [],
    };
  }

  const priority = (chunk: OrchestratorParsedChunk): number => {
    const hasName = typeof chunk.name === "string" && chunk.name.trim().length > 0;
    if (hasName) {
      return 0;
    }

    return chunk.chunkType === "other" ? 2 : 1;
  };

  const selectedIndices = new Set(
    [...eligible]
      .sort((left, right) => {
        const priorityDelta = priority(left.chunk) - priority(right.chunk);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return left.index - right.index;
      })
      .slice(0, maxChunksPerFile)
      .map(({ index }) => index)
  );

  let droppedNamedCount = 0;
  let droppedAnonymousCount = 0;
  const droppedNamedSymbols: string[] = [];
  const filtered: OrchestratorParsedChunk[] = [];

  for (const { chunk, index } of eligible) {
    if (selectedIndices.has(index)) {
      filtered.push(chunk);
      continue;
    }

    if (typeof chunk.name === "string" && chunk.name.trim().length > 0) {
      droppedNamedCount += 1;
      if (!droppedNamedSymbols.includes(chunk.name)) {
        droppedNamedSymbols.push(chunk.name);
      }
    } else {
      droppedAnonymousCount += 1;
    }
  }

  return {
    chunks: filtered,
    capped: true,
    eligibleCount: eligible.length,
    droppedCount: eligible.length - filtered.length,
    droppedNamedCount,
    droppedAnonymousCount,
    droppedNamedSymbols,
  };
}

function createEmptyStats(): IndexStats {
  return {
    totalFiles: 0,
    totalChunks: 0,
    indexedChunks: 0,
    failedChunks: 0,
    tokensUsed: 0,
    durationMs: 0,
    existingChunks: 0,
    removedChunks: 0,
    skippedFiles: [],
    parseFailures: [],
    ttiMeasurements: [],
  };
}

export class IncrementalIndexOrchestrator {
  private checkpointManager: CheckpointManager | null = null;
  private readonly queue = new JobQueue();
  private readonly pendingHotUpdatePaths = new Map<string, Set<string>>();
  private startupComplete = false;
  private forceColdStart = false;

  constructor(private readonly host: IncrementalIndexOrchestratorHost) {}

  private getActiveVoyageMaxTokens(resources: {
    voyageProvider: VoyageEmbeddingProvider | null;
    voyageStore: VectorStore | null;
    voyageModelId: string | null;
  }): number | null {
    const voyageEnabled = Boolean(
      resources.voyageProvider && resources.voyageStore && resources.voyageModelId
    );

    return voyageEnabled ? resources.voyageProvider!.getModelInfo().maxTokens : null;
  }

  private getEffectiveEmbeddingMaxTokens(resources: {
    configuredProviderInfo: ConfiguredProviderInfo;
    voyageProvider: VoyageEmbeddingProvider | null;
    voyageStore: VectorStore | null;
    voyageModelId: string | null;
  }): number {
    const primaryMaxTokens = resources.configuredProviderInfo.modelInfo.maxTokens;
    const activeVoyageMaxTokens = this.getActiveVoyageMaxTokens(resources);

    if (activeVoyageMaxTokens == null) {
      return primaryMaxTokens;
    }

    return Math.min(primaryMaxTokens, activeVoyageMaxTokens);
  }

  resetStartupState(): void {
    this.startupComplete = false;
    this.forceColdStart = false;
    this.pendingHotUpdatePaths.clear();
  }

  requestColdStart(): void {
    this.forceColdStart = true;
  }

  private buildConfigRebuildPlan(
    previousConfig: StoredConfigRecord | null,
    currentConfig: ConfigVersion,
    currentConfigHash: string
  ): ConfigRebuildPlan {
    if (!previousConfig) {
      return {
        resetChunk: true,
        resetEmbed: true,
        resetIndex: true,
        resetGraph: true,
        forceFreshPrimaryEmbeddings: true,
        forceFreshVoyageEmbeddings: true,
      };
    }

    const chunkChanged = previousConfig.chunkerVersion !== currentConfig.chunkerVersion;
    const graphChanged =
      previousConfig.graphExtractorVersion !== currentConfig.graphExtractorVersion;
    const voyageChanged =
      (previousConfig.voyageModelId ?? null) !== currentConfig.voyageModelId;
    const prefixChanged =
      (previousConfig.embeddingPrefixVersion ?? 0) !== currentConfig.embeddingPrefixVersion;
    const primaryEmbedVisibleChanged =
      previousConfig.embeddingModelId !== currentConfig.embeddingModelId ||
      previousConfig.embeddingDimension !== currentConfig.embeddingDimension ||
      prefixChanged;
    const hiddenPrimaryEmbedConfigChanged =
      previousConfig.configHash !== currentConfigHash &&
      !chunkChanged &&
      !graphChanged &&
      !primaryEmbedVisibleChanged &&
      !voyageChanged;
    const primaryEmbedChanged =
      primaryEmbedVisibleChanged || hiddenPrimaryEmbedConfigChanged;
    const voyageEmbedChanged = voyageChanged || prefixChanged;

    if (chunkChanged) {
      return {
        resetChunk: true,
        resetEmbed: true,
        resetIndex: true,
        resetGraph: true,
        forceFreshPrimaryEmbeddings: primaryEmbedChanged,
        forceFreshVoyageEmbeddings: voyageEmbedChanged,
      };
    }

    return {
      resetChunk: false,
      resetEmbed: primaryEmbedChanged || voyageEmbedChanged,
      resetIndex: primaryEmbedChanged || voyageEmbedChanged,
      resetGraph: graphChanged,
      forceFreshPrimaryEmbeddings: primaryEmbedChanged,
      forceFreshVoyageEmbeddings: voyageEmbedChanged,
    };
  }

  private applyConfigRebuildPlan(branch: string, plan: ConfigRebuildPlan): void {
    if (plan.resetChunk) {
      this.checkpoints.resetStageType(branch, "chunk");
    }
    if (plan.resetEmbed) {
      this.checkpoints.resetStageType(branch, "embed");
    }
    if (plan.resetIndex) {
      this.checkpoints.resetStageType(branch, "index");
    }
    if (plan.resetGraph) {
      this.checkpoints.resetStageType(branch, "graph");
    }
  }

  private resolveBranchBaselineConfig(
    branch: string,
    currentConfigHash: string,
    fallbackConfig: StoredConfigRecord | null = null
  ): StoredConfigRecord | null {
    const branchConfig = this.checkpoints.getBranchConfigVersion(branch);
    if (branchConfig) {
      const persisted = this.checkpoints.getConfigVersion(branchConfig.configHash);
      if (persisted) {
        return persisted;
      }
    }

    if (fallbackConfig && fallbackConfig.configHash !== currentConfigHash) {
      return fallbackConfig;
    }

    return null;
  }

  private async enqueueFilesForRun(
    context: RunContext,
    filePaths: string[],
    trigger: IndexJob["trigger"],
    priority: IndexJob["priority"]
  ): Promise<void> {
    for (
      let batchStart = 0;
      batchStart < filePaths.length;
      batchStart += COLD_START_BATCH_SIZE
    ) {
      const batch = filePaths.slice(batchStart, batchStart + COLD_START_BATCH_SIZE);

      for (const filePath of batch) {
        this.checkpoints.ensureTrackedFile(context.branch, filePath);
        this.queue.enqueue({
          branch: context.branch,
          filePath,
          priority,
          trigger,
          runId: context.runId,
        });
      }

      await this.drainRunContext(context, {
        maxCountedJobs: batch.length,
        countJob: (job) =>
          job.branch === context.branch &&
          job.runId === context.runId &&
          job.trigger === trigger,
      });

      while (this.queue.hasPendingAtOrAbove("high")) {
        await this.drainRunContext(context);
      }
    }
  }

  private async runBranchWideConfigChange(
    resources: InitializationResources,
    branch: string,
    configVersion: ConfigVersion,
    configHash: string,
    plan: ConfigRebuildPlan,
    options: {
      storedSnapshot?: string | null;
      currentSnapshot?: string | null;
    } = {}
  ): Promise<void> {
    const storedSnapshot =
      options.storedSnapshot ?? this.getStoredSnapshot(resources.database, branch);
    const currentSnapshot =
      options.currentSnapshot ??
      (
        await buildMerkleSnapshot(
          this.host.getProjectRoot(),
          branch,
          this.host.buildMerkleIgnoreRules()
        )
      ).snapshot;
    const fileHashes = toAbsoluteFileHashes(this.host.getProjectRoot(), currentSnapshot);
    const run = this.checkpoints.startRun(branch, "config_change", configHash);
    const context = this.createRunContext({
      ...resources,
      branch,
      runId: run.runId,
      runType: "config_change",
      configVersion,
      configHash,
      forceFreshPrimaryEmbeddings: plan.forceFreshPrimaryEmbeddings,
      forceFreshVoyageEmbeddings: plan.forceFreshVoyageEmbeddings,
      baseSnapshot: storedSnapshot,
      fileHashes,
    });

    const trackedDeletedFiles = Array.from(
      new Set(
        this.checkpoints
          .getKnownFiles(branch)
          .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath))
          .filter((filePath) => !fileHashes.has(filePath))
      )
    ).sort((left, right) => left.localeCompare(right));

    for (const filePath of trackedDeletedFiles) {
      this.processRemovedFile(context, filePath);
    }

    const branchFilePaths = this.includeActiveVoyageDebtFiles(
      context,
      Array.from(fileHashes.keys())
    );
    context.stats.totalFiles = branchFilePaths.length;
    await this.enqueueFilesForRun(context, branchFilePaths, "config_change", "normal");
    await this.drainRunContext(context);
    await this.finalizeRunContext(context);
  }

  private async ensureBranchConfigApplied(
    resources: InitializationResources,
    branch: string,
    currentConfig: ConfigVersion,
    currentConfigHash: string,
    options: {
      fallbackConfig?: StoredConfigRecord | null;
      storedSnapshot?: string | null;
      currentSnapshot?: string | null;
    } = {}
  ): Promise<boolean> {
    const branchConfig = this.checkpoints.getBranchConfigVersion(branch);
    if (branchConfig?.configHash === currentConfigHash) {
      return false;
    }

    const storedSnapshot =
      options.storedSnapshot ?? this.getStoredSnapshot(resources.database, branch);
    const currentSnapshot =
      options.currentSnapshot ??
      (
        await buildMerkleSnapshot(
          this.host.getProjectRoot(),
          branch,
          this.host.buildMerkleIgnoreRules()
        )
      ).snapshot;
    const fileHashes = toAbsoluteFileHashes(this.host.getProjectRoot(), currentSnapshot);
    const knownFiles = this.checkpoints.getKnownFiles(branch);

    if (!storedSnapshot && knownFiles.length === 0) {
      return false;
    }

    if (knownFiles.length === 0 && fileHashes.size === 0) {
      this.checkpoints.markBranchConfigApplied(branch, currentConfigHash);
      return false;
    }

    const previousConfig = this.resolveBranchBaselineConfig(
      branch,
      currentConfigHash,
      options.fallbackConfig ?? null
    );
    const plan = this.buildConfigRebuildPlan(
      previousConfig,
      currentConfig,
      currentConfigHash
    );

    if (
      !plan.resetChunk &&
      !plan.resetEmbed &&
      !plan.resetIndex &&
      !plan.resetGraph
    ) {
      this.checkpoints.markBranchConfigApplied(branch, currentConfigHash);
      return false;
    }

    this.applyConfigRebuildPlan(branch, plan);
    await this.runBranchWideConfigChange(resources, branch, currentConfig, currentConfigHash, plan, {
      storedSnapshot,
      currentSnapshot,
    });
    return true;
  }

  private getCheckpointManager(database: Database): CheckpointManager {
    if (!this.checkpointManager) {
      this.checkpointManager = new CheckpointManager(database);
    }
    return this.checkpointManager;
  }

  private get checkpoints(): CheckpointManager {
    if (!this.checkpointManager) {
      throw new Error("CheckpointManager accessed before initialization");
    }
    return this.checkpointManager;
  }

  async coldStart(onProgress?: ProgressCallback): Promise<IndexStats> {
    await this.ensureStartupState();

    if (this.forceColdStart) {
      this.forceColdStart = false;
    }

    return this.host.runWithCrashMarker(async () => {
      const resources = await this.prepareRun();
      const branch = this.host.getCurrentBranch();
      this.consumePendingHotUpdatePaths(branch);
      const configVersion = await getCurrentConfigVersion(
        resources.configuredProviderInfo,
        resources.voyageModelId,
        this.getActiveVoyageMaxTokens(resources)
      );
      const configHash = hashConfigVersion(configVersion);
      const snapshot = await buildMerkleSnapshot(
        this.host.getProjectRoot(),
        branch,
        this.host.buildMerkleIgnoreRules()
      );
      const fileHashes = toAbsoluteFileHashes(this.host.getProjectRoot(), snapshot.snapshot);
      const run = this.checkpoints.startRun(branch, "cold_start", configHash);

      onProgress?.({
        phase: "scanning",
        filesProcessed: 0,
        totalFiles: fileHashes.size,
        chunksProcessed: 0,
        totalChunks: 0,
      });

      const context = this.createRunContext({
        ...resources,
        branch,
        runId: run.runId,
        runType: "cold_start",
        configVersion,
        configHash,
        baseSnapshot: this.getStoredSnapshot(resources.database, branch),
        fileHashes,
      });

      const trackedDeletedFiles = Array.from(
        new Set(
          this.checkpoints
            .getKnownFiles(branch)
            .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath))
            .filter((filePath) => !fileHashes.has(filePath))
        )
      ).sort((left, right) => left.localeCompare(right));

      for (const filePath of trackedDeletedFiles) {
        this.processRemovedFile(context, filePath);
      }

      const coldStartFilePaths = this.includeActiveVoyageDebtFiles(
        context,
        Array.from(fileHashes.keys())
      );
      context.stats.totalFiles = coldStartFilePaths.length;
      await this.enqueueFilesForRun(context, coldStartFilePaths, "cold_start", "low");
      await this.drainRunContext(context);
      return this.finalizeRunContext(context, onProgress);
    });
  }

  async hotUpdate(
    diff: MerkleDiff,
    nextSnapshot?: string,
    baseSnapshot: string | null = null
  ): Promise<IndexStats> {
    await this.ensureStartupState();

    if (this.forceColdStart) {
      this.forceColdStart = false;
      return this.coldStart();
    }

    return this.host.runWithCrashMarker(async () => {
      const resources = await this.prepareRun();
      const branch = this.host.getCurrentBranch();
      const configVersion = await getCurrentConfigVersion(
        resources.configuredProviderInfo,
        resources.voyageModelId,
        this.getActiveVoyageMaxTokens(resources)
      );
      const configHash = hashConfigVersion(configVersion);
      const preparedHotUpdate = await this.prepareHotUpdateInputs(
        resources.database,
        branch,
        diff,
        nextSnapshot,
        baseSnapshot
      );
      const run = this.checkpoints.startRun(branch, "hot_update", configHash);
      const touchedFiles = this.host.normalizeDirtyPaths([
        ...preparedHotUpdate.diff.changedFiles,
        ...preparedHotUpdate.diff.addedFiles,
        ...preparedHotUpdate.diff.removedFiles,
      ]).map((filePath) => path.join(this.host.getProjectRoot(), filePath));
      const fileHashes = preparedHotUpdate.nextSnapshot
        ? toAbsoluteFileHashes(this.host.getProjectRoot(), preparedHotUpdate.nextSnapshot)
        : new Map<string, string>();

      for (const filePath of this.host
        .normalizeDirtyPaths([
          ...preparedHotUpdate.diff.changedFiles,
          ...preparedHotUpdate.diff.addedFiles,
        ])
        .map((relativePath) => path.join(this.host.getProjectRoot(), relativePath))) {
        this.checkpoints.ensureTrackedFile(branch, filePath);
      }

      const context = this.createRunContext({
        ...resources,
        branch,
        runId: run.runId,
        runType: "hot_update",
        configVersion,
        configHash,
        baseSnapshot: preparedHotUpdate.baseSnapshot,
        fileHashes,
      });
      const hotUpdateFilePaths = this.includeActiveVoyageDebtFiles(context, touchedFiles);
      for (const filePath of hotUpdateFilePaths) {
        this.queue.enqueue({
          branch,
          filePath,
          priority: "high",
          trigger: "watcher_event",
          runId: run.runId,
        });
      }
      context.stats.totalFiles = hotUpdateFilePaths.length;
      await this.drainRunContext(context);
      return this.finalizeRunContext(context);
    });
  }

  async handleBranchChange(oldBranch: string | null, newBranch: string): Promise<void> {
    await this.ensureStartupState();

    const resources = await this.prepareRun();
    const currentConfig = await getCurrentConfigVersion(
      resources.configuredProviderInfo,
      resources.voyageModelId,
      this.getActiveVoyageMaxTokens(resources)
    );
    const currentConfigHash = hashConfigVersion(currentConfig);
    if (oldBranch) {
      this.checkpoints.cancelActiveRuns(oldBranch);
      this.queue.purgeBranch(oldBranch);
      this.pendingHotUpdatePaths.delete(oldBranch);
    }
    const { database } = resources;
    const storedSnapshot = database.getMerkleSnapshot(newBranch);
    await this.host.setCurrentBranch(newBranch);

    if (!storedSnapshot) {
      await this.coldStart();
      return;
    }

    const currentSnapshot = await buildMerkleSnapshot(
      this.host.getProjectRoot(),
      newBranch,
      this.host.buildMerkleIgnoreRules()
    );
    if (
      await this.ensureBranchConfigApplied(
        resources,
        newBranch,
        currentConfig,
        currentConfigHash,
        {
          storedSnapshot,
          currentSnapshot: currentSnapshot.snapshot,
        }
      )
    ) {
      return;
    }

    const diff = await import("../native/index.js").then(({ diffMerkleSnapshots }) =>
      diffMerkleSnapshots(storedSnapshot, currentSnapshot.snapshot)
    );

    if (diff.changedFiles.length === 0 && diff.addedFiles.length === 0 && diff.removedFiles.length === 0) {
      database.saveMerkleSnapshot(currentSnapshot.snapshot);
      return;
    }

    await this.hotUpdate(diff, currentSnapshot.snapshot, storedSnapshot);
  }

  async handleConfigChange(
    resources: InitializationResources,
    branch: string,
    oldConfig: ReturnType<CheckpointManager["getActiveConfigVersion"]>,
    newConfig: ConfigVersion,
    newConfigHash: string
  ): Promise<void> {
    this.checkpoints.activateConfigVersion(newConfigHash, newConfig);
    await this.ensureBranchConfigApplied(resources, branch, newConfig, newConfigHash, {
      fallbackConfig: oldConfig,
    });
  }

  private async ensureStartupState(): Promise<void> {
    if (this.startupComplete) {
      return;
    }

    const resources = await this.prepareRun();
    const branch = this.host.getCurrentBranch();
    const currentConfig = await getCurrentConfigVersion(
      resources.configuredProviderInfo,
      resources.voyageModelId,
      this.getActiveVoyageMaxTokens(resources)
    );
    const currentConfigHash = hashConfigVersion(currentConfig);
    const activeConfig = this.checkpoints.getActiveConfigVersion();

    if (!activeConfig || activeConfig.configHash !== currentConfigHash) {
      await this.handleConfigChange(
        resources,
        branch,
        activeConfig,
        currentConfig,
        currentConfigHash
      );
    } else {
      await this.ensureBranchConfigApplied(
        resources,
        branch,
        currentConfig,
        currentConfigHash
      );
    }

    const interruptedFinalizationRuns = this.checkpoints.getFinalizingRuns(branch);
    if (interruptedFinalizationRuns.length > 0) {
      // Runs interrupted during finalization (status: 'finalizing') are intentionally
      // cold-started rather than replayed. By the time a run reaches 'finalizing',
      // branch catalog writes may be partially applied. Replaying into partial catalog
      // state without rollback capability is unsafe. Cold-start rebuilds from a clean
      // baseline. True interrupted-finalization replay would require transactional
      // catalog writes and is deferred to a future architectural improvement.
      for (const run of interruptedFinalizationRuns) {
        this.host.logger.warn(
          `Interrupted finalization detected for run ${run.runId} on branch ${run.branch}. Forcing cold start to restore consistency.`,
          {
            branch: run.branch,
            runId: run.runId,
            configHash: run.configHash,
          }
        );
      }
      this.checkpoints.cancelActiveRuns(branch);
      this.forceColdStart = true;
    }

    if (this.host.consumeRecoveredFromCrash()) {
      for (const run of this.checkpoints.getInProgressRuns()) {
        this.checkpoints.cancelActiveRuns(run.branch);
      }
      this.forceColdStart = true;
    } else {
      await this.resumeInterruptedRuns(branch, currentConfig, currentConfigHash);
    }

    this.checkpoints.pruneFinishedRuns(FINISHED_RUN_RETENTION_MS);
    this.startupComplete = true;
  }

  private async resumeInterruptedRuns(
    currentBranch: string,
    configVersion: ConfigVersion,
    configHash: string
  ): Promise<void> {
    const resources = await this.prepareRun();
    const now = Date.now();
    const activeRuns = this.checkpoints.getInProgressRuns();

    for (const run of activeRuns) {
      if (now - run.startedAt > RESUME_STALENESS_THRESHOLD_MS) {
        this.checkpoints.cancelActiveRuns(run.branch);
        continue;
      }

      if (run.branch !== currentBranch) {
        this.checkpoints.cancelActiveRuns(run.branch);
        continue;
      }

      if (run.configHash !== configHash) {
        this.checkpoints.cancelActiveRuns(run.branch);
        this.host.logger.info(
          `Cancelled interrupted run ${run.runId} on branch ${run.branch} because config changed since the run started. Config-migration path will handle reindexing.`,
          {
            branch: run.branch,
            runId: run.runId,
            runConfigHash: run.configHash,
            currentConfigHash: configHash,
          }
        );
        continue;
      }

      let unfinishedFiles = this.checkpoints
        .getUnfinishedFiles(run.branch)
        .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath));
      if (unfinishedFiles.length === 0) {
        const replayResult = await this.replayRunFinalization(resources, {
          branch: run.branch,
          runId: run.runId,
          configVersion,
          configHash,
        });
        if (replayResult.replayed) {
          continue;
        }
        unfinishedFiles = replayResult.reopenedFiles;
      }

      for (const filePath of unfinishedFiles) {
        this.verifyResumableEmbedCheckpoint(resources, run.branch, filePath, run.runId);
      }

      const snapshot = this.getStoredSnapshot(resources.database, run.branch);
      const currentSnapshot = await buildMerkleSnapshot(
        this.host.getProjectRoot(),
        run.branch,
        this.host.buildMerkleIgnoreRules()
      );
      const fileHashes = toAbsoluteFileHashes(
        this.host.getProjectRoot(),
        currentSnapshot.snapshot
      );
      const context = this.createRunContext({
        ...resources,
        branch: run.branch,
        runId: run.runId,
        runType: "resume",
        configVersion,
        configHash,
        baseSnapshot: snapshot,
        fileHashes,
      });
      const resumeFilePaths = this.includeActiveVoyageDebtFiles(context, unfinishedFiles);
      for (const filePath of resumeFilePaths) {
        this.queue.enqueue({
          branch: run.branch,
          filePath,
          priority: "normal",
          trigger: "crash_resume",
          runId: run.runId,
        });
      }
      context.stats.totalFiles = resumeFilePaths.length;
      await this.drainRunContext(context);
      await this.finalizeRunContext(context);
    }
  }

  private verifyResumableEmbedCheckpoint(
    resources: InitializationResources,
    branch: string,
    filePath: string,
    runId: string
  ): boolean {
    const embedState = this.checkpoints.getStageState(branch, filePath, "embed");
    if (embedState?.status !== "complete") {
      return true;
    }

    const currentChunks = resources.database.getChunksByFileOnBranch(filePath, branch);
    if (currentChunks.length === 0) {
      return true;
    }

    const primaryArtifactsMissing = currentChunks.some((chunk) => {
      const chunkPresent =
        resources.store.contains(chunk.chunkId) && resources.invertedIndex.hasChunk(chunk.chunkId);
      if (!chunkPresent) {
        return true;
      }

      return (
        !resources.store.branchContains(branch, chunk.chunkId) ||
        !resources.invertedIndex.branchContains(branch, chunk.chunkId)
      );
    });
    const voyageArtifactsMissing = Boolean(resources.voyageStore && resources.voyageModelId)
      ? currentChunks.some((chunk) => {
          if (!resources.voyageStore!.contains(chunk.chunkId)) {
            return true;
          }
          return !resources.voyageStore!.branchContains(branch, chunk.chunkId);
        })
      : false;

    if (!primaryArtifactsMissing && !voyageArtifactsMissing) {
      return true;
    }

    const branchChunkIds = resources.database.getBranchChunkIds(branch);
    if (branchChunkIds.length > 0) {
      this.host.syncNativeBranchMembership(branch, branchChunkIds);
    }

    const primaryArtifactsRecovered = currentChunks.every(
      (chunk) =>
        resources.store.contains(chunk.chunkId) &&
        resources.invertedIndex.hasChunk(chunk.chunkId) &&
        resources.store.branchContains(branch, chunk.chunkId) &&
        resources.invertedIndex.branchContains(branch, chunk.chunkId)
    );
    const voyageArtifactsRecovered =
      !resources.voyageStore ||
      !resources.voyageModelId ||
      currentChunks.every(
        (chunk) =>
          resources.voyageStore!.contains(chunk.chunkId) &&
          resources.voyageStore!.branchContains(branch, chunk.chunkId)
      );

    if (primaryArtifactsRecovered && voyageArtifactsRecovered) {
      this.host.logger.info(
        "Recovered missing branch-visible retrieval state during resume by rehydrating native branch membership",
        {
          branch,
          filePath,
          runId,
          chunkCount: currentChunks.length,
        }
      );
      return true;
    }

    this.checkpoints.markStagePending(branch, filePath, "embed");
    this.host.logger.warn(
      "Embed checkpoint was complete but live retrieval artifacts were missing during resume; scheduling re-embed",
      {
        branch,
        filePath,
        runId,
        primaryArtifactsMissing,
        voyageArtifactsMissing,
        chunkCount: currentChunks.length,
      }
    );
    return false;
  }

  private async replayRunFinalization(
    resources: InitializationResources,
    args: {
      branch: string;
      runId: string;
      configVersion: ConfigVersion;
      configHash: string;
    }
  ): Promise<RunFinalizationReplayResult> {
    await this.host.setCurrentBranch(args.branch);
    const currentSnapshot = await buildMerkleSnapshot(
      this.host.getProjectRoot(),
      args.branch,
      this.host.buildMerkleIgnoreRules()
    );
    const currentFileHashes = toAbsoluteFileHashes(this.host.getProjectRoot(), currentSnapshot.snapshot);
    const replayableFiles: ReplayableFileState[] = [];
    const filesToReopen = new Set<string>();
    const knownFiles = this.checkpoints
      .getKnownFiles(args.branch)
      .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath));
    const knownFileSet = new Set(knownFiles);

    for (const filePath of currentFileHashes.keys()) {
      if (!knownFileSet.has(filePath)) {
        filesToReopen.add(filePath);
      }
    }

    for (const filePath of knownFiles) {
      const observedHash = currentFileHashes.get(filePath);
      if (!observedHash || !existsSync(filePath)) {
        filesToReopen.add(filePath);
        continue;
      }

      const fileContent = readFileSync(filePath, "utf-8");
      const expectedHashes = this.buildReplayExpectedStageHashes(
        resources,
        args.configVersion,
        filePath,
        fileContent,
        observedHash
      );

      if (!expectedHashes || !this.isReplayFileStateCurrent(args.branch, filePath, expectedHashes)) {
        filesToReopen.add(filePath);
        continue;
      }

      replayableFiles.push({
        filePath,
        fileContentHash: observedHash,
      });
    }

    if (filesToReopen.size > 0) {
      for (const filePath of filesToReopen) {
        this.checkpoints.ensureTrackedFile(args.branch, filePath);
        this.checkpoints.markStagePending(args.branch, filePath, "chunk");
      }

      this.host.logger.warn(
        "Interrupted run had no unfinished files but finalization replay was unsafe; reopened drifted files for resume",
        {
          branch: args.branch,
          runId: args.runId,
          reopenedFiles: Array.from(filesToReopen).map((filePath) =>
            toRelativePath(this.host.getProjectRoot(), filePath)
          ),
        }
      );

      return {
        replayed: false,
        reopenedFiles: this.checkpoints
          .getUnfinishedFiles(args.branch)
          .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath)),
      };
    }

    const previousSnapshot = this.getStoredSnapshot(resources.database, args.branch);
    const removedAbsolutePaths = getFilePathsFromSnapshot(previousSnapshot)
      .filter((relativePath) => !currentFileHashes.has(toAbsolutePath(this.host.getProjectRoot(), relativePath)))
      .map((relativePath) => toAbsolutePath(this.host.getProjectRoot(), relativePath));

    this.host.loadFileHashCache();
    this.host.commitFileHashChanges(
      new Map(replayableFiles.map((file) => [file.filePath, file.fileContentHash])),
      removedAbsolutePaths
    );
    resources.database.saveMerkleSnapshot(currentSnapshot.snapshot);
    if (this.checkpoints.getBranchConfigVersion(args.branch)?.configHash !== args.configHash) {
      this.checkpoints.markBranchConfigApplied(args.branch, args.configHash);
    }
    this.checkpoints.markRunComplete(args.runId);
    this.applyPostFinalizationSideEffects(resources.configuredProviderInfo);
    this.host.logger.info("Replayed interrupted run finalization", {
      branch: args.branch,
      runId: args.runId,
      replayedFiles: replayableFiles.length,
      removedFiles: removedAbsolutePaths.length,
    });
    return {
      replayed: true,
      reopenedFiles: [],
    };
  }

  private buildReplayExpectedStageHashes(
    resources: InitializationResources,
    configVersion: ConfigVersion,
    absolutePath: string,
    fileContent: string,
    fileContentHash: string
  ): ReplayExpectedStageHashes | null {
    const parsed = this.host.parseFilesForIndexing([
      {
        path: absolutePath,
        content: fileContent,
        hash: fileContentHash,
      },
    ]);
    if (parsed.failedFilePaths.length > 0 || parsed.parsedFiles.length !== 1) {
      return null;
    }

    const parsedFile = parsed.parsedFiles[0];
    if (!parsedFile) {
      return null;
    }

    const currentChunks = this.buildChunkRecords(
      absolutePath,
      parsedFile,
      this.getEffectiveEmbeddingMaxTokens(resources)
    );
    const embedConfigHash = hashEmbedConfig(
      resources.configuredProviderInfo,
      resources.voyageModelId,
      this.getActiveVoyageMaxTokens(resources)
    );
    const embeddingInputHashes = currentChunks.map((chunk) => chunk.embeddingInputHash);

    return {
      chunk: buildChunkStageInputHash(fileContentHash, configVersion.chunkerVersion),
      embed: buildEmbedStageInputHash(embeddingInputHashes, embedConfigHash),
      index: buildIndexStageInputHash(embeddingInputHashes, embedConfigHash),
      graph: buildGraphStageInputHash(fileContentHash, configVersion.graphExtractorVersion),
    };
  }

  private isReplayFileStateCurrent(
    branch: string,
    filePath: string,
    expectedHashes: ReplayExpectedStageHashes
  ): boolean {
    const chunkState = this.checkpoints.getStageState(branch, filePath, "chunk");
    const embedState = this.checkpoints.getStageState(branch, filePath, "embed");
    const indexState = this.checkpoints.getStageState(branch, filePath, "index");
    const graphState = this.checkpoints.getStageState(branch, filePath, "graph");

    return (
      chunkState?.status === "complete" &&
      chunkState.inputHash === expectedHashes.chunk &&
      embedState?.status === "complete" &&
      embedState.inputHash === expectedHashes.embed &&
      indexState?.status === "complete" &&
      indexState.inputHash === expectedHashes.index &&
      graphState?.status === "complete" &&
      graphState.inputHash === expectedHashes.graph
    );
  }

  private async prepareRun(): Promise<InitializationResources> {
    const resources = await this.host.ensureInitialized();
    this.getCheckpointManager(resources.database);
    await this.host.refreshBranchInfo();
    this.host.assertIndexCompatible();
    return resources;
  }

  private getActiveVoyageDebtByFile(
    database: Database,
    branch: string,
    voyageModelId: string | null
  ): Map<string, EmbeddingDebtData> {
    if (!voyageModelId) {
      return new Map();
    }

    const debtRows = database.getEmbeddingDebtForBranch(branch);
    return new Map(
      debtRows
        .filter((row) => row.model === voyageModelId)
        .map((row) => [row.filePath, row] as const)
    );
  }

  private includeActiveVoyageDebtFiles(
    context: RunContext,
    filePaths: string[]
  ): string[] {
    const combined = new Set(filePaths);

    for (const [filePath] of context.activeVoyageDebtByFile) {
      const embedState = this.checkpoints.getStageState(context.branch, filePath, "embed");
      if (embedState?.status === "complete") {
        combined.add(filePath);
      }
    }

    return Array.from(combined).sort((left, right) => left.localeCompare(right));
  }

  private createRunContext(args: {
    branch: string;
    runId: string;
    runType: PipelineRunType;
    configVersion: ConfigVersion;
    configHash: string;
    forceFreshPrimaryEmbeddings?: boolean;
    forceFreshVoyageEmbeddings?: boolean;
    baseSnapshot: string | null;
    fileHashes: Map<string, string>;
  } & InitializationResources): RunContext {
    const branchChunkIds = new Set(args.database.getBranchChunkIds(args.branch));
    const { existingChunks, existingChunksByFile } = this.host.buildBranchStoreChunkMaps(
      branchChunkIds
    );
    const branchSymbolIds = new Set(args.database.getBranchSymbolIds(args.branch));
    const activeVoyageDebtByFile = this.getActiveVoyageDebtByFile(
      args.database,
      args.branch,
      args.voyageModelId
    );

    this.host.loadFileHashCache();
    this.host.logger.recordIndexingStart();
    if (activeVoyageDebtByFile.size > 0 && args.voyageModelId) {
      this.host.logger.info(
        `Voyage embedding debt: ${activeVoyageDebtByFile.size} files on branch ${args.branch} will be healed this run`,
        {
          branch: args.branch,
          runId: args.runId,
          fileCount: activeVoyageDebtByFile.size,
          model: args.voyageModelId,
        }
      );
    }

    return {
      startTime: Date.now(),
      branch: args.branch,
      runId: args.runId,
      runType: args.runType,
      configVersion: args.configVersion,
      configHash: args.configHash,
      store: args.store,
      provider: args.provider,
      voyageProvider: args.voyageProvider,
      voyageStore: args.voyageStore,
      voyageModelId: args.voyageModelId,
      invertedIndex: args.invertedIndex,
      database: args.database,
      configuredProviderInfo: args.configuredProviderInfo,
      forceFreshPrimaryEmbeddings: args.forceFreshPrimaryEmbeddings ?? false,
      forceFreshVoyageEmbeddings: args.forceFreshVoyageEmbeddings ?? false,
      branchChunkIds,
      currentChunkIds: new Set(branchChunkIds),
      existingChunks,
      existingChunksByFile,
      branchSymbolIds,
      allSymbolIds: new Set(branchSymbolIds),
      successfulFileHashes: new Map<string, string>(),
      observedSnapshotFiles: new Map<string, { hash: string; sizeBytes: number }>(),
      removedAbsolutePaths: new Set<string>(),
      removedRelativePaths: new Set<string>(),
      pendingIndexCompletions: new Map<string, { fileContentHash: string; inputHash: string }>(),
      oldChunkIdsForTouchedFiles: new Set<string>(),
      oldSymbolIdsForTouchedFiles: new Set<string>(),
      activeVoyageDebtByFile,
      initialVoyageDebtFiles: new Set(activeVoyageDebtByFile.keys()),
      healedVoyageDebtFiles: new Set<string>(),
      failedFiles: new Set<string>(),
      deferredHotUpdatePaths: new Set<string>(),
      stats: createEmptyStats(),
      baseSnapshot: args.baseSnapshot,
      fileHashes: args.fileHashes,
    };
  }

  private deferHotUpdatePath(branch: string, filePath: string): void {
    const branchPaths = this.pendingHotUpdatePaths.get(branch) ?? new Set<string>();
    branchPaths.add(filePath);
    this.pendingHotUpdatePaths.set(branch, branchPaths);
  }

  private consumePendingHotUpdatePaths(branch: string): string[] {
    const pending = this.pendingHotUpdatePaths.get(branch);
    if (!pending || pending.size === 0) {
      return [];
    }

    this.pendingHotUpdatePaths.delete(branch);
    return Array.from(pending).sort((left, right) => left.localeCompare(right));
  }

  private async prepareHotUpdateInputs(
    database: Database,
    branch: string,
    diff: MerkleDiff,
    nextSnapshot?: string,
    baseSnapshot: string | null = null
  ): Promise<{
    diff: MerkleDiff;
    nextSnapshot?: string;
    baseSnapshot: string | null;
  }> {
    const deferredPaths = this.consumePendingHotUpdatePaths(branch);
    const effectiveBaseSnapshot = baseSnapshot ?? this.getStoredSnapshot(database, branch);

    if (deferredPaths.length === 0) {
      return {
        diff,
        nextSnapshot,
        baseSnapshot: effectiveBaseSnapshot,
      };
    }

    const currentSnapshot = await buildMerkleSnapshot(
      this.host.getProjectRoot(),
      branch,
      this.host.buildMerkleIgnoreRules()
    );
    const diffBaseSnapshot =
      effectiveBaseSnapshot ?? serializeSnapshotDocument(createEmptySnapshotDocument(branch));

    // Containment strategy: if files drifted after scan, do not try to salvage the
    // old diff inside the same run. The next serialized operation recomputes a fresh
    // Merkle diff from the last committed snapshot to the current working tree.
    return {
      diff: await diffMerkleSnapshots(diffBaseSnapshot, currentSnapshot.snapshot),
      nextSnapshot: currentSnapshot.snapshot,
      baseSnapshot: effectiveBaseSnapshot,
    };
  }

  private async drainRunContext(
    context: RunContext,
    options: JobQueueDrainOptions = {}
  ): Promise<void> {
    await this.queue.drain(async (job) => {
      if (job.branch !== context.branch || job.runId !== context.runId) {
        return;
      }

      try {
        await this.processJob(context, job);
      } catch (error) {
        context.failedFiles.add(job.filePath);
        context.stats.failedChunks += 1;
        this.host.logger.warn("Incremental file processing failed", {
          branch: job.branch,
          filePath: job.filePath,
          stage: "pipeline",
          error: getErrorMessage(error),
        });
      }
    }, options);
  }

  private async processJob(context: RunContext, job: IndexJob): Promise<void> {
    const absolutePath = job.filePath;
    if (!existsSync(absolutePath)) {
      this.processRemovedFile(context, job.filePath);
      return;
    }

    this.checkpoints.ensureTrackedFile(job.branch, job.filePath);

    const fileContent = readFileSync(absolutePath, "utf-8");
    const fileContentHash = hashContent(fileContent);
    const scanTimeHash = context.fileHashes.get(job.filePath);

    if (scanTimeHash && scanTimeHash !== fileContentHash) {
      // The working tree drifted after the Merkle scan that produced this run's
      // file list. We contain that drift by deferring the file into the next
      // serialized hot-update pass instead of indexing newer bytes under stale
      // diff/branch assumptions. Full mid-run preemption is not implemented in
      // this architecture because indexing remains serialized behind the FIFO lock.
      this.deferHotUpdatePath(context.branch, job.filePath);
      context.deferredHotUpdatePaths.add(job.filePath);
      this.host.logger.info("Deferring file that changed after scan", {
        branch: context.branch,
        filePath: job.filePath,
        runId: context.runId,
        runType: context.runType,
        scanTimeHash,
        observedHash: fileContentHash,
      });
      return;
    }

    const chunkInputHash = buildChunkStageInputHash(
      fileContentHash,
      context.configVersion.chunkerVersion
    );

    const filePlan = await this.buildFileJobPlan(
      context,
      job.filePath,
      absolutePath,
      fileContent,
      fileContentHash,
      chunkInputHash
    );

    try {
      if (filePlan.voyageDebtChunks.length > 0) {
        await this.processVoyageDebtFile(context, job.filePath, filePlan);
        return;
      }
      await this.processEmbedStage(context, job.filePath, filePlan);
      await this.processIndexStage(context, job.filePath, filePlan);
      await this.processGraphStage(context, job.filePath, fileContent, fileContentHash, filePlan);
      this.recordSuccessfulFile(
        context,
        job.filePath,
        fileContentHash,
        Buffer.byteLength(fileContent, "utf-8"),
        filePlan
      );
    } catch (error) {
      this.rollbackMaterializedChunksForFile(context, filePlan);
      throw error;
    }
  }

  private async buildFileJobPlan(
    context: RunContext,
    filePath: string,
    absolutePath: string,
    fileContent: string,
    fileContentHash: string,
    chunkInputHash: string
  ): Promise<FileJobPlan> {
    const oldChunkIds = new Set(context.existingChunksByFile.get(filePath) ?? []);
    const oldSymbolIds = new Set(
      context.database
        .getSymbolsByFile(filePath)
        .map((symbol) => symbol.id)
        .filter((symbolId) => context.branchSymbolIds.has(symbolId))
    );
    for (const chunkId of oldChunkIds) {
      context.oldChunkIdsForTouchedFiles.add(chunkId);
    }
    for (const symbolId of oldSymbolIds) {
      context.oldSymbolIdsForTouchedFiles.add(symbolId);
    }

    let parsedFile: OrchestratorParsedFile | null = null;
    let currentChunks: ChunkRecord[] = [];
    let dirtyChunks: EmbeddingWorkChunk[] = [];
    let voyageDebtChunks: EmbeddingWorkChunk[] = [];
    let removedChunkIds = new Set<string>();
    let chunkRan = false;
    let indexNeedsUpdate = false;

    if (this.checkpoints.isStageStale(context.branch, filePath, "chunk", chunkInputHash)) {
      this.checkpoints.markStageInProgress(context.branch, filePath, "chunk", chunkInputHash);
      const parsed = this.host.parseFilesForIndexing([
        {
          path: absolutePath,
          content: fileContent,
          hash: fileContentHash,
        },
      ]);
      context.stats.parseFailures.push(...parsed.failedFilePaths);
      if (parsed.failedFilePaths.length > 0 || parsed.parsedFiles.length !== 1) {
        const error = `Chunking failed for ${filePath}`;
        this.checkpoints.markStageFailed(context.branch, filePath, "chunk", error, chunkInputHash);
        throw new Error(error);
      }

      parsedFile = parsed.parsedFiles[0] ?? null;
      currentChunks = this.buildChunkRecords(
        absolutePath,
        parsedFile,
        this.getEffectiveEmbeddingMaxTokens(context),
        {
          branch: context.branch,
          database: context.database,
        }
      );
      const diff = this.diffChunksForFile(currentChunks, oldChunkIds, context);
      dirtyChunks = diff.dirtyChunks;
      removedChunkIds = diff.removedChunkIds;
      indexNeedsUpdate = dirtyChunks.length > 0 || removedChunkIds.size > 0;

      const chunkRows: ChunkData[] = currentChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        contentHash: chunk.contentHash,
        embeddingInputHash: chunk.embeddingInputHash,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        nodeType: chunk.nodeType,
        name: chunk.name,
        chunkKind: chunk.chunkKind,
        symbolKind: chunk.symbolKind,
        language: chunk.language,
      }));
      context.database.upsertChunksBatch(chunkRows);
      this.checkpoints.markStageComplete(context.branch, filePath, "chunk", chunkInputHash);
      chunkRan = true;
    } else {
      currentChunks = this.loadCurrentBranchChunkRecords(context, filePath);
    }

    const embedConfigHash = hashEmbedConfig(
      context.configuredProviderInfo,
      context.voyageModelId,
      this.getActiveVoyageMaxTokens(context)
    );
    const currentEmbeddingInputHashes = currentChunks.map(
      (chunk) => chunk.embeddingInputHash
    );
    const embedStageInputHash = buildEmbedStageInputHash(
      currentEmbeddingInputHashes,
      embedConfigHash
    );
    const indexStageInputHash = buildIndexStageInputHash(
      currentEmbeddingInputHashes,
      embedConfigHash
    );
    const embedStageIsStale = this.checkpoints.isStageStale(
      context.branch,
      filePath,
      "embed",
      embedStageInputHash
    );
    const activeVoyageDebt = context.activeVoyageDebtByFile.get(filePath) ?? null;

    if (!chunkRan && embedStageIsStale) {
      const reparsed = this.host.parseFilesForIndexing([
        {
          path: absolutePath,
          content: fileContent,
          hash: fileContentHash,
        },
      ]);
      context.stats.parseFailures.push(...reparsed.failedFilePaths);
      parsedFile = reparsed.parsedFiles[0] ?? null;
      if (!parsedFile) {
        const error = `Chunking failed while rebuilding embed plan for ${filePath}`;
        this.checkpoints.markStageFailed(context.branch, filePath, "embed", error, embedStageInputHash);
        throw new Error(error);
      }
      currentChunks = this.buildChunkRecords(
        absolutePath,
        parsedFile,
        this.getEffectiveEmbeddingMaxTokens(context),
        {
          branch: context.branch,
          database: context.database,
        }
      );
      dirtyChunks = currentChunks.map((chunk) => this.toEmbeddingWorkChunk(chunk));
      indexNeedsUpdate = dirtyChunks.length > 0 || removedChunkIds.size > 0;
    } else if (chunkRan && embedStageIsStale && dirtyChunks.length === 0) {
      dirtyChunks = currentChunks.map((chunk) => this.toEmbeddingWorkChunk(chunk));
      indexNeedsUpdate = dirtyChunks.length > 0 || removedChunkIds.size > 0;
    } else if (!chunkRan && !embedStageIsStale && activeVoyageDebt) {
      voyageDebtChunks = this.loadVoyageDebtChunksForFile(context, filePath, currentChunks);
    }

    context.stats.totalChunks += currentChunks.length;

    return {
      parsedFile,
      currentChunks,
      dirtyChunks,
      voyageDebtChunks,
      removedChunkIds,
      oldChunkIds,
      oldSymbolIds,
      newSymbolIds: new Set<string>(),
      primaryMaterializedChunkIds: new Set<string>(),
      embedStageInputHash,
      indexStageInputHash,
      chunkRan,
      indexNeedsUpdate,
      indexStarted: false,
      activeVoyageDebt,
    };
  }

  private async processEmbedStage(
    context: RunContext,
    filePath: string,
    plan: FileJobPlan
  ): Promise<void> {
    const embedStageIsStale = this.checkpoints.isStageStale(
      context.branch,
      filePath,
      "embed",
      plan.embedStageInputHash
    );
    if (plan.dirtyChunks.length === 0) {
      if (embedStageIsStale) {
        this.checkpoints.markStageInProgress(
          context.branch,
          filePath,
          "embed",
          plan.embedStageInputHash
        );
        this.checkpoints.markStageComplete(
          context.branch,
          filePath,
          "embed",
          plan.embedStageInputHash
        );
      }
      return;
    }

    const embedNeedsWork =
      plan.chunkRan || embedStageIsStale;

    if (!embedNeedsWork) {
      return;
    }

    this.checkpoints.markStageInProgress(
      context.branch,
      filePath,
      "embed",
      plan.embedStageInputHash
    );

    const { store, invertedIndex, database, provider } = context;
    const arcticModelId = context.configuredProviderInfo.modelInfo.model;
    const voyageProvider = context.voyageProvider;
    const voyageStore = context.voyageStore;
    const voyageModelId = context.voyageModelId;
    const voyageEnabled = Boolean(voyageProvider && voyageStore && voyageModelId);
    const requiredVoyageHashes = voyageEnabled
      ? new Set(plan.dirtyChunks.map((chunk) => chunk.embeddingInputHash))
      : new Set<string>();
    const completedVoyageHashes = new Set<string>();
    let voyageDebtReason: string | null = null;
    const embeddingInputHashes = plan.dirtyChunks.map(
      (chunk) => chunk.embeddingInputHash
    );
    const missingArcticEmbeddings = context.forceFreshPrimaryEmbeddings
      ? new Set(embeddingInputHashes)
      : new Set(
          database.getMissingEmbeddingsForModel(
            embeddingInputHashes,
            arcticModelId
          )
        );
    const missingVoyageEmbeddings = voyageEnabled && voyageModelId
      ? context.forceFreshVoyageEmbeddings
        ? new Set(embeddingInputHashes)
        : new Set(
            database.getMissingEmbeddingsForModel(
              embeddingInputHashes,
              voyageModelId
            )
          )
      : new Set<string>();
    const embeddingQueue = new PQueue(
      this.host.getProviderRateLimits(context.configuredProviderInfo.provider)
    );

    const cachedArcticHashes = context.forceFreshPrimaryEmbeddings
      ? []
      : Array.from(
          new Set(
            plan.dirtyChunks
              .filter((chunk) => !missingArcticEmbeddings.has(chunk.embeddingInputHash))
              .map((chunk) => chunk.embeddingInputHash)
          )
        );
    const cachedArcticEmbeddings = database.getEmbeddingsForModelBatch(
      cachedArcticHashes,
      arcticModelId
    );
    const cachedVoyageHashes = voyageEnabled && voyageModelId && !context.forceFreshVoyageEmbeddings
      ? Array.from(
          new Set(
            plan.dirtyChunks
              .filter((chunk) => !missingVoyageEmbeddings.has(chunk.embeddingInputHash))
              .map((chunk) => chunk.embeddingInputHash)
          )
        )
      : [];
    const cachedVoyageEmbeddings = voyageEnabled && voyageModelId
      ? database.getEmbeddingsForModelBatch(cachedVoyageHashes, voyageModelId)
      : new Map<string, Buffer>();

    for (const chunk of plan.dirtyChunks) {
      if (!missingArcticEmbeddings.has(chunk.embeddingInputHash)) {
        const embeddingBuffer = cachedArcticEmbeddings.get(chunk.embeddingInputHash);
        if (!embeddingBuffer) {
          const error =
            `Missing cached ${arcticModelId} embedding for ${chunk.embeddingInputHash}`;
          this.checkpoints.markStageFailed(
            context.branch,
            filePath,
            "embed",
            error,
            plan.embedStageInputHash
          );
          throw new Error(error);
        }
        const vector = Array.from(
          new Float32Array(
            embeddingBuffer.buffer,
            embeddingBuffer.byteOffset,
            embeddingBuffer.byteLength / 4
          )
        );
        store.add(chunk.id, vector, chunk.metadata);
        invertedIndex.removeChunk(chunk.id);
        invertedIndex.addChunk(chunk.id, chunk.content);
        plan.primaryMaterializedChunkIds.add(chunk.id);
        context.stats.existingChunks += 1;
        context.stats.indexedChunks += 1;
      }

      if (
        voyageEnabled &&
        voyageStore &&
        !missingVoyageEmbeddings.has(chunk.embeddingInputHash)
      ) {
        const embeddingBuffer = cachedVoyageEmbeddings.get(chunk.embeddingInputHash);
        if (!embeddingBuffer) {
          this.host.logger.warn("Voyage cached embedding missing; scheduling re-embed for batch", {
            chunkId: chunk.id,
            filePath,
            model: voyageModelId,
          });
          missingVoyageEmbeddings.add(chunk.embeddingInputHash);
          continue;
        }

        const vector = Array.from(
          new Float32Array(
            embeddingBuffer.buffer,
            embeddingBuffer.byteOffset,
            embeddingBuffer.byteLength / 4
          )
        );
        voyageStore.add(chunk.id, vector, chunk.metadata);
        completedVoyageHashes.add(chunk.embeddingInputHash);
      }
    }

    const batches = createDynamicBatches(
      plan.dirtyChunks
        .filter(
          (chunk) =>
            missingArcticEmbeddings.has(chunk.embeddingInputHash) ||
            (voyageEnabled && missingVoyageEmbeddings.has(chunk.embeddingInputHash))
        ),
      this.getEffectiveEmbeddingMaxTokens(context)
    );

    try {
      for (const batch of batches) {
        await embeddingQueue.add(async () => {
          const arcticBatch = batch.filter((chunk) =>
            missingArcticEmbeddings.has(chunk.embeddingInputHash)
          );
          const voyageBatch = voyageEnabled
            ? batch.filter((chunk) =>
                missingVoyageEmbeddings.has(chunk.embeddingInputHash)
              )
            : [];

          const [arcticOutcome, voyageOutcome] = await Promise.allSettled([
            arcticBatch.length > 0
              ? pRetry(
                  async () => provider.embedBatch(arcticBatch.map((chunk) => chunk.text)),
                  {
                    retries: 3,
                    onFailedAttempt: (error) => {
                      if (error instanceof CustomProviderNonRetryableError) {
                        throw error;
                      }
                    },
                  }
                )
              : Promise.resolve(null),
            voyageEnabled && voyageProvider && voyageBatch.length > 0
              ? voyageProvider
                  .embedBatch(voyageBatch.map((chunk) => chunk.text))
                  .catch((error: unknown) => {
                    this.host.logger.warn(
                      "Voyage embedding batch threw unexpectedly; continuing with Arctic only",
                      {
                        batchSize: voyageBatch.length,
                        error: getErrorMessage(error),
                        filePath,
                        model: voyageModelId,
                      }
                    );
                    return null;
                  })
              : Promise.resolve(null),
          ]);

          let arcticFailure: unknown = null;
          let voyageFailure: unknown = null;

          if (arcticBatch.length > 0) {
            if (arcticOutcome.status === "fulfilled") {
              try {
                const arcticVectors = arcticOutcome.value?.embeddings ?? [];
                const arcticItems = arcticBatch.map((chunk, index) => {
                  const vector = arcticVectors[index];
                  if (!vector) {
                    throw new Error(`Missing embedding vector for ${chunk.id}`);
                  }
                  return {
                    id: chunk.id,
                    vector,
                    metadata: chunk.metadata,
                  };
                });
                store.addBatch(arcticItems);
                database.upsertEmbeddingsBatch(
                  arcticBatch.map((chunk, index) => ({
                    embeddingInputHash: chunk.embeddingInputHash,
                    contentHash: chunk.contentHash,
                    embedding: Buffer.from(new Float32Array(arcticVectors[index] ?? []).buffer),
                    chunkText: chunk.content,
                    model: arcticModelId,
                  }))
                );
                for (const chunk of arcticBatch) {
                  invertedIndex.removeChunk(chunk.id);
                  invertedIndex.addChunk(chunk.id, chunk.content);
                  plan.primaryMaterializedChunkIds.add(chunk.id);
                }
                context.stats.indexedChunks += arcticBatch.length;
                context.stats.tokensUsed += arcticOutcome.value?.totalTokensUsed ?? 0;
                this.host.logger.recordChunksEmbedded(arcticBatch.length);
                this.host.logger.recordEmbeddingApiCall(arcticOutcome.value?.totalTokensUsed ?? 0);
              } catch (error) {
                arcticFailure = error;
              }
            } else {
              arcticFailure = arcticOutcome.reason;
            }
          }

          if (voyageEnabled && voyageStore && voyageModelId && voyageBatch.length > 0) {
            if (voyageOutcome.status === "rejected") {
              voyageFailure = voyageOutcome.reason;
              this.host.logger.warn(
                "Voyage embeddings unavailable for batch; continuing with Arctic-only indexing",
                {
                  batchSize: voyageBatch.length,
                  filePath,
                  model: voyageModelId,
                  error: getErrorMessage(voyageOutcome.reason),
                }
              );
            } else if (!voyageOutcome.value) {
              voyageFailure = new Error("Voyage provider returned no embeddings result");
              this.host.logger.warn(
                "Voyage embeddings unavailable for batch; continuing with Arctic-only indexing",
                {
                  batchSize: voyageBatch.length,
                  filePath,
                  model: voyageModelId,
                }
              );
            } else {
              try {
                const voyageVectors = voyageOutcome.value.embeddings;
                const voyageItems = voyageBatch.map((chunk, index) => {
                  const vector = voyageVectors[index];
                  if (!vector) {
                    throw new Error(`Missing Voyage embedding vector for ${chunk.id}`);
                  }
                  return {
                    id: chunk.id,
                    vector,
                    metadata: chunk.metadata,
                  };
                });
                voyageStore.addBatch(voyageItems);
                database.upsertEmbeddingsBatch(
                  voyageBatch.map((chunk, index) => ({
                    embeddingInputHash: chunk.embeddingInputHash,
                    contentHash: chunk.contentHash,
                    embedding: Buffer.from(new Float32Array(voyageVectors[index] ?? []).buffer),
                    chunkText: chunk.content,
                    model: voyageModelId,
                  }))
                );
                for (const chunk of voyageBatch) {
                  completedVoyageHashes.add(chunk.embeddingInputHash);
                }
                context.stats.tokensUsed += voyageOutcome.value.totalTokensUsed;
                this.host.logger.recordEmbeddingApiCall(voyageOutcome.value.totalTokensUsed);
              } catch (error) {
                voyageFailure = error;
                this.host.logger.warn(
                  "Voyage embedding batch persistence failed; continuing with Arctic-only indexing",
                  {
                    batchSize: voyageBatch.length,
                    filePath,
                    model: voyageModelId,
                    error: getErrorMessage(error),
                  }
                );
              }
            }
          }

          if (voyageFailure) {
            voyageDebtReason = getErrorMessage(voyageFailure);
            this.host.logger.recordEmbeddingError();
          }

          if (arcticFailure) {
            throw arcticFailure;
          }
        });
      }
    } catch (error) {
      this.host.logger.recordEmbeddingError();
      this.host.addFailedBatch(
        plan.dirtyChunks.filter(
          (chunk) =>
            missingArcticEmbeddings.has(chunk.embeddingInputHash) ||
            missingVoyageEmbeddings.has(chunk.embeddingInputHash)
        ),
        getErrorMessage(error)
      );
      this.checkpoints.markStageFailed(
        context.branch,
        filePath,
        "embed",
        getErrorMessage(error),
        plan.embedStageInputHash
      );
      if (voyageEnabled && voyageModelId) {
        const voyageFileComplete =
          completedVoyageHashes.size === requiredVoyageHashes.size;
        if (voyageFileComplete) {
          this.clearVoyageEmbeddingDebt(context, filePath, voyageModelId);
        } else {
          this.recordVoyageEmbeddingDebt(
            context,
            filePath,
            voyageModelId,
            voyageDebtReason ??
              "Voyage embedding incomplete because the file-level embed run exited before all Voyage batches completed"
          );
        }
      }
      throw error;
    }

    if (voyageEnabled && voyageModelId) {
      const voyageFileComplete =
        completedVoyageHashes.size === requiredVoyageHashes.size;
      if (voyageFileComplete) {
        this.clearVoyageEmbeddingDebt(context, filePath, voyageModelId);
      } else if (voyageDebtReason) {
        this.recordVoyageEmbeddingDebt(context, filePath, voyageModelId, voyageDebtReason);
      }
    }

    this.checkpoints.markStageComplete(
      context.branch,
      filePath,
      "embed",
      plan.embedStageInputHash
    );
  }

  private async processVoyageDebtFile(
    context: RunContext,
    filePath: string,
    plan: FileJobPlan
  ): Promise<void> {
    const voyageProvider = context.voyageProvider;
    const voyageStore = context.voyageStore;
    const voyageModelId = context.voyageModelId;
    if (!voyageProvider || !voyageStore || !voyageModelId) {
      return;
    }

    if (plan.voyageDebtChunks.length === 0) {
      this.clearVoyageEmbeddingDebt(context, filePath, voyageModelId);
      return;
    }

    const batches = createDynamicBatches(
      plan.voyageDebtChunks,
      this.getEffectiveEmbeddingMaxTokens(context)
    );
    const embeddingQueue = new PQueue(
      this.host.getProviderRateLimits(context.configuredProviderInfo.provider)
    );

    try {
      for (const batch of batches) {
        await embeddingQueue.add(async () => {
          let voyageResponse;
          try {
            voyageResponse = await voyageProvider.embedBatch(batch.map((chunk) => chunk.text));
          } catch (error) {
            const reason = getErrorMessage(error);
            this.recordVoyageEmbeddingDebt(context, filePath, voyageModelId, reason);
            this.host.logger.warn(
              "Voyage debt healing batch failed; retaining debt for a later retry",
              {
                batchSize: batch.length,
                filePath,
                model: voyageModelId,
                error: reason,
              }
            );
            throw error;
          }

          if (!voyageResponse) {
            const reason = "Voyage provider returned no embeddings result";
            this.recordVoyageEmbeddingDebt(context, filePath, voyageModelId, reason);
            this.host.logger.warn(
              "Voyage debt healing batch returned no result; retaining debt for a later retry",
              {
                batchSize: batch.length,
                filePath,
                model: voyageModelId,
              }
            );
            throw new Error(reason);
          }

          try {
            const voyageVectors = voyageResponse.embeddings;
            const voyageItems = batch.map((chunk, index) => {
              const vector = voyageVectors[index];
              if (!vector) {
                throw new Error(`Missing Voyage embedding vector for ${chunk.id}`);
              }
              return {
                id: chunk.id,
                vector,
                metadata: chunk.metadata,
              };
            });
            voyageStore.addBatch(voyageItems);
            context.database.upsertEmbeddingsBatch(
              batch.map((chunk, index) => ({
                embeddingInputHash: chunk.embeddingInputHash,
                contentHash: chunk.contentHash,
                embedding: Buffer.from(new Float32Array(voyageVectors[index] ?? []).buffer),
                chunkText: chunk.content,
                model: voyageModelId,
              }))
            );
            context.stats.tokensUsed += voyageResponse.totalTokensUsed;
            this.host.logger.recordEmbeddingApiCall(voyageResponse.totalTokensUsed);
          } catch (error) {
            const reason = getErrorMessage(error);
            this.recordVoyageEmbeddingDebt(context, filePath, voyageModelId, reason);
            this.host.logger.warn(
              "Voyage debt healing persistence failed; retaining debt for a later retry",
              {
                batchSize: batch.length,
                filePath,
                model: voyageModelId,
                error: reason,
              }
            );
            throw error;
          }
        });
      }
    } catch (error) {
      this.host.logger.recordEmbeddingError();
      this.host.addFailedBatch(plan.voyageDebtChunks, getErrorMessage(error));
      throw error;
    }

    this.clearVoyageEmbeddingDebt(context, filePath, voyageModelId);
  }

  private async processIndexStage(
    context: RunContext,
    filePath: string,
    plan: FileJobPlan
  ): Promise<void> {
    const stageIsStale = this.checkpoints.isStageStale(
      context.branch,
      filePath,
      "index",
      plan.indexStageInputHash
    );
    if (!plan.indexNeedsUpdate && !stageIsStale) {
      return;
    }

    this.checkpoints.markStageInProgress(
      context.branch,
      filePath,
      "index",
      plan.indexStageInputHash
    );
    plan.indexStarted = true;
  }

  private async processGraphStage(
    context: RunContext,
    filePath: string,
    fileContent: string,
    fileContentHash: string,
    plan: FileJobPlan
  ): Promise<void> {
    const graphInputHash = buildGraphStageInputHash(
      fileContentHash,
      context.configVersion.graphExtractorVersion
    );
    if (!this.checkpoints.isStageStale(context.branch, filePath, "graph", graphInputHash)) {
      return;
    }

    this.checkpoints.markStageInProgress(
      context.branch,
      filePath,
      "graph",
      graphInputHash
    );

    try {
      const parsedFile =
        plan.parsedFile ??
        this.host.parseFilesForIndexing([
          {
            path: filePath,
            content: fileContent,
            hash: fileContentHash,
          },
        ]).parsedFiles[0];

      if (!parsedFile) {
        throw new Error(`Graph parsing failed for ${filePath}`);
      }

      // Deviation from the Step 4 placeholder: this codebase already has call graph
      // extraction in production, and keeping it active avoids regressing existing behavior.
      const graph = this.host.buildFileGraphData([parsedFile]).get(parsedFile.path);
      for (const symbolId of plan.oldSymbolIds) {
        this.host.clearCallEdgesForSymbolIfUnreferenced(context.database, symbolId);
      }

      plan.newSymbolIds.clear();
      if (graph) {
        if (graph.symbols.length > 0) {
          context.database.upsertSymbolsBatch(graph.symbols);
        }
        if (graph.edges.length > 0) {
          const edgesToPersist: CallEdgeData[] = graph.edges.map((edge) => ({
            ...edge,
            branch: context.branch,
            callerFilePath: edge.callerFilePath ?? filePath,
            targetFilePath: edge.targetFilePath,
            targetKind: edge.targetKind,
          }));
          context.database.upsertCallEdgesBatch(edgesToPersist);
        }
        for (const symbol of graph.symbols) {
          plan.newSymbolIds.add(symbol.id);
        }
      }

      this.checkpoints.markStageComplete(context.branch, filePath, "graph", graphInputHash);
    } catch (error) {
      this.checkpoints.markStageFailed(
        context.branch,
        filePath,
        "graph",
        getErrorMessage(error),
        graphInputHash
      );
      throw error;
    }
  }

  private processRemovedFile(context: RunContext, filePath: string): void {
    const oldChunkIds = new Set(context.existingChunksByFile.get(filePath) ?? []);
    const oldSymbolIds = new Set(
      context.database
        .getSymbolsByFile(filePath)
        .map((symbol) => symbol.id)
        .filter((symbolId) => context.branchSymbolIds.has(symbolId))
    );

    for (const chunkId of oldChunkIds) {
      context.oldChunkIdsForTouchedFiles.add(chunkId);
      context.currentChunkIds.delete(chunkId);
      context.branchChunkIds.delete(chunkId);
    }
    for (const symbolId of oldSymbolIds) {
      context.oldSymbolIdsForTouchedFiles.add(symbolId);
      context.allSymbolIds.delete(symbolId);
    }

    context.existingChunksByFile.delete(filePath);
    context.removedAbsolutePaths.add(filePath);
    context.removedRelativePaths.add(toRelativePath(this.host.getProjectRoot(), filePath));
    context.activeVoyageDebtByFile.delete(filePath);
    context.initialVoyageDebtFiles.delete(filePath);
    context.healedVoyageDebtFiles.delete(filePath);
    context.database.clearChunkCapDrop(context.branch, filePath);
    clearWatcherEventTimestamp(filePath);
    this.checkpoints.clearFileState(context.branch, filePath);
  }

  private buildChunkRecords(
    absolutePath: string,
    parsedFile: OrchestratorParsedFile,
    embeddingMaxTokens: number,
    persistence?: {
      branch: string;
      database: Database;
    }
  ): ChunkRecord[] {
    const filterResult = applyChunkFilters(parsedFile.chunks, this.host.getConfig());
    if (filterResult.capped) {
      this.host.logger.warn("Per-file chunk cap reached; dropping lower-priority chunks", {
        filePath: parsedFile.path,
        maxChunksPerFile: this.host.getConfig().indexing.maxChunksPerFile,
        eligibleChunks: filterResult.eligibleCount,
        keptChunks: filterResult.chunks.length,
        droppedChunks: filterResult.droppedCount,
        droppedNamedChunks: filterResult.droppedNamedCount,
        droppedAnonymousChunks: filterResult.droppedAnonymousCount,
      });
      if (persistence) {
        persistence.database.upsertChunkCapDrop(
          persistence.branch,
          parsedFile.path,
          this.host.getConfig().indexing.maxChunksPerFile,
          filterResult.chunks.length,
          filterResult.droppedCount,
          filterResult.droppedNamedSymbols
        );
      }
    } else if (persistence) {
      persistence.database.clearChunkCapDrop(persistence.branch, parsedFile.path);
    }

    return filterResult.chunks.map((chunk) => {
      const embeddingChunk = {
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkType: chunk.chunkType,
        name: chunk.name,
        symbolKind: chunk.symbolKind as ChunkSymbolKind | undefined,
        language: chunk.language,
      };
      const embeddingInput = prepareEmbeddingInput(
        embeddingChunk,
        parsedFile.path,
        this.host.getProjectRoot(),
        embeddingMaxTokens
      );
      return {
        chunkId: generateChunkId(absolutePath, embeddingChunk),
        contentHash: hashContent(chunk.content),
        embeddingInputHash: embeddingInput.hash,
        embeddingText: embeddingInput.text,
        filePath: parsedFile.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        nodeType: chunk.chunkType,
        name: chunk.name,
        chunkKind: chunk.chunkKind,
        symbolKind: chunk.symbolKind,
        language: chunk.language,
        text: chunk.content,
        chunkHash: chunk.chunkHash,
      };
    });
  }

  private diffChunksForFile(
    currentChunks: ChunkRecord[],
    oldChunkIds: Set<string>,
    context: RunContext
  ): {
    dirtyChunks: EmbeddingWorkChunk[];
    removedChunkIds: Set<string>;
  } {
    const newChunkIds = new Set(currentChunks.map((chunk) => chunk.chunkId));
    const dirtyChunks: EmbeddingWorkChunk[] = [];

    for (const chunk of currentChunks) {
      if (
        context.existingChunks.get(chunk.chunkId) === chunk.embeddingInputHash &&
        context.invertedIndex.hasChunk(chunk.chunkId)
      ) {
        continue;
      }
      dirtyChunks.push(this.toEmbeddingWorkChunk(chunk));
    }

    return {
      dirtyChunks,
      removedChunkIds: new Set(
        Array.from(oldChunkIds).filter((chunkId) => !newChunkIds.has(chunkId))
      ),
    };
  }

  private loadCurrentBranchChunkRecords(context: RunContext, filePath: string): ChunkRecord[] {
    return context.database
      .getChunksByFile(filePath)
      .filter((chunk) => context.branchChunkIds.has(chunk.chunkId))
      .map((chunk) => ({
        chunkId: chunk.chunkId,
        contentHash: chunk.contentHash,
        embeddingInputHash: chunk.embeddingInputHash,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        nodeType: chunk.nodeType,
        name: chunk.name,
        language: chunk.language,
        text: chunk.name ?? chunk.chunkId,
        chunkHash: chunk.contentHash,
      }));
  }

  private loadVoyageDebtChunksForFile(
    context: RunContext,
    filePath: string,
    currentChunks: ChunkRecord[]
  ): EmbeddingWorkChunk[] {
    if (currentChunks.length === 0) {
      return [];
    }

    const chunkTexts = context.database.getChunkTextsBatch(
      currentChunks.map((chunk) => chunk.embeddingInputHash)
    );

    return currentChunks.map((chunk) => {
      const chunkText = chunkTexts.get(chunk.embeddingInputHash);
      if (!chunkText) {
        throw new Error(
          `Missing stored chunk text for Voyage debt healing on ${filePath} (${chunk.embeddingInputHash})`
        );
      }

      return this.toEmbeddingWorkChunk({
        ...chunk,
        embeddingText: chunkText,
        text: chunkText,
      });
    });
  }

  private recordVoyageEmbeddingDebt(
    context: RunContext,
    filePath: string,
    model: string,
    reason: string
  ): void {
    context.database.recordEmbeddingDebt(context.branch, filePath, model, reason);
    context.activeVoyageDebtByFile.set(filePath, {
      branch: context.branch,
      filePath,
      model,
      reason,
      createdAt: Date.now(),
    });
    context.healedVoyageDebtFiles.delete(filePath);
  }

  private clearVoyageEmbeddingDebt(
    context: RunContext,
    filePath: string,
    model: string
  ): void {
    context.database.clearEmbeddingDebt(context.branch, filePath, model);
    context.activeVoyageDebtByFile.delete(filePath);
    if (context.initialVoyageDebtFiles.has(filePath)) {
      context.healedVoyageDebtFiles.add(filePath);
    }
  }

  private toEmbeddingWorkChunk(chunk: ChunkRecord): EmbeddingWorkChunk {
    if (!chunk.embeddingText) {
      throw new Error(`Missing precomputed embedding text for ${chunk.chunkId}`);
    }

    return {
      id: chunk.chunkId,
      text: chunk.embeddingText,
      content: chunk.text,
      contentHash: chunk.contentHash,
      embeddingInputHash: chunk.embeddingInputHash,
      metadata: {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkType: (chunk.nodeType as ChunkMetadata["chunkType"]) ?? "other",
        name: chunk.name,
        language: chunk.language,
        hash: chunk.embeddingInputHash,
      },
    };
  }

  private getStoredSnapshot(database: Database, branch: string): string | null {
    return database.getMerkleSnapshot(branch);
  }

  private recordSuccessfulFile(
    context: RunContext,
    filePath: string,
    fileContentHash: string,
    fileSizeBytes: number,
    plan: FileJobPlan
  ): void {
    for (const chunkId of plan.oldChunkIds) {
      context.currentChunkIds.delete(chunkId);
      context.branchChunkIds.delete(chunkId);
      context.existingChunks.delete(chunkId);
    }
    for (const chunk of plan.currentChunks) {
      context.currentChunkIds.add(chunk.chunkId);
      context.branchChunkIds.add(chunk.chunkId);
      context.existingChunks.set(chunk.chunkId, chunk.embeddingInputHash);
    }
    context.existingChunksByFile.set(
      filePath,
      new Set(plan.currentChunks.map((chunk) => chunk.chunkId))
    );

    for (const symbolId of plan.oldSymbolIds) {
      context.allSymbolIds.delete(symbolId);
      context.branchSymbolIds.delete(symbolId);
    }
    for (const symbolId of plan.newSymbolIds) {
      context.allSymbolIds.add(symbolId);
      context.branchSymbolIds.add(symbolId);
    }

    if (plan.indexStarted) {
      context.pendingIndexCompletions.set(filePath, {
        fileContentHash,
        inputHash: plan.indexStageInputHash,
      });
      context.observedSnapshotFiles.set(
        toRelativePath(this.host.getProjectRoot(), filePath),
        {
          hash: fileContentHash,
          sizeBytes: fileSizeBytes,
        }
      );
    }
  }

  private rollbackMaterializedChunksForFile(
    context: RunContext,
    plan: FileJobPlan
  ): void {
    // Preserve successful best-effort Voyage materialization when Arctic fails.
    // A failed file should roll back only the primary retrieval lane artifacts
    // that would otherwise surface stale or incomplete results.
    for (const chunkId of plan.primaryMaterializedChunkIds) {
      this.host.removeChunkFromRetrievalIfUnreferenced(
        context.database,
        context.invertedIndex,
        chunkId
      );
    }
  }

  private async finalizeRunContext(
    context: RunContext,
    onProgress?: ProgressCallback
  ): Promise<IndexStats> {
    this.checkpoints.markRunFinalizing(context.runId);
    const previousBranchChunkIds = new Set(context.branchChunkIds);
    const staleChunkIds = Array.from(context.oldChunkIdsForTouchedFiles).filter(
      (chunkId) => !context.currentChunkIds.has(chunkId)
    );
    for (const chunkId of staleChunkIds) {
      if (
        this.host.removeChunkFromRetrievalIfUnreferenced(
          context.database,
          context.invertedIndex,
          chunkId
        )
      ) {
        context.stats.removedChunks += 1;
      }
    }

    const staleSymbolIds = Array.from(context.oldSymbolIdsForTouchedFiles).filter(
      (symbolId) => !context.allSymbolIds.has(symbolId)
    );
    for (const symbolId of staleSymbolIds) {
      this.host.removeSymbolFromGraphIfUnreferenced(context.database, symbolId);
    }

    context.database.clearBranch(context.branch);
    context.database.addChunksToBranchBatch(context.branch, Array.from(context.currentChunkIds));
    const addedBranchChunkIds = Array.from(context.currentChunkIds).filter(
      (chunkId) => !previousBranchChunkIds.has(chunkId)
    );
    const removedBranchChunkIds = Array.from(previousBranchChunkIds).filter(
      (chunkId) => !context.currentChunkIds.has(chunkId)
    );
    this.host.applyNativeBranchMembershipDelta(
      context.branch,
      addedBranchChunkIds,
      removedBranchChunkIds
    );
    context.database.clearBranchSymbols(context.branch);
    context.database.addSymbolsToBranchBatch(context.branch, Array.from(context.allSymbolIds));
    const resolvedCrossFileEdges = context.database.resolveUnresolvedCallEdgesForBranch(
      context.branch
    );
    if (resolvedCrossFileEdges > 0) {
      this.host.logger.branch("debug", "Resolved unresolved call edges for branch", {
        branch: context.branch,
        resolvedCrossFileEdges,
        runId: context.runId,
      });
    }

    if (staleChunkIds.length > 0) {
      // Branch membership is now authoritative for this run, so orphan GC can
      // safely remove chunk rows and embeddings that no branch references
      // anymore, including files deleted before a cold start begins.
      context.database.gcOrphanChunks();
      context.database.gcOrphanEmbeddings();
    }

    context.store.save();
    context.voyageStore?.save();
    context.invertedIndex.save();

    // This codebase persists branch membership and on-disk retrieval artifacts in
    // batch at run finalization, so INDEX completion is deferred until those
    // durable writes succeed.
    for (const [filePath, completion] of context.pendingIndexCompletions) {
      this.checkpoints.markStageComplete(
        context.branch,
        filePath,
        "index",
        completion.inputHash
      );
      context.successfulFileHashes.set(filePath, completion.fileContentHash);

      if (context.runType === "hot_update") {
        const watcherTimestamp = consumeWatcherEventTimestamp(filePath);
        if (watcherTimestamp !== undefined) {
          const ttiMs = Date.now() - watcherTimestamp;
          const exceededTarget = ttiMs > TTI_TARGET_MS;
          context.stats.ttiMeasurements?.push({
            filePath,
            durationMs: ttiMs,
            exceededTarget,
          });
          this.host.logger.recordHotUpdateTti(ttiMs, exceededTarget);
          this.host.logger.branch("debug", "Recorded hot update TTI", {
            branch: context.branch,
            filePath,
            runId: context.runId,
            ttiMs,
            targetMs: TTI_TARGET_MS,
          });
          if (exceededTarget) {
            this.host.logger.warn("Hot update TTI exceeded target", {
              branch: context.branch,
              filePath,
              runId: context.runId,
              ttiMs,
              targetMs: TTI_TARGET_MS,
            });
          }
        }
      }
    }

    this.host.commitFileHashChanges(context.successfulFileHashes, context.removedAbsolutePaths);

    const committedSnapshot = buildSnapshotFromObservedFileState({
      branch: context.branch,
      baseSnapshot: context.baseSnapshot,
      observedFiles: context.observedSnapshotFiles,
      removedRelativePaths: context.removedRelativePaths,
    });
    context.database.saveMerkleSnapshot(committedSnapshot);

    if (context.failedFiles.size === 0) {
      this.checkpoints.markBranchConfigApplied(context.branch, context.configHash);
      this.checkpoints.markRunComplete(context.runId);
    } else {
      this.checkpoints.markRunFailed(context.runId);
    }

    if (context.initialVoyageDebtFiles.size > 0 && context.voyageModelId) {
      this.host.logger.info(
        `Voyage embedding debt cleared: ${context.healedVoyageDebtFiles.size}/${context.initialVoyageDebtFiles.size} files healed`,
        {
          branch: context.branch,
          runId: context.runId,
          healedFiles: context.healedVoyageDebtFiles.size,
          totalDebtFiles: context.initialVoyageDebtFiles.size,
          model: context.voyageModelId,
        }
      );
    }

    this.applyPostFinalizationSideEffects(context.configuredProviderInfo);
    context.stats.durationMs = Date.now() - context.startTime;
    if (context.failedFiles.size > 0) {
      context.stats.failedBatchesPath = this.host.getFailedBatchesPath();
    }

    this.host.logger.recordIndexingEnd();
    this.host.logger.info("Incremental indexing run complete", {
      branch: context.branch,
      runId: context.runId,
      runType: context.runType,
      files: context.stats.totalFiles,
      indexed: context.stats.indexedChunks,
      removed: context.stats.removedChunks,
      failed: context.failedFiles.size,
      queueStarvationThresholdMs: LOW_PRIORITY_STARVATION_THRESHOLD_MS,
      coldStartBatchSize: COLD_START_BATCH_SIZE,
    });

    onProgress?.({
      phase: "complete",
      filesProcessed: context.stats.totalFiles,
      totalFiles: context.stats.totalFiles,
      chunksProcessed: context.stats.indexedChunks,
      totalChunks: context.stats.totalChunks,
    });

    return context.stats;
  }

  private applyPostFinalizationSideEffects(providerInfo: ConfiguredProviderInfo): void {
    this.host.saveIndexMetadata(providerInfo);
    this.host.markIndexCompatible();
  }
}
