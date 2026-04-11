import { describe, expect, it } from "vitest";

import type { ChunkData, ChunkMetadata, Database, SymbolData } from "../src/native/index.js";
import { expandGraphContext } from "../src/indexer/graph-expansion.js";

type CallerRow = ReturnType<Database["getCallersWithContext"]>[number];
type CalleeRow = ReturnType<Database["getCallees"]>[number];

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

  return {
    getSymbolByNameOnBranch(name: string, filePath: string, branch: string) {
      return filterSymbolsByBranch(branch, symbolsByFile.get(filePath) ?? [])
        .find((item) => item.name === name) ?? null;
    },
    getSymbolsByFileOnBranch(filePath: string, branch: string) {
      return filterSymbolsByBranch(branch, symbolsByFile.get(filePath) ?? []);
    },
    getSymbolsByNameOnBranch(name: string, branch: string) {
      return filterSymbolsByBranch(branch, input.symbols).filter((item) => item.name === name);
    },
    getSymbolsByNameCiOnBranch(name: string, branch: string) {
      return filterSymbolsByBranch(branch, input.symbols)
        .filter((item) => item.name.toLowerCase() === name.toLowerCase());
    },
    getSymbolByIdOnBranch(symbolId: string, branch: string) {
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
      return filterChunksByBranch(branch, chunksByFile.get(filePath) ?? []);
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
      return (input.callers ?? []).filter((item) =>
        item.toSymbolId === _targetSymbolId &&
        (!("branch" in item) || item.branch === _branch)
      );
    },
    getCallees(_symbolId: string, _branch: string) {
      return (input.callees ?? []).filter((item) =>
        item.fromSymbolId === _symbolId &&
        (!("branch" in item) || item.branch === _branch)
      );
    },
  } as unknown as Database;
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

  it("scopes seed and unresolved target symbol resolution to the active branch", () => {
    const db = fakeDatabase({
      symbols: [
        symbol("seed-main", "processPayment", "/repo/src/payment.ts"),
        symbol("seed-feature", "processPayment", "/repo/src/payment.ts"),
        symbol("callee-main", "saveReceipt", "/repo/src/receipt.ts"),
        symbol("callee-feature", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      chunks: [
        chunk("seedChunkMain", "processPayment", "/repo/src/payment.ts"),
        chunk("seedChunkFeature", "processPayment", "/repo/src/payment.ts"),
        chunk("calleeChunkMain", "saveReceipt", "/repo/src/receipt.ts"),
        chunk("calleeChunkFeature", "saveReceipt", "/repo/src/receipt.ts"),
      ],
      branchSymbols: {
        main: ["seed-main", "callee-main"],
        feature: ["seed-feature", "callee-feature"],
      },
      branchChunks: {
        main: ["seedChunkMain", "calleeChunkMain"],
        feature: ["seedChunkFeature", "calleeChunkFeature"],
      },
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
      }, {
        id: "edge-feature",
        fromSymbolId: "seed-feature",
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

    const featureExpanded = expandGraphContext(db, [{
      id: "seedChunkFeature",
      metadata: meta("processPayment", "/repo/src/payment.ts"),
    }], {
      branch: "feature",
      depth: 1,
      allowedChunkIds: new Set(["seedChunkFeature", "calleeChunkFeature"]),
    });
    expect(featureExpanded).toHaveLength(1);
    expect(featureExpanded[0]?.id).toBe("calleeChunkFeature");
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
});
