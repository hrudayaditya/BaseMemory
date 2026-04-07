import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
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

  it("returns implementation definitions before fixture/benchmark noise for implementation-intent query", async () => {
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
        fromSymbolId: "sym-rerankResults",
        fromSymbolName: "rerankResults",
        fromSymbolFilePath: filePath,
        targetName: "rankHybridResults",
        toSymbolId: "sym-rankHybridResults",
        callType: "Call",
        line: 2,
        col: 47,
        isResolved: true,
      },
      {
        id: "edge-entry-rerank",
        fromSymbolId: "sym-searchEntry",
        fromSymbolName: "searchEntry",
        fromSymbolFilePath: filePath,
        targetName: "rerankResults",
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
      graphDepth: 1,
    });

    expect(response.primaryResults[0]?.name).toBe("rerankResults");
    const expandedNames = response.expandedContext.map((entry) => entry.name);
    expect(expandedNames).toContain("rankHybridResults");
    expect(expandedNames).toContain("searchEntry");
    expect(new Set(response.expandedContext.map((entry) => entry.relation))).toEqual(new Set(["caller", "callee"]));
  });
});
