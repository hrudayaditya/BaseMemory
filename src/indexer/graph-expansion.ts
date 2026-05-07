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

interface ResolvedUnresolvedCalleeEdge {
  edge: CallEdgeData;
  target: SymbolData;
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

function isEarlierSymbol(candidate: SymbolData, currentBest: SymbolData): boolean {
  if (candidate.startLine !== currentBest.startLine) {
    return candidate.startLine < currentBest.startLine;
  }

  if (candidate.startCol !== currentBest.startCol) {
    return candidate.startCol < currentBest.startCol;
  }

  return candidate.id.localeCompare(currentBest.id) < 0;
}

function matchesTargetKind(symbol: SymbolData, targetKind?: string): boolean {
  if (!targetKind) {
    return true;
  }

  return symbol.kind.toLowerCase() === targetKind.toLowerCase();
}

function groupSymbolsByName(symbols: SymbolData[]): Map<string, SymbolData[]> {
  const grouped = new Map<string, SymbolData[]>();

  for (const symbol of symbols) {
    const bucket = grouped.get(symbol.name);
    if (bucket) {
      bucket.push(symbol);
    } else {
      grouped.set(symbol.name, [symbol]);
    }
  }

  return grouped;
}

function selectCanonicalTargetSymbol(
  edge: Pick<CallEdgeData, "targetFilePath" | "targetKind">,
  candidates: SymbolData[]
): SymbolData | null {
  const kindMatched = candidates.filter((symbol) => matchesTargetKind(symbol, edge.targetKind));
  if (kindMatched.length === 0) {
    return null;
  }

  const targetFileCandidates = edge.targetFilePath
    ? kindMatched.filter((symbol) => symbol.filePath === edge.targetFilePath)
    : [];
  const effectiveCandidates = targetFileCandidates.length > 0 ? targetFileCandidates : kindMatched;
  const files = new Set(effectiveCandidates.map((symbol) => symbol.filePath));
  if (files.size !== 1) {
    return null;
  }

  let best = effectiveCandidates[0] ?? null;
  for (const candidate of effectiveCandidates.slice(1)) {
    if (best && isEarlierSymbol(candidate, best)) {
      best = candidate;
    }
  }

  return best;
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
): Map<string, GraphExpansionSeed[]> {
  if (symbols.length === 0) {
    return new Map();
  }

  const rows = database.getChunksForSymbolsBatch(
    symbols.map((symbol) => symbol.id),
    branch,
    allowedChunkIds ? [...allowedChunkIds] : undefined
  );

  const resolved = new Map<string, GraphExpansionSeed[]>();
  for (const row of rows) {
    const existing = resolved.get(row.symbolId) ?? [];
    existing.push(chunkRowToSeed(row));
    resolved.set(row.symbolId, existing);
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

    const unresolvedCallerTargetNames = direction === "callee"
      ? []
      : frontier
          .filter((entry) => !callersByTarget.has(entry.symbol.id))
          .map((entry) => entry.symbol.name);
    const unresolvedCallerEdges = unresolvedCallerTargetNames.length > 0
      ? database.getUnresolvedCallersByTargetNamesOnBranch(
          [...new Set(unresolvedCallerTargetNames)],
          options.branch
        )
      : [];
    const unresolvedCalleeEdges = direction === "caller"
      ? []
      : edgeBatch.callees.filter((edge) => !edge.toSymbolId);
    const unresolvedTargetNames = [
      ...new Set([
        ...unresolvedCallerEdges.map((edge) => edge.targetName),
        ...unresolvedCalleeEdges.map((edge) => edge.targetName),
      ]),
    ];
    const unresolvedTargetSymbols = unresolvedTargetNames.length > 0
      ? database.getSymbolsByNamesOnBranch(unresolvedTargetNames, options.branch)
      : [];
    const unresolvedTargetSymbolsByName = groupSymbolsByName(unresolvedTargetSymbols);
    const unresolvedCallersByTarget = new Map<string, CallEdgeData[]>();
    const unresolvedCalleesBySource = new Map<string, ResolvedUnresolvedCalleeEdge[]>();

    const relatedSymbolIds = new Set<string>();
    for (const edge of edgeBatch.callers) {
      relatedSymbolIds.add(edge.fromSymbolId);
    }
    for (const edge of edgeBatch.callees) {
      if (edge.toSymbolId) {
        relatedSymbolIds.add(edge.toSymbolId);
      }
    }

    const additionalSymbols = new Map<string, SymbolData>();
    for (const edge of unresolvedCallerEdges) {
      const effectiveTarget = selectCanonicalTargetSymbol(
        edge,
        unresolvedTargetSymbolsByName.get(edge.targetName) ?? []
      );
      if (!effectiveTarget) {
        continue;
      }

      const bucket = unresolvedCallersByTarget.get(effectiveTarget.id);
      if (bucket) {
        bucket.push(edge);
      } else {
        unresolvedCallersByTarget.set(effectiveTarget.id, [edge]);
      }
      additionalSymbols.set(effectiveTarget.id, effectiveTarget);
      relatedSymbolIds.add(edge.fromSymbolId);
    }

    for (const edge of unresolvedCalleeEdges) {
      const effectiveTarget = selectCanonicalTargetSymbol(
        edge,
        unresolvedTargetSymbolsByName.get(edge.targetName) ?? []
      );
      if (!effectiveTarget) {
        continue;
      }

      const bucket = unresolvedCalleesBySource.get(edge.fromSymbolId);
      const resolvedEdge = { edge, target: effectiveTarget };
      if (bucket) {
        bucket.push(resolvedEdge);
      } else {
        unresolvedCalleesBySource.set(edge.fromSymbolId, [resolvedEdge]);
      }
      additionalSymbols.set(effectiveTarget.id, effectiveTarget);
      relatedSymbolIds.add(effectiveTarget.id);
    }

    const relatedSymbols = database.getSymbolsByIdsOnBranch([...relatedSymbolIds], options.branch);
    const symbolsById = new Map<string, SymbolData>([
      ...relatedSymbols.map((symbol): [string, SymbolData] => [symbol.id, symbol]),
      ...Array.from(additionalSymbols.values(), (symbol): [string, SymbolData] => [symbol.id, symbol]),
    ]);
    const chunksBySymbolId = resolveChunksForSymbolsBatch(
      database,
      [...symbolsById.values()],
      options.branch,
      options.allowedChunkIds
    );

    const nextFrontier: QueueEntry[] = [];

    for (const current of frontier) {
      if (direction !== "callee") {
        for (const edge of [
          ...(callersByTarget.get(current.symbol.id) ?? []),
          ...(unresolvedCallersByTarget.get(current.symbol.id) ?? []),
        ]) {
          const callerSymbol = symbolsById.get(edge.fromSymbolId);
          if (!callerSymbol) {
            continue;
          }

          const callerChunks = chunksBySymbolId.get(callerSymbol.id) ?? [];
          let emittedCallerChunk = false;
          for (const callerChunk of callerChunks) {
            if (seenChunkIds.has(callerChunk.id)) {
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
            emittedCallerChunk = true;
          }

          if (emittedCallerChunk && !seenSymbols.has(callerSymbol.id)) {
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

          const calleeChunks = chunksBySymbolId.get(calleeSymbol.id) ?? [];
          let emittedCalleeChunk = false;
          for (const calleeChunk of calleeChunks) {
            if (seenChunkIds.has(calleeChunk.id)) {
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
            emittedCalleeChunk = true;
          }

          if (emittedCalleeChunk && !seenSymbols.has(calleeSymbol.id)) {
            seenSymbols.add(calleeSymbol.id);
            nextFrontier.push({ symbol: calleeSymbol, depth: nextDepth });
          }
        }

        for (const unresolved of unresolvedCalleesBySource.get(current.symbol.id) ?? []) {
          const calleeChunks = chunksBySymbolId.get(unresolved.target.id) ?? [];
          let emittedUnresolvedChunk = false;
          for (const calleeChunk of calleeChunks) {
            if (seenChunkIds.has(calleeChunk.id)) {
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
            emittedUnresolvedChunk = true;
          }

          if (emittedUnresolvedChunk && !seenSymbols.has(unresolved.target.id)) {
            seenSymbols.add(unresolved.target.id);
            nextFrontier.push({ symbol: unresolved.target, depth: nextDepth });
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return expanded;
}
