**Diagnostic Answers**
1. Yes. A file can be treated as clean in `pipeline_state` while its retrieval artifacts are missing: on resume, `buildFileJobPlan()` reloads DB chunk rows without content or `embeddingText`, `processEmbedStage()` skips work when `embed` is already complete, `processIndexStage()` only marks stage progress, and `finalizeRunContext()` later marks `index` complete anyway. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1568), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1594), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1651), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1986), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2195), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2371).
2. No. `finalizeRunContext()` is not crash-atomic: it rewrites branch membership and branch symbols before saving ANN/BM25, then marks `index` complete only afterward. A crash can leave DB branch state ahead of retrieval state, and the startup integrity check only detects empty/recovered stores, not partial branch skew. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2330), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2364), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:2201).
3. `branch_config_versions` itself is written at the right point: only after `failedFiles.size === 0`, after snapshot save, and after deferred `index` completions. But the global active config flips earlier via `activateConfigVersion()`, so the system can advertise a new global config before every branch has been rebuilt under it. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1171), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2421), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:3584).
4. No. `resumeInterruptedRuns()` resumes old runs using the current `configVersion` and `configHash`, not the run’s stored `config_hash`, so a config change between crash and resume can finish an old run under new inputs. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1222), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1275), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:3438).
5. `embeddingInputHash` does invalidate on file path, symbol descriptor, chunk content, and embedding format version because it hashes `createEmbeddingText(...)`; model/provider changes do not change `embeddingInputHash` itself and instead invalidate via `hashEmbedConfig()` / stage input hashes. See [src/native/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/native/index.ts:642), [src/native/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/native/index.ts:692), [src/indexer/config-version.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/config-version.ts:52), [src/indexer/config-version.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/config-version.ts:100).
6. I did not find obvious non-determinism in `prepareEmbeddingInput()`: it is pure string formatting plus deterministic truncation by binary search over the same input text. See [src/native/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/native/index.ts:642).
7. No. Arctic/Voyage failure isolation is incomplete: if Arctic succeeds and Voyage partially fails, the file still gets `embed` marked complete, and missing Voyage vectors are only backfilled if the file becomes dirty again later. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1894), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1978).
8. Yes. Remaining resolvable-but-unresolved edges include same-name targets across multiple files when import/receiver context could disambiguate them, because extraction stores only bare `target_name` and resolver matches only name plus optional file/kind. See [native/src/call_extractor.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/call_extractor.rs:64), [native/src/call_extractor.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/call_extractor.rs:152), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:2710).
9. The current unresolved-edge fallback is still O(depth), not O(frontier width), because each level uses batched frontier edge fetch, batched unresolved-caller fetch, batched symbol-name lookup, batched symbol-id lookup, and batched chunk resolution. See [src/indexer/graph-expansion.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/graph-expansion.ts:261), [src/indexer/graph-expansion.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/graph-expansion.ts:271), [src/indexer/graph-expansion.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/graph-expansion.ts:286), [src/indexer/graph-expansion.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/graph-expansion.ts:343), [src/indexer/graph-expansion.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/graph-expansion.ts:348).
10. For live orchestrator removal paths, inbound cleanup is wired correctly: stale symbols go through `removeSymbolFromGraphIfUnreferenced()`, which unresolves/deletes inbound and outbound edges, and GC also unresolves missing targets. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3052), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3064), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2323), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:3042), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:3082).
11. No. The branch race is not fully closed because `refreshBranchInfo()` still mutates `this.currentBranch` directly without loading native branch membership. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:4296).
12. The ChunkKind penalty is applied before reranking, but the cross-encoder can still undo it because reranked order is driven by cross-encoder score and uses the pre-rerank score only as a tiebreak. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3988), [src/indexer/reranker.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/reranker.ts:428), [src/indexer/reranker.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/reranker.ts:434).
13. No. That semantic exemption is not the only hardcoded query logic; runtime retrieval also has hardcoded regexes for source/doc intent, relationship direction, relationship target extraction, test/debug detection, and bug detection. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:628), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:699), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:736), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:776), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:933).
14. I cannot state an exact large-repo BM25 memory footprint from code alone. What the code proves is that postings, per-doc term-frequency maps, and branch filter sets are all fully resident in memory and serialized as JSON, so memory grows with total vocabulary, postings, and per-doc token maps. See [native/src/inverted_index.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/inverted_index.rs:9), [native/src/inverted_index.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/inverted_index.rs:17), [native/src/inverted_index.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/inverted_index.rs:141), [native/src/inverted_index.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/inverted_index.rs:173).
15. Yes. `buildAllowedChunkIds()` does a full `getAllMetadata()` scan on metadata-filtered search requests, which is on the query path. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:4447).
16. The shadow-copy design in `VectorStore.add_batch()` is rollback-safe but expensive: it clones the whole ANN plus cloned metadata maps before swapping. See [native/src/store.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/store.rs:154), [native/src/store.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/store.rs:278).
17. If the cross-encoder silently falls back, the signal is weak: there is a search warning log and metrics counters, but both depend on debug logging/metrics being enabled. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3573), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:113), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:256).
18. No. Dropped chunks from `maxChunksPerFile` are only emitted as a warning log entry; there is no persistent DB artifact or manifest of what was dropped. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2118), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:102), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:320).
19. TTI is measured only for hot updates and is surfaced only through debug metrics/logs, not normal status output. See [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2380), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:272), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:316).
20. Yes. Sensitive material reaches logs: raw search queries are logged, watcher errors/branch changes go to console, and native chunker warnings/debug output include file paths and symbol names unconditionally via `eprintln!`. See [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3808), [src/watcher/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/watcher/index.ts:127), [src/watcher/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/watcher/index.ts:269), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:152), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:405), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:559).

## [Critical] Resume Can Mark Files Indexed Without Rebuilding Missing Retrieval Artifacts
**Location:** [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1568), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1594), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2195), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2371)
**Category:** Correctness

**Problem:**
A resumed run can declare a file’s `index` stage complete even when its ANN/BM25 materialization never got rebuilt. That is silent wrong-state, not just wasted work.

**Evidence:**
When the chunk stage is clean, `buildFileJobPlan()` reloads chunk rows from DB using `loadCurrentBranchChunkRecords()`, which reconstructs `text` as `chunk.name ?? chunk.chunkId` and does not restore `embeddingText`. If `embed` is already marked complete, `processEmbedStage()` returns immediately. `processIndexStage()` only marks `index` in progress; it does not rebuild retrieval artifacts. `finalizeRunContext()` then marks `index` complete for pending files after saving current stores, even if those stores never received the file’s chunks during this resumed run.

**Recommended fix:**
Make resumed `index`-stale files reconstruct full `ChunkRecord`s, including stored chunk text and embedding text, and force a real rematerialization path before `index` can be completed.

## [Critical] Finalization Can Persist Branch Catalog State Ahead Of Retrieval State Without Detection
**Location:** [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2330), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2364), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:2201)
**Category:** Correctness

**Problem:**
A crash during finalization can leave `branch_chunks`, `branch_symbols`, and call-edge resolution updated in SQLite while ANN/BM25 still reflect the old retrieval state. The startup integrity check is too coarse to detect that partial mismatch unless the retrieval artifacts are entirely empty.

**Evidence:**
`finalizeRunContext()` clears and rewrites branch chunk membership, applies native branch deltas, clears/re-adds branch symbols, and resolves unresolved edges before saving the vector stores and BM25. `validateRetrievalStartupIntegrity()` only treats startup as broken when stores are empty/recovered or BM25 has zero docs; it does not compare branch chunk catalog state against retrieval membership or per-file completeness.

**Recommended fix:**
Make branch catalog updates and retrieval persistence commit as a single recoverable unit, or record a durable per-run finalization marker and verify retrieval/catalog parity on startup before trusting branch state.

## [High] Branch Refresh Still Bypasses Native Branch-Membership Reload
**Location:** [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:4296), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3172)
**Category:** Correctness

**Problem:**
`refreshBranchInfo()` directly mutates `this.currentBranch` and reloads file-hash cache without reloading native branch membership. That reopens branch-state divergence outside the safer `setCurrentBranch()` path.

**Evidence:**
`refreshBranchInfo()` assigns `this.currentBranch = getBranchOrDefault(...)` and only calls `loadFileHashCache()` on change. `handleFileChanges()` invokes `refreshBranchInfo()` before reading Merkle state, so branch switches observed through the file-watcher path can bypass the native branch filter update.

**Recommended fix:**
Remove direct `currentBranch` mutation from `refreshBranchInfo()` and route every branch publication through the same “load native membership, then publish branch” path.

## [High] Interrupted Runs Resume Under The Wrong Config Version
**Location:** [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1222), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1275), [native/src/db.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/db.rs:3438)
**Category:** Correctness

**Problem:**
If config changes between crash and resume, the resume path finishes an old in-progress run using the current config hash/version, not the run’s original config. That mixes control-plane history and can stamp stale work as clean under the wrong config.

**Evidence:**
`resumeInterruptedRuns()` pulls active runs from `pipeline_runs`, but the resumed context is built from the current `configVersion` and `configHash` passed into startup, not `run.configHash`.

**Recommended fix:**
On resume, compare `run.configHash` to the current config. If they differ, cancel the run and force the appropriate config-migration path instead of resuming it.

## [High] Partial Voyage Failures Become Permanent Sparse Secondary-Lane State
**Location:** [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1894), [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:1978)
**Category:** Correctness

**Problem:**
When Arctic succeeds but Voyage partially fails, the file still exits `embed` as complete. Missing Voyage vectors for unchanged chunks are never automatically repaired, so the secondary lane can remain silently sparse forever.

**Evidence:**
Voyage failures are logged and tolerated, while only Arctic failure aborts the stage. `markStageComplete()` still runs after the batch loop. Later runs only recompute embeddings for dirty chunks, so unchanged files with missing Voyage embeddings do not get healed.

**Recommended fix:**
Track per-model embed completeness separately, or leave a file/model-level debt marker that forces Voyage backfill on the next run until the secondary lane is complete.

## [High] Metadata-Filtered Search Still Full-Scans Vector Metadata On The Query Path
**Location:** [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:4447)
**Category:** Performance

**Problem:**
Metadata-filtered searches still iterate `store.getAllMetadata()` over the entire vector store to build `allowedChunkIds`. That is O(total chunks) on the hot path.

**Evidence:**
`buildAllowedChunkIds()` checks `fileType`, `directory`, `chunkType`, and `excludeFile` by scanning every metadata entry in the store.

**Recommended fix:**
Move metadata filtering into an indexed native/SQLite path or maintain secondary indexes keyed by file type, directory, and chunk kind.

## [High] VectorStore Batch Insert Has Whole-Index Shadow-Copy Memory Cost
**Location:** [native/src/store.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/store.rs:154), [native/src/store.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/store.rs:278)
**Category:** Performance

**Problem:**
`add_batch()` is rollback-safe by cloning the full ANN plus stored metadata before every batch. On a large store, that can double or worse the peak memory footprint of the hottest mutation path.

**Evidence:**
`clone_index()` serializes the full ANN to a buffer and reloads it into a cloned index. `add_batch_internal()` clones both `Index` and `StoredMetadata` before applying inserts.

**Recommended fix:**
Move to a journaled batch-apply strategy or segmented/sharded store layout so rollback safety does not require full-store cloning.

## [Medium] Cross-Encoder Failure Is Barely Observable Outside Debug Mode
**Location:** [src/indexer/reranker.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/reranker.ts:283), [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3573), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:256)
**Category:** Observability

**Problem:**
The cross-encoder loader and backend fallback swallow failures, and the only signal is a warning log plus metrics counters that exist only if debug logging/metrics are enabled.

**Evidence:**
`loadTransformersCrossEncoderScorer()` catches all errors and returns `null`. `SearchReranker` catches backend failures and downgrades. `Indexer.applyFinalReranker()` logs a warning through the debug logger path, and `recordReranker()` only increments counters when metrics are enabled.

**Recommended fix:**
Expose reranker backend/failure state in normal status/health output and emit a durable startup warning when the configured cross-encoder is unavailable.

## [Medium] Per-File Chunk Drops Are Not Persistently Auditable
**Location:** [src/indexer/incremental-index-orchestrator.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/incremental-index-orchestrator.ts:2118), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:102), [src/utils/logger.ts](/Users/onlyaady/Desktop/BaseMemory/src/utils/logger.ts:320)
**Category:** Observability

**Problem:**
When `maxChunksPerFile` drops chunks, the only record is an ephemeral log line. Developers have no durable way to discover which files/functions are invisible to retrieval.

**Evidence:**
`buildChunkRecords()` warns when the cap is hit, but Logger stores only an in-memory ring buffer of 1000 entries.

**Recommended fix:**
Persist capped-file diagnostics in SQLite or a durable artifact under `.opencode/index`, including kept/dropped counts and dropped named symbols.

## [Medium] Sensitive Queries, File Paths, And Symbol Names Leak Into Logs
**Location:** [src/indexer/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/indexer/index.ts:3808), [src/watcher/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/watcher/index.ts:127), [src/watcher/index.ts](/Users/onlyaady/Desktop/BaseMemory/src/watcher/index.ts:269), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:152), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:405), [native/src/chunker/mod.rs](/Users/onlyaady/Desktop/BaseMemory/native/src/chunker/mod.rs:559)
**Category:** Security

**Problem:**
The system logs raw user queries, file paths, and symbol names. Native chunker diagnostics go straight to stderr regardless of debug config, which is especially risky in hosted or shared logging environments.

**Evidence:**
Search debug logging includes the raw `query`. Watcher error and branch-change handlers use `console.error` / `console.log`. Native chunker log helpers unconditionally `eprintln!`, and force-split/coverage warnings embed `file_path` and `symbol_name`.

**Recommended fix:**
Gate all sensitive logging behind explicit debug flags, scrub or hash payload fields by default, and remove unconditional native stderr logging in production builds.

**Priority Action List**
1. Fix the resume/index-stage correctness hole so interrupted runs cannot mark files indexed without rematerializing retrieval state.
2. Close the finalization crash window between SQLite branch catalog updates and retrieval persistence, or add durable parity checks that detect partial finalization on startup.
3. Eliminate all remaining branch publication paths that bypass native branch-membership reload, especially `refreshBranchInfo()`.
4. Make resume config-safe by refusing to continue in-progress runs under a different config hash.
5. Add a repair path for partial Voyage coverage so secondary-lane sparsity cannot become permanent.
6. Remove `getAllMetadata()` from metadata-filtered search and redesign vector batch rollback to avoid whole-store shadow copies.
7. Add durable observability for reranker fallback, chunk-cap drops, and hot-update TTI outside debug-only surfaces.
8. Lock down logging so sensitive queries/file paths/symbol names do not leak by default.
9. Accept for now: remaining unresolved same-name cross-file call edges that require richer semantic disambiguation, and the general BM25 in-memory footprint risk until there is real large-repo measurement.

The overall system is ambitious and much farther along than a prototype, but the real risk is still in the control-plane boundaries, not the ranking heuristics. The code has several places where SQLite state, persisted retrieval artifacts, and in-memory branch/runtime state can drift apart after crashes or resumes, and the observability surface is too weak to make that obvious without deliberate debugging. Until those durability and state-coherence gaps are closed, the indexer is not yet robust enough to trust after failure or long-lived branch/config churn.
