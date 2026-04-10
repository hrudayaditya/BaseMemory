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
  language: string;
}

export type ChunkSymbolKind =
  | "Function"
  | "Method"
  | "Class"
  | "Interface"
  | "Struct"
  | "Test"
  | "Module"
  | "Block";

export type ChunkKind = "Code" | "Test" | "Doc" | "Config";

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
  targetTokenBudget: 1500,
  maxChunkChars: 3000,
  minChunkChars: 200,
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

  remove(id: string): boolean {
    return this.inner.remove(id);
  }

  save(): void {
    this.inner.save();
  }

  load(): void {
    this.inner.load();
  }

  count(): number {
    return this.inner.count();
  }

  clear(): void {
    this.inner.clear();
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
const MAX_BATCH_TOKENS = 7500; // Leave buffer under 8192 API limit
const MAX_SINGLE_CHUNK_TOKENS = 2000; // Truncate individual chunks beyond this

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function createEmbeddingText(chunk: CodeChunk, filePath: string): string {
  const parts: string[] = [];
  
  const fileName = filePath.split("/").pop() || filePath;
  const dirPath = filePath.split("/").slice(-3, -1).join("/");
  
  const langDescriptors: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript", 
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
  };
  
  const typeDescriptors: Record<string, string> = {
    function_declaration: "function",
    function: "function",
    arrow_function: "arrow function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type alias",
    enum_declaration: "enum",
    export_statement: "export",
    lexical_declaration: "variable declaration",
    function_definition: "function",
    class_definition: "class",
    function_item: "function",
    impl_item: "implementation",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
  };

  const lang = langDescriptors[chunk.language] || chunk.language;
  const typeDesc = typeDescriptors[chunk.chunkType] || chunk.chunkType;
  
  if (chunk.name) {
    parts.push(`${lang} ${typeDesc} "${chunk.name}"`);
  } else {
    parts.push(`${lang} ${typeDesc}`);
  }
  
  if (dirPath) {
    parts.push(`in ${dirPath}/${fileName}`);
  } else {
    parts.push(`in ${fileName}`);
  }
  
  const semanticHints = extractSemanticHints(chunk.name || "", chunk.content);
  if (semanticHints.length > 0) {
    parts.push(`Purpose: ${semanticHints.join(", ")}`);
  }
  
  parts.push("");
  
  let content = chunk.content;
  const headerLength = parts.join("\n").length;
  const maxContentChars = (MAX_SINGLE_CHUNK_TOKENS * CHARS_PER_TOKEN) - headerLength;
  
  if (content.length > maxContentChars) {
    content = content.slice(0, maxContentChars) + "\n... [truncated]";
  }
  
  parts.push(content);

  return parts.join("\n");
}

export function createDynamicBatches<T extends { text: string }>(chunks: T[]): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentTokens = 0;
  
  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(chunk.text);
    
    if (currentBatch.length > 0 && currentTokens + chunkTokens > MAX_BATCH_TOKENS) {
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

function extractSemanticHints(name: string, content: string): string[] {
  const hints: string[] = [];
  const combined = `${name} ${content}`.toLowerCase();
  
  const signature = extractFunctionSignature(content);
  if (signature) {
    hints.push(signature);
  }
  
  const patterns: Array<[RegExp, string]> = [
    [/auth|login|logout|signin|signout|credential/i, "authentication"],
    [/password|hash|bcrypt|argon/i, "password handling"],
    [/token|jwt|bearer|oauth/i, "token management"],
    [/user|account|profile|member/i, "user management"],
    [/permission|role|access|authorize/i, "authorization"],
    [/validate|verify|check|assert/i, "validation"],
    [/error|exception|throw|catch/i, "error handling"],
    [/log|debug|trace|info|warn/i, "logging"],
    [/cache|memoize|store/i, "caching"],
    [/fetch|request|response|api|http/i, "HTTP/API"],
    [/database|db|query|sql|mongo/i, "database"],
    [/file|read|write|stream|path/i, "file operations"],
    [/parse|serialize|json|xml/i, "data parsing"],
    [/encrypt|decrypt|crypto|secret|cipher|cryptographic/i, "encryption/cryptography"],
    [/test|spec|mock|stub|expect/i, "testing"],
    [/config|setting|option|env/i, "configuration"],
    [/route|endpoint|handler|controller|middleware/i, "routing/middleware"],
    [/render|component|view|template/i, "UI rendering"],
    [/state|redux|store|dispatch/i, "state management"],
    [/hook|effect|memo|callback/i, "React hooks"],
  ];
  
  for (const [pattern, hint] of patterns) {
    if (pattern.test(combined) && !hints.includes(hint)) {
      hints.push(hint);
    }
  }
  
  return hints.slice(0, 6);
}

function extractFunctionSignature(content: string): string | null {
  const tsJsPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+))?\s*=>/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/,
  ];
  
  const pyPatterns = [
    /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
    /async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
  ];
  
  const goPatterns = [
    /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|([^{\n]+))?/,
  ];
  
  const rustPatterns = [
    /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/,
  ];
  
  for (const pattern of [...tsJsPatterns, ...pyPatterns, ...goPatterns, ...rustPatterns]) {
    const match = content.match(pattern);
    if (match) {
      const funcName = match[1];
      const params = match[2]?.trim() || "";
      const returnType = (match[3] || match[4])?.trim();
      
      const paramNames = extractParamNames(params);
      
      let sig = `${funcName}(${paramNames.join(", ")})`;
      if (returnType && returnType.length < 50) {
        sig += ` -> ${returnType.replace(/\s+/g, " ").trim()}`;
      }
      
      if (sig.length < 100) {
        return sig;
      }
    }
  }
  
  return null;
}

function extractParamNames(params: string): string[] {
  if (!params.trim()) return [];
  
  const names: string[] = [];
  const parts = params.split(",");
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    const tsMatch = trimmed.match(/^(\w+)\s*[?:]?/);
    const pyMatch = trimmed.match(/^(\w+)\s*(?::|=)/);
    const goMatch = trimmed.match(/^(\w+)\s+\w/);
    const rustMatch = trimmed.match(/^(\w+)\s*:/);
    
    const match = tsMatch || pyMatch || goMatch || rustMatch;
    if (match && match[1] !== "self" && match[1] !== "this") {
      names.push(match[1]);
    }
  }
  
  return names.slice(0, 5);
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

  load(): void {
    this.inner.load();
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

  hasChunk(chunkId: string): boolean {
    return this.inner.hasChunk(chunkId);
  }

  clear(): void {
    this.inner.clear();
  }

  getDocumentCount(): number {
    return this.inner.documentCount();
  }
}

export interface ChunkData {
  chunkId: string;
  contentHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  chunkKind?: string;
  symbolKind?: string;
  language: string;
}

export interface ChunkKindEnrichment {
  chunkId: string;
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
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

export interface StoredConfigVersionData {
  configHash: string;
  embeddingModelId: string;
  embeddingDimension: number;
  voyageModelId?: string | null;
  chunkerVersion: string;
  graphExtractorVersion: string;
  active: boolean;
  createdAt: number;
}

export class Database {
  private inner: any;

  constructor(dbPath: string) {
    this.inner = new native.Database(dbPath);
  }

  embeddingExists(contentHash: string): boolean {
    return this.inner.embeddingExists(contentHash);
  }

  getEmbedding(contentHash: string): Buffer | null {
    return this.inner.getEmbedding(contentHash) ?? null;
  }

  getEmbeddingForModel(contentHash: string, model: string): Buffer | null {
    return this.inner.getEmbeddingForModel(contentHash, model) ?? null;
  }

  getEmbeddingsForModelBatch(contentHashes: string[], model: string): Map<string, Buffer> {
    const results = this.inner.getEmbeddingsForModelBatch(contentHashes, model);
    const map = new Map<string, Buffer>();
    for (const item of results as Array<{
      contentHash?: string;
      content_hash?: string;
      embedding: Buffer;
    }>) {
      const contentHash = item.contentHash ?? item.content_hash;
      if (!contentHash) continue;
      map.set(contentHash, item.embedding);
    }
    return map;
  }

  upsertEmbedding(
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): void {
    this.inner.upsertEmbedding(contentHash, embedding, chunkText, model);
  }

  upsertEmbeddingsBatch(
    items: Array<{
      contentHash: string;
      embedding: Buffer;
      chunkText: string;
      model: string;
    }>
  ): void {
    if (items.length === 0) return;
    this.inner.upsertEmbeddingsBatch(items);
  }

  getMissingEmbeddings(contentHashes: string[]): string[] {
    return this.inner.getMissingEmbeddings(contentHashes);
  }

  getMissingEmbeddingsForModel(contentHashes: string[], model: string): string[] {
    return this.inner.getMissingEmbeddingsForModel(contentHashes, model);
  }

  upsertChunk(chunk: ChunkData): void {
    this.inner.upsertChunk(chunk);
  }

  upsertChunksBatch(chunks: ChunkData[]): void {
    if (chunks.length === 0) return;
    this.inner.upsertChunksBatch(chunks);
  }

  getChunk(chunkId: string): ChunkData | null {
    return this.inner.getChunk(chunkId) ?? null;
  }

  getChunksByFile(filePath: string): ChunkData[] {
    return this.inner.getChunksByFile(filePath);
  }

  getChunksByName(name: string): ChunkData[] {
    return this.inner.getChunksByName(name);
  }

  getChunksByNameCi(name: string): ChunkData[] {
    return this.inner.getChunksByNameCi(name);
  }

  getChunkKindsBatch(chunkIds: string[]): ChunkKindEnrichment[] {
    if (chunkIds.length === 0) return [];
    return this.inner.getChunkKindsBatch(chunkIds);
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

  updatePipelineRunStatus(runId: string, status: string, completedAt: number): boolean {
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

  pruneFinishedPipelineRuns(olderThan: number): number {
    return this.inner.pruneFinishedPipelineRuns(olderThan);
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

  // ── Symbol methods ──────────────────────────────────────────────

  upsertSymbol(symbol: SymbolData): void {
    this.inner.upsertSymbol(symbol);
  }

  upsertSymbolsBatch(symbols: SymbolData[]): void {
    if (symbols.length === 0) return;
    this.inner.upsertSymbolsBatch(symbols);
  }

  getSymbolsByFile(filePath: string): SymbolData[] {
    return this.inner.getSymbolsByFile(filePath);
  }

  getSymbolById(symbolId: string): SymbolData | null {
    return this.inner.getSymbolById(symbolId) ?? null;
  }

  getSymbolByName(name: string, filePath: string): SymbolData | null {
    return this.inner.getSymbolByName(name, filePath) ?? null;
  }

  getSymbolsByName(name: string): SymbolData[] {
    return this.inner.getSymbolsByName(name);
  }

  getSymbolsByNameCi(name: string): SymbolData[] {
    return this.inner.getSymbolsByNameCi(name);
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

  resolveCallEdge(
    edgeId: string,
    branch: string,
    toSymbolId: string,
    targetFilePath?: string,
    targetKind?: string
  ): void {
    this.inner.resolveCallEdge(edgeId, branch, toSymbolId, targetFilePath, targetKind);
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
