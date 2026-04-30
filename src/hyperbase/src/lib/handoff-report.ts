import type Graph from 'graphology';
import type {
  CurrentGraphPayload,
  FileGraphNodeAttributes,
  GraphEdge,
  GraphEdgeAttributes,
  GraphNode,
  PathNode,
  SymbolGraphNodeAttributes,
} from '../types';
import type { ViewInfo } from '../stores/graph';

type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

function resolveNodeDetails(
  nodeId: string,
  graph: HyperGraph,
  payload: CurrentGraphPayload
): { id: string; name: string; filePath: string } | null {
  if (graph.hasNode(nodeId)) {
    const attributes = graph.getNodeAttributes(nodeId) as Partial<SymbolGraphNodeAttributes & FileGraphNodeAttributes>;
    return {
      id: nodeId,
      name: typeof attributes.name === 'string' ? attributes.name : typeof attributes.label === 'string' ? attributes.label : nodeId,
      filePath: String(attributes.filePath ?? ''),
    };
  }

  const nodes =
    payload.kind === 'overview' || payload.kind === 'galaxy'
      ? payload.payload.nodes.map((node) => ({ id: node.id, name: node.filePath.split('/').pop() ?? node.filePath, filePath: node.filePath }))
      : payload.kind === 'path'
        ? payload.payload.path
        : payload.payload.nodes;

  const match = nodes.find((node) => node.id === nodeId) as GraphNode | PathNode | undefined;
  if (!match) {
    return null;
  }

  if ('filePath' in match) {
    const graphMatch = match as GraphNode | PathNode;
    return {
      id: graphMatch.id,
      name: graphMatch.name,
      filePath: graphMatch.filePath,
    };
  }

  return null;
}

function graphEdges(payload: CurrentGraphPayload): GraphEdge[] {
  if (payload.kind === 'overview' || payload.kind === 'galaxy') {
    return [];
  }

  if (payload.kind === 'directory') {
    return payload.payload.edges.map((edge): GraphEdge => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      callType: 'Call',
      isResolved: true,
      callerFilePath: edge.callerFilePath,
      targetFilePath: edge.targetFilePath,
      boundary: edge.boundary,
      line: 0,
    }));
  }

  return payload.payload.edges;
}

export function deriveHandoffSelection(
  graph: HyperGraph | null,
  payload: CurrentGraphPayload | null,
  viewInfo: ViewInfo,
  selectedNodeId: string | null,
  focusedNodeIds: Set<string>
): string[] {
  if (focusedNodeIds.size > 0) {
    return Array.from(focusedNodeIds);
  }

  if (selectedNodeId) {
    return [selectedNodeId];
  }

  if (payload && viewInfo.kind === 'directory' && payload.kind === 'directory') {
    return payload.payload.nodes.filter((node) => node.role === 'internal').map((node) => node.id);
  }

  return graph ? graph.nodes().slice(0, 1) : [];
}

export function generateHandoffReport(
  selectionIds: Iterable<string>,
  graph: HyperGraph,
  payload: CurrentGraphPayload,
  viewInfo: ViewInfo
): { title: string; markdown: string } {
  const selected = new Set(Array.from(selectionIds));
  const selectedDetails = Array.from(selected)
    .map((nodeId) => resolveNodeDetails(nodeId, graph, payload))
    .filter((value): value is { id: string; name: string; filePath: string } => Boolean(value))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));

  const externalCallers = new Map<string, { name: string; filePath: string }>();
  const externalCallees = new Map<string, { name: string; filePath: string }>();
  const unresolvedEdges: GraphEdge[] = [];

  for (const edge of graphEdges(payload)) {
    if (selected.has(edge.from) && edge.to && !selected.has(edge.to)) {
      const details = resolveNodeDetails(edge.to, graph, payload);
      if (details) {
        externalCallees.set(details.id, { name: details.name, filePath: details.filePath });
      }
    }

    if (edge.to && selected.has(edge.to) && !selected.has(edge.from)) {
      const details = resolveNodeDetails(edge.from, graph, payload);
      if (details) {
        externalCallers.set(details.id, { name: details.name, filePath: details.filePath });
      }
    }

    if (!edge.to && selected.has(edge.from)) {
      unresolvedEdges.push(edge);
    }
  }

  const title =
    viewInfo.kind === 'directory'
      ? `Handoff: ${viewInfo.directoryPath}`
      : selectedDetails.length === 1
        ? `Handoff: ${selectedDetails[0].name}`
        : `Handoff: ${selectedDetails.length} nodes`;

  const summary = `This subsystem has ${selectedDetails.length} symbols, ${externalCallees.size} external dependencies, ${externalCallers.size} things that depend on it, and ${unresolvedEdges.length} unresolved dependencies.`;

  const symbolSection = selectedDetails.length
    ? selectedDetails.map((detail) => `- \`${detail.name}\` — \`${detail.filePath}\``).join('\n')
    : '- None selected';

  const callerSection = externalCallers.size
    ? Array.from(externalCallers.values())
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name))
        .map((detail) => `- \`${detail.name}\` — \`${detail.filePath}\``)
        .join('\n')
    : '- None';

  const calleeSection = externalCallees.size
    ? Array.from(externalCallees.values())
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name))
        .map((detail) => `- \`${detail.name}\` — \`${detail.filePath}\``)
        .join('\n')
    : '- None';

  const unresolvedSection = unresolvedEdges.length
    ? unresolvedEdges
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((edge) => `- \`${edge.callType}\` from \`${resolveNodeDetails(edge.from, graph, payload)?.name ?? edge.from}\` at line ${edge.line}`)
        .join('\n')
    : '- None';

  const markdown = [
    `# ${title}`,
    '',
    summary,
    '',
    '## Symbols',
    symbolSection,
    '',
    '## External Callers',
    callerSection,
    '',
    '## External Callees',
    calleeSection,
    '',
    '## Unresolved Edges',
    unresolvedSection,
  ].join('\n');

  return { title, markdown };
}
