import {
  type BlastRadiusResponse,
  type FileGraphResponse,
  type FullSymbolGraphResponse,
  type FullGraphResponse,
  type GraphEdge,
  type GraphEdgeRow,
  type GraphNode,
  type GraphQueryService,
  type GraphSymbolRow,
  type DirectoryGraphResponse,
  type NeighborhoodResponse,
  type OverviewGraphResponse,
  type PathResponse,
} from "./types.js";

export const MAX_NEIGHBORHOOD_DEPTH = 3;
export const MAX_NEIGHBORHOOD_NODES = 300;
export const MAX_BLAST_RADIUS_NODES = 500;
export const MAX_DIRECTORY_NODES = 10_000;
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

function makeNode(
  row: GraphSymbolRow,
  degree: number = 0,
  extras: Partial<Pick<GraphNode, "role" | "depth">> = {}
): GraphNode {
  return {
    id: row.id,
    name: row.name,
    entityType: "symbol",
    kind: row.kind,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    degree,
    ...extras,
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

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function splitPath(filePath: string): string[] {
  return normalizePath(filePath).split("/").filter(Boolean);
}

function commonPathPrefix(paths: string[]): string[] {
  if (paths.length === 0) {
    return [];
  }

  const segments = paths.map(splitPath);
  const shortest = Math.min(...segments.map((parts) => parts.length));
  const prefix: string[] = [];

  for (let index = 0; index < shortest; index += 1) {
    const value = segments[0]?.[index];
    if (!value || segments.some((parts) => parts[index] !== value)) {
      break;
    }
    prefix.push(value);
  }

  return prefix;
}

function relativeSegments(filePath: string, rootSegments: string[]): string[] {
  const parts = splitPath(filePath);
  let index = 0;
  while (index < rootSegments.length && parts[index] === rootSegments[index]) {
    index += 1;
  }
  return parts.slice(index);
}

function joinPath(rootSegments: string[], relative: string[]): string {
  if (rootSegments.length === 0 && relative.length === 0) {
    return ".";
  }
  const parts = [...rootSegments, ...relative];
  return `${parts.length > 0 ? "/" : ""}${parts.join("/")}`;
}

function labelForPrefix(relativePrefix: string[]): string {
  return relativePrefix.length > 0 ? relativePrefix.join("/") : "root";
}

type ExternalRole = "external-caller" | "external-callee" | "external-bidirectional";

function mergeExternalRole(
  current: ExternalRole | undefined,
  next: Exclude<ExternalRole, "external-bidirectional">
): ExternalRole {
  if (!current || current === next) {
    return next;
  }
  return "external-bidirectional";
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
  const nodes = sortNodes(
    Array.from(nodesById.values(), (row) =>
      makeNode(row, degrees.get(row.id) ?? 0, { depth: depths.get(row.id) ?? 0 })
    )
  );
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

export function buildDirectoryGraph(
  queries: GraphQueryService,
  branch: string,
  directoryPath: string
): DirectoryGraphResponse | null {
  const normalizedDirectory = normalizePath(directoryPath).replace(/\/+$/, "");
  const allFiles = queries.getFullGraphNodes(branch);
  const allEdges = queries.getFullGraphEdges(branch);
  const internalFiles = allFiles.filter((row) => {
    const filePath = normalizePath(row.file_path);
    return filePath === normalizedDirectory || filePath.startsWith(`${normalizedDirectory}/`);
  });

  if (internalFiles.length === 0) {
    return null;
  }

  const internalPaths = new Set(internalFiles.map((row) => normalizePath(row.file_path)));
  const nodesById = new Map(
    internalFiles.map((row) => [
      `file::${row.file_path}`,
      {
        id: `file::${row.file_path}`,
        entityType: "file" as const,
        name: row.file_path.split("/").pop() ?? row.file_path,
        filePath: row.file_path,
        language: row.language,
        symbolCount: row.symbol_count,
        directory: toDirectoryPath(row.file_path),
        degree: 0,
        role: "internal" as const,
      },
    ]),
  );
  const rolesById = new Map<string, ExternalRole>();
  const edgesById = new Map<
    string,
    {
      id: string;
      from: string;
      to: string;
      callCount: number;
      boundary: "internal" | "incoming" | "outgoing";
      callerFilePath: string;
      targetFilePath: string;
    }
  >();
  let truncated = false;

  for (const row of allEdges) {
    const fromFilePath = normalizePath(row.from_file_path);
    const toFilePath = normalizePath(row.to_file_path);
    const fromInternal = internalPaths.has(fromFilePath);
    const toInternal = internalPaths.has(toFilePath);

    if (!fromInternal && !toInternal) {
      continue;
    }

    const edgeId = `file-edge::${fromFilePath}->${toFilePath}`;
    const fromId = `file::${row.from_file_path}`;
    const toId = `file::${row.to_file_path}`;
    const boundary =
      fromInternal && toInternal ? "internal" : fromInternal ? "outgoing" : "incoming";

    if (fromInternal && !toInternal) {
      rolesById.set(toId, mergeExternalRole(rolesById.get(toId), "external-callee"));
    } else if (!fromInternal && toInternal) {
      rolesById.set(fromId, mergeExternalRole(rolesById.get(fromId), "external-caller"));
    }

    const existing = edgesById.get(edgeId);
    if (existing) {
      existing.callCount += row.call_count;
    } else {
      edgesById.set(edgeId, {
        id: edgeId,
        from: fromId,
        to: toId,
        callCount: row.call_count,
        boundary,
        callerFilePath: row.from_file_path,
        targetFilePath: row.to_file_path,
      });
    }
  }

  const fileMetrics = new Map<string, { language: string; symbolCount: number; directory: string; degree: number }>();
  allFiles.forEach((row) => {
    fileMetrics.set(normalizePath(row.file_path), {
      language: row.language,
      symbolCount: row.symbol_count,
      directory: toDirectoryPath(row.file_path),
      degree: 0,
    });
  });

  edgesById.forEach((edge) => {
    const fromMetrics = fileMetrics.get(normalizePath(edge.callerFilePath));
    const toMetrics = fileMetrics.get(normalizePath(edge.targetFilePath));
    if (fromMetrics) {
      fromMetrics.degree += edge.callCount;
    }
    if (toMetrics) {
      toMetrics.degree += edge.callCount;
    }
  });

  for (const [nodeId, role] of rolesById) {
    if (nodesById.has(nodeId)) {
      continue;
    }

    if (nodesById.size >= MAX_DIRECTORY_NODES) {
      truncated = true;
      break;
    }

    const filePath = nodeId.replace(/^file::/, "");
    const metrics = fileMetrics.get(normalizePath(filePath));
    if (!metrics) {
      continue;
    }

    nodesById.set(nodeId, {
      id: nodeId,
      entityType: "file",
      name: filePath.split("/").pop() ?? filePath,
      filePath,
      language: metrics.language,
      symbolCount: metrics.symbolCount,
      directory: metrics.directory,
      degree: metrics.degree,
      role,
    });
  }

  return {
    directoryPath: normalizedDirectory,
    truncated,
    nodes: Array.from(nodesById.values()).sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name)),
    edges: Array.from(edgesById.values())
      .filter((edge) => nodesById.has(edge.from) && nodesById.has(edge.to))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

export function buildFileGraph(
  queries: GraphQueryService,
  branch: string,
  filePath: string
): FileGraphResponse | null {
  const internalRows = queries.getSymbolsByFilePath(branch, filePath);
  if (internalRows.length === 0) {
    return null;
  }

  const internalIds = new Set(internalRows.map((row) => row.id));
  const nodesById = new Map<string, GraphSymbolRow>(internalRows.map((row) => [row.id, row]));
  const edgesById = new Map<string, GraphEdge>();
  const incidentRows = queries.getResolvedIncident(branch, internalIds);

  for (const row of incidentRows) {
    const edge = makeResolvedEdge(row);
    if (!edge || !edge.to) {
      continue;
    }

    const fromInternal = internalIds.has(edge.from);
    const toInternal = internalIds.has(edge.to);

    if (fromInternal && toInternal) {
      edge.boundary = "internal";
      edgesById.set(edge.id, edge);
    }
  }

  const degrees = queries.getDegrees(branch, nodesById.keys());
  const nodes = sortNodes(
    Array.from(nodesById.values(), (row) =>
      makeNode(row, degrees.get(row.id) ?? 0, {
        role: "internal",
      })
    )
  );

  return {
    filePath,
    truncated: false,
    nodes,
    edges: sortEdges(Array.from(edgesById.values())),
  };
}

export function buildFullSymbolGraph(
  queries: GraphQueryService,
  branch: string
): FullSymbolGraphResponse {
  const symbolRows = queries.getAllSymbols(branch);
  const edgeRows = queries.getAllResolvedEdges(branch);
  const symbolIds = symbolRows.map((row) => row.id);
  const degrees = queries.getDegrees(branch, symbolIds);

  const nodes = sortNodes(
    symbolRows.map((row) =>
      makeNode(row, degrees.get(row.id) ?? 0, {
        role: "internal",
      })
    )
  );

  const edges = sortEdges(
    edgeRows
      .map((row) => makeResolvedEdge(row))
      .filter((edge): edge is GraphEdge => Boolean(edge && edge.to))
  );

  return {
    truncated: false,
    nodes,
    edges,
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
    entityType: "file" as const,
    name: row.file_path.split("/").pop() ?? row.file_path,
    filePath: row.file_path,
    language: row.language,
    symbolCount: row.symbol_count,
    directory: toDirectoryPath(row.file_path),
    degree: 0,
  }));

  const edges = queries.getFullGraphEdges(branch).map((row) => ({
    from: `file::${row.from_file_path}`,
    to: `file::${row.to_file_path}`,
    callCount: row.call_count,
  }));

  return { nodes, edges };
}

type OverviewCluster = {
  key: string;
  relativePrefix: string[];
  files: Array<{
    filePath: string;
    language: string;
    symbolCount: number;
    relativeSegments: string[];
  }>;
};

function partitionOverviewClusters(
  files: Array<{
    filePath: string;
    language: string;
    symbolCount: number;
    relativeSegments: string[];
  }>
): { clusters: OverviewCluster[]; granularity: number; rootSegments: string[] } {
  const rootSegments = commonPathPrefix(files.map((file) => file.filePath));
  const withRelative = files.map((file) => ({
    ...file,
    relativeSegments: relativeSegments(file.filePath, rootSegments),
  }));

  const makeCluster = (relativePrefix: string[], clusterFiles: typeof withRelative): OverviewCluster => ({
    key: relativePrefix.join("/") || "root",
    relativePrefix,
    files: clusterFiles,
  });

  const splitCluster = (cluster: OverviewCluster): OverviewCluster[] => {
    const buckets = new Map<string, typeof withRelative>();
    cluster.files.forEach((file) => {
      const segment = file.relativeSegments[cluster.relativePrefix.length] ?? "(root)";
      const bucket = buckets.get(segment);
      if (bucket) {
        bucket.push(file);
      } else {
        buckets.set(segment, [file]);
      }
    });

    if (buckets.size <= 1) {
      return [cluster];
    }

    return Array.from(buckets.entries())
      .sort((a, b) => {
        const aWeight = a[1].reduce((sum, file) => sum + file.symbolCount, 0);
        const bWeight = b[1].reduce((sum, file) => sum + file.symbolCount, 0);
        return bWeight - aWeight || a[0].localeCompare(b[0]);
      })
      .map(([segment, bucket]) =>
        makeCluster(segment === "(root)" ? cluster.relativePrefix : [...cluster.relativePrefix, segment], bucket)
      );
  };

  let clusters = splitCluster(makeCluster([], withRelative));
  if (clusters.length === 1 && clusters[0]) {
    const split = splitCluster(clusters[0]);
    if (split.length > 1) {
      clusters = split;
    }
  }

  const totalSymbols = withRelative.reduce((sum, file) => sum + file.symbolCount, 0);
  const maxNodes = 25;
  const minNodes = 8;

  while (true) {
    const count = clusters.length;
    const splittable = clusters
      .map((cluster, index) => ({
        index,
        cluster,
        children: splitCluster(cluster),
        symbolCount: cluster.files.reduce((sum, file) => sum + file.symbolCount, 0),
      }))
      .filter((entry) => entry.children.length > 1)
      .sort((a, b) => b.symbolCount - a.symbolCount || a.cluster.key.localeCompare(b.cluster.key));

    if (splittable.length === 0) {
      break;
    }

    const largestShare = splittable[0].symbolCount / Math.max(totalSymbols, 1);
    const preferred = splittable.find((entry) => count - 1 + entry.children.length <= maxNodes);
    const shouldRefineForCount = count < minNodes && Boolean(preferred);
    const shouldRefineForDominance = count < maxNodes && largestShare > 0.55 && Boolean(preferred);

    if (!shouldRefineForCount && !shouldRefineForDominance) {
      break;
    }

    const target = preferred ?? splittable[0];
    clusters.splice(target.index, 1, ...target.children);
  }

  const granularity =
    clusters.length === 0
      ? 1
      : Math.max(...clusters.map((cluster) => Math.max(cluster.relativePrefix.length, 1)));

  return {
    clusters: clusters.sort((a, b) => a.key.localeCompare(b.key)),
    granularity,
    rootSegments,
  };
}

export function buildOverviewGraph(
  queries: GraphQueryService,
  branch: string
): OverviewGraphResponse {
  const fullGraph = buildFullGraph(queries, branch);
  const relativeFiles = fullGraph.nodes.map((node) => ({
    filePath: node.filePath,
    language: node.language,
    symbolCount: node.symbolCount,
    relativeSegments: [] as string[],
  }));
  const { clusters, granularity, rootSegments } = partitionOverviewClusters(relativeFiles);
  const fileToCluster = new Map<string, OverviewCluster>();

  clusters.forEach((cluster) => {
    cluster.files.forEach((file) => {
      fileToCluster.set(normalizePath(file.filePath), cluster);
    });
  });

  const nodes = clusters.map((cluster) => {
    const symbolCount = cluster.files.reduce((sum, file) => sum + file.symbolCount, 0);
    const languageWeights = new Map<string, number>();
    cluster.files.forEach((file) => {
      languageWeights.set(file.language, (languageWeights.get(file.language) ?? 0) + file.symbolCount);
    });
    const language =
      Array.from(languageWeights.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      "default";
    const directoryPath = joinPath(rootSegments, cluster.relativePrefix);

    return {
      id: `dir::${directoryPath}`,
      entityType: "directory" as const,
      name: labelForPrefix(cluster.relativePrefix),
      filePath: directoryPath,
      directoryPath,
      directory: directoryPath,
      language,
      symbolCount,
      fileCount: cluster.files.length,
      degree: 0,
    };
  });

  const edgeCounts = new Map<string, number>();
  fullGraph.edges.forEach((edge) => {
    const fromCluster = fileToCluster.get(normalizePath(edge.from.replace(/^file::/, "")));
    const toCluster = fileToCluster.get(normalizePath(edge.to.replace(/^file::/, "")));
    if (!fromCluster || !toCluster || fromCluster.key === toCluster.key) {
      return;
    }
    const fromPath = joinPath(rootSegments, fromCluster.relativePrefix);
    const toPath = joinPath(rootSegments, toCluster.relativePrefix);
    const edgeKey = `dir::${fromPath}->dir::${toPath}`;
    edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + edge.callCount);
  });

  const degreeById = new Map<string, number>();
  const edges = Array.from(edgeCounts.entries())
    .map(([edgeKey, callCount]) => {
      const [from, to] = edgeKey.split("->");
      degreeById.set(from, (degreeById.get(from) ?? 0) + callCount);
      degreeById.set(to, (degreeById.get(to) ?? 0) + callCount);
      return {
        from,
        to,
        callCount,
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  nodes.forEach((node) => {
    node.degree = degreeById.get(node.id) ?? 0;
  });

  return {
    granularity,
    nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
    edges,
  };
}
