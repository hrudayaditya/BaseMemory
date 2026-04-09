# Incremental Index Orchestrator Handoff

Last audited: 2026-04-08

This document describes the current state of the Incremental Index Orchestrator as it exists in the codebase now. It is meant to be a planning handoff for future work, not a design wish list. Everything below is based on the live code and the current test suite.

## Scope

The orchestrator owns indexing mutation flow. Retrieval stays in `searchDetailed()` and is out of scope here except where it intersects with index durability.

Primary source files:

- `src/indexer/incremental-index-orchestrator.ts`
- `src/indexer/checkpoint-manager.ts`
- `src/indexer/job-queue.ts`
- `src/indexer/index.ts`
- `src/indexer/watcher-tti.ts`
- `src/watcher/index.ts`

## Current ownership boundary

### What the orchestrator owns

`IncrementalIndexOrchestrator` is the canonical owner for:

- cold start indexing
- hot updates from file deltas
- branch-change handling
- config-drift handling
- interrupted-run resume
- pipeline stage transitions
- final durable commit ordering
- per-file TTI recording for hot updates

Main entrypoints:

- `coldStart()` in `src/indexer/incremental-index-orchestrator.ts:589`
- `hotUpdate()` in `src/indexer/incremental-index-orchestrator.ts:683`
- `handleBranchChange()` in `src/indexer/incremental-index-orchestrator.ts:752`
- `handleConfigChange()` in `src/indexer/incremental-index-orchestrator.ts:787`
- `ensureStartupState()` in `src/indexer/incremental-index-orchestrator.ts:859`
- `resumeInterruptedRuns()` in `src/indexer/incremental-index-orchestrator.ts:887`

### What still lives in `Indexer`

`Indexer` still owns:

- singleton-per-repo construction in `src/indexer/index.ts:1508`
- wiring the orchestrator host callbacks in `src/indexer/index.ts:1528`
- initialization of provider, store, DB, and compatibility state in `src/indexer/index.ts:1820`
- in-process serialization via `runSerializedIndexOperation()` in `src/indexer/index.ts:1727`
- crash marker / lock file handling via `runWithCrashMarker()` in `src/indexer/index.ts:1742`
- interrupted-lock recovery in `src/indexer/index.ts:1704`
- file hash cache persistence in `src/indexer/index.ts:1586`
- retrieval/search in `src/indexer/index.ts:2753`

### Public `Indexer` API after Step 9

The public indexing methods now delegate cleanly:

- `handleFileChanges()` -> serialized `handleFileChangesInternal()` -> `orchestrator.hotUpdate(...)` or fallback cold start in `src/indexer/index.ts:2407`
- `handleBranchChange()` -> `orchestrator.handleBranchChange(...)` in `src/indexer/index.ts:2473`
- `indexDirtySet()` -> `orchestrator.hotUpdate(...)` in `src/indexer/index.ts:2481`
- `index()` -> `orchestrator.coldStart(...)` in `src/indexer/index.ts:2504`

Retrieval remains on the search path:

- `search()` -> `searchDetailed()` in `src/indexer/index.ts:2753`

The old bulk indexing path is gone. `retryFailedBatches()` was removed. The failed-batch file remains only as an observability artifact, not as an active recovery path. See `src/indexer/index.ts:1751`.

## Pipeline model

### Stages

The pipeline stages are defined in `src/indexer/checkpoint-manager.ts:9`:

- `chunk`
- `embed`
- `index`
- `graph`

Stage statuses are defined in `src/indexer/checkpoint-manager.ts:10`:

- `pending`
- `in_progress`
- `complete`
- `failed`

### Run types

Run types are defined in `src/indexer/checkpoint-manager.ts:11`:

- `cold_start`
- `hot_update`
- `config_change`
- `resume`

Run statuses are defined in `src/indexer/checkpoint-manager.ts:12`:

- `in_progress`
- `complete`
- `failed`
- `cancelled`

### Stage input hashes

The orchestrator computes input hashes; `CheckpointManager` treats them as opaque values.

Hash builders:

- `buildChunkStageInputHash()` in `src/indexer/incremental-index-orchestrator.ts:443`
- `buildChunkEmbedInputHash()` in `src/indexer/incremental-index-orchestrator.ts:450`
- `buildEmbedStageInputHash()` in `src/indexer/incremental-index-orchestrator.ts:459`
- `buildIndexStageInputHash()` in `src/indexer/incremental-index-orchestrator.ts:471`
- `buildGraphStageInputHash()` in `src/indexer/incremental-index-orchestrator.ts:478`

Current invalidation rules:

- `CHUNK` invalidates on file-content hash or chunker version change.
- `EMBED` invalidates on chunk set/content or embedding config change.
- `INDEX` is bookkeeping over current embed identity and reruns when needed for durable store/branch state.
- `GRAPH` invalidates on file-content hash or graph extractor version change.

## Startup sequence

Startup is serialized and runs through `ensureStartupState()` before cold start, hot update, or branch change work.

Current order in `src/indexer/incremental-index-orchestrator.ts:859`:

1. Prepare resources and read current branch.
2. Compute current config version/hash.
3. Read active config version from DB.
4. If config hash changed or no active config exists, run `handleConfigChange(...)`.
5. If `Indexer` reported crash recovery, cancel all in-progress runs and force a cold start.
6. Otherwise, run `resumeInterruptedRuns(...)`.
7. Prune old finished runs.
8. Mark startup complete.

This ordering matters. Config drift is applied before resume, so files cannot resume under stale chunker/embed/graph config.

## Cold start behavior

Cold start entrypoint: `src/indexer/incremental-index-orchestrator.ts:589`

Current cold start flow:

1. Call `ensureStartupState()`.
2. Prepare store/provider/index/database resources.
3. Consume deferred hot-update paths for the branch.
4. Resolve current config version/hash.
5. Build a full Merkle snapshot of the working tree.
6. Start a `pipeline_runs` row with type `cold_start`.
7. Create a run context with branch chunk/symbol membership, existing chunk hashes, and snapshot-derived file hashes.
8. Compare current working-tree files against `CheckpointManager.getKnownFiles(branch)` and treat any tracked-but-missing files as deleted.
9. Run `processRemovedFile()` for those deleted files before indexing present files.
10. Queue present files in batches of `COLD_START_BATCH_SIZE`.
11. Drain each batch.
12. After each low-priority batch, drain newly pending high-priority jobs before continuing.
13. Finalize the run.

Key constants:

- `COLD_START_BATCH_SIZE = 50` in `src/indexer/incremental-index-orchestrator.ts:225`

Important current behavior:

- Cold start now really batches work. Before Step 6, the constant existed only in logs.
- High-priority work can cut between cold-start batches, but not in the middle of a single file job.
- Deleted files from prior runs are now cleaned up during cold start by comparing `getKnownFiles(branch)` against the current Merkle snapshot. This behavior was restored after Step 9.

Relevant code:

- deleted-file detection: `src/indexer/incremental-index-orchestrator.ts:631`
- batch enqueue loop: `src/indexer/incremental-index-orchestrator.ts:645`
- high-priority yield between batches: `src/indexer/incremental-index-orchestrator.ts:673`

## Hot update behavior

Hot update entrypoint: `src/indexer/incremental-index-orchestrator.ts:683`

### End-to-end path

1. `FileWatcher.handleChange()` records a watcher timestamp and coalesces changes in `src/watcher/index.ts:73`.
2. Debounced watcher flush calls `indexer.handleFileChanges(changes)` in `src/watcher/index.ts:113` and `src/watcher/index.ts:260`.
3. `Indexer.handleFileChanges()` serializes the operation in `src/indexer/index.ts:2407`.
4. `handleFileChangesInternal()`:
   - refreshes branch info
   - loads the stored branch snapshot
   - normalizes incoming paths
   - backfills a watcher timestamp for direct non-watcher calls with `ensureWatcherEventTimestamp(...)`
   - computes a Merkle diff from the changed paths
   - falls back to cold start if snapshot/diff handling fails
5. `orchestrator.hotUpdate(...)` starts a `hot_update` run, enqueues touched files at `high` priority, drains the queue, and finalizes.

Relevant code:

- watcher timestamp stamp: `src/watcher/index.ts:86`
- direct call timestamp backfill: `src/indexer/index.ts:2433`
- hot-update enqueue: `src/indexer/incremental-index-orchestrator.ts:717`

### Drift containment

If a file changes after the Merkle scan that produced the run’s file list, `processJob()` does not try to salvage it in-place. It:

- detects scan-time hash vs live-content hash mismatch
- defers the file into `pendingHotUpdatePaths`
- skips indexing that file in the current run
- lets the next serialized hot-update pass recompute a fresh diff

Relevant code:

- drift check and deferral: `src/indexer/incremental-index-orchestrator.ts:1052`
- deferred-path recomputation: `src/indexer/incremental-index-orchestrator.ts:1012`

This is intentional containment, not true mid-run preemption.

### Zero-cost no-op updates

If `diffMerkleFromEvents(...)` produces no changed, added, or removed files, `handleFileChangesInternal()` only saves the next snapshot and returns. No hot-update run is started.

Relevant code:

- no-op early return: `src/indexer/index.ts:2445`

## Branch change behavior

Branch changes are detected by `GitHeadWatcher` in `src/watcher/index.ts:155`.

Current flow:

1. Watch `.git/HEAD` and refs.
2. Debounce branch changes for 100ms.
3. Call `indexer.handleBranchChange(oldBranch, newBranch)`.
4. Serialize the operation in `Indexer`.
5. `orchestrator.handleBranchChange(...)`:
   - cancels active runs for the old branch
   - purges pending queue jobs for the old branch
   - drops deferred hot-update paths for the old branch
   - switches `currentBranch`
   - if the new branch has no snapshot, runs `coldStart()`
   - otherwise diffs stored snapshot vs current working tree and runs `hotUpdate(...)`
   - if diff is empty, just saves the new branch snapshot

Relevant code:

- branch watcher: `src/watcher/index.ts:167`
- old-branch queue purge: `src/indexer/incremental-index-orchestrator.ts:758`
- cold-start on branch without snapshot: `src/indexer/incremental-index-orchestrator.ts:766`

Important current behavior:

- pending old-branch queue jobs are removed
- active old-branch runs are cancelled
- old-branch `pipeline_state` rows are not deleted during branch switch
- old branch snapshots are not explicitly cleared on branch switch

## Config drift handling

Config drift is handled by `handleConfigChange()` in `src/indexer/incremental-index-orchestrator.ts:787`.

Current drift dimensions:

- `chunkerVersion`
- `graphExtractorVersion`
- `embeddingModelId`
- `embeddingDimension`

Current reset rules:

- chunker drift -> reset `chunk`
- embedding drift -> reset `embed` and `index`
- graph drift -> reset `graph`

Relevant code:

- drift comparisons: `src/indexer/incremental-index-orchestrator.ts:800`
- stage resets: `src/indexer/incremental-index-orchestrator.ts:813`

Current behavior:

- config drift is branch-wide over `getKnownFiles(branch)`
- affected files are queued at `normal` priority with trigger `config_change`
- the new config version is activated before the config-change run executes
- combined chunker + embed drift converges in one startup pass

## Crash recovery and resume

### Multi-process crash marker

`Indexer` uses a lock file as a crash/restart guard, not as a distributed coordination system.

Relevant code:

- lock acquisition: `src/indexer/index.ts:1674`
- interrupted lock recovery: `src/indexer/index.ts:1704`

Current recovery behavior when a stale lock is detected:

- clear all file hash caches
- clear all Merkle snapshots
- run health check without wrapping another crash marker
- mark `recoveredFromInterruptedIndexing = true`

On the next orchestrator startup:

- all in-progress runs are cancelled
- `forceColdStart = true`
- resume is skipped for that startup cycle

### Resume of interrupted runs

`resumeInterruptedRuns()` in `src/indexer/incremental-index-orchestrator.ts:887` currently:

- only resumes runs on the current branch
- cancels runs older than `RESUME_STALENESS_THRESHOLD_MS`
- cancels in-progress runs from other branches
- re-enqueues only unfinished files
- reuses the original run id
- queues resumed files at `normal` priority with trigger `crash_resume`

Key constants:

- `RESUME_STALENESS_THRESHOLD_MS = 2 hours` in `src/indexer/incremental-index-orchestrator.ts:227`
- `FINISHED_RUN_RETENTION_MS = 7 days` in `src/indexer/incremental-index-orchestrator.ts:228`

Relevant code:

- staleness cancellation: `src/indexer/incremental-index-orchestrator.ts:897`
- branch mismatch cancellation: `src/indexer/incremental-index-orchestrator.ts:902`
- unfinished file lookup: `src/indexer/incremental-index-orchestrator.ts:906`

## Per-file job execution

Per-file execution is in `processJob()` at `src/indexer/incremental-index-orchestrator.ts:1087`.

### Stage execution summary

#### CHUNK

- stale check via `CheckpointManager.isStageStale(...)`
- parse file
- apply chunk filters
- diff against existing branch chunks
- upsert chunk rows
- mark `chunk` complete

Relevant code:

- `buildFileJobPlan()` in `src/indexer/incremental-index-orchestrator.ts:1124`

#### EMBED

- file-level stale check
- if chunks are unchanged and embeddings are fresh, skip
- if chunks are unchanged but embedding config drifted, rebuild embedding work from current chunks
- reuse cached embeddings from DB when available
- embed missing chunks in dynamic batches
- write vectors to vector store and BM25 index
- mark `embed` complete

Relevant code:

- `processEmbedStage()` in `src/indexer/incremental-index-orchestrator.ts:1255`

Important current behavior:

- combined config drift bug was fixed so embed drift can still force re-embedding even when chunk structure is unchanged
- zero-chunk files still complete `embed`

#### INDEX

Current `index` stage is bookkeeping for durable completion:

- mark `index` in progress if chunk/embed work requires durable update
- do not mark it complete until finalization succeeds

Relevant code:

- `processIndexStage()` in `src/indexer/incremental-index-orchestrator.ts:1412`

#### GRAPH

- graph stage reruns only when its input hash is stale
- uses existing parse or reparses if needed
- clears old call edges only when the old symbol is not referenced on other branches
- upserts symbols and call edges
- marks `graph` complete

Relevant code:

- `processGraphStage()` in `src/indexer/incremental-index-orchestrator.ts:1436`

### Removed files

Removed files are handled by `processRemovedFile()` in `src/indexer/incremental-index-orchestrator.ts:1530`.

Current behavior:

- remove file chunk ids from current in-memory branch state
- remove file symbol ids from current in-memory branch state
- remove file from `existingChunksByFile`
- record removed absolute and relative paths
- clear watcher TTI timestamp for the file
- clear all `pipeline_state` rows for that file on that branch

Actual retrieval/global deletion still happens later during finalization, using branch-safe removal helpers:

- `removeChunkFromRetrievalIfUnreferenced(...)` in `src/indexer/index.ts:2296`
- `clearCallEdgesForSymbolIfUnreferenced(...)` in `src/indexer/index.ts:2311`
- `removeSymbolFromGraphIfUnreferenced(...)` in `src/indexer/index.ts:2320`

These helpers explicitly check whether the chunk or symbol still exists on other branches before removing shared retrieval/graph data.

## Finalization and durability order

Finalization is in `src/indexer/incremental-index-orchestrator.ts:1721`.

Current order:

1. Compute stale chunk ids and remove retrieval entries only if no other branch still references them.
2. Compute stale symbol ids and remove graph entries only if unreferenced.
3. Rewrite branch chunk membership.
4. Rewrite branch symbol membership.
5. If stale chunks existed, run orphan GC for chunk rows and embeddings.
6. Save vector store.
7. Save inverted index.
8. Mark pending `index` stages complete.
9. Record successful file hashes.
10. For hot updates, compute TTI from watcher arrival to durable `index` completion.
11. Commit file hash cache changes.
12. Build and save the committed Merkle snapshot.
13. Mark the run `complete` if no files failed, otherwise `failed`.
14. Save index metadata and mark compatibility clean.

This means the effective durable ordering is:

`branch membership/store save -> INDEX complete -> file hash cache commit -> Merkle snapshot commit`

Important behavior:

- `index` completion is intentionally delayed until branch membership and store saves succeed.
- failed files are excluded from `pendingIndexCompletions`, so they do not get fresh file hashes or committed snapshot entries.
- hot-update TTI is measured only for successfully completed files.

## TTI instrumentation

TTI support was added in Step 6.

Files:

- watcher timestamp registry: `src/indexer/watcher-tti.ts`
- watcher stamp: `src/watcher/index.ts:86`
- direct-call backfill: `src/indexer/index.ts:2433`
- TTI record and warning: `src/indexer/incremental-index-orchestrator.ts:1777`

Current behavior:

- latest timestamp wins per normalized path
- direct `handleFileChanges()` calls without the live watcher still get a timestamp via `ensureWatcherEventTimestamp(...)`
- TTI is recorded when a hot-update file’s `index` stage is durably completed
- `TTI_TARGET_MS = 2000` in `src/indexer/incremental-index-orchestrator.ts:226`
- exceeding the target logs a warning; it is not a hard failure

## Queue semantics

Queue implementation: `src/indexer/job-queue.ts`

Priorities:

- `critical`
- `high`
- `normal`
- `low`

Triggers:

- `watcher_event`
- `cold_start`
- `config_change`
- `crash_resume`
- `follow_up`

Important behavior:

- strict priority drain order
- FIFO preserved within a priority
- pending duplicate job at lower/equal priority is deduped
- pending duplicate at higher priority replaces the existing pending job while preserving original enqueue time/sequence
- if a duplicate arrives while a job is in progress, a single `follow_up` job is scheduled for later
- low-priority starvation promotion threshold is `30_000ms`
- `purgeBranch(branch)` removes only pending jobs, not in-progress jobs
- `hasPendingAtOrAbove("high")` is used by cold start to service critical/high work between low-priority batches

Key code:

- `LOW_PRIORITY_STARVATION_THRESHOLD_MS` in `src/indexer/job-queue.ts:60`
- `enqueue()` in `src/indexer/job-queue.ts:100`
- `drain()` in `src/indexer/job-queue.ts:145`
- `purgeBranch()` in `src/indexer/job-queue.ts:172`

## Checkpoint manager behavior

Checkpoint manager implementation: `src/indexer/checkpoint-manager.ts`

Important behavior:

- stale means: missing row, non-complete row, or input-hash mismatch
- `ensureTrackedFile()` creates a pending `chunk` row for new files
- `getUnfinishedFiles(branch)` returns files with any missing or unfinished stage state
- `getKnownFiles(branch)` is now used by cold start and config-drift runs
- stage resets are per branch and per stage type
- `cancelActiveRuns(branch)` only affects `pipeline_runs`, not `pipeline_state`
- `pruneFinishedRuns(retentionMs)` removes old finished runs but keeps active ones

Key code:

- `isStageStale()` in `src/indexer/checkpoint-manager.ts:123`
- `getUnfinishedFiles()` in `src/indexer/checkpoint-manager.ts:154`
- `getKnownFiles()` in `src/indexer/checkpoint-manager.ts:158`
- `resetStageType()` in `src/indexer/checkpoint-manager.ts:162`
- `clearFileState()` in `src/indexer/checkpoint-manager.ts:170`
- `startRun()` in `src/indexer/checkpoint-manager.ts:174`
- `cancelActiveRuns()` in `src/indexer/checkpoint-manager.ts:206`
- `pruneFinishedRuns()` in `src/indexer/checkpoint-manager.ts:214`

## What was completed across Steps 6-10

### Step 6

Hot update full wiring and TTI validation were closed out.

What was established:

- end-to-end `handleFileChanges()` integration path works
- partial failure isolation in hot update works
- failed files are retried via `getUnfinishedFiles()` on the next pass
- TTI is recorded and warning logs fire correctly
- branch changes during pending work purge old-branch pending jobs and start the new branch cleanly
- removed file handling clears pipeline state and preserves cross-branch references

### Step 7

Cold start finalization and validation were closed out.

What was established:

- cold start completes all four stages end to end
- Merkle snapshot, file hash cache, and `pipeline_runs` completion are persisted
- interrupted cold starts resume only incomplete files
- chunker config drift reruns CHUNK without unnecessary EMBED resets
- old finished runs are pruned while active history is retained
- high-priority interruption between cold-start batches works

### Step 8

Config drift and crash-resume hardening were closed out.

What was established:

- embedding config drift reruns `embed` and `index`, not `chunk` or `graph`
- graph extractor drift reruns only `graph`
- stale interrupted runs older than two hours are cancelled, not resumed
- config-drift handling runs before resume
- stale lock recovery invalidates snapshots and caches and forces cold start

### Step 9

Ownership cleanup and public delegation were completed.

What changed:

- legacy bulk indexing path was removed
- `retryFailedBatches()` was deleted
- public `Indexer` indexing methods now delegate to the orchestrator
- failed-batches file remains as an artifact only

### Step 10

Edge-case hardening was completed and exposed one real bug.

Fix delivered:

- combined chunker + embedding config drift now converges correctly in one pass even when chunk structure is unchanged

Additional coverage now exists for:

- empty repo
- single-file repo
- zero-cost unchanged hot update
- branch with no prior snapshot
- zero-chunk files
- concurrent singleton construction
- queue starvation under real load

## Current test coverage

Primary orchestrator coverage is in `tests/incremental-orchestrator.test.ts`.

Representative tests:

- delegation wiring: `tests/incremental-orchestrator.test.ts:399`
- singleton and concurrent singleton construction: `tests/incremental-orchestrator.test.ts:505`, `tests/incremental-orchestrator.test.ts:513`
- empty repo cold start: `tests/incremental-orchestrator.test.ts:524`
- multi-language cold start durability: `tests/incremental-orchestrator.test.ts:557`
- single-file repo lifecycle: `tests/incremental-orchestrator.test.ts:614`
- zero-cost unchanged hot update: `tests/incremental-orchestrator.test.ts:653`
- deleted-file cleanup during cold start: `tests/incremental-orchestrator.test.ts:681`
- cross-branch deletion safety: `tests/incremental-orchestrator.test.ts:723`
- cold-start batch yield to high-priority work: `tests/incremental-orchestrator.test.ts:760`
- end-to-end hot update path: `tests/incremental-orchestrator.test.ts:819`
- partial-failure isolation and retry: `tests/incremental-orchestrator.test.ts:870`
- hot-update TTI measurement: `tests/incremental-orchestrator.test.ts:964`
- TTI warning logging: `tests/incremental-orchestrator.test.ts:1008`
- drift-after-scan containment: `tests/incremental-orchestrator.test.ts:1123`
- zero-chunk file completion: `tests/incremental-orchestrator.test.ts:1195`
- crash-finalization recovery: `tests/incremental-orchestrator.test.ts:1257`
- resume unfinished index stages: `tests/incremental-orchestrator.test.ts:1302`
- recent resume preserving run id: `tests/incremental-orchestrator.test.ts:1338`
- interrupted cold-start resume: `tests/incremental-orchestrator.test.ts:1400`
- stale resume cancellation: `tests/incremental-orchestrator.test.ts:1479`
- chunk/embed/graph drift resets: `tests/incremental-orchestrator.test.ts:1526`, `tests/incremental-orchestrator.test.ts:1575`, `tests/incremental-orchestrator.test.ts:1630`
- combined drift convergence: `tests/incremental-orchestrator.test.ts:1680`
- config drift before resume ordering: `tests/incremental-orchestrator.test.ts:1763`
- pruning old finished runs: `tests/incremental-orchestrator.test.ts:1836`
- stale lock recovery forcing cold start: `tests/incremental-orchestrator.test.ts:1891`
- single-file embed failure isolation: `tests/incremental-orchestrator.test.ts:1967`
- branch-change purge/no-leak behavior: `tests/incremental-orchestrator.test.ts:1999`
- branch with no prior snapshot: `tests/incremental-orchestrator.test.ts:2066`
- removed-file cleanup clearing pipeline state: `tests/incremental-orchestrator.test.ts:2086`

Supporting coverage:

- checkpoint behavior: `tests/checkpoint-manager.test.ts`
- queue behavior: `tests/job-queue.test.ts`
- watcher behavior: `tests/watcher.test.ts`

## Intentional decisions and deferred work

These are the important things that are intentionally not solved yet or are only partially solved.

### 1. Index mutation remains serialized

All public indexing entrypoints still run behind `Indexer.runSerializedIndexOperation()` in `src/indexer/index.ts:1727`.

Implication:

- no overlapping cold start + hot update execution
- no true preemption
- batch yielding only lets higher-priority work in between cold-start batches, not inside a file job and not outside the serialized mutation lock

This is a deliberate stability-first tradeoff.

### 2. No multi-process concurrent indexing support

The lock file is a crash/restart guard, not a real concurrent multi-process coordinator. See `src/indexer/index.ts:1671`.

### 3. No explicit failed-batch retry entrypoint

`retryFailedBatches()` was deleted. Failed embedding batches are still written to `failed-batches.json`, but recovery is now checkpoint-driven through unfinished stage detection and resume. This is intentional.

### 4. Branch switch does not purge old branch pipeline state

Branch change currently cancels old runs and purges pending queue jobs, but does not clear old-branch `pipeline_state` rows. That state remains branch-scoped history.

### 5. TTI is measured and warned, not enforced

`TTI_TARGET_MS` is a warning threshold only. There is no hard gate or SLA enforcement in code.

### 6. No true live watcher SLA test

We now have:

- unit coverage for the watcher
- integration coverage through `handleFileChanges()`
- TTI instrumentation and warning logs

We do not yet have a strong end-to-end test that starts the live watcher, edits files on disk, and asserts a hard freshness deadline.

### 7. Progress reporting is minimal in the orchestrator path

The current orchestrator path reports `scanning` and `complete` through `ProgressCallback`. It does not provide rich per-stage progress comparable to the old bulk path.

### 8. Batch/windowing is fixed, not adaptive

`COLD_START_BATCH_SIZE` is a constant `50`. It is not dynamic and not config-driven.

### 9. Retrieval/ranking cleanup is separate work

The orchestrator migration is largely done. Retrieval still has its own architectural complexity, but that is a different cleanup track.

## Recommended future planning topics

If the next planning session is specifically about the orchestrator, the highest-signal topics are:

1. Whether to keep serialized mutation forever or introduce controlled overlap/preemption.
2. Whether to add a first-class end-to-end watcher freshness test with a real time budget.
3. Whether to make batch/window sizing adaptive or configurable.
4. Whether to expose richer progress and status telemetry from orchestrator runs.
5. Whether to keep `failed-batches.json` as an artifact or remove it entirely once confidence in checkpoint recovery is high.
6. Whether branch-switch handling should eventually clean or compact historical branch-local `pipeline_state`.
7. Whether there should be a real one-shot CLI command for cold start and hot update smoke tests instead of relying on MCP or local scripts.

## Short version

The orchestrator migration is functionally complete. The active indexing path is:

- single-owner `Indexer`
- serialized mutation
- orchestrator-owned cold start/hot update/branch/config/resume flows
- per-file checkpointing with stage hashes
- durable finalization ordering
- real cold-start batching
- real hot-update TTI instrumentation
- branch-safe deletion cleanup
- strong integration coverage

What is left is not “make the orchestrator exist.” It is mostly productization and refinement:

- stronger end-to-end watcher validation
- possibly better progress/reporting
- possibly smarter scheduling/preemption
- cleanup of a few remaining artifacts and historical tradeoffs
