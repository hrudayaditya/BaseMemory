import * as path from "path";
import * as os from "os";
import * as module from "module";
import { fileURLToPath } from "url";

function getNativeBinding() {
  const platform = os.platform();
  const arch = os.arch();

  let bindingName: string;
  
  if (platform === "darwin" && arch === "arm64") {
    bindingName = "codebase-index-native.darwin-arm64.node";
  } else if (platform === "darwin" && arch === "x64") {
    bindingName = "codebase-index-native.darwin-x64.node";
  } else if (platform === "linux" && arch === "x64") {
    bindingName = "codebase-index-native.linux-x64-gnu.node";
  } else if (platform === "linux" && arch === "arm64") {
    bindingName = "codebase-index-native.linux-arm64-gnu.node";
  } else if (platform === "win32" && arch === "x64") {
    bindingName = "codebase-index-native.win32-x64-msvc.node";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Determine the current directory - handle ESM, CJS, and bundled contexts
  let currentDir: string;
  let requireTarget: string;
  
  // Check for ESM context with valid import.meta.url
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
    requireTarget = import.meta.url;
  } 
  // Fallback to __dirname for CJS/bundled contexts
  else if (typeof __dirname !== 'undefined') {
    currentDir = __dirname;
    requireTarget = __filename;
  }
  // Last resort: use process.cwd() - shouldn't normally hit this
  else {
    currentDir = process.cwd();
    requireTarget = path.join(currentDir, "index.js");
  }
  
  // The native module is in the 'native' folder at package root
  // From dist/index.js, we go up one level to package root, then into native/
  // From src/native/index.ts (dev/test), we go up two levels to package root
  const isDevMode = currentDir.includes('/src/native');
  const packageRoot = isDevMode 
    ? path.resolve(currentDir, '../..') 
    : path.resolve(currentDir, '..');
  const nativePath = path.join(packageRoot, 'native', bindingName);
  
  // Load the native module - use standard require for .node files
  const require = module.createRequire(requireTarget);
  return require(nativePath);
}

const native = getNativeBinding();

export interface FileInput {
  path: string;
  content: string;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  symbolKind?: ChunkSymbolKind;
  language: string;
}

export type ChunkSymbolKind =
  | "Function"
  | "Method"
  | "Class"
  | "Interface"
  | "Struct"
  | "Type"
  | "Constant"
  | "Test"
  | "Module"
  | "Block";

export type ChunkKind = "Code" | "Test" | "Doc" | "Config" | "File";

export type Granularity = "Fine" | "Coarse";

export interface ChunkConfig {
  targetTokenBudget: number;
  maxChunkChars: number;
  minChunkChars: number;
  mergeSmallSiblings: boolean;
  attachComments: boolean;
  emitCoarseChunks: boolean;
}

export interface SemanticChunk {
  filePath: string;
  language: string;
  symbolName?: string;
  symbolAliases?: string[];
  symbolKind?: ChunkSymbolKind;
  chunkKind: ChunkKind;
  granularity: Granularity;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  text: string;
  chunkHash: string;
}

export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "impl"
  | "trait"
  | "module"
  | "constant"
  | "import"
  | "export"
  | "comment"
  | "other";

export interface ParsedFile {
  path: string;
  chunks: CodeChunk[];
  hash: string;
}


export type CallType = "Call" | "MethodCall" | "Constructor" | "Import";

export interface CallSiteData {
  calleeName: string;
  line: number;
  column: number;
  callType: CallType;
}

export interface SymbolData {
  id: string;
  filePath: string;
  name: string;
  symbolAliases?: string[];
  kind: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  language: string;
}

export interface CallEdgeData {
  id: string;
  branch: string;
  fromSymbolId: string;
  fromSymbolName?: string;
  fromSymbolFilePath?: string;
  callerFilePath?: string;
  targetName: string;
  targetFilePath?: string;
  targetKind?: string;
  toSymbolId?: string;
  callType: string;
  line: number;
  col: number;
  isResolved: boolean;
}

export interface CallEdgeFrontierBatch {
  callers: CallEdgeData[];
  callees: CallEdgeData[];
}

export interface SymbolChunkData {
  symbolId: string;
  chunkId: string;
  contentHash: string;
  embeddingInputHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  symbolAliases?: string[];
  chunkKind?: string;
  symbolKind?: string;
  language: string;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface MerkleIgnoreRules {
  include: string[];
  exclude: string[];
  maxFileSize?: number;
}

export interface MerkleDiff {
  changedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
}

export interface PreparedMerkleDiff extends MerkleDiff {
  nextSnapshot: string;
}

export interface MerkleSnapshotPayload {
  branch: string;
  rootHash: string;
  totalNodes: number;
  totalFiles: number;
  snapshot: string;
}

export interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
  hash: string;
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetTokenBudget: 512,
  maxChunkChars: 2000,
  minChunkChars: 400,
  mergeSmallSiblings: true,
  attachComments: true,
  emitCoarseChunks: true,
};

export function chunkFile(
  filePath: string,
  language: string,
  sourceCode: string,
  config: Partial<ChunkConfig> = {}
): SemanticChunk[] {
  const result = native.chunkFile(filePath, language, sourceCode, {
    ...DEFAULT_CHUNK_CONFIG,
    ...config,
  });
  return result.map(mapSemanticChunk);
}

export function parseFile(filePath: string, content: string): CodeChunk[] {
  const result = native.parseFile(filePath, content);
  return result.map(mapChunk);
}

export function parseFiles(files: FileInput[]): ParsedFile[] {
  const result = native.parseFiles(files);
  return result.map((f: any) => ({
    path: f.path,
    chunks: f.chunks.map(mapChunk),
    hash: f.hash,
  }));
}

function mapChunk(c: any): CodeChunk {
  return {
    content: c.content,
    startLine: c.startLine ?? c.start_line,
    endLine: c.endLine ?? c.end_line,
    chunkType: (c.chunkType ?? c.chunk_type) as ChunkType,
    name: c.name ?? undefined,
    language: c.language,
  };
}

function mapSemanticChunk(c: any): SemanticChunk {
  return {
    filePath: c.filePath ?? c.file_path,
    language: c.language,
    symbolName: c.symbolName ?? c.symbol_name ?? undefined,
    symbolAliases: c.symbolAliases ?? c.symbol_aliases ?? [],
    symbolKind: c.symbolKind ?? c.symbol_kind ?? undefined,
    chunkKind: c.chunkKind ?? c.chunk_kind,
    granularity: c.granularity,
    startByte: c.startByte ?? c.start_byte,
    endByte: c.endByte ?? c.end_byte,
    startLine: c.startLine ?? c.start_line,
    endLine: c.endLine ?? c.end_line,
    text: c.text,
    chunkHash: c.chunkHash ?? c.chunk_hash,
  };
}

export function hashContent(content: string): string {
  return native.hashContent(content);
}

export function hashFile(filePath: string): string {
  return native.hashFile(filePath);
}

export function getChunkerVersion(): string {
  return native.getChunkerVersion();
}

export function getGraphExtractorVersion(): string {
  return native.getGraphExtractorVersion();
}

function mapMerkleDiff(diff: any): MerkleDiff {
  return {
    changedFiles: diff.changedFiles ?? diff.changed_files ?? [],
    addedFiles: diff.addedFiles ?? diff.added_files ?? [],
    removedFiles: diff.removedFiles ?? diff.removed_files ?? [],
  };
}

function mapMerkleSnapshotPayload(payload: any): MerkleSnapshotPayload {
  return {
    branch: payload.branch,
    rootHash: payload.rootHash ?? payload.root_hash,
    totalNodes: payload.totalNodes ?? payload.total_nodes,
    totalFiles: payload.totalFiles ?? payload.total_files,
    snapshot: payload.snapshot,
  };
}

export async function buildMerkleSnapshot(
  repoRoot: string,
  branch: string,
  ignoreRules: MerkleIgnoreRules
): Promise<MerkleSnapshotPayload> {
  const payload = await native.buildMerkleSnapshot(repoRoot, branch, {
    include: ignoreRules.include,
    exclude: ignoreRules.exclude,
    maxFileSize: ignoreRules.maxFileSize,
  });
  return mapMerkleSnapshotPayload(payload);
}

export async function diffMerkleSnapshots(
  oldSnapshot: string,
  newSnapshot: string
): Promise<MerkleDiff> {
  const diff = await native.diffMerkleSnapshots(oldSnapshot, newSnapshot);
  return mapMerkleDiff(diff);
}

export async function diffMerkleFromEvents(
  oldSnapshot: string,
  changedPaths: string[],
  repoRoot: string,
  ignoreRules: MerkleIgnoreRules
): Promise<PreparedMerkleDiff> {
  const payload = await native.diffMerkleFromEvents(oldSnapshot, changedPaths, repoRoot, {
    include: ignoreRules.include,
    exclude: ignoreRules.exclude,
    maxFileSize: ignoreRules.maxFileSize,
  });

  return {
    ...mapMerkleDiff(payload),
    nextSnapshot: payload.nextSnapshot ?? payload.next_snapshot,
  };
}


export function extractCalls(content: string, language: string): CallSiteData[] {
  return native.extractCalls(content, language);
}

export class VectorStore {
  private inner: any;
  private dimensions: number;

  constructor(indexPath: string, dimensions: number) {
    this.inner = new native.VectorStore(indexPath, dimensions);
    this.dimensions = dimensions;
  }

  add(id: string, vector: number[], metadata: ChunkMetadata): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    this.inner.add(id, vector, JSON.stringify(metadata));
  }

  addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>
  ): void {
    const ids = items.map((i) => i.id);
    const vectors = items.map((i) => {
      if (i.vector.length !== this.dimensions) {
        throw new Error(
          `Vector dimension mismatch for ${i.id}: expected ${this.dimensions}, got ${i.vector.length}`
        );
      }
      return i.vector;
    });
    const metadata = items.map((i) => JSON.stringify(i.metadata));
    this.inner.addBatch(ids, vectors, metadata);
  }

  search(queryVector: number[], limit: number = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = this.inner.search(queryVector, limit);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  searchFiltered(queryVector: number[], allowedIds: string[], limit: number = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = this.inner.searchFiltered(queryVector, limit, allowedIds);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  searchOnBranch(queryVector: number[], branch: string, limit: number = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = this.inner.searchOnBranch(queryVector, limit, branch);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  remove(id: string): boolean {
    return this.inner.remove(id);
  }

  save(): void {
    this.inner.save();
  }

  load(): boolean {
    return this.inner.load();
  }

  count(): number {
    return this.inner.count();
  }

  contains(id: string): boolean {
    return this.inner.contains(id);
  }

  branchContains(branch: string, id: string): boolean {
    return this.inner.branchContains(branch, id);
  }

  clear(): void {
    this.inner.clear();
  }

  setBranchMembership(branch: string, chunkIds: string[]): void {
    this.inner.setBranchMembership(branch, chunkIds);
  }

  applyBranchDelta(branch: string, added: string[], removed: string[]): void {
    this.inner.applyBranchDelta(branch, added, removed);
  }

  clearBranchMembership(branch: string): void {
    this.inner.clearBranchMembership(branch);
  }

  clearAllBranchMemberships(): void {
    this.inner.clearAllBranchMemberships();
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getAllKeys(): string[] {
    return this.inner.getAllKeys();
  }

  getAllMetadata(): Array<{ key: string; metadata: ChunkMetadata }> {
    const results = this.inner.getAllMetadata();
    return results.map((r: { key: string; metadata: string }) => ({
      key: r.key,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  getMetadata(id: string): ChunkMetadata | undefined {
    const result = this.inner.getMetadata(id);
    if (result === null || result === undefined) {
      return undefined;
    }
    return JSON.parse(result) as ChunkMetadata;
  }

  getMetadataBatch(ids: string[]): Map<string, ChunkMetadata> {
    const results = this.inner.getMetadataBatch(ids);
    const map = new Map<string, ChunkMetadata>();
    for (const { key, metadata } of results) {
      map.set(key, JSON.parse(metadata) as ChunkMetadata);
    }
    return map;
  }
}

// Token estimation: ~4 chars per token for code (conservative)
const CHARS_PER_TOKEN = 4;
const MIN_EMBEDDING_TOKEN_SAFETY_MARGIN = 128;
const MIN_BATCH_TOKEN_SAFETY_MARGIN = 256;
const EMBEDDING_TOKEN_SAFETY_MARGIN_RATIO = 0.125;
const BATCH_TOKEN_SAFETY_MARGIN_RATIO = 0.2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function normalizeEmbeddingMaxTokens(maxTokens: number): number {
  if (!Number.isFinite(maxTokens)) {
    throw new Error(`Expected a finite embedding maxTokens value, received ${maxTokens}`);
  }

  return Math.max(1, Math.floor(maxTokens));
}

function computeSafetyMargin(
  maxTokens: number,
  minimumMargin: number,
  ratio: number
): number {
  const normalizedMaxTokens = normalizeEmbeddingMaxTokens(maxTokens);
  return Math.min(
    normalizedMaxTokens - 1,
    Math.max(minimumMargin, Math.ceil(normalizedMaxTokens * ratio))
  );
}

function getSafeEmbeddingTokenBudget(maxTokens: number): number {
  return Math.max(
    1,
    normalizeEmbeddingMaxTokens(maxTokens) -
      computeSafetyMargin(
        maxTokens,
        MIN_EMBEDDING_TOKEN_SAFETY_MARGIN,
        EMBEDDING_TOKEN_SAFETY_MARGIN_RATIO
      )
  );
}

function getSafeBatchTokenBudget(maxTokens: number): number {
  return Math.max(
    1,
    normalizeEmbeddingMaxTokens(maxTokens) -
      computeSafetyMargin(
        maxTokens,
        MIN_BATCH_TOKEN_SAFETY_MARGIN,
        BATCH_TOKEN_SAFETY_MARGIN_RATIO
      )
  );
}

function normalizeEmbeddingPath(filePath: string, projectRoot?: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  if (!projectRoot) {
    return normalizedFilePath.replace(/^\/+/, "");
  }

  const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
  if (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return normalizedFilePath.replace(/^\/+/, "");
}

function isSyntheticSymbolName(name: string | undefined): boolean {
  return Boolean(name && name.startsWith("<") && name.endsWith(">"));
}

function normalizeIdentifierTerms(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatSymbolDescriptor(chunk: CodeChunk): string | null {
  if (!chunk.name || isSyntheticSymbolName(chunk.name)) {
    return null;
  }

  const normalizedTerms = normalizeIdentifierTerms(chunk.name);
  const includeTerms =
    normalizedTerms.length > 0 && normalizedTerms !== chunk.name.trim().toLowerCase();

  if (chunk.symbolKind) {
    return includeTerms
      ? `symbol: ${chunk.name} (${chunk.symbolKind.toLowerCase()}) terms: ${normalizedTerms}`
      : `symbol: ${chunk.name} (${chunk.symbolKind.toLowerCase()})`;
  }

  return includeTerms ? `symbol: ${chunk.name} terms: ${normalizedTerms}` : `symbol: ${chunk.name}`;
}

/**
 * Tracks the exact output contract of createEmbeddingText().
 * Bump this whenever path normalization, symbol descriptor formatting, header
 * layout, truncation behavior, or body ordering changes.
 * A bump flows into hashEmbedConfig(), makes EMBED checkpoints stale, and
 * forces affected chunks to be re-embedded on the next indexing run.
 */
export const EMBEDDING_INPUT_FORMAT_VERSION = 5;

export function createEmbeddingText(
  chunk: CodeChunk,
  filePath: string,
  projectRoot: string | undefined,
  maxTokens: number
): string {
  const parts: string[] = [`file: ${normalizeEmbeddingPath(filePath, projectRoot)}`];
  const symbolDescriptor = formatSymbolDescriptor(chunk);
  if (symbolDescriptor) {
    parts.push(symbolDescriptor);
  }
  parts.push("");

  const header = `${parts.join("\n")}\n`;
  const fullText = header + chunk.content;
  const safeTokenBudget = getSafeEmbeddingTokenBudget(maxTokens);

  if (estimateTokens(fullText) <= safeTokenBudget) {
    return fullText;
  }

  if (estimateTokens(header) > safeTokenBudget) {
    return header;
  }

  const truncationSuffix = "\n... [truncated]";
  let low = 0;
  let high = chunk.content.length;
  let best = header;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = header + chunk.content.slice(0, mid) + truncationSuffix;

    if (estimateTokens(candidate) <= safeTokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

export interface PreparedEmbeddingInput {
  text: string;
  hash: string;
}

export function prepareEmbeddingInput(
  chunk: CodeChunk,
  filePath: string,
  projectRoot: string | undefined,
  maxTokens: number
): PreparedEmbeddingInput {
  const text = createEmbeddingText(chunk, filePath, projectRoot, maxTokens);
  return {
    text,
    hash: hashContent(text),
  };
}

export function buildEmbeddingInputHash(
  chunk: CodeChunk,
  filePath: string,
  projectRoot: string | undefined,
  maxTokens: number
): string {
  return prepareEmbeddingInput(chunk, filePath, projectRoot, maxTokens).hash;
}

export function createDynamicBatches<T extends { text: string }>(
  chunks: T[],
  maxTokens: number
): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentTokens = 0;
  const batchTokenBudget = getSafeBatchTokenBudget(maxTokens);
  
  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(chunk.text);
    
    if (currentBatch.length > 0 && currentTokens + chunkTokens > batchTokenBudget) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    
    currentBatch.push(chunk);
    currentTokens += chunkTokens;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}

export function generateChunkHash(chunk: CodeChunk): string {
  return hashContent(chunk.content);
}

export interface KeywordSearchResult {
  chunkId: string;
  score: number;
}

export class InvertedIndex {
  private inner: any;

  constructor(indexPath: string) {
    this.inner = new native.InvertedIndex(indexPath);
  }

  load(): boolean {
    return this.inner.load();
  }

  save(): void {
    this.inner.save();
  }

  addChunk(chunkId: string, content: string): void {
    this.inner.addChunk(chunkId, content);
  }

  removeChunk(chunkId: string): boolean {
    return this.inner.removeChunk(chunkId);
  }

  search(query: string, limit?: number): Map<string, number> {
    const results = this.inner.search(query, limit ?? 100);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.chunkId, r.score);
    }
    return map;
  }

  searchFiltered(query: string, allowedChunkIds: string[], limit?: number): Map<string, number> {
    const results = this.inner.searchFiltered(query, allowedChunkIds, limit ?? 100);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.chunkId, r.score);
    }
    return map;
  }

  searchOnBranch(query: string, branch: string, limit?: number): Map<string, number> {
    const results = this.inner.searchOnBranch(query, branch, limit ?? 100);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.chunkId, r.score);
    }
    return map;
  }

  hasChunk(chunkId: string): boolean {
    return this.inner.hasChunk(chunkId);
  }

  branchContains(branch: string, chunkId: string): boolean {
    return this.inner.branchContains(branch, chunkId);
  }

  clear(): void {
    this.inner.clear();
  }

  setBranchMembership(branch: string, chunkIds: string[]): void {
    this.inner.setBranchMembership(branch, chunkIds);
  }

  applyBranchDelta(branch: string, added: string[], removed: string[]): void {
    this.inner.applyBranchDelta(branch, added, removed);
  }

  clearBranchMembership(branch: string): void {
    this.inner.clearBranchMembership(branch);
  }

  clearAllBranchMemberships(): void {
    this.inner.clearAllBranchMemberships();
  }

  getDocumentCount(): number {
    return this.inner.documentCount();
  }
}

export interface ChunkData {
  chunkId: string;
  contentHash: string;
  embeddingInputHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  symbolAliases?: string[];
  chunkKind?: string;
  symbolKind?: string;
  language: string;
}

export interface ChunkKindEnrichment {
  chunkId: string;
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
}

export interface ChunkMetadataLookup {
  chunkId: string;
  embeddingInputHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: ChunkType;
  name?: string;
  symbolAliases?: string[];
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
  language: string;
}

export interface BranchDelta {
  added: string[];
  removed: string[];
}

export interface DatabaseStats {
  embeddingCount: number;
  chunkCount: number;
  branchChunkCount: number;
  branchCount: number;
  symbolCount: number;
  callEdgeCount: number;
}

export interface PipelineStateData {
  branch: string;
  filePath: string;
  stage: string;
  status: string;
  inputHash?: string;
  error?: string;
  updatedAt: number;
}

export interface PipelineRunData {
  runId: string;
  branch: string;
  runType: string;
  status: string;
  configHash: string;
  startedAt: number;
  completedAt?: number;
}

export interface EmbeddingDebtData {
  branch: string;
  filePath: string;
  model: string;
  reason: string;
  createdAt: number;
}

export interface RerankerHealthData {
  backend: string;
  status: string;
  model?: string | null;
  error?: string | null;
  updatedAt: number;
}

export interface ChunkCapDropData {
  branch: string;
  filePath: string;
  capLimit: number;
  keptCount: number;
  droppedCount: number;
  droppedNamed: string[];
  indexedAt: number;
}

export interface StoredConfigVersionData {
  configHash: string;
  embeddingModelId: string;
  embeddingDimension: number;
  voyageModelId?: string | null;
  embeddingPrefixVersion?: number;
  chunkerVersion: string;
  graphExtractorVersion: string;
  active: boolean;
  createdAt: number;
}

export interface StoredBranchConfigVersionData {
  branch: string;
  configHash: string;
  appliedAt: number;
}

function maybeExposeSymbolAliases<T extends { symbolAliases?: string[] }>(value: T): T {
  if (!value.symbolAliases || value.symbolAliases.length === 0) {
    const { symbolAliases: _symbolAliases, ...rest } = value;
    return rest as T;
  }
  return value;
}

function normalizeChunkDataForWrite(chunk: ChunkData): ChunkData {
  return {
    ...chunk,
    symbolAliases: chunk.symbolAliases ?? [],
  };
}

function normalizeChunkDataFromRead(chunk: ChunkData): ChunkData {
  return maybeExposeSymbolAliases({
    ...chunk,
    symbolAliases: chunk.symbolAliases ?? [],
  });
}

function normalizeSymbolDataForWrite(symbol: SymbolData): SymbolData {
  return {
    ...symbol,
    symbolAliases: symbol.symbolAliases ?? [],
  };
}

function normalizeSymbolDataFromRead(symbol: SymbolData): SymbolData {
  return maybeExposeSymbolAliases({
    ...symbol,
    symbolAliases: symbol.symbolAliases ?? [],
  });
}

function normalizeSymbolChunkData(symbolChunk: SymbolChunkData): SymbolChunkData {
  return maybeExposeSymbolAliases({
    ...symbolChunk,
    symbolAliases: symbolChunk.symbolAliases ?? [],
  });
}

function normalizeChunkMetadataLookup(chunk: ChunkMetadataLookup): ChunkMetadataLookup {
  return maybeExposeSymbolAliases({
    ...chunk,
    symbolAliases: chunk.symbolAliases ?? [],
  });
}

export class Database {
  private inner: any;

  constructor(dbPath: string) {
    this.inner = new native.Database(dbPath);
  }

  embeddingExists(embeddingInputHash: string): boolean {
    return this.inner.embeddingExists(embeddingInputHash);
  }

  getEmbedding(embeddingInputHash: string): Buffer | null {
    return this.inner.getEmbedding(embeddingInputHash) ?? null;
  }

  getEmbeddingForModel(embeddingInputHash: string, model: string): Buffer | null {
    return this.inner.getEmbeddingForModel(embeddingInputHash, model) ?? null;
  }

  getEmbeddingsForModelBatch(embeddingInputHashes: string[], model: string): Map<string, Buffer> {
    const results = this.inner.getEmbeddingsForModelBatch(embeddingInputHashes, model);
    const map = new Map<string, Buffer>();
    for (const item of results as Array<{
      embeddingInputHash?: string;
      embedding_input_hash?: string;
      embedding: Buffer;
    }>) {
      const embeddingInputHash =
        item.embeddingInputHash ?? item.embedding_input_hash;
      if (!embeddingInputHash) continue;
      map.set(embeddingInputHash, item.embedding);
    }
    return map;
  }

  getChunkTextsBatch(embeddingInputHashes: string[]): Map<string, string> {
    const results = this.inner.getChunkTextsBatch(embeddingInputHashes);
    const map = new Map<string, string>();
    for (const item of results as Array<{
      embeddingInputHash?: string;
      embedding_input_hash?: string;
      chunkText?: string;
      chunk_text?: string;
    }>) {
      const embeddingInputHash =
        item.embeddingInputHash ?? item.embedding_input_hash;
      const chunkText = item.chunkText ?? item.chunk_text;
      if (!embeddingInputHash || chunkText === undefined) continue;
      map.set(embeddingInputHash, chunkText);
    }
    return map;
  }

  upsertEmbedding(
    embeddingInputHash: string,
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): void {
    this.inner.upsertEmbedding(
      embeddingInputHash,
      contentHash,
      embedding,
      chunkText,
      model
    );
  }

  upsertEmbeddingsBatch(
    items: Array<{
      embeddingInputHash: string;
      contentHash: string;
      embedding: Buffer;
      chunkText: string;
      model: string;
    }>
  ): void {
    if (items.length === 0) return;
    this.inner.upsertEmbeddingsBatch(items);
  }

  getMissingEmbeddings(embeddingInputHashes: string[]): string[] {
    return this.inner.getMissingEmbeddings(embeddingInputHashes);
  }

  getMissingEmbeddingsForModel(
    embeddingInputHashes: string[],
    model: string
  ): string[] {
    return this.inner.getMissingEmbeddingsForModel(embeddingInputHashes, model);
  }

  recordEmbeddingDebt(
    branch: string,
    filePath: string,
    model: string,
    reason: string
  ): void {
    this.inner.recordEmbeddingDebt(branch, filePath, model, reason);
  }

  clearEmbeddingDebt(branch: string, filePath: string, model: string): void {
    this.inner.clearEmbeddingDebt(branch, filePath, model);
  }

  clearEmbeddingDebtForFile(branch: string, filePath: string): number {
    return this.inner.clearEmbeddingDebtForFile(branch, filePath);
  }

  getEmbeddingDebtForBranch(branch: string): EmbeddingDebtData[] {
    return this.inner.getEmbeddingDebtForBranch(branch).map((item: {
      branch: string;
      filePath?: string;
      file_path?: string;
      model: string;
      reason: string;
      createdAt?: number;
      created_at?: number;
    }) => ({
      branch: item.branch,
      filePath: item.filePath ?? item.file_path ?? "",
      model: item.model,
      reason: item.reason,
      createdAt: item.createdAt ?? item.created_at ?? 0,
    }));
  }

  clearEmbeddingDebtForBranch(branch: string): number {
    return this.inner.clearEmbeddingDebtForBranch(branch);
  }

  clearAllEmbeddingDebt(): number {
    return this.inner.clearAllEmbeddingDebt();
  }

  upsertRerankerHealth(
    backend: string,
    status: string,
    model?: string | null,
    error?: string | null
  ): void {
    this.inner.upsertRerankerHealth(backend, status, model ?? null, error ?? null);
  }

  getRerankerHealth(): RerankerHealthData | null {
    const result = this.inner.getRerankerHealth();
    if (result === null || result === undefined) {
      return null;
    }
    return {
      backend: result.backend,
      status: result.status,
      model: result.model ?? null,
      error: result.error ?? null,
      updatedAt: result.updatedAt ?? result.updated_at ?? 0,
    };
  }

  upsertChunkCapDrop(
    branch: string,
    filePath: string,
    capLimit: number,
    keptCount: number,
    droppedCount: number,
    droppedNamed: string[]
  ): void {
    this.inner.upsertChunkCapDrop(
      branch,
      filePath,
      capLimit,
      keptCount,
      droppedCount,
      droppedNamed
    );
  }

  clearChunkCapDrop(branch: string, filePath: string): number {
    return this.inner.clearChunkCapDrop(branch, filePath);
  }

  getChunkCapDropsForBranch(branch: string): ChunkCapDropData[] {
    return this.inner.getChunkCapDropsForBranch(branch).map((item: {
      branch: string;
      filePath?: string;
      file_path?: string;
      capLimit?: number;
      cap_limit?: number;
      keptCount?: number;
      kept_count?: number;
      droppedCount?: number;
      dropped_count?: number;
      droppedNamed?: string[];
      dropped_named?: string[];
      indexedAt?: number;
      indexed_at?: number;
    }) => ({
      branch: item.branch,
      filePath: item.filePath ?? item.file_path ?? "",
      capLimit: item.capLimit ?? item.cap_limit ?? 0,
      keptCount: item.keptCount ?? item.kept_count ?? 0,
      droppedCount: item.droppedCount ?? item.dropped_count ?? 0,
      droppedNamed: item.droppedNamed ?? item.dropped_named ?? [],
      indexedAt: item.indexedAt ?? item.indexed_at ?? 0,
    }));
  }

  clearChunkCapDropsForBranch(branch: string): number {
    return this.inner.clearChunkCapDropsForBranch(branch);
  }

  clearAllChunkCapDrops(): number {
    return this.inner.clearAllChunkCapDrops();
  }

  upsertChunk(chunk: ChunkData): void {
    this.inner.upsertChunk(normalizeChunkDataForWrite(chunk));
  }

  upsertChunksBatch(chunks: ChunkData[]): void {
    if (chunks.length === 0) return;
    this.inner.upsertChunksBatch(chunks.map(normalizeChunkDataForWrite));
  }

  getChunk(chunkId: string): ChunkData | null {
    const result = this.inner.getChunk(chunkId);
    return result ? normalizeChunkDataFromRead(result) : null;
  }

  getChunksByFile(filePath: string): ChunkData[] {
    return this.inner.getChunksByFile(filePath).map(normalizeChunkDataFromRead);
  }

  getChunksByFileOnBranch(filePath: string, branch: string): ChunkData[] {
    return this.inner.getChunksByFileOnBranch(filePath, branch).map(normalizeChunkDataFromRead);
  }

  async getChunkIdsByFiltersForBranch(
    branch: string,
    fileType: string | null,
    directory: string | null,
    chunkType: string | null,
    excludeFile: string | null,
    chunkKind: string | null,
    language: string | null,
    pathGlob: string | null,
  ): Promise<string[]> {
    return this.inner.getChunkIdsByFiltersForBranch(
      branch,
      fileType,
      directory,
      chunkType,
      excludeFile,
      chunkKind,
      language,
      pathGlob
    );
  }

  getChunksForSymbolsBatch(
    symbolIds: string[],
    branch: string,
    allowedChunkIds?: string[]
  ): SymbolChunkData[] {
    return this.inner.getChunksForSymbolsBatch(symbolIds, branch, allowedChunkIds ?? null).map((item: any) => normalizeSymbolChunkData({
      symbolId: item.symbolId ?? item.symbol_id,
      chunkId: item.chunkId ?? item.chunk_id,
      contentHash: item.contentHash ?? item.content_hash,
      embeddingInputHash: item.embeddingInputHash ?? item.embedding_input_hash,
      filePath: item.filePath ?? item.file_path,
      startLine: item.startLine ?? item.start_line,
      endLine: item.endLine ?? item.end_line,
      nodeType: item.nodeType ?? item.node_type ?? undefined,
      name: item.name ?? undefined,
      symbolAliases: item.symbolAliases ?? item.symbol_aliases ?? [],
      chunkKind: item.chunkKind ?? item.chunk_kind ?? undefined,
      symbolKind: item.symbolKind ?? item.symbol_kind ?? undefined,
      language: item.language,
    }));
  }

  getChunksByName(name: string): ChunkData[] {
    return this.inner.getChunksByName(name).map(normalizeChunkDataFromRead);
  }

  getChunksByNameCi(name: string): ChunkData[] {
    return this.inner.getChunksByNameCi(name).map(normalizeChunkDataFromRead);
  }

  getChunkKindsBatch(chunkIds: string[]): ChunkKindEnrichment[] {
    if (chunkIds.length === 0) return [];
    return this.inner.getChunkKindsBatch(chunkIds);
  }

  getChunkMetadataBatch(chunkIds: string[]): ChunkMetadataLookup[] {
    if (chunkIds.length === 0) return [];
    return this.inner.getChunkMetadataBatch(chunkIds).map((item: {
      chunkId?: string;
      chunk_id?: string;
      embeddingInputHash?: string;
      embedding_input_hash?: string;
      filePath?: string;
      file_path?: string;
      startLine?: number;
      start_line?: number;
      endLine?: number;
      end_line?: number;
      nodeType?: ChunkType;
      node_type?: ChunkType;
      name?: string;
      symbolAliases?: string[];
      symbol_aliases?: string[];
      chunkKind?: ChunkKind;
      chunk_kind?: ChunkKind;
      symbolKind?: ChunkSymbolKind;
      symbol_kind?: ChunkSymbolKind;
      language: string;
    }) => normalizeChunkMetadataLookup({
      chunkId: item.chunkId ?? item.chunk_id ?? "",
      embeddingInputHash: item.embeddingInputHash ?? item.embedding_input_hash ?? "",
      filePath: item.filePath ?? item.file_path ?? "",
      startLine: item.startLine ?? item.start_line ?? 0,
      endLine: item.endLine ?? item.end_line ?? 0,
      nodeType: item.nodeType ?? item.node_type ?? undefined,
      name: item.name ?? undefined,
      symbolAliases: item.symbolAliases ?? item.symbol_aliases ?? [],
      chunkKind: item.chunkKind ?? item.chunk_kind ?? undefined,
      symbolKind: item.symbolKind ?? item.symbol_kind ?? undefined,
      language: item.language,
    }));
  }

  deleteChunksByFile(filePath: string): number {
    return this.inner.deleteChunksByFile(filePath);
  }

  addChunksToBranch(branch: string, chunkIds: string[]): void {
    this.inner.addChunksToBranch(branch, chunkIds);
  }

  addChunksToBranchBatch(branch: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    this.inner.addChunksToBranchBatch(branch, chunkIds);
  }

  clearBranch(branch: string): number {
    return this.inner.clearBranch(branch);
  }

  clearAllBranches(): number {
    return this.inner.clearAllBranches();
  }

  getBranchChunkIds(branch: string): string[] {
    return this.inner.getBranchChunkIds(branch);
  }

  getBranchDelta(branch: string, baseBranch: string): BranchDelta {
    return this.inner.getBranchDelta(branch, baseBranch);
  }

  chunkExistsOnBranch(branch: string, chunkId: string): boolean {
    return this.inner.chunkExistsOnBranch(branch, chunkId);
  }

  chunkExistsOnOtherBranches(branch: string, chunkId: string): boolean {
    return this.inner.chunkExistsOnOtherBranches(branch, chunkId);
  }

  getAllBranches(): string[] {
    return this.inner.getAllBranches();
  }

  getMetadata(key: string): string | null {
    return this.inner.getMetadata(key) ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.inner.setMetadata(key, value);
  }

  deleteMetadata(key: string): boolean {
    return this.inner.deleteMetadata(key);
  }

  getMerkleSnapshot(branch: string): string | null {
    return this.inner.getMerkleSnapshot(branch) ?? null;
  }

  saveMerkleSnapshot(snapshot: string): void {
    this.inner.saveMerkleSnapshot(snapshot);
  }

  deleteMerkleSnapshot(branch: string): boolean {
    return this.inner.deleteMerkleSnapshot(branch);
  }

  clearAllMerkleSnapshots(): void {
    this.inner.clearAllMerkleSnapshots();
  }

  gcOrphanEmbeddings(): number {
    return this.inner.gcOrphanEmbeddings();
  }

  gcOrphanChunks(): number {
    return this.inner.gcOrphanChunks();
  }

  getStats(): DatabaseStats {
    return this.inner.getStats();
  }

  upsertPipelineState(state: PipelineStateData): void {
    this.inner.upsertPipelineState({
      branch: state.branch,
      filePath: state.filePath,
      stage: state.stage,
      status: state.status,
      inputHash: state.inputHash,
      error: state.error,
      updatedAt: state.updatedAt,
    });
  }

  getPipelineState(branch: string, filePath: string, stage: string): PipelineStateData | null {
    const result = this.inner.getPipelineState(branch, filePath, stage);
    if (result === null || result === undefined) {
      return null;
    }
    return {
      branch: result.branch,
      filePath: result.filePath ?? result.file_path,
      stage: result.stage,
      status: result.status,
      inputHash: result.inputHash ?? result.input_hash ?? undefined,
      error: result.error ?? undefined,
      updatedAt: result.updatedAt ?? result.updated_at,
    };
  }

  getUnfinishedPipelineFiles(branch: string): string[] {
    return this.inner.getUnfinishedPipelineFiles(branch);
  }

  getKnownPipelineFiles(branch: string): string[] {
    return this.inner.getKnownPipelineFiles(branch);
  }

  resetPipelineStage(branch: string, stage: string, updatedAt: number): number {
    return this.inner.resetPipelineStage(branch, stage, updatedAt);
  }

  clearPipelineStateForBranch(branch: string): number {
    return this.inner.clearPipelineStateForBranch(branch);
  }

  clearPipelineStateForFile(branch: string, filePath: string): number {
    return this.inner.clearPipelineStateForFile(branch, filePath);
  }

  clearAllPipelineState(): number {
    return this.inner.clearAllPipelineState();
  }

  startPipelineRun(run: PipelineRunData, cancelledAt: number): void {
    this.inner.startPipelineRun({
      runId: run.runId,
      branch: run.branch,
      runType: run.runType,
      status: run.status,
      configHash: run.configHash,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }, cancelledAt);
  }

  updatePipelineRunStatus(runId: string, status: string, completedAt?: number): boolean {
    return this.inner.updatePipelineRunStatus(runId, status, completedAt);
  }

  getPipelineRun(runId: string): PipelineRunData | null {
    const result = this.inner.getPipelineRun(runId);
    if (result === null || result === undefined) {
      return null;
    }
    return {
      runId: result.runId ?? result.run_id,
      branch: result.branch,
      runType: result.runType ?? result.run_type,
      status: result.status,
      configHash: result.configHash ?? result.config_hash,
      startedAt: result.startedAt ?? result.started_at,
      completedAt: result.completedAt ?? result.completed_at ?? undefined,
    };
  }

  cancelActivePipelineRuns(branch: string, cancelledAt: number): number {
    return this.inner.cancelActivePipelineRuns(branch, cancelledAt);
  }

  getActivePipelineRuns(): PipelineRunData[] {
    const results = this.inner.getActivePipelineRuns();
    return results.map((result: any) => ({
      runId: result.runId ?? result.run_id,
      branch: result.branch,
      runType: result.runType ?? result.run_type,
      status: result.status,
      configHash: result.configHash ?? result.config_hash,
      startedAt: result.startedAt ?? result.started_at,
      completedAt: result.completedAt ?? result.completed_at ?? undefined,
    }));
  }

  getPipelineRunsByStatus(status: string): PipelineRunData[] {
    const results = this.inner.getPipelineRunsByStatus(status);
    return results.map((result: any) => ({
      runId: result.runId ?? result.run_id,
      branch: result.branch,
      runType: result.runType ?? result.run_type,
      status: result.status,
      configHash: result.configHash ?? result.config_hash,
      startedAt: result.startedAt ?? result.started_at,
      completedAt: result.completedAt ?? result.completed_at ?? undefined,
    }));
  }

  pruneFinishedPipelineRuns(olderThan: number): number {
    return this.inner.pruneFinishedPipelineRuns(olderThan);
  }

  getConfigVersion(configHash: string): StoredConfigVersionData | null {
    const result = this.inner.getConfigVersion(configHash);
    if (result === null || result === undefined) {
      return null;
    }
    return {
      configHash: result.configHash ?? result.config_hash,
      embeddingModelId: result.embeddingModelId ?? result.embedding_model_id,
      embeddingDimension: result.embeddingDimension ?? result.embedding_dimension,
      voyageModelId: result.voyageModelId ?? result.voyage_model_id ?? null,
      embeddingPrefixVersion:
        result.embeddingPrefixVersion ?? result.embedding_prefix_version ?? 0,
      chunkerVersion: result.chunkerVersion ?? result.chunker_version,
      graphExtractorVersion: result.graphExtractorVersion ?? result.graph_extractor_version,
      active: result.active,
      createdAt: result.createdAt ?? result.created_at,
    };
  }

  clearAllPipelineRuns(): number {
    return this.inner.clearAllPipelineRuns();
  }

  getActiveConfigVersion(): StoredConfigVersionData | null {
    const result = this.inner.getActiveConfigVersion();
    if (result === null || result === undefined) {
      return null;
    }
    return {
      configHash: result.configHash ?? result.config_hash,
      embeddingModelId: result.embeddingModelId ?? result.embedding_model_id,
      embeddingDimension: result.embeddingDimension ?? result.embedding_dimension,
      voyageModelId: result.voyageModelId ?? result.voyage_model_id ?? null,
      embeddingPrefixVersion:
        result.embeddingPrefixVersion ?? result.embedding_prefix_version ?? 0,
      chunkerVersion: result.chunkerVersion ?? result.chunker_version,
      graphExtractorVersion: result.graphExtractorVersion ?? result.graph_extractor_version,
      active: result.active,
      createdAt: result.createdAt ?? result.created_at,
    };
  }

  activateConfigVersion(configVersion: StoredConfigVersionData): void {
    const payload = {
      configHash: configVersion.configHash,
      embeddingModelId: configVersion.embeddingModelId,
      embeddingDimension: configVersion.embeddingDimension,
      embeddingPrefixVersion: configVersion.embeddingPrefixVersion ?? 0,
      chunkerVersion: configVersion.chunkerVersion,
      graphExtractorVersion: configVersion.graphExtractorVersion,
      active: configVersion.active,
      createdAt: configVersion.createdAt,
      ...(configVersion.voyageModelId != null
        ? { voyageModelId: configVersion.voyageModelId }
        : {}),
    };
    this.inner.activateConfigVersion(payload);
  }

  getBranchConfigVersion(branch: string): StoredBranchConfigVersionData | null {
    const result = this.inner.getBranchConfigVersion(branch);
    if (result === null || result === undefined) {
      return null;
    }
    return {
      branch: result.branch,
      configHash: result.configHash ?? result.config_hash,
      appliedAt: result.appliedAt ?? result.applied_at,
    };
  }

  upsertBranchConfigVersion(branchConfig: StoredBranchConfigVersionData): void {
    this.inner.upsertBranchConfigVersion({
      branch: branchConfig.branch,
      configHash: branchConfig.configHash,
      appliedAt: branchConfig.appliedAt,
    });
  }

  clearAllConfigVersions(): number {
    return this.inner.clearAllConfigVersions();
  }

  // ── Symbol methods ──────────────────────────────────────────────

  upsertSymbol(symbol: SymbolData): void {
    this.inner.upsertSymbol(normalizeSymbolDataForWrite(symbol));
  }

  upsertSymbolsBatch(symbols: SymbolData[]): void {
    if (symbols.length === 0) return;
    this.inner.upsertSymbolsBatch(symbols.map(normalizeSymbolDataForWrite));
  }

  getSymbolsByFile(filePath: string): SymbolData[] {
    return this.inner.getSymbolsByFile(filePath).map(normalizeSymbolDataFromRead);
  }

  getSymbolsByFileOnBranch(filePath: string, branch: string): SymbolData[] {
    return this.inner.getSymbolsByFileOnBranch(filePath, branch).map(normalizeSymbolDataFromRead);
  }

  getSymbolById(symbolId: string): SymbolData | null {
    const result = this.inner.getSymbolById(symbolId);
    return result ? normalizeSymbolDataFromRead(result) : null;
  }

  getSymbolByIdOnBranch(symbolId: string, branch: string): SymbolData | null {
    const result = this.inner.getSymbolByIdOnBranch(symbolId, branch);
    return result ? normalizeSymbolDataFromRead(result) : null;
  }

  getSymbolsByIdsOnBranch(symbolIds: string[], branch: string): SymbolData[] {
    if (symbolIds.length === 0) {
      return [];
    }
    return this.inner.getSymbolsByIdsOnBranch(symbolIds, branch).map(normalizeSymbolDataFromRead);
  }

  getSymbolByName(name: string, filePath: string): SymbolData | null {
    const result = this.inner.getSymbolByName(name, filePath);
    return result ? normalizeSymbolDataFromRead(result) : null;
  }

  getSymbolByNameOnBranch(name: string, filePath: string, branch: string): SymbolData | null {
    const result = this.inner.getSymbolByNameOnBranch(name, filePath, branch);
    return result ? normalizeSymbolDataFromRead(result) : null;
  }

  getSymbolsByName(name: string): SymbolData[] {
    return this.inner.getSymbolsByName(name).map(normalizeSymbolDataFromRead);
  }

  getSymbolsByNameOnBranch(name: string, branch: string): SymbolData[] {
    return this.inner.getSymbolsByNameOnBranch(name, branch).map(normalizeSymbolDataFromRead);
  }

  getSymbolsByNamesOnBranch(names: string[], branch: string): SymbolData[] {
    if (names.length === 0) {
      return [];
    }
    return this.inner.getSymbolsByNamesOnBranch(names, branch).map(normalizeSymbolDataFromRead);
  }

  getSymbolsByNameCi(name: string): SymbolData[] {
    return this.inner.getSymbolsByNameCi(name).map(normalizeSymbolDataFromRead);
  }

  getSymbolsByNameCiOnBranch(name: string, branch: string): SymbolData[] {
    return this.inner.getSymbolsByNameCiOnBranch(name, branch).map(normalizeSymbolDataFromRead);
  }

  symbolExistsOnOtherBranches(branch: string, symbolId: string): boolean {
    return this.inner.symbolExistsOnOtherBranches(branch, symbolId);
  }

  deleteSymbolsByFile(filePath: string): number {
    return this.inner.deleteSymbolsByFile(filePath);
  }

  deleteSymbol(symbolId: string): boolean {
    return this.inner.deleteSymbol(symbolId);
  }

  // ── Call Edge methods ────────────────────────────────────────────

  upsertCallEdge(edge: CallEdgeData): void {
    this.inner.upsertCallEdge(edge);
  }

  upsertCallEdgesBatch(edges: CallEdgeData[]): void {
    if (edges.length === 0) return;
    this.inner.upsertCallEdgesBatch(edges);
  }

  getCallers(targetName: string, branch: string): CallEdgeData[] {
    return this.inner.getCallers(targetName, branch);
  }

  getCallersWithContext(targetName: string, branch: string): CallEdgeData[] {
    return this.inner.getCallersWithContext(targetName, branch);
  }

  getCallersWithContextByTargetSymbolId(targetSymbolId: string, branch: string): CallEdgeData[] {
    return this.inner.getCallersWithContextByTargetSymbolId(targetSymbolId, branch);
  }

  getCallEdgeFrontierBatch(symbolIds: string[], branch: string): CallEdgeFrontierBatch {
    if (symbolIds.length === 0) {
      return { callers: [], callees: [] };
    }

    const result = this.inner.getCallEdgeFrontierBatch(symbolIds, branch);
    return {
      callers: result.callers ?? [],
      callees: result.callees ?? [],
    };
  }

  getUnresolvedCallersByTargetNamesOnBranch(targetNames: string[], branch: string): CallEdgeData[] {
    if (targetNames.length === 0) {
      return [];
    }
    return this.inner.getUnresolvedCallersByTargetNamesOnBranch(targetNames, branch) ?? [];
  }

  getCallees(symbolId: string, branch: string): CallEdgeData[] {
    return this.inner.getCallees(symbolId, branch);
  }

  deleteCallEdgesByFile(filePath: string, branch: string): number {
    return this.inner.deleteCallEdgesByFile(filePath, branch);
  }

  deleteCallEdgesBySymbol(symbolId: string): number {
    return this.inner.deleteCallEdgesBySymbol(symbolId);
  }

  deleteCallEdgesBySymbolForBranch(symbolId: string, branch: string): number {
    return this.inner.deleteCallEdgesBySymbolForBranch(symbolId, branch);
  }

  unresolveCallEdgesByTargetSymbolForBranch(symbolId: string, branch: string): number {
    return this.inner.unresolveCallEdgesByTargetSymbolForBranch(symbolId, branch);
  }

  deleteCallEdgesByTargetSymbol(symbolId: string): number {
    return this.inner.deleteCallEdgesByTargetSymbol(symbolId);
  }

  resolveCallEdge(
    edgeId: string,
    branch: string,
    toSymbolId: string,
    targetFilePath?: string,
    targetKind?: string
  ): void {
    this.inner.resolveCallEdge(edgeId, branch, toSymbolId, targetFilePath, targetKind);
  }

  resolveUnresolvedCallEdgesForBranch(branch: string): number {
    return this.inner.resolveUnresolvedCallEdgesForBranch(branch);
  }

  // ── Branch Symbol methods ────────────────────────────────────────

  addSymbolsToBranch(branch: string, symbolIds: string[]): void {
    this.inner.addSymbolsToBranch(branch, symbolIds);
  }

  addSymbolsToBranchBatch(branch: string, symbolIds: string[]): void {
    if (symbolIds.length === 0) return;
    this.inner.addSymbolsToBranchBatch(branch, symbolIds);
  }

  getBranchSymbolIds(branch: string): string[] {
    return this.inner.getBranchSymbolIds(branch);
  }

  clearBranchSymbols(branch: string): number {
    return this.inner.clearBranchSymbols(branch);
  }

  clearAllBranchSymbols(): number {
    return this.inner.clearAllBranchSymbols();
  }

  // ── GC methods for symbols/edges ─────────────────────────────────

  gcOrphanSymbols(): number {
    return this.inner.gcOrphanSymbols();
  }

  gcOrphanCallEdges(): number {
    return this.inner.gcOrphanCallEdges();
  }
}
