import { existsSync, readFileSync } from "fs";
import * as path from "path";

import PQueue from "p-queue";
import pRetry from "p-retry";

import type { ConfiguredProviderInfo } from "../embeddings/detector.js";
import {
  buildMerkleSnapshot,
  createDynamicBatches,
  createEmbeddingText,
  diffMerkleSnapshots,
  generateChunkId,
  hashContent,
  type ChunkData,
  type ChunkMetadata,
  type Database,
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
} from "./job-queue.js";
import type { IndexStats, ProgressCallback } from "./index.js";

export interface OrchestratorParsedChunk {
  content: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  chunkType: ChunkMetadata["chunkType"];
  name?: string;
  language: string;
  chunkHash: string;
}

export interface OrchestratorParsedFile {
  path: string;
  hash: string;
  content: string;
  chunks: OrchestratorParsedChunk[];
}

export interface OrchestratorFileGraphData {
  symbols: SymbolData[];
  edges: CallEdgeData[];
}

export interface InitializationResources {
  store: VectorStore;
  provider: EmbeddingProviderInterface;
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
  setCurrentBranch(branch: string): void;
  refreshBranchInfo(): void;
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
    store: VectorStore,
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
    store: VectorStore,
    invertedIndex: InvertedIndex,
    chunkId: string
  ): boolean;
  clearCallEdgesForSymbolIfUnreferenced(database: Database, symbolId: string): boolean;
  removeSymbolFromGraphIfUnreferenced(database: Database, symbolId: string): boolean;
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
  removedChunkIds: Set<string>;
  oldChunkIds: Set<string>;
  oldSymbolIds: Set<string>;
  newSymbolIds: Set<string>;
  materializedChunkIds: Set<string>;
  embedStageInputHash: string;
  indexStageInputHash: string;
  chunkRan: boolean;
  indexNeedsUpdate: boolean;
  indexStarted: boolean;
}

interface ChunkRecord {
  chunkId: string;
  contentHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  language: string;
  text: string;
  chunkHash: string;
}

interface EmbeddingWorkChunk {
  id: string;
  text: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
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
  invertedIndex: InvertedIndex;
  database: Database;
  configuredProviderInfo: ConfiguredProviderInfo;
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
  failedFiles: Set<string>;
  deferredHotUpdatePaths: Set<string>;
  stats: IndexStats;
  baseSnapshot: string | null;
  fileHashes: Map<string, string>;
}

const COLD_START_BATCH_SIZE = 50;
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
  chunkHash: string,
  embedConfigHash: string
): string {
  return hashContent(chunkHash + embedConfigHash);
}

// pipeline_state is keyed per file, so EMBED identity must be aggregated from the
// file's current chunks rather than stored per chunk.
export function buildEmbedStageInputHash(
  chunkHashes: string[],
  embedConfigHash: string
): string {
  const chunkInputs = [...chunkHashes]
    .sort()
    .map((chunkHash) => buildChunkEmbedInputHash(chunkHash, embedConfigHash));
  return hashContent([embedConfigHash, ...chunkInputs].join("\n"));
}

// INDEX does not have an independent invalidation dimension in this codebase,
// but pipeline_state requires a concrete non-null hash. We persist the current
// file-level embed identity so the checkpoint row stays verifiable.
export function buildIndexStageInputHash(
  chunkHashes: string[],
  embedConfigHash: string
): string {
  return buildEmbedStageInputHash(chunkHashes, embedConfigHash);
}

export function buildGraphStageInputHash(
  fileContentHash: string,
  graphExtractorVersion: string
): string {
  return hashContent(fileContentHash + graphExtractorVersion);
}

function applyChunkFilters(
  chunks: OrchestratorParsedChunk[],
  config: ParsedCodebaseIndexConfig
): OrchestratorParsedChunk[] {
  const filtered: OrchestratorParsedChunk[] = [];
  let fileChunkCount = 0;

  for (const chunk of chunks) {
    if (fileChunkCount >= config.indexing.maxChunksPerFile) {
      break;
    }

    if (config.indexing.semanticOnly && chunk.chunkType === "other") {
      continue;
    }

    filtered.push(chunk);
    fileChunkCount += 1;
  }

  return filtered;
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
  };
}

export class IncrementalIndexOrchestrator {
  private checkpointManager: CheckpointManager | null = null;
  private readonly queue = new JobQueue();
  private readonly pendingHotUpdatePaths = new Map<string, Set<string>>();
  private startupComplete = false;
  private forceColdStart = false;

  constructor(private readonly host: IncrementalIndexOrchestratorHost) {}

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
      const configVersion = await getCurrentConfigVersion(resources.configuredProviderInfo);
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

      for (const filePath of fileHashes.keys()) {
        this.checkpoints.ensureTrackedFile(branch, filePath);
        this.queue.enqueue({
          branch,
          filePath,
          priority: "low",
          trigger: "cold_start",
          runId: run.runId,
        });
      }

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

      context.stats.totalFiles = fileHashes.size;
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
      const configVersion = await getCurrentConfigVersion(resources.configuredProviderInfo);
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

      for (const filePath of touchedFiles) {
        this.queue.enqueue({
          branch,
          filePath,
          priority: "high",
          trigger: "watcher_event",
          runId: run.runId,
        });
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
      context.stats.totalFiles = touchedFiles.length;
      await this.drainRunContext(context);
      return this.finalizeRunContext(context);
    });
  }

  async handleBranchChange(oldBranch: string | null, newBranch: string): Promise<void> {
    await this.ensureStartupState();

    const resources = await this.prepareRun();
    if (oldBranch) {
      this.checkpoints.cancelActiveRuns(oldBranch);
      this.queue.purgeBranch(oldBranch);
      this.pendingHotUpdatePaths.delete(oldBranch);
    }
    const { database } = resources;
    const storedSnapshot = database.getMerkleSnapshot(newBranch);
    this.host.setCurrentBranch(newBranch);

    if (!storedSnapshot) {
      await this.coldStart();
      return;
    }

    const currentSnapshot = await buildMerkleSnapshot(
      this.host.getProjectRoot(),
      newBranch,
      this.host.buildMerkleIgnoreRules()
    );
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
    branch: string,
    oldConfig: ReturnType<CheckpointManager["getActiveConfigVersion"]>,
    newConfig: ConfigVersion,
    newConfigHash: string
  ): Promise<void> {
    const knownFiles = this.checkpoints
      .getKnownFiles(branch)
      .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath));
    if (knownFiles.length === 0) {
      this.checkpoints.activateConfigVersion(newConfigHash, newConfig);
      return;
    }

    const chunkChanged = oldConfig?.chunkerVersion !== newConfig.chunkerVersion;
    const graphChanged = oldConfig?.graphExtractorVersion !== newConfig.graphExtractorVersion;
    const embedChanged = oldConfig
      ? oldConfig.configHash !== newConfigHash &&
        !chunkChanged &&
        !graphChanged
      : false;

    if (!chunkChanged && !embedChanged && !graphChanged) {
      this.checkpoints.activateConfigVersion(newConfigHash, newConfig);
      return;
    }

    if (chunkChanged) {
      this.checkpoints.resetStageType(branch, "chunk");
    }
    if (embedChanged) {
      this.checkpoints.resetStageType(branch, "embed");
      this.checkpoints.resetStageType(branch, "index");
    }
    if (graphChanged) {
      this.checkpoints.resetStageType(branch, "graph");
    }

    this.checkpoints.activateConfigVersion(newConfigHash, newConfig);

    const resources = await this.prepareRun();
    const run = this.checkpoints.startRun(branch, "config_change", newConfigHash);
    const snapshot = this.getStoredSnapshot(resources.database, branch);
    const fileHashes = snapshot
      ? toAbsoluteFileHashes(this.host.getProjectRoot(), snapshot)
      : new Map<string, string>();

    for (const filePath of knownFiles) {
      this.checkpoints.ensureTrackedFile(branch, filePath);
      this.queue.enqueue({
        branch,
        filePath,
        priority: "normal",
        trigger: "config_change",
        runId: run.runId,
      });
    }

    const context = this.createRunContext({
      ...resources,
      branch,
      runId: run.runId,
      runType: "config_change",
      configVersion: newConfig,
      configHash: newConfigHash,
      baseSnapshot: snapshot,
      fileHashes,
    });
    context.stats.totalFiles = knownFiles.length;
    await this.drainRunContext(context);
    await this.finalizeRunContext(context);
  }

  private async ensureStartupState(): Promise<void> {
    if (this.startupComplete) {
      return;
    }

    const resources = await this.prepareRun();
    const branch = this.host.getCurrentBranch();
    const currentConfig = await getCurrentConfigVersion(resources.configuredProviderInfo);
    const currentConfigHash = hashConfigVersion(currentConfig);
    const activeConfig = this.checkpoints.getActiveConfigVersion();

    if (!activeConfig || activeConfig.configHash !== currentConfigHash) {
      await this.handleConfigChange(branch, activeConfig, currentConfig, currentConfigHash);
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

      const unfinishedFiles = this.checkpoints
        .getUnfinishedFiles(run.branch)
        .map((filePath) => toAbsolutePath(this.host.getProjectRoot(), filePath));
      if (unfinishedFiles.length === 0) {
        this.checkpoints.markRunComplete(run.runId);
        continue;
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
      for (const filePath of unfinishedFiles) {
        this.queue.enqueue({
          branch: run.branch,
          filePath,
          priority: "normal",
          trigger: "crash_resume",
          runId: run.runId,
        });
      }

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
      context.stats.totalFiles = unfinishedFiles.length;
      await this.drainRunContext(context);
      await this.finalizeRunContext(context);
    }
  }

  private async prepareRun(): Promise<InitializationResources> {
    const resources = await this.host.ensureInitialized();
    this.getCheckpointManager(resources.database);
    this.host.refreshBranchInfo();
    this.host.assertIndexCompatible();
    return resources;
  }

  private createRunContext(args: {
    branch: string;
    runId: string;
    runType: PipelineRunType;
    configVersion: ConfigVersion;
    configHash: string;
    baseSnapshot: string | null;
    fileHashes: Map<string, string>;
  } & InitializationResources): RunContext {
    const branchChunkIds = new Set(args.database.getBranchChunkIds(args.branch));
    const { existingChunks, existingChunksByFile } = this.host.buildBranchStoreChunkMaps(
      args.store,
      branchChunkIds
    );
    const branchSymbolIds = new Set(args.database.getBranchSymbolIds(args.branch));

    this.host.loadFileHashCache();
    this.host.logger.recordIndexingStart();

    return {
      startTime: Date.now(),
      branch: args.branch,
      runId: args.runId,
      runType: args.runType,
      configVersion: args.configVersion,
      configHash: args.configHash,
      store: args.store,
      provider: args.provider,
      invertedIndex: args.invertedIndex,
      database: args.database,
      configuredProviderInfo: args.configuredProviderInfo,
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

  private async drainRunContext(context: RunContext): Promise<void> {
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
    });
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
      currentChunks = this.buildChunkRecords(absolutePath, parsedFile);
      const diff = this.diffChunksForFile(currentChunks, oldChunkIds, context);
      dirtyChunks = diff.dirtyChunks;
      removedChunkIds = diff.removedChunkIds;
      indexNeedsUpdate = dirtyChunks.length > 0 || removedChunkIds.size > 0;

      const chunkRows: ChunkData[] = currentChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        contentHash: chunk.contentHash,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        nodeType: chunk.nodeType,
        name: chunk.name,
        language: chunk.language,
      }));
      context.database.upsertChunksBatch(chunkRows);
      this.checkpoints.markStageComplete(context.branch, filePath, "chunk", chunkInputHash);
      chunkRan = true;
    } else {
      currentChunks = this.loadCurrentBranchChunkRecords(context, filePath);
    }

    const embedConfigHash = hashEmbedConfig(context.configuredProviderInfo);
    const currentChunkHashes = currentChunks.map((chunk) => chunk.chunkHash);
    const embedStageInputHash = buildEmbedStageInputHash(currentChunkHashes, embedConfigHash);
    const indexStageInputHash = buildIndexStageInputHash(currentChunkHashes, embedConfigHash);

    if (!chunkRan && this.checkpoints.isStageStale(context.branch, filePath, "embed", embedStageInputHash)) {
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
      currentChunks = this.buildChunkRecords(absolutePath, parsedFile);
      dirtyChunks = currentChunks.map((chunk) => this.toEmbeddingWorkChunk(chunk));
      indexNeedsUpdate = dirtyChunks.length > 0 || removedChunkIds.size > 0;
    }

    context.stats.totalChunks += currentChunks.length;

    return {
      parsedFile,
      currentChunks,
      dirtyChunks,
      removedChunkIds,
      oldChunkIds,
      oldSymbolIds,
      newSymbolIds: new Set<string>(),
      materializedChunkIds: new Set<string>(),
      embedStageInputHash,
      indexStageInputHash,
      chunkRan,
      indexNeedsUpdate,
      indexStarted: false,
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
    const model = context.configuredProviderInfo.modelInfo.model;
    const missingEmbeddings = new Set(
      database.getMissingEmbeddings(plan.dirtyChunks.map((chunk) => chunk.contentHash))
    );
    const embeddingQueue = new PQueue(this.host.getProviderRateLimits(context.configuredProviderInfo.provider));

    for (const chunk of plan.dirtyChunks) {
      if (!missingEmbeddings.has(chunk.contentHash)) {
        const embeddingBuffer = database.getEmbedding(chunk.contentHash);
        if (!embeddingBuffer) {
          const error = `Missing cached embedding for ${chunk.contentHash}`;
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
        plan.materializedChunkIds.add(chunk.id);
        context.stats.existingChunks += 1;
        context.stats.indexedChunks += 1;
      }
    }

    const batches = createDynamicBatches(
      plan.dirtyChunks
        .filter((chunk) => missingEmbeddings.has(chunk.contentHash))
        .map((chunk) => chunk)
    );

    for (const batch of batches) {
      await embeddingQueue.add(async () => {
        try {
          const embeddingResult = await pRetry(
            async () => {
              const texts = batch.map((chunk) => chunk.text);
              return provider.embedBatch(texts);
            },
            {
              retries: 3,
              onFailedAttempt: (error) => {
                if (error instanceof CustomProviderNonRetryableError) {
                  throw error;
                }
              },
            }
          );
          const vectors = embeddingResult.embeddings;

          const items = batch.map((chunk, index) => {
            const vector = vectors[index];
            if (!vector) {
              throw new Error(`Missing embedding vector for ${chunk.id}`);
            }
            return {
              id: chunk.id,
              vector,
              metadata: chunk.metadata,
            };
          });
          store.addBatch(items);
          database.upsertEmbeddingsBatch(
            batch.map((chunk, index) => ({
              contentHash: chunk.contentHash,
              embedding: Buffer.from(new Float32Array(vectors[index] ?? []).buffer),
              chunkText: chunk.content,
              model,
            }))
          );
          for (const chunk of batch) {
            invertedIndex.removeChunk(chunk.id);
            invertedIndex.addChunk(chunk.id, chunk.content);
            plan.materializedChunkIds.add(chunk.id);
          }
          context.stats.indexedChunks += batch.length;
          context.stats.tokensUsed += embeddingResult.totalTokensUsed;
          this.host.logger.recordChunksEmbedded(batch.length);
          this.host.logger.recordEmbeddingApiCall(embeddingResult.totalTokensUsed);
        } catch (error) {
          this.host.logger.recordEmbeddingError();
          this.host.addFailedBatch(batch, getErrorMessage(error));
          this.checkpoints.markStageFailed(
            context.branch,
            filePath,
            "embed",
            getErrorMessage(error),
            plan.embedStageInputHash
          );
          throw error;
        }
      });
    }

    this.checkpoints.markStageComplete(
      context.branch,
      filePath,
      "embed",
      plan.embedStageInputHash
    );
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
          context.database.upsertCallEdgesBatch(graph.edges);
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
    this.checkpoints.clearFileState(context.branch, filePath);
  }

  private buildChunkRecords(
    absolutePath: string,
    parsedFile: OrchestratorParsedFile
  ): ChunkRecord[] {
    const filteredChunks = applyChunkFilters(parsedFile.chunks, this.host.getConfig());
    return filteredChunks.map((chunk) => ({
      chunkId: generateChunkId(absolutePath, {
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkType: chunk.chunkType,
        name: chunk.name,
        language: chunk.language,
      }),
      contentHash: hashContent(chunk.content),
      filePath: parsedFile.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      nodeType: chunk.chunkType,
      name: chunk.name,
      language: chunk.language,
      text: chunk.content,
      chunkHash: chunk.chunkHash,
    }));
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
        context.existingChunks.get(chunk.chunkId) === chunk.contentHash &&
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

  private toEmbeddingWorkChunk(chunk: ChunkRecord): EmbeddingWorkChunk {
    return {
      id: chunk.chunkId,
      text: createEmbeddingText(
        {
          content: chunk.text,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType: chunk.nodeType as ChunkMetadata["chunkType"],
          name: chunk.name,
          language: chunk.language,
        },
        chunk.filePath
      ),
      content: chunk.text,
      contentHash: chunk.contentHash,
      metadata: {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkType: (chunk.nodeType as ChunkMetadata["chunkType"]) ?? "other",
        name: chunk.name,
        language: chunk.language,
        hash: chunk.contentHash,
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
      context.existingChunks.set(chunk.chunkId, chunk.contentHash);
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
    for (const chunkId of plan.materializedChunkIds) {
      this.host.removeChunkFromRetrievalIfUnreferenced(
        context.database,
        context.store,
        context.invertedIndex,
        chunkId
      );
    }
  }

  private async finalizeRunContext(
    context: RunContext,
    onProgress?: ProgressCallback
  ): Promise<IndexStats> {
    const staleChunkIds = Array.from(context.oldChunkIdsForTouchedFiles).filter(
      (chunkId) => !context.currentChunkIds.has(chunkId)
    );
    for (const chunkId of staleChunkIds) {
      if (
        this.host.removeChunkFromRetrievalIfUnreferenced(
          context.database,
          context.store,
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
    context.database.clearBranchSymbols(context.branch);
    context.database.addSymbolsToBranchBatch(context.branch, Array.from(context.allSymbolIds));
    context.store.save();
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
      this.checkpoints.markRunComplete(context.runId);
    } else {
      this.checkpoints.markRunFailed(context.runId);
    }

    this.host.saveIndexMetadata(context.configuredProviderInfo);
    this.host.markIndexCompatible();
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
}
