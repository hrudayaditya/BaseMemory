import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import type { SearchTaskType } from "../src/indexer/search-recipes.js";
import { SearchReranker, type RerankerCandidate, type SearchRerankerBackend } from "../src/indexer/reranker.js";
import { Database } from "../src/native/index.js";

class FixedScoreBackend implements SearchRerankerBackend {
  readonly name = "fixed-score";

  async rerank(
    _query: string,
    candidates: RerankerCandidate[],
    _taskType: SearchTaskType
  ): Promise<RerankerCandidate[]> {
    return [...candidates]
      .map((candidate) => ({
        ...candidate,
        baseScore: candidate.metadata.filePath.includes("/app/indexer/index.ts") ? 0.97 : 0.23,
      }))
      .sort((left, right) => {
        if (right.baseScore !== left.baseScore) {
          return right.baseScore - left.baseScore;
        }
        return left.id.localeCompare(right.id);
      });
  }
}

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      const texts = Array.isArray(body.input) ? body.input : [];
      const url = String(_url);
      const dimensions = url.includes("api.voyageai.com") || body.model === "voyage-code-2" ? 1536 : 8;

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: dimensions }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-integration-"));

    fs.mkdirSync(path.join(tempDir, "app", "indexer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src", "eval"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "tests", "fixtures", "call-graph"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "benchmarks"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "app", "indexer", "index.ts"),
      `export function rankHybridResults(query: string) { return query.length; }
export function rerankResults(query: string) { return rankHybridResults(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "tests", "fixtures", "call-graph", "same-file-refs.ts"),
      `function entryPoint() { return "where is rankHybridResults implementation fixture rankHybridResults"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "benchmarks", "run.ts"),
      `export function runBenchmarks() { return "rankHybridResults benchmark implementation"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "src", "eval", "runner.ts"),
      `function createRunDirectory() { return "artifacts"; }
function writeJson(_path: string, _value: unknown) {}
function writeText(_path: string, _value: string) {}

export async function withEvalEmbeddingEnvironment<T>(action: () => Promise<T>): Promise<T> {
  return action();
}

export async function finalizeEvaluationRun(): Promise<string> {
  const outputDir = createRunDirectory();
  writeJson("summary.json", {});
  writeJson("per-query.json", {});
  writeJson("compare.json", {});
  writeText("summary.md", "Evaluation Summary");
  return outputDir;
}
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "src", "eval", "cli.ts"),
      `declare function runEvaluation(): Promise<{ outputDir: string }>;

export async function handleEvalCommand(): Promise<void> {
  const result = await runEvaluation();
  console.log("Eval run complete. Artifacts:", result.outputDir);
}
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Retrieval Documentation\n\nThis doc explains rankHybridResults usage.",
      "utf-8"
    );

    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns no results on an empty index without making embedding calls", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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
    });

    const indexer = new Indexer(tempDir, config);
    const fetchCountBefore = fetchSpy.mock.calls.length;

    await expect(indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    })).resolves.toEqual([]);

    expect(fetchSpy.mock.calls.length).toBe(fetchCountBefore);
  });

  it("returns implementation definitions before fixture/benchmark noise for implementation-intent query", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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
    });

    const indexer = new Indexer(tempDir, config);
    const stats = await indexer.index();
    expect(stats.totalFiles).toBeGreaterThan(0);

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain("/app/indexer/index.ts");
    expect(topPaths).not.toContain("/tests/fixtures/call-graph/same-file-refs.ts");
    expect(topPaths).not.toContain("/benchmarks/run.ts");
    expect(results[0]?.chunkKind).toBe("Code");
    expect(results[0]?.symbolKind).toBe("Function");
  });

  it("rewrites definition-search scores through the reranker promoted block and preserves chunk metadata", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const internals = indexer as unknown as { searchReranker: SearchReranker };
    internals.searchReranker = new SearchReranker([]);
    const baseline = await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });

    internals.searchReranker = new SearchReranker([new FixedScoreBackend()]);
    const reranked = await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });

    expect(baseline.reranker.applied).toBe(false);
    expect(reranked.reranker.applied).toBe(true);
    expect(reranked.reranker.backend).toBe("fixed-score");
    expect(reranked.primaryResults[0]?.score).toBe(0.97);
    expect(reranked.primaryResults[0]?.score).not.toBe(baseline.primaryResults[0]?.score);
    expect(reranked.primaryResults[0]?.reranked).toBe(true);
    expect(reranked.primaryResults[0]?.chunkKind).toBe("Code");
  });

  it("prefers documentation paths for doc-intent phrasing with 'where is'", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const results = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("/README.md");
  });

  it("returns implementation definitions with definitionIntent option even for ambiguous queries", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain("/app/indexer/index.ts");
  });

  it("uses different runtime fusion weights for definition and general search", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const loggerSpy = vi.spyOn((indexer as unknown as { logger: { search: (...args: unknown[]) => void } }).logger, "search");

    await indexer.searchDetailed("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });
    await indexer.searchDetailed("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "general",
    });

    const startCalls = loggerSpy.mock.calls.filter((call) => call[1] === "Starting search");
    const definitionPayload = startCalls.find((call) => (call[2] as { taskType?: string }).taskType === "definition")?.[2] as {
      bm25Weight: number;
      denseWeight: number;
      voyageWeight: number;
      finalRerankTopN: number;
    };
    const generalPayload = startCalls.find((call) => (call[2] as { taskType?: string }).taskType === "general")?.[2] as {
      bm25Weight: number;
      denseWeight: number;
      voyageWeight: number;
      finalRerankTopN: number;
    };

    expect(definitionPayload.bm25Weight).toBe(0.5);
    expect(definitionPayload.denseWeight).toBe(0.2);
    expect(definitionPayload.voyageWeight).toBe(0.3);
    expect(definitionPayload.finalRerankTopN).toBe(20);
    expect(generalPayload.bm25Weight).toBe(0.2);
    expect(generalPayload.denseWeight).toBe(0.6);
    expect(generalPayload.voyageWeight).toBe(0.2);
    expect(generalPayload.finalRerankTopN).toBe(10);
  });

  it("redistributes Voyage fusion weight to Arctic when the Voyage query lane is unavailable", async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).includes("api.voyageai.com")) {
        return new Response("temporarily unavailable", { status: 503 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return { embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997) };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const loggerSpy = vi.spyOn((indexer as unknown as { logger: { search: (...args: unknown[]) => void } }).logger, "search");

    await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "general",
    });

    const startPayload = loggerSpy.mock.calls.find(
      (call) => call[1] === "Starting search" && (call[2] as { taskType?: string }).taskType === "general"
    )?.[2] as {
      bm25Weight: number;
      denseWeight: number;
      voyageWeight: number;
      voyageLaneConfigured: boolean;
      voyageLaneAvailable: boolean;
    };

    expect(startPayload.voyageLaneConfigured).toBe(true);
    expect(startPayload.voyageLaneAvailable).toBe(false);
    expect(startPayload.bm25Weight).toBe(0.2);
    expect(startPayload.denseWeight).toBe(0.8);
    expect(startPayload.voyageWeight).toBe(0);
  });

  it("uses the Voyage lane to lift code results for bug-report queries", async () => {
    fs.mkdirSync(path.join(tempDir, "src", "runtime"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "src", "runtime", "abort-controller.ts"),
      `export function runRefinements(options: { abort?: boolean }, values: string[]) {
  for (const value of values) {
    if (!value.startsWith("ok")) {
      if (options.abort) {
        return { success: false, aborted: true };
      }
    }
  }
  return { success: true, aborted: false };
}
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "docs", "abort-behavior.md"),
      `Expected behavior: abort: true should stop after first failing refine.
Actual behavior: continues validating.
steps to reproduce:
1. set abort: true
2. continue validating
3. observe continues validating
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "src", "runtime", "continue-validating.ts"),
      `export function continueValidating() {
  return "Expected behavior abort: true should stop after first failing refine but actual behavior continues validating";
}
`,
      "utf-8"
    );

    fetchSpy.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      const texts = Array.isArray(body.input) ? body.input : [];
      const requestUrl = String(url);
      const isVoyage = requestUrl.includes("api.voyageai.com") || body.model === "voyage-code-2";
      const dimensions = isVoyage ? 1536 : 8;

      const data = texts.map((text) => {
        const lower = String(text).toLowerCase();
        const bugQuery = lower.includes("expected behavior") || lower.includes("actual behavior");
        const abortImplementation = lower.includes("if (options.abort)") || lower.includes("aborted: true");
        const misleadingImplementation = lower.includes("continuevalidating()");
        const abortDocs = lower.includes("steps to reproduce");
        let embedding: number[];

        if (isVoyage) {
          embedding = Array.from({ length: dimensions }, (_, idx) => {
            if (idx === 0) return bugQuery || abortImplementation ? 1 : 0;
            if (idx === 1) return misleadingImplementation || abortDocs ? 1 : 0;
            return 0;
          });
        } else {
          embedding = Array.from({ length: dimensions }, (_, idx) => {
            if (idx === 0) return bugQuery || misleadingImplementation ? 1 : 0;
            if (idx === 1) return abortImplementation ? 1 : 0;
            return 0;
          });
        }

        return { embedding };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const voyageDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-voyage-"));
    const arcticOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-arctic-"));
    fs.cpSync(tempDir, voyageDir, { recursive: true });
    fs.cpSync(tempDir, arcticOnlyDir, { recursive: true });

    try {
      const configWithVoyage = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-embedding-model",
          dimensions: 8,
        },
        voyageApiKey: "voyage-test-key",
        voyageModelId: "voyage-code-2",
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
      });
      const configWithoutVoyage = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
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
      });

      const voyageIndexer = new Indexer(voyageDir, configWithVoyage);
      await voyageIndexer.index();
      const voyageResult = await voyageIndexer.searchDetailed(
        "Expected behavior: abort: true should stop after first failing refine. Actual behavior: continues validating.",
        5,
        {
          metadataOnly: true,
          filterByBranch: false,
          taskType: "semantic",
          bm25Weight: 0.01,
          denseWeight: 0.01,
          voyageWeight: 0.98,
          finalRerankTopN: 0,
        }
      );

      const arcticOnlyIndexer = new Indexer(arcticOnlyDir, configWithoutVoyage);
      await arcticOnlyIndexer.index();
      const arcticOnlyResult = await arcticOnlyIndexer.searchDetailed(
        "Expected behavior: abort: true should stop after first failing refine. Actual behavior: continues validating.",
        5,
        {
          metadataOnly: true,
          filterByBranch: false,
          taskType: "semantic",
          bm25Weight: 0.01,
          denseWeight: 0.01,
          voyageWeight: 0.98,
          finalRerankTopN: 0,
        }
      );

      const voyageTarget = voyageResult.primaryResults.find((result) =>
        result.filePath.includes("/src/runtime/abort-controller.ts")
      );
      const arcticTarget = arcticOnlyResult.primaryResults.find((result) =>
        result.filePath.includes("/src/runtime/abort-controller.ts")
      );

      expect(voyageResult.taskType).toBe("semantic");
      expect(voyageResult.primaryResults[0]?.filePath).toContain("/src/runtime/abort-controller.ts");
      expect(voyageTarget).toBeDefined();
      expect(arcticTarget).toBeDefined();
      expect((voyageTarget?.score ?? 0)).toBeGreaterThan(arcticTarget?.score ?? 0);
    } finally {
      fs.rmSync(voyageDir, { recursive: true, force: true });
      fs.rmSync(arcticOnlyDir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully when the Voyage query lane is unavailable", async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).includes("api.voyageai.com")) {
        return new Response("temporarily unavailable", { status: 503 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return { embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997) };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    await expect(indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    })).resolves.toMatchObject({
      primaryResults: expect.arrayContaining([
        expect.objectContaining({
          filePath: expect.stringContaining("/app/indexer/index.ts"),
        }),
      ]),
      taskType: "definition",
    });
  });

  it("forces definition lanes for doc-leaning queries when definitionIntent is true", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const withoutOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(withoutOverride[0]?.filePath).toContain("/README.md");

    const withOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(withOverride.length).toBeGreaterThan(0);
    expect(withOverride[0]?.filePath).toContain("/app/indexer/index.ts");
    expect(withOverride[0]?.filePath).not.toContain("/README.md");
  });

  it("applies branch filtering before retrieval and never falls back to unfiltered results", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const mainChunkIds = database.getBranchChunkIds("main");
    expect(mainChunkIds.length).toBeGreaterThan(0);

    database.clearBranch("main");
    database.addChunksToBranch("feature/test", mainChunkIds);

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });

    expect(results).toEqual([]);
  });

  it("keeps branch filtering active on a real branch named default", async () => {
    execFileSync("git", ["branch", "-m", "default"], { cwd: tempDir, stdio: "ignore" });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const defaultChunkIds = database.getBranchChunkIds("default");
    expect(defaultChunkIds.length).toBeGreaterThan(0);

    database.clearBranch("default");
    database.addChunksToBranch("feature/test", defaultChunkIds);

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });

    expect(results).toEqual([]);
  });

  it("returns an empty result for an empty query without error", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const results = await indexer.search("   ", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results).toEqual([]);
  });

  it("uses the named retrieval candidate limit for filtered hybrid search", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const internals = indexer as unknown as {
      ensureInitialized: () => Promise<{
        store: { searchFiltered: (...args: unknown[]) => unknown };
        invertedIndex: { searchFiltered: (...args: unknown[]) => unknown };
      }>;
    };
    const { store, invertedIndex } = await internals.ensureInitialized();

    const vectorSpy = vi.spyOn(store, "searchFiltered");
    const keywordSpy = vi.spyOn(invertedIndex, "searchFiltered");

    await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      fileType: "ts",
    });

    expect(vectorSpy).toHaveBeenCalled();
    expect(keywordSpy).toHaveBeenCalled();
    expect(vectorSpy.mock.calls[0]?.[2]).toBe(50);
    expect(keywordSpy.mock.calls[0]?.[2]).toBe(50);
  });

  it("returns identical primary results for explicit general task type", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const baseline = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    const detailed = await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "general",
    });

    expect(detailed.primaryResults).toEqual(baseline);
    expect(detailed.expandedContext).toEqual([]);
  });

  it("uses indexed chunk text for snippets and reranker content after files change on disk", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    fs.writeFileSync(
      path.join(tempDir, "app", "indexer", "index.ts"),
      `export function rankHybridResults(query: string) { return query.toUpperCase(); }
export function rerankResults(query: string) { return rankHybridResults(query) + "!"; }
export function searchEntry(query: string) { return rerankResults(query) + "!"; }
`,
      "utf-8"
    );

    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const indexedFilePath = fs.realpathSync(path.join(tempDir, "app", "indexer", "index.ts"));
    const chunkRows = database.getChunksByFile(indexedFilePath);
    const rankHybridChunk = chunkRows.find((chunk) => chunk.name === "rankHybridResults");
    const rerankChunk = chunkRows.find((chunk) => chunk.name === "rerankResults");

    expect(rankHybridChunk).toBeDefined();
    expect(rerankChunk).toBeDefined();

    const toCandidate = (chunk: NonNullable<typeof rankHybridChunk>, score: number) => ({
      id: chunk.chunkId,
      score,
      metadata: {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkType: (chunk.nodeType ?? "other") as any,
        language: chunk.language,
        hash: chunk.embeddingInputHash,
        name: chunk.name ?? undefined,
      },
      chunkKind: chunk.chunkKind ?? undefined,
      symbolKind: chunk.symbolKind ?? undefined,
    });

    const internals = indexer as unknown as {
      batchFetchStoredChunkTexts: (contentHashes: string[]) => Promise<Map<string, string>>;
      buildRerankerCandidates: (
        candidates: Array<ReturnType<typeof toCandidate>>,
        fileContentCache: Map<string, string | null>,
        storedChunkTexts: Map<string, string>
      ) => Promise<RerankerCandidate[]>;
      materializeRankedResults: (
        candidates: Array<ReturnType<typeof toCandidate>>,
        options: { metadataOnly: boolean; contextLines: number },
        fileContentCache: Map<string, string | null>,
        storedChunkTexts: Map<string, string>
      ) => Promise<Array<{ content: string; name?: string }>>;
    };

    const candidates = [toCandidate(rankHybridChunk!, 0.8), toCandidate(rerankChunk!, 0.7)];
    const storedChunkTexts = await internals.batchFetchStoredChunkTexts(
      candidates.map((candidate) => candidate.metadata.hash)
    );
    const rerankerCandidates = await internals.buildRerankerCandidates(
      candidates,
      new Map(),
      storedChunkTexts
    );
    const [materialized] = await internals.materializeRankedResults(
      [candidates[0]],
      { metadataOnly: false, contextLines: 0 },
      new Map(),
      storedChunkTexts
    );

    expect(materialized?.content).toContain("return query.length;");
    expect(materialized?.content).not.toContain("return query.toUpperCase();");

    const rerankerCandidate = rerankerCandidates.find(
      (candidate) => candidate.metadata.name === "rankHybridResults"
    );
    expect(rerankerCandidate).toBeDefined();
    expect(rerankerCandidate?.content).toContain("return query.length;");
    expect(rerankerCandidate?.content).not.toContain("return query.toUpperCase();");
  });

  it("returns caller/callee graph expansion separately from primary results", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
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
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const filePath = path.join(tempDir, "app", "indexer", "index.ts");

    database.upsertSymbolsBatch([
      {
        id: "sym-rankHybridResults",
        filePath,
        name: "rankHybridResults",
        kind: "Function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 63,
        language: "typescript",
      },
      {
        id: "sym-rerankResults",
        filePath,
        name: "rerankResults",
        kind: "Function",
        startLine: 2,
        startCol: 0,
        endLine: 2,
        endCol: 74,
        language: "typescript",
      },
      {
        id: "sym-searchEntry",
        filePath,
        name: "searchEntry",
        kind: "Function",
        startLine: 3,
        startCol: 0,
        endLine: 3,
        endCol: 65,
        language: "typescript",
      },
    ]);
    database.addSymbolsToBranchBatch("main", [
      "sym-rankHybridResults",
      "sym-rerankResults",
      "sym-searchEntry",
    ]);
    database.upsertCallEdgesBatch([
      {
        id: "edge-rerank-rank",
        branch: "main",
        fromSymbolId: "sym-rerankResults",
        fromSymbolName: "rerankResults",
        fromSymbolFilePath: filePath,
        callerFilePath: filePath,
        targetName: "rankHybridResults",
        targetFilePath: filePath,
        targetKind: "Function",
        toSymbolId: "sym-rankHybridResults",
        callType: "Call",
        line: 2,
        col: 47,
        isResolved: true,
      },
      {
        id: "edge-entry-rerank",
        branch: "main",
        fromSymbolId: "sym-searchEntry",
        fromSymbolName: "searchEntry",
        fromSymbolFilePath: filePath,
        callerFilePath: filePath,
        targetName: "rerankResults",
        targetFilePath: filePath,
        targetKind: "Function",
        toSymbolId: "sym-rerankResults",
        callType: "Call",
        line: 3,
        col: 43,
        isResolved: true,
      },
    ]);
    expect(database.getSymbolByName("rerankResults", filePath)).not.toBeNull();
    expect(database.getCallersWithContext("rerankResults", "main").length).toBeGreaterThanOrEqual(1);
    expect(database.getCallees("sym-rerankResults", "main")).toHaveLength(1);

    const response = await indexer.searchDetailed("where is rerankResults implementation", 1, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });

    expect(response.primaryResults[0]?.name).toBe("rerankResults");
    expect(response.expandedContext.length).toBeGreaterThan(0);
    const expandedNames = response.expandedContext.map((entry) => entry.name);
    expect(expandedNames).toContain("rankHybridResults");
    expect(expandedNames).toContain("searchEntry");
    expect(new Set(response.expandedContext.map((entry) => entry.relation))).toEqual(new Set(["caller", "callee"]));
    expect(response.expandedContext.every((entry) => entry.chunkKind === "Code")).toBe(true);
  });
});
