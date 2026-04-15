import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import type { SearchTaskType } from "../src/indexer/search-recipes.js";
import {
  DEFAULT_LOCAL_CROSS_ENCODER_MODEL,
  DEFAULT_LOCAL_CROSS_ENCODER_TOKENIZER,
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

  async rerank(_query: string, _candidates: RerankerCandidate[], _taskType: SearchTaskType): Promise<RerankerCandidate[]> {
    throw new Error("boom");
  }
}

class ReverseBackend implements SearchRerankerBackend {
  readonly name = "reverse";

  async rerank(
    _query: string,
    candidates: RerankerCandidate[],
    _taskType: SearchTaskType
  ): Promise<RerankerCandidate[]> {
    return [...candidates].reverse();
  }
}

class IdentityBackend implements SearchRerankerBackend {
  readonly name = "identity";

  async rerank(
    _query: string,
    candidates: RerankerCandidate[],
    _taskType: SearchTaskType
  ): Promise<RerankerCandidate[]> {
    return candidates;
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

  it("prefers stored Test chunkKind over a non-test file path", async () => {
    const backend = new HeuristicLocalRerankerBackend();
    const reranked = await backend.rerank("debug failing checkout test", [
      candidate("prod-helper", {
        metadata: {
          filePath: "/repo/src/checkout/runner.ts",
          startLine: 1,
          endLine: 10,
          chunkType: "function",
          language: "typescript",
          hash: "prod-helper",
          name: "runner",
        },
        chunkKind: "Code",
        content: "export function runner() { return false; }",
      }),
      candidate("stored-test", {
        metadata: {
          filePath: "/repo/src/checkout/scenarios.ts",
          startLine: 1,
          endLine: 10,
          chunkType: "function",
          language: "typescript",
          hash: "stored-test",
          name: "checkoutScenario",
        },
        chunkKind: "Test",
        content: "export function checkoutScenario() { return false; }",
      }),
    ], "test_debug");

    expect(reranked[0]?.id).toBe("stored-test");
  });

  it("falls back to test-path heuristics when chunkKind is undefined", async () => {
    const backend = new HeuristicLocalRerankerBackend();
    const reranked = await backend.rerank("debug failing checkout test", [
      candidate("plain-source", {
        metadata: {
          filePath: "/repo/src/checkout/runner.ts",
          startLine: 1,
          endLine: 10,
          chunkType: "function",
          language: "typescript",
          hash: "plain-source",
          name: "runner",
        },
        content: "export function runner() { return false; }",
      }),
      candidate("path-test", {
        metadata: {
          filePath: "/repo/tests/checkout/runner.spec.ts",
          startLine: 1,
          endLine: 10,
          chunkType: "function",
          language: "typescript",
          hash: "path-test",
          name: "runnerSpec",
        },
        content: "export function runnerSpec() { return false; }",
      }),
    ], "test_debug");

    expect(reranked[0]?.id).toBe("path-test");
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

  it("demotes test chunks after reranking for bug queries", async () => {
    const reranker = new SearchReranker([new IdentityBackend()]);
    const result = await reranker.rerank("sqlite lock contention", [
      candidate("test-case", {
        baseScore: 0.9,
        chunkKind: "Test",
        content: "assert retry waits through transient sqlite write contention",
      }),
      candidate("source", {
        baseScore: 0.2,
        chunkKind: "Code",
        content: "fn retry_busy_sqlite() { /* retry loop */ }",
      }),
    ], "bug");

    expect(result.candidates.map((item) => item.id)).toEqual(["source", "test-case"]);
    expect(result.candidates[1]?.baseScore).toBeCloseTo(0.045, 6);
  });

  it("does not apply bug-only post-rerank dampening to test_debug queries", async () => {
    const reranker = new SearchReranker([new IdentityBackend()]);
    const result = await reranker.rerank("what tests cover sqlite lock contention", [
      candidate("test-case", {
        baseScore: 0.9,
        chunkKind: "Test",
        content: "assert retry waits through transient sqlite write contention",
      }),
      candidate("source", {
        baseScore: 0.2,
        chunkKind: "Code",
        content: "fn retry_busy_sqlite() { /* retry loop */ }",
      }),
    ], "test_debug");

    expect(result.candidates.map((item) => item.id)).toEqual(["test-case", "source"]);
    expect(result.candidates[0]?.baseScore).toBe(0.9);
  });

  it("rewrites candidate scores with sigmoid-normalized cross-encoder output", async () => {
    const backend = new TransformersCrossEncoderBackend(async () =>
      async () => [10, -5]
    );

    const reranked = await backend.rerank("find target implementation", [
      candidate("high", { content: "target implementation body" }),
      candidate("low", { content: "generic helper function" }),
    ], "definition");

    expect(reranked.map((item) => item.id)).toEqual(["high", "low"]);
    expect(reranked[0]?.baseScore).toBeCloseTo(1 / (1 + Math.exp(-10)), 6);
    expect(reranked[1]?.baseScore).toBeCloseTo(1 / (1 + Math.exp(5)), 6);
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
      candidate("generic", {
        metadata: {
          filePath: "/repo/src/generic.ts",
          startLine: 1,
          endLine: 20,
          chunkType: "function",
          language: "typescript",
          hash: "generic",
        },
        content: "generic helper function",
        chunkKind: "Code",
        symbolKind: "Function",
      }),
      candidate("target", {
        metadata: {
          filePath: "/repo/src/target.ts",
          startLine: 1,
          endLine: 20,
          chunkType: "function",
          language: "typescript",
          hash: "target",
        },
        content: "target implementation body",
        chunkKind: "Test",
        relation: "callee",
      }),
    ], "definition");

    expect(seen).toEqual([
      {
        text: "find target implementation",
        textPair: "[kind: Code] [symbol: Function] generic helper function",
      },
      {
        text: "find target implementation",
        textPair: "[kind: Test] [relation: callee] target implementation body",
      },
    ]);
    expect(reranked.map((item) => item.id)).toEqual(["target", "generic"]);
  });

  it("uses matching tokenizer and model assets for the local cross-encoder", () => {
    expect(DEFAULT_LOCAL_CROSS_ENCODER_TOKENIZER).toBe(DEFAULT_LOCAL_CROSS_ENCODER_MODEL);
  });

  it("does not inject structured prefixes into the heuristic backend content", async () => {
    const backend = new HeuristicLocalRerankerBackend();
    const reranked = await backend.rerank("debug checkout test", [
      candidate("test-case", {
        chunkKind: "Test",
        relation: "callee",
        content: "it should process checkout retries",
      }),
      candidate("helper", {
        content: "helper implementation",
      }),
    ], "test_debug");

    expect(reranked.find((item) => item.id === "test-case")?.content).toBe("it should process checkout retries");
  });
});
