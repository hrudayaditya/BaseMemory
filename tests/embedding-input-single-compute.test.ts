import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareEmbeddingInputSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/native/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/native/index.js")>(
    "../src/native/index.js"
  );
  prepareEmbeddingInputSpy.mockImplementation(actual.prepareEmbeddingInput);
  return {
    ...actual,
    prepareEmbeddingInput: prepareEmbeddingInputSpy,
  };
});

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

describe("embedding input single-compute path", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function createMockEmbeddingResponse(init: RequestInit | undefined): Response {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; model?: string };
    const texts = Array.isArray(body.input) ? body.input : [];
    const data = texts.map((text) => {
      let seed = 0;
      for (const ch of text) {
        seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
      }
      const embedding = Array.from(
        { length: 8 },
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

  function createConfig() {
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
    });
  }

  function createRepo(): { fileA: string; fileB: string } {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const fileA = path.join(srcDir, "alpha.ts");
    const fileB = path.join(srcDir, "beta.ts");
    fs.writeFileSync(fileA, "export function alpha(): number { return 1; }\n", "utf-8");
    fs.writeFileSync(fileB, "export function beta(): number { return 2; }\n", "utf-8");

    return { fileA, fileB };
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-input-single-compute-"));
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => createMockEmbeddingResponse(init));
    prepareEmbeddingInputSpy.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    prepareEmbeddingInputSpy.mockClear();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("computes embedding text exactly once per embedded chunk", async () => {
    const { fileA, fileB } = createRepo();
    const indexer = new Indexer(tempDir, createConfig());

    await indexer.index();

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    const trackedA = resolveTrackedPath(database, status.currentBranch, fileA, tempDir);
    const trackedB = resolveTrackedPath(database, status.currentBranch, fileB, tempDir);
    const embeddedChunkCount =
      database.getChunksByFileOnBranch(trackedA, status.currentBranch).length +
      database.getChunksByFileOnBranch(trackedB, status.currentBranch).length;
    const providerInputs = fetchSpy.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    const preparedTexts = prepareEmbeddingInputSpy.mock.results
      .filter((result) => result.type === "return")
      .map((result) => (result.value as { text: string }).text);

    expect(embeddedChunkCount).toBeGreaterThan(0);
    expect(prepareEmbeddingInputSpy).toHaveBeenCalledTimes(embeddedChunkCount);
    expect(providerInputs).toEqual(preparedTexts);
  });
});
