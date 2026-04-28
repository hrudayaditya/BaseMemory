import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer, matchesHardRetrievalFilters } from "../src/indexer/index.js";
import type { SearchTaskType } from "../src/indexer/search-recipes.js";
import {
  HeuristicLocalRerankerBackend,
  SearchReranker,
  TransformersCrossEncoderBackend,
  type RerankerCandidate,
  type SearchRerankerBackend,
} from "../src/indexer/reranker.js";
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

function getPrimaryStore(indexer: Indexer): {
  getAllMetadata: () => Array<{ key: string; metadata: { filePath: string; chunkType: string } }>;
} {
  const internals = indexer as unknown as {
    stores: Map<string, {
      getAllMetadata: () => Array<{ key: string; metadata: { filePath: string; chunkType: string } }>;
    }>;
    primaryStoreModelId?: string | null;
    configuredProviderInfo: { modelInfo: { model: string } };
  };
  const modelId = internals.primaryStoreModelId ?? internals.configuredProviderInfo.modelInfo.model;
  const store = internals.stores.get(modelId);
  if (!store) {
    throw new Error(`Missing primary store for model ${modelId}`);
  }
  return store;
}

function getQueryEmbeddingFailureState(indexer: Indexer): Map<string, { until: number; reason: string }> {
  return (indexer as unknown as {
    queryEmbeddingFailureState: Map<string, { until: number; reason: string }>;
  }).queryEmbeddingFailureState;
}

function getSecondaryProvider(indexer: Indexer): {
  getModelInfo(): { model: string };
  embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number } | null>;
} | null {
  return (indexer as unknown as {
    voyageProvider: {
      getModelInfo(): { model: string };
      embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number } | null>;
    } | null;
  }).voyageProvider;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number = 5_000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function createSearchTestConfig(rerankTopN: number = 20) {
    return parseConfig({
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
        rerankTopN,
      },
    });
  }

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

  it("falls back to BM25-only search while background embedding is still running", async () => {
    const releaseEmbedding = Promise.withResolvers<void>();
    fetchSpy.mockImplementation(async (_url, init) => {
      await releaseEmbedding.promise;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
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
    const foreground = await indexer.indexForeground();
    const statusDuring = await indexer.getStatus();
    const storeDuring = getPrimaryStore(indexer);

    expect(foreground.embeddingStatus).toBe("pending");
    expect(statusDuring.indexed).toBe(true);
    expect(statusDuring.vectorCount).toBe(0);
    expect(storeDuring.getAllMetadata()).toHaveLength(0);

    const results = await indexer.search("rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.filePath).toContain("/app/indexer/index.ts");

    releaseEmbedding.resolve();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning());

    const statusAfter = await indexer.getStatus();
    expect(statusAfter.embedding?.status).toBe("complete");
    expect(statusAfter.vectorCount).toBeGreaterThan(0);
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

  it("stores MCP registration chunks as config and keeps implementation-intent ranking on the real tool definition", async () => {
    fs.mkdirSync(path.join(tempDir, "src", "tools"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "src", "tools", "index.ts"),
      fs.readFileSync(path.join(process.cwd(), "src", "tools", "index.ts"), "utf-8"),
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "src", "mcp-server.ts"),
      fs.readFileSync(path.join(process.cwd(), "src", "mcp-server.ts"), "utf-8"),
      "utf-8"
    );

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

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const chunkRows = execFileSync(
      "sqlite3",
      [
        `file:${dbPath}?mode=ro`,
        "select chunk_kind, start_line, end_line, node_type from chunks where file_path like '%/src/mcp-server.ts' order by start_line;",
      ],
      { encoding: "utf-8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const parsedChunkRows = chunkRows.map((row) => {
      const [chunkKind, startLine, endLine, nodeType] = row.split("|");
      return {
        chunkKind,
        startLine: Number(startLine),
        endLine: Number(endLine),
        nodeType,
      };
    });
    const mcpServerSource = fs.readFileSync(path.join(tempDir, "src", "mcp-server.ts"), "utf8");
    const registrationLines = mcpServerSource
      .split("\n")
      .flatMap((line, index) => line.includes("server.tool(") || line.includes("server.prompt(") ? [index + 1] : []);
    const overlappingRegistrationChunks = parsedChunkRows.filter((row) =>
      registrationLines.some((line) => row.startLine <= line && row.endLine >= line)
    );

    expect(overlappingRegistrationChunks.length).toBeGreaterThan(0);
    expect(overlappingRegistrationChunks.every((row) => row.chunkKind === "Config")).toBe(true);
    expect(parsedChunkRows).toContainEqual({
      chunkKind: "Config",
      startLine: 752,
      endLine: 809,
      nodeType: "other",
    });

    const codebaseSearchResponse = await indexer.searchDetailed("find exported ToolDefinition for codebase_search", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
      graphDepth: 1,
    });

    expect(codebaseSearchResponse.primaryResults[0]?.filePath).toContain("/src/tools/index.ts");
    expect(codebaseSearchResponse.primaryResults[0]?.name).toBe("codebase_search");
    expect(codebaseSearchResponse.primaryResults[0]?.filePath).not.toContain("/src/mcp-server.ts");

    const implementationLookupResponse = await indexer.searchDetailed("find exported ToolDefinition for implementation_lookup", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
      graphDepth: 1,
    });

    expect(implementationLookupResponse.primaryResults[0]?.filePath).toContain("/src/tools/index.ts");
    expect(implementationLookupResponse.primaryResults[0]?.name).toBe("implementation_lookup");
    expect(implementationLookupResponse.primaryResults[0]?.filePath).not.toContain("/src/mcp-server.ts");
  });

  it("preserves retrieval correctness across clearIndex and rebuild", async () => {
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

    const before = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(before[0]?.filePath).toContain("/app/indexer/index.ts");

    await indexer.clearIndex();

    const afterClear = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(afterClear).toEqual([]);

    await indexer.index();

    const afterRebuild = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(afterRebuild[0]?.filePath).toContain("/app/indexer/index.ts");
    expect(afterRebuild[0]?.name).toBe("rankHybridResults");
  });

  it("indexes a coarse file/module chunk for small constant files and retrieves them in the top results", async () => {
    fs.mkdirSync(path.join(tempDir, "src", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "config", "provider.ts"),
      `export const ARCTIC_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export const VOYAGE_DEFAULT_MODEL_ID = "voyage-code-2";
`,
      "utf-8"
    );

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

    const indexedFilePath = fs.realpathSync(path.join(tempDir, "src", "config", "provider.ts"));
    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const chunkRows = database.getChunksByFile(indexedFilePath);
    expect(
      chunkRows.some(
        (chunk) =>
          chunk.chunkKind === "File" &&
          chunk.symbolKind === "Module" &&
          chunk.name === "provider"
      )
    ).toBe(true);

    const results = await indexer.search("arctic query prefix", 3, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.slice(0, 3).some((result) => result.filePath === indexedFilePath)).toBe(true);
    expect(results.slice(0, 3).some((result) => result.name === "ARCTIC_QUERY_PREFIX")).toBe(true);
  });

  it("re-emits coarse file/module chunks when a small constant file changes and is reindexed", async () => {
    fs.mkdirSync(path.join(tempDir, "src", "config"), { recursive: true });
    const filePath = path.join(tempDir, "src", "config", "provider.ts");
    fs.writeFileSync(
      filePath,
      `export const ARCTIC_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export const VOYAGE_DEFAULT_MODEL_ID = "voyage-code-2";
`,
      "utf-8"
    );

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

    const indexedFilePath = fs.realpathSync(filePath);
    const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
    const initialModuleChunk = database
      .getChunksByFile(indexedFilePath)
      .find(
        (chunk) =>
          chunk.chunkKind === "File" &&
          chunk.symbolKind === "Module" &&
          chunk.name === "provider"
      );
    expect(initialModuleChunk).toBeDefined();

    fs.writeFileSync(
      filePath,
      `export const OCEAN_QUERY_PREFIX = "Represent this sentence for searching ocean passages: ";
export const VOYAGE_DEFAULT_MODEL_ID = "voyage-code-2";
`,
      "utf-8"
    );

    await indexer.index();

    const updatedModuleChunk = database
      .getChunksByFile(indexedFilePath)
      .find(
        (chunk) =>
          chunk.chunkKind === "File" &&
          chunk.symbolKind === "Module" &&
          chunk.name === "provider"
      );
    expect(updatedModuleChunk).toBeDefined();
    expect(updatedModuleChunk?.chunkId).not.toBe(initialModuleChunk?.chunkId);
    expect(updatedModuleChunk?.embeddingInputHash).not.toBe(initialModuleChunk?.embeddingInputHash);

    const results = await indexer.search("ocean query prefix", 3, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(results.slice(0, 3).some((result) => result.filePath === indexedFilePath)).toBe(true);
    expect(results.slice(0, 3).some((result) => result.name === "OCEAN_QUERY_PREFIX")).toBe(true);
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
      includeScoreBreakdown: true,
    });

    expect(baseline.reranker.applied).toBe(false);
    expect(reranked.reranker.applied).toBe(true);
    expect(reranked.reranker.backend).toBe("fixed-score");
    expect(reranked.primaryResults[0]?.score).toBe(0.97);
    expect(reranked.primaryResults[0]?.score).not.toBe(baseline.primaryResults[0]?.score);
    expect(reranked.primaryResults[0]?.reranked).toBe(true);
    expect(reranked.primaryResults[0]?.chunkKind).toBe("Code");
    expect(reranked.primaryResults[0]?.scoreBreakdown?.reranker).toEqual(expect.objectContaining({
      score: 0.97,
      rank: 1,
      backend: "fixed-score",
    }));
  });

  it("persists healthy reranker status after a successful cross-encoder load", async () => {
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
      searchReranker: SearchReranker;
      recordRerankerHealth: (event: {
        backend: "jina-api" | "transformers-cross-encoder" | "heuristic-local" | "none";
        status: "healthy" | "failed" | "never-loaded";
        model?: string | null;
        error?: string | null;
      }) => void;
    };
    const reportHealth = (event: {
      backend: "jina-api" | "transformers-cross-encoder" | "heuristic-local" | "none";
      status: "healthy" | "failed" | "never-loaded";
      model?: string | null;
      error?: string | null;
    }) => internals.recordRerankerHealth(event);
    internals.searchReranker = new SearchReranker([
      new TransformersCrossEncoderBackend(
        async () => ({
          model: "Xenova/ms-marco-MiniLM-L-6-v2",
          scorer: async (pairs) => pairs.map((_pair, index) => 10 - index),
          error: null,
        }),
        reportHealth
      ),
      new HeuristicLocalRerankerBackend(),
    ], reportHealth);

    await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    expect(database.getRerankerHealth()).toMatchObject({
      backend: "transformers-cross-encoder",
      status: "healthy",
      model: "Xenova/ms-marco-MiniLM-L-6-v2",
    });
  });

  it("updates persisted reranker health when falling back after backend failure", async () => {
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
      searchReranker: SearchReranker;
      recordRerankerHealth: (event: {
        backend: "jina-api" | "transformers-cross-encoder" | "heuristic-local" | "none";
        status: "healthy" | "failed" | "never-loaded";
        model?: string | null;
        error?: string | null;
      }) => void;
    };
    const reportHealth = (event: {
      backend: "jina-api" | "transformers-cross-encoder" | "heuristic-local" | "none";
      status: "healthy" | "failed" | "never-loaded";
      model?: string | null;
      error?: string | null;
    }) => internals.recordRerankerHealth(event);
    internals.searchReranker = new SearchReranker([
      new TransformersCrossEncoderBackend(
        async () => ({
          model: "Xenova/ms-marco-MiniLM-L-6-v2",
          scorer: async () => {
            throw new Error("cross encoder exploded");
          },
          error: null,
        }),
        reportHealth
      ),
      new HeuristicLocalRerankerBackend(),
    ], reportHealth);

    const response = await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
    });

    expect(response.reranker.backend).toBe("heuristic-local");
    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    expect(database.getRerankerHealth()).toMatchObject({
      backend: "heuristic-local",
      status: "failed",
      model: "Xenova/ms-marco-MiniLM-L-6-v2",
      error: "cross encoder exploded",
    });
  });

  it("emits a startup warning in normal mode when persisted reranker health is degraded", async () => {
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
      debug: {
        enabled: false,
      },
    });

    const indexDir = path.join(tempDir, ".opencode", "index");
    fs.mkdirSync(indexDir, { recursive: true });
    const database = new Database(path.join(indexDir, "codebase.db"));
    database.upsertRerankerHealth(
      "heuristic-local",
      "failed",
      "Xenova/ms-marco-MiniLM-L-6-v2",
      "startup boom"
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const indexer = new Indexer(tempDir, config);

    await indexer.getStatus();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[reranker:warn] Search reranker is degraded.")
    );
    warnSpy.mockRestore();
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

  it("excludes .d.ts chunks from the deterministic floor for definition queries", async () => {
    fs.mkdirSync(path.join(tempDir, "lib", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "lib", "core", "Foo.js"),
      `export class Foo {
  run(value) {
    return value;
  }
}
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "index.d.ts"),
      `/** Foo implementation implementation implementation */
export declare class Foo {
  run(value: string): string;
}
`,
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createSearchTestConfig(0));
    await indexer.index();

    const response = await indexer.searchDetailed("where is Foo implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
      taskType: "definition",
      graphDepth: 0,
    });

    const dtsResult = response.primaryResults.find((entry) => entry.filePath.endsWith("index.d.ts"));
    const jsResult = response.primaryResults.find((entry) => entry.filePath.endsWith(path.join("lib", "core", "Foo.js")));

    expect(dtsResult).toBeDefined();
    expect(jsResult).toBeDefined();
    expect(dtsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(false);
    expect(jsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(true);
  });

  it("allows .d.ts chunks in the deterministic floor for bug queries", async () => {
    fs.mkdirSync(path.join(tempDir, "lib", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "lib", "core", "Foo.js"),
      `export class Foo {
  run(value) {
    return value;
  }
}
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "index.d.ts"),
      `/** Foo bug implementation implementation implementation */
export declare class Foo {
  run(value: string): string;
}
`,
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createSearchTestConfig(0));
    await indexer.index();

    const response = await indexer.searchDetailed("why does Foo fail", 10, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
      taskType: "bug",
      graphDepth: 0,
    });

    const dtsResult = response.primaryResults.find((entry) => entry.filePath.endsWith("index.d.ts"));
    const jsResult = response.primaryResults.find((entry) => entry.filePath.endsWith(path.join("lib", "core", "Foo.js")));

    expect(dtsResult).toBeDefined();
    expect(jsResult).toBeDefined();
    expect(dtsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(true);
  });

  it("allows .d.ts chunks in the deterministic floor when graph direction is set", async () => {
    fs.mkdirSync(path.join(tempDir, "lib", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "lib", "core", "Foo.js"),
      `export class Foo {
  run(value) {
    return value;
  }
}
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "index.d.ts"),
      `/** Foo implementation implementation implementation */
export declare class Foo {
  run(value: string): string;
}
`,
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createSearchTestConfig(0));
    await indexer.index();

    const response = await indexer.searchDetailed("where is Foo implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
      taskType: "definition",
      graphDirection: "caller",
      graphDepth: 0,
    });

    const dtsResult = response.primaryResults.find((entry) => entry.filePath.endsWith("index.d.ts"));
    expect(dtsResult).toBeDefined();
    expect(dtsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(true);
  });

  it("keeps js implementation deterministic floor behavior unchanged for definition queries", async () => {
    fs.mkdirSync(path.join(tempDir, "lib", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "lib", "core", "Foo.js"),
      `export class Foo {
  run(value) {
    return value;
  }
}
`,
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createSearchTestConfig(0));
    await indexer.index();

    const response = await indexer.searchDetailed("where is Foo implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
      taskType: "definition",
      graphDepth: 0,
    });

    const jsResult = response.primaryResults.find((entry) => entry.filePath.endsWith(path.join("lib", "core", "Foo.js")));
    expect(jsResult).toBeDefined();
    expect(jsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(true);
  });

  it("keeps non-.d.ts typescript files eligible for the deterministic floor in definition queries", async () => {
    fs.mkdirSync(path.join(tempDir, "lib", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "lib", "core", "Foo.ts"),
      `export class Foo {
  run(value: string) {
    return value;
  }
}
`,
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createSearchTestConfig(0));
    await indexer.index();

    const response = await indexer.searchDetailed("where is Foo implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
      taskType: "definition",
      graphDepth: 0,
    });

    const tsResult = response.primaryResults.find((entry) => entry.filePath.endsWith(path.join("lib", "core", "Foo.ts")));
    expect(tsResult).toBeDefined();
    expect(tsResult?.scoreBreakdown?.stages.some((stage) => stage.reason.includes("deterministicIdentifierLane:"))).toBe(true);
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
    const mainSymbolIds = database.getBranchSymbolIds("main");

    database.clearBranch("main");
    database.addChunksToBranch("feature/test", mainChunkIds);
    database.clearBranchSymbols("main");
    database.addSymbolsToBranchBatch("feature/test", mainSymbolIds);
    (indexer as unknown as { syncNativeBranchMembership: (branch: string, chunkIds: string[]) => void })
      .syncNativeBranchMembership("main", database.getBranchChunkIds("main"));
    (indexer as unknown as { syncNativeBranchMembership: (branch: string, chunkIds: string[]) => void })
      .syncNativeBranchMembership("feature/test", database.getBranchChunkIds("feature/test"));

    const internals = indexer as unknown as {
      stores: Map<string, { searchOnBranch: (queryVector: number[], branch: string, limit?: number) => unknown[] }>;
      invertedIndex: { searchOnBranch: (query: string, branch: string, limit?: number) => Map<string, number> };
    };
    const primaryStore = internals.stores.get("mock-embedding-model");
    expect(primaryStore).toBeTruthy();
    expect(primaryStore!.searchOnBranch(Array(8).fill(0), "main", 5)).toEqual([]);
    expect(Array.from(internals.invertedIndex.searchOnBranch("rankHybridResults", "main", 5).keys())).toEqual([]);
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
    const defaultSymbolIds = database.getBranchSymbolIds("default");

    database.clearBranch("default");
    database.addChunksToBranch("feature/test", defaultChunkIds);
    database.clearBranchSymbols("default");
    database.addSymbolsToBranchBatch("feature/test", defaultSymbolIds);
    (indexer as unknown as { syncNativeBranchMembership: (branch: string, chunkIds: string[]) => void })
      .syncNativeBranchMembership("default", database.getBranchChunkIds("default"));
    (indexer as unknown as { syncNativeBranchMembership: (branch: string, chunkIds: string[]) => void })
      .syncNativeBranchMembership("feature/test", database.getBranchChunkIds("feature/test"));

    const internals = indexer as unknown as {
      stores: Map<string, { searchOnBranch: (queryVector: number[], branch: string, limit?: number) => unknown[] }>;
      invertedIndex: { searchOnBranch: (query: string, branch: string, limit?: number) => Map<string, number> };
    };
    const primaryStore = internals.stores.get("mock-embedding-model");
    expect(primaryStore).toBeTruthy();
    expect(primaryStore!.searchOnBranch(Array(8).fill(0), "default", 5)).toEqual([]);
    expect(Array.from(internals.invertedIndex.searchOnBranch("rankHybridResults", "default", 5).keys())).toEqual([]);
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
        store: { search: (...args: unknown[]) => unknown };
        invertedIndex: { search: (...args: unknown[]) => unknown };
      }>;
    };
    const { store, invertedIndex } = await internals.ensureInitialized();

    const vectorSpy = vi.spyOn(store, "search");
    const keywordSpy = vi.spyOn(invertedIndex, "search");

    await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      fileType: "ts",
    });

    expect(vectorSpy).toHaveBeenCalled();
    expect(keywordSpy).toHaveBeenCalled();
    expect(vectorSpy.mock.calls[0]?.[1]).toBe(250);
    expect(keywordSpy.mock.calls[0]?.[1]).toBe(250);
  });

  it("matches the old metadata-scan filter semantics with the SQLite-backed branch query", async () => {
    fs.mkdirSync(path.join(tempDir, "src", "services"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src", "models"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "services", "auth.ts"),
      `export function authenticateUser(): boolean { return true; }\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "src", "services", "auth.py"),
      `def authenticate_user() -> bool:\n    return True\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "src", "models", "user.ts"),
      `export class UserModel {\n  name = "Ada";\n}\n`,
      "utf-8"
    );

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

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const store = getPrimaryStore(indexer);
    const authTsPath = fs.realpathSync(path.join(tempDir, "src", "services", "auth.ts"));

    const cases = [
      { fileType: "ts" },
      { directory: "src/services" },
      { chunkType: "function" },
      { excludeFile: authTsPath },
      {
        fileType: "ts",
        directory: "src/services",
        chunkType: "function",
      },
      {
        fileType: "ts",
        directory: "src/services",
        chunkType: "function",
        excludeFile: authTsPath,
      },
    ];

    for (const filters of cases) {
      const oldPath = new Set(
        store
          .getAllMetadata()
          .filter(({ metadata }) => matchesHardRetrievalFilters(metadata, filters))
          .map(({ key }) => key)
      );
      const newPath = new Set(
        await database.getChunkIdsByFiltersForBranch(
          status.currentBranch,
          filters.fileType ?? null,
          filters.directory ?? null,
          filters.chunkType ?? null,
          filters.excludeFile ?? null
        )
      );

      expect(Array.from(newPath).sort()).toEqual(Array.from(oldPath).sort());
    }
  });

  it("returns null and skips the DB fast path when no hard filters are active", async () => {
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
    });

    const indexer = new Indexer(tempDir, config);
    const internals = indexer as unknown as {
      currentBranch: string;
      ensureInitialized: () => Promise<{ database: Database }>;
      buildAllowedChunkIds: (
        database: Database,
        branch: string,
        options: Record<string, never>
      ) => Promise<Set<string> | null>;
    };
    const { database } = await internals.ensureInitialized();
    const dbSpy = vi.spyOn(database, "getChunkIdsByFiltersForBranch");

    await expect(
      internals.buildAllowedChunkIds(database, internals.currentBranch, {})
    ).resolves.toBeNull();
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("does not call the DB hard-filter path for searches without metadata filters", async () => {
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
      ensureInitialized: () => Promise<{ database: Database }>;
    };
    const { database } = await internals.ensureInitialized();
    const dbSpy = vi.spyOn(database, "getChunkIdsByFiltersForBranch");

    const response = await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(dbSpy).not.toHaveBeenCalled();
    expect(response.timings?.prefilterMs ?? 0).toBeLessThan(1);
  });

  it("returns an empty Set rather than null when active filters match no chunks", async () => {
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
      currentBranch: string;
      ensureInitialized: () => Promise<{ database: Database }>;
      buildAllowedChunkIds: (
        database: Database,
        branch: string,
        options: { fileType?: string }
      ) => Promise<Set<string> | null>;
    };
    const { database } = await internals.ensureInitialized();

    const result = await internals.buildAllowedChunkIds(database, internals.currentBranch, {
      fileType: "rs",
    });

    expect(result).toBeInstanceOf(Set);
    expect(result?.size).toBe(0);
  });

  it("does not call getAllMetadata on the hot path when metadata filters are active", async () => {
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

    const store = getPrimaryStore(indexer);
    const metadataSpy = vi.spyOn(store, "getAllMetadata");

    await indexer.searchDetailed("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      fileType: "ts",
    });

    expect(metadataSpy).not.toHaveBeenCalled();
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

  it("keeps the seed result and resolves same-file unresolved graph edges into expanded context", async () => {
    fs.writeFileSync(
      path.join(tempDir, "app", "indexer", "partial.ts"),
      `export function partialLeafExact(query: string) { return query.length; }
export function partialMidExact(query: string) { return partialLeafExact(query); }
export function partialEntryExact(query: string) { return partialMidExact(query); }
`,
      "utf-8"
    );

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
    const filePath = fs.realpathSync(path.join(tempDir, "app", "indexer", "partial.ts"));
    const targetSymbol = database.getSymbolByName("partialMidExact", filePath);
    expect(targetSymbol).not.toBeNull();

    database.unresolveCallEdgesByTargetSymbolForBranch(targetSymbol!.id, "main");

    const response = await indexer.searchDetailed("where is partialMidExact implementation", 1, {
      metadataOnly: true,
      filterByBranch: false,
      taskType: "definition",
      graphDepth: 1,
    });

    expect(response.primaryResults[0]?.name).toBe("partialMidExact");
    const expandedNames = response.expandedContext.map((entry) => entry.name);
    expect(expandedNames).toContain("partialLeafExact");
    expect(expandedNames).toContain("partialEntryExact");
  });

  it("uses branch-native search APIs instead of marshaling branch chunk allowlists per query", async () => {
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

    const primaryStore = (indexer as unknown as {
      stores: Map<string, { searchFiltered: (...args: unknown[]) => unknown; searchOnBranch: (...args: unknown[]) => unknown }>;
      invertedIndex: { searchFiltered: (...args: unknown[]) => unknown; searchOnBranch: (...args: unknown[]) => unknown };
    }).stores.get("mock-embedding-model");
    expect(primaryStore).toBeTruthy();

    const denseFilteredSpy = vi.spyOn(primaryStore!, "searchFiltered");
    const denseBranchSpy = vi.spyOn(primaryStore!, "searchOnBranch");
    const bm25FilteredSpy = vi.spyOn((indexer as unknown as { invertedIndex: { searchFiltered: (...args: unknown[]) => unknown; searchOnBranch: (...args: unknown[]) => unknown } }).invertedIndex, "searchFiltered");
    const bm25BranchSpy = vi.spyOn((indexer as unknown as { invertedIndex: { searchFiltered: (...args: unknown[]) => unknown; searchOnBranch: (...args: unknown[]) => unknown } }).invertedIndex, "searchOnBranch");

    await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });

    expect(denseFilteredSpy).not.toHaveBeenCalled();
    expect(bm25FilteredSpy).not.toHaveBeenCalled();
    expect(denseBranchSpy).toHaveBeenCalledWith(expect.any(Array), "main", expect.any(Number));
    expect(bm25BranchSpy).toHaveBeenCalledWith("rankHybridResults", "main", expect.any(Number));
  });

  it("switches native branch filter state correctly across git branch changes", async () => {
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

    const targetFile = path.join(tempDir, "app", "indexer", "index.ts");
    fs.writeFileSync(
      targetFile,
      `export function mainBranchOnlySymbol(query: string) { return query.length; }
export function rerankResults(query: string) { return mainBranchOnlySymbol(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial main snapshot"], { cwd: tempDir, stdio: "ignore" });
    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const mainResults = await indexer.search("mainBranchOnlySymbol", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });
    expect(mainResults[0]?.name).toBe("mainBranchOnlySymbol");

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(
      targetFile,
      `export function featureBranchOnlySymbol(query: string) { return query.toUpperCase(); }
export function featureSearchEntry(query: string) { return featureBranchOnlySymbol(query); }
`,
      "utf-8"
    );
    await indexer.handleBranchChange("main", "feature");

    const featureResults = await indexer.search("featureBranchOnlySymbol", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });
    expect(featureResults[0]?.name).toBe("featureBranchOnlySymbol");

    execFileSync("git", ["checkout", "-f", "main"], { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(
      targetFile,
      `export function mainBranchOnlySymbol(query: string) { return query.length; }
export function rerankResults(query: string) { return mainBranchOnlySymbol(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );
    await indexer.handleBranchChange("feature", "main");

    const mainResultsAfterSwitchBack = await indexer.search("mainBranchOnlySymbol", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });
    expect(mainResultsAfterSwitchBack[0]?.name).toBe("mainBranchOnlySymbol");

  });

  it("keeps query branch context consistent when a branch switch is in progress after publication", async () => {
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

    const targetFile = path.join(tempDir, "app", "indexer", "index.ts");
    fs.writeFileSync(
      targetFile,
      `export function mainBranchOnlySymbol(query: string) { return query.length; }
export function rerankResults(query: string) { return mainBranchOnlySymbol(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial main snapshot"], { cwd: tempDir, stdio: "ignore" });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const publishDeferred = Promise.withResolvers<void>();
    const finishSwitchDeferred = Promise.withResolvers<void>();
    const originalPublishCurrentBranch = (
      indexer as unknown as { publishCurrentBranch: (branch: string) => void }
    ).publishCurrentBranch.bind(indexer);
    const publishSpy = vi.spyOn(
      indexer as unknown as { publishCurrentBranch: (branch: string) => void },
      "publishCurrentBranch"
    ).mockImplementation((branch: string) => {
      originalPublishCurrentBranch(branch);
      publishDeferred.resolve();
    });
    const orchestrator = (indexer as unknown as {
      orchestrator: {
        coldStart: () => Promise<void>;
      };
    }).orchestrator;
    const coldStartSpy = vi
      .spyOn(orchestrator, "coldStart")
      .mockImplementation(async () => {
        await finishSwitchDeferred.promise;
      });
    const stores = (indexer as unknown as {
      stores: Map<string, { searchOnBranch: (queryVector: number[], branch: string, limit?: number) => unknown[] }>;
      invertedIndex: { searchOnBranch: (query: string, branch: string, limit?: number) => Map<string, number> };
    }).stores;
    const primaryStore = stores.get("mock-embedding-model");
    expect(primaryStore).toBeTruthy();
    const denseBranchSpy = vi.spyOn(primaryStore!, "searchOnBranch");
    const bm25BranchSpy = vi.spyOn(
      (indexer as unknown as {
        invertedIndex: { searchOnBranch: (query: string, branch: string, limit?: number) => Map<string, number> };
      }).invertedIndex,
      "searchOnBranch"
    );

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(
      targetFile,
      `export function featureBranchOnlySymbol(query: string) { return query.toUpperCase(); }
export function featureSearchEntry(query: string) { return featureBranchOnlySymbol(query); }
`,
      "utf-8"
    );
    const switchPromise = indexer.handleBranchChange("main", "feature");
    await publishDeferred.promise;

    const response = await indexer.searchDetailed("featureBranchOnlySymbol", 5, {
      metadataOnly: true,
      filterByBranch: true,
    });

    expect(response.primaryResults).toEqual([]);
    expect(denseBranchSpy.mock.calls.every((call) => call[1] === "feature")).toBe(true);
    expect(bm25BranchSpy.mock.calls.every((call) => call[1] === "feature")).toBe(true);

    finishSwitchDeferred.resolve();
    await switchPromise;
    coldStartSpy.mockRestore();
    publishSpy.mockRestore();
  });

  it("snapshots the branch once at query start and ignores mid-query branch changes", async () => {
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

    const targetFile = path.join(tempDir, "app", "indexer", "index.ts");
    fs.writeFileSync(
      targetFile,
      `export function mainBranchOnlySymbol(query: string) { return query.length; }
export function rerankResults(query: string) { return mainBranchOnlySymbol(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial main snapshot"], { cwd: tempDir, stdio: "ignore" });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(
      targetFile,
      `export function featureBranchOnlySymbol(query: string) { return query.toUpperCase(); }
export function featureSearchEntry(query: string) { return featureBranchOnlySymbol(query); }
`,
      "utf-8"
    );
    await indexer.handleBranchChange("main", "feature");

    execFileSync("git", ["checkout", "-f", "main"], { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(
      targetFile,
      `export function mainBranchOnlySymbol(query: string) { return query.length; }
export function rerankResults(query: string) { return mainBranchOnlySymbol(query); }
export function searchEntry(query: string) { return rerankResults(query); }
`,
      "utf-8"
    );
    await indexer.handleBranchChange("feature", "main");

    let branchReadCount = 0;
    let currentBranchValue = (indexer as unknown as { currentBranch: string }).currentBranch;
    Object.defineProperty(indexer, "currentBranch", {
      configurable: true,
      get() {
        branchReadCount += 1;
        return currentBranchValue;
      },
      set(value: string) {
        currentBranchValue = value;
      },
    });

    const embeddingDeferred = Promise.withResolvers<void>();
    const originalGetQueryEmbedding = (
      indexer as unknown as {
        getQueryEmbedding: (query: string, provider: unknown) => Promise<number[] | null>;
      }
    ).getQueryEmbedding.bind(indexer);
    const getQueryEmbeddingSpy = vi
      .spyOn(
        indexer as unknown as {
          getQueryEmbedding: (query: string, provider: unknown) => Promise<number[] | null>;
        },
        "getQueryEmbedding"
      )
      .mockImplementation(async (query: string, provider: unknown) => {
        await embeddingDeferred.promise;
        return originalGetQueryEmbedding(query, provider);
      });

    const primaryStore = (indexer as unknown as {
      stores: Map<string, { searchOnBranch: (queryVector: number[], branch: string, limit?: number) => unknown[] }>;
    }).stores.get("mock-embedding-model");
    expect(primaryStore).toBeTruthy();
    const denseBranchSpy = vi.spyOn(primaryStore!, "searchOnBranch");
    const bm25BranchSpy = vi.spyOn(
      (indexer as unknown as {
        invertedIndex: { searchOnBranch: (query: string, branch: string, limit?: number) => Map<string, number> };
      }).invertedIndex,
      "searchOnBranch"
    );

    const searchPromise = indexer.searchDetailed("mainBranchOnlySymbol", 5, {
      metadataOnly: true,
      filterByBranch: true,
      graphDepth: 1,
    });

    await Promise.resolve();
    (indexer as unknown as { currentBranch: string }).currentBranch = "feature";
    embeddingDeferred.resolve();

    const response = await searchPromise;

    expect(branchReadCount).toBe(1);
    expect(response.primaryResults[0]?.name).toBe("mainBranchOnlySymbol");
    expect(denseBranchSpy.mock.calls.every((call) => call[1] === "main")).toBe(true);
    expect(bm25BranchSpy.mock.calls.every((call) => call[1] === "main")).toBe(true);

    getQueryEmbeddingSpy.mockRestore();
    Object.defineProperty(indexer, "currentBranch", {
      configurable: true,
      writable: true,
      value: currentBranchValue,
    });
  });

  it("expands only callers for caller queries and only callees for callee queries", async () => {
    fs.mkdirSync(path.join(tempDir, "app", "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "app", "graph", "helper.ts"),
      `export function graphTargetHelper(value: string) { return value.length; }
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "app", "graph", "caller.ts"),
      `import { graphTargetHelper } from "./helper";

export function graphCallHelper(value: string) { return graphTargetHelper(value); }
export function graphOuterCaller(value: string) { return graphCallHelper(value); }
`,
      "utf-8"
    );

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

    const callerResponse = await indexer.searchDetailed("what calls graphTargetHelper", 5, {
      metadataOnly: true,
      filterByBranch: false,
      includeScoreBreakdown: true,
    });
    expect(callerResponse.taskType).toBe("definition");
    expect(callerResponse.graphDirection).toBe("caller");
    expect(callerResponse.expandedContext.map((entry) => entry.name)).toContain("graphCallHelper");
    expect(callerResponse.expandedContext.every((entry) => entry.relation === "caller")).toBe(true);
    expect(callerResponse.expandedContext.map((entry) => entry.name)).not.toContain("graphOuterCaller");
    expect(callerResponse.primaryResults.some((entry) =>
      entry.scoreBreakdown?.stages.some((stage) =>
        stage.name === "deterministicIntentLane" &&
        (stage.kind === "set-min" || stage.kind === "set") &&
        stage.reason.includes("graphInjection")
      )
    )).toBe(true);

    const calleeResponse = await indexer.searchDetailed("what does graphCallHelper call", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(calleeResponse.taskType).toBe("definition");
    expect(calleeResponse.graphDirection).toBe("callee");
    expect(calleeResponse.expandedContext.map((entry) => entry.name)).toContain("graphTargetHelper");
    expect(calleeResponse.expandedContext.every((entry) => entry.relation === "callee")).toBe(true);
    expect(calleeResponse.expandedContext.map((entry) => entry.name)).not.toContain("graphOuterCaller");
  });

  it("returns caller chunks from search() for relationship queries instead of discarding expanded context", async () => {
    fs.mkdirSync(path.join(tempDir, "app", "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "app", "graph", "helper.ts"),
      `export function graphTargetHelper(value: string) { return value.length; }
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "app", "graph", "caller.ts"),
      `import { graphTargetHelper } from "./helper";

export function graphCallHelper(value: string) { return graphTargetHelper(value); }
`,
      "utf-8"
    );

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

    const results = await indexer.search("what calls graphTargetHelper", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.some((entry) => entry.name === "graphCallHelper" && entry.relation === "caller")).toBe(true);
  });

  it("marks the secondary query lane degraded during startup when the probe fails", async () => {
    let customProbeCalls = 0;
    fetchSpy.mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      const texts = Array.isArray(body.input) ? body.input : [];
      if (requestUrl.includes("api.voyageai.com")) {
        return createMockEmbeddingResponse(init);
      }
      if (requestUrl.includes("127.0.0.1:11434") && texts.some((text) => text.includes("health"))) {
        customProbeCalls += 1;
        throw new Error("ollama down");
      }
      return createMockEmbeddingResponse(init);
    });

    const config = parseConfig({
      embeddingProvider: "voyage",
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
      customProvider: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "snowflake-arctic-embed2",
        dimensions: 1024,
      },
      indexing: {
        watchFiles: false,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.initialize();

    await waitForCondition(() => customProbeCalls > 0);
    await waitForCondition(() => getQueryEmbeddingFailureState(indexer).has("snowflake-arctic-embed2"));

    expect(getQueryEmbeddingFailureState(indexer).get("snowflake-arctic-embed2")?.reason).toContain("startup health probe");
  });

  it("keeps the secondary query lane healthy when the startup probe succeeds", async () => {
    let customProbeCalls = 0;
    fetchSpy.mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      const texts = Array.isArray(body.input) ? body.input : [];
      if (requestUrl.includes("127.0.0.1:11434") && texts.some((text) => text.includes("health"))) {
        customProbeCalls += 1;
      }
      return createMockEmbeddingResponse(init);
    });

    const config = parseConfig({
      embeddingProvider: "voyage",
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
      customProvider: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "snowflake-arctic-embed2",
        dimensions: 1024,
      },
      indexing: {
        watchFiles: false,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.initialize();

    await waitForCondition(() => customProbeCalls > 0);
    expect(getQueryEmbeddingFailureState(indexer).has("snowflake-arctic-embed2")).toBe(false);
  });

  it("recovers the secondary query lane after cooldown when the provider comes back", async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      const texts = Array.isArray(body.input) ? body.input : [];
      const dimensions =
        requestUrl.includes("api.voyageai.com") || body.model === "voyage-code-2"
          ? 1536
          : body.model === "snowflake-arctic-embed2"
            ? 1024
            : 8;
      if (requestUrl.includes("api.voyageai.com")) {
        const data = texts.map((text) => {
          let seed = 0;
          for (const ch of text) {
            seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
          }
          return {
            embedding: Array.from({ length: dimensions }, (_, idx) => ((seed + idx * 17) % 997) / 997),
          };
        });
        return new Response(
          JSON.stringify({
            data,
            usage: { total_tokens: Math.max(1, texts.length * 8) },
          }),
          { status: 200 }
        );
      }
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from({ length: dimensions }, (_, idx) => ((seed + idx * 17) % 997) / 997),
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

    const config = parseConfig({
      embeddingProvider: "voyage",
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
      customProvider: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "snowflake-arctic-embed2",
        dimensions: 1024,
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
    await indexer.initialize();
    const failureState = getQueryEmbeddingFailureState(indexer);
    failureState.set("snowflake-arctic-embed2", {
      until: Date.now() - 1,
      reason: "expired for test",
    });

    const secondaryProvider = getSecondaryProvider(indexer);
    expect(secondaryProvider).toBeDefined();
    await (indexer as unknown as {
      getQueryEmbedding(
        query: string,
        provider: {
          getModelInfo(): { model: string };
          embedQuery(query: string): Promise<{ embedding: number[]; tokensUsed: number } | null>;
        }
      ): Promise<number[] | null>;
    }).getQueryEmbedding("health", secondaryProvider!);

    expect(getQueryEmbeddingFailureState(indexer).has("snowflake-arctic-embed2")).toBe(false);
  });

  it("expands callers for split function symbols after call-edge resolution canonicalizes the target", async () => {
    fs.mkdirSync(path.join(tempDir, "app", "split-graph"), { recursive: true });
    const repeatedBody = Array.from({ length: 220 }, (_, index) =>
      `  const metric${index} = values[${index % 3}] ?? ${index};`
    ).join("\n");
    fs.writeFileSync(
      path.join(tempDir, "app", "split-graph", "metrics.ts"),
      `export function computeMetrics(values: number[]) {\n${repeatedBody}\n  return values.reduce((sum, value) => sum + value, 0);\n}\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tempDir, "app", "split-graph", "runner.ts"),
      `import { computeMetrics } from "./metrics";\n\nexport function runMetrics(values: number[]) {\n  return computeMetrics(values);\n}\n`,
      "utf-8"
    );

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
    const branch = (indexer as unknown as { currentBranch: string }).currentBranch;
    const splitSymbols = database.getSymbolsByNameOnBranch("computeMetrics", branch);
    expect(splitSymbols.length).toBeGreaterThan(1);

    const runMetrics = database.getSymbolsByNameOnBranch("runMetrics", branch)[0];
    expect(runMetrics).toBeDefined();
    const callees = database.getCallees(runMetrics!.id, branch);
    expect(callees.some((edge) => edge.targetName === "computeMetrics" && Boolean(edge.toSymbolId))).toBe(true);

    const response = await indexer.searchDetailed("what calls computeMetrics", 10, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(response.graphDirection).toBe("caller");
    expect(response.expandedContext.some((entry) => entry.name === "runMetrics" && entry.relation === "caller")).toBe(true);
  });
});
