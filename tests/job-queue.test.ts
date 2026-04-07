import { describe, expect, it } from "vitest";

import {
  JobQueue,
  LOW_PRIORITY_STARVATION_THRESHOLD_MS,
  type IndexJob,
  type IndexJobRequest,
} from "../src/indexer/job-queue.js";

function createJob(
  filePath: string,
  priority: IndexJobRequest["priority"],
  overrides: Partial<Omit<IndexJobRequest, "filePath" | "priority">> = {}
): IndexJobRequest {
  return {
    branch: overrides.branch ?? "main",
    filePath,
    priority,
    trigger: overrides.trigger ?? "cold_start",
    runId: overrides.runId ?? `${filePath}-run`,
  };
}

describe("JobQueue", () => {
  it("drains jobs in strict priority order across all four levels", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/low.ts", "low"));
    queue.enqueue(createJob("src/normal.ts", "normal", { trigger: "crash_resume" }));
    queue.enqueue(createJob("src/high.ts", "high", { trigger: "watcher_event" }));
    queue.enqueue(createJob("src/critical.ts", "critical", { trigger: "watcher_event" }));

    await queue.drain(async (job) => {
      processed.push(`${job.priority}:${job.filePath}`);
    });

    expect(processed).toEqual([
      "critical:src/critical.ts",
      "high:src/high.ts",
      "normal:src/normal.ts",
      "low:src/low.ts",
    ]);
  });

  it("preserves FIFO order within the same priority", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/first.ts", "normal"));
    queue.enqueue(createJob("src/second.ts", "normal"));
    queue.enqueue(createJob("src/third.ts", "normal"));

    await queue.drain(async (job) => {
      processed.push(job.filePath);
    });

    expect(processed).toEqual([
      "src/first.ts",
      "src/second.ts",
      "src/third.ts",
    ]);
  });

  it("drops lower-priority duplicates for a pending job", async () => {
    const queue = new JobQueue();
    const processed: IndexJob[] = [];

    expect(queue.enqueue(createJob("src/file.ts", "high", {
      trigger: "watcher_event",
      runId: "high-run",
    }))).toBe("enqueued");
    expect(queue.enqueue(createJob("src/file.ts", "low", {
      runId: "low-run",
    }))).toBe("deduped");

    await queue.drain(async (job) => {
      processed.push(job);
    });

    expect(processed).toEqual([{
      branch: "main",
      filePath: "src/file.ts",
      priority: "high",
      trigger: "watcher_event",
      runId: "high-run",
      enqueuedAt: processed[0]?.enqueuedAt ?? 0,
    }]);
    expect(queue.getStats().totalEnqueued).toBe(1);
  });

  it("replaces a pending job with a higher-priority duplicate and preserves enqueue time", async () => {
    let nowMs = 1_000;
    const queue = new JobQueue({
      now: () => nowMs,
    });
    let processedJob: IndexJob | null = null;

    expect(queue.enqueue(createJob("src/file.ts", "low", {
      trigger: "cold_start",
      runId: "low-run",
    }))).toBe("enqueued");

    nowMs = 2_000;
    expect(queue.enqueue(createJob("src/file.ts", "high", {
      trigger: "watcher_event",
      runId: "high-run",
    }))).toBe("replaced");

    await queue.drain(async (job) => {
      processedJob = job;
    });

    expect(processedJob).toEqual({
      branch: "main",
      filePath: "src/file.ts",
      priority: "high",
      trigger: "watcher_event",
      runId: "high-run",
      enqueuedAt: 1_000,
    });
  });

  it("checks for newly arrived high-priority jobs after each completed job", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/low-a.ts", "low"));
    queue.enqueue(createJob("src/low-b.ts", "low"));

    await queue.drain(async (job) => {
      processed.push(job.filePath);
      if (job.filePath === "src/low-a.ts") {
        queue.enqueue(createJob("src/high.ts", "high", {
          trigger: "watcher_event",
        }));
      }
    });

    expect(processed).toEqual([
      "src/low-a.ts",
      "src/high.ts",
      "src/low-b.ts",
    ]);
  });

  it("re-enqueues exactly one normal-priority follow-up job after in-progress duplicates arrive", async () => {
    const queue = new JobQueue();
    const processed: IndexJob[] = [];

    queue.enqueue(createJob("src/file.ts", "high", {
      trigger: "watcher_event",
      runId: "run-1",
    }));

    await queue.drain(async (job) => {
      processed.push(job);
      if (processed.length === 1) {
        expect(queue.enqueue(createJob("src/file.ts", "critical", {
          trigger: "config_change",
          runId: "run-2",
        }))).toBe("requeue_scheduled");
        expect(queue.enqueue(createJob("src/file.ts", "high", {
          trigger: "watcher_event",
          runId: "run-3",
        }))).toBe("requeue_scheduled");
      }
    });

    expect(processed).toEqual([
      {
        branch: "main",
        filePath: "src/file.ts",
        priority: "high",
        trigger: "watcher_event",
        runId: "run-1",
        enqueuedAt: processed[0]?.enqueuedAt ?? 0,
      },
      {
        branch: "main",
        filePath: "src/file.ts",
        priority: "normal",
        trigger: "follow_up",
        runId: "run-3",
        enqueuedAt: processed[1]?.enqueuedAt ?? 0,
      },
    ]);
    expect(queue.getStats().totalCompleted).toBe(2);
  });

  it("does not re-enqueue a follow-up job when no in-progress duplicate arrived", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/file.ts", "normal"));

    await queue.drain(async (job) => {
      processed.push(job.filePath);
    });

    expect(processed).toEqual(["src/file.ts"]);
    expect(queue.getStats().pendingCount).toBe(0);
  });

  it("promotes a starved low-priority job before the next drain cycle", async () => {
    let nowMs = 0;
    const queue = new JobQueue({
      now: () => nowMs,
    });
    const processed: IndexJob[] = [];

    queue.enqueue(createJob("src/starved.ts", "low"));
    nowMs = 1_000;
    queue.enqueue(createJob("src/normal.ts", "normal"));

    nowMs = LOW_PRIORITY_STARVATION_THRESHOLD_MS + 1;
    await queue.drain(async (job) => {
      processed.push(job);
    });

    expect(processed[0]).toMatchObject({
      filePath: "src/starved.ts",
      priority: "normal",
    });
    expect(processed[1]).toMatchObject({
      filePath: "src/normal.ts",
      priority: "normal",
    });
  });

  it("does not promote a low-priority job before the starvation threshold", async () => {
    let nowMs = 0;
    const queue = new JobQueue({
      now: () => nowMs,
    });
    const processed: IndexJob[] = [];

    queue.enqueue(createJob("src/low.ts", "low"));
    nowMs = 1_000;
    queue.enqueue(createJob("src/normal.ts", "normal"));

    nowMs = LOW_PRIORITY_STARVATION_THRESHOLD_MS - 1;
    await queue.drain(async (job) => {
      processed.push(job);
    });

    expect(processed[0]).toMatchObject({
      filePath: "src/normal.ts",
      priority: "normal",
    });
    expect(processed[1]).toMatchObject({
      filePath: "src/low.ts",
      priority: "low",
    });
  });

  it("promotes jobs based on wait time, not just original priority", async () => {
    let nowMs = 0;
    const queue = new JobQueue({
      now: () => nowMs,
    });
    const processed: IndexJob[] = [];

    queue.enqueue(createJob("src/older-low.ts", "low"));
    nowMs = 10_000;
    queue.enqueue(createJob("src/newer-low.ts", "low"));

    nowMs = LOW_PRIORITY_STARVATION_THRESHOLD_MS + 1;
    await queue.drain(async (job) => {
      processed.push(job);
    });

    expect(processed[0]).toMatchObject({
      filePath: "src/older-low.ts",
      priority: "normal",
    });
    expect(processed[1]).toMatchObject({
      filePath: "src/newer-low.ts",
      priority: "low",
    });
  });

  it("returns immediately when drain is called on an empty queue", async () => {
    const queue = new JobQueue();
    const processed = await queue.drain(async () => {
      throw new Error("executor should not be called");
    });

    expect(processed).toBe(0);
  });

  it("rejects new jobs after shutdown, lets the in-progress job finish, and drains cleanly", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/file.ts", "normal", {
      runId: "run-1",
    }));

    const drained = await queue.drain(async (job) => {
      processed.push(job.filePath);
      expect(queue.enqueue(createJob("src/file.ts", "high", {
        trigger: "watcher_event",
        runId: "run-2",
      }))).toBe("requeue_scheduled");
      queue.shutdown();
      expect(queue.enqueue(createJob("src/new-file.ts", "high", {
        trigger: "watcher_event",
      }))).toBe("shutdown");
    });

    expect(drained).toBe(1);
    expect(processed).toEqual(["src/file.ts"]);
    expect(queue.getStats()).toEqual({
      pendingCount: 0,
      pendingByPriority: {
        critical: 0,
        high: 0,
        normal: 0,
        low: 0,
      },
      inProgressCount: 0,
      stalledLowPriorityCount: 0,
      totalEnqueued: 1,
      totalCompleted: 1,
      isShutdown: true,
    });
  });

  it("purges only pending jobs for the selected branch", async () => {
    const queue = new JobQueue();
    const processed: string[] = [];

    queue.enqueue(createJob("src/main-a.ts", "low", { branch: "main" }));
    queue.enqueue(createJob("src/main-b.ts", "normal", { branch: "main" }));
    queue.enqueue(createJob("src/feature.ts", "high", { branch: "feature" }));

    expect(queue.purgeBranch("main")).toBe(2);

    await queue.drain(async (job) => {
      processed.push(`${job.branch}:${job.filePath}`);
    });

    expect(processed).toEqual(["feature:src/feature.ts"]);
  });

  it("reports accurate pending, in-progress, stalled, and total counts", async () => {
    let nowMs = 0;
    const queue = new JobQueue({
      now: () => nowMs,
    });

    queue.enqueue(createJob("src/critical.ts", "critical"));
    queue.enqueue(createJob("src/normal.ts", "normal"));
    queue.enqueue(createJob("src/low.ts", "low"));

    nowMs = LOW_PRIORITY_STARVATION_THRESHOLD_MS + 1;
    expect(queue.getStats()).toEqual({
      pendingCount: 3,
      pendingByPriority: {
        critical: 1,
        high: 0,
        normal: 1,
        low: 1,
      },
      inProgressCount: 0,
      stalledLowPriorityCount: 1,
      totalEnqueued: 3,
      totalCompleted: 0,
      isShutdown: false,
    });

    let inProgressStats: ReturnType<JobQueue["getStats"]> | null = null;
    await queue.drain(async (job) => {
      if (!inProgressStats && job.filePath === "src/critical.ts") {
        inProgressStats = queue.getStats();
      }
    });

    expect(inProgressStats).toEqual({
      pendingCount: 2,
      pendingByPriority: {
        critical: 0,
        high: 0,
        normal: 2,
        low: 0,
      },
      inProgressCount: 1,
      stalledLowPriorityCount: 0,
      totalEnqueued: 3,
      totalCompleted: 0,
      isShutdown: false,
    });
    expect(queue.getStats()).toEqual({
      pendingCount: 0,
      pendingByPriority: {
        critical: 0,
        high: 0,
        normal: 0,
        low: 0,
      },
      inProgressCount: 0,
      stalledLowPriorityCount: 0,
      totalEnqueued: 3,
      totalCompleted: 3,
      isShutdown: false,
    });
  });
});
