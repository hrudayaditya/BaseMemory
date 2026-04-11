import { randomUUID } from "crypto";

import type { ConfigVersion } from "./config-version.js";
import {
  Database,
  type PipelineRunData,
  type PipelineStateData,
  type StoredBranchConfigVersionData,
  type StoredConfigVersionData,
} from "../native/index.js";

export type PipelineStage = "chunk" | "embed" | "index" | "graph";
export type PipelineStageStatus = "pending" | "in_progress" | "complete" | "failed";
export type PipelineRunType = "cold_start" | "hot_update" | "config_change" | "resume";
export type PipelineRunStatus = "in_progress" | "complete" | "failed" | "cancelled";

export interface CheckpointManagerOptions {
  now?: () => number;
  makeRunId?: () => string;
}

/**
 * Owns all reads and writes to pipeline_state, pipeline_runs, and the
 * persisted config records that drive branch-level invalidation.
 *
 * Expected stage input hashes are constructed by the orchestrator, not here:
 * CHUNK: `hash(fileContentHash + chunkerVersion)`
 * EMBED: file-level aggregate of `hash(embeddingInputHash + embedConfigHash)` across the file's
 *   current chunks, where `embeddingInputHash = hash(createEmbeddingText(...))` and
 *   `embedConfigHash = hashEmbedConfig(providerInfo)`
 * INDEX: file-level bookkeeping hash derived from the current chunk/embed identity; INDEX still reruns
 *   whenever CHUNK changes structure or EMBED reruns any chunk
 * GRAPH: `hash(fileContentHash + graphExtractorVersion)`
 *
 * This manager treats input hashes as opaque strings and applies the stale check
 * exactly as stored in pipeline_state.
 */
export class CheckpointManager {
  private readonly now: () => number;
  private readonly makeRunId: () => string;

  constructor(
    private readonly database: Database,
    options: CheckpointManagerOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.makeRunId = options.makeRunId ?? (() => randomUUID());
  }

  getStageState(
    branch: string,
    filePath: string,
    stage: PipelineStage
  ): PipelineStateData | null {
    return this.database.getPipelineState(branch, filePath, stage);
  }

  markStageInProgress(
    branch: string,
    filePath: string,
    stage: PipelineStage,
    inputHash: string
  ): void {
    this.database.upsertPipelineState({
      branch,
      filePath,
      stage,
      status: "in_progress",
      inputHash,
      updatedAt: this.now(),
    });
  }

  markStagePending(
    branch: string,
    filePath: string,
    stage: PipelineStage
  ): void {
    this.database.upsertPipelineState({
      branch,
      filePath,
      stage,
      status: "pending",
      updatedAt: this.now(),
    });
  }

  ensureTrackedFile(branch: string, filePath: string): void {
    if (!this.getStageState(branch, filePath, "chunk")) {
      this.markStagePending(branch, filePath, "chunk");
    }
  }

  /**
   * The caller must pass the same input hash used for markStageInProgress for
   * this specific job attempt. Completion never reads the current row because
   * overlapping attempts can otherwise stamp a stale result as clean.
   */
  markStageComplete(
    branch: string,
    filePath: string,
    stage: PipelineStage,
    inputHash: string
  ): void {
    this.database.upsertPipelineState({
      branch,
      filePath,
      stage,
      status: "complete",
      inputHash,
      updatedAt: this.now(),
    });
  }

  /**
   * The caller must pass the same input hash used for markStageInProgress for
   * this specific job attempt. Failure never reads the current row for the
   * same overlap-safety reason as markStageComplete.
   */
  markStageFailed(
    branch: string,
    filePath: string,
    stage: PipelineStage,
    error: string,
    inputHash: string
  ): void {
    this.database.upsertPipelineState({
      branch,
      filePath,
      stage,
      status: "failed",
      inputHash,
      error,
      updatedAt: this.now(),
    });
  }

  isStageStale(
    branch: string,
    filePath: string,
    stage: PipelineStage,
    currentInputHash: string
  ): boolean {
    const state = this.getStageState(branch, filePath, stage);

    if (!state) {
      return true;
    }

    if (state.status !== "complete") {
      return true;
    }

    return state.inputHash !== currentInputHash;
  }

  getUnfinishedFiles(branch: string): string[] {
    return this.database.getUnfinishedPipelineFiles(branch);
  }

  getKnownFiles(branch: string): string[] {
    return this.database.getKnownPipelineFiles(branch);
  }

  resetStageType(branch: string, stage: PipelineStage): number {
    return this.database.resetPipelineStage(branch, stage, this.now());
  }

  clearBranchState(branch: string): number {
    return this.database.clearPipelineStateForBranch(branch);
  }

  clearFileState(branch: string, filePath: string): number {
    return this.database.clearPipelineStateForFile(branch, filePath);
  }

  startRun(
    branch: string,
    runType: PipelineRunType,
    configHash: string
  ): PipelineRunData {
    const now = this.now();
    const run: PipelineRunData = {
      runId: this.makeRunId(),
      branch,
      runType,
      status: "in_progress",
      configHash,
      startedAt: now,
      completedAt: undefined,
    };

    this.database.startPipelineRun(run, now);
    return run;
  }

  markRunComplete(runId: string): boolean {
    return this.database.updatePipelineRunStatus(runId, "complete", this.now());
  }

  markRunFailed(runId: string): boolean {
    return this.database.updatePipelineRunStatus(runId, "failed", this.now());
  }

  getRun(runId: string): PipelineRunData | null {
    return this.database.getPipelineRun(runId);
  }

  cancelActiveRuns(branch: string): number {
    return this.database.cancelActivePipelineRuns(branch, this.now());
  }

  getInProgressRuns(): PipelineRunData[] {
    return this.database.getActivePipelineRuns();
  }

  pruneFinishedRuns(retentionMs: number): number {
    return this.database.pruneFinishedPipelineRuns(this.now() - retentionMs);
  }

  getActiveConfigVersion(): StoredConfigVersionData | null {
    return this.database.getActiveConfigVersion();
  }

  getConfigVersion(configHash: string): StoredConfigVersionData | null {
    return this.database.getConfigVersion(configHash);
  }

  activateConfigVersion(configHash: string, configVersion: ConfigVersion): void {
    this.database.activateConfigVersion({
      configHash,
      embeddingModelId: configVersion.embeddingModelId,
      embeddingDimension: configVersion.embeddingDimension,
      voyageModelId: configVersion.voyageModelId,
      embeddingPrefixVersion: configVersion.embeddingPrefixVersion,
      chunkerVersion: configVersion.chunkerVersion,
      graphExtractorVersion: configVersion.graphExtractorVersion,
      active: true,
      createdAt: this.now(),
    });
  }

  getBranchConfigVersion(branch: string): StoredBranchConfigVersionData | null {
    return this.database.getBranchConfigVersion(branch);
  }

  markBranchConfigApplied(branch: string, configHash: string): void {
    this.database.upsertBranchConfigVersion({
      branch,
      configHash,
      appliedAt: this.now(),
    });
  }
}
