import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import {
  HeuristicLocalRerankerBackend,
  SearchReranker,
  TransformersCrossEncoderBackend,
  type RerankerCandidate,
  type SearchRerankerBackend,
} from "../src/indexer/reranker.js";

function candidate(
  id: string,
  overrides: Partial<RerankerCandidate> = {}
): RerankerCandidate {
  const metadata: ChunkMetadata = {
    filePath: `/repo/src/${id}.ts`,
    startLine: 1,
    endLine: 20,
    chunkType: "function",
    language: "typescript",
    hash: id,
    name: id,
  };

  return {
    id,
    baseScore: 0.5,
    metadata,
    content: `function ${id}() { return "${id}"; }`,
    ...overrides,
  };
}

class ThrowingBackend implements SearchRerankerBackend {
  readonly name = "throwing";

  async rerank(): Promise<RerankerCandidate[]> {
    throw new Error("boom");
  }
}

class ReverseBackend implements SearchRerankerBackend {
  readonly name = "reverse";

  async rerank(_query: string, candidates: RerankerCandidate[]): Promise<RerankerCandidate[]> {
    return [...candidates].reverse();
  }
}

describe("search reranker", () => {
  it("reorders candidates by local joint score", async () => {
    const backend = new HeuristicLocalRerankerBackend();
    const reranked = await backend.rerank("where is validateToken implementation", [
      candidate("generic", {
        metadata: {
          filePath: "/repo/src/auth/helpers.ts",
          startLine: 1,
          endLine: 10,
          chunkType: "function",
          language: "typescript",
          hash: "generic",
          name: "helper",
        },
        content: "function helper() { return true; }",
      }),
      candidate("target", {
        metadata: {
          filePath: "/repo/src/auth/validate-token.ts",
          startLine: 1,
          endLine: 15,
          chunkType: "function",
          language: "typescript",
          hash: "target",
          name: "validateToken",
        },
        content: "export function validateToken(token: string) { return token.length > 0; }",
      }),
    ], "definition");

    expect(reranked[0]?.id).toBe("target");
  });

  it("falls back without reranking when fewer than two candidates exist", async () => {
    const reranker = new SearchReranker([new ReverseBackend()]);
    const result = await reranker.rerank("query", [candidate("only")], "semantic");

    expect(result.applied).toBe(false);
    expect(result.candidates.map((item) => item.id)).toEqual(["only"]);
  });

  it("falls back gracefully when the first backend fails", async () => {
    const reranker = new SearchReranker([new ThrowingBackend(), new ReverseBackend()]);
    const result = await reranker.rerank("query", [candidate("first"), candidate("second")], "semantic");

    expect(result.applied).toBe(true);
    expect(result.backend).toBe("reverse");
    expect(result.failedBackend).toBe("throwing");
    expect(result.candidates.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("passes structured query-document pairs into the transformers backend", async () => {
    const seen: Array<{ text: string; textPair: string }> = [];
    const backend = new TransformersCrossEncoderBackend(async () =>
      async (pairs) => {
        seen.push(...pairs);
        return pairs.map((pair) => pair.textPair.includes("target") ? 10 : -5);
      }
    );

    const reranked = await backend.rerank("find target implementation", [
      candidate("generic", { content: "generic helper function" }),
      candidate("target", { content: "target implementation body" }),
    ], "definition");

    expect(seen).toEqual([
      { text: "find target implementation", textPair: "generic helper function" },
      { text: "find target implementation", textPair: "target implementation body" },
    ]);
    expect(reranked.map((item) => item.id)).toEqual(["target", "generic"]);
  });
});
