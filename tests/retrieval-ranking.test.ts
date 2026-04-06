import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import {
  extractFilePathHint,
  fuseResultsRrf,
  fuseResultsWeighted,
  rankSemanticOnlyResults,
  mergeTieredResults,
  rankHybridResults,
  stripFilePathHint,
  rerankResults,
} from "../src/indexer/index.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };

function meta(overrides: Partial<ChunkMetadata>): ChunkMetadata {
  return {
    filePath: "/repo/src/unknown.ts",
    startLine: 1,
    endLine: 10,
    chunkType: "other",
    language: "typescript",
    hash: "hash",
    ...overrides,
  };
}

describe("retrieval ranking", () => {
  it("fuses hybrid results using RRF rank ordering", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.91, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "d", score: 50, metadata: meta({ filePath: "/repo/src/auth-route.ts", name: "authRoute", chunkType: "function" }) },
      { id: "c", score: 30, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
      { id: "a", score: 1, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(fused.map(r => r.id).slice(0, 3)).toEqual(["a", "c", "d"]);
    expect(fused[0]?.score ?? 0).toBeLessThanOrEqual(1);
    expect(fused[0]?.score ?? 0).toBeGreaterThan(0);
  });

  it("keeps both semantic-only and keyword-only candidates in top fused results", () => {
    const semantic: Candidate[] = [
      { id: "semanticOnly", score: 0.95, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticBest", chunkType: "function" }) },
      { id: "both", score: 0.9, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "keywordOnly", score: 100, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordBest", chunkType: "function" }) },
      { id: "both", score: 1, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 5);
    const top3 = fused.map(r => r.id).slice(0, 3);
    expect(top3[0]).toBe("both");
    expect(top3).toContain("semanticOnly");
    expect(top3).toContain("keywordOnly");
    for (const result of fused) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("reranks deterministically using name/path/chunk-type signals", () => {
    const candidates: Candidate[] = [
      { id: "generic", score: 0.9, metadata: meta({ filePath: "/repo/src/misc.ts", name: "handler", chunkType: "other" }) },
      { id: "pathOverlap", score: 0.9, metadata: meta({ filePath: "/repo/src/auth/handler.ts", name: "handler", chunkType: "other" }) },
      { id: "exactName", score: 0.9, metadata: meta({ filePath: "/repo/src/services/auth.ts", name: "auth", chunkType: "function" }) },
    ];

    const reranked = rerankResults("auth handler", candidates, 10);
    expect(reranked.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);

    const rerankedAgain = rerankResults("auth handler", candidates, 10);
    expect(rerankedAgain.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);
  });

  it("applies hybrid ranking path for search and semantic-only rerank for findSimilar", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "auth", chunkType: "function" }) },
      { id: "s2", score: 0.92, metadata: meta({ filePath: "/repo/src/util.ts", name: "helper", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 42, metadata: meta({ filePath: "/repo/src/routes/auth.ts", name: "authRoute", chunkType: "function" }) },
    ];

    const searchRanked = rankHybridResults("auth", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 5,
      limit: 5,
      hybridWeight: 0.5,
    });
    expect(searchRanked.some(r => r.id === "k1")).toBe(true);

    const similarRanked = rankSemanticOnlyResults("auth", semantic, {
      rerankTopN: 5,
      limit: 5,
    });
    expect(similarRanked.map(r => r.id)).not.toContain("k1");
  });

  it("returns pre-rerank order when rerankTopN is 0", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.92, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.90, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 80, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "x", score: 79, metadata: meta({ filePath: "/repo/src/x.ts", name: "x", chunkType: "function" }) },
    ];

    const preRerank = fuseResultsRrf(semantic, keyword, 60, 10);
    const ranked = rankHybridResults("query", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 0,
      limit: 10,
      hybridWeight: 0.5,
    });

    expect(ranked.map(r => r.id)).toEqual(preRerank.map(r => r.id));
  });

  it("supports weighted fusion strategy fallback", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 1.0, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.8, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 4.0, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 3.0, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];

    const weighted = fuseResultsWeighted(semantic, keyword, 0.5, 10);
    expect(weighted.map(r => r.id).slice(0, 2)).toEqual(["b", "c"]);
  });

  it("handles edge cases for disjoint and empty candidate sets", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.9, metadata: meta({ filePath: "/repo/src/s1.ts", name: "s1", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 2.5, metadata: meta({ filePath: "/repo/src/k1.ts", name: "k1", chunkType: "function" }) },
    ];

    const disjoint = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(disjoint).toHaveLength(2);
    expect(disjoint.map(r => r.id)).toContain("s1");
    expect(disjoint.map(r => r.id)).toContain("k1");

    expect(fuseResultsRrf([], [], 60, 10)).toEqual([]);
    expect(rankSemanticOnlyResults("q", [], { rerankTopN: 10, limit: 5 })).toEqual([]);
  });

  it("prefers src implementation paths over tests/docs for implementation-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "testCase", score: 0.92, metadata: meta({ filePath: "/repo/tests/retrieval-ranking.test.ts", name: "retrieval ranking", chunkType: "function" }) },
      { id: "readme", score: 0.92, metadata: meta({ filePath: "/repo/README.md", name: "retrieval docs", chunkType: "other" }) },
      { id: "srcImpl", score: 0.9, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults implementation", candidates, 10);
    expect(reranked[0]?.id).toBe("srcImpl");
  });

  it("does not force src priority for doc/test-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "srcImpl", score: 0.92, metadata: meta({ filePath: "/repo/stacks/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "readme", score: 0.9, metadata: meta({ filePath: "/repo/README.md", name: "retrieval docs", chunkType: "other" }) },
      { id: "testCase", score: 0.89, metadata: meta({ filePath: "/repo/tests/retrieval-ranking.test.ts", name: "retrieval test", chunkType: "function" }) },
    ];

    const reranked = rerankResults("README retrieval docs", candidates, 10);
    expect(reranked[0]?.id).toBe("readme");
  });

  it("prioritizes exact identifier hints for implementation-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "noise1", score: 0.93, metadata: meta({ filePath: "/repo/native/src/lib.rs", name: "VectorStore", chunkType: "other" }) },
      { id: "noise2", score: 0.92, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "isRateLimitError", chunkType: "function" }) },
      { id: "target", score: 0.9, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults implementation", candidates, 10);
    expect(reranked[0]?.id).toBe("target");
  });

  it("promotes implementation symbol matches in hybrid ranking for identifier queries", () => {
    const semantic: Candidate[] = [
      { id: "noiseA", score: 0.96, metadata: meta({ filePath: "/repo/tests/fixtures/edge.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "noiseB", score: 0.95, metadata: meta({ filePath: "/repo/native/src/lib.rs", name: "VectorStore", chunkType: "other" }) },
      { id: "target", score: 0.84, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "target", score: 0.6, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "noiseA", score: 0.7, metadata: meta({ filePath: "/repo/tests/fixtures/edge.ts", name: "entryPoint", chunkType: "function" }) },
    ];

    const ranked = rankHybridResults("where is rankHybridResults implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("keeps symbol-lane candidates ahead of hybrid lane in tiered merge", () => {
    const symbolLane: Candidate[] = [
      { id: "def1", score: 0.99, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "def2", score: 0.88, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rerankResults", chunkType: "function" }) },
    ];
    const hybridLane: Candidate[] = [
      { id: "noise", score: 1, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "def1", score: 0.7, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "other", score: 0.69, metadata: meta({ filePath: "/repo/stacks/search/pipeline.ts", name: "pipeline", chunkType: "function" }) },
    ];

    const merged = mergeTieredResults(symbolLane, hybridLane, 5);
    expect(merged.map((r) => r.id).slice(0, 2)).toEqual(["def1", "def2"]);
    expect(merged.map((r) => r.id)).toContain("noise");
  });

  it("builds fallback lane from implementation code-term hints when exact symbol names are unavailable", () => {
    const hybridLane: Candidate[] = [
      { id: "target", score: 0.65, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "buildSymbolDefinitionLane", chunkType: "function" }) },
      { id: "noise", score: 0.9, metadata: meta({ filePath: "/repo/tests/fixtures/call-graph/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
    ];

    const symbolLane: Candidate[] = [
      { id: "target", score: 0.88, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "buildSymbolDefinitionLane", chunkType: "function" }) },
    ];

    const merged = mergeTieredResults(symbolLane, hybridLane, 5);
    expect(merged[0]?.id).toBe("target");
  });

  it("prefers exact identifier implementation chunks over noisy fixture chunks", () => {
    const semantic: Candidate[] = [
      { id: "fixture", score: 0.96, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "bench", score: 0.95, metadata: meta({ filePath: "/repo/benchmarks/run.ts", name: "runBenchmarks", chunkType: "function" }) },
      { id: "target", score: 0.7, metadata: meta({ filePath: "/repo/app/indexer/system.ts", name: "createSystem", chunkType: "export" }) },
    ];
    const keyword: Candidate[] = [
      { id: "fixture", score: 0.9, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.65, metadata: meta({ filePath: "/repo/app/indexer/system.ts", name: "createSystem", chunkType: "export" }) },
    ];

    const ranked = rankHybridResults("where is createSystem implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("deterministically prefers exact name chunk even when fixture has higher base score", () => {
    const semantic: Candidate[] = [
      { id: "fixture", score: 0.98, metadata: meta({ filePath: "/repo/tests/fixtures/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.61, metadata: meta({ filePath: "/repo/packages/react/src/styled-system/system.ts", name: "createSystem", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "fixture", score: 0.97, metadata: meta({ filePath: "/repo/tests/fixtures/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.62, metadata: meta({ filePath: "/repo/packages/react/src/styled-system/system.ts", name: "createSystem", chunkType: "function" }) },
    ];

    const ranked = rankHybridResults("where is createSystem implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("classifies implementation intent correctly with explicit implementation signal, and avoids over-routing doc/test phrasing", () => {
    const candidates: Candidate[] = [
      { id: "impl", score: 0.88, metadata: meta({ filePath: "/repo/src/indexer/system.ts", name: "createSystem", chunkType: "function" }) },
      { id: "bench", score: 0.92, metadata: meta({ filePath: "/repo/benchmarks/run.ts", name: "runBenchmarks", chunkType: "function" }) },
      { id: "tests", score: 0.9, metadata: meta({ filePath: "/repo/tests/system.test.ts", name: "createSystem test", chunkType: "function" }) },
    ];

    const implementationQuery = "where is createSystem implementation";
    const implementationReranked = rerankResults(implementationQuery, candidates, 10);
    expect(implementationReranked[0]?.id).toBe("impl");

    const docTestWeightedQueries = [
      "where is createSystem implementation benchmark test",
      "where is createSystem benchmark",
    ];
    for (const query of docTestWeightedQueries) {
      const reranked = rerankResults(query, candidates, 10);
      expect(reranked[0]?.id).not.toBe("impl");
    }
  });

  it("does not over-route doc phrasing with 'where is ... documentation' to source intent", () => {
    const candidates: Candidate[] = [
      { id: "impl", score: 0.91, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "docs", score: 0.9, metadata: meta({ filePath: "/repo/README.md", name: "retrieval documentation", chunkType: "other" }) },
      { id: "tests", score: 0.89, metadata: meta({ filePath: "/repo/tests/retrieval.test.ts", name: "rankHybridResults test", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults documentation", candidates, 10);
    expect(reranked[0]?.id).toBe("docs");
  });

  it("extracts file path hint from path-constrained implementation query", () => {
    const query = "where is createSystem implementation in packages/react/src/styled-system/system.ts";
    expect(extractFilePathHint(query)).toBe("packages/react/src/styled-system/system.ts");
  });

  it("returns null for queries without file path hint", () => {
    const query = "where is createSystem implementation";
    expect(extractFilePathHint(query)).toBeNull();
  });

  it("strips file path suffix from embedding query text", () => {
    const query = "where is createSystem implementation in packages/react/src/styled-system/system.ts";
    expect(stripFilePathHint(query)).toBe("where is createSystem implementation");
  });
});
