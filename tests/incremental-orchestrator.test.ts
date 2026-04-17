import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  applyChunkFilters,
  buildChunkStageInputHash,
  buildEmbedStageInputHash,
  buildGraphStageInputHash,
  TTI_TARGET_MS,
  type OrchestratorParsedChunk,
} from "../src/indexer/incremental-index-orchestrator.js";
import { CheckpointManager } from "../src/indexer/checkpoint-manager.js";
import {
  type ConfigVersion,
  getCurrentConfigVersion,
  hashConfigVersion,
} from "../src/indexer/config-version.js";
import {
  buildEmbeddingInputHash,
  buildMerkleSnapshot,
  chunkFile,
  Database,
  getChunkerVersion,
  hashContent,
  prepareEmbeddingInput,
} from "../src/native/index.js";
import {
  recordWatcherEventTimestamp,
  resetWatcherEventTimestamps,
} from "../src/indexer/watcher-tti.js";
import { formatStatus } from "../src/tools/utils.js";

describe("incremental index orchestrator", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function getMockEmbeddingDimensions(model: string | undefined): number {
    switch (model) {
      case "voyage-code-2":
        return 1536;
      case "voyage-code-3":
        return 1024;
      default:
        return 8;
    }
  }

  function createMockEmbeddingResponse(
    init: RequestInit | undefined,
    overrides: {
      failIf?: (body: { input?: string[]; model?: string }) => Error | null;
    } = {}
  ): Response {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
    const failure = overrides.failIf?.(body);
    if (failure) {
      throw failure;
    }

    const texts = Array.isArray(body.input) ? body.input : [];
    const dimensions = getMockEmbeddingDimensions(body.model);
    const data = texts.map((text) => {
      let seed = 0;
      for (const ch of text) {
        seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
      }
      const embedding = Array.from(
        { length: dimensions },
        (_, idx) => ((seed + idx * 17) % 997) / 997
      );
      return { embedding };
    });

    return new Response(
      JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }),
      { status: 200 }
    );
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "incremental-orchestrator-"));
    resetWatcherEventTimestamps();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => createMockEmbeddingResponse(init));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetWatcherEventTimestamps();
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

  function createVoyagePrimaryConfig(overrides: Record<string, unknown> = {}) {
    const overrideRecord = overrides as {
      indexing?: Record<string, unknown>;
    };
    return parseConfig({
      embeddingProvider: "voyage",
      voyageApiKey: "voyage-test-key",
      voyageModelId: "voyage-code-2",
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

  function createSingleFileRepo(): string {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "only.ts");
    fs.writeFileSync(filePath, "export function only(): number { return 1; }\n", "utf-8");
    return filePath;
  }

  function createRepoWithThreeFiles(): {
    fileA: string;
    fileB: string;
    fileC: string;
  } {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const fileA = path.join(srcDir, "alpha.ts");
    const fileB = path.join(srcDir, "beta.ts");
    const fileC = path.join(srcDir, "gamma.ts");
    fs.writeFileSync(fileA, "export function alpha(): number { return 1; }\n", "utf-8");
    fs.writeFileSync(fileB, "export function beta(): number { return 2; }\n", "utf-8");
    fs.writeFileSync(fileC, "export function gamma(): number { return 3; }\n", "utf-8");

    return { fileA, fileB, fileC };
  }

  function createRepoWithManyFiles(count: number): string[] {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePaths: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const filePath = path.join(srcDir, `file-${index}.ts`);
      fs.writeFileSync(
        filePath,
        `export function file${index}(): number { return ${index}; }\n`,
        "utf-8"
      );
      filePaths.push(filePath);
    }
    return filePaths;
  }

  function createRepoWithManyMultiChunkFiles(
    fileCount: number,
    chunksPerFile: number
  ): string[] {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePaths: string[] = [];
    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      const filePath = path.join(srcDir, `multi-${fileIndex}.ts`);
      const body = Array.from({ length: chunksPerFile }, (_, chunkIndex) =>
        `export function file${fileIndex}Chunk${chunkIndex}(): number { return ${chunkIndex}; }`
      ).join("\n");
      fs.writeFileSync(filePath, `${body}\n`, "utf-8");
      filePaths.push(filePath);
    }
    return filePaths;
  }

  function createLargeSingleFileRepo(chunks: number): string {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, "large.ts");
    const body = Array.from({ length: chunks }, (_, index) =>
      `export function largeChunk${index}(): number { return ${index}; }`
    ).join("\n");
    fs.writeFileSync(filePath, `${body}\n`, "utf-8");
    return filePath;
  }

  function createGitRepoMetadata(currentBranch: string, branches: string[] = [currentBranch]): void {
    const gitDir = path.join(tempDir, ".git");
    const refsDir = path.join(gitDir, "refs", "heads");
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${currentBranch}\n`, "utf-8");
    for (const branch of branches) {
      const branchPath = path.join(refsDir, branch);
      fs.mkdirSync(path.dirname(branchPath), { recursive: true });
      fs.writeFileSync(branchPath, `${"a".repeat(39)}${branch.length % 10}\n`, "utf-8");
    }
  }

  function createMultiLanguageRepo(): Array<{
    filePath: string;
    language: "typescript" | "python" | "rust";
    content: string;
  }> {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const files = [
      {
        filePath: path.join(srcDir, "alpha.ts"),
        language: "typescript" as const,
        content: [
          "export function alpha(): number {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      },
      {
        filePath: path.join(srcDir, "beta.py"),
        language: "python" as const,
        content: [
          "def beta() -> int:",
          "    return 2",
          "",
        ].join("\n"),
      },
      {
        filePath: path.join(srcDir, "gamma.rs"),
        language: "rust" as const,
        content: [
          "pub fn gamma() -> i32 {",
          "    3",
          "}",
          "",
        ].join("\n"),
      },
    ];

    for (const file of files) {
      fs.writeFileSync(file.filePath, file.content, "utf-8");
    }

    return files;
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

  it("returns foreground results before background embedding completes and suppresses duplicate background launches", async () => {
    createSingleFileRepo();
    const config = createConfig();
    const releaseEmbedding = Promise.withResolvers<void>();
    fetchSpy.mockImplementation(async (_url, init) => {
      await releaseEmbedding.promise;
      return createMockEmbeddingResponse(init);
    });

    const indexer = new Indexer(tempDir, config);
    const startedAt = Date.now();
    const foreground = await indexer.indexForeground();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(3_000);
    expect(foreground.bm25Ready).toBe(true);
    expect(foreground.callGraphReady).toBe(true);
    expect(foreground.embeddingStatus).toBe("pending");

    const duplicate = await indexer.indexForeground();
    expect(duplicate.alreadyInProgress).toBe(true);
    expect(indexer.isBackgroundEmbeddingRunning()).toBe(true);

    const statusDuring = await indexer.getStatus();
    expect(statusDuring.indexed).toBe(true);
    expect(statusDuring.foreground?.bm25Ready).toBe(true);

    releaseEmbedding.resolve();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning());

    const statusAfter = await indexer.getStatus();
    expect(statusAfter.embedding?.status).toBe("complete");
  });

  it("reports foreground readiness while background embedding is running", async () => {
    createGraphRepo();
    const config = createConfig();
    const releaseEmbedding = Promise.withResolvers<void>();
    fetchSpy.mockImplementation(async (_url, init) => {
      await releaseEmbedding.promise;
      return createMockEmbeddingResponse(init);
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.indexForeground();

    const status = await indexer.getStatus();

    expect(status.foreground?.callGraphReady).toBe(true);
    expect(status.embedding?.status === "pending" || status.embedding?.status === "in_progress").toBe(true);

    releaseEmbedding.resolve();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning());
  });

  it("dispatches cross-file Voyage background batches at 128-chunk capacity", async () => {
    createRepoWithManyMultiChunkFiles(30, 10);
    const config = createVoyagePrimaryConfig();
    const indexer = new Indexer(tempDir, config);

    const foreground = await indexer.indexForeground();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning(), 10_000);

    const voyageCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; input?: string[] };
      return body.model === "voyage-code-2" && Array.isArray(body.input);
    });
    const expectedBatches = Math.ceil(foreground.embeddingProgress.total / 128);

    expect(foreground.embeddingProgress.total).toBeGreaterThan(128);
    expect(voyageCalls).toHaveLength(expectedBatches);
    expect(voyageCalls.every(([, init], index) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputLength = Array.isArray(body.input) ? body.input.length : 0;
      if (index < voyageCalls.length - 1) {
        return inputLength === 128;
      }
      return inputLength > 0 && inputLength <= 128;
    })).toBe(true);
  });

  it("continues background batching after a middle Voyage batch failure and records debt rows", async () => {
    const filePaths = createRepoWithManyFiles(300);
    const orderedFilePaths = [...filePaths].sort();
    const seenVoyagePayloads = new Set<string>();
    let failedPayload: string | null = null;
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      if (body.model === "voyage-code-2" && Array.isArray(body.input) && body.input.length > 0) {
        const payloadKey = JSON.stringify(body.input);
        if (!seenVoyagePayloads.has(payloadKey)) {
          seenVoyagePayloads.add(payloadKey);
          if (seenVoyagePayloads.size === 2) {
            failedPayload = payloadKey;
          }
        }
        if (failedPayload === payloadKey) {
          throw new Error("synthetic voyage batch failure");
        }
      }
      return createMockEmbeddingResponse(init);
    });

    const config = createVoyagePrimaryConfig();
    const indexer = new Indexer(tempDir, config);
    const foreground = await indexer.indexForeground();
    expect(foreground.embeddingProgress.total).toBeGreaterThan(256);
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning(), 10_000);

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const branch = status.currentBranch;
    const trackedFirst = resolveTrackedPath(database, branch, orderedFilePaths[0]!, tempDir);
    const trackedLast = resolveTrackedPath(
      database,
      branch,
      orderedFilePaths[orderedFilePaths.length - 1]!,
      tempDir
    );

    expect(database.getPipelineState(branch, trackedFirst, "embed")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedLast, "embed")?.status).toBe("complete");
    expect(database.getEmbeddingDebtForBranch(branch)).not.toEqual([]);
  });

  it("marks a large file complete only after all cross-file Voyage batches succeed", async () => {
    const filePath = createLargeSingleFileRepo(150);
    const releaseSecondBatch = Promise.withResolvers<void>();
    let voyageCallCount = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
      if (body.model === "voyage-code-2" && Array.isArray(body.input) && body.input.length > 0) {
        voyageCallCount += 1;
        if (voyageCallCount === 2) {
          await releaseSecondBatch.promise;
        }
      }
      return createMockEmbeddingResponse(init);
    });

    const config = createVoyagePrimaryConfig();
    const indexer = new Indexer(tempDir, config);

    const foreground = await indexer.indexForeground();
    expect(foreground.embeddingProgress.total).toBeGreaterThan(128);
    await waitForCondition(() => indexer.isBackgroundEmbeddingRunning(), 5_000);

    const statusDuring = await indexer.getStatus();
    const databaseDuring = new Database(path.join(statusDuring.indexPath, "codebase.db"));
    const trackedPath = resolveTrackedPath(databaseDuring, statusDuring.currentBranch, filePath, tempDir);
    expect(databaseDuring.getPipelineState(statusDuring.currentBranch, trackedPath, "embed")?.status).not.toBe("complete");

    releaseSecondBatch.resolve();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning(), 10_000);

    const statusAfter = await indexer.getStatus();
    const databaseAfter = new Database(path.join(statusAfter.indexPath, "codebase.db"));
    expect(databaseAfter.getPipelineState(statusAfter.currentBranch, trackedPath, "embed")?.status).toBe("complete");
  });

  it("keeps the hot update path on per-file embedding", async () => {
    const filePath = createSingleFileRepo();
    const config = createVoyagePrimaryConfig();
    const indexer = new Indexer(tempDir, config);

    await indexer.indexForeground();
    await waitForCondition(() => !indexer.isBackgroundEmbeddingRunning(), 10_000);

    fetchSpy.mockClear();
    fs.writeFileSync(filePath, "export function only(): number { return 2; }\n", "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: filePath }]);

    const voyageCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; input?: string[] };
      return body.model === "voyage-code-2" && Array.isArray(body.input);
    });

    expect(voyageCalls).toHaveLength(1);
    const requestBody = JSON.parse(String(voyageCalls[0]?.[1]?.body ?? "{}")) as { input?: string[] };
    expect(Array.isArray(requestBody.input)).toBe(true);
    expect((requestBody.input ?? []).length).toBeGreaterThan(0);
  });

  function createCrossFileCallRepo(): {
    callerFile: string;
    helperFile: string;
  } {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const callerFile = path.join(srcDir, "caller.ts");
    const helperFile = path.join(srcDir, "helper.ts");
    fs.writeFileSync(
      helperFile,
      [
        "export function helperFn(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      callerFile,
      [
        "import { helperFn } from \"./helper\";",
        "",
        "export function runTask(): number {",
        "  return helperFn();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    return {
      callerFile,
      helperFile,
    };
  }

  function createAmbiguousCrossFileCallRepo(): {
    callerFile: string;
    processAFile: string;
    processBFile: string;
  } {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const callerFile = path.join(srcDir, "caller.ts");
    const processAFile = path.join(srcDir, "process-a.ts");
    const processBFile = path.join(srcDir, "process-b.ts");
    fs.writeFileSync(
      processAFile,
      [
        "export function process(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      processBFile,
      [
        "export function process(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      callerFile,
      [
        "export function runTask(): number {",
        "  return process();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    return {
      callerFile,
      processAFile,
      processBFile,
    };
  }

  function createBranchDivergenceRepo(): {
    mainBranch: string;
    featureBranch: string;
    sharedFile: string;
    featureFile: string;
    checkoutMain: () => void;
    checkoutFeature: () => void;
  } {
    const srcDir = path.join(tempDir, "src");
    const mainBranch = "default";
    const featureBranch = "feature";
    const snapshots = {
      [mainBranch]: new Map<string, string>([
        [
          "src/shared.ts",
          [
            "export function sharedValue(): number {",
            "  return 1;",
            "}",
            "",
          ].join("\n"),
        ],
      ]),
      [featureBranch]: new Map<string, string>([
        [
          "src/shared.ts",
          [
            "export function sharedValue(): number {",
            "  return 1;",
            "}",
            "",
          ].join("\n"),
        ],
        [
          "src/feature-only.ts",
          [
            "export function featureOnlyHelper(): string {",
            "  return \"feature\";",
            "}",
            "",
          ].join("\n"),
        ],
      ]),
    };

    const applySnapshot = (snapshot: Map<string, string>): void => {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.mkdirSync(srcDir, { recursive: true });
      for (const [relativePath, content] of snapshot.entries()) {
        const absolutePath = path.join(tempDir, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, "utf-8");
      }
    };

    applySnapshot(snapshots[mainBranch]);

    return {
      mainBranch,
      featureBranch,
      sharedFile: path.join(srcDir, "shared.ts"),
      featureFile: path.join(srcDir, "feature-only.ts"),
      checkoutMain: () => applySnapshot(snapshots[mainBranch]),
      checkoutFeature: () => applySnapshot(snapshots[featureBranch]),
    };
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

  function createLargeRepo(fileCount: number): string[] {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const filePaths: string[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      const filePath = path.join(srcDir, `file-${String(index).padStart(3, "0")}.ts`);
      fs.writeFileSync(
        filePath,
        `export function value${index}(): number { return ${index}; }\n`,
        "utf-8"
      );
      filePaths.push(filePath);
    }

    return filePaths;
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

  function resolveTrackedRelativePath(
    database: Database,
    branch: string,
    relativePath: string
  ): string {
    const normalized = relativePath.replace(/\\/g, "/");
    const known = database.getKnownPipelineFiles(branch);
    return (
      known.find(
        (candidate) =>
          candidate === normalized ||
          candidate.endsWith(`/${normalized}`)
      ) ?? normalized
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

  function getStoreBasePath(indexPath: string, modelId: string): string {
    const safeModelId = modelId.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(indexPath, `vectors-${safeModelId}`);
  }

  function relativeToRepo(filePath: string): string {
    return path.relative(tempDir, filePath).replace(/\\/g, "/");
  }

  function searchResultMatchesFile(filePath: string, expectedRelativePath: string): boolean {
    const normalizedExpected = expectedRelativePath.replace(/\\/g, "/");
    const normalizedActual = filePath.replace(/\\/g, "/");
    return (
      normalizedActual === normalizedExpected ||
      normalizedActual.endsWith(`/${normalizedExpected}`) ||
      relativeToRepo(filePath) === normalizedExpected
    );
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

  function getFileHashCachePath(indexPath: string, branch: string): string {
    return path.join(indexPath, "file-hashes", `${encodeURIComponent(branch || "default")}.json`);
  }

  function getIndexerInternals(indexer: Indexer): {
    orchestrator: any;
    stores: Map<string, { save: () => void }>;
    invertedIndex?: {
      save: () => void;
      removeChunk: (chunkId: string) => boolean;
      setBranchMembership: (branch: string, chunkIds: string[]) => void;
      getDocumentCount: () => number;
    } | null;
    primaryStoreModelId?: string | null;
    config: { voyageModelId?: string | null; voyageApiKey?: string | null };
    voyageProvider?: { getModelInfo: () => { model: string } } | null;
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
      stores: Map<string, { save: () => void }>;
      invertedIndex?: {
        save: () => void;
        removeChunk: (chunkId: string) => boolean;
        setBranchMembership: (branch: string, chunkIds: string[]) => void;
        getDocumentCount: () => number;
      } | null;
      primaryStoreModelId?: string | null;
      config: { voyageModelId?: string | null; voyageApiKey?: string | null };
      voyageProvider?: { getModelInfo: () => { model: string } } | null;
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

  function getPrimaryStore(indexer: Indexer): { save: () => void } {
    const internals = getIndexerInternals(indexer);
    const modelId = internals.primaryStoreModelId ?? internals.configuredProviderInfo.modelInfo.model;
    const store = internals.stores.get(modelId);
    if (!store) {
      throw new Error(`Missing primary store for model ${modelId}`);
    }
    return store;
  }

  async function getCurrentRuntimeConfig(indexer: Indexer): Promise<ConfigVersion> {
    const { configuredProviderInfo, voyageProvider } = getIndexerInternals(indexer);
    return getCurrentConfigVersion(
      configuredProviderInfo,
      voyageProvider?.getModelInfo().model ?? null
    );
  }

  async function createFreshIndexer(overrides: Record<string, unknown> = {}): Promise<Indexer> {
    vi.resetModules();
    const { Indexer: FreshIndexer } = await import("../src/indexer/index.js");
    return new FreshIndexer(tempDir, createConfig(overrides)) as unknown as Indexer;
  }

  async function primeIndexerForCrossModelRebuild(indexer: Indexer): Promise<void> {
    await indexer.getStatus();
    (
      getIndexerInternals(indexer) as {
        indexCompatibility?: { compatible: boolean } | null;
      }
    ).indexCompatibility = { compatible: true };
  }

  function buildExactChunkQuery(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    const chunks = chunkFile(filePath, "typescript", content, {
      targetTokenBudget: 512,
      maxChunkChars: 2000,
      minChunkChars: 400,
      mergeSmallSiblings: true,
      attachComments: true,
      emitCoarseChunks: true,
    }).filter((chunk) => chunk.granularity === "Fine");
    const targetChunk = chunks[0];
    if (!targetChunk) {
      throw new Error(`Expected at least one fine chunk for ${filePath}`);
    }
    return prepareEmbeddingInput(
      {
        content: targetChunk.text,
        startLine: targetChunk.startLine,
        endLine: targetChunk.endLine,
        chunkType: "other",
        name: targetChunk.symbolName,
        symbolKind: targetChunk.symbolKind,
        language: targetChunk.language,
      },
      filePath,
      tempDir,
      8_192
    ).text;
  }

  function seedBranchAppliedConfig(
    database: Database,
    branch: string,
    configHash: string,
    configVersion: ConfigVersion,
    createdAt: number = Date.now() - 1
  ): void {
    database.activateConfigVersion({
      configHash,
      embeddingModelId: configVersion.embeddingModelId,
      embeddingDimension: configVersion.embeddingDimension,
      voyageModelId: configVersion.voyageModelId,
      embeddingPrefixVersion: configVersion.embeddingPrefixVersion,
      chunkerVersion: configVersion.chunkerVersion,
      graphExtractorVersion: configVersion.graphExtractorVersion,
      active: true,
      createdAt,
    });
    database.upsertBranchConfigVersion({
      branch,
      configHash,
      appliedAt: createdAt,
    });
  }

  function createEmptyStats(): {
    totalFiles: number;
    totalChunks: number;
    indexedChunks: number;
    failedChunks: number;
    tokensUsed: number;
    durationMs: number;
    existingChunks: number;
    removedChunks: number;
    skippedFiles: [];
    parseFailures: [];
  } {
    return {
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };
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

  it("delegates public indexing entrypoints to the orchestrator", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { orchestrator } = getIndexerInternals(indexer);
    const coldStartSpy = vi.spyOn(orchestrator, "coldStart").mockResolvedValue(createEmptyStats());
    const hotUpdateSpy = vi.spyOn(orchestrator, "hotUpdate").mockResolvedValue(createEmptyStats());
    const branchSpy = vi.spyOn(orchestrator, "handleBranchChange").mockResolvedValue(undefined);

    await indexer.index();
    expect(coldStartSpy).toHaveBeenCalledTimes(1);

    fs.writeFileSync(fileA, "export function alpha(): number { return 42; }\n", "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: fileA }]);
    expect(hotUpdateSpy).toHaveBeenCalledTimes(1);

    await indexer.indexDirtySet(
      {
        changedFiles: ["src/alpha.ts"],
        addedFiles: [],
        removedFiles: [],
      },
      undefined,
      null
    );
    expect(hotUpdateSpy).toHaveBeenCalledTimes(2);
    expect(hotUpdateSpy).toHaveBeenLastCalledWith(
      {
        changedFiles: ["src/alpha.ts"],
        addedFiles: [],
        removedFiles: [],
      },
      undefined,
      null
    );

    await indexer.handleBranchChange("main", "feature");
    expect(branchSpy).toHaveBeenCalledWith("main", "feature");

    coldStartSpy.mockRestore();
    hotUpdateSpy.mockRestore();
    branchSpy.mockRestore();
  });

  it("delegates search() to searchDetailed() and keeps searchDetailed on the retrieval path", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    const { orchestrator } = getIndexerInternals(indexer);
    const coldStartSpy = vi.spyOn(orchestrator, "coldStart");
    const hotUpdateSpy = vi.spyOn(orchestrator, "hotUpdate");
    const branchSpy = vi.spyOn(orchestrator, "handleBranchChange");

    const detailedSpy = vi.spyOn(indexer, "searchDetailed").mockResolvedValue({
      primaryResults: [
        {
          filePath: "src/alpha.ts",
          startLine: 1,
          endLine: 1,
          content: "export function alpha(): number { return 1; }",
          score: 1,
          chunkType: "function",
          name: "alpha",
        },
      ],
      expandedContext: [],
      taskType: "general",
      reranker: {
        applied: false,
        backend: null,
      },
    });

    await expect(indexer.search("alpha", 1, { metadataOnly: true })).resolves.toEqual([
      {
        filePath: "src/alpha.ts",
        startLine: 1,
        endLine: 1,
        content: "export function alpha(): number { return 1; }",
        score: 1,
        chunkType: "function",
        name: "alpha",
      },
    ]);
    expect(detailedSpy).toHaveBeenCalledWith("alpha", 1, { metadataOnly: true });
    detailedSpy.mockRestore();

    const response = await indexer.searchDetailed("", 5);
    expect(response).toEqual({
      primaryResults: [],
      expandedContext: [],
      taskType: "general",
      graphDirection: "both",
      timings: {
        prefilterMs: 0,
      },
      reranker: {
        applied: false,
        backend: null,
      },
      retrieval: {
        voyageLaneConfigured: false,
        voyageLaneUsed: false,
      },
    });
    expect(coldStartSpy).not.toHaveBeenCalled();
    expect(hotUpdateSpy).not.toHaveBeenCalled();
    expect(branchSpy).not.toHaveBeenCalled();

    coldStartSpy.mockRestore();
    hotUpdateSpy.mockRestore();
    branchSpy.mockRestore();
  });

  it("reuses a singleton Indexer instance for the same repo path and config", () => {
    createRepo();
    const config = createConfig();
    const first = new Indexer(tempDir, config);
    const second = new Indexer(tempDir, createConfig());
    expect(second).toBe(first);
  });

  it("reuses the same singleton Indexer instance when construction happens concurrently", async () => {
    createRepo();

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => new Indexer(tempDir, createConfig())),
      Promise.resolve().then(() => new Indexer(tempDir, createConfig())),
    ]);

    expect(second).toBe(first);
  });

  it("completes a cold start on an empty repo and commits a valid empty snapshot", async () => {
    const indexer = new Indexer(tempDir, createConfig());
    let coldStartRunId: string | null = null;
    const originalStartPipelineRun = Database.prototype.startPipelineRun;
    const runSpy = vi
      .spyOn(Database.prototype, "startPipelineRun")
      .mockImplementation(function (run, cancelledAt) {
        if (run.runType === "cold_start" && coldStartRunId === null) {
          coldStartRunId = run.runId;
        }
        return originalStartPipelineRun.call(this, run, cancelledAt);
      });

    const stats = await indexer.index();
    runSpy.mockRestore();

    expect(stats.totalFiles).toBe(0);
    expect(coldStartRunId).toBeTruthy();

    const { branch, database } = await openDatabase(indexer);
    const snapshot = database.getMerkleSnapshot(branch);
    expect(snapshot).toBeTruthy();
    expect(database.getPipelineRun(coldStartRunId ?? "")?.status).toBe("complete");

    const parsed = JSON.parse(snapshot ?? "{}") as {
      branch?: string;
      nodes?: Record<string, { kind?: string }>;
    };
    expect(parsed.branch).toBe(branch);
    const fileNodes = Object.values(parsed.nodes ?? {}).filter((node) => node.kind === "file");
    expect(fileNodes).toHaveLength(0);
  });

  it("completes cold start end to end across multiple languages and persists all durable artifacts", async () => {
    const files = createMultiLanguageRepo();
    const indexer = new Indexer(tempDir, createConfig());
    let coldStartRunId: string | null = null;
    const originalStartPipelineRun = Database.prototype.startPipelineRun;
    const runSpy = vi
      .spyOn(Database.prototype, "startPipelineRun")
      .mockImplementation(function (run, cancelledAt) {
        if (run.runType === "cold_start" && coldStartRunId === null) {
          coldStartRunId = run.runId;
        }
        return originalStartPipelineRun.call(this, run, cancelledAt);
      });

    const stats = await indexer.index();
    runSpy.mockRestore();
    expect(stats.totalFiles).toBe(files.length);
    expect(coldStartRunId).toBeTruthy();

    const status = await indexer.getStatus();
    const branch = status.currentBranch;
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const branchChunkIds = new Set(database.getBranchChunkIds(branch));

    for (const file of files) {
      const trackedPath = resolveTrackedPath(database, branch, file.filePath, tempDir);
      for (const stage of ["chunk", "embed", "index", "graph"] as const) {
        expect(database.getPipelineState(branch, trackedPath, stage)).toMatchObject({
          branch,
          filePath: trackedPath,
          stage,
          status: "complete",
        });
        expect(database.getPipelineState(branch, trackedPath, stage)?.inputHash).toBeTruthy();
      }

      const branchChunksForFile = database
        .getChunksByFile(trackedPath)
        .filter((chunk) => branchChunkIds.has(chunk.chunkId));
      expect(branchChunksForFile).toHaveLength(
        chunkFile(file.filePath, file.language, file.content).length
      );
    }

    expect(database.getMerkleSnapshot(branch)).toBeTruthy();
    expect(database.getPipelineRun(coldStartRunId ?? "")?.status).toBe("complete");

    const fileHashCachePath = getFileHashCachePath(status.indexPath, branch);
    expect(fs.existsSync(fileHashCachePath)).toBe(true);
    const persistedFileHashCache = JSON.parse(
      fs.readFileSync(fileHashCachePath, "utf-8")
    ) as Record<string, string>;
    for (const file of files) {
      expect(persistedFileHashCache[fs.realpathSync(file.filePath)]).toBe(hashContent(file.content));
    }
  });

  it("handles cold start, hot update, and branch change correctly for a single-file repo", async () => {
    const filePath = createSingleFileRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    const mainTrackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, mainTrackedPath, stage)?.status).toBe("complete");
    }
    const initialChunks = database.getChunksByFile(mainTrackedPath);
    expect(initialChunks.some((chunk) => chunk.chunkKind !== undefined)).toBe(true);
    expect(initialChunks.some((chunk) => chunk.symbolKind !== undefined)).toBe(true);

    const changedContent = "export function only(): number { return 2; }\n";
    fs.writeFileSync(filePath, changedContent, "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: filePath }]);

    ({ branch, database } = await openDatabase(indexer));
    expect(
      getSnapshotFileHash(database.getMerkleSnapshot(branch) ?? "", relativeToRepo(filePath))
    ).toBe(hashContent(changedContent));

    const { orchestrator } = getIndexerInternals(indexer);
    const coldStartSpy = vi.spyOn(orchestrator, "coldStart");
    const hotUpdateSpy = vi.spyOn(orchestrator, "hotUpdate");

    await indexer.handleBranchChange(branch, "feature");

    expect(coldStartSpy).toHaveBeenCalledTimes(1);
    expect(hotUpdateSpy).not.toHaveBeenCalled();

    const featureTrackedPath = resolveTrackedPath(database, "feature", filePath, tempDir);
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState("feature", featureTrackedPath, stage)?.status).toBe("complete");
    }
    expect(database.getMerkleSnapshot("feature")).toBeTruthy();

    coldStartSpy.mockRestore();
    hotUpdateSpy.mockRestore();
  });

  it("force rebuild clears control-plane tables and rebuilds cold start, hot update, and branch change from scratch", async () => {
    const graphFile = createGraphRepo();
    const extraFile = path.join(tempDir, "src", "helper.ts");
    fs.writeFileSync(extraFile, "export function helper(): number { return 7; }\n", "utf-8");

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    const trackedGraph = resolveTrackedPath(database, branch, graphFile, tempDir);
    const trackedExtra = resolveTrackedPath(database, branch, extraFile, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const staleRunId = "force-rebuild-stale-run";
    const staleCreatedAt = 123;

    expect(database.getStats().chunkCount).toBeGreaterThan(0);
    expect(database.getStats().embeddingCount).toBeGreaterThan(0);
    expect(database.getStats().symbolCount).toBeGreaterThan(0);
    expect(database.getStats().callEdgeCount).toBeGreaterThan(0);

    database.startPipelineRun(
      {
        runId: staleRunId,
        branch,
        runType: "hot_update",
        status: "in_progress",
        configHash: "stale-run-config",
        startedAt: Date.now(),
      },
      Date.now()
    );
    database.activateConfigVersion({
      configHash: "force-rebuild-stale-config",
      embeddingModelId: currentConfig.embeddingModelId,
      embeddingDimension: currentConfig.embeddingDimension,
      voyageModelId: currentConfig.voyageModelId,
      embeddingPrefixVersion: currentConfig.embeddingPrefixVersion,
      chunkerVersion: currentConfig.chunkerVersion,
      graphExtractorVersion: currentConfig.graphExtractorVersion,
      active: true,
      createdAt: staleCreatedAt,
    });

    await indexer.clearIndex();

    ({ branch, database } = await openDatabase(indexer));
    expect(database.getStats()).toEqual({
      embeddingCount: 0,
      chunkCount: 0,
      branchChunkCount: 0,
      branchCount: 0,
      symbolCount: 0,
      callEdgeCount: 0,
    });
    expect(database.getMerkleSnapshot(branch)).toBeNull();
    expect(database.getKnownPipelineFiles(branch)).toEqual([]);
    expect(database.getPipelineRun(staleRunId)).toBeNull();
    expect(database.getActiveConfigVersion()).toBeNull();
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, trackedGraph, stage)).toBeNull();
      expect(database.getPipelineState(branch, trackedExtra, stage)).toBeNull();
    }

    const coldStartSpy = vi.spyOn(getIndexerInternals(indexer).orchestrator, "coldStart");
    await indexer.index();
    expect(coldStartSpy).toHaveBeenCalledTimes(1);
    coldStartSpy.mockRestore();

    ({ branch, database } = await openDatabase(indexer));
    const rebuiltTrackedGraph = resolveTrackedPath(database, branch, graphFile, tempDir);
    const rebuiltTrackedExtra = resolveTrackedPath(database, branch, extraFile, tempDir);
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, rebuiltTrackedGraph, stage)?.status).toBe("complete");
      expect(database.getPipelineState(branch, rebuiltTrackedExtra, stage)?.status).toBe("complete");
    }
    expect(database.getStats().chunkCount).toBeGreaterThan(0);
    expect(database.getStats().embeddingCount).toBeGreaterThan(0);
    expect(database.getStats().symbolCount).toBeGreaterThan(0);
    expect(database.getStats().callEdgeCount).toBeGreaterThan(0);
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      active: true,
    });
    expect(database.getActiveConfigVersion()?.createdAt).not.toBe(staleCreatedAt);

    const beforeHotUpdateEmbed = database.getPipelineState(
      branch,
      rebuiltTrackedExtra,
      "embed"
    )?.updatedAt ?? 0;
    fs.writeFileSync(extraFile, "export function helper(): number { return 8; }\n", "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: extraFile }]);

    ({ branch, database } = await openDatabase(indexer));
    const hotUpdatedTrackedExtra = resolveTrackedPath(database, branch, extraFile, tempDir);
    expect(database.getPipelineState(branch, hotUpdatedTrackedExtra, "embed")?.updatedAt).toBeGreaterThan(
      beforeHotUpdateEmbed
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const branchColdStartSpy = vi.spyOn(orchestrator, "coldStart");
    const branchHotUpdateSpy = vi.spyOn(orchestrator, "hotUpdate");
    await indexer.handleBranchChange(branch, "force-rebuild-feature");

    expect(branchColdStartSpy).toHaveBeenCalledTimes(1);
    expect(branchHotUpdateSpy).not.toHaveBeenCalled();
    branchColdStartSpy.mockRestore();
    branchHotUpdateSpy.mockRestore();

    ({ database } = await openDatabase(indexer));
    expect(database.getMerkleSnapshot("force-rebuild-feature")).toBeTruthy();
  });

  it("force rebuild reruns GRAPH and recreates call edges instead of skipping the stage", async () => {
    const filePath = createGraphRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    expect(database.getPipelineState(branch, trackedPath, "graph")?.status).toBe("complete");
    const callersBefore = database.getCallers("callee", branch);
    expect(callersBefore.length).toBeGreaterThan(0);

    await indexer.clearIndex();

    ({ branch, database } = await openDatabase(indexer));
    expect(database.getPipelineState(branch, trackedPath, "graph")).toBeNull();
    expect(database.getCallers("callee", branch)).toHaveLength(0);

    await indexer.index();

    ({ branch, database } = await openDatabase(indexer));
    const rebuiltTrackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    expect(database.getPipelineState(branch, rebuiltTrackedPath, "graph")?.status).toBe("complete");
    const callersAfter = database.getCallers("callee", branch);
    expect(callersAfter.length).toBeGreaterThan(0);
    expect(callersAfter.every((edge) => edge.branch === branch)).toBe(true);
  });

  it("force rebuild clears stale config versions before cold start activates a fresh one", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { database } = await openDatabase(indexer);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const staleCreatedAt = 42;
    database.activateConfigVersion({
      configHash: "force-rebuild-stale-config",
      embeddingModelId: currentConfig.embeddingModelId,
      embeddingDimension: currentConfig.embeddingDimension,
      voyageModelId: currentConfig.voyageModelId,
      embeddingPrefixVersion: currentConfig.embeddingPrefixVersion,
      chunkerVersion: currentConfig.chunkerVersion,
      graphExtractorVersion: currentConfig.graphExtractorVersion,
      active: true,
      createdAt: staleCreatedAt,
    });
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: "force-rebuild-stale-config",
      createdAt: staleCreatedAt,
    });

    await indexer.clearIndex();

    ({ database } = await openDatabase(indexer));
    expect(database.getActiveConfigVersion()).toBeNull();

    await indexer.index();

    ({ database } = await openDatabase(indexer));
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      embeddingModelId: currentConfig.embeddingModelId,
      active: true,
    });
    expect(database.getActiveConfigVersion()?.createdAt).not.toBe(staleCreatedAt);
  });

  it("migrates an inactive branch on zero-diff switch after the embedding config changes", async () => {
    const { mainBranch, featureBranch, featureFile, checkoutMain, checkoutFeature } =
      createBranchDivergenceRepo();
    const legacyIndexer = new Indexer(tempDir, createConfig());
    await legacyIndexer.index();

    checkoutFeature();
    await legacyIndexer.handleBranchChange(mainBranch, featureBranch);
    checkoutMain();
    await legacyIndexer.handleBranchChange(featureBranch, mainBranch);

    const migratedIndexer = await createFreshIndexer({
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "updated-model-id",
        dimensions: 8,
      },
    });
    await primeIndexerForCrossModelRebuild(migratedIndexer);
    await migratedIndexer.index();

    let { database } = await openDatabase(migratedIndexer);
    const currentConfigHash = hashConfigVersion(await getCurrentRuntimeConfig(migratedIndexer));
    const featureTrackedPathBefore = resolveTrackedRelativePath(
      database,
      featureBranch,
      relativeToRepo(featureFile)
    );
    const beforeFeatureEmbed = database.getPipelineState(
      featureBranch,
      featureTrackedPathBefore,
      "embed"
    );
    const beforeFeatureIndex = database.getPipelineState(
      featureBranch,
      featureTrackedPathBefore,
      "index"
    );

    expect(database.getBranchConfigVersion(featureBranch)?.configHash).not.toBe(currentConfigHash);

    await new Promise((resolve) => setTimeout(resolve, 2));
    checkoutFeature();
    await migratedIndexer.handleBranchChange(mainBranch, featureBranch);

    ({ database } = await openDatabase(migratedIndexer));
    const featureTrackedPathAfter = resolveTrackedRelativePath(
      database,
      featureBranch,
      relativeToRepo(featureFile)
    );
    expect(database.getPipelineState(featureBranch, featureTrackedPathAfter, "embed")?.updatedAt)
      .toBeGreaterThan(beforeFeatureEmbed?.updatedAt ?? 0);
    expect(database.getPipelineState(featureBranch, featureTrackedPathAfter, "index")?.updatedAt)
      .toBeGreaterThan(beforeFeatureIndex?.updatedAt ?? 0);
    expect(database.getBranchConfigVersion(featureBranch)?.configHash).toBe(currentConfigHash);

    const results = await migratedIndexer.search(buildExactChunkQuery(featureFile), 5, {
      filterByBranch: true,
      hybridWeight: 0,
    });
    expect(
      results.some((result) => searchResultMatchesFile(result.filePath, "src/feature-only.ts"))
    ).toBe(true);
  });

  it("persists stale branch config drift across restart and reindexes on a zero-diff switch", async () => {
    const { mainBranch, featureBranch, featureFile, checkoutMain, checkoutFeature } =
      createBranchDivergenceRepo();
    const legacyIndexer = new Indexer(tempDir, createConfig());
    await legacyIndexer.index();

    checkoutFeature();
    await legacyIndexer.handleBranchChange(mainBranch, featureBranch);
    checkoutMain();
    await legacyIndexer.handleBranchChange(featureBranch, mainBranch);

    const mainMigrationIndexer = await createFreshIndexer({
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "updated-model-id",
        dimensions: 8,
      },
    });
    await primeIndexerForCrossModelRebuild(mainMigrationIndexer);
    await mainMigrationIndexer.index();

    const restartedIndexer = await createFreshIndexer({
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "updated-model-id",
        dimensions: 8,
      },
    });

    let { database } = await openDatabase(restartedIndexer);
    const currentConfigHash = hashConfigVersion(await getCurrentRuntimeConfig(restartedIndexer));
    const featureTrackedPathBefore = resolveTrackedRelativePath(
      database,
      featureBranch,
      relativeToRepo(featureFile)
    );
    const beforeFeatureEmbed = database.getPipelineState(
      featureBranch,
      featureTrackedPathBefore,
      "embed"
    );

    expect(database.getBranchConfigVersion(featureBranch)?.configHash).not.toBe(currentConfigHash);

    await new Promise((resolve) => setTimeout(resolve, 2));
    checkoutFeature();
    await restartedIndexer.handleBranchChange(mainBranch, featureBranch);

    ({ database } = await openDatabase(restartedIndexer));
    const featureTrackedPathAfter = resolveTrackedRelativePath(
      database,
      featureBranch,
      relativeToRepo(featureFile)
    );
    expect(database.getPipelineState(featureBranch, featureTrackedPathAfter, "embed")?.updatedAt)
      .toBeGreaterThan(beforeFeatureEmbed?.updatedAt ?? 0);
    expect(database.getBranchConfigVersion(featureBranch)?.configHash).toBe(currentConfigHash);

    const results = await restartedIndexer.search(buildExactChunkQuery(featureFile), 5, {
      filterByBranch: true,
      hybridWeight: 0,
    });
    expect(
      results.some((result) => searchResultMatchesFile(result.filePath, "src/feature-only.ts"))
    ).toBe(true);
  });

  it("reruns only GRAPH on a zero-diff branch switch when just the graph extractor version drifted", async () => {
    const { mainBranch, featureBranch, featureFile, checkoutMain, checkoutFeature } =
      createBranchDivergenceRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    checkoutFeature();
    await indexer.handleBranchChange(mainBranch, featureBranch);
    checkoutMain();
    await indexer.handleBranchChange(featureBranch, mainBranch);

    const { database } = await openDatabase(indexer);
    const featureTrackedPath = resolveTrackedRelativePath(
      database,
      featureBranch,
      relativeToRepo(featureFile)
    );
    const beforeChunk = database.getPipelineState(featureBranch, featureTrackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(featureBranch, featureTrackedPath, "embed");
    const beforeGraph = database.getPipelineState(featureBranch, featureTrackedPath, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const currentConfigHash = hashConfigVersion(currentConfig);
    const staleGraphConfig = {
      ...currentConfig,
      graphExtractorVersion: "stale-graph-version",
    };

    seedBranchAppliedConfig(
      database,
      featureBranch,
      hashConfigVersion(staleGraphConfig),
      staleGraphConfig
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;

    await new Promise((resolve) => setTimeout(resolve, 2));
    checkoutFeature();
    await indexer.handleBranchChange(mainBranch, featureBranch);

    expect(database.getPipelineState(featureBranch, featureTrackedPath, "chunk")?.updatedAt).toBe(
      beforeChunk?.updatedAt
    );
    expect(database.getPipelineState(featureBranch, featureTrackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
    expect(database.getPipelineState(featureBranch, featureTrackedPath, "graph")?.updatedAt)
      .toBeGreaterThan(beforeGraph?.updatedAt ?? 0);
    expect(database.getBranchConfigVersion(featureBranch)?.configHash).toBe(currentConfigHash);
  });

  it("treats unchanged file notifications as a zero-cost hot update", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeAChunk = database.getPipelineState(branch, trackedA, "chunk");
    const beforeAEmbed = database.getPipelineState(branch, trackedA, "embed");
    const beforeBChunk = database.getPipelineState(branch, trackedB, "chunk");
    const beforeBEmbed = database.getPipelineState(branch, trackedB, "embed");
    const beforeSnapshot = database.getMerkleSnapshot(branch);
    const fetchCountBefore = fetchSpy.mock.calls.length;

    await indexer.handleFileChanges([
      { type: "change", path: fileA },
      { type: "change", path: fileB },
    ]);

    expect(fetchSpy.mock.calls.length).toBe(fetchCountBefore);
    expect(database.getPipelineState(branch, trackedA, "chunk")?.updatedAt).toBe(beforeAChunk?.updatedAt);
    expect(database.getPipelineState(branch, trackedA, "embed")?.updatedAt).toBe(beforeAEmbed?.updatedAt);
    expect(database.getPipelineState(branch, trackedB, "chunk")?.updatedAt).toBe(beforeBChunk?.updatedAt);
    expect(database.getPipelineState(branch, trackedB, "embed")?.updatedAt).toBe(beforeBEmbed?.updatedAt);
    expect(database.getMerkleSnapshot(branch)).toBe(beforeSnapshot);
  });

  it("removes files deleted since the last run during cold start", async () => {
    const { fileA, fileB, fileC } = createRepoWithThreeFiles();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const trackedC = resolveTrackedPath(database, branch, fileC, tempDir);
    const initialBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    const deletedFileChunkIds = database
      .getChunksByFile(trackedB)
      .filter((chunk) => initialBranchChunkIds.has(chunk.chunkId))
      .map((chunk) => chunk.chunkId);

    expect(deletedFileChunkIds.length).toBeGreaterThan(0);

    fs.unlinkSync(fileB);
    await indexer.index();

    const updatedBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    for (const chunkId of deletedFileChunkIds) {
      expect(updatedBranchChunkIds.has(chunkId)).toBe(false);
    }
    expect(database.getChunksByFile(trackedB)).toHaveLength(0);
    expect(database.getKnownPipelineFiles(branch)).not.toContain(trackedB);
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, trackedB, stage)).toBeNull();
      expect(database.getPipelineState(branch, trackedA, stage)?.status).toBe("complete");
      expect(database.getPipelineState(branch, trackedC, stage)?.status).toBe("complete");
    }

    const remainingAChunks = database
      .getChunksByFile(trackedA)
      .filter((chunk) => updatedBranchChunkIds.has(chunk.chunkId));
    const remainingCChunks = database
      .getChunksByFile(trackedC)
      .filter((chunk) => updatedBranchChunkIds.has(chunk.chunkId));
    expect(remainingAChunks.length).toBeGreaterThan(0);
    expect(remainingCChunks.length).toBeGreaterThan(0);
  });

  it("preserves other-branch chunk references when cold start removes a deleted file", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch: mainBranch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, mainBranch, fileA, tempDir);
    const mainBranchChunkIds = new Set(database.getBranchChunkIds(mainBranch));
    const fileChunkIds = database
      .getChunksByFile(trackedPath)
      .filter((chunk) => mainBranchChunkIds.has(chunk.chunkId))
      .map((chunk) => chunk.chunkId);

    expect(fileChunkIds.length).toBeGreaterThan(0);

    await indexer.handleBranchChange(mainBranch, "feature");
    const featureBranchChunkIds = new Set(database.getBranchChunkIds("feature"));
    for (const chunkId of fileChunkIds) {
      expect(featureBranchChunkIds.has(chunkId)).toBe(true);
    }

    await indexer.handleBranchChange("feature", mainBranch);
    fs.unlinkSync(fileA);
    await indexer.index();

    const updatedMainBranchChunkIds = new Set(database.getBranchChunkIds(mainBranch));
    const updatedFeatureBranchChunkIds = new Set(database.getBranchChunkIds("feature"));
    for (const chunkId of fileChunkIds) {
      expect(updatedMainBranchChunkIds.has(chunkId)).toBe(false);
      expect(updatedFeatureBranchChunkIds.has(chunkId)).toBe(true);
    }
    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(mainBranch, trackedPath, stage)).toBeNull();
      expect(database.getPipelineState("feature", trackedPath, stage)?.status).toBe("complete");
    }
  });

  it("processes high priority jobs before remaining cold-start batches", async () => {
    const lowFiles = createLargeRepo(60);
    const urgentFile = path.join(tempDir, "src", "urgent.ts");
    const indexer = new Indexer(tempDir, createConfig());
    const { orchestrator } = getIndexerInternals(indexer);
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "high";
        trigger: "watcher_event";
        runId: string;
      }) => string;
    };

    const processedFiles: string[] = [];
    let injected = false;
    let coldStartJobsSeen = 0;
    const originalProcessJob = orchestrator.processJob.bind(orchestrator);
    const processSpy = vi
      .spyOn(orchestrator, "processJob")
      .mockImplementation(async (context: any, job: any) => {
        processedFiles.push(path.basename(job.filePath));
        if (!injected && job.trigger === "cold_start") {
          coldStartJobsSeen += 1;
          if (coldStartJobsSeen === 10) {
            fs.writeFileSync(
              urgentFile,
              "export function urgent(): number { return 999; }\n",
              "utf-8"
            );
            queue.enqueue({
              branch: context.branch,
              filePath: urgentFile,
              priority: "high",
              trigger: "watcher_event",
              runId: context.runId,
            });
            injected = true;
          }
        }
        return originalProcessJob(context, job);
      });

    await indexer.index();
    processSpy.mockRestore();

    expect(injected).toBe(true);
    expect(processedFiles.indexOf("urgent.ts")).toBeGreaterThan(-1);
    expect(processedFiles.indexOf(path.basename(lowFiles[55] ?? ""))).toBeGreaterThan(-1);
    expect(processedFiles.indexOf("urgent.ts")).toBeLessThan(
      processedFiles.indexOf(path.basename(lowFiles[55] ?? ""))
    );

    const { branch, database } = await openDatabase(indexer);
    const trackedUrgent = resolveTrackedPath(database, branch, urgentFile, tempDir);
    expect(database.getPipelineState(branch, trackedUrgent, "index")?.status).toBe("complete");
  });

  it("wires the full hot update path end to end through handleFileChanges", async () => {
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
    recordWatcherEventTimestamp(fileA, Date.now() - 100);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const changedContent = "export function alpha(): number { return 11; }\n";
    fs.writeFileSync(fileA, changedContent, "utf-8");
    await indexer.handleFileChanges([{ type: "change", path: fileA }]);

    const afterAChunk = database.getPipelineState(branch, trackedA, "chunk");
    const afterAEmbed = database.getPipelineState(branch, trackedA, "embed");
    const afterAIndex = database.getPipelineState(branch, trackedA, "index");
    const afterAGraph = database.getPipelineState(branch, trackedA, "graph");
    const afterBChunk = database.getPipelineState(branch, trackedB, "chunk");

    expect(afterAChunk?.updatedAt).toBeGreaterThan(beforeA?.updatedAt ?? 0);
    expect(afterAEmbed?.status).toBe("complete");
    expect(afterAIndex?.status).toBe("complete");
    expect(afterAGraph?.status).toBe("complete");
    expect(afterBChunk?.updatedAt).toBe(beforeB?.updatedAt);
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(hashContent(changedContent));
    expect(indexer.getLogger().getMetrics().hotUpdateTtiCount).toBeGreaterThan(0);
    expect(indexer.getLogger().getMetrics().hotUpdateTtiLastMs).toBeGreaterThan(0);

    const hotUpdateCalls = fetchSpy.mock.calls.slice(initialFetchCount);
    expect(hotUpdateCalls.length).toBe(1);
    const requestBody = JSON.parse(String(hotUpdateCalls[0]?.[1]?.body ?? "{}")) as {
      input?: string[];
    };
    expect(requestBody.input?.length).toBe(1);
    expect(requestBody.input?.[0]).toContain("alpha");
  });

  it("isolates partial failure during hot update and retries the unfinished file on the next pass", async () => {
    const { fileA, fileB, fileC } = createRepoWithThreeFiles();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const trackedC = resolveTrackedPath(database, branch, fileC, tempDir);
    const oldSnapshot = database.getMerkleSnapshot(branch) ?? "";
    const oldAHash = getSnapshotFileHash(oldSnapshot, relativeToRepo(fileA));

    const changedA = "export function alpha(): number { return 101; }\n";
    const changedB = "export function beta(): number { return 202; }\n";
    fs.writeFileSync(fileA, changedA, "utf-8");
    fs.writeFileSync(fileB, changedB, "utf-8");

    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      if (texts.some((text) => text.includes("alpha"))) {
        throw new Error("forced hot update embed failure");
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

    await indexer.handleFileChanges([
      { type: "change", path: fileA },
      { type: "change", path: fileB },
    ]);

    expect(database.getPipelineState(branch, trackedA, "embed")?.status).toBe("failed");
    expect(database.getPipelineState(branch, trackedB, "index")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedB, "graph")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedC, "chunk")?.status).toBe("complete");
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(oldAHash);
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileB)
      )
    ).toBe(hashContent(changedB));
    expect(database.getUnfinishedPipelineFiles(branch)).toContain(trackedA);
    expect(database.getUnfinishedPipelineFiles(branch)).not.toContain(trackedB);

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

    await indexer.handleFileChanges([{ type: "change", path: fileA }]);

    expect(database.getPipelineState(branch, trackedA, "embed")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedA, "index")?.status).toBe("complete");
    expect(
      getSnapshotFileHash(
        database.getMerkleSnapshot(branch) ?? "",
        relativeToRepo(fileA)
      )
    ).toBe(hashContent(changedA));
    expect(database.getUnfinishedPipelineFiles(branch)).not.toContain(trackedA);
  });

  it("records hot update TTI from watcher event arrival to index completion", async () => {
    const { fileA } = createRepo();
    const config = createConfig({
      debug: {
        enabled: true,
        logLevel: "debug",
        metrics: true,
      },
      indexing: {
        watchFiles: true,
      },
    });
    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    fs.writeFileSync(fileA, "export function alpha(): number { return 77; }\n", "utf-8");
    const { branch, database } = await openDatabase(indexer);
    const baseSnapshot = database.getMerkleSnapshot(branch);
    const nextSnapshot = await buildMerkleSnapshot(
      tempDir,
      branch,
      getIndexerInternals(indexer).buildMerkleIgnoreRules()
    );
    recordWatcherEventTimestamp(fileA, Date.now() - 100);

    await indexer.indexDirtySet(
      {
        changedFiles: [relativeToRepo(fileA)],
        addedFiles: [],
        removedFiles: [],
      },
      nextSnapshot.snapshot,
      baseSnapshot
    );

    const metrics = indexer.getLogger().getMetrics();
    expect(metrics.hotUpdateTtiCount).toBeGreaterThan(0);
    expect(metrics.hotUpdateTtiLastMs).toBeGreaterThan(0);
    expect(metrics.hotUpdateTtiLastMs).toBeLessThan(5000);
    expect(metrics.hotUpdateTtiMaxMs).toBeGreaterThanOrEqual(metrics.hotUpdateTtiLastMs);
    expect(metrics.hotUpdateTtiOverTargetCount).toBeLessThanOrEqual(metrics.hotUpdateTtiCount);
    expect(TTI_TARGET_MS).toBe(2000);
  });

  it("logs a warning when hot update TTI exceeds the target", async () => {
    const { fileA } = createRepo();
    const config = createConfig({
      debug: {
        enabled: true,
        logLevel: "debug",
        metrics: true,
      },
    });
    const indexer = new Indexer(tempDir, config);
    await indexer.index();
    indexer.getLogger().clearLogs();

    fs.writeFileSync(fileA, "export function alpha(): number { return 88; }\n", "utf-8");
    recordWatcherEventTimestamp(fileA, Date.now() - (TTI_TARGET_MS + 250));

    await indexer.handleFileChanges([{ type: "change", path: fileA }]);

    const ttiWarnings = indexer
      .getLogger()
      .getLogsByLevel("warn")
      .filter((entry) => entry.message === "Hot update TTI exceeded target");
    expect(ttiWarnings.length).toBeGreaterThan(0);
    expect(ttiWarnings[0]?.data?.targetMs).toBe(TTI_TARGET_MS);
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
    const config = createConfig({
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 2,
      },
    });
    const chunks: OrchestratorParsedChunk[] = [
      {
        content: "anonymous prelude",
        startLine: 1,
        endLine: 20,
        startByte: 0,
        endByte: 160,
        chunkType: "other",
        language: "typescript",
        chunkHash: "anon-1",
      },
      {
        content: "export function namedOne() { return 1; }",
        startLine: 21,
        endLine: 30,
        startByte: 161,
        endByte: 220,
        chunkType: "function",
        name: "namedOne",
        language: "typescript",
        chunkHash: "named-1",
      },
      {
        content: "another anonymous bridge",
        startLine: 31,
        endLine: 50,
        startByte: 221,
        endByte: 320,
        chunkType: "other",
        language: "typescript",
        chunkHash: "anon-2",
      },
      {
        content: "export const NAMED_TWO = 2;",
        startLine: 51,
        endLine: 55,
        startByte: 321,
        endByte: 360,
        chunkType: "constant",
        name: "NAMED_TWO",
        language: "typescript",
        chunkHash: "named-2",
      },
    ];

    const filtered = applyChunkFilters(chunks, config);

    expect(filtered.capped).toBe(true);
    expect(filtered.chunks.map((chunk) => chunk.name ?? "<anonymous>")).toEqual([
      "namedOne",
      "NAMED_TWO",
    ]);
    expect(filtered.droppedNamedCount).toBe(0);
    expect(filtered.droppedAnonymousCount).toBe(2);
  });

  it("logs a warning when the per-file chunk cap drops chunks", async () => {
    const filePath = createChunkyRepo();
    const config = createConfig({
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 1,
      },
      debug: {
        enabled: true,
        logLevel: "debug",
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
    const filtered = applyChunkFilters(parsed?.chunks ?? [], config);

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    const branchChunkIds = new Set(database.getBranchChunkIds(branch));
    const branchChunksForFile = database
      .getChunksByFile(trackedPath)
      .filter((chunk) => branchChunkIds.has(chunk.chunkId));

    expect(branchChunksForFile).toHaveLength(filtered.chunks.length);
    expect(branchChunksForFile).toHaveLength(1);
    expect(filtered.capped).toBe(true);

    const capWarnings = indexer
      .getLogger()
      .getLogsByLevel("warn")
      .filter((entry) => entry.message === "Per-file chunk cap reached; dropping lower-priority chunks");

    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]?.data).toMatchObject({
      filePath: trackedPath,
      maxChunksPerFile: 1,
      eligibleChunks: parsed?.chunks.length,
      keptChunks: 1,
    });
  });

  it("persists chunk-cap drops and exposes them via coverage and status", async () => {
    const filePath = createChunkyRepo();
    const config = createConfig({
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 1,
      },
    });
    const indexer = new Indexer(tempDir, config);

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    expect(database.getChunkCapDropsForBranch(branch)).toEqual([
      {
        branch,
        filePath: trackedPath,
        capLimit: 1,
        keptCount: 1,
        droppedCount: 3,
        droppedNamed: ["second", "third", "many"],
        indexedAt: expect.any(Number),
      },
    ]);

    const coverage = await indexer.getCoverageReport();
    expect(coverage).toEqual({
      branch,
      truncatedFiles: [
        {
          filePath: trackedPath,
          capLimit: 1,
          keptChunks: 1,
          droppedChunks: 3,
          droppedNamedSymbols: ["second", "third", "many"],
          indexedAt: expect.any(Number),
        },
      ],
      totalDroppedChunks: 3,
      totalDroppedNamedSymbols: 3,
    });

    const formattedStatus = formatStatus(await indexer.getStatus());
    expect(formattedStatus).toContain("Chunk cap: 1 files truncated (3 chunks dropped, 3 named symbols invisible)");
  });

  it("clears persisted chunk-cap drops after a clean reindex", async () => {
    const filePath = createChunkyRepo();
    const config = createConfig({
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 1,
      },
    });
    const indexer = new Indexer(tempDir, config);

    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    expect(database.getChunkCapDropsForBranch(branch)).toHaveLength(1);

    fs.writeFileSync(
      filePath,
      [
        "export function first(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await indexer.index();

    ({ branch, database } = await openDatabase(indexer));
    expect(database.getChunkCapDropsForBranch(branch)).toEqual([]);
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

    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt;
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed")?.updatedAt;
    const fetchCountBefore = fetchSpy.mock.calls.length;

    await indexer.index();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(beforeChunk);
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(beforeEmbed);
    expect(database.getUnfinishedPipelineFiles(branch)).not.toContain(trackedPath);
    expect(fetchSpy.mock.calls.length).toBe(fetchCountBefore);
  });

  it("keeps other-branch call edges intact when reindexing a shared file", async () => {
    const filePath = createGraphRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const callersBefore = database.getCallers("callee", branch);
    expect(callersBefore.length).toBeGreaterThan(0);
    expect(callersBefore.every((edge) => edge.branch === branch)).toBe(true);

    database.addSymbolsToBranchBatch("feature", database.getBranchSymbolIds(branch));
    database.upsertCallEdgesBatch(
      callersBefore.map((edge) => ({
        ...edge,
        branch: "feature",
      }))
    );
    expect(database.getCallers("callee", "feature")).toHaveLength(callersBefore.length);

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

  it("persistently resolves unique cross-file call edges after branch symbols become authoritative", async () => {
    const { callerFile, helperFile } = createCrossFileCallRepo();
    const indexer = new Indexer(tempDir, createConfig());

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const callerSymbol = database.getSymbolsByNameOnBranch("runTask", branch)[0];
    const helperSymbol = database.getSymbolsByNameOnBranch("helperFn", branch)[0];

    expect(callerSymbol).toBeTruthy();
    expect(helperSymbol).toBeTruthy();
    expect(path.basename(callerSymbol!.filePath)).toBe(path.basename(callerFile));
    expect(path.basename(helperSymbol!.filePath)).toBe(path.basename(helperFile));

    const helperEdge = database
      .getCallees(callerSymbol!.id, branch)
      .find((edge) => edge.targetName === "helperFn" && edge.callType === "Call");

    expect(helperEdge?.isResolved).toBe(true);
    expect(helperEdge?.toSymbolId).toBe(helperSymbol!.id);
    expect(path.basename(helperEdge?.targetFilePath ?? "")).toBe(path.basename(helperFile));
    expect(helperEdge?.targetKind).toBe("function");

    const callers = database.getCallersWithContextByTargetSymbolId(helperSymbol!.id, branch);
    expect(callers).toHaveLength(1);
    expect(callers[0]?.fromSymbolId).toBe(callerSymbol!.id);
    expect(path.basename(callers[0]?.fromSymbolFilePath ?? "")).toBe(path.basename(callerFile));
    expect(callers[0]?.targetName).toBe("helperFn");
    expect(callers[0]?.toSymbolId).toBe(helperSymbol!.id);
    expect(callers[0]?.isResolved).toBe(true);
  });

  it("keeps ambiguous cross-file call edges unresolved after finalization", async () => {
    const { callerFile, processAFile, processBFile } = createAmbiguousCrossFileCallRepo();
    const indexer = new Indexer(tempDir, createConfig());

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const callerSymbol = database.getSymbolsByNameOnBranch("runTask", branch)[0];
    const processSymbols = database.getSymbolsByNameOnBranch("process", branch);

    expect(callerSymbol).toBeTruthy();
    expect(processSymbols).toHaveLength(2);
    expect(processSymbols.map((symbol) => path.basename(symbol.filePath)).sort()).toEqual([
      path.basename(processAFile),
      path.basename(processBFile),
    ]);

    const processEdge = database
      .getCallees(callerSymbol!.id, branch)
      .find((edge) => edge.targetName === "process" && edge.callType === "Call");

    expect(processEdge?.isResolved).toBe(false);
    expect(processEdge?.targetFilePath ?? null).toBeNull();
    expect(processEdge?.targetKind ?? null).toBeNull();
    expect(processEdge?.toSymbolId ?? null).toBeNull();
    for (const processSymbol of processSymbols) {
      expect(database.getCallersWithContextByTargetSymbolId(processSymbol.id, branch)).toEqual([]);
    }
  });

  it("forces cold start instead of resume when finalization crashes before durable completion", async () => {
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
      .spyOn(getPrimaryStore(indexer), "save")
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
    const finalizingRun = database.getPipelineRunsByStatus("finalizing")[0];
    expect(finalizingRun?.branch).toBe(branch);

    const restartedIndexer = await createFreshIndexer();
    const restartedOrchestrator = getIndexerInternals(restartedIndexer).orchestrator;
    const coldStartSpy = vi.spyOn(restartedOrchestrator, "coldStart");

    await restartedIndexer.index();

    const restartedDatabase = new Database(
      path.join((await restartedIndexer.getStatus()).indexPath, "codebase.db")
    );
    expect(restartedDatabase.getPipelineRun(finalizingRun!.runId)?.status).toBe("cancelled");
    expect(restartedDatabase.getPipelineState(branch, trackedPath, "index")?.status).toBe("complete");
    expect(coldStartSpy).toHaveBeenCalled();
    coldStartSpy.mockRestore();
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

  it("re-enqueues only incomplete files at normal priority during crash resume and preserves the original run id", async () => {
    const { fileA, fileB, fileC } = createRepoWithThreeFiles();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const trackedC = resolveTrackedPath(database, branch, fileC, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "normal";
        trigger: "crash_resume";
        runId: string;
      }) => string;
    };

    database.upsertPipelineState({
      branch,
      filePath: trackedC,
      stage: "graph",
      status: "in_progress",
      inputHash: database.getPipelineState(branch, trackedC, "graph")?.inputHash,
      updatedAt: Date.now(),
    });
    database.startPipelineRun(
      {
        runId: "recent-resume-run",
        branch,
        runType: "hot_update",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith({
      branch,
      filePath: trackedC,
      priority: "normal",
      trigger: "crash_resume",
      runId: "recent-resume-run",
    });
    expect(
      enqueueSpy.mock.calls.some((call) => (call[0] as { filePath: string }).filePath === trackedA)
    ).toBe(false);
    expect(
      enqueueSpy.mock.calls.some((call) => (call[0] as { filePath: string }).filePath === trackedB)
    ).toBe(false);
    expect(database.getPipelineRun("recent-resume-run")?.status).toBe("complete");
    enqueueSpy.mockRestore();
  });

  it("resumes an interrupted cold start by reprocessing only incomplete files", async () => {
    const { fileA, fileB, fileC } = createRepoWithThreeFiles();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const trackedC = resolveTrackedPath(database, branch, fileC, tempDir);
    const beforeAChunk = database.getPipelineState(branch, trackedA, "chunk");
    const beforeAEmbed = database.getPipelineState(branch, trackedA, "embed");
    const beforeBChunk = database.getPipelineState(branch, trackedB, "chunk");
    const beforeBEmbed = database.getPipelineState(branch, trackedB, "embed");
    const beforeCChunk = database.getPipelineState(branch, trackedC, "chunk");
    const beforeCEmbed = database.getPipelineState(branch, trackedC, "embed");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    database.upsertPipelineState({
      branch,
      filePath: trackedC,
      stage: "embed",
      status: "in_progress",
      inputHash: beforeCEmbed?.inputHash,
      updatedAt: Date.now(),
    });
    database.upsertPipelineState({
      branch,
      filePath: trackedC,
      stage: "index",
      status: "pending",
      updatedAt: Date.now(),
    });
    database.upsertPipelineState({
      branch,
      filePath: trackedC,
      stage: "graph",
      status: "pending",
      updatedAt: Date.now(),
    });
    database.startPipelineRun(
      {
        runId: "interrupted-cold-start",
        branch,
        runType: "cold_start",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const fetchCountBeforeResume = fetchSpy.mock.calls.length;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("interrupted-cold-start")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedC, "embed")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedC, "index")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedC, "graph")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedA, "chunk")?.updatedAt).toBe(beforeAChunk?.updatedAt);
    expect(database.getPipelineState(branch, trackedA, "embed")?.updatedAt).toBe(beforeAEmbed?.updatedAt);
    expect(database.getPipelineState(branch, trackedB, "chunk")?.updatedAt).toBe(beforeBChunk?.updatedAt);
    expect(database.getPipelineState(branch, trackedB, "embed")?.updatedAt).toBe(beforeBEmbed?.updatedAt);
    expect(database.getPipelineState(branch, trackedC, "chunk")?.updatedAt).toBe(beforeCChunk?.updatedAt);
    expect(database.getPipelineState(branch, trackedC, "embed")?.updatedAt).toBeGreaterThan(
      beforeCEmbed?.updatedAt ?? 0
    );

    const resumeCalls = fetchSpy.mock.calls.slice(fetchCountBeforeResume);
    expect(resumeCalls.length).toBeLessThanOrEqual(1);
    if (resumeCalls.length === 1) {
      const requestBody = JSON.parse(String(resumeCalls[0]?.[1]?.body ?? "{}")) as {
        input?: string[];
      };
      expect(requestBody.input?.length).toBeGreaterThan(0);
      expect(requestBody.input?.every((text) => text.includes("gamma"))).toBe(true);
    }
  });

  it("cancels stale in-progress runs older than the resume threshold instead of resuming them", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const staleStartedAt = Date.now() - 2 * 60 * 60 * 1000 - 5_000;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "normal";
        trigger: "crash_resume";
        runId: string;
      }) => string;
    };

    database.upsertPipelineState({
      branch,
      filePath: trackedPath,
      stage: "index",
      status: "in_progress",
      updatedAt: staleStartedAt,
    });
    database.startPipelineRun(
      {
        runId: "stale-resume-run",
        branch,
        runType: "hot_update",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: staleStartedAt,
      },
      staleStartedAt
    );

    const enqueueSpy = vi.spyOn(queue, "enqueue");
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("stale-resume-run")?.status).toBe("cancelled");
    expect(enqueueSpy).not.toHaveBeenCalled();
    enqueueSpy.mockRestore();
  });

  it("cancels interrupted runs on resume when the config hash changed since the run started", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "normal";
        trigger: "crash_resume";
        runId: string;
      }) => string;
    };
    const logger = (indexer as unknown as { logger: { info: (...args: unknown[]) => void } }).logger;

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
        runId: "config-mismatch-run",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: "stale-config-hash",
        startedAt: Date.now(),
      },
      Date.now()
    );

    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const logSpy = vi.spyOn(logger, "info");
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("config-mismatch-run")?.status).toBe("cancelled");
    expect(database.getPipelineState(branch, trackedPath, "index")?.status).toBe("in_progress");
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cancelled interrupted run config-mismatch-run on branch"),
      expect.objectContaining({
        branch,
        runId: "config-mismatch-run",
        runConfigHash: "stale-config-hash",
      })
    );
    enqueueSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("resumes interrupted runs normally when the config hash still matches", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");

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
        runId: "config-match-run",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const fetchCountBeforeResume = fetchSpy.mock.calls.length;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("config-match-run")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "index")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
    expect(fetchSpy.mock.calls.length).toBe(fetchCountBeforeResume);
  });

  it("replays finalization on resume when an interrupted run has zero unfinished files but durable finalization writes are missing", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database, indexPath } = await openDatabase(indexer);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const currentConfigHash = hashConfigVersion(currentConfig);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const fileHashCachePath = getFileHashCachePath(indexPath, branch);
    const expectedFileHash = hashContent(fs.readFileSync(fileA, "utf-8"));

    expect(database.getUnfinishedPipelineFiles(branch)).toEqual([]);
    expect(database.deleteMerkleSnapshot(branch)).toBe(true);
    fs.rmSync(fileHashCachePath, { force: true });
    seedBranchAppliedConfig(database, branch, "stale-finalization-hash", currentConfig);
    database.startPipelineRun(
      {
        runId: "resume-finalization-replay",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: currentConfigHash,
        startedAt: Date.now(),
      },
      Date.now()
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const replaySpy = vi.spyOn(orchestrator as any, "replayRunFinalization");

    await orchestrator.resumeInterruptedRuns(branch, currentConfig, currentConfigHash);

    expect(replaySpy).toHaveBeenCalledWith(expect.anything(), {
      branch,
      runId: "resume-finalization-replay",
      configVersion: currentConfig,
      configHash: currentConfigHash,
    });
    expect(database.getPipelineRun("resume-finalization-replay")?.status).toBe("complete");
    expect(database.getMerkleSnapshot(branch)).toBeTruthy();
    expect(database.getBranchConfigVersion(branch)?.configHash).toBe(currentConfigHash);
    expect(fs.existsSync(fileHashCachePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8")) as Record<string, string>).toMatchObject({
      [trackedPath]: expectedFileHash,
    });
    replaySpy.mockRestore();
  });

  it("replays interrupted finalization idempotently", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database, indexPath } = await openDatabase(indexer);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const currentConfigHash = hashConfigVersion(currentConfig);
    const fileHashCachePath = getFileHashCachePath(indexPath, branch);
    const internals = getIndexerInternals(indexer) as unknown as {
      orchestrator: {
        prepareRun: () => Promise<unknown>;
        replayRunFinalization: (
          resources: unknown,
          args: {
            branch: string;
            runId: string;
            configVersion: ConfigVersion;
            configHash: string;
          }
        ) => Promise<{ replayed: boolean }>;
      };
      indexCompatibility?: { compatible: boolean } | null;
    };
    const orchestrator = getIndexerInternals(indexer).orchestrator as {
      prepareRun: () => Promise<unknown>;
      replayRunFinalization: (
        resources: unknown,
        args: {
          branch: string;
          runId: string;
          configVersion: ConfigVersion;
          configHash: string;
        }
      ) => Promise<{ replayed: boolean }>;
    };

    expect(database.deleteMerkleSnapshot(branch)).toBe(true);
    fs.rmSync(fileHashCachePath, { force: true });
    seedBranchAppliedConfig(database, branch, "stale-finalization-hash", currentConfig);
    database.startPipelineRun(
      {
        runId: "resume-finalization-idempotent",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: currentConfigHash,
        startedAt: Date.now(),
      },
      Date.now()
    );

    const resources = await orchestrator.prepareRun();
    database.deleteMetadata("index.version");
    database.deleteMetadata("index.embeddingProvider");
    database.deleteMetadata("index.embeddingModel");
    database.deleteMetadata("index.embeddingDimensions");
    database.deleteMetadata("index.createdAt");
    database.deleteMetadata("index.updatedAt");
    internals.indexCompatibility = {
      compatible: false,
    };
    const first = await orchestrator.replayRunFinalization(resources, {
      branch,
      runId: "resume-finalization-idempotent",
      configVersion: currentConfig,
      configHash: currentConfigHash,
    });
    const snapshotAfterFirstReplay = database.getMerkleSnapshot(branch);
    const branchConfigAfterFirstReplay = database.getBranchConfigVersion(branch);
    const cacheAfterFirstReplay = fs.readFileSync(fileHashCachePath, "utf-8");

    const second = await orchestrator.replayRunFinalization(resources, {
      branch,
      runId: "resume-finalization-idempotent",
      configVersion: currentConfig,
      configHash: currentConfigHash,
    });

    expect(first.replayed).toBe(true);
    expect(second.replayed).toBe(true);
    expect(database.getPipelineRun("resume-finalization-idempotent")?.status).toBe("complete");
    expect(database.getMerkleSnapshot(branch)).toBe(snapshotAfterFirstReplay);
    expect(database.getBranchConfigVersion(branch)?.configHash).toBe(currentConfigHash);
    expect(database.getBranchConfigVersion(branch)?.appliedAt).toBe(branchConfigAfterFirstReplay?.appliedAt);
    expect(fs.readFileSync(fileHashCachePath, "utf-8")).toBe(cacheAfterFirstReplay);
    expect(snapshotAfterFirstReplay).toBeTruthy();
    expect(branchConfigAfterFirstReplay?.configHash).toBe(currentConfigHash);
    expect(cacheAfterFirstReplay.length).toBeGreaterThan(0);
    expect(database.getMetadata("index.version")).toBeTruthy();
    expect(database.getMetadata("index.embeddingProvider")).toBe(currentConfig.embeddingProvider);
    expect(database.getMetadata("index.embeddingModel")).toBe(currentConfig.embeddingModelId);
    expect(database.getMetadata("index.embeddingDimensions")).toBe(
      currentConfig.embeddingDimension.toString()
    );
    expect(internals.indexCompatibility).toEqual({ compatible: true });
    void fileA;
  });

  it("marks successful runs complete without leaving a finalizing marker behind", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const completedRuns = database
      .getPipelineRunsByStatus("complete")
      .filter((run) => run.branch === branch);

    expect(completedRuns.length).toBeGreaterThan(0);
    expect(completedRuns.every((run) => run.status === "complete")).toBe(true);
    expect(database.getPipelineRunsByStatus("finalizing")).toEqual([]);
  });

  it("forces re-embedding during resume when the embed checkpoint is complete but live retrieval artifacts are missing", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const internals = getIndexerInternals(indexer) as unknown as {
      stores: Map<string, { clear: () => void; contains: (chunkId: string) => boolean }>;
      primaryStoreModelId?: string | null;
      configuredProviderInfo: { modelInfo: { model: string } };
      invertedIndex: { clear: () => void; hasChunk: (chunkId: string) => boolean };
    };
    const primaryModelId =
      internals.primaryStoreModelId ?? internals.configuredProviderInfo.modelInfo.model;
    const primaryStore = internals.stores.get(primaryModelId);
    if (!primaryStore) {
      throw new Error(`Missing primary store for model ${primaryModelId}`);
    }

    primaryStore.clear();
    internals.invertedIndex.clear();

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
        runId: "resume-missing-store-data",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const fetchCountBeforeResume = fetchSpy.mock.calls.length;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    const restoredChunkIds = database
      .getChunksByFileOnBranch(trackedPath, branch)
      .map((chunk) => chunk.chunkId);

    expect(database.getPipelineRun("resume-missing-store-data")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "embed")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(fetchSpy.mock.calls.length).toBe(fetchCountBeforeResume);
    expect(restoredChunkIds.length).toBeGreaterThan(0);
    expect(restoredChunkIds.every((chunkId) => primaryStore.contains(chunkId))).toBe(true);
    expect(restoredChunkIds.every((chunkId) => internals.invertedIndex.hasChunk(chunkId))).toBe(true);
  });

  it("repairs missing branch-filter state during resume when chunks still exist globally", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const internals = getIndexerInternals(indexer) as unknown as {
      stores: Map<
        string,
        {
          contains: (chunkId: string) => boolean;
          branchContains: (branchName: string, chunkId: string) => boolean;
          clearBranchMembership: (branchName: string) => void;
        }
      >;
      primaryStoreModelId?: string | null;
      configuredProviderInfo: { modelInfo: { model: string } };
      invertedIndex: {
        hasChunk: (chunkId: string) => boolean;
        branchContains: (branchName: string, chunkId: string) => boolean;
        clearBranchMembership: (branchName: string) => void;
      };
    };
    const primaryModelId =
      internals.primaryStoreModelId ?? internals.configuredProviderInfo.modelInfo.model;
    const primaryStore = internals.stores.get(primaryModelId);
    if (!primaryStore) {
      throw new Error(`Missing primary store for model ${primaryModelId}`);
    }

    const restoredChunkIds = database
      .getChunksByFileOnBranch(trackedPath, branch)
      .map((chunk) => chunk.chunkId);
    primaryStore.clearBranchMembership(branch);
    internals.invertedIndex.clearBranchMembership(branch);

    expect(restoredChunkIds.length).toBeGreaterThan(0);
    expect(restoredChunkIds.every((chunkId) => primaryStore.contains(chunkId))).toBe(true);
    expect(restoredChunkIds.every((chunkId) => internals.invertedIndex.hasChunk(chunkId))).toBe(true);
    expect(restoredChunkIds.every((chunkId) => !primaryStore.branchContains(branch, chunkId))).toBe(true);
    expect(
      restoredChunkIds.every((chunkId) => !internals.invertedIndex.branchContains(branch, chunkId))
    ).toBe(true);

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
        runId: "resume-missing-branch-filter",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const fetchCountBeforeResume = fetchSpy.mock.calls.length;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("resume-missing-branch-filter")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
    expect(fetchSpy.mock.calls.length).toBe(fetchCountBeforeResume);
    expect(restoredChunkIds.every((chunkId) => primaryStore.branchContains(branch, chunkId))).toBe(true);
    expect(
      restoredChunkIds.every((chunkId) => internals.invertedIndex.branchContains(branch, chunkId))
    ).toBe(true);
  });

  it("keeps embed checkpoints trusted during resume when live retrieval artifacts are still present", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const internals = getIndexerInternals(indexer) as unknown as {
      stores: Map<
        string,
        {
          branchContains: (branchName: string, chunkId: string) => boolean;
        }
      >;
      primaryStoreModelId?: string | null;
      configuredProviderInfo: { modelInfo: { model: string } };
      invertedIndex: {
        branchContains: (branchName: string, chunkId: string) => boolean;
      };
    };
    const primaryModelId =
      internals.primaryStoreModelId ?? internals.configuredProviderInfo.modelInfo.model;
    const primaryStore = internals.stores.get(primaryModelId);
    if (!primaryStore) {
      throw new Error(`Missing primary store for model ${primaryModelId}`);
    }
    const chunkIds = database.getChunksByFileOnBranch(trackedPath, branch).map((chunk) => chunk.chunkId);

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
        runId: "resume-valid-store-data",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: hashConfigVersion(currentConfig),
        startedAt: Date.now(),
      },
      Date.now()
    );

    const fetchCountBeforeResume = fetchSpy.mock.calls.length;
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    await orchestrator.resumeInterruptedRuns(branch, currentConfig, hashConfigVersion(currentConfig));

    expect(database.getPipelineRun("resume-valid-store-data")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
    expect(fetchSpy.mock.calls.length).toBe(fetchCountBeforeResume);
    expect(chunkIds.every((chunkId) => primaryStore.branchContains(branch, chunkId))).toBe(true);
    expect(chunkIds.every((chunkId) => internals.invertedIndex.branchContains(branch, chunkId))).toBe(
      true
    );
  });

  it("reruns CHUNK, EMBED, and GRAPH across the branch after chunker config drift", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const initialFetchCount = fetchSpy.mock.calls.length;

    seedBranchAppliedConfig(database, branch, "stale-chunker-hash", {
      ...currentConfig,
      chunkerVersion: "stale-chunker-version",
    });

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await indexer.index();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunk?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraph?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunkB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraphB?.updatedAt ?? 0
    );
    expect(fetchSpy.mock.calls.length).toBe(initialFetchCount);
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      active: true,
      chunkerVersion: currentConfig.chunkerVersion,
    });
  });

  it("reruns EMBED across the branch after embedding config drift without resetting CHUNK or GRAPH", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    seedBranchAppliedConfig(database, branch, "stale-embed-hash", {
      ...currentConfig,
      embeddingModelId: "stale-model-id",
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
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBe(
      beforeGraph?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBe(
      beforeChunkB?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBe(
      beforeGraphB?.updatedAt
    );
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      active: true,
      embeddingModelId: currentConfig.embeddingModelId,
    });
  });

  it("sends the structured embedding prefix to providers while preserving raw chunk text for storage", async () => {
    const srcDir = path.join(tempDir, "src", "config");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "api.ts"),
      [
        "export const API_BASE_URL =",
        "  import.meta.env.VITE_API_URL ?? 'http://localhost:3001'",
        "",
      ].join("\n"),
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.initialize();

    const internals = indexer as unknown as {
      database: {
        upsertEmbeddingsBatch: (items: Array<{ chunkText: string }>) => void;
      } | null;
    };
    const database = internals.database;
    if (!database) {
      throw new Error("Database was not initialized");
    }

    const originalUpsertEmbeddingsBatch = database.upsertEmbeddingsBatch.bind(database);
    const storedChunkTexts: string[] = [];
    database.upsertEmbeddingsBatch = ((items: Array<{ chunkText: string }>) => {
      storedChunkTexts.push(...items.map((item) => item.chunkText));
      return originalUpsertEmbeddingsBatch(items);
    }) as typeof database.upsertEmbeddingsBatch;

    await indexer.index();

    const requestBodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string }
    );
    const documentText = requestBodies
      .flatMap((body) => body.input ?? [])
      .find((text) => text.includes("API_BASE_URL"));

    expect(documentText).toContain("file: src/config/api.ts");
    expect(documentText).toContain("symbol: API_BASE_URL (constant)");
    expect(documentText).toContain("export const API_BASE_URL =");
    expect(storedChunkTexts).toContain(
      "export const API_BASE_URL =\n  import.meta.env.VITE_API_URL ?? 'http://localhost:3001'\n"
    );
    expect(storedChunkTexts.some((text) => text.includes("file: src/config/api.ts"))).toBe(false);
    expect(storedChunkTexts.some((text) => text.includes("symbol: API_BASE_URL"))).toBe(false);
  });

  it("stores embeddingInputHash values that match the exact provider payload bytes", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());

    await indexer.index();

    const providerInputs = fetchSpy.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(providerInputs.length).toBeGreaterThan(0);

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const chunkHashes = new Set(
      [
        ...database.getChunksByFileOnBranch(trackedA, branch),
        ...database.getChunksByFileOnBranch(trackedB, branch),
      ].map((chunk) => chunk.embeddingInputHash)
    );
    const providerInputHashes = new Set(providerInputs.map((text) => hashContent(text)));

    expect(providerInputHashes).toEqual(chunkHashes);
  });

  it("re-embeds when a file is renamed without changing chunk content", async () => {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const originalFile = path.join(srcDir, "helper.ts");
    fs.writeFileSync(
      originalFile,
      [
        "export function sharedHelper(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    const originalTrackedPath = resolveTrackedPath(database, branch, originalFile, tempDir);
    const originalChunks = database.getChunksByFileOnBranch(originalTrackedPath, branch);
    expect(originalChunks.length).toBeGreaterThan(0);
    const originalEmbeddingInputHashes = new Set(
      originalChunks.map((chunk) => chunk.embeddingInputHash)
    );

    fetchSpy.mockClear();
    const renamedFile = path.join(srcDir, "renamed-helper.ts");
    fs.renameSync(originalFile, renamedFile);
    await indexer.handleFileChanges([
      { type: "unlink", path: originalFile },
      { type: "add", path: renamedFile },
    ]);

    ({ branch, database } = await openDatabase(indexer));
    const renamedTrackedPath = resolveTrackedPath(database, branch, renamedFile, tempDir);
    const renamedChunks = database.getChunksByFileOnBranch(renamedTrackedPath, branch);
    expect(renamedChunks.length).toBe(originalChunks.length);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(
      renamedChunks.every(
        (chunk) => !originalEmbeddingInputHashes.has(chunk.embeddingInputHash)
      )
    ).toBe(true);
    for (const chunk of renamedChunks) {
      expect(
        database.getEmbeddingForModel(chunk.embeddingInputHash, "mock-embedding-model")
      ).not.toBeNull();
    }

    const requestBodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body ?? "{}")) as { input?: string[] }
    );
    const renamedDocument = requestBodies
      .flatMap((body) => body.input ?? [])
      .find((text) => text.includes("file: src/renamed-helper.ts"));
    expect(renamedDocument).toBeTruthy();
  });

  it("re-embeds when symbol metadata changes even if chunk content stays identical", async () => {
    const filePath = createSingleFileRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    let { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    const beforeChunk = database
      .getChunksByFileOnBranch(trackedPath, branch)
      .find((chunk) => chunk.name === "only");
    expect(beforeChunk).toBeTruthy();
    const beforeEmbedState = database.getPipelineState(branch, trackedPath, "embed");

    const internals = getIndexerInternals(indexer);
    const originalParseFilesForIndexing = internals.parseFilesForIndexing.bind(internals);
    const originalFileContent = fs.readFileSync(filePath, "utf-8");
    const originalParsedTarget = originalParseFilesForIndexing([
      {
        path: filePath,
        content: originalFileContent,
        hash: hashContent(originalFileContent),
      },
    ]).parsedFiles[0];
    expect(originalParsedTarget).toBeTruthy();
    const parseSpy = vi
      .spyOn(internals, "parseFilesForIndexing")
      .mockImplementation((files) => {
        const result = originalParseFilesForIndexing(files);
        return {
          ...result,
          parsedFiles: result.parsedFiles.map((parsedFile) => {
            if (fs.realpathSync(parsedFile.path) !== fs.realpathSync(filePath)) {
              return parsedFile;
            }

            return {
              ...parsedFile,
              chunks: (originalParsedTarget?.chunks ?? []).map((chunk) => ({
                ...chunk,
                name: chunk.name ? "renamedOnly" : chunk.name,
              })),
            };
          }),
        };
      });

    fetchSpy.mockClear();
    fs.appendFileSync(filePath, "\n");
    await indexer.handleFileChanges([{ type: "change", path: filePath }]);
    parseSpy.mockRestore();

    ({ branch, database } = await openDatabase(indexer));
    const afterChunk = database
      .getChunksByFileOnBranch(trackedPath, branch)
      .find((chunk) => chunk.name === "renamedOnly");
    expect(afterChunk).toBeTruthy();
    expect(afterChunk!.contentHash).toBe(beforeChunk!.contentHash);
    expect(afterChunk!.embeddingInputHash).not.toBe(beforeChunk!.embeddingInputHash);
    expect(afterChunk!.name).toBe("renamedOnly");
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedState?.updatedAt ?? 0
    );
    expect(
      database.getEmbeddingForModel(afterChunk!.embeddingInputHash, "mock-embedding-model")
    ).not.toBeNull();
  });

  it("stores distinct embeddings for duplicate chunk content in different files", async () => {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(path.join(srcDir, "nested"), { recursive: true });
    const sharedContent = [
      "export function sharedHelper(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const fileA = path.join(srcDir, "alpha.ts");
    const fileB = path.join(srcDir, "nested", "beta.ts");
    fs.writeFileSync(fileA, sharedContent, "utf-8");
    fs.writeFileSync(fileB, sharedContent, "utf-8");

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    const chunkA = database
      .getChunksByFileOnBranch(trackedA, branch)
      .find((chunk) => chunk.name === "sharedHelper");
    const chunkB = database
      .getChunksByFileOnBranch(trackedB, branch)
      .find((chunk) => chunk.name === "sharedHelper");

    expect(chunkA).toBeTruthy();
    expect(chunkB).toBeTruthy();
    expect(chunkA!.contentHash).toBe(chunkB!.contentHash);
    expect(chunkA!.embeddingInputHash).not.toBe(chunkB!.embeddingInputHash);
    expect(
      database.getEmbeddingForModel(chunkA!.embeddingInputHash, "mock-embedding-model")
    ).not.toBeNull();
    expect(
      database.getEmbeddingForModel(chunkB!.embeddingInputHash, "mock-embedding-model")
    ).not.toBeNull();
  });

  it("invalidates embed checkpoints when only the symbol descriptor changes", () => {
    const checkpointDb = new Database(path.join(tempDir, "checkpoint-staleness.db"));
    const checkpointManager = new CheckpointManager(checkpointDb);
    const baseChunk = {
      content: "export function stable(): number { return 1; }\n",
      startLine: 1,
      endLine: 1,
      chunkType: "function" as const,
      name: "stable",
      symbolKind: "Function" as const,
      language: "typescript",
    };
    const renamedChunk = {
      ...baseChunk,
      name: "stableRenamed",
    };
    const embedConfigHash = "embed-v1";
    const filePath = "/repo/src/stable.ts";

    const originalEmbeddingInputHash = buildEmbeddingInputHash(baseChunk, filePath, "/repo", 8_192);
    const renamedEmbeddingInputHash = buildEmbeddingInputHash(
      renamedChunk,
      filePath,
      "/repo",
      8_192
    );
    expect(hashContent(baseChunk.content)).toBe(hashContent(renamedChunk.content));
    expect(originalEmbeddingInputHash).not.toBe(renamedEmbeddingInputHash);

    const originalStageHash = buildEmbedStageInputHash(
      [originalEmbeddingInputHash],
      embedConfigHash
    );
    const renamedStageHash = buildEmbedStageInputHash(
      [renamedEmbeddingInputHash],
      embedConfigHash
    );

    checkpointManager.markStageComplete("main", filePath, "embed", originalStageHash);
    expect(
      checkpointManager.isStageStale("main", filePath, "embed", originalStageHash)
    ).toBe(false);
    expect(
      checkpointManager.isStageStale("main", filePath, "embed", renamedStageHash)
    ).toBe(true);
  });

  it("reruns EMBED across the branch when the embedding input format version drifts without resetting CHUNK or GRAPH", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    seedBranchAppliedConfig(database, branch, "stale-prefix-hash", {
      ...currentConfig,
      embeddingPrefixVersion: 0,
    });

    fetchSpy.mockClear();
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(
      beforeChunk?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBe(
      beforeGraph?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBe(
      beforeChunkB?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBe(
      beforeGraphB?.updatedAt
    );
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      active: true,
      embeddingPrefixVersion: currentConfig.embeddingPrefixVersion,
    });
  });

  it("writes Arctic and Voyage embeddings on cold start when Voyage is available", async () => {
    createRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const chunkIds = database.getBranchChunkIds(branch);
    expect(chunkIds.length).toBeGreaterThan(0);

    const internals = getIndexerInternals(indexer);
    const arcticStore = internals.stores.get("mock-embedding-model");
    const voyageStore = internals.stores.get("voyage-code-2");
    expect(arcticStore?.count()).toBe(chunkIds.length);
    expect(voyageStore?.count()).toBe(chunkIds.length);

    for (const chunkId of chunkIds) {
      const chunk = database.getChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(database.getEmbeddingForModel(chunk!.embeddingInputHash, "mock-embedding-model")).not.toBeNull();
      expect(database.getEmbeddingForModel(chunk!.embeddingInputHash, "voyage-code-2")).not.toBeNull();
    }
  });

  it("treats Voyage batch nulls as non-blocking and still completes Arctic indexing", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const voyageProvider = getIndexerInternals(indexer).voyageProvider;
    expect(voyageProvider).toBeTruthy();
    vi.spyOn(voyageProvider!, "embedBatch").mockResolvedValue(null);

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedA = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, branch, fileB, tempDir);
    expect(database.getPipelineState(branch, trackedA, "embed")?.status).toBe("complete");
    expect(database.getPipelineState(branch, trackedB, "embed")?.status).toBe("complete");
    expect(database.getEmbeddingDebtForBranch(branch)).toEqual([
      expect.objectContaining({
        branch,
        filePath: trackedA,
        model: "voyage-code-2",
      }),
      expect.objectContaining({
        branch,
        filePath: trackedB,
        model: "voyage-code-2",
      }),
    ]);

    const chunkIds = database.getBranchChunkIds(branch);
    const voyageStore = getIndexerInternals(indexer).stores.get("voyage-code-2");
    expect(voyageStore?.count() ?? 0).toBe(0);
    for (const chunkId of chunkIds) {
      const chunk = database.getChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(database.getEmbeddingForModel(chunk!.embeddingInputHash, "mock-embedding-model")).not.toBeNull();
      expect(database.getEmbeddingForModel(chunk!.embeddingInputHash, "voyage-code-2")).toBeNull();
    }
  });

  it("clears embedding debt after a successful Voyage healing run", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const voyageProvider = getIndexerInternals(indexer).voyageProvider;
    expect(voyageProvider).toBeTruthy();
    vi.spyOn(voyageProvider!, "embedBatch").mockResolvedValueOnce(null);

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    expect(database.getEmbeddingDebtForBranch(branch)).toHaveLength(1);

    await indexer.index();

    expect(database.getEmbeddingDebtForBranch(branch)).toEqual([]);
  });

  it("schedules unchanged debt files for Voyage-only healing on the next run", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const voyageProvider = getIndexerInternals(indexer).voyageProvider;
    expect(voyageProvider).toBeTruthy();
    vi.spyOn(voyageProvider!, "embedBatch").mockResolvedValueOnce(null);

    await indexer.index();
    fetchSpy.mockClear();

    await indexer.index();

    const models = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return body.model;
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model === "voyage-code-2")).toBe(true);
  });

  it("heals Voyage debt without changing Arctic embeddings", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const voyageProvider = getIndexerInternals(indexer).voyageProvider;
    expect(voyageProvider).toBeTruthy();
    vi.spyOn(voyageProvider!, "embedBatch").mockResolvedValueOnce(null);

    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const chunkIds = database.getBranchChunkIds(branch);
    const arcticBefore = new Map(
      chunkIds.map((chunkId) => {
        const chunk = database.getChunk(chunkId);
        if (!chunk) {
          throw new Error(`Missing chunk ${chunkId}`);
        }
        const embedding = database.getEmbeddingForModel(
          chunk.embeddingInputHash,
          "mock-embedding-model"
        );
        return [chunk.embeddingInputHash, embedding?.toString("hex") ?? ""];
      })
    );

    await indexer.index();

    for (const chunkId of chunkIds) {
      const chunk = database.getChunk(chunkId);
      expect(chunk).not.toBeNull();
      expect(
        database.getEmbeddingForModel(chunk!.embeddingInputHash, "mock-embedding-model")?.toString(
          "hex"
        )
      ).toBe(arcticBefore.get(chunk!.embeddingInputHash));
      expect(database.getEmbeddingForModel(chunk!.embeddingInputHash, "voyage-code-2")).not.toBeNull();
    }
  });

  it("clears embedding debt when branch state is cleared", async () => {
    const branch = "main";
    const filePath = "/tmp/debt.ts";
    const database = new Database(path.join(tempDir, "branch-debt.db"));
    database.recordEmbeddingDebt(branch, filePath, "voyage-code-2", "provider timeout");
    database.upsertPipelineState({
      branch,
      filePath,
      stage: "embed",
      status: "complete",
      updatedAt: Date.now(),
    });

    const manager = new CheckpointManager(database);
    manager.clearBranchState(branch);

    expect(database.getEmbeddingDebtForBranch(branch)).toEqual([]);
  });

  it("logs Voyage debt healing summary when a run starts with outstanding debt", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const voyageProvider = getIndexerInternals(indexer).voyageProvider;
    expect(voyageProvider).toBeTruthy();
    vi.spyOn(voyageProvider!, "embedBatch").mockResolvedValueOnce(null);

    await indexer.index();

    const loggerInfoSpy = vi.spyOn((indexer as any).logger, "info");
    await indexer.index();

    expect(
      loggerInfoSpy.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("Voyage embedding debt: 1 files") &&
          message.includes("will be healed this run")
      )
    ).toBe(true);

    loggerInfoSpy.mockRestore();
  });

  it("preserves successful Voyage embeddings when Arctic fails for a batch", async () => {
    const filePath = createSingleFileRepo();
    fetchSpy.mockImplementation(async (_url, init) =>
      createMockEmbeddingResponse(init, {
        failIf: (body) =>
          body.model === "mock-embedding-model"
            ? new Error("forced Arctic embedding failure")
            : null,
      })
    );

    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );

    const stats = await indexer.index();
    expect(stats.failedChunks).toBeGreaterThan(0);

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, filePath, tempDir);
    expect(database.getPipelineState(branch, trackedPath, "embed")?.status).toBe("failed");

    const chunkRows = database.getChunksByFile(trackedPath);
    expect(chunkRows.length).toBeGreaterThan(0);

    const arcticStore = getIndexerInternals(indexer).stores.get("mock-embedding-model");
    const voyageStore = getIndexerInternals(indexer).stores.get("voyage-code-2");
    expect(arcticStore?.count() ?? 0).toBe(0);
    expect(voyageStore?.count()).toBe(chunkRows.length);

    for (const chunk of chunkRows) {
      expect(database.getEmbeddingForModel(chunk.embeddingInputHash, "mock-embedding-model")).toBeNull();
      expect(database.getEmbeddingForModel(chunk.embeddingInputHash, "voyage-code-2")).not.toBeNull();
    }
  });

  it("reuses both model caches on unchanged cold start runs", async () => {
    createRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );

    await indexer.index();
    fetchSpy.mockClear();

    await indexer.index();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls Voyage only when Arctic is cached and Voyage is newly enabled", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    fetchSpy.mockClear();
    const internals = getIndexerInternals(indexer);
    internals.config.voyageApiKey = "voyage-test-key";
    internals.orchestrator.startupComplete = false;
    await indexer.index();

    const models = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return body.model;
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model === "voyage-code-2")).toBe(true);
  });

  it("reruns Voyage-only embedding work when voyageModelId changes without touching CHUNK or GRAPH", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");

    const internals = getIndexerInternals(indexer);
    internals.config.voyageModelId = "voyage-code-3";
    fetchSpy.mockClear();
    internals.orchestrator.startupComplete = false;
    await internals.orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(
      beforeChunk?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBe(
      beforeGraph?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBe(
      beforeChunkB?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBe(
      beforeGraphB?.updatedAt
    );

    const models = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return body.model;
    });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model === "voyage-code-3")).toBe(true);
    expect(database.getActiveConfigVersion()).toMatchObject({
      active: true,
      voyageModelId: "voyage-code-3",
    });
  });

  it("issues Arctic and Voyage embedding requests in parallel for the same batch", async () => {
    createSingleFileRepo();
    const callTimeline: Array<{ model: string; event: "start" | "end"; at: number }> = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const model = body.model ?? "unknown";
      callTimeline.push({ model, event: "start", at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 40));
      callTimeline.push({ model, event: "end", at: Date.now() });
      return createMockEmbeddingResponse(init);
    });

    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.index();

    const arcticStart = callTimeline.find(
      (entry) => entry.model === "mock-embedding-model" && entry.event === "start"
    );
    const arcticEnd = callTimeline.find(
      (entry) => entry.model === "mock-embedding-model" && entry.event === "end"
    );
    const voyageStart = callTimeline.find(
      (entry) => entry.model === "voyage-code-2" && entry.event === "start"
    );
    const voyageEnd = callTimeline.find(
      (entry) => entry.model === "voyage-code-2" && entry.event === "end"
    );

    expect(arcticStart).toBeTruthy();
    expect(arcticEnd).toBeTruthy();
    expect(voyageStart).toBeTruthy();
    expect(voyageEnd).toBeTruthy();
    expect(voyageStart!.at).toBeLessThan(arcticEnd!.at);
    expect(arcticStart!.at).toBeLessThan(voyageEnd!.at);
  });

  it("reruns GRAPH across the branch after graph extractor drift without resetting CHUNK or EMBED", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    seedBranchAppliedConfig(database, branch, "stale-graph-hash", {
      ...currentConfig,
      graphExtractorVersion: "stale-graph-version",
    });

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(
      beforeChunk?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(
      beforeEmbed?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraph?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBe(
      beforeChunkB?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBe(
      beforeEmbedB?.updatedAt
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraphB?.updatedAt ?? 0
    );
  });

  it("converges combined chunker and embedding config drift in a single startup pass", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const internals = getIndexerInternals(indexer) as {
      orchestrator: any;
      configuredProviderInfo: {
        modelInfo: {
          model: string;
        };
      };
    };
    const originalModel = internals.configuredProviderInfo.modelInfo.model;
    internals.configuredProviderInfo.modelInfo.model = "updated-model-id";

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const trackedPathB = resolveTrackedPath(database, branch, fileB, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const beforeChunkB = database.getPipelineState(branch, trackedPathB, "chunk");
    const beforeEmbedB = database.getPipelineState(branch, trackedPathB, "embed");
    const beforeGraph = database.getPipelineState(branch, trackedPath, "graph");
    const beforeGraphB = database.getPipelineState(branch, trackedPathB, "graph");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    seedBranchAppliedConfig(database, branch, "stale-chunk-and-embed-hash", {
      ...currentConfig,
      embeddingModelId: originalModel,
      chunkerVersion: "stale-chunker-version",
    });

    const fetchCountBefore = fetchSpy.mock.calls.length;
    internals.orchestrator.startupComplete = false;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await internals.orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunk?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunkB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbedB?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraph?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPathB, "graph")?.updatedAt).toBeGreaterThan(
      beforeGraphB?.updatedAt ?? 0
    );
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetchCountBefore);

    const afterFirstChunk = database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt;
    const afterFirstEmbed = database.getPipelineState(branch, trackedPath, "embed")?.updatedAt;
    const afterFirstChunkB = database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt;
    const afterFirstEmbedB = database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt;
    const fetchCountAfterFirstPass = fetchSpy.mock.calls.length;

    internals.orchestrator.startupComplete = false;
    await internals.orchestrator.ensureStartupState();

    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBe(afterFirstChunk);
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBe(afterFirstEmbed);
    expect(database.getPipelineState(branch, trackedPathB, "chunk")?.updatedAt).toBe(afterFirstChunkB);
    expect(database.getPipelineState(branch, trackedPathB, "embed")?.updatedAt).toBe(afterFirstEmbedB);
    expect(fetchSpy.mock.calls.length).toBe(fetchCountAfterFirstPass);
    expect(database.getActiveConfigVersion()).toMatchObject({
      configHash: hashConfigVersion(currentConfig),
      active: true,
      chunkerVersion: currentConfig.chunkerVersion,
      embeddingModelId: currentConfig.embeddingModelId,
    });
  });

  it("applies config drift handling before resume so files cannot skip CHUNK under a stale chunker version", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const beforeChunk = database.getPipelineState(branch, trackedPath, "chunk");
    const beforeEmbed = database.getPipelineState(branch, trackedPath, "embed");
    const currentConfig = await getCurrentRuntimeConfig(indexer);

    seedBranchAppliedConfig(database, branch, "ordering-stale-chunker-hash", {
      ...currentConfig,
      chunkerVersion: "ordering-stale-chunker-version",
    });
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
        runId: "ordering-resume-run",
        branch,
        runType: "hot_update",
        status: "in_progress",
        configHash: "ordering-stale-chunker-hash",
        startedAt: Date.now(),
      },
      Date.now()
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const callOrder: string[] = [];
    const originalHandleConfigChange = orchestrator.handleConfigChange.bind(orchestrator);
    const originalResumeInterruptedRuns = orchestrator.resumeInterruptedRuns.bind(orchestrator);
    const configSpy = vi
      .spyOn(orchestrator, "handleConfigChange")
      .mockImplementation(async (...args: Parameters<typeof originalHandleConfigChange>) => {
        callOrder.push("config");
        return originalHandleConfigChange(...args);
      });
    const resumeSpy = vi
      .spyOn(orchestrator, "resumeInterruptedRuns")
      .mockImplementation(async (...args: Parameters<typeof originalResumeInterruptedRuns>) => {
        callOrder.push("resume");
        return originalResumeInterruptedRuns(...args);
      });

    orchestrator.startupComplete = false;
    await orchestrator.ensureStartupState();

    expect(callOrder[0]).toBe("config");
    expect(callOrder[1]).toBe("resume");
    expect(database.getPipelineState(branch, trackedPath, "chunk")?.updatedAt).toBeGreaterThan(
      beforeChunk?.updatedAt ?? 0
    );
    expect(database.getPipelineState(branch, trackedPath, "embed")?.updatedAt).toBeGreaterThan(
      beforeEmbed?.updatedAt ?? 0
    );
    expect(database.getPipelineRun("ordering-resume-run")?.status).toBe("cancelled");
    configSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it("prunes old finished pipeline runs during cold start without deleting active run history", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    const status = await indexer.getStatus();
    const branch = status.currentBranch;
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const now = Date.now();
    const oldCompletedAt = now - 8 * 24 * 60 * 60 * 1000;

    database.startPipelineRun(
      {
        runId: "old-complete-run",
        branch,
        runType: "cold_start",
        status: "complete",
        configHash: "old-complete-hash",
        startedAt: oldCompletedAt - 1000,
        completedAt: oldCompletedAt,
      },
      oldCompletedAt
    );
    database.startPipelineRun(
      {
        runId: "old-cancelled-run",
        branch,
        runType: "hot_update",
        status: "cancelled",
        configHash: "old-cancelled-hash",
        startedAt: oldCompletedAt - 2000,
        completedAt: oldCompletedAt,
      },
      oldCompletedAt
    );
    database.startPipelineRun(
      {
        runId: "old-in-progress-run",
        branch,
        runType: "resume",
        status: "in_progress",
        configHash: "old-active-hash",
        startedAt: now - 8 * 24 * 60 * 60 * 1000,
      },
      now - 8 * 24 * 60 * 60 * 1000
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    orchestrator.startupComplete = false;
    await indexer.index();

    expect(database.getPipelineRun("old-complete-run")).toBeNull();
    expect(database.getPipelineRun("old-cancelled-run")).toBeNull();
    expect(database.getPipelineRun("old-in-progress-run")).not.toBeNull();
    expect(database.getPipelineRun("old-in-progress-run")?.status).not.toBe("in_progress");
  });

  it("detects a stale lock, invalidates snapshots and caches, cancels in-progress runs, and forces cold start instead of resume", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const status = await indexer.getStatus();
    const branch = status.currentBranch;
    const indexPath = status.indexPath;
    const database = new Database(path.join(indexPath, "codebase.db"));
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const previousSnapshot = database.getMerkleSnapshot(branch);
    expect(previousSnapshot).toBeTruthy();

    const fileHashCachePath = getFileHashCachePath(indexPath, branch);
    expect(fs.existsSync(fileHashCachePath)).toBe(true);

    database.upsertPipelineState({
      branch,
      filePath: trackedPath,
      stage: "index",
      status: "in_progress",
      updatedAt: Date.now(),
    });
    database.startPipelineRun(
      {
        runId: "stale-lock-run",
        branch,
        runType: "hot_update",
        status: "in_progress",
        configHash: "stale-lock-config",
        startedAt: Date.now(),
      },
      Date.now()
    );

    fs.writeFileSync(
      path.join(indexPath, "indexing.lock"),
      JSON.stringify({
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const resumeSpy = vi.spyOn(orchestrator as any, "resumeInterruptedRuns");
    const indexerInternal = indexer as unknown as {
      stores: Map<string, unknown>;
      invertedIndex: unknown;
      database: unknown;
      provider: unknown;
      configuredProviderInfo: unknown;
      ensureInitialized: () => Promise<void>;
    };
    indexerInternal.stores = new Map();
    indexerInternal.invertedIndex = null;
    indexerInternal.database = null;
    indexerInternal.provider = null;
    indexerInternal.configuredProviderInfo = null;

    await indexerInternal.ensureInitialized();

    const recoveredDatabase = new Database(path.join(indexPath, "codebase.db"));
    expect(recoveredDatabase.getMerkleSnapshot(branch)).toBeNull();
    expect(fs.existsSync(fileHashCachePath)).toBe(false);

    orchestrator.startupComplete = false;
    await indexer.index();

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(recoveredDatabase.getPipelineRun("stale-lock-run")?.status).toBe("cancelled");
    expect(recoveredDatabase.getMerkleSnapshot(branch)).toBeTruthy();
    expect(fs.existsSync(fileHashCachePath)).toBe(true);
    resumeSpy.mockRestore();
  });

  it("forces cold start after vector-store recovery resets persisted state to empty", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database, indexPath } = await openDatabase(indexer);
    const branchChunkCount = database.getBranchChunkIds(branch).length;
    const primaryModelId =
      getIndexerInternals(indexer).primaryStoreModelId ??
      getIndexerInternals(indexer).configuredProviderInfo.modelInfo.model;
    const storeBasePath = getStoreBasePath(indexPath, primaryModelId!);
    fs.rmSync(`${storeBasePath}.meta.json`);

    const restartedIndexer = await createFreshIndexer();
    const loggerWarnSpy = vi.spyOn((restartedIndexer as any).logger, "warn");
    const coldStartSpy = vi.spyOn(getIndexerInternals(restartedIndexer).orchestrator, "coldStart");
    await (restartedIndexer as any).ensureInitialized();

    expect(getIndexerInternals(restartedIndexer).orchestrator.forceColdStart).toBe(true);
    expect(
      loggerWarnSpy.mock.calls.some(
        ([message]) =>
          message ===
          "Retrieval startup integrity check failed: retrieval artifacts are empty, recovered, or underpopulated while the database still has indexed chunks. A full rebuild is required before search results are reliable."
      )
    ).toBe(true);

    await restartedIndexer.index();

    const restartedStore = getIndexerInternals(restartedIndexer).stores.get(primaryModelId!);
    expect(coldStartSpy).toHaveBeenCalled();
    expect((restartedStore as any).count()).toBe(branchChunkCount);
    loggerWarnSpy.mockRestore();
    coldStartSpy.mockRestore();
  });

  it("detects DB-vs-store parity mismatch at startup and warns before forcing cold start", async () => {
    createRepoWithManyFiles(50);
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const branchChunkIds = database.getBranchChunkIds(branch);
    expect(branchChunkIds.length).toBeGreaterThanOrEqual(50);
    const retainedChunkIds = branchChunkIds.slice(0, 5);
    const primaryModelId =
      getIndexerInternals(indexer).primaryStoreModelId ??
      getIndexerInternals(indexer).configuredProviderInfo.modelInfo.model;
    const primaryStore = getIndexerInternals(indexer).stores.get(primaryModelId!) as
      | {
          remove: (chunkId: string) => boolean;
          save: () => void;
          setBranchMembership: (branch: string, chunkIds: string[]) => void;
          count: () => number;
        }
      | undefined;
    const invertedIndex = getIndexerInternals(indexer).invertedIndex as
      | {
          removeChunk: (chunkId: string) => boolean;
          save: () => void;
          setBranchMembership: (branch: string, chunkIds: string[]) => void;
          getDocumentCount: () => number;
        }
      | null
      | undefined;
    expect(primaryStore).toBeTruthy();
    expect(invertedIndex).toBeTruthy();

    for (const chunkId of branchChunkIds.slice(retainedChunkIds.length)) {
      primaryStore!.remove(chunkId);
      invertedIndex!.removeChunk(chunkId);
    }
    primaryStore!.setBranchMembership(branch, retainedChunkIds);
    invertedIndex!.setBranchMembership(branch, retainedChunkIds);
    primaryStore!.save();
    invertedIndex!.save();
    expect(primaryStore!.count()).toBe(retainedChunkIds.length);
    expect(invertedIndex!.getDocumentCount()).toBe(retainedChunkIds.length);

    const restartedIndexer = await createFreshIndexer();
    const loggerWarnSpy = vi.spyOn((restartedIndexer as any).logger, "warn");
    await (restartedIndexer as any).ensureInitialized();

    expect(getIndexerInternals(restartedIndexer).orchestrator.forceColdStart).toBe(true);
    expect(
      loggerWarnSpy.mock.calls.some(
        ([message, details]) =>
          message ===
            "Retrieval startup integrity check failed: retrieval artifacts are empty, recovered, or underpopulated while the database still has indexed chunks. A full rebuild is required before search results are reliable." &&
          (details as {
            branchChunkCount?: number;
            mismatchedStores?: Array<{ modelId: string; count: number }>;
            bm25Count?: number;
          }).branchChunkCount === branchChunkIds.length &&
          (details as {
            mismatchedStores?: Array<{ modelId: string; count: number }>;
          }).mismatchedStores?.some((entry) => entry.count === retainedChunkIds.length) === true &&
          (details as { bm25Count?: number }).bm25Count === retainedChunkIds.length
      )
    ).toBe(true);
    loggerWarnSpy.mockRestore();
  });

  it("detects interrupted finalization at startup, cancels the run, and forces cold start", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const currentConfig = await getCurrentRuntimeConfig(indexer);
    const currentConfigHash = hashConfigVersion(currentConfig);
    database.startPipelineRun(
      {
        runId: "interrupted-finalizing-run",
        branch,
        runType: "hot_update",
        status: "finalizing",
        configHash: currentConfigHash,
        startedAt: Date.now(),
      },
      Date.now()
    );

    const restartedIndexer = await createFreshIndexer();
    const restartedOrchestrator = getIndexerInternals(restartedIndexer).orchestrator;
    const loggerWarnSpy = vi.spyOn((restartedIndexer as any).logger, "warn");

    restartedOrchestrator.startupComplete = false;
    await restartedOrchestrator.ensureStartupState();

    const restartedDb = new Database(
      path.join((await restartedIndexer.getStatus()).indexPath, "codebase.db")
    );
    expect(restartedDb.getPipelineRun("interrupted-finalizing-run")?.status).toBe("cancelled");
    expect(restartedOrchestrator.forceColdStart).toBe(true);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Interrupted finalization detected for run interrupted-finalizing-run"),
      expect.objectContaining({
        branch,
        runId: "interrupted-finalizing-run",
        configHash: currentConfigHash,
      })
    );
    loggerWarnSpy.mockRestore();
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

  it("purges old-branch hot-update jobs and starts the new branch without leaking old state", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const oldBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const queue = orchestrator.queue as {
      enqueue: (job: {
        branch: string;
        filePath: string;
        priority: "low";
        trigger: "cold_start" | "hot_update";
        runId: string;
      }) => void;
      getStats: () => { pendingCount: number };
    };

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
    const featureFile = path.join(tempDir, "src", "feature-only.ts");
    fs.writeFileSync(
      featureFile,
      "export function featureOnly(): number { return 999; }\n",
      "utf-8"
    );

    database.startPipelineRun(
      {
        runId: "branch-change-run",
        branch,
        runType: "hot_update",
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
      trigger: "hot_update",
      runId: "branch-change-run",
    });
    queue.enqueue({
      branch,
      filePath: fileB,
      priority: "low",
      trigger: "hot_update",
      runId: "branch-change-run",
    });
    expect(queue.getStats().pendingCount).toBeGreaterThan(0);

    await orchestrator.handleBranchChange(branch, "feature");

    expect(database.getPipelineRun("branch-change-run")?.status).toBe("cancelled");
    expect(queue.getStats().pendingCount).toBe(0);
    expect(database.getMerkleSnapshot("feature")).toBeTruthy();
    const featureChunkIds = new Set(database.getBranchChunkIds("feature"));
    expect(featureChunkIds.size).toBeGreaterThan(0);
    for (const chunkId of oldBranchChunkIds) {
      expect(featureChunkIds.has(chunkId)).toBe(false);
    }
  });

  it("pushes only branch membership deltas to native retrieval filters on hot update", async () => {
    createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const initialBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    const orchestrator = getIndexerInternals(indexer).orchestrator as unknown as {
      host: {
        applyNativeBranchMembershipDelta: (
          branch: string,
          addedChunkIds: string[],
          removedChunkIds: string[]
        ) => void;
        syncNativeBranchMembership: (branch: string, chunkIds: string[]) => void;
      };
    };
    const applyDeltaSpy = vi.spyOn(orchestrator.host, "applyNativeBranchMembershipDelta");
    const syncMembershipSpy = vi.spyOn(orchestrator.host, "syncNativeBranchMembership");
    applyDeltaSpy.mockClear();
    syncMembershipSpy.mockClear();

    const addedFile = path.join(tempDir, "src", "delta-added.ts");
    fs.writeFileSync(
      addedFile,
      "export function deltaAddedHotUpdate(): number { return 7; }\n",
      "utf-8"
    );

    await indexer.handleFileChanges([{ type: "add", path: addedFile }]);

    const updatedBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    const addedChunkIds = Array.from(updatedBranchChunkIds).filter(
      (chunkId) => !initialBranchChunkIds.has(chunkId)
    );

    expect(addedChunkIds.length).toBeGreaterThan(0);
    expect(syncMembershipSpy).not.toHaveBeenCalled();
    expect(applyDeltaSpy).toHaveBeenCalled();

    applyDeltaSpy.mockRestore();
    syncMembershipSpy.mockRestore();
  });

  it("uses cold start instead of hot update when switching to a branch with no prior snapshot", async () => {
    createSingleFileRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const orchestrator = getIndexerInternals(indexer).orchestrator;
    const coldStartSpy = vi.spyOn(orchestrator, "coldStart");
    const hotUpdateSpy = vi.spyOn(orchestrator, "hotUpdate");

    await indexer.handleBranchChange(branch, "brand-new-branch");

    expect(coldStartSpy).toHaveBeenCalledTimes(1);
    expect(hotUpdateSpy).not.toHaveBeenCalled();
    expect(database.getMerkleSnapshot("brand-new-branch")).toBeTruthy();

    coldStartSpy.mockRestore();
    hotUpdateSpy.mockRestore();
  });

  it("removes deleted files from the active branch, keeps cross-branch references, and clears pipeline state", async () => {
    const { fileA } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.index();

    const { branch, database } = await openDatabase(indexer);
    const trackedPath = resolveTrackedPath(database, branch, fileA, tempDir);
    const mainBranchChunkIds = new Set(database.getBranchChunkIds(branch));
    const fileChunkIds = database
      .getChunksByFile(trackedPath)
      .filter((chunk) => mainBranchChunkIds.has(chunk.chunkId))
      .map((chunk) => chunk.chunkId);
    database.addChunksToBranchBatch("feature", fileChunkIds);

    const removeChunkSpy = vi.spyOn(
      indexer as unknown as {
        removeChunkFromRetrievalIfUnreferenced: (
          database: Database,
          invertedIndex: unknown,
          chunkId: string
        ) => boolean;
      },
      "removeChunkFromRetrievalIfUnreferenced"
    );

    fs.unlinkSync(fileA);
    await indexer.handleFileChanges([{ type: "unlink", path: fileA }]);

    const updatedMainChunkIds = new Set(database.getBranchChunkIds(branch));
    const featureChunkIds = new Set(database.getBranchChunkIds("feature"));
    for (const chunkId of fileChunkIds) {
      expect(updatedMainChunkIds.has(chunkId)).toBe(false);
      expect(featureChunkIds.has(chunkId)).toBe(true);
    }
    expect(removeChunkSpy.mock.calls.length).toBeGreaterThan(0);
    const checkedChunkIds = new Set(
      removeChunkSpy.mock.calls.map((call) => call[2] as string)
    );
    for (const chunkId of fileChunkIds) {
      expect(checkedChunkIds.has(chunkId)).toBe(true);
    }
    removeChunkSpy.mockRestore();

    for (const stage of ["chunk", "embed", "index", "graph"] as const) {
      expect(database.getPipelineState(branch, trackedPath, stage)).toBeNull();
    }
  });

  it("routes refreshBranchInfo through setCurrentBranch before publishing a branch change", async () => {
    createRepo();
    createGitRepoMetadata("feature", ["main", "feature"]);
    const indexer = new Indexer(tempDir, createConfig());
    const indexerAny = indexer as any;
    indexerAny.currentBranch = "main";
    indexerAny.baseBranch = "main";

    let membershipLoaded = false;
    const originalPublishCurrentBranch = indexerAny.publishCurrentBranch;
    const setCurrentBranchSpy = vi.spyOn(indexerAny, "setCurrentBranch");
    const loadMembershipSpy = vi
      .spyOn(indexerAny, "loadNativeBranchMembership")
      .mockImplementation((branchName: string) => {
        membershipLoaded = true;
        expect(branchName).toBe("feature");
      });
    const publishBranchSpy = vi
      .spyOn(indexerAny, "publishCurrentBranch")
      .mockImplementation(function (this: any, branchName: string): void {
        expect(branchName).toBe("feature");
        expect(membershipLoaded).toBe(true);
        expect(this.currentBranch).toBe("main");
        originalPublishCurrentBranch.call(this, branchName);
      });

    await indexerAny.refreshBranchInfo();

    expect(setCurrentBranchSpy).toHaveBeenCalledWith("feature");
    expect(indexerAny.currentBranch).toBe("feature");

    setCurrentBranchSpy.mockRestore();
    loadMembershipSpy.mockRestore();
    publishBranchSpy.mockRestore();
  });

  it("skips branch publication work when refreshBranchInfo sees no branch change", async () => {
    createRepo();
    createGitRepoMetadata("main", ["main", "feature"]);
    const indexer = new Indexer(tempDir, createConfig());
    const indexerAny = indexer as any;
    indexerAny.currentBranch = "main";
    indexerAny.baseBranch = "main";

    const setCurrentBranchSpy = vi.spyOn(indexerAny, "setCurrentBranch");
    const loadMembershipSpy = vi.spyOn(indexerAny, "loadNativeBranchMembership");

    await indexerAny.refreshBranchInfo();

    expect(setCurrentBranchSpy).not.toHaveBeenCalled();
    expect(loadMembershipSpy).not.toHaveBeenCalled();
    expect(indexerAny.currentBranch).toBe("main");

    setCurrentBranchSpy.mockRestore();
    loadMembershipSpy.mockRestore();
  });
});
