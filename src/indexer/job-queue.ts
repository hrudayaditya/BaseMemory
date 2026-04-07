export type IndexJobPriority = "critical" | "high" | "normal" | "low";
export type IndexJobTrigger =
  | "watcher_event"
  | "cold_start"
  | "config_change"
  | "crash_resume"
  | "follow_up";

export interface IndexJobRequest {
  branch: string;
  filePath: string;
  priority: IndexJobPriority;
  trigger: IndexJobTrigger;
  runId: string;
}

export interface IndexJob extends IndexJobRequest {
  enqueuedAt: number;
}

export interface JobQueueOptions {
  now?: () => number;
}

export interface JobQueueStats {
  pendingCount: number;
  pendingByPriority: Record<IndexJobPriority, number>;
  inProgressCount: number;
  stalledLowPriorityCount: number;
  totalEnqueued: number;
  totalCompleted: number;
  isShutdown: boolean;
}

export type JobQueueEnqueueResult =
  | "enqueued"
  | "replaced"
  | "deduped"
  | "requeue_scheduled"
  | "shutdown";

export type IndexJobExecutor = (job: IndexJob) => Promise<void> | void;

interface PendingIndexJob extends IndexJob {
  key: string;
  sequence: number;
}

interface InProgressIndexJob {
  job: PendingIndexJob;
  pendingRequeue: boolean;
  requeueRunId?: string;
}

const PRIORITY_ORDER: IndexJobPriority[] = ["critical", "high", "normal", "low"];
const PRIORITY_RANK: Record<IndexJobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const LOW_PRIORITY_STARVATION_THRESHOLD_MS = 30_000;

function createPendingByPriority(): Record<IndexJobPriority, PendingIndexJob[]> {
  return {
    critical: [],
    high: [],
    normal: [],
    low: [],
  };
}

function createPriorityCounts(): Record<IndexJobPriority, number> {
  return {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };
}

function getJobKey(branch: string, filePath: string): string {
  return `${branch}\u0000${filePath}`;
}

function isHigherPriority(
  left: IndexJobPriority,
  right: IndexJobPriority
): boolean {
  return PRIORITY_RANK[left] < PRIORITY_RANK[right];
}

export class JobQueue {
  private readonly now: () => number;
  private readonly pendingByPriority = createPendingByPriority();
  private readonly pendingJobs = new Map<string, PendingIndexJob>();
  private readonly inProgressJobs = new Map<string, InProgressIndexJob>();
  private nextSequence = 0;
  private totalEnqueued = 0;
  private totalCompleted = 0;
  private shutdownRequested = false;

  constructor(options: JobQueueOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  enqueue(job: IndexJobRequest): JobQueueEnqueueResult {
    if (this.shutdownRequested) {
      return "shutdown";
    }

    const key = getJobKey(job.branch, job.filePath);
    const existingPending = this.pendingJobs.get(key);
    if (existingPending) {
      if (!isHigherPriority(job.priority, existingPending.priority)) {
        return "deduped";
      }

      this.removePendingJob(existingPending);
      this.insertPendingJob({
        ...job,
        key,
        enqueuedAt: existingPending.enqueuedAt,
        sequence: existingPending.sequence,
      });
      this.totalEnqueued += 1;
      return "replaced";
    }

    const existingInProgress = this.inProgressJobs.get(key);
    if (existingInProgress) {
      existingInProgress.pendingRequeue = true;
      existingInProgress.requeueRunId = job.runId;
      return "requeue_scheduled";
    }

    this.insertPendingJob({
      ...job,
      key,
      enqueuedAt: this.now(),
      sequence: this.nextSequence++,
    });
    this.totalEnqueued += 1;
    return "enqueued";
  }

  async drain(executor: IndexJobExecutor): Promise<number> {
    let processed = 0;

    while (true) {
      this.promoteStarvedLowPriorityJobs();
      const nextJob = this.takeNextJob();

      if (!nextJob) {
        return processed;
      }

      try {
        await executor(this.toPublicJob(nextJob));
      } finally {
        this.finishJob(nextJob);
        processed += 1;
      }
    }
  }

  shutdown(): void {
    this.shutdownRequested = true;
  }

  purgeBranch(branch: string): number {
    let removed = 0;

    for (const priority of PRIORITY_ORDER) {
      const retained: PendingIndexJob[] = [];
      for (const job of this.pendingByPriority[priority]) {
        if (job.branch === branch) {
          this.pendingJobs.delete(job.key);
          removed += 1;
          continue;
        }
        retained.push(job);
      }
      this.pendingByPriority[priority] = retained;
    }

    return removed;
  }

  getStats(): JobQueueStats {
    const pendingByPriority = createPriorityCounts();
    for (const priority of PRIORITY_ORDER) {
      pendingByPriority[priority] = this.pendingByPriority[priority].length;
    }

    const now = this.now();
    const stalledLowPriorityCount = this.pendingByPriority.low.filter(
      (job) => now - job.enqueuedAt > LOW_PRIORITY_STARVATION_THRESHOLD_MS
    ).length;

    return {
      pendingCount: PRIORITY_ORDER.reduce(
        (count, priority) => count + pendingByPriority[priority],
        0
      ),
      pendingByPriority,
      inProgressCount: this.inProgressJobs.size,
      stalledLowPriorityCount,
      totalEnqueued: this.totalEnqueued,
      totalCompleted: this.totalCompleted,
      isShutdown: this.shutdownRequested,
    };
  }

  private finishJob(job: PendingIndexJob): void {
    const inProgress = this.inProgressJobs.get(job.key);
    this.inProgressJobs.delete(job.key);
    this.totalCompleted += 1;

    if (
      !this.shutdownRequested &&
      inProgress?.pendingRequeue
    ) {
      this.enqueue({
        branch: job.branch,
        filePath: job.filePath,
        priority: "normal",
        trigger: "follow_up",
        runId: inProgress.requeueRunId ?? job.runId,
      });
    }
  }

  private insertPendingJob(job: PendingIndexJob): void {
    const queue = this.pendingByPriority[job.priority];
    const insertionIndex = queue.findIndex((candidate) => candidate.sequence > job.sequence);

    if (insertionIndex === -1) {
      queue.push(job);
    } else {
      queue.splice(insertionIndex, 0, job);
    }

    this.pendingJobs.set(job.key, job);
  }

  private removePendingJob(job: PendingIndexJob): void {
    const queue = this.pendingByPriority[job.priority];
    const index = queue.findIndex((candidate) => candidate.key === job.key);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    this.pendingJobs.delete(job.key);
  }

  private promoteStarvedLowPriorityJobs(): void {
    const now = this.now();
    const remainingLowPriorityJobs: PendingIndexJob[] = [];
    const promotedJobs: PendingIndexJob[] = [];

    for (const job of this.pendingByPriority.low) {
      if (now - job.enqueuedAt > LOW_PRIORITY_STARVATION_THRESHOLD_MS) {
        job.priority = "normal";
        promotedJobs.push(job);
        continue;
      }

      remainingLowPriorityJobs.push(job);
    }

    if (promotedJobs.length === 0) {
      return;
    }

    this.pendingByPriority.low = remainingLowPriorityJobs;
    for (const job of promotedJobs) {
      this.insertPendingJob(job);
    }
  }

  private takeNextJob(): PendingIndexJob | null {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.pendingByPriority[priority];
      const nextJob = queue.shift();

      if (!nextJob) {
        continue;
      }

      this.pendingJobs.delete(nextJob.key);
      this.inProgressJobs.set(nextJob.key, {
        job: nextJob,
        pendingRequeue: false,
      });
      return nextJob;
    }

    return null;
  }

  private toPublicJob(job: PendingIndexJob): IndexJob {
    return {
      branch: job.branch,
      filePath: job.filePath,
      priority: job.priority,
      trigger: job.trigger,
      runId: job.runId,
      enqueuedAt: job.enqueuedAt,
    };
  }
}
