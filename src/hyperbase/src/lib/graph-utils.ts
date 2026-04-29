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
import { MAX_NODE_SIZE, MIN_NODE_SIZE } from './constants';
import { getTheme } from './theme';

export function nodeColor(kind: string): string {
  const theme = getTheme();
  return theme.node[kind as keyof typeof theme.node] ?? theme.node.default;
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
  const theme = getTheme();
  const known = theme.language[language as keyof typeof theme.language];
  if (known) {
    return known;
  }

  const fallbackPalette = [
    theme.language.typescript,
    theme.language.javascript,
    theme.language.rust,
    theme.language.python,
    theme.language.go,
    theme.language.default,
  ];

  return fallbackPalette[stringToHue(language) % fallbackPalette.length] ?? theme.language.default;
}

function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function seededPosition(nodeId: string, contentId: string, axis: 'x' | 'y'): number {
  const seed = `${contentId}:${nodeId}:${axis}`;
  return seededUnit(seed) * 1000 - 500;
}

export function buildGraphologyInstance(
  nodes: FileNode[],
  edges: FileEdge[],
  contentId: string
): Graph<FileGraphNodeAttributes, GraphEdgeAttributes> {
  const theme = getTheme();
  const graph = new Graph<FileGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const maxSymbolCount = Math.max(...nodes.map((node) => node.symbolCount), 1);

  nodes.forEach((node) => {
    graph.addNode(node.id, {
      label: node.filePath.split('/').slice(-1)[0] ?? node.filePath,
      color: languageColor(node.language),
      size: nodeSize(node.symbolCount, maxSymbolCount),
      x: seededPosition(node.id, contentId, 'x'),
      y: seededPosition(node.id, contentId, 'y'),
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
        color: theme.edge.file,
        isResolved: true,
        highlighted: false,
      });
    }
  });

  return graph;
}

export function buildNeighborhoodGraphologyInstance(
  nodes: GraphNode[],
  edges: GraphEdge[],
  contentId: string
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const theme = getTheme();
  const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const maxDegree = Math.max(...nodes.map((node) => node.degree), 1);
  const collapsedEdges = new Map<string, GraphEdge>();

  nodes.forEach((node) => {
    graph.addNode(node.id, {
      label: nodeLabel(node.name, node.filePath),
      color: nodeColor(node.kind),
      size: nodeSize(node.degree, maxDegree),
      x: node.x ?? seededPosition(node.id, contentId, 'x'),
      y: node.y ?? seededPosition(node.id, contentId, 'y'),
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
    if (!edge.to) {
      return;
    }

    const pairKey = `${edge.from}->${edge.to}`;
    const existing = collapsedEdges.get(pairKey);
    if (!existing) {
      collapsedEdges.set(pairKey, edge);
      return;
    }

    if (existing.isResolved || !edge.isResolved) {
      return;
    }

    collapsedEdges.set(pairKey, edge);
  });

  collapsedEdges.forEach((edge) => {
    if (edge.to && graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        size: edge.isResolved ? 1.5 : 0.75,
        color: edge.isResolved ? theme.edge.resolved : theme.edge.unresolved,
        isResolved: edge.isResolved,
        highlighted: false,
      });
    }
  });

  return graph;
}
