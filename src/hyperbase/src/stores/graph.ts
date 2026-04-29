import Graph from 'graphology';
import type Sigma from 'sigma';
import { derived, writable } from 'svelte/store';
import type {
  FileEdge,
  FileNode,
  GraphEdgeAttributes,
  SymbolGraphNodeAttributes,
  FileGraphNodeAttributes,
  ZoomLevel,
} from '../types';

export const graphInstance = writable<Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes> | null>(null);
export const sigmaInstance = writable<Sigma | null>(null);

export const fileNodes = writable<FileNode[]>([]);
export const fileEdges = writable<FileEdge[]>([]);

export const graphLoading = writable<boolean>(false);
export const graphError = writable<string | null>(null);
export const graphTruncated = writable<boolean>(false);

export const activeBranch = writable<string>('');
export const availableBranches = writable<string[]>([]);
export const focusedSymbolId = writable<string | null>(null);
export const zoomLevel = writable<ZoomLevel>('galaxy');

export const graphNodeCount = writable<number>(0);
export const graphEdgeCount = writable<number>(0);

export const cameraState = writable<{ x: number; y: number; ratio: number; angle: number }>({
  x: 0.5,
  y: 0.5,
  ratio: 1,
  angle: 0,
});

export const graphStats = derived(
  [graphNodeCount, graphEdgeCount],
  ([$nodeCount, $edgeCount]) => ({ nodeCount: $nodeCount, edgeCount: $edgeCount })
);
