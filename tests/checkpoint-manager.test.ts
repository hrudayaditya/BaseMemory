import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CheckpointManager } from "../src/indexer/checkpoint-manager.js";
import { Database } from "../src/native/index.js";

describe("CheckpointManager", () => {
  let tempDir: string;
  let database: Database;
  let nowMs: number;
  let runIdCounter: number;
  let manager: CheckpointManager;

  function trackFileOnBranch(branch: string, filePath: string, chunkId: string): void {
    database.upsertChunk({
      chunkId,
      contentHash: `${chunkId}-content`,
      embeddingInputHash: `${chunkId}-content`,
      filePath,
      startLine: 1,
      endLine: 10,
      language: "typescript",
    });
    database.addChunksToBranch(branch, [chunkId]);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-manager-test-"));
    database = new Database(path.join(tempDir, "test.db"));
    nowMs = 1_000;
    runIdCounter = 0;
    manager = new CheckpointManager(database, {
      now: () => nowMs,
      makeRunId: () => `run-${++runIdCounter}`,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("stage stale checks", () => {
    it("treats a missing row as stale", () => {
      expect(manager.isStageStale("main", "src/file.ts", "chunk", "hash-1")).toBe(true);
    });

    it("treats non-complete rows as stale", () => {
      manager.markStageInProgress("main", "src/file.ts", "chunk", "hash-1");
      expect(manager.isStageStale("main", "src/file.ts", "chunk", "hash-1")).toBe(true);

      manager.markStageComplete("main", "src/file.ts", "embed", "hash-2");
      manager.resetStageType("main", "embed");
      expect(manager.isStageStale("main", "src/file.ts", "embed", "hash-2")).toBe(true);

      manager.markStageFailed("main", "src/file.ts", "graph", "boom", "hash-3");
      expect(manager.isStageStale("main", "src/file.ts", "graph", "hash-3")).toBe(true);
    });

    it("treats a complete row with a different input hash as stale", () => {
      manager.markStageInProgress("main", "src/file.ts", "chunk", "hash-1");
      nowMs = 2_000;
      manager.markStageComplete("main", "src/file.ts", "chunk", "hash-1");

      expect(manager.isStageStale("main", "src/file.ts", "chunk", "hash-2")).toBe(true);
    });

    it("treats a complete row with an exact matching input hash as clean", () => {
      manager.markStageInProgress("main", "src/file.ts", "chunk", "hash-1");
      nowMs = 2_000;
      manager.markStageComplete("main", "src/file.ts", "chunk", "hash-1");

      expect(manager.isStageStale("main", "src/file.ts", "chunk", "hash-1")).toBe(false);
    });

    it("treats a late completion from an older job as stale for the newer hash", () => {
      manager.markStageInProgress("main", "src/file.ts", "embed", "hash-old");
      manager.markStageInProgress("main", "src/file.ts", "embed", "hash-new");

      nowMs = 2_000;
      manager.markStageComplete("main", "src/file.ts", "embed", "hash-old");

      expect(manager.getStageState("main", "src/file.ts", "embed")).toEqual({
        branch: "main",
        filePath: "src/file.ts",
        stage: "embed",
        status: "complete",
        inputHash: "hash-old",
        error: undefined,
        updatedAt: 2_000,
      });
      expect(manager.isStageStale("main", "src/file.ts", "embed", "hash-new")).toBe(true);
    });
  });

  describe("stage transitions", () => {
    it("records in-progress and complete stage transitions end-to-end", () => {
      manager.markStageInProgress("main", "src/file.ts", "chunk", "hash-1");

      const inProgress = manager.getStageState("main", "src/file.ts", "chunk");
      expect(inProgress).toEqual({
        branch: "main",
        filePath: "src/file.ts",
        stage: "chunk",
        status: "in_progress",
        inputHash: "hash-1",
        error: undefined,
        updatedAt: 1_000,
      });

      nowMs = 2_000;
      manager.markStageComplete("main", "src/file.ts", "chunk", "hash-1");

      expect(manager.getStageState("main", "src/file.ts", "chunk")).toEqual({
        branch: "main",
        filePath: "src/file.ts",
        stage: "chunk",
        status: "complete",
        inputHash: "hash-1",
        error: undefined,
        updatedAt: 2_000,
      });
    });

    it("records failed stage transitions and preserves the input hash", () => {
      manager.markStageInProgress("main", "src/file.ts", "embed", "hash-embed");
      nowMs = 3_000;
      manager.markStageFailed("main", "src/file.ts", "embed", "embedding failed", "hash-embed");

      expect(manager.getStageState("main", "src/file.ts", "embed")).toEqual({
        branch: "main",
        filePath: "src/file.ts",
        stage: "embed",
        status: "failed",
        inputHash: "hash-embed",
        error: "embedding failed",
        updatedAt: 3_000,
      });
    });

    it("finds files on a branch with unfinished work, including missing stages", () => {
      trackFileOnBranch("main", "src/a.ts", "chunk-a");
      trackFileOnBranch("main", "src/b.ts", "chunk-b");
      trackFileOnBranch("main", "src/c.ts", "chunk-c");
      trackFileOnBranch("main", "src/d.ts", "chunk-d");
      trackFileOnBranch("feature", "src/e.ts", "chunk-e");

      manager.markStageInProgress("main", "src/a.ts", "chunk", "hash-a");
      manager.markStageComplete("main", "src/b.ts", "chunk", "hash-b");
      manager.markStageComplete("main", "src/d.ts", "chunk", "hash-d-chunk");
      manager.markStageComplete("main", "src/d.ts", "embed", "hash-d-embed");
      manager.markStageComplete("main", "src/d.ts", "index", "hash-d-index");
      manager.markStageComplete("main", "src/d.ts", "graph", "hash-d-graph");
      manager.markStageInProgress("feature", "src/e.ts", "chunk", "hash-e");

      expect(manager.getUnfinishedFiles("main")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    });

    it("treats complete rows with a null input hash as unfinished", () => {
      trackFileOnBranch("main", "src/null-hash.ts", "chunk-null-hash");

      manager.markStageComplete("main", "src/null-hash.ts", "chunk", "hash-chunk");
      database.upsertPipelineState({
        branch: "main",
        filePath: "src/null-hash.ts",
        stage: "embed",
        status: "complete",
        updatedAt: 1_000,
      });
      manager.markStageComplete("main", "src/null-hash.ts", "index", "hash-index");
      manager.markStageComplete("main", "src/null-hash.ts", "graph", "hash-graph");

      expect(manager.getUnfinishedFiles("main")).toEqual(["src/null-hash.ts"]);
    });

    it("resets only one stage type on one branch", () => {
      manager.markStageComplete("main", "src/a.ts", "chunk", "hash-a");
      manager.markStageFailed("main", "src/a.ts", "embed", "embed failed", "hash-b");
      manager.markStageFailed("main", "src/b.ts", "chunk", "chunk failed", "hash-c");
      manager.markStageComplete("feature", "src/c.ts", "chunk", "hash-d");

      nowMs = 4_000;
      expect(manager.resetStageType("main", "chunk")).toBe(2);

      expect(manager.getStageState("main", "src/a.ts", "chunk")).toEqual({
        branch: "main",
        filePath: "src/a.ts",
        stage: "chunk",
        status: "pending",
        inputHash: undefined,
        error: undefined,
        updatedAt: 4_000,
      });
      expect(manager.getStageState("main", "src/b.ts", "chunk")).toEqual({
        branch: "main",
        filePath: "src/b.ts",
        stage: "chunk",
        status: "pending",
        inputHash: undefined,
        error: undefined,
        updatedAt: 4_000,
      });
      expect(manager.getStageState("main", "src/a.ts", "embed")).toEqual({
        branch: "main",
        filePath: "src/a.ts",
        stage: "embed",
        status: "failed",
        inputHash: "hash-b",
        error: "embed failed",
        updatedAt: 1_000,
      });
      expect(manager.getStageState("feature", "src/c.ts", "chunk")).toEqual({
        branch: "feature",
        filePath: "src/c.ts",
        stage: "chunk",
        status: "complete",
        inputHash: "hash-d",
        error: undefined,
        updatedAt: 1_000,
      });
    });

    it("wipes stage state for one branch without affecting others", () => {
      manager.markStageComplete("main", "src/a.ts", "chunk", "hash-a");
      manager.markStageFailed("main", "src/b.ts", "embed", "embed failed", "hash-b");
      manager.markStageComplete("feature", "src/c.ts", "chunk", "hash-c");

      expect(manager.clearBranchState("main")).toBe(2);

      expect(manager.getStageState("main", "src/a.ts", "chunk")).toBeNull();
      expect(manager.getStageState("main", "src/b.ts", "embed")).toBeNull();
      expect(manager.getStageState("feature", "src/c.ts", "chunk")).toEqual({
        branch: "feature",
        filePath: "src/c.ts",
        stage: "chunk",
        status: "complete",
        inputHash: "hash-c",
        error: undefined,
        updatedAt: 1_000,
      });
    });
  });

  describe("run history", () => {
    it("cancels any active branch run before creating a new one", () => {
      const firstRun = manager.startRun("main", "cold_start", "config-1");

      nowMs = 2_000;
      const secondRun = manager.startRun("main", "hot_update", "config-2");

      expect(manager.getInProgressRuns()).toEqual([secondRun]);
      expect(manager.getRun(firstRun.runId)).toEqual({
        ...firstRun,
        status: "cancelled",
        completedAt: 2_000,
      });
      expect(manager.getRun(secondRun.runId)).toEqual(secondRun);
    });

    it("cancelling active runs does not affect pipeline_state", () => {
      manager.markStageComplete("main", "src/a.ts", "chunk", "hash-a");
      manager.startRun("main", "cold_start", "config-1");

      nowMs = 2_000;
      expect(manager.cancelActiveRuns("main")).toBe(1);
      expect(manager.getStageState("main", "src/a.ts", "chunk")).toEqual({
        branch: "main",
        filePath: "src/a.ts",
        stage: "chunk",
        status: "complete",
        inputHash: "hash-a",
        error: undefined,
        updatedAt: 1_000,
      });
    });

    it("marks runs complete and failed", () => {
      const completedRun = manager.startRun("main", "cold_start", "config-1");
      nowMs = 2_000;
      expect(manager.markRunComplete(completedRun.runId)).toBe(true);

      const failedRun = manager.startRun("feature", "resume", "config-2");
      nowMs = 3_000;
      expect(manager.markRunFailed(failedRun.runId)).toBe(true);

      expect(manager.getRun(completedRun.runId)).toEqual({
        ...completedRun,
        status: "complete",
        completedAt: 2_000,
      });
      expect(manager.getRun(failedRun.runId)).toEqual({
        ...failedRun,
        status: "failed",
        completedAt: 3_000,
      });
    });

    it("returns all currently in-progress runs across branches", () => {
      const mainRun = manager.startRun("main", "cold_start", "config-1");
      const featureRun = manager.startRun("feature", "resume", "config-2");

      nowMs = 2_000;
      manager.markRunComplete(mainRun.runId);

      expect(manager.getInProgressRuns()).toEqual([featureRun]);
    });

    it("prunes old finished runs without touching in-progress runs", () => {
      const oldRun = manager.startRun("main", "cold_start", "config-1");
      nowMs = 2_000;
      manager.markRunComplete(oldRun.runId);

      nowMs = 3_000;
      const activeRun = manager.startRun("feature", "resume", "config-2");

      nowMs = 10_000;
      expect(manager.pruneFinishedRuns(5_000)).toBe(1);

      expect(manager.getRun(oldRun.runId)).toBeNull();
      expect(manager.getRun(activeRun.runId)).toEqual(activeRun);
      expect(manager.getInProgressRuns()).toEqual([activeRun]);
    });
  });
});
