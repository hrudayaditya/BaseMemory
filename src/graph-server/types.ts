import type Database from "better-sqlite3";

export type ErrorCode =
  | "INVALID_INPUT"
  | "BRANCH_NOT_FOUND"
  | "NOT_FOUND"
  | "NO_DATABASE"
  | "DB_SWITCH_IN_PROGRESS"
  | "DB_ERROR"
  | "INTERNAL_ERROR";

export type GraphSymbolRow = {
  id: string;
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  language: string;
  symbol_aliases: string;
};

export type GraphEdgeRow = {
  id: string;
  branch: string;
  from_symbol_id: string;
  caller_file_path: string | null;
  target_name: string;
  target_file_path: string | null;
  target_kind: string | null;
  to_symbol_id: string | null;
  call_type: string;
  line: number;
  col: number;
  is_resolved: number;
};

export type GraphNode = {
  id: string;
  name: string;
  entityType: "directory" | "file" | "symbol";
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  degree: number;
  role?: "internal" | "external-caller" | "external-callee" | "external-bidirectional";
  depth?: number;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string | null;
  callType: string;
  isResolved: boolean;
  callerFilePath: string | null;
  targetFilePath: string | null;
  line: number;
  boundary?: "internal" | "incoming" | "outgoing";
};

export type NeighborhoodResponse = {
  centerSymbolId: string;
  depth: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type BlastRadiusResponse = {
  symbolId: string;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: Record<string, number>;
};

export type PathNode = {
  id: string;
  name: string;
  filePath: string;
};

export type PathResponse = {
  found: boolean;
  exhausted: boolean;
  path: PathNode[];
  edges: GraphEdge[];
};

export type DirectoryGraphResponse = {
  directoryPath: string;
  truncated: boolean;
  nodes: Array<{
    id: string;
    entityType: "file";
    name: string;
    filePath: string;
    language: string;
    symbolCount: number;
    directory: string;
    degree: number;
    role?: "internal" | "external-caller" | "external-callee" | "external-bidirectional";
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    callCount: number;
    boundary: "internal" | "incoming" | "outgoing";
    callerFilePath: string;
    targetFilePath: string;
  }>;
};

export type FileGraphResponse = {
  filePath: string;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type OverviewGraphResponse = {
  granularity: number;
  nodes: Array<{
    id: string;
    entityType: "directory";
    name: string;
    directoryPath: string;
    language: string;
    symbolCount: number;
    fileCount: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    callCount: number;
  }>;
};

export type BranchRow = { branch: string };
export type DegreeRow = { symbol_id: string; degree: number };
export type FileNodeRow = { file_path: string; language: string; symbol_count: number };
export type FileEdgeRow = { from_file_path: string; to_file_path: string; call_count: number };
export type PeekRow = {
  id: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_start_line: number | null;
  chunk_end_line: number | null;
};

export type SearchResult = {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
};

export type SymbolDetail = {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  callerCount: number;
  calleeCount: number;
};

export type FullGraphResponse = {
  nodes: Array<{
    id: string;
    filePath: string;
    language: string;
    symbolCount: number;
    directory: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    callCount: number;
  }>;
};

export type GraphServerOptions = {
  dbPath?: string;
  branch?: string;
  port?: number;
};

export type GraphServerState = {
  db: Database.Database;
  queries: GraphQueryService;
  branches: string[];
  defaultBranch: string;
  dbPath: string;
  activeRequests: number;
  retired: boolean;
};

export type GraphDbInfoResponse = {
  available: boolean;
  dbPath: string | null;
  branch: string | null;
  symbolCount: number;
  resolvedEdgeCount: number;
  branches: string[];
  version: string;
};

export type GraphDemoRepo = {
  id: string;
  name: string;
  language: string;
  description: string;
  dbPath: string;
};

export type GraphServerInstance = {
  app: import("express").Express;
  server: import("http").Server;
  getCurrentState: () => GraphServerState | null;
  port: number;
  start: () => Promise<void>;
  close: () => Promise<void>;
};

export interface GraphQueryService {
  listBranches(): string[];
  getSymbolCount(branch: string): number;
  getResolvedEdgeCount(branch: string): number;
  getSymbolById(branch: string, symbolId: string): GraphSymbolRow | undefined;
  getSymbolsByIds(branch: string, symbolIds: Iterable<string>): Map<string, GraphSymbolRow>;
  getSymbolsByDirectoryPrefix(branch: string, directoryPath: string): GraphSymbolRow[];
  getSymbolsByFilePath(branch: string, filePath: string): GraphSymbolRow[];
  searchSymbols(branch: string, query: string): GraphSymbolRow[];
  getCallerCount(branch: string, symbolId: string): number;
  getCalleeCount(branch: string, symbolId: string): number;
  getResolvedCallers(branch: string, symbolIds: Iterable<string>): GraphEdgeRow[];
  getResolvedCallees(branch: string, symbolIds: Iterable<string>): GraphEdgeRow[];
  getResolvedIncident(branch: string, symbolIds: Iterable<string>): GraphEdgeRow[];
  getUnresolvedOutgoing(branch: string, symbolIds: Iterable<string>): GraphEdgeRow[];
  getDegrees(branch: string, symbolIds: Iterable<string>): Map<string, number>;
  getFullGraphNodes(branch: string): FileNodeRow[];
  getFullGraphEdges(branch: string): FileEdgeRow[];
  getPeekSymbolAndChunk(branch: string, symbolId: string): PeekRow | undefined;
}
