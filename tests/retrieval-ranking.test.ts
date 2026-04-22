import { readFileSync } from "fs";

import { describe, expect, it } from "vitest";

import type { ScoreBreakdown } from "../src/indexer/index.js";
import type { ChunkMetadata } from "../src/native/index.js";
import {
  applyChunkKindPenalty,
  CALLER_TARGET_PENALTY,
  extractFilePathHint,
  fuseResultsRrf,
  fuseResultsWeighted,
  GRAPH_SOURCE_FLOOR,
  GRAPH_TEST_DOC_FLOOR,
  getChunkKindPenaltyFactor,
  RELATIONSHIP_BIAS_SOURCE,
  SEMANTIC_TEST_DOC_PATH_PENALTY,
  SYMBOL_FALLBACK_EXACT_FLOOR,
  inferTaskType,
  matchesHardRetrievalFilters,
  rankSemanticOnlyResults,
  mergeTieredResults,
  rankHybridResults,
  stripFilePathHint,
  rerankResults,
  chunkTypeBoost,
} from "../src/indexer/index.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };
const EQUAL_FUSION_WEIGHTS = { denseWeight: 0.5, bm25Weight: 0.5, voyageWeight: 0 } as const;

function fuseTwoLaneRrf(
  semantic: Candidate[],
  keyword: Candidate[],
  rrfK: number,
  limit: number
): Candidate[] {
  return fuseResultsRrf([
    { results: semantic, weight: EQUAL_FUSION_WEIGHTS.denseWeight },
    { results: keyword, weight: EQUAL_FUSION_WEIGHTS.bm25Weight },
  ], rrfK, limit);
}

function fuseTwoLaneWeighted(
  semantic: Candidate[],
  keyword: Candidate[],
  limit: number
): Candidate[] {
  return fuseResultsWeighted([
    { results: semantic, weight: EQUAL_FUSION_WEIGHTS.denseWeight },
    { results: keyword, weight: EQUAL_FUSION_WEIGHTS.bm25Weight },
  ], limit);
}

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

function laneBreakdowns(
  semantic: Candidate[],
  keyword: Candidate[],
  voyage: Candidate[] = []
): Map<string, ScoreBreakdown["lanes"]> {
  const byId = new Map<string, ScoreBreakdown["lanes"]>();
  const add = (source: keyof ScoreBreakdown["lanes"], candidates: Candidate[]) => {
    candidates.forEach((candidate, index) => {
      const lanes = byId.get(candidate.id) ?? {};
      lanes[source] = { score: candidate.score, rank: index + 1 };
      byId.set(candidate.id, lanes);
    });
  };
  add("arctic", semantic);
  add("bm25", keyword);
  add("voyage", voyage);
  return byId;
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

    const fused = fuseTwoLaneRrf(semantic, keyword, 60, 10);
    expect(fused.map(r => r.id).slice(0, 3)).toEqual(["a", "c", "d"]);
    expect(fused[0]?.score ?? 0).toBeLessThanOrEqual(1);
    expect(fused[0]?.score ?? 0).toBeGreaterThan(0);
  });

  it("keeps result order and scores identical when score breakdown is enabled", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.91, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 10, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
      { id: "a", score: 1, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
    ];

    const withoutBreakdown = rankHybridResults("where is validateAuth implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 10,
      limit: 5,
      hybridWeight: 0.5,
      bm25Weight: 0.5,
      denseWeight: 0.5,
      voyageWeight: 0,
      taskType: "general",
    });
    const withBreakdown = rankHybridResults("where is validateAuth implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 10,
      limit: 5,
      hybridWeight: 0.5,
      bm25Weight: 0.5,
      denseWeight: 0.5,
      voyageWeight: 0,
      taskType: "general",
      scoreBreakdownLanes: laneBreakdowns(semantic, keyword),
    });

    expect(withBreakdown.map((candidate) => [candidate.id, candidate.score])).toEqual(
      withoutBreakdown.map((candidate) => [candidate.id, candidate.score])
    );
    expect(withoutBreakdown.every((candidate) => candidate.scoreBreakdown === undefined)).toBe(true);
    expect(withBreakdown.every((candidate) => candidate.scoreBreakdown !== undefined)).toBe(true);
  });

  it("records multiplicative test/doc chunk penalties when breakdown is enabled", () => {
    const candidate: Candidate & { chunkKind: "Test"; scoreBreakdown: ScoreBreakdown } = {
      id: "test",
      score: 0.8,
      chunkKind: "Test",
      metadata: meta({
        filePath: "/repo/tests/auth.test.ts",
        name: "auth test",
        chunkType: "function",
        chunkKind: "Test",
      }),
      scoreBreakdown: {
        lanes: { bm25: { score: 0.8, rank: 1 } },
        fusion: { strategy: "rrf", score: 0.8, rank: 1 },
        sources: ["bm25"],
        stages: [],
        preRerankScore: 0.8,
        finalScore: 0.8,
      },
    };

    const [, penalized] = applyChunkKindPenalty([
      {
        id: "source",
        score: 0.9,
        metadata: meta({ filePath: "/repo/src/auth.ts", name: "auth", chunkType: "function", chunkKind: "Code" }),
      },
      candidate,
    ], "definition", "where is auth test");

    expect(penalized?.score).toBe(0.4);
    expect(penalized?.scoreBreakdown?.stages).toContainEqual(expect.objectContaining({
      name: "pathAndKindSuppression",
      kind: "multiply",
      before: 0.8,
      after: 0.4,
      reason: expect.stringContaining("testDocChunkPenalty"),
    }));
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

    const fused = fuseTwoLaneRrf(semantic, keyword, 60, 5);
    const top3 = fused.map(r => r.id).slice(0, 3);
    expect(top3[0]).toBe("both");
    expect(top3).toContain("semanticOnly");
    expect(top3).toContain("keywordOnly");
    for (const result of fused) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("treats documents missing from one list as rank infinity in that lane", () => {
    const semantic: Candidate[] = [
      { id: "semanticOnly", score: 0.95, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticBest", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "keywordOnly", score: 100, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordBest", chunkType: "function" }) },
    ];

    const fused = fuseTwoLaneRrf(semantic, keyword, 60, 10);

    expect(fused).toHaveLength(2);
    expect(fused.map((result) => result.id)).toEqual(["keywordOnly", "semanticOnly"]);
  });

  it("ranks a document present in both lists above one present in only one list", () => {
    const semantic: Candidate[] = [
      { id: "both", score: 0.9, metadata: meta({ filePath: "/repo/src/both.ts", name: "both", chunkType: "function" }) },
      { id: "semanticOnly", score: 0.89, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semantic", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "both", score: 3, metadata: meta({ filePath: "/repo/src/both.ts", name: "both", chunkType: "function" }) },
    ];

    const fused = fuseTwoLaneRrf(semantic, keyword, 60, 10);

    expect(fused[0]?.id).toBe("both");
    expect(fused[1]?.id).toBe("semanticOnly");
  });

  it("returns fused results in descending score order", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.9, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 2, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 1, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];

    const fused = fuseTwoLaneRrf(semantic, keyword, 60, 10);

    for (let i = 1; i < fused.length; i += 1) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score);
    }
  });

  it("uses the provided RRF k constant when computing fused scores", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.9, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "a", score: 3, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 2, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];

    const lowK = fuseTwoLaneRrf(semantic, keyword, 10, 10);
    const highK = fuseTwoLaneRrf(semantic, keyword, 100, 10);

    expect(lowK[0]?.id).toBe("a");
    expect(highK[0]?.id).toBe("a");
    expect(lowK[1]?.id).toBe("b");
    expect(highK[1]?.id).toBe("b");
    expect(lowK[1]?.score).not.toBe(highK[1]?.score);
  });

  it("fuses three weighted lanes and normalizes scores into [0, 1]", () => {
    const semantic: Candidate[] = [
      { id: "shared", score: 0.9, metadata: meta({ filePath: "/repo/src/shared.ts", name: "shared", chunkType: "function" }) },
      { id: "semanticOnly", score: 0.85, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticOnly", chunkType: "function" }) },
    ];
    const voyage: Candidate[] = [
      { id: "voyageTop", score: 0.95, metadata: meta({ filePath: "/repo/src/voyage.ts", name: "voyageTop", chunkType: "function" }) },
      { id: "shared", score: 0.88, metadata: meta({ filePath: "/repo/src/shared.ts", name: "shared", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "shared", score: 12, metadata: meta({ filePath: "/repo/src/shared.ts", name: "shared", chunkType: "function" }) },
      { id: "keywordOnly", score: 9, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordOnly", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf([
      { results: semantic, weight: 0.2 },
      { results: voyage, weight: 0.4 },
      { results: keyword, weight: 0.4 },
    ], 60, 10);

    expect(fused[0]?.id).toBe("shared");
    expect(fused.map((result) => result.id)).toContain("voyageTop");
    expect(fused.map((result) => result.id)).toContain("keywordOnly");
    expect(fused.every((result) => result.score >= 0 && result.score <= 1)).toBe(true);
  });

  it("keeps two-lane RRF scores normalized when Voyage is absent", () => {
    const semantic: Candidate[] = [
      { id: "semanticOnly", score: 0.95, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticOnly", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "keywordOnly", score: 8, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordOnly", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf([
      { results: semantic, weight: 0.6 },
      { results: [], weight: 0.2 },
      { results: keyword, weight: 0.2 },
    ], 60, 10);

    expect(fused).toHaveLength(2);
    expect(fused.every((result) => result.score >= 0 && result.score <= 1)).toBe(true);
  });

  it("applies hard retrieval filters consistently", () => {
    const candidate = meta({
      filePath: "/repo/src/services/auth.ts",
      chunkType: "function",
    });

    expect(matchesHardRetrievalFilters(candidate, {
      fileType: "ts",
      directory: "src/services",
      chunkType: "function",
    })).toBe(true);

    expect(matchesHardRetrievalFilters(candidate, { fileType: "py" })).toBe(false);
    expect(matchesHardRetrievalFilters(candidate, { directory: "docs" })).toBe(false);
    expect(matchesHardRetrievalFilters(candidate, { chunkType: "class" })).toBe(false);
    expect(matchesHardRetrievalFilters(candidate, { excludeFile: "/repo/src/services/auth.ts" })).toBe(false);
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

  it("penalizes interface chunks for definition queries so factories rank above them", () => {
    const candidates: Candidate[] = [
      {
        id: "iface",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/src/procedureBuilder.ts",
          name: "ProcedureBuilder",
          chunkType: "interface",
        }),
      },
      {
        id: "factory",
        score: 0.82,
        metadata: meta({
          filePath: "/repo/src/procedureBuilder.ts",
          name: "createBuilder",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("factory that returns the mutable procedure builder", candidates, 10, {
      pathPreference: "source",
      taskType: "definition",
    });

    expect(reranked.map((candidate) => candidate.id)).toEqual(["factory", "iface"]);
  });

  it("does not penalize interface chunks for semantic queries", () => {
    const candidates: Candidate[] = [
      {
        id: "iface",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/src/procedureBuilder.ts",
          name: "ProcedureBuilder",
          chunkType: "interface",
        }),
      },
      {
        id: "factory",
        score: 0.82,
        metadata: meta({
          filePath: "/repo/src/procedureBuilder.ts",
          name: "createBuilder",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("shape of the procedure builder interface", candidates, 10, {
      pathPreference: "balanced",
      taskType: "semantic",
    });

    expect(reranked[0]?.id).toBe("iface");
  });

  it("keeps implementation chunks ahead of interface chunks for representative definition queries", () => {
    const candidates: Candidate[] = [
      {
        id: "interfaceChunk",
        score: 0.88,
        metadata: meta({
          filePath: "/repo/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts",
          name: "ProcedureBuilder",
          chunkType: "interface",
        }),
      },
      {
        id: "factoryChunk",
        score: 0.81,
        metadata: meta({
          filePath: "/repo/packages/server/src/unstable-core-do-not-import/procedureBuilder.ts",
          name: "createBuilder",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("where is createBuilder defined", candidates, 10, {
      pathPreference: "source",
      taskType: "definition",
    });

    expect(reranked[0]?.id).toBe("factoryChunk");
  });

  it("suppresses unnamed module or other chunks when a named sibling from the same file is present", () => {
    const candidates: Candidate[] = [
      {
        id: "unnamedModule",
        score: 0.918,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: undefined,
          chunkType: "other",
        }),
      },
      {
        id: "namedFunction",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: "sanitizeHeaderValue",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("zzqv", candidates, 10, {
      pathPreference: "balanced",
      taskType: "definition",
    });

    expect(reranked[0]?.id).toBe("namedFunction");
    expect(reranked[1]?.id).toBe("unnamedModule");
  });

  it("does not suppress real named module chunks that merely match the file stem", () => {
    const candidates: Candidate[] = [
      {
        id: "moduleChunk",
        score: 1.25,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: "AxiosHeaders",
          chunkType: "module",
        }),
      },
      {
        id: "namedFunction",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: "sanitizeHeaderValue",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("zzqv", candidates, 10, {
      pathPreference: "balanced",
      taskType: "definition",
    });

    // The module chunk still pays the normal `module` base penalty, but it should
    // no longer take the extra -0.10 same-file unnamed/default suppression.
    expect(reranked[0]?.id).toBe("moduleChunk");
    expect(reranked[1]?.id).toBe("namedFunction");
  });

  it("suppresses placeholder-named module chunks when a named sibling is present", () => {
    const candidates: Candidate[] = [
      {
        id: "moduleChunk",
        score: 0.918,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: "<default>",
          chunkType: "module",
        }),
      },
      {
        id: "namedFunction",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/lib/core/AxiosHeaders.js",
          name: "sanitizeHeaderValue",
          chunkType: "function",
        }),
      },
    ];

    const reranked = rerankResults("header value sanitize", candidates, 10, {
      pathPreference: "source",
      taskType: "definition",
    });

    expect(reranked[0]?.id).toBe("namedFunction");
    expect(reranked[1]?.id).toBe("moduleChunk");
  });

  it("uses at least a -0.12 base penalty for unnamed other chunks", () => {
    expect(chunkTypeBoost("other")).toBeLessThanOrEqual(-0.12);
  });

  it("exports named load-bearing and dangerous scoring constants", () => {
    expect(GRAPH_SOURCE_FLOOR).toBe(0.97);
    expect(RELATIONSHIP_BIAS_SOURCE).toBe(0.6);
    expect(CALLER_TARGET_PENALTY).toBe(0.51);
    expect(GRAPH_TEST_DOC_FLOOR).toBe(0.72);
    expect(SEMANTIC_TEST_DOC_PATH_PENALTY).toBe(0.35);
    expect(SYMBOL_FALLBACK_EXACT_FLOOR).toBe(0.97);
  });

  it("marks scoring debt on extracted scoring constants", () => {
    const source = readFileSync(new URL("../src/indexer/index.ts", import.meta.url), "utf8");
    expect(source.match(/SCORING-DEBT/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
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

  it("softly demotes test chunks for semantic source-oriented queries", () => {
    const candidates: Candidate[] = [
      {
        id: "testChunk",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/tests/eval-budget.test.ts",
          name: "eval budget gate",
          chunkType: "function",
          chunkKind: "Test",
        }),
        chunkKind: "Test",
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/src/eval/budget.ts",
          name: "evaluateBudgetGate",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "semantic", "where is budget enforcement handled");

    expect(getChunkKindPenaltyFactor("semantic", "Test")).toBe(0.45);
    expect(getChunkKindPenaltyFactor("semantic", "Doc")).toBe(0.45);
    expect(penalized[0]?.id).toBe("sourceChunk");
    expect(penalized[1]?.score).toBeCloseTo(0.405, 6);
  });

  it("does not penalize test chunks for test_debug queries", () => {
    const candidates: Candidate[] = [
      {
        id: "testChunk",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/tests/auth.test.ts",
          name: "auth tests",
          chunkType: "function",
          chunkKind: "Test",
        }),
        chunkKind: "Test",
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/src/auth.ts",
          name: "authenticate",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "test_debug", "what tests cover the login flow");

    expect(getChunkKindPenaltyFactor("test_debug", "Test")).toBe(1);
    expect(penalized.map((candidate) => candidate.id)).toEqual(["testChunk", "sourceChunk"]);
  });

  it("penalizes rust inline test chunks the same way as test files for source-oriented queries", () => {
    const candidates: Candidate[] = [
      {
        id: "rustInlineTest",
        score: 0.85,
        metadata: meta({
          filePath: "/repo/native/src/db.rs",
          name: "test_busy_timeout_waits_for_transient_write_lock",
          chunkType: "function",
          chunkKind: "Test",
        }),
        chunkKind: "Test",
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/native/src/db.rs",
          name: "retry_busy_sqlite",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "definition", "sqlite busy timeout handling");

    expect(getChunkKindPenaltyFactor("definition", "Test")).toBe(0.5);
    expect(penalized[0]?.id).toBe("sourceChunk");
    expect(penalized[1]?.score).toBeCloseTo(0.425, 6);
  });

  it("does not penalize rust inline test chunks for test_debug queries", () => {
    const candidates: Candidate[] = [
      {
        id: "rustInlineTest",
        score: 0.85,
        metadata: meta({
          filePath: "/repo/native/src/db.rs",
          name: "test_busy_timeout_waits_for_transient_write_lock",
          chunkType: "function",
          chunkKind: "Test",
        }),
        chunkKind: "Test",
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/native/src/db.rs",
          name: "retry_busy_sqlite",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(
      candidates,
      "test_debug",
      "what tests cover sqlite busy timeout handling"
    );

    expect(getChunkKindPenaltyFactor("test_debug", "Test")).toBe(1);
    expect(penalized.map((candidate) => candidate.id)).toEqual(["rustInlineTest", "sourceChunk"]);
  });

  it("does not penalize code or constant chunks", () => {
    const candidates: Candidate[] = [
      {
        id: "constant",
        score: 0.82,
        metadata: meta({
          filePath: "/repo/src/indexer/search-recipes.ts",
          name: "DEFAULT_FINAL_RERANK_TOP_N",
          chunkType: "constant",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
      {
        id: "function",
        score: 0.81,
        metadata: meta({
          filePath: "/repo/src/indexer/index.ts",
          name: "rankHybridResults",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "definition", "what is the default rerank window size");

    expect(getChunkKindPenaltyFactor("definition", "Code")).toBe(1);
    expect(penalized[0]?.score).toBe(0.82);
    expect(penalized[1]?.score).toBe(0.81);
  });

  it("does not penalize non-test rust functions", () => {
    const candidates: Candidate[] = [
      {
        id: "rustFunction",
        score: 0.83,
        metadata: meta({
          filePath: "/repo/native/src/db.rs",
          name: "process_data",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
      {
        id: "otherSource",
        score: 0.8,
        metadata: meta({
          filePath: "/repo/native/src/lib.rs",
          name: "run",
          chunkType: "function",
          chunkKind: "Code",
        }),
        chunkKind: "Code",
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "semantic", "data processing internals");

    expect(penalized[0]?.score).toBe(0.83);
    expect(penalized[1]?.score).toBe(0.8);
  });

  it("softly demotes test chunks for semantic module-overview queries", () => {
    const candidates: Candidate[] = [
      {
        id: "testChunk",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/tests/eval-runner.test.ts",
          name: "eval runner",
          chunkType: "function",
          chunkKind: "Test",
        }),
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/src/eval/runner.ts",
          name: "finalizeEvaluationRun",
          chunkType: "function",
          chunkKind: "Code",
        }),
      },
    ];

    const penalized = applyChunkKindPenalty(candidates, "semantic", "what does the runner pipeline module do");

    expect(penalized.map((candidate) => candidate.id)).toEqual(["sourceChunk", "testChunk"]);
    expect(penalized[1]?.score).toBeCloseTo(0.405, 6);
  });

  it("does not penalize semantic recipe-mapping queries", () => {
    const candidates: Candidate[] = [
      {
        id: "testChunk",
        score: 0.9,
        metadata: meta({
          filePath: "/repo/tests/search-recipes.test.ts",
          name: "search recipes",
          chunkType: "function",
          chunkKind: "Test",
        }),
      },
      {
        id: "sourceChunk",
        score: 0.7,
        metadata: meta({
          filePath: "/repo/src/indexer/search-recipes.ts",
          name: "mapEvalQueryTypeToTaskType",
          chunkType: "function",
          chunkKind: "Code",
        }),
      },
    ];

    const penalized = applyChunkKindPenalty(
      candidates,
      "semantic",
      "where is input type to task recipe mapping handled"
    );

    expect(penalized.map((candidate) => candidate.id)).toEqual(["testChunk", "sourceChunk"]);
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

    const preRerank = fuseTwoLaneRrf(semantic, keyword, 60, 10);
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

    const weighted = fuseTwoLaneWeighted(semantic, keyword, 10);
    expect(weighted.map(r => r.id).slice(0, 2)).toEqual(["b", "c"]);
  });

  it("handles edge cases for disjoint and empty candidate sets", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.9, metadata: meta({ filePath: "/repo/src/s1.ts", name: "s1", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 2.5, metadata: meta({ filePath: "/repo/src/k1.ts", name: "k1", chunkType: "function" }) },
    ];

    const disjoint = fuseTwoLaneRrf(semantic, keyword, 60, 10);
    expect(disjoint).toHaveLength(2);
    expect(disjoint.map(r => r.id)).toContain("s1");
    expect(disjoint.map(r => r.id)).toContain("k1");

    expect(fuseTwoLaneRrf([], [], 60, 10)).toEqual([]);
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

  it("infers bug task type from expected/actual bug report phrasing", () => {
    expect(inferTaskType(
      "Expected behavior: abort: true should stop. Actual behavior: it continues validating."
    )).toBe("bug");
  });

  it("infers test_debug for natural-language test discovery queries", () => {
    expect(inferTaskType("what tests cover the login flow?")).toBe("test_debug");
    expect(inferTaskType("where are the auth tests?")).toBe("test_debug");
    expect(inferTaskType("failing test for payment processing")).toBe("test_debug");
    expect(inferTaskType("what does the login flow test")).toBe("test_debug");
    expect(inferTaskType("how does beforeEach set up auth state?")).toBe("test_debug");
  });

  it("does not override an explicitly provided task type during inference", () => {
    expect(inferTaskType(
      "Expected behavior: abort: true should stop. Actual behavior: it continues validating.",
      "definition"
    )).toBe("definition");
    expect(inferTaskType("what tests cover the login flow?", "general")).toBe("general");
  });

  it("avoids false-positive bug inference for ordinary definition lookup queries", () => {
    expect(inferTaskType("where is rankHybridResults implementation")).toBe("general");
    expect(inferTaskType("what does the App component render?")).toBe("general");
  });
});
