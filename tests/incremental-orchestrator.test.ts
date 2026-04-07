import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  buildChunkStageInputHash,
  buildEmbedStageInputHash,
  buildGraphStageInputHash,
} from "../src/indexer/incremental-index-orchestrator.js";
import {
  type ConfigVersion,
  getCurrentConfigVersion,
  hashConfigVersion,
} from "../src/indexer/config-version.js";
import {
  buildMerkleSnapshot,
  Database,
  getChunkerVersion,
  hashContent,
} from "../src/native/index.js";

describe("incremental index orchestrator", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "incremental-orchestrator-"));
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
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createConfig(overrides: Record<string, unknown> = {}) {
    const overrideRecord = overrides as {
      customProvider?: Record<string, unknown>;
      indexing?: Record<string, unknown>;
    };
    return parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
        ...(overrideRecord.customProvider ?? {}),
      },
      indexing: {
        watchFiles: false,
        ...(overrideRecord.indexing ?? {}),
      },
      ...overrides,
    });
  }

  function createRepo(): {
    fileA: string;
    fileB: string;
  } {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const fileA = path.join(srcDir, "alpha.ts");
    const fileB = path.join(srcDir, "beta.ts");
    fs.writeFileSync(fileA, "export function alpha(): number { return 1; }\n", "utf-8");
    fs.writeFileSync(fileB, "export function beta(): number { return 2; }\n", "utf-8");

    return {
      fileA,
      fileB,
    };
  }

  function createGraphRepo(): string {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "calls.ts");
    fs.writeFileSync(
      filePath,
      [
        "export function callee(): number {",
        "  return 1;",
        "}",
        "",
        "export function caller(): number {",
        "  return callee();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    return filePath;
  }

  function createChunkyRepo(): string {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "many.ts");
    fs.writeFileSync(
      filePath,
      [
        "export function first(): number {",
        "  return 1;",
        "}",
        "",
        "export function second(): number {",
        "  return 2;",
        "}",
        "",
        "export function third(): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    return filePath;
  }

  function createZeroChunkRepo(): string {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "constants.ts");
    fs.writeFileSync(
      filePath,
      [
        "export const ALPHA = 1;",
        "export const BETA = 2;",
        "",
      ].join("\n"),
      "utf-8"
    );
    return filePath;
  }

  function resolveTrackedPath(
    database: Database,
    branch: string,
    filePath: string,
    projectRoot: string
  ): string {
    const realFilePath = fs.realpathSync(filePath);
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const known = database.getKnownPipelineFiles(branch);
    return (
      known.find(
        (candidate) =>
          candidate === filePath ||
          candidate === realFilePath ||
          candidate === relativePath ||
          candidate.endsWith(`/${relativePath}`)
      ) ??
      realFilePath
    );
  }

  async function openDatabase(indexer: Indexer): Promise<{
    branch: string;
    database: Database;
    indexPath: string;
  }> {
    const status = await indexer.getStatus();
    return {
      branch: status.currentBranch,
      database: new Database(path.join(status.indexPath, "codebase.db")),
      indexPath: status.indexPath,
    };
  }

  function relativeToRepo(filePath: string): string {
    return path.relative(tempDir, filePath).replace(/\\/g, "/");
  }

  function getSnapshotFileHash(snapshot: string, relativePath: string): string | null {
    const parsed = JSON.parse(snapshot) as {
      nodes?: Record<string, { hash?: string; kind?: string }>;
    };
    const node = parsed.nodes?.[relativePath];
    if (!node || node.kind !== "file") {
      return null;
    }
    return node.hash ?? null;
  }

  function getIndexerInternals(indexer: Indexer): {
    orchestrator: any;
    store: { save: () => void };
    configuredProviderInfo: any;
    buildMerkleIgnoreRules: () => {
      include: string[];
      exclude: string[];
      maxFileSize?: number;
    };
    parseFilesForIndexing: (
      files: Array<{ path: string; content: string; hash: string }>
    ) => {
      parsedFiles: Array<{
        path: string;
        chunks: Array<{ chunkType: string }>;
      }>;
    };
  } {
    return indexer as unknown as {
      orchestrator: any;
      store: { save: () => void };
      configuredProviderInfo: any;
      buildMerkleIgnoreRules: () => {
        include: string[];
        exclude: string[];
        maxFileSize?: number;
      };
      parseFilesForIndexing: (
        files: Array<{ path: string; content: string; hash: string }>
      ) => {
        parsedFiles: Array<{
          path: string;
          chunks: Array<{ chunkType: string }>;
        }>;
      };
    };
  }

  async function getCurrentRuntimeConfig(indexer: Indexer): Promise<ConfigVersion> {
    const { configuredProviderInfo } = getIndexerInternals(indexer);
    return getCurrentConfigVersion(configuredProviderInfo);
  }

  it("builds stable stage input hashes with the expected invalidation behavior", () => {
    expect(buildChunkStageInputHash("file-hash-a", "chunker-v1")).toBe(
      buildChunkStageInputHash("file-hash-a", "chunker-v1")
    );
    expect(buildChunkStageInputHash("file-hash-a", "chunker-v1")).not.toBe(
      buildChunkStageInputHash("file-hash-b", "chunker-v1")
    );

    const embedA = buildEmbedStageInputHash(["chunk-a", "chunk-b"], "embed-v1");
    const embedB = buildEmbedStageInputHash(["chunk-b", "chunk-a"], "embed-v1");
    const embedC = buildEmbedStageInputHash(["chunk-a", "chunk-b"], "embed-v2");
    expect(embedA).toBe(embedB);
    expect(embedA).not.toBe(embedC);

    expect(buildGraphStageInputHash("file-hash-a", "graph-v1")).not.toBe(
      buildGraphStageInputHash("file-hash-a", "graph-v2")
    );
  });

  it("completes all pipeline stages on cold start and persists a Merkle snapshot", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());

    const stats = await indexer.index();
    expect(stats.totalFiles).toBe(2);

    const status = await indexer.getStatus();
    const branch = status.currentBranch;
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    for (const filePath of [fileA, fileB]) {
      const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
      for (const stage of ["chunk", "embed", "index", "graph"] as const) {
        expect(database.getPipelineState(branch, trackedPath, stage)).toMatchObject({
          branch,
          filePath: trackedPath,
          stage,
          status: "complete",
        });
        expect(database.getPipelineState(branch, trackedPath, stage)?.inputHash).toBeTruthy();
      }
    }

    expect(database.getMerkleSnapshot(branch)).toBeTruthy();
  });

  it("reprocesses only the changed file on hot update and leaves unchanged files untouched", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const status = await indexer.getStatus();
    const branch = status.currentBranch;
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeA = database.getPipelineState(branch, trackedA, "chunk");
    const beforeB = database.getPipelineState(branch, trackedB, "chunk");
    expect(beforeA?.updatedAt).toBeTypeOf("number");
    expect(beforeB?.updatedAt).toBeTypeOf("number");

    const initialFetchCount = fetchSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(fileA, "export function alpha(): number { return 11; }\n", "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: fileA }]);

    const afterAChunk = database.getPipelineState(branch, trackedA, "chunk");
    const afterAEmbed = database.getPipelineState(branch, trackedA, "embed");
    const afterBChunk = database.getPipelineState(branch, trackedB, "chunk");

    expect(afterAChunk?.updatedAt).toBeGreaterThan(beforeA?.updatedAt ?? 0);
    expect(afterAEmbed?.status).toBe("complete");
    expect(afterBChunk?.updatedAt).toBe(beforeB?.updatedAt);

    const hotUpdateCalls = fetchSpy.mock.calls.slice(initialFetchCount);
    expect(hotUpdateCalls.length).toBe(1);
    const requestBody = JSON.parse(String(hotUpdateCalls[0]?.[1]?.body ?? "{}")) as {
      input?: string[];
    };
    expect(requestBody.input?.length).toBe(1);
    expect(requestBody.input?.[0]).toContain("alpha");
  });

  it("skips embedding calls on a clean rerun when stage hashes still match", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());

    await indexer.index();
    const initialFetchCount = fetchSpy.mock.calls.length;

    await indexer.index();

    expect(fetchSpy.mock.calls.length).toBe(initialFetchCount);
  });

  it("applies the same chunk filters as the old indexing path", async () => {
    const filePath = createChunkyRepo();
    const config = createConfig({
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 1,
      },
    });
    const indexer = new Indexer(tempDir, config);
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const internals = getIndexerInternals(indexer);
    const parsed = internals.parseFilesForIndexing([
      {
        path: filePath,
        content: fileContent,
        hash: hashContent(fileContent),
      },
    ]).parsedFiles[0];

    let expectedChunkCount = 0;
    for (const chunk of parsed?.chunks ?? []) {
      if (expectedChunkCount >= config.indexing.maxChunksPerFile) {
        break;
      }
      if (config.indexing.semanticOnly && chunk.chunkType === "other") {
        continue;
      }
      expectedChunkCount += 1;
    }

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    const branchChunkIds = new Set(database.getBranchChunkIds(branch));
    const branchChunksForFile = database
      .getChunksByFile(trackedPath)
      .filter((chunk) => branchChunkIds.has(chunk.chunkId));

    expect(branchChunksForFile).toHaveLength(expectedChunkCount);
    expect(branchChunksForFile).toHaveLength(1);
  });

  it("commits Merkle snapshot hashes from the bytes actually processed", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const baseSnapshot = database.getMerkleSnapshot(branch);
    expect(baseSnapshot).toBeTruthy();

    const finalContent = "export function alpha(): number { return 34; }\n";
    fs.writeFileSync(fileA, finalContent, "utf-8");

    await indexer.indexDirtySet(
      {
        changedFiles: [relativeToRepo(fileA)],
        addedFiles: [],
        removedFiles: [],
      },
      undefined,
      baseSnapshot
    );

    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    expect(database.getPipelineState(branch, trackedPath, "chunk")?.inputHash).toBe(
      buildChunkStageInputHash(hashContent(finalContent), getChunkerVersion())
    );
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(hashContent(finalContent));
  });

  it("defers files that drift after scan and reprocesses them on the next hot update pass", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const baseSnapshot = database.getMerkleSnapshot(branch);
    expect(baseSnapshot).toBeTruthy();
    const snapshotBeforeDeferral = baseSnapshot ?? "";
    const oldChunkInputHash = database.getPipelineState(branch, trackedPath, "chunk")?.inputHash;
    const initialFetchCount = fetchSpy.mock.calls.length;

    const scannedContent = "export function alpha(): number { return 21; }\n";
    fs.writeFileSync(fileA, scannedContent, "utf-8");
    const scannedSnapshot = await buildMerkleSnapshot(
      tempDir,
      branch,
      getIndexerInternals(indexer).buildMerkleIgnoreRules()
    );

    const liveContent = "export function alpha(): number { return 34; }\n";
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const originalProcessJob = orchestrator.processJob.bind(orchestrator);
    const processSpy = vi
      .spyOn(orchestrator, "processJob")
      .mockImplementationOnce(async (context: unknown, job: unknown) => {
        fs.writeFileSync(fileA, liveContent, "utf-8");
        return originalProcessJob(context, job);
      });

    await indexer.indexDirtySet(
      {
        changedFiles: [relativeToRepo(fileA)],
        addedFiles: [],
        removedFiles: [],
      },
      scannedSnapshot.snapshot,
      baseSnapshot
    );
    processSpy.mockRestore();

    expect(fetchSpy.mock.calls.length).toBe(initialFetchCount);
    expect(database.getPipelineState(branch, trackedPath, "chunk")?.inputHash).toBe(oldChunkInputHash);
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(getSnapshotFileHash(snapshotBeforeDeferral, relativeToRepo(fileA)));

    await indexer.indexDirtySet(
      {
        changedFiles: [],
        addedFiles: [],
        removedFiles: [],
      },
      undefined,
      database.getMerkleSnapshot(branch)
    );

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.inputHash).toBe(
      buildChunkStageInputHash(hashContent(liveContent), getChunkerVersion())
    );
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(hashContent(liveContent));
  });

  it("marks zero-chunk files complete and keeps them out of unfinished worklists", async () => {
    const filePath = createZeroChunkRepo();
    const indexer = new Indexer(tempDir, createConfig({
      indexing: {
        watchFiles: false,
        semanticOnly: true,
      },
    }));

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, trackedPath, stage)?.status).toBe("complete");
      expect(database.getPipelineState(branch, trackedPath, stage)?.inputHash).toBeTruthy();
    }

    expect(database.getUnfinishedPipelineFiles(branch)).not.toContain(trackedPath);
  });

  it("keeps other-branch call edges intact when reindexing a shared file", async () => {
    const filePath = createGraphRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const callersBefore = database.getCallers("callee", branch);
    expect(callersBefore.length).toBeGreaterThan(0);

    database.addSymbolsToBranchBatch("feature", database.getBranchSymbolIds(branch));

    fs.writeFileSync(
      filePath,
      [
        "export function callee(): number {",
        "  return 2;",
        "}",
        "",
        "export function caller(): number {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    await indexer.handleFileChanges([{ type: "change", path: filePath }]);

    expect(database.getCallers("callee", "feature")).toHaveLength(callersBefore.length);
  });

  it("reprocesses files left with index in_progress when finalization crashes before durable completion", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    fs.writeFileSync(fileA, "export function alpha(): number { return 55; }\n", "utf-8");

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const baseSnapshot = database.getMerkleSnapshot(branch);
    const nextSnapshot = await buildMerkleSnapshot(
      tempDir,
      branch,
      getIndexerInternals(indexer).buildMerkleIgnoreRules()
    );
    const saveSpy = vi
      .spyOn(getIndexerInternals(indexer).store, "save")
      .mockImplementationOnce(() => {
        throw new Error("simulated finalization crash");
      });

    await expect(
      indexer.indexDirtySet(
        {
          changedFiles: [relativeToRepo(fileA)],
          addedFiles: [],
          removedFiles: [],
        },
        nextSnapshot.snapshot,
        baseSnapshot
      )
    ).rejects.toThrow("simulated finalization crash");
    saveSpy.mockRestore();

    expect(database.getPipelineState(branch, trackedPath, "index")?.status).toBe("in_progress");
    expect(database.getActivePipelineRuns()).toHaveLength(1);

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineState(branch, trackedPath, "index")?.status).toBe("complete");
    expect(database.getActivePipelineRuns()).toHaveLength(0);
  });

  it("reprocesses unfinished index stages during resume instead of skipping them", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    database.upsertPipelineState({
      branch,
      filePath: trackedPath,
      stage: "index",
      status: "in_progress",
      inputHash: database.getPipelineState(branch, trackedPath, "index")?.inputHash,
      updatedAt: Date.now(),
    });
    database.startPipelineRun(
      {
        runId: "resume-run",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineState(branch, trackedPath, "index")?.status).toBe("complete");
    expect(database.getPipelineRun("resume-run")?.status).toBe("complete");
  });

  it("handles chunker config drift by rerunning CHUNK without resetting EMBED", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    database.activateConfigVersion({
      configHash: "stale-chunker-hash",
      embeddingModelId: currentConfig.embeddingModelId,
      embeddingDimension: currentConfig.embeddingDimension,
      chunkerVersion: "stale-chunker-version",
      graphExtractorVersion: currentConfig.graphExtractorVersion,
      active: true,
      createdAt: Date.now() - 1,
    });

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunk?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
  });

  it("handles embedding config drift by rerunning EMBED without resetting CHUNK", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    database.activateConfigVersion({
      configHash: "stale-embed-hash",
      embeddingModelId: currentConfig.embeddingModelId,
      embeddingDimension: currentConfig.embeddingDimension,
      chunkerVersion: currentConfig.chunkerVersion,
      graphExtractorVersion: currentConfig.graphExtractorVersion,
      active: true,
      createdAt: Date.now() - 1,
    });

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(
      beforeChunk?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
  });

  it("isolates single-file embed failures and still completes the rest of the run", async () => {
    const { fileA, fileB } = createRepo();
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      if (texts.some((text) => text.includes("alpha"))) {
        throw new Error("forced embed failure");
      }
      const data = texts.map(() => ({
        embedding: Array.from({ length: 8 }, (_, idx) => idx / 8),
      }));
      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);

    expect(database.getPipelineState(branch, trackedA, "embed")?.status).toBe("failed");
    expect(database.getPipelineState(branch, trackedB, "index")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedB, "graph")?.status).toBe("complete");
  });

  it("purges pending old-branch jobs and cancels active runs when the branch changes", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "low";
        trigger: "cold_start";
        runId: string;
      }) => void;
      getStats: () => { pendingCount: number };
    };

    database.startPipelineRun(
      {
        runId: "branch-change-run",
        branch,
        runType: "cold_start",
        status: "in_progress",
        configHash: "branch-change-hash",
        startedAt: Date.now(),
      },
      Date.now()
    );
    queue.enqueue({
      branch,
      filePath: fileA,
      priority: "low",
      trigger: "cold_start",
      runId: "branch-change-run",
    });
    expect(queue.getStats().pendingCount).toBeGreaterThan(0);

    await orchestrator.handleBranchChange(branch, "feature");

    expect(database.getPipelineRun("branch-change-run")?.status).toBe("cancelled");
    expect(queue.getStats().pendingCount).toBe(0);
    expect(database.getMerkleSnapshot("feature")).toBeTruthy();
  });
});
