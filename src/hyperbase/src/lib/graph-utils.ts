import Graph from 'graphology';
import type {
  BlastRadiusResponse,
  DirectoryGraphResponse,
  FileGraphResponse,
  FullSymbolGraphResponse,
  PathNode,
  FileEdge,
  FileGraphNodeAttributes,
  FileNode,
  GraphEdge,
  GraphEdgeAttributes,
  GraphNode,
  OverviewGraphResponse,
  SymbolGraphNodeAttributes,
} from '../types';
import { FULL_SYMBOL_FILE_RING_RADIUS, MAX_NODE_SIZE, MIN_NODE_SIZE } from './constants';
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

function buildDegreeMap(nodes: string[], edges: Array<{ from: string; to: string }>): Map<string, number> {
  const degreeMap = new Map<string, number>(nodes.map((nodeId) => [nodeId, 0]));

  edges.forEach((edge) => {
    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
  });

  return degreeMap;
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

export function inferLanguageFromPath(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) return 'typescript';
  if (normalized.endsWith('.js') || normalized.endsWith('.jsx') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs')) {
    return 'javascript';
  }
  if (normalized.endsWith('.rs')) return 'rust';
  if (normalized.endsWith('.py')) return 'python';
  if (normalized.endsWith('.go')) return 'go';
  return 'default';
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

function seededRange(seed: string, min: number, max: number): number {
  return min + seededUnit(seed) * (max - min);
}

function circleSeedPosition(nodeId: string, contentId: string, index: number, total: number, radius = 320): { x: number; y: number } {
  const safeTotal = Math.max(total, 1);
  const baseAngle = (index / safeTotal) * Math.PI * 2;
  const angle = baseAngle + seededRange(`${contentId}:${nodeId}:circle:angle`, -0.14, 0.14);
  const radial = radius + seededRange(`${contentId}:${nodeId}:circle:radius`, -48, 48);
  return {
    x: Math.cos(angle) * radial,
    y: Math.sin(angle) * radial,
  };
}

function clusterSeedPosition(
  nodeId: string,
  contentId: string,
  anchor: { x: number; y: number },
  index: number,
  total: number
): { x: number; y: number } {
  const safeTotal = Math.max(total, 1);
  const baseAngle = (index / safeTotal) * Math.PI * 2;
  const angle = baseAngle + seededRange(`${contentId}:${nodeId}:cluster:angle`, -0.22, 0.22);
  const radiusBase = Math.min(112, 18 + Math.sqrt(safeTotal) * 11);
  const radius = radiusBase + seededRange(`${contentId}:${nodeId}:cluster:radius`, -10, 18);
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
  };
}

function blastDepthColor(depth: number): string {
  const theme = getTheme();
  if (depth <= 0) {
    return theme.analytics.hotspot;
  }
  if (depth === 1) {
    return theme.analytics.blastDepth1;
  }
  if (depth === 2) {
    return theme.analytics.blastDepth2;
  }
  if (depth === 3) {
    return theme.analytics.blastDepth3;
  }
  return theme.analytics.blastDepthBeyond;
}

export function buildGraphologyInstance(
  nodes: FileNode[],
  edges: FileEdge[],
  contentId: string
): Graph<FileGraphNodeAttributes, GraphEdgeAttributes> {
  const theme = getTheme();
  const graph = new Graph<FileGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const maxSymbolCount = Math.max(...nodes.map((node) => node.symbolCount), 1);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const degreeMap = buildDegreeMap(
    nodes.map((node) => node.id),
    edges
  );

  nodes.forEach((node) => {
    graph.addNode(node.id, {
      label: node.name,
      color: languageColor(node.language),
      size: nodeSize(node.symbolCount, maxSymbolCount),
      x: seededPosition(node.id, contentId, 'x'),
      y: seededPosition(node.id, contentId, 'y'),
      entityType: node.entityType,
      name: node.name,
      filePath: node.filePath,
      language: node.language,
      symbolCount: node.symbolCount,
      directory: node.directory,
      directoryPath: node.directoryPath,
      fileCount: node.fileCount,
      degree: degreeMap.get(node.id) ?? 0,
      highlighted: false,
      dimmed: false,
    });
  });

  edges.forEach((edge) => {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to) && fromNode && toNode) {
      graph.addEdge(edge.from, edge.to, {
        size: Math.min(Math.max(Math.log(edge.callCount + 1), 1), 4),
        color: theme.edge.file,
        isResolved: true,
        callCount: edge.callCount,
        callerFilePath: fromNode.filePath,
        targetFilePath: toNode.filePath,
        highlighted: false,
      });
    }
  });

  return graph;
}

export function buildOverviewGraphologyInstance(
  payload: OverviewGraphResponse,
  contentId: string
): Graph<FileGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<FileGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const theme = getTheme();
  const maxSymbolCount = Math.max(...payload.nodes.map((node) => node.symbolCount), 1);
  const sortedNodes = [...payload.nodes].sort((a, b) => a.name.localeCompare(b.name));

  sortedNodes.forEach((node, index) => {
    const position = circleSeedPosition(node.id, contentId, index, sortedNodes.length, 280);
    graph.addNode(node.id, {
      label: node.name,
      color: languageColor(node.language),
      size: nodeSize(node.symbolCount, maxSymbolCount),
      x: position.x,
      y: position.y,
      entityType: 'directory',
      name: node.name,
      filePath: node.filePath,
      language: node.language,
      symbolCount: node.symbolCount,
      directory: node.directory,
      directoryPath: node.directoryPath,
      fileCount: node.fileCount,
      degree: node.degree ?? 0,
      highlighted: false,
      dimmed: false,
    });
  });

  payload.edges.forEach((edge) => {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(`${edge.from}->${edge.to}`, edge.from, edge.to, {
        size: Math.min(Math.max(Math.log(edge.callCount + 1), 1), 4),
        color: theme.edge.file,
        isResolved: true,
        callCount: edge.callCount,
        callerFilePath: graph.getNodeAttributes(edge.from).filePath,
        targetFilePath: graph.getNodeAttributes(edge.to).filePath,
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
      entityType: 'symbol',
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      degree: node.degree,
      startLine: node.startLine,
      name: node.name,
      role: node.role,
      depth: node.depth,
      layoutRole: node.role,
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
        callCount: 1,
        callerFilePath: edge.callerFilePath,
        targetFilePath: edge.targetFilePath,
        highlighted: false,
      });
    }
  });

  return graph;
}

function directorySeedPosition(
  nodeId: string,
  contentId: string,
  role: SymbolGraphNodeAttributes['layoutRole']
): { x: number; y: number } {
  if (!role || role === 'internal') {
    return {
      x: seededRange(`${contentId}:${nodeId}:directory:center:x`, -180, 180),
      y: seededRange(`${contentId}:${nodeId}:directory:center:y`, -140, 140),
    };
  }

  const radius = seededRange(`${contentId}:${nodeId}:directory:radius`, 320, 460);
  const angle =
    role === 'external-caller'
      ? seededRange(`${contentId}:${nodeId}:directory:angle`, Math.PI * 0.65, Math.PI * 1.35)
      : role === 'external-callee'
        ? seededRange(`${contentId}:${nodeId}:directory:angle`, -Math.PI * 0.35, Math.PI * 0.35)
        : seededRange(`${contentId}:${nodeId}:directory:angle`, Math.PI * 1.35, Math.PI * 1.65);

  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

export function buildBlastRadiusGraphologyInstance(
  payload: BlastRadiusResponse,
  contentId: string
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = buildNeighborhoodGraphologyInstance(payload.nodes, payload.edges, contentId);

  payload.nodes.forEach((node) => {
    if (!graph.hasNode(node.id)) {
      return;
    }

    const depth = payload.depth[node.id] ?? node.depth ?? 0;
    graph.mergeNodeAttributes(node.id, {
      color: blastDepthColor(depth),
      depth,
      role: node.role,
    });
  });

  return graph;
}

function moduleSeedPosition(
  nodeId: string,
  contentId: string,
  role: FileGraphNodeAttributes['layoutRole']
): { x: number; y: number } {
  if (!role || role === 'internal') {
    return {
      x: seededRange(`${contentId}:${nodeId}:module:center:x`, -220, 220),
      y: seededRange(`${contentId}:${nodeId}:module:center:y`, -160, 160),
    };
  }

  const radius = seededRange(`${contentId}:${nodeId}:module:radius`, 360, 520);
  const angle =
    role === 'external-caller'
      ? seededRange(`${contentId}:${nodeId}:module:angle`, Math.PI * 0.65, Math.PI * 1.35)
      : role === 'external-callee'
        ? seededRange(`${contentId}:${nodeId}:module:angle`, -Math.PI * 0.35, Math.PI * 0.35)
        : seededRange(`${contentId}:${nodeId}:module:angle`, Math.PI * 1.35, Math.PI * 1.65);

  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

export function buildDirectoryGraphologyInstance(
  payload: DirectoryGraphResponse,
  contentId: string
): Graph<FileGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<FileGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const theme = getTheme();
  const maxSymbolCount = Math.max(...payload.nodes.map((node) => node.symbolCount), 1);

  payload.nodes.forEach((node) => {
    const position = moduleSeedPosition(node.id, contentId, node.role);
    const isInternal = !node.role || node.role === 'internal';
    graph.addNode(node.id, {
      label: node.name,
      color: isInternal ? languageColor(node.language) : theme.node.default,
      size: isInternal ? nodeSize(node.symbolCount, maxSymbolCount) : Math.max(4, nodeSize(node.symbolCount, maxSymbolCount) * 0.72),
      x: position.x,
      y: position.y,
      entityType: 'file',
      name: node.name,
      filePath: node.filePath,
      language: node.language,
      symbolCount: node.symbolCount,
      directory: node.directory,
      directoryPath: node.directory,
      fileCount: 1,
      degree: node.degree ?? 0,
      layoutRole: node.role,
      highlighted: false,
      dimmed: false,
    });
  });

  payload.edges.forEach((edge) => {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        size: edge.boundary === 'internal' ? 1.4 : 0.9,
        color:
          edge.boundary === 'internal'
            ? theme.edge.resolved
            : edge.boundary === 'incoming'
              ? theme.analytics.couplingCross
              : theme.node.dimmed,
        isResolved: true,
        callCount: edge.callCount,
        callerFilePath: edge.callerFilePath,
        targetFilePath: edge.targetFilePath,
        boundary: edge.boundary,
        highlighted: false,
      });
    }
  });

  return graph;
}

export function buildFileGraphologyInstance(
  payload: FileGraphResponse,
  contentId: string
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const theme = getTheme();
  const maxDegree = Math.max(...payload.nodes.map((node) => node.degree), 1);
  const collapsedEdges = new Map<
    string,
    {
      edge: GraphEdge;
      callCount: number;
    }
  >();

  payload.nodes.forEach((node) => {
    const position = directorySeedPosition(node.id, contentId, node.role);
    const isInternal = !node.role || node.role === 'internal';
    graph.addNode(node.id, {
      label: nodeLabel(node.name, node.filePath),
      color: isInternal ? nodeColor(node.kind) : theme.node.default,
      size: isInternal ? nodeSize(node.degree, maxDegree) : Math.max(4, nodeSize(node.degree, maxDegree) * 0.7),
      x: node.x ?? position.x,
      y: node.y ?? position.y,
      entityType: 'symbol',
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      degree: node.degree,
      startLine: node.startLine,
      name: node.name,
      role: node.role,
      layoutRole: node.role,
      community: node.community,
      communityColor: undefined,
      highlighted: false,
      dimmed: false,
    });
  });

  payload.edges.forEach((edge) => {
    if (!edge.to) {
      return;
    }

    const pairKey = `${edge.from}->${edge.to}`;
    const existing = collapsedEdges.get(pairKey);
    if (!existing) {
      collapsedEdges.set(pairKey, { edge, callCount: 1 });
      return;
    }

    existing.callCount += 1;
  });

  collapsedEdges.forEach(({ edge, callCount }) => {
    if (edge.to && graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        size: edge.boundary === 'internal' ? 1.4 : 0.9,
        color:
          edge.boundary === 'internal'
            ? theme.edge.resolved
            : edge.boundary === 'incoming'
              ? theme.analytics.couplingCross
              : theme.node.dimmed,
        isResolved: edge.isResolved,
        callCount,
        callerFilePath: edge.callerFilePath,
        targetFilePath: edge.targetFilePath,
        boundary: edge.boundary,
        highlighted: false,
      });
    }
  });

  return graph;
}

export function buildFullSymbolGraphologyInstance(
  payload: FullSymbolGraphResponse,
  contentId: string
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const theme = getTheme();
  const maxDegree = Math.max(...payload.nodes.map((node) => node.degree), 1);
  const nodesByFile = new Map<string, typeof payload.nodes>();
  const collapsedEdges = new Map<
    string,
    {
      id: string;
      from: string;
      to: string;
      callerFilePath: string | null;
      targetFilePath: string | null;
      callCount: number;
      isResolved: boolean;
    }
  >();

  payload.nodes.forEach((node) => {
    const existing = nodesByFile.get(node.filePath);
    if (existing) {
      existing.push(node);
    } else {
      nodesByFile.set(node.filePath, [node]);
    }
  });

  const sortedFiles = Array.from(nodesByFile.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const fileAnchors = new Map<string, { x: number; y: number }>();
  sortedFiles.forEach(([filePath], index) => {
    fileAnchors.set(filePath, circleSeedPosition(`file-anchor::${filePath}`, contentId, index, sortedFiles.length, FULL_SYMBOL_FILE_RING_RADIUS));
  });

  sortedFiles.forEach(([filePath, fileNodes]) => {
    const anchor = fileAnchors.get(filePath) ?? { x: 0, y: 0 };
    const sortedNodes = [...fileNodes].sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
    sortedNodes.forEach((node, index) => {
      const position = clusterSeedPosition(node.id, contentId, anchor, index, sortedNodes.length);
      graph.addNode(node.id, {
        label: nodeLabel(node.name, node.filePath),
        color: nodeColor(node.kind),
        size: nodeSize(node.degree, maxDegree),
        x: position.x,
        y: position.y,
        entityType: 'symbol',
        filePath: node.filePath,
        language: node.language,
        kind: node.kind,
        degree: node.degree,
        startLine: node.startLine,
        name: node.name,
        role: node.role,
        layoutRole: node.role,
        community: node.community,
        communityColor: undefined,
        highlighted: false,
        dimmed: false,
      });
    });
  });

  payload.edges.forEach((edge) => {
    if (!edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to)) {
      return;
    }

    const pairKey = `${edge.from}->${edge.to}`;
    const existing = collapsedEdges.get(pairKey);
    if (existing) {
      existing.callCount += 1;
      return;
    }

    collapsedEdges.set(pairKey, {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      callerFilePath: edge.callerFilePath,
      targetFilePath: edge.targetFilePath,
      callCount: 1,
      isResolved: edge.isResolved,
    });
  });

  collapsedEdges.forEach((edge) => {
    graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
      size: Math.min(Math.max(Math.log(edge.callCount + 1), 0.7), 2.4),
      color:
        edge.callerFilePath && edge.targetFilePath && edge.callerFilePath === edge.targetFilePath
          ? theme.edge.unresolved
          : theme.edge.resolved,
      isResolved: edge.isResolved,
      callCount: edge.callCount,
      callerFilePath: edge.callerFilePath,
      targetFilePath: edge.targetFilePath,
      highlighted: false,
    });
  });

  return graph;
}

export function buildPathGraphologyInstance(
  nodes: PathNode[],
  edges: GraphEdge[],
  contentId: string
): Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes> {
  const theme = getTheme();
  const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
  const degreeMap = new Map<string, number>();
  const spacing = 160;
  const offset = ((nodes.length - 1) * spacing) / 2;

  edges.forEach((edge) => {
    if (!edge.to) {
      return;
    }

    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
  });

  nodes.forEach((node, index) => {
    const language = inferLanguageFromPath(node.filePath);
    graph.addNode(node.id, {
      label: nodeLabel(node.name, node.filePath),
      color: nodeColor('function'),
      size: nodeSize(degreeMap.get(node.id) ?? 1, Math.max(...degreeMap.values(), 1)),
      x: index * spacing - offset,
      y: seededPosition(node.id, contentId, 'y') * 0.12,
      entityType: 'symbol',
      filePath: node.filePath,
      language,
      kind: 'function',
      degree: degreeMap.get(node.id) ?? 0,
      startLine: 0,
      name: node.name,
      community: undefined,
      communityColor: undefined,
      highlighted: false,
      dimmed: false,
    });
  });

  edges.forEach((edge) => {
    if (edge.to && graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        size: 2,
        color: theme.edge.path,
        isResolved: edge.isResolved,
        callCount: 1,
        callerFilePath: edge.callerFilePath,
        targetFilePath: edge.targetFilePath,
        highlighted: false,
      });
    }
  });

  return graph;
}
