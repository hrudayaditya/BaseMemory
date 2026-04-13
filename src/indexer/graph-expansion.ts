import type {
  CallEdgeData,
  ChunkKind,
  ChunkMetadata,
  ChunkSymbolKind,
  Database,
  SymbolChunkData,
  SymbolData,
} from "../native/index.js";

export interface GraphExpansionMetadata extends ChunkMetadata {
  chunkKind?: ChunkKind;
  symbolKind?: ChunkSymbolKind;
}

export interface GraphExpansionSeed {
  id: string;
  metadata: GraphExpansionMetadata;
}

export interface GraphExpansionEntry {
  id: string;
  metadata: GraphExpansionMetadata;
  relation: "caller" | "callee";
  depth: number;
  viaSymbol?: string;
}

export type GraphExpansionDirection = "caller" | "callee" | "both";

interface QueueEntry {
  symbol: SymbolData;
  depth: number;
}

function containsSymbolRange(
  symbol: SymbolData,
  startLine: number,
  endLine: number
): boolean {
  return symbol.startLine >= startLine && symbol.endLine <= endLine;
}

function isMoreSpecificSymbol(candidate: SymbolData, currentBest: SymbolData): boolean {
  if (candidate.startLine !== currentBest.startLine) {
    return candidate.startLine > currentBest.startLine;
  }

  if (candidate.startCol !== currentBest.startCol) {
    return candidate.startCol > currentBest.startCol;
  }

  if (candidate.endLine !== currentBest.endLine) {
    return candidate.endLine < currentBest.endLine;
  }

  if (candidate.endCol !== currentBest.endCol) {
    return candidate.endCol < currentBest.endCol;
  }

  return candidate.id.localeCompare(currentBest.id) < 0;
}

function resolveSeedSymbol(
  database: Database,
  seed: GraphExpansionSeed,
  branch: string
): SymbolData | null {
  if (seed.metadata.name) {
    const symbol = database.getSymbolByNameOnBranch(seed.metadata.name, seed.metadata.filePath, branch);
    if (symbol) {
      return symbol;
    }
  }

  const fileSymbols = database.getSymbolsByFileOnBranch(seed.metadata.filePath, branch);
  let bestSymbol: SymbolData | null = null;

  for (const symbol of fileSymbols) {
    if (!containsSymbolRange(symbol, seed.metadata.startLine, seed.metadata.endLine)) {
      continue;
    }

    if (!bestSymbol || isMoreSpecificSymbol(symbol, bestSymbol)) {
      bestSymbol = symbol;
    }
  }

  return bestSymbol;
}

function resolveChunksForSymbolsBatch(
  database: Database,
  symbols: SymbolData[],
  branch: string,
  allowedChunkIds: Set<string> | null
): Map<string, GraphExpansionSeed> {
  if (symbols.length === 0) {
    return new Map();
  }

  const rows = database.getChunksForSymbolsBatch(
    symbols.map((symbol) => symbol.id),
    branch,
    allowedChunkIds ? [...allowedChunkIds] : undefined
  );

  const resolved = new Map<string, GraphExpansionSeed>();
  for (const row of rows) {
    resolved.set(row.symbolId, chunkRowToSeed(row));
  }
  return resolved;
}

function chunkRowToSeed(row: SymbolChunkData): GraphExpansionSeed {
  return {
    id: row.chunkId,
    metadata: {
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      chunkType: (row.nodeType ?? "other") as ChunkMetadata["chunkType"],
      chunkKind: row.chunkKind as ChunkKind | undefined,
      symbolKind: row.symbolKind as ChunkSymbolKind | undefined,
      name: row.name ?? undefined,
      language: row.language,
      hash: row.embeddingInputHash,
    },
  };
}

function groupEdgesBySymbolId(
  edges: CallEdgeData[],
  getKey: (edge: CallEdgeData) => string | undefined
): Map<string, CallEdgeData[]> {
  const grouped = new Map<string, CallEdgeData[]>();

  for (const edge of edges) {
    const key = getKey(edge);
    if (!key) {
      continue;
    }

    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(edge);
    } else {
      grouped.set(key, [edge]);
    }
  }

  return grouped;
}

export function expandGraphContext(
  database: Database,
  primaryCandidates: GraphExpansionSeed[],
  options: {
    branch: string;
    depth: number;
    direction?: GraphExpansionDirection;
    allowedChunkIds: Set<string> | null;
  }
): GraphExpansionEntry[] {
  if (options.depth <= 0 || primaryCandidates.length === 0) {
    return [];
  }

  const direction = options.direction ?? "both";

  const primaryIds = new Set(primaryCandidates.map((candidate) => candidate.id));
  const seenChunkIds = new Set(direction === "both" ? primaryIds : []);
  const seenSymbols = new Set<string>();
  let frontier: QueueEntry[] = [];
  const expanded: GraphExpansionEntry[] = [];

  for (const candidate of primaryCandidates) {
    const symbol = resolveSeedSymbol(database, candidate, options.branch);
    if (!symbol || seenSymbols.has(symbol.id)) {
      continue;
    }
    seenSymbols.add(symbol.id);
    frontier.push({ symbol, depth: 0 });
  }

  while (frontier.length > 0) {
    const currentDepth = frontier[0]?.depth ?? 0;
    if (currentDepth >= options.depth) {
      break;
    }

    const nextDepth = currentDepth + 1;
    const frontierSymbolIds = frontier.map((entry) => entry.symbol.id);
    const edgeBatch = database.getCallEdgeFrontierBatch(frontierSymbolIds, options.branch);
    const callersByTarget = groupEdgesBySymbolId(edgeBatch.callers, (edge) => edge.toSymbolId);
    const calleesBySource = groupEdgesBySymbolId(edgeBatch.callees, (edge) => edge.fromSymbolId);

    const relatedSymbolIds = new Set<string>();
    for (const edge of edgeBatch.callers) {
      relatedSymbolIds.add(edge.fromSymbolId);
    }
    for (const edge of edgeBatch.callees) {
      if (edge.toSymbolId) {
        relatedSymbolIds.add(edge.toSymbolId);
      }
    }

    const relatedSymbols = database.getSymbolsByIdsOnBranch([...relatedSymbolIds], options.branch);
    const symbolsById = new Map(relatedSymbols.map((symbol) => [symbol.id, symbol]));
    const chunksBySymbolId = resolveChunksForSymbolsBatch(
      database,
      relatedSymbols,
      options.branch,
      options.allowedChunkIds
    );

    const nextFrontier: QueueEntry[] = [];

    for (const current of frontier) {
      if (direction !== "callee") {
        for (const edge of callersByTarget.get(current.symbol.id) ?? []) {
          const callerSymbol = symbolsById.get(edge.fromSymbolId);
          if (!callerSymbol) {
            continue;
          }

          const callerChunk = chunksBySymbolId.get(callerSymbol.id);
          if (!callerChunk || seenChunkIds.has(callerChunk.id)) {
            continue;
          }

          seenChunkIds.add(callerChunk.id);
          expanded.push({
            id: callerChunk.id,
            metadata: callerChunk.metadata,
            relation: "caller",
            depth: nextDepth,
            viaSymbol: current.symbol.name,
          });

          if (!seenSymbols.has(callerSymbol.id)) {
            seenSymbols.add(callerSymbol.id);
            nextFrontier.push({ symbol: callerSymbol, depth: nextDepth });
          }
        }
      }

      if (direction !== "caller") {
        for (const edge of calleesBySource.get(current.symbol.id) ?? []) {
          if (!edge.toSymbolId) {
            continue;
          }

          const calleeSymbol = symbolsById.get(edge.toSymbolId);
          if (!calleeSymbol) {
            continue;
          }

          const calleeChunk = chunksBySymbolId.get(calleeSymbol.id);
          if (!calleeChunk || seenChunkIds.has(calleeChunk.id)) {
            continue;
          }

          seenChunkIds.add(calleeChunk.id);
          expanded.push({
            id: calleeChunk.id,
            metadata: calleeChunk.metadata,
            relation: "callee",
            depth: nextDepth,
            viaSymbol: current.symbol.name,
          });

          if (!seenSymbols.has(calleeSymbol.id)) {
            seenSymbols.add(calleeSymbol.id);
            nextFrontier.push({ symbol: calleeSymbol, depth: nextDepth });
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return expanded;
}
