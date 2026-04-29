import Graph from 'graphology';
import type {
  FileEdge,
  FileGraphNodeAttributes,
  FileNode,
  GraphEdge,
  GraphEdgeAttributes,
  GraphNode,
  SymbolGraphNodeAttributes,
} from '../types';
import { LANGUAGE_COLORS, MAX_NODE_SIZE, MIN_NODE_SIZE, NODE_COLOR_DEFAULT, NODE_COLORS } from './constants';

export function nodeColor(kind: string): string {
  return NODE_COLORS[kind] ?? NODE_COLOR_DEFAULT;
}

export function nodeSize(degree: number, maxDegree: number): number {
  const safeMax = Math.max(maxDegree, 1);
  const normalized = Math.log(degree + 1) / Math.log(safeMax + 1);
  return MIN_NODE_SIZE + normalized * (MAX_NODE_SIZE - MIN_NODE_SIZE);
}

export function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

export function fileDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const trimmed = normalized.startsWith('/') ? parts.slice(1) : parts;
  return trimmed.slice(0, 2).join('/') || parts.slice(-2).join('/');
}

export function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function nodeLabel(name: string, filePath: string): string {
  return `${name} · ${shortPath(filePath)}`;
}

export function languageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? `hsl(${stringToHue(language)}, 65%, 58%)`;
}

export function buildGraphologyInstance(
  nodes: FileNode[],
  edges: FileEdge[]
): Graph<FileGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<FileGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const maxSymbolCount = Math.max(...nodes.map((node) => node.symbolCount), 1);

  nodes.forEach((node) => {
    graph.addNode(node.id, {
      label: node.filePath.split('/').slice(-1)[0] ?? node.filePath,
      color: languageColor(node.language),
      size: nodeSize(node.symbolCount, maxSymbolCount),
      x: Math.random() * 1000 - 500,
      y: Math.random() * 1000 - 500,
      filePath: node.filePath,
      language: node.language,
      symbolCount: node.symbolCount,
      directory: node.directory,
      highlighted: false,
      dimmed: false,
    });
  });

  edges.forEach((edge) => {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdge(edge.from, edge.to, {
        size: Math.min(Math.max(Math.log(edge.callCount + 1), 1), 4),
        color: 'rgba(255,255,255,0.08)',
        isResolved: true,
        highlighted: false,
      });
    }
  });

  return graph;
}

export function buildNeighborhoodGraphologyInstance(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const maxDegree = Math.max(...nodes.map((node) => node.degree), 1);

  nodes.forEach((node) => {
    graph.addNode(node.id, {
      label: nodeLabel(node.name, node.filePath),
      color: nodeColor(node.kind),
      size: nodeSize(node.degree, maxDegree),
      x: node.x ?? Math.random() * 1000 - 500,
      y: node.y ?? Math.random() * 1000 - 500,
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      degree: node.degree,
      startLine: node.startLine,
      name: node.name,
      community: node.community,
      communityColor: undefined,
      highlighted: false,
      dimmed: false,
    });
  });

  edges.forEach((edge) => {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        size: edge.isResolved ? 1.5 : 0.75,
        color: edge.isResolved ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.04)',
        isResolved: edge.isResolved,
        highlighted: false,
      });
    }
  });

  return graph;
}
