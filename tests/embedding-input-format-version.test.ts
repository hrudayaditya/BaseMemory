import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCustomProviderInfo } from "../src/embeddings/detector.js";
import { CheckpointManager } from "../src/indexer/checkpoint-manager.js";
import { buildEmbedStageInputHash } from "../src/indexer/incremental-index-orchestrator.js";
import {
  Database,
  EMBEDDING_INPUT_FORMAT_VERSION,
  prepareEmbeddingInput,
} from "../src/native/index.js";

async function loadConfigVersionModuleWithFormatVersion(version: number) {
  vi.resetModules();
  vi.doMock("../src/native/index.js", async () => {
    const actual = await vi.importActual<typeof import("../src/native/index.js")>(
      "../src/native/index.js"
    );

    return {
      ...actual,
      EMBEDDING_INPUT_FORMAT_VERSION: version,
    };
  });

  return import("../src/indexer/config-version.js");
}

describe("embedding input format version enforcement", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.doUnmock("../src/native/index.js");
    vi.resetModules();

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("changes hashEmbedConfig when the embedding input format version changes and stays stable when it does not", async () => {
    const providerInfo = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });

    const currentModule = await loadConfigVersionModuleWithFormatVersion(
      EMBEDDING_INPUT_FORMAT_VERSION
    );
    const sameVersionModule = await loadConfigVersionModuleWithFormatVersion(
      EMBEDDING_INPUT_FORMAT_VERSION
    );
    const bumpedModule = await loadConfigVersionModuleWithFormatVersion(
      EMBEDDING_INPUT_FORMAT_VERSION + 1
    );

    const currentHash = currentModule.hashEmbedConfig(providerInfo);
    const sameVersionHash = sameVersionModule.hashEmbedConfig(providerInfo);
    const bumpedHash = bumpedModule.hashEmbedConfig(providerInfo);

    expect(sameVersionHash).toBe(currentHash);
    expect(bumpedHash).not.toBe(currentHash);
  });

  it("marks completed embed checkpoints stale after an embedding input format version bump", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-input-format-version-"));

    const database = new Database(path.join(tempDir, "checkpoint.db"));
    const checkpointManager = new CheckpointManager(database);
    const providerInfo = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });
    const filePath = "/repo/src/stable.ts";
    const embeddingInputHash = prepareEmbeddingInput(
      {
        content: "export function stable(): number { return 1; }\n",
        startLine: 1,
        endLine: 1,
        chunkType: "function",
        name: "stable",
        symbolKind: "Function",
        language: "typescript",
      },
      filePath,
      "/repo",
      8_192
    ).hash;

    const currentModule = await loadConfigVersionModuleWithFormatVersion(
      EMBEDDING_INPUT_FORMAT_VERSION
    );
    const bumpedModule = await loadConfigVersionModuleWithFormatVersion(
      EMBEDDING_INPUT_FORMAT_VERSION + 1
    );

    const currentStageHash = buildEmbedStageInputHash(
      [embeddingInputHash],
      currentModule.hashEmbedConfig(providerInfo)
    );
    const bumpedStageHash = buildEmbedStageInputHash(
      [embeddingInputHash],
      bumpedModule.hashEmbedConfig(providerInfo)
    );

    checkpointManager.markStageComplete("main", filePath, "embed", currentStageHash);

    expect(
      checkpointManager.isStageStale("main", filePath, "embed", currentStageHash)
    ).toBe(false);
    expect(
      checkpointManager.isStageStale("main", filePath, "embed", bumpedStageHash)
    ).toBe(true);
  });
});
