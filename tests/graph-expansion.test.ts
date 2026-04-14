import { describe, expect, it } from "vitest";

import type { ChunkData, ChunkMetadata, Database, SymbolData } from "../src/native/index.js";
import { expandGraphContext } from "../src/indexer/graph-expansion.js";

type CallerRow = ReturnType<Database["getCallersWithContext"]>[number];
type CalleeRow = ReturnType<Database["getCallees"]>[number];

interface GraphExpansionCallCounters {
  getSymbolByNameOnBranch: number;
  getSymbolsByFileOnBranch: number;
  getCallersWithContextByTargetSymbolId: number;
  getCallees: number;
  getSymbolByIdOnBranch: number;
  getChunksByFileOnBranch: number;
  getCallEdgeFrontierBatch: number;
  getSymbolsByIdsOnBranch: number;
  getSymbolsByNamesOnBranch: number;
  getChunksForSymbolsBatch: number;
  getUnresolvedCallersByTargetNamesOnBranch: number;
}

function symbol(id: string, name: string, filePath: string): SymbolData {
  return {
    id,
    filePath,
    name,
    kind: "Function",
    startLine: 1,
    startCol: 0,
    endLine: 10,
    endCol: 0,
    language: "typescript",
  };
}

function chunk(chunkId: string, name: string, filePath: string): ChunkData {
  return {
    chunkId,
    contentHash: chunkId,
    embeddingInputHash: chunkId,
    filePath,
    startLine: 1,
    endLine: 10,
    language: "typescript",
    name,
    nodeType: "function",
    chunkKind: "Code",
    symbolKind: "Function",
  };
}

function fakeDatabase(input: {
  symbols: SymbolData[];
  chunks: ChunkData[];
  callers?: CallerRow[];
  callees?: CalleeRow[];
  branchSymbols?: Record<string, string[]>;
  branchChunks?: Record<string, string[]>;
  failOnNameLookup?: boolean;
  callCounters?: GraphExpansionCallCounters;
}): Database {
  const symbolsById = new Map(input.symbols.map((item) => [item.id, item]));
  const branchSymbolIds = new Map(
    Object.entries(input.branchSymbols ?? {}).map(([branch, ids]) => [branch, new Set(ids)])
  );
  const branchChunkIds = new Map(
    Object.entries(input.branchChunks ?? {}).map(([branch, ids]) => [branch, new Set(ids)])
  );
  const symbolsByFile = new Map<string, SymbolData[]>();
  for (const item of input.symbols) {
    symbolsByFile.set(item.filePath, [...(symbolsByFile.get(item.filePath) ?? []), item]);
  }
  const chunksByFile = new Map<string, ChunkData[]>();
  for (const item of input.chunks) {
    chunksByFile.set(item.filePath, [...(chunksByFile.get(item.filePath) ?? []), item]);
  }

  const filterSymbolsByBranch = (branch: string, symbols: SymbolData[]): SymbolData[] => {
    const allowed = branchSymbolIds.get(branch);
    if (!allowed) {
      return symbols;
    }
    return symbols.filter((item) => allowed.has(item.id));
  };

  const filterChunksByBranch = (branch: string, chunks: ChunkData[]): ChunkData[] => {
    const allowed = branchChunkIds.get(branch);
    if (!allowed) {
      return chunks;
    }
    return chunks.filter((item) => allowed.has(item.chunkId));
  };

  const count = (key: keyof GraphExpansionCallCounters): void => {
    if (input.callCounters) {
      input.callCounters[key] += 1;
    }
  };

  return {
    getSymbolByNameOnBranch(name: string, filePath: string, branch: string) {
      count("getSymbolByNameOnBranch");
      return filterSymbolsByBranch(branch, symbolsByFile.get(filePath) ?? [])
        .find((item) => item.name === name) ?? null;
    },
    getSymbolsByFileOnBranch(filePath: string, branch: string) {
      count("getSymbolsByFileOnBranch");
      return filterSymbolsByBranch(branch, symbolsByFile.get(filePath) ?? []);
    },
    getSymbolsByNameOnBranch(name: string, branch: string) {
      if (input.failOnNameLookup) {
        throw new Error(`unexpected exact name lookup for ${name} on ${branch}`);
      }
      return filterSymbolsByBranch(branch, input.symbols).filter((item) => item.name === name);
    },
    getSymbolsByNamesOnBranch(names: string[], branch: string) {
      count("getSymbolsByNamesOnBranch");
      const nameSet = new Set(names);
      return filterSymbolsByBranch(branch, input.symbols).filter((item) => nameSet.has(item.name));
    },
    getSymbolsByNameCiOnBranch(name: string, branch: string) {
      if (input.failOnNameLookup) {
        throw new Error(`unexpected case-insensitive name lookup for ${name} on ${branch}`);
      }
      return filterSymbolsByBranch(branch, input.symbols)
        .filter((item) => item.name.toLowerCase() === name.toLowerCase());
    },
    getSymbolByIdOnBranch(symbolId: string, branch: string) {
      count("getSymbolByIdOnBranch");
      const symbol = symbolsById.get(symbolId) ?? null;
      if (symbol === null) {
        return null;
      }
      const allowed = branchSymbolIds.get(branch);
      if (allowed && !allowed.has(symbolId)) {
        return null;
      }
      return symbol;
    },
    getChunksByFileOnBranch(filePath: string, branch: string) {
      count("getChunksByFileOnBranch");
      return filterChunksByBranch(branch, chunksByFile.get(filePath) ?? []);
    },
    getSymbolsByIdsOnBranch(symbolIds: string[], branch: string) {
      count("getSymbolsByIdsOnBranch");
      const allowed = branchSymbolIds.get(branch);
      return symbolIds
        .map((symbolId) => symbolsById.get(symbolId) ?? null)
        .filter((item): item is SymbolData => item !== null)
        .filter((item) => !allowed || allowed.has(item.id));
    },
    getChunksForSymbolsBatch(symbolIds: string[], branch: string, allowedChunkIds?: string[]) {
      count("getChunksForSymbolsBatch");
      const allowedChunks = allowedChunkIds ? new Set(allowedChunkIds) : null;
      return symbolIds.flatMap((symbolId) => {
        const item = symbolsById.get(symbolId);
        if (!item) {
          return [];
        }

        const bestChunk = filterChunksByBranch(branch, chunksByFile.get(item.filePath) ?? [])
          .filter((chunk) => !allowedChunks || allowedChunks.has(chunk.chunkId))
          .filter((chunk) => chunk.startLine <= item.startLine && chunk.endLine >= item.endLine)
          .sort((left, right) => {
            const leftNameMatch = left.name === item.name ? 1 : 0;
            const rightNameMatch = right.name === item.name ? 1 : 0;
            if (leftNameMatch !== rightNameMatch) {
              return rightNameMatch - leftNameMatch;
            }
            const leftSpan = left.endLine - left.startLine;
            const rightSpan = right.endLine - right.startLine;
            return leftSpan - rightSpan;
          })[0];

        if (!bestChunk) {
          return [];
        }

        return [{
          symbolId,
          chunkId: bestChunk.chunkId,
          contentHash: bestChunk.contentHash,
          embeddingInputHash: bestChunk.embeddingInputHash,
          filePath: bestChunk.filePath,
          startLine: bestChunk.startLine,
          endLine: bestChunk.endLine,
          nodeType: bestChunk.nodeType,
          name: bestChunk.name,
          chunkKind: bestChunk.chunkKind,
          symbolKind: bestChunk.symbolKind,
          language: bestChunk.language,
        }];
      });
    },
    getSymbolByName(name: string, filePath: string) {
      return (symbolsByFile.get(filePath) ?? []).find((item) => item.name === name) ?? null;
    },
    getSymbolsByFile(filePath: string) {
      return symbolsByFile.get(filePath) ?? [];
    },
    getSymbolsByName(name: string) {
      return input.symbols.filter((item) => item.name === name);
    },
    getSymbolsByNameCi(name: string) {
      return input.symbols.filter((item) => item.name.toLowerCase() === name.toLowerCase());
    },
    getSymbolById(symbolId: string) {
      return symbolsById.get(symbolId) ?? null;
    },
    getChunksByFile(filePath: string) {
      return chunksByFile.get(filePath) ?? [];
    },
    getCallersWithContext(_targetName: string, _branch: string) {
      return (input.callers ?? []).filter((item) =>
        item.targetName === _targetName &&
        (!("branch" in item) || item.branch === _branch)
      );
    },
    getCallersWithContextByTargetSymbolId(_targetSymbolId: string, _branch: string) {
      count("getCallersWithContextByTargetSymbolId");
      return (input.callers ?? []).filter((item) =>
        item.toSymbolId === _targetSymbolId &&
        (!("branch" in item) || item.branch === _branch)
      );
    },
    getUnresolvedCallersByTargetNamesOnBranch(targetNames: string[], branch: string) {
      count("getUnresolvedCallersByTargetNamesOnBranch");
      const nameSet = new Set(targetNames);
      return (input.callers ?? []).filter((item) =>
        !item.toSymbolId &&
        nameSet.has(item.targetName) &&
        (!("branch" in item) || item.branch === branch)
      );
    },
    getCallees(_symbolId: string, _branch: string) {
      count("getCallees");
      return (input.callees ?? []).filter((item) =>
        item.fromSymbolId === _symbolId &&
        (!("branch" in item) || item.branch === _branch)
      );
    },
    getCallEdgeFrontierBatch(symbolIds: string[], branch: string) {
      count("getCallEdgeFrontierBatch");
      const symbolSet = new Set(symbolIds);
      return {
        callers: (input.callers ?? []).filter((item) =>
          !!item.toSymbolId &&
          symbolSet.has(item.toSymbolId) &&
          (!("branch" in item) || item.branch === branch)
        ),
        callees: (input.callees ?? []).filter((item) =>
          symbolSet.has(item.fromSymbolId) &&
          (!("branch" in item) || item.branch === branch)
        ),
      };
    },
  } as unknown as Database;
}

function createCallCounters(): GraphExpansionCallCounters {
  return {
    getSymbolByNameOnBranch: 0,
    getSymbolsByFileOnBranch: 0,
    getCallersWithContextByTargetSymbolId: 0,
    getCallees: 0,
    getSymbolByIdOnBranch: 0,
    getChunksByFileOnBranch: 0,
    getCallEdgeFrontierBatch: 0,
    getSymbolsByIdsOnBranch: 0,
    getSymbolsByNamesOnBranch: 0,
    getChunksForSymbolsBatch: 0,
    getUnresolvedCallersByTargetNamesOnBranch: 0,
  };
}

function meta(name: string, filePath: string): ChunkMetadata {
  return {
    filePath,
    startLine: 1,
    endLine: 10,
    chunkType: "function",
    language: "typescript",
    hash: name,
    name,
  };
}

describe("graph expansion", () => {
  it("returns callers and callees for a known symbol", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed", "processPayment", "/repo/src/payment.ts"),
        symbol("caller", "submitCheckout", "/repo/src/checkout.ts"),
        symbol("callee", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      chunks: [
        chunk("seedChunk", "processPayment", "/repo/src/payment.ts"),
        chunk("callerChunk", "submitCheckout", "/repo/src/checkout.ts"),
        chunk("calleeChunk", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      callers: [{
        id: "edge-1",
        fromSymbolId: "caller",
        fromSymbolName: "submitCheckout",
        fromSymbolFilePath: "/repo/src/checkout.ts",
        targetName: "processPayment",
        toSymbolId: "seed",
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: true,
      }],
      callees: [{
        id: "edge-2",
        fromSymbolId: "seed",
        fromSymbolName: "processPayment",
        fromSymbolFilePath: "/repo/src/payment.ts",
        targetName: "saveReceipt",
        toSymbolId: "callee",
        callType: "Call",
        line: 8,
        col: 2,
        isResolved: true,
      }],
    });

    const expanded = expandGraphContext(db, [{
      id: "seedChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seedChunk", "callerChunk", "calleeChunk"]),
    });

    expect(expanded.map((item) => item.metadata.name)).toEqual(["submitCheckout", "saveReceipt"]);
    expect(expanded.map((item) => item.relation)).toEqual(["caller", "callee"]);
  });

  it("respects branch-aware chunk filtering", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed", "processPayment", "/repo/src/payment.ts"),
        symbol("other", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      chunks: [
        chunk("seedChunk", "processPayment", "/repo/src/payment.ts"),
        chunk("otherChunk", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      callers: [{
        id: "edge-1",
        fromSymbolId: "other",
        fromSymbolName: "submitCheckout",
        fromSymbolFilePath: "/repo/src/checkout.ts",
        targetName: "processPayment",
        toSymbolId: "seed",
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: true,
      }],
    });

    const expanded = expandGraphContext(db, [{
      id: "seedChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seedChunk"]),
    });

    expect(expanded).toEqual([]);
  });

  it("respects the configured depth limit", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed", "processPayment", "/repo/src/payment.ts"),
        symbol("caller", "submitCheckout", "/repo/src/checkout.ts"),
        symbol("root", "handleRequest", "/repo/src/entry.ts"),
      ],
      chunks: [
        chunk("seedChunk", "processPayment", "/repo/src/payment.ts"),
        chunk("callerChunk", "submitCheckout", "/repo/src/checkout.ts"),
        chunk("rootChunk", "handleRequest", "/repo/src/entry.ts"),
      ],
      callers: [
        {
          id: "edge-1",
          fromSymbolId: "caller",
          fromSymbolName: "submitCheckout",
          fromSymbolFilePath: "/repo/src/checkout.ts",
          targetName: "processPayment",
          toSymbolId: "seed",
          callType: "Call",
          line: 4,
          col: 2,
          isResolved: true,
        },
        {
          id: "edge-2",
          fromSymbolId: "root",
          fromSymbolName: "handleRequest",
          fromSymbolFilePath: "/repo/src/entry.ts",
          targetName: "submitCheckout",
          toSymbolId: "caller",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: true,
        },
      ],
    });

    const depthOne = expandGraphContext(db, [{
      id: "seedChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seedChunk", "callerChunk", "rootChunk"]),
    });
    expect(depthOne.map((item) => item.metadata.name)).toEqual(["submitCheckout"]);

    const depthTwo = expandGraphContext(db, [{
      id: "seedChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 2,
      allowedChunkIds: new Set(["seedChunk", "callerChunk", "rootChunk"]),
    });
    expect(depthTwo.map((item) => item.metadata.name)).toEqual(["submitCheckout", "handleRequest"]);
  });

  it("traverses resolved cross-file callees without falling back to name lookup", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed-main", "processPayment", "/repo/src/payment.ts"),
        symbol("callee-main", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      chunks: [
        chunk("seedChunkMain", "processPayment", "/repo/src/payment.ts"),
        chunk("calleeChunkMain", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      branchSymbols: {
        main: ["seed-main", "callee-main"],
      },
      branchChunks: {
        main: ["seedChunkMain", "calleeChunkMain"],
      },
      failOnNameLookup: true,
      callees: [{
        id: "edge-main",
        fromSymbolId: "seed-main",
        fromSymbolName: "processPayment",
        fromSymbolFilePath: "/repo/src/payment.ts",
        targetName: "saveReceipt",
        toSymbolId: "callee-main",
        callType: "Call",
        line: 8,
        col: 2,
        isResolved: true,
      }],
    });

    const mainExpanded = expandGraphContext(db, [{
      id: "seedChunkMain",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seedChunkMain", "calleeChunkMain"]),
    });
    expect(mainExpanded).toHaveLength(1);
    expect(mainExpanded[0]?.id).toBe("calleeChunkMain");
  });

  it("expands unresolved callees when the target name canonically resolves within one file", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed-main", "processPayment", "/repo/src/payment.ts"),
        symbol("callee-main", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      chunks: [
        chunk("seedChunkMain", "processPayment", "/repo/src/payment.ts"),
        chunk("calleeChunkMain", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      branchSymbols: {
        main: ["seed-main", "callee-main"],
      },
      branchChunks: {
        main: ["seedChunkMain", "calleeChunkMain"],
      },
      failOnNameLookup: true,
      callees: [{
        id: "edge-main",
        fromSymbolId: "seed-main",
        fromSymbolName: "processPayment",
        fromSymbolFilePath: "/repo/src/payment.ts",
        targetName: "saveReceipt",
        toSymbolId: null,
        callType: "Call",
        line: 8,
        col: 2,
        isResolved: false,
      }],
    });

    const expanded = expandGraphContext(db, [{
      id: "seedChunkMain",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seedChunkMain", "calleeChunkMain"]),
    });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      id: "calleeChunkMain",
      relation: "callee",
    });
  });

  it("returns callers only for persistently resolved cross-file targets", () => {
    const resolvedDb = fakeDatabase({
      symbols: [
        symbol("target", "processPayment", "/repo/src/payment.ts"),
        symbol("caller", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      chunks: [
        chunk("targetChunk", "processPayment", "/repo/src/payment.ts"),
        chunk("callerChunk", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      branchSymbols: {
        main: ["target", "caller"],
      },
      branchChunks: {
        main: ["targetChunk", "callerChunk"],
      },
      callers: [{
        id: "edge-resolved",
        fromSymbolId: "caller",
        fromSymbolName: "submitCheckout",
        fromSymbolFilePath: "/repo/src/checkout.ts",
        targetName: "processPayment",
        targetFilePath: "/repo/src/payment.ts",
        targetKind: "Function",
        toSymbolId: "target",
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: true,
      }],
      failOnNameLookup: true,
    });

    const resolvedExpanded = expandGraphContext(resolvedDb, [{
      id: "targetChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["targetChunk", "callerChunk"]),
    });

    expect(resolvedExpanded).toHaveLength(1);
    expect(resolvedExpanded[0]).toMatchObject({
      id: "callerChunk",
      relation: "caller",
    });

    const unresolvedDb = fakeDatabase({
      symbols: [
        {
          ...symbol("target-head", "processPayment", "/repo/src/payment.ts"),
          startLine: 10,
          endLine: 40,
        },
        {
          ...symbol("target-tail", "processPayment", "/repo/src/payment.ts"),
          startLine: 41,
          endLine: 90,
        },
        symbol("caller", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      chunks: [
        chunk("targetChunk", "processPayment", "/repo/src/payment.ts"),
        chunk("callerChunk", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      branchSymbols: {
        main: ["target-head", "target-tail", "caller"],
      },
      branchChunks: {
        main: ["targetChunk", "callerChunk"],
      },
      callers: [{
        id: "edge-unresolved",
        fromSymbolId: "caller",
        fromSymbolName: "submitCheckout",
        fromSymbolFilePath: "/repo/src/checkout.ts",
        targetName: "processPayment",
        targetFilePath: undefined,
        targetKind: undefined,
        toSymbolId: null,
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: false,
      }],
      failOnNameLookup: true,
    });

    const unresolvedExpanded = expandGraphContext(unresolvedDb, [{
      id: "targetChunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["targetChunk", "callerChunk"]),
    });

    expect(unresolvedExpanded).toHaveLength(1);
    expect(unresolvedExpanded[0]).toMatchObject({
      id: "callerChunk",
      relation: "caller",
    });
  });

  it("keeps unresolved same-name targets in different files ambiguous", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("target-a", "processPayment", "/repo/src/payment-a.ts"),
        symbol("target-b", "processPayment", "/repo/src/payment-b.ts"),
        symbol("caller", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      chunks: [
        chunk("target-a-chunk", "processPayment", "/repo/src/payment-a.ts"),
        chunk("target-b-chunk", "processPayment", "/repo/src/payment-b.ts"),
        chunk("callerChunk", "submitCheckout", "/repo/src/checkout.ts"),
      ],
      branchSymbols: {
        main: ["target-a", "target-b", "caller"],
      },
      branchChunks: {
        main: ["target-a-chunk", "target-b-chunk", "callerChunk"],
      },
      callers: [{
        id: "edge-unresolved-ambiguous",
        fromSymbolId: "caller",
        fromSymbolName: "submitCheckout",
        fromSymbolFilePath: "/repo/src/checkout.ts",
        targetName: "processPayment",
        targetFilePath: undefined,
        targetKind: undefined,
        toSymbolId: null,
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: false,
      }],
      failOnNameLookup: true,
    });

    const expanded = expandGraphContext(db, [{
      id: "target-a-chunk",
      metadata: meta("processPayment", "/repo/src/payment-a.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["target-a-chunk", "target-b-chunk", "callerChunk"]),
    });

    expect(expanded).toEqual([]);
  });

  it("fails gracefully when a seed has no symbol record", () => {
    const db = fakeDatabase({
      symbols: [],
      chunks: [],
    });

    const expanded = expandGraphContext(db, [{
      id: "missing",
      metadata: meta("missing", "/repo/src/missing.ts"),
    }], {
      branch: "main",
      depth: 2,
      allowedChunkIds: null,
    });

    expect(expanded).toEqual([]);
  });

  it("does not mix callers for same-named symbols in different files", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("execute-a", "execute", "/repo/src/tools/a.ts"),
        symbol("execute-b", "execute", "/repo/src/tools/b.ts"),
        symbol("caller-a", "runA", "/repo/src/run-a.ts"),
        symbol("caller-b", "runB", "/repo/src/run-b.ts"),
      ],
      chunks: [
        chunk("chunk-a", "execute", "/repo/src/tools/a.ts"),
        chunk("chunk-b", "execute", "/repo/src/tools/b.ts"),
        chunk("caller-chunk-a", "runA", "/repo/src/run-a.ts"),
        chunk("caller-chunk-b", "runB", "/repo/src/run-b.ts"),
      ],
      callers: [
        {
          id: "edge-a",
          fromSymbolId: "caller-a",
          fromSymbolName: "runA",
          fromSymbolFilePath: "/repo/src/run-a.ts",
          targetName: "execute",
          toSymbolId: "execute-a",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: true,
        },
        {
          id: "edge-b",
          fromSymbolId: "caller-b",
          fromSymbolName: "runB",
          fromSymbolFilePath: "/repo/src/run-b.ts",
          targetName: "execute",
          toSymbolId: "execute-b",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: true,
        },
      ],
    });

    const expanded = expandGraphContext(db, [{
      id: "chunk-a",
      metadata: meta("execute", "/repo/src/tools/a.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["chunk-a", "chunk-b", "caller-chunk-a", "caller-chunk-b"]),
    });

    expect(expanded.map((item) => item.metadata.name)).toEqual(["runA"]);
  });

  it("uses the tightest enclosing symbol when the seed chunk has no direct name match", () => {
    const db = fakeDatabase({
      symbols: [
        {
          id: "outer",
          filePath: "/repo/src/tools.ts",
          name: "outer",
          kind: "Module",
          startLine: 1,
          startCol: 0,
          endLine: 12,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "execute",
          filePath: "/repo/src/tools.ts",
          name: "execute",
          kind: "Method",
          startLine: 4,
          startCol: 2,
          endLine: 8,
          endCol: 0,
          language: "typescript",
        },
        symbol("caller", "invokeTool", "/repo/src/runner.ts"),
      ],
      chunks: [
        chunk("outer-chunk", "outer", "/repo/src/tools.ts"),
        chunk("execute-chunk", "execute", "/repo/src/tools.ts"),
        chunk("caller-chunk", "invokeTool", "/repo/src/runner.ts"),
      ],
      callers: [{
        id: "edge",
        fromSymbolId: "caller",
        fromSymbolName: "invokeTool",
        fromSymbolFilePath: "/repo/src/runner.ts",
        targetName: "execute",
        toSymbolId: "execute",
        callType: "Call",
        line: 4,
        col: 2,
        isResolved: true,
      }],
    });

    const expanded = expandGraphContext(db, [{
      id: "seed",
      metadata: {
        filePath: "/repo/src/tools.ts",
        startLine: 1,
        endLine: 12,
        chunkType: "module",
        language: "typescript",
        hash: "seed",
      },
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["outer-chunk", "execute-chunk", "caller-chunk"]),
    });

    expect(expanded.map((item) => item.metadata.name)).toEqual(["invokeTool"]);
  });

  it("batches traversal lookups once per depth level instead of per frontier symbol", () => {
    const counters = createCallCounters();
    const db = fakeDatabase({
      symbols: [
        symbol("seed-1", "seedOne", "/repo/src/seed-one.ts"),
        symbol("seed-2", "seedTwo", "/repo/src/seed-two.ts"),
        symbol("seed-3", "seedThree", "/repo/src/seed-three.ts"),
        symbol("seed-4", "seedFour", "/repo/src/seed-four.ts"),
        symbol("seed-5", "seedFive", "/repo/src/seed-five.ts"),
        symbol("caller-1", "callerOne", "/repo/src/caller-one.ts"),
        symbol("caller-2", "callerTwo", "/repo/src/caller-two.ts"),
        symbol("caller-3", "callerThree", "/repo/src/caller-three.ts"),
        symbol("caller-4", "callerFour", "/repo/src/caller-four.ts"),
        symbol("caller-5", "callerFive", "/repo/src/caller-five.ts"),
      ],
      chunks: [
        chunk("seed-chunk-1", "seedOne", "/repo/src/seed-one.ts"),
        chunk("seed-chunk-2", "seedTwo", "/repo/src/seed-two.ts"),
        chunk("seed-chunk-3", "seedThree", "/repo/src/seed-three.ts"),
        chunk("seed-chunk-4", "seedFour", "/repo/src/seed-four.ts"),
        chunk("seed-chunk-5", "seedFive", "/repo/src/seed-five.ts"),
        chunk("caller-chunk-1", "callerOne", "/repo/src/caller-one.ts"),
        chunk("caller-chunk-2", "callerTwo", "/repo/src/caller-two.ts"),
        chunk("caller-chunk-3", "callerThree", "/repo/src/caller-three.ts"),
        chunk("caller-chunk-4", "callerFour", "/repo/src/caller-four.ts"),
        chunk("caller-chunk-5", "callerFive", "/repo/src/caller-five.ts"),
      ],
      callers: [
        {
          id: "edge-1",
          fromSymbolId: "caller-1",
          fromSymbolName: "callerOne",
          fromSymbolFilePath: "/repo/src/caller-one.ts",
          targetName: "seedOne",
          toSymbolId: "seed-1",
          callType: "Call",
          line: 3,
          col: 1,
          isResolved: true,
        },
        {
          id: "edge-2",
          fromSymbolId: "caller-2",
          fromSymbolName: "callerTwo",
          fromSymbolFilePath: "/repo/src/caller-two.ts",
          targetName: "seedTwo",
          toSymbolId: "seed-2",
          callType: "Call",
          line: 3,
          col: 1,
          isResolved: true,
        },
        {
          id: "edge-3",
          fromSymbolId: "caller-3",
          fromSymbolName: "callerThree",
          fromSymbolFilePath: "/repo/src/caller-three.ts",
          targetName: "seedThree",
          toSymbolId: "seed-3",
          callType: "Call",
          line: 3,
          col: 1,
          isResolved: true,
        },
        {
          id: "edge-4",
          fromSymbolId: "caller-4",
          fromSymbolName: "callerFour",
          fromSymbolFilePath: "/repo/src/caller-four.ts",
          targetName: "seedFour",
          toSymbolId: "seed-4",
          callType: "Call",
          line: 3,
          col: 1,
          isResolved: true,
        },
        {
          id: "edge-5",
          fromSymbolId: "caller-5",
          fromSymbolName: "callerFive",
          fromSymbolFilePath: "/repo/src/caller-five.ts",
          targetName: "seedFive",
          toSymbolId: "seed-5",
          callType: "Call",
          line: 3,
          col: 1,
          isResolved: true,
        },
      ],
      callCounters: counters,
    });

    const expanded = expandGraphContext(db, [
      { id: "seed-chunk-1", metadata: meta("seedOne", "/repo/src/seed-one.ts") },
      { id: "seed-chunk-2", metadata: meta("seedTwo", "/repo/src/seed-two.ts") },
      { id: "seed-chunk-3", metadata: meta("seedThree", "/repo/src/seed-three.ts") },
      { id: "seed-chunk-4", metadata: meta("seedFour", "/repo/src/seed-four.ts") },
      { id: "seed-chunk-5", metadata: meta("seedFive", "/repo/src/seed-five.ts") },
    ], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set([
        "seed-chunk-1",
        "seed-chunk-2",
        "seed-chunk-3",
        "seed-chunk-4",
        "seed-chunk-5",
        "caller-chunk-1",
        "caller-chunk-2",
        "caller-chunk-3",
        "caller-chunk-4",
        "caller-chunk-5",
      ]),
    });

    expect(expanded).toHaveLength(5);
    expect(counters.getCallEdgeFrontierBatch).toBe(1);
    expect(counters.getSymbolsByIdsOnBranch).toBe(1);
    expect(counters.getSymbolsByNamesOnBranch).toBe(0);
    expect(counters.getChunksForSymbolsBatch).toBe(1);
    expect(counters.getUnresolvedCallersByTargetNamesOnBranch).toBe(0);
    expect(counters.getCallersWithContextByTargetSymbolId).toBe(0);
    expect(counters.getCallees).toBe(0);
    expect(counters.getSymbolByIdOnBranch).toBe(0);
    expect(counters.getChunksByFileOnBranch).toBe(0);
  });

  it("finds wide-fanout callers in a single traversal level", () => {
    const counters = createCallCounters();
    const callers = Array.from({ length: 12 }, (_, index) => ({
      id: `edge-${index}`,
      fromSymbolId: `caller-${index}`,
      fromSymbolName: `caller${index}`,
      fromSymbolFilePath: `/repo/src/caller-${index}.ts`,
      targetName: "target",
      toSymbolId: "target",
      callType: "Call",
      line: 3,
      col: 1,
      isResolved: true,
    }));

    const db = fakeDatabase({
      symbols: [
        symbol("target", "target", "/repo/src/target.ts"),
        ...Array.from({ length: 12 }, (_, index) =>
          symbol(`caller-${index}`, `caller${index}`, `/repo/src/caller-${index}.ts`)
        ),
      ],
      chunks: [
        chunk("target-chunk", "target", "/repo/src/target.ts"),
        ...Array.from({ length: 12 }, (_, index) =>
          chunk(`caller-chunk-${index}`, `caller${index}`, `/repo/src/caller-${index}.ts`)
        ),
      ],
      callers,
      callCounters: counters,
    });

    const expanded = expandGraphContext(db, [{
      id: "target-chunk",
      metadata: meta("target", "/repo/src/target.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set([
        "target-chunk",
        ...Array.from({ length: 12 }, (_, index) => `caller-chunk-${index}`),
      ]),
    });

    expect(expanded).toHaveLength(12);
    expect(expanded.every((entry) => entry.relation === "caller" && entry.depth === 1)).toBe(true);
    expect(counters.getCallEdgeFrontierBatch).toBe(1);
    expect(counters.getUnresolvedCallersByTargetNamesOnBranch).toBe(0);
  });

  it("skips unresolved edges while still returning resolved neighbors from the same frontier", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed", "processPayment", "/repo/src/payment.ts"),
        symbol("resolved", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      chunks: [
        chunk("seed-chunk", "processPayment", "/repo/src/payment.ts"),
        chunk("resolved-chunk", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      callees: [
        {
          id: "edge-resolved",
          fromSymbolId: "seed",
          fromSymbolName: "processPayment",
          fromSymbolFilePath: "/repo/src/payment.ts",
          targetName: "saveReceipt",
          toSymbolId: "resolved",
          callType: "Call",
          line: 8,
          col: 2,
          isResolved: true,
        },
        {
          id: "edge-unresolved",
          fromSymbolId: "seed",
          fromSymbolName: "processPayment",
          fromSymbolFilePath: "/repo/src/payment.ts",
          targetName: "notifyUser",
          toSymbolId: null,
          callType: "Call",
          line: 9,
          col: 2,
          isResolved: false,
        },
      ],
    });

    const expanded = expandGraphContext(db, [{
      id: "seed-chunk",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "main",
      depth: 1,
      allowedChunkIds: new Set(["seed-chunk", "resolved-chunk"]),
    });

    expect(expanded).toEqual([
      expect.objectContaining({
        id: "resolved-chunk",
        relation: "callee",
      }),
    ]);
  });
});
