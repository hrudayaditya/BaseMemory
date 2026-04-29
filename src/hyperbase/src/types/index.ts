export interface GraphNode {
  id: string;
  name: string;
  kind: 'function' | 'method' | 'struct' | 'class' | 'constant' | 'module' | 'interface' | 'type' | string;
  filePath: string;
  language: string;
  startLine: number;
  degree: number;
  community?: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  callType: string;
  isResolved: boolean;
  callerFilePath: string | null;
  targetFilePath: string | null;
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
  filePath: string;
  language: string;
  symbolCount: number;
  directory: string;
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

export interface HealthResponse {
  status: string;
  dbPath: string;
  branch: string;
  symbolCount: number;
  resolvedEdgeCount: number;
  version: string;
}

export interface FileGraphNodeAttributes {
  label: string;
  color: string;
  size: number;
  x: number;
  y: number;
  filePath: string;
  language: string;
  symbolCount: number;
  directory: string;
  highlighted?: boolean;
  dimmed?: boolean;
}

export interface SymbolGraphNodeAttributes {
  label: string;
  color: string;
  size: number;
  x: number;
  y: number;
  filePath: string;
  language: string;
  kind: string;
  degree: number;
  startLine: number;
  name: string;
  community?: number;
  communityColor?: string;
  highlighted?: boolean;
  dimmed?: boolean;
}

export interface GraphEdgeAttributes {
  size: number;
  color: string;
  isResolved: boolean;
  highlighted?: boolean;
}

export interface UrlState {
  branch?: string;
  symbolId?: string;
  depth?: number;
  view?: string;
}

export type Overlay = 'none' | 'community' | 'degree' | 'language';
export type ZoomLevel = 'galaxy' | 'solar' | 'atom';
