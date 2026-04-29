import {
  type BlastRadiusResponse,
  type FullGraphResponse,
  type GraphEdge,
  type GraphEdgeRow,
  type GraphNode,
  type GraphQueryService,
  type GraphSymbolRow,
  type NeighborhoodResponse,
  type PathResponse,
} from "./types.js";

export const MAX_NEIGHBORHOOD_DEPTH = 3;
export const MAX_NEIGHBORHOOD_NODES = 300;
export const MAX_BLAST_RADIUS_NODES = 500;
export const MAX_PATH_VISITED_NODES = 1000;

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) =>
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function edgeSortKey(edge: GraphEdge): string {
  return edge.to ?? "";
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) =>
    a.from.localeCompare(b.from) ||
    edgeSortKey(a).localeCompare(edgeSortKey(b)) ||
    a.line - b.line ||
    a.id.localeCompare(b.id)
  );
}

function makeNode(row: GraphSymbolRow, degree: number = 0): GraphNode {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    degree,
  };
}

function makeResolvedEdge(row: GraphEdgeRow): GraphEdge | null {
  if (!row.to_symbol_id) {
    return null;
  }

  return {
    id: row.id,
    from: row.from_symbol_id,
    to: row.to_symbol_id,
    callType: row.call_type,
    isResolved: row.is_resolved === 1,
    callerFilePath: row.caller_file_path,
    targetFilePath: row.target_file_path,
    line: row.line,
  };
}

function makeUnresolvedEdge(row: GraphEdgeRow): GraphEdge {
  return {
    id: row.id,
    from: row.from_symbol_id,
    to: null,
    callType: row.call_type,
    isResolved: false,
    callerFilePath: row.caller_file_path,
    targetFilePath: row.target_file_path,
    line: row.line,
  };
}

function toDirectoryPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : ".";
}

export function buildNeighborhoodGraph(
  queries: GraphQueryService,
  branch: string,
  centerSymbolId: string,
  depth: number
): NeighborhoodResponse | null {
  const center = queries.getSymbolById(branch, centerSymbolId);
  if (!center) {
    return null;
  }

  const nodesById = new Map<string, GraphSymbolRow>([[center.id, center]]);
  const edgesById = new Map<string, GraphEdge>();
  let frontier = [center.id];
  let truncated = false;

  for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth++) {
    const resolvedRows = queries.getResolvedIncident(branch, frontier);
    const missingIds = new Set<string>();

    for (const row of resolvedRows) {
      if (row.from_symbol_id && !nodesById.has(row.from_symbol_id)) {
        missingIds.add(row.from_symbol_id);
      }
      if (row.to_symbol_id && !nodesById.has(row.to_symbol_id)) {
        missingIds.add(row.to_symbol_id);
      }
    }

    const fetchedSymbols = queries.getSymbolsByIds(branch, missingIds);
    const nextFrontier: string[] = [];

    for (const [symbolId, symbol] of fetchedSymbols) {
      if (nodesById.has(symbolId)) {
        continue;
      }
      if (nodesById.size >= MAX_NEIGHBORHOOD_NODES) {
        truncated = true;
        break;
      }
      nodesById.set(symbolId, symbol);
      nextFrontier.push(symbolId);
    }

    for (const row of resolvedRows) {
      const edge = makeResolvedEdge(row);
      if (!edge || !nodesById.has(edge.from) || !edge.to || !nodesById.has(edge.to)) {
        continue;
      }
      edgesById.set(edge.id, edge);
    }

    if (truncated) {
      break;
    }

    frontier = nextFrontier;
  }

  const unresolvedRows = queries.getUnresolvedOutgoing(branch, nodesById.keys());
  for (const row of unresolvedRows) {
    if (!nodesById.has(row.from_symbol_id)) {
      continue;
    }
    edgesById.set(row.id, makeUnresolvedEdge(row));
  }

  const degrees = queries.getDegrees(branch, nodesById.keys());
  const nodes = sortNodes(Array.from(nodesById.values(), (row) => makeNode(row, degrees.get(row.id) ?? 0)));
  const edges = sortEdges(Array.from(edgesById.values()));

  return {
    centerSymbolId,
    depth,
    truncated,
    nodes,
    edges,
  };
}

export function buildBlastRadiusGraph(
  queries: GraphQueryService,
  branch: string,
  symbolId: string
): BlastRadiusResponse | null {
  const center = queries.getSymbolById(branch, symbolId);
  if (!center) {
    return null;
  }

  const nodesById = new Map<string, GraphSymbolRow>([[center.id, center]]);
  const depths = new Map<string, number>([[center.id, 0]]);
  const edgesById = new Map<string, GraphEdge>();
  let frontier = [center.id];
  let truncated = false;

  while (frontier.length > 0 && !truncated) {
    const callerRows = queries.getResolvedCallers(branch, frontier);
    const nextFrontier: string[] = [];
    const missingIds = new Set<string>();

    for (const row of callerRows) {
      if (row.from_symbol_id && !nodesById.has(row.from_symbol_id)) {
        missingIds.add(row.from_symbol_id);
      }
    }

    const fetchedSymbols = queries.getSymbolsByIds(branch, missingIds);
    for (const [nodeId, symbol] of fetchedSymbols) {
      if (nodesById.has(nodeId)) {
        continue;
      }
      if (nodesById.size >= MAX_BLAST_RADIUS_NODES) {
        truncated = true;
        break;
      }
      nodesById.set(nodeId, symbol);
    }

    for (const row of callerRows) {
      const edge = makeResolvedEdge(row);
      if (!edge || !nodesById.has(edge.from) || !edge.to || !nodesById.has(edge.to)) {
        continue;
      }
      edgesById.set(edge.id, edge);

      if (!depths.has(edge.from)) {
        const baseDepth = depths.get(edge.to) ?? 0;
        depths.set(edge.from, baseDepth + 1);
        nextFrontier.push(edge.from);
      }
    }

    frontier = nextFrontier;
  }

  const degrees = queries.getDegrees(branch, nodesById.keys());
  const nodes = sortNodes(Array.from(nodesById.values(), (row) => makeNode(row, degrees.get(row.id) ?? 0)));
  const edges = sortEdges(Array.from(edgesById.values()));
  const depthMap = Object.fromEntries(Array.from(depths.entries()).sort((a, b) => a[0].localeCompare(b[0])));

  return {
    symbolId,
    truncated,
    nodes,
    edges,
    depth: depthMap,
  };
}

export function buildShortestPath(
  queries: GraphQueryService,
  branch: string,
  fromId: string,
  toId: string
): PathResponse | "NOT_FOUND" {
  const fromSymbol = queries.getSymbolById(branch, fromId);
  const toSymbol = queries.getSymbolById(branch, toId);

  if (!fromSymbol || !toSymbol) {
    return "NOT_FOUND";
  }

  if (fromId === toId) {
    return {
      found: true,
      exhausted: false,
      path: [{ id: fromSymbol.id, name: fromSymbol.name, filePath: fromSymbol.file_path }],
      edges: [],
    };
  }

  const visited = new Set<string>([fromId]);
  let frontier: string[] = [fromId];
  const previousNode = new Map<string, string>();
  const previousEdge = new Map<string, GraphEdge>();

  while (frontier.length > 0) {
    const frontierSet = new Set(frontier);
    const edges = queries.getResolvedIncident(branch, frontier);
    const nextFrontier: string[] = [];

    for (const row of edges) {
      const edge = makeResolvedEdge(row);
      if (!edge || !edge.to) {
        continue;
      }

      const candidates: Array<{ current: string; neighbor: string }> = [];
      if (frontierSet.has(edge.from)) {
        candidates.push({ current: edge.from, neighbor: edge.to });
      }
      if (frontierSet.has(edge.to)) {
        candidates.push({ current: edge.to, neighbor: edge.from });
      }

      for (const { neighbor } of candidates) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        previousNode.set(neighbor, edge.from === neighbor ? edge.to : edge.from);
        previousEdge.set(neighbor, edge);

        if (visited.size > MAX_PATH_VISITED_NODES) {
          return {
            found: false,
            exhausted: true,
            path: [],
            edges: [],
          };
        }

        if (neighbor === toId) {
          const pathIds = [toId];
          const pathEdges: GraphEdge[] = [];
          let cursor = toId;

          while (cursor !== fromId) {
            const prev = previousNode.get(cursor);
            const prevEdge = previousEdge.get(cursor);
            if (!prev || !prevEdge) {
              break;
            }
            pathEdges.push(prevEdge);
            pathIds.push(prev);
            cursor = prev;
          }

          pathIds.reverse();
          pathEdges.reverse();
          const pathSymbols = queries.getSymbolsByIds(branch, pathIds);

          return {
            found: true,
            exhausted: false,
            path: pathIds.map((id) => {
              const symbol = pathSymbols.get(id)!;
              return { id: symbol.id, name: symbol.name, filePath: symbol.file_path };
            }),
            edges: sortEdges(pathEdges),
          };
        }

        nextFrontier.push(neighbor);
      }
    }

    frontier = nextFrontier;
  }

  return {
    found: false,
    exhausted: false,
    path: [],
    edges: [],
  };
}

export function buildFullGraph(
  queries: GraphQueryService,
  branch: string
): FullGraphResponse {
  const nodes = queries.getFullGraphNodes(branch).map((row) => ({
    id: `file::${row.file_path}`,
    filePath: row.file_path,
    language: row.language,
    symbolCount: row.symbol_count,
    directory: toDirectoryPath(row.file_path),
  }));

  const edges = queries.getFullGraphEdges(branch).map((row) => ({
    from: `file::${row.from_file_path}`,
    to: `file::${row.to_file_path}`,
    callCount: row.call_count,
  }));

  return { nodes, edges };
}
