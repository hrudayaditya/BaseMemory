import type { ChunkKind, ChunkMetadata, ChunkSymbolKind, Database, SymbolData } from "../native/index.js";

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

function resolveChunkForSymbol(
  database: Database,
  symbol: SymbolData,
  branch: string,
  allowedChunkIds: Set<string> | null
): GraphExpansionSeed | null {
  const fileChunks = database.getChunksByFileOnBranch(symbol.filePath, branch);
  const bestChunk = fileChunks
    .filter((chunk) => !allowedChunkIds || allowedChunkIds.has(chunk.chunkId))
    .filter((chunk) =>
      chunk.startLine <= symbol.startLine &&
      chunk.endLine >= symbol.endLine
    )
    .sort((left, right) => {
      const leftNameMatch = left.name === symbol.name ? 1 : 0;
      const rightNameMatch = right.name === symbol.name ? 1 : 0;
      if (leftNameMatch !== rightNameMatch) {
        return rightNameMatch - leftNameMatch;
      }
      const leftSpan = left.endLine - left.startLine;
      const rightSpan = right.endLine - right.startLine;
      return leftSpan - rightSpan;
    })[0];

  if (!bestChunk) {
    return null;
  }

  return {
    id: bestChunk.chunkId,
    metadata: {
      filePath: bestChunk.filePath,
      startLine: bestChunk.startLine,
      endLine: bestChunk.endLine,
      chunkType: (bestChunk.nodeType ?? "other") as ChunkMetadata["chunkType"],
      chunkKind: bestChunk.chunkKind as ChunkKind | undefined,
      symbolKind: bestChunk.symbolKind as ChunkSymbolKind | undefined,
      name: bestChunk.name ?? undefined,
      language: bestChunk.language,
      hash: bestChunk.embeddingInputHash,
    },
  };
}

function resolveTargetSymbols(database: Database, targetName: string, branch: string): SymbolData[] {
  const exact = database.getSymbolsByNameOnBranch(targetName, branch);
  const ci = database.getSymbolsByNameCiOnBranch(targetName, branch);
  const deduped = new Map<string, SymbolData>();

  for (const symbol of [...exact, ...ci]) {
    deduped.set(symbol.id, symbol);
  }

  return Array.from(deduped.values());
}

export function expandGraphContext(
  database: Database,
  primaryCandidates: GraphExpansionSeed[],
  options: {
    branch: string;
    depth: number;
    allowedChunkIds: Set<string> | null;
  }
): GraphExpansionEntry[] {
  if (options.depth <= 0 || primaryCandidates.length === 0) {
    return [];
  }

  const primaryIds = new Set(primaryCandidates.map((candidate) => candidate.id));
  const seenChunkIds = new Set(primaryIds);
  const seenSymbols = new Set<string>();
  const queue: QueueEntry[] = [];
  const expanded: GraphExpansionEntry[] = [];

  for (const candidate of primaryCandidates) {
    const symbol = resolveSeedSymbol(database, candidate, options.branch);
    if (!symbol || seenSymbols.has(symbol.id)) {
      continue;
    }
    seenSymbols.add(symbol.id);
    queue.push({ symbol, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (current.depth >= options.depth) {
      continue;
    }

    const nextDepth = current.depth + 1;

    const callers = database.getCallersWithContextByTargetSymbolId(current.symbol.id, options.branch);
    for (const edge of callers) {
      const callerSymbol = database.getSymbolByIdOnBranch(edge.fromSymbolId, options.branch);
      if (!callerSymbol) {
        continue;
      }

      const callerChunk = resolveChunkForSymbol(
        database,
        callerSymbol,
        options.branch,
        options.allowedChunkIds
      );
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
        queue.push({ symbol: callerSymbol, depth: nextDepth });
      }
    }

    const callees = database.getCallees(current.symbol.id, options.branch);
    for (const edge of callees) {
      const calleeSymbols = edge.toSymbolId
        ? [database.getSymbolByIdOnBranch(edge.toSymbolId, options.branch)].filter((value): value is SymbolData => value !== null)
        : resolveTargetSymbols(database, edge.targetName, options.branch);

      for (const calleeSymbol of calleeSymbols) {
        const calleeChunk = resolveChunkForSymbol(
          database,
          calleeSymbol,
          options.branch,
          options.allowedChunkIds
        );
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
          queue.push({ symbol: calleeSymbol, depth: nextDepth });
        }
      }
    }
  }

  return expanded;
}
