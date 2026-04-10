import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { VectorStore, type ChunkMetadata } from "../src/native/index.js";

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

function createMetadata(filePath: string, hash: string): ChunkMetadata {
  return {
    filePath,
    startLine: 1,
    endLine: 1,
    chunkType: "function",
    name: "example",
    language: "typescript",
    hash,
  };
}

function createVector(dimensions: number, seed: number): number[] {
  return Array.from({ length: dimensions }, (_, index) => ((seed + index * 17) % 997) / 997);
}

function getInternals(indexer: Indexer): {
  stores: Map<string, VectorStore>;
  configuredProviderInfo: { modelInfo: { model: string } };
  storePathForModel(modelId: string): string;
  hasStore(modelId: string): boolean;
  getStore(modelId: string): VectorStore;
  saveAllStores(): void;
  loadAllStores(): void;
} {
  return indexer as unknown as {
    stores: Map<string, VectorStore>;
    configuredProviderInfo: { modelInfo: { model: string } };
    storePathForModel(modelId: string): string;
    hasStore(modelId: string): boolean;
    getStore(modelId: string): VectorStore;
    saveAllStores(): void;
    loadAllStores(): void;
  };
}

describe("multi-index vector store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-index-store-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves single-store behavior when Voyage is not configured", async () => {
    const indexer = new Indexer(tempDir, createConfig());
    await indexer.initialize();

    const internals = getInternals(indexer);
    expect(Array.from(internals.stores.keys())).toEqual(["mock-embedding-model"]);
    expect(internals.hasStore("mock-embedding-model")).toBe(true);
    expect(internals.hasStore("voyage-code-2")).toBe(false);
  });

  it("initializes dual named stores with model-keyed paths and dimensions when Voyage is configured", async () => {
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const internals = getInternals(indexer);
    expect(Array.from(internals.stores.keys())).toEqual([
      "mock-embedding-model",
      "voyage-code-2",
    ]);
    expect(internals.getStore("mock-embedding-model").getDimensions()).toBe(8);
    expect(internals.getStore("voyage-code-2").getDimensions()).toBe(1536);
    const resolvedTempDir = fs.realpathSync(tempDir);
    expect(internals.storePathForModel("mock-embedding-model")).toBe(
      path.join(resolvedTempDir, ".opencode", "index", "vectors-mock-embedding-model")
    );
    expect(internals.storePathForModel("voyage-code-2")).toBe(
      path.join(resolvedTempDir, ".opencode", "index", "vectors-voyage-code-2")
    );
  });

  it("migrates the legacy vectors store to the model-keyed primary path on initialize", async () => {
    const resolvedTempDir = fs.realpathSync(tempDir);
    const indexPath = path.join(resolvedTempDir, ".opencode", "index");
    fs.mkdirSync(indexPath, { recursive: true });

    const legacyBasePath = path.join(indexPath, "vectors");
    const legacyStore = new VectorStore(legacyBasePath, 8);
    legacyStore.add("legacy-chunk", createVector(8, 1), createMetadata("/tmp/legacy.ts", "legacy-hash"));
    legacyStore.save();

    const legacyIndexFile = legacyBasePath;
    const legacyMetaFile = `${legacyBasePath}.meta.json`;
    expect(fs.existsSync(legacyIndexFile)).toBe(true);
    expect(fs.existsSync(legacyMetaFile)).toBe(true);

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.initialize();

    const newBasePath = path.join(indexPath, "vectors-mock-embedding-model");
    expect(fs.existsSync(legacyIndexFile)).toBe(false);
    expect(fs.existsSync(legacyMetaFile)).toBe(false);
    expect(fs.existsSync(newBasePath)).toBe(true);
    expect(fs.existsSync(`${newBasePath}.meta.json`)).toBe(true);
    expect(getInternals(indexer).hasStore("mock-embedding-model")).toBe(true);
  });

  it("does not rename the legacy store when the model-keyed store already exists", async () => {
    const resolvedTempDir = fs.realpathSync(tempDir);
    const indexPath = path.join(resolvedTempDir, ".opencode", "index");
    fs.mkdirSync(indexPath, { recursive: true });

    const legacyBasePath = path.join(indexPath, "vectors");
    const legacyStore = new VectorStore(legacyBasePath, 8);
    legacyStore.add("legacy-chunk", createVector(8, 1), createMetadata("/tmp/legacy.ts", "legacy-hash"));
    legacyStore.save();

    const namedBasePath = path.join(indexPath, "vectors-mock-embedding-model");
    const namedStore = new VectorStore(namedBasePath, 8);
    namedStore.add("named-chunk", createVector(8, 2), createMetadata("/tmp/named.ts", "named-hash"));
    namedStore.save();

    const indexer = new Indexer(tempDir, createConfig());
    await indexer.initialize();

    expect(fs.existsSync(legacyBasePath)).toBe(true);
    expect(fs.existsSync(`${legacyBasePath}.meta.json`)).toBe(true);
    expect(getInternals(indexer).hasStore("mock-embedding-model")).toBe(true);
  });

  it("exposes hasStore/getStore for initialized and missing models", async () => {
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const internals = getInternals(indexer);
    expect(internals.hasStore("voyage-code-2")).toBe(true);
    expect(internals.hasStore("missing-model")).toBe(false);
    expect(() => internals.getStore("missing-model")).toThrow(
      'Vector store for model "missing-model" has not been initialized.'
    );
  });

  it("saves and loads all initialized stores", async () => {
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const internals = getInternals(indexer);
    const primarySaveSpy = vi.spyOn(internals.getStore("mock-embedding-model"), "save");
    const voyageSaveSpy = vi.spyOn(internals.getStore("voyage-code-2"), "save");
    const primaryLoadSpy = vi.spyOn(internals.getStore("mock-embedding-model"), "load");
    const voyageLoadSpy = vi.spyOn(internals.getStore("voyage-code-2"), "load");

    internals.saveAllStores();
    internals.loadAllStores();

    expect(primarySaveSpy).toHaveBeenCalledTimes(1);
    expect(voyageSaveSpy).toHaveBeenCalledTimes(1);
    expect(primaryLoadSpy).toHaveBeenCalledTimes(1);
    expect(voyageLoadSpy).toHaveBeenCalledTimes(1);
  });

  it("clearIndex clears all initialized stores", async () => {
    const indexer = new Indexer(
      tempDir,
      createConfig({
        voyageApiKey: "voyage-test-key",
      })
    );
    await indexer.initialize();

    const internals = getInternals(indexer);
    const primaryStore = internals.getStore("mock-embedding-model");
    const voyageStore = internals.getStore("voyage-code-2");
    primaryStore.add("primary-chunk", createVector(8, 3), createMetadata("/tmp/primary.ts", "primary-hash"));
    voyageStore.add("voyage-chunk", createVector(1536, 4), createMetadata("/tmp/voyage.ts", "voyage-hash"));

    expect(primaryStore.count()).toBe(1);
    expect(voyageStore.count()).toBe(1);

    await indexer.clearIndex();

    expect(primaryStore.count()).toBe(0);
    expect(voyageStore.count()).toBe(0);
  });
});
