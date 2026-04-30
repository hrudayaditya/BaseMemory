export interface GraphNode {
  id: string;
  name: string;
  entityType: 'directory' | 'file' | 'symbol';
  kind: 'function' | 'method' | 'struct' | 'class' | 'constant' | 'module' | 'interface' | 'type' | string;
  filePath: string;
  language: string;
  startLine: number;
  degree: number;
  community?: number;
  role?: 'internal' | 'external-caller' | 'external-callee' | 'external-bidirectional';
  depth?: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string | null;
  callType: string;
  isResolved: boolean;
  callerFilePath: string | null;
  targetFilePath: string | null;
  boundary?: 'internal' | 'incoming' | 'outgoing';
  line: number;
}

export interface NeighborhoodResponse {
  centerSymbolId: string;
  depth: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FileNode {
  id: string;
  entityType: 'file' | 'directory';
  name: string;
  filePath: string;
  language: string;
  symbolCount: number;
  directory: string;
  fileCount?: number;
  directoryPath?: string;
  role?: 'internal' | 'external-caller' | 'external-callee' | 'external-bidirectional';
  degree?: number;
}

export interface FileEdge {
  from: string;
  to: string;
  callCount: number;
}

export interface FullGraphResponse {
  nodes: FileNode[];
  edges: FileEdge[];
}

export interface OverviewGraphResponse {
  granularity: number;
  nodes: FileNode[];
  edges: FileEdge[];
}

export interface SearchResult {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
}

export interface SymbolDetail {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  callerCount: number;
  calleeCount: number;
}

export interface PeekResult {
  symbolId: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string | null;
}

export interface BlastRadiusResponse {
  symbolId: string;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: Record<string, number>;
}

export interface DirectoryGraphResponse {
  directoryPath: string;
  truncated: boolean;
  nodes: FileNode[];
  edges: Array<FileEdge & { id: string; boundary: 'internal' | 'incoming' | 'outgoing'; callerFilePath: string; targetFilePath: string }>;
}

export interface FileGraphResponse {
  filePath: string;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PathNode {
  id: string;
  name: string;
  filePath: string;
}

export interface PathResponse {
  found: boolean;
  exhausted: boolean;
  path: PathNode[];
  edges: GraphEdge[];
}

export type CurrentGraphPayload =
  | { kind: 'overview'; payload: OverviewGraphResponse }
  | { kind: 'galaxy'; payload: FullGraphResponse }
  | { kind: 'neighborhood'; payload: NeighborhoodResponse }
  | { kind: 'blast-radius'; payload: BlastRadiusResponse }
  | { kind: 'directory'; payload: DirectoryGraphResponse }
  | { kind: 'file'; payload: FileGraphResponse }
  | { kind: 'path'; payload: PathResponse };

export interface HealthResponse {
  status: string;
  dbPath: string | null;
  branch: string | null;
  symbolCount: number;
  resolvedEdgeCount: number;
  version: string;
}

export interface DbInfoResponse {
  available: boolean;
  dbPath: string | null;
  branch: string | null;
  symbolCount: number;
  resolvedEdgeCount: number;
  branches: string[];
  version: string;
}

export interface DemoRepoInfo {
  id: string;
  name: string;
  language: string;
  description: string;
  fileCount: number;
  symbolCount: number;
}

export interface FileGraphNodeAttributes {
  label: string;
  color: string;
  size: number;
  x: number;
  y: number;
  entityType: 'file' | 'directory';
  name: string;
  filePath: string;
  language: string;
  symbolCount: number;
  directory: string;
  fileCount?: number;
  directoryPath?: string;
  degree: number;
  layoutRole?: 'internal' | 'external-caller' | 'external-callee' | 'external-bidirectional';
  highlighted?: boolean;
  dimmed?: boolean;
}

export interface SymbolGraphNodeAttributes {
  label: string;
  color: string;
  size: number;
  x: number;
  y: number;
  entityType: 'symbol' | 'file' | 'directory';
  filePath: string;
  language: string;
  kind: string;
  degree: number;
  startLine: number;
  name: string;
  role?: 'internal' | 'external-caller' | 'external-callee' | 'external-bidirectional';
  depth?: number;
  layoutRole?: 'internal' | 'external-caller' | 'external-callee' | 'external-bidirectional';
  community?: number;
  communityColor?: string;
  highlighted?: boolean;
  dimmed?: boolean;
}

export interface GraphEdgeAttributes {
  size: number;
  color: string;
  isResolved: boolean;
  callCount?: number;
  callerFilePath?: string | null;
  targetFilePath?: string | null;
  boundary?: 'internal' | 'incoming' | 'outgoing';
  highlighted?: boolean;
}

export interface UrlState {
  branch?: string;
  symbolId?: string;
  filePath?: string;
  fromId?: string;
  toId?: string;
  directoryPath?: string;
  focus?: boolean;
  focusedIds?: string[];
  depth?: number;
  view?: string;
}

export type Overlay = 'none' | 'community' | 'degree' | 'language' | 'coupling' | 'dead' | 'hotspot';
export type ZoomLevel = 'overview' | 'galaxy' | 'solar' | 'atom';
