import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServerMock = vi.fn();

vi.mock("http", async () => {
  const actual = await vi.importActual<typeof import("http")>("http");
  return {
    ...actual,
    createServer: (...args: unknown[]) => createServerMock(...args),
  };
});

import { runEvaluation, runSweep } from "../src/eval/runner.js";
import { Indexer } from "../src/indexer/index.js";

describe("eval runner", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createServerMock.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
    mkdirSync(path.join(tempDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(tempDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "budgets"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "baselines"), { recursive: true });

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: false,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(tempDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs eval and writes required artifacts", async () => {
    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(result.summary.queryCount).toBe(1);
    expect(result.summary.searchConfig.effectiveTaskType).toBe("definition");
    expect(result.summary.searchConfig.effectiveFinalRerankTopN).toBe(20);
    expect(result.summary.searchConfig.effectiveGraphDepth).toBe(1);
    expect(readFileSync(path.join(result.outputDir, "summary.json"), "utf-8")).toContain("\"metrics\"");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("# Evaluation Summary");
    expect(readFileSync(path.join(result.outputDir, "per-query.json"), "utf-8")).toContain("\"queries\"");
    const perQueryArtifact = JSON.parse(readFileSync(path.join(result.outputDir, "per-query.json"), "utf-8")) as {
      queries: Array<{ prefilterMs?: number; subIntent?: string | null; results: Array<{ scoreBreakdown?: { fusion?: { subIntent?: string | null } } }> }>;
    };
    expect(perQueryArtifact.queries[0]?.prefilterMs).toBeDefined();
    expect(perQueryArtifact.queries[0]?.subIntent).toBe("definition:executable");
    expect(perQueryArtifact.queries[0]?.results[0]?.scoreBreakdown).toEqual(expect.objectContaining({
      lanes: expect.any(Object),
      fusion: expect.objectContaining({
        subIntent: "definition:executable",
      }),
      stages: expect.any(Array),
      finalScore: expect.any(Number),
    }));
  });

  it("writes subIntent alongside effectiveTaskType in the per-query artifact", async () => {
    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const perQueryArtifact = JSON.parse(readFileSync(path.join(result.outputDir, "per-query.json"), "utf-8")) as {
      queries: Array<{ effectiveTaskType?: string; subIntent?: string | null }>;
    };

    expect(perQueryArtifact.queries[0]?.effectiveTaskType).toBe("definition");
    expect(perQueryArtifact.queries[0]?.subIntent).toBe("definition:executable");
  });

  it("uses the general task type for all eval queries when useQueryTypes is false", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed");

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
              },
            },
            {
              id: "q2",
              query: "find similar code",
              queryType: "similarity",
              expected: {
                filePath: "src/tools/index.ts",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const taskTypes = searchDetailedSpy.mock.calls.map((call) => call[2]?.taskType);
    expect(taskTypes).toEqual(["general", "general"]);
    expect(result.summary.searchConfig.useQueryTypes).toBe(false);
    expect(result.summary.searchConfig.effectiveTaskType).toBe("general");
    expect(result.summary.searchConfig.effectiveFinalRerankTopN).toBe(10);

    searchDetailedSpy.mockRestore();
  });

  it("uses mapped per-query task types when useQueryTypes is true", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed");

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
              },
            },
            {
              id: "q2",
              query: "find the tool implementation",
              expected: {
                filePath: "src/tools/index.ts",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const taskTypes = searchDetailedSpy.mock.calls.map((call) => call[2]?.taskType);
    expect(taskTypes).toEqual(["definition", "general"]);
    expect(result.summary.searchConfig.useQueryTypes).toBe(true);
    expect(result.summary.searchConfig.effectiveTaskType).toBe("mixed");
    expect(result.summary.searchConfig.effectiveFinalRerankTopN).toBe(-1);
    expect(result.summary.searchConfig.effectiveGraphDepth).toBe(-1);

    searchDetailedSpy.mockRestore();
  });

  it("maps test-discovery and bug-report query types into test_debug and bug recipes", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed");

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "what tests cover ranking?",
              queryType: "test-discovery",
              expected: {
                filePath: "tests/retrieval-ranking.test.ts",
              },
            },
            {
              id: "q2",
              query: "Expected behavior: eval gate should pass. Actual behavior: it regresses hit quality.",
              queryType: "bug-report",
              expected: {
                filePath: "src/eval/budget.ts",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const taskTypes = searchDetailedSpy.mock.calls.map((call) => call[2]?.taskType);
    expect(taskTypes).toEqual(["test_debug", "bug"]);
    searchDetailedSpy.mockRestore();
  });

  it("records effective recipe fields for a definition-only eval run", async () => {
    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const summaryJson = JSON.parse(
      readFileSync(path.join(result.outputDir, "summary.json"), "utf-8")
    ) as { searchConfig: Record<string, unknown> };

    expect(result.summary.searchConfig.effectiveTaskType).toBe("definition");
    expect(result.summary.searchConfig.effectiveFinalRerankTopN).toBeGreaterThan(0);
    expect(result.summary.searchConfig.effectiveGraphDepth).toBe(1);
    expect(summaryJson.searchConfig.effectiveTaskType).toBe("definition");
    expect(summaryJson.searchConfig.effectiveFinalRerankTopN).toBeGreaterThan(0);
    expect(summaryJson.searchConfig.effectiveGraphDepth).toBe(1);
  });

  it("passes recipe graph depth through to searchDetailed during eval execution", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed");

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          eval: {
            useQueryTypes: true,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(searchDetailedSpy.mock.calls[0]?.[2]?.taskType).toBe("definition");
    expect(searchDetailedSpy.mock.calls[0]?.[2]?.graphDepth).toBe(1);
    expect(searchDetailedSpy.mock.calls[0]?.[2]?.finalRerankTopN).toBe(20);
  });

  it("supports overriding eval taskType across all queries", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed");

    await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
      taskTypeOverride: "test_debug",
    });

    expect(searchDetailedSpy.mock.calls.every((call) => call[2]?.taskType === "test_debug")).toBe(true);
    searchDetailedSpy.mockRestore();
  });

  it("compares against baseline and writes compare artifact", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(baselineRun.summary, null, 2),
      "utf-8"
    );

    const compareRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      againstPath: "benchmarks/baselines/eval-baseline-summary.json",
      ciMode: false,
      reindex: false,
    });

    expect(compareRun.comparison).toBeDefined();
    expect(readFileSync(path.join(compareRun.outputDir, "compare.json"), "utf-8")).toContain("\"deltas\"");
  });

  it("fails ci gate when thresholds regress beyond tolerance", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          ...baselineRun.summary,
          metrics: {
            ...baselineRun.summary.metrics,
            hitAt5: 0.95,
            mrrAt10: 0.95,
            latencyMs: {
              p50: 1,
              p95: 1,
              p99: 1,
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "default.json"),
      JSON.stringify(
        {
          name: "default",
          baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
          failOnMissingBaseline: true,
          thresholds: {
            hitAt5MaxDrop: 0.01,
            mrrAt10MaxDrop: 0.01,
            p95LatencyMaxMultiplier: 1.01,
            minHitAt5: 1.1,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const run = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      budgetPath: "benchmarks/budgets/default.json",
      reindex: false,
    });

    expect(run.gate?.passed).toBe(false);
    expect((run.gate?.violations.length ?? 0) > 0).toBe(true);
  });

  it("runs parameter sweep and emits aggregate compare report", async () => {
    const sweep = await runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      },
      {
        fusionStrategy: ["rrf", "weighted"],
        hybridWeight: [0.4, 0.6],
        rrfK: [30],
        rerankTopN: [10],
      }
    );

    expect(sweep.aggregate.runCount).toBe(4);
    expect(readFileSync(path.join(sweep.outputDir, "compare.json"), "utf-8")).toContain("\"runCount\"");
  });

  it("uses clearIndex through the product API before a reindexed sweep", async () => {
    const clearIndexSpy = vi.spyOn(Indexer.prototype, "clearIndex");

    const sweep = await runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: true,
      },
      {
        fusionStrategy: ["rrf", "weighted"],
      }
    );

    expect(sweep.aggregate.runCount).toBe(2);
    expect(clearIndexSpy).toHaveBeenCalledTimes(1);
  });

  it("sweeps voyageWeight and taskType as first-class eval parameters", async () => {
    const searchDetailedSpy = vi.spyOn(Indexer.prototype, "searchDetailed").mockImplementation(
      async (_query, _limit, options) => {
        const prefersPrimary = (options?.voyageWeight ?? 0) >= 0.5 || options?.taskType === "definition";
        return {
          primaryResults: [
            prefersPrimary
              ? {
                  filePath: path.join(tempDir, "src", "indexer", "index.ts"),
                  startLine: 1,
                  endLine: 1,
                  content: "export function rankHybridResults() {}",
                  score: 1,
                  chunkType: "function",
                  name: "rankHybridResults",
                }
              : {
                  filePath: path.join(tempDir, "src", "tools", "index.ts"),
                  startLine: 1,
                  endLine: 1,
                  content: "export const codebase_search = () => 'ok';",
                  score: 1,
                  chunkType: "function",
                  name: "codebase_search",
                },
          ],
          expandedContext: [],
          taskType: options?.taskType ?? "general",
          retrieval: {
            voyageLaneConfigured: Boolean(options?.voyageWeight),
            voyageLaneUsed: Boolean(options?.voyageWeight),
          },
          reranker: {
            applied: false,
            backend: null,
          },
        };
      }
    );

    const sweep = await runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      },
      {
        taskType: ["general", "definition"],
        recipeOverrides: {
          voyageWeight: [0.1, 0.9],
        },
      }
    );

    expect(sweep.aggregate.runCount).toBe(4);
    expect(
      new Set(sweep.aggregate.runs.map((run) => run.summary.searchConfig.recipeOverrides?.voyageWeight)).size
    ).toBe(2);
    expect(
      new Set(sweep.aggregate.runs.map((run) => run.summary.searchConfig.taskTypeOverride)).size
    ).toBe(2);
    expect(
      new Set(sweep.aggregate.runs.map((run) => run.summary.metrics.hitAt1)).size
    ).toBeGreaterThan(1);
    searchDetailedSpy.mockRestore();
  });

  it("enables branch filtering only when expected.branch is provided", async () => {
    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q-branch",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                branch: "other-branch",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(/expects branch 'other-branch'/);
  });

  it("handles missing baseline based on failOnMissingBaseline", async () => {
    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "strict.json"),
      JSON.stringify(
        {
          name: "strict",
          baselinePath: "benchmarks/baselines/missing.json",
          failOnMissingBaseline: true,
          thresholds: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: true,
        budgetPath: "benchmarks/budgets/strict.json",
        reindex: false,
      })
    ).rejects.toThrow(/Budget baseline is missing/);

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "lenient.json"),
      JSON.stringify(
        {
          name: "lenient",
          baselinePath: "benchmarks/baselines/missing.json",
          failOnMissingBaseline: false,
          thresholds: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      budgetPath: "benchmarks/budgets/lenient.json",
      reindex: false,
    });

    expect(result.gate?.passed).toBe(true);
  });

  it("bootstraps the bundled eval mock when the configured mock endpoint is offline", async () => {
    const fakeServer = {
      once: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      listen: vi.fn((_: number, __: string, cb?: () => void) => {
        cb?.();
        return fakeServer;
      }),
      close: vi.fn((cb?: (error?: Error) => void) => {
        cb?.();
        return fakeServer;
      }),
    };
    createServerMock.mockReturnValueOnce(fakeServer);
    let fetchCalls = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new TypeError("fetch failed");
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://127.0.0.1:11435/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const clearIndexSpy = vi.spyOn(Indexer.prototype, "clearIndex");

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    expect(result.summary.metrics.hitAt10).toBeGreaterThan(0);
    expect(result.summary.metrics.embedding.callCount).toBeGreaterThan(0);
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(clearIndexSpy).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when a non-mock custom embedding endpoint is unreachable", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://127.0.0.1:9/v1",
            model: "real-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: true,
      })
    ).rejects.toThrow(/Evaluation embedding provider is unreachable/);
    expect(createServerMock).not.toHaveBeenCalled();
  });
});
