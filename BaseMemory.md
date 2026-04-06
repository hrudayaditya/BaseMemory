# Next-Generation Indexing Architecture for OpenCode

## 1. Overview

This document proposes a next-generation indexing architecture for OpenCode, grounded in a detailed analysis of the existing `opencode-codebase-index` implementation and a survey of state-of-the-art techniques in code indexing, hybrid retrieval, and graph-based RAG for large codebases. The design is explicitly builder-oriented: each component is motivated by concrete flaws, mapped to specific techniques, and organized into phases that a single strong developer can realistically implement.[^1][^2][^3]

The goal is not to produce a research paper, but a practical blueprint you can implement and evolve. The architecture is designed to:

- Scale to large monorepos and many branches without excessive reindexing or thrashing.[^4][^1]
- Maintain consistency and recover gracefully from crashes and partial updates.[^5]
- Deliver high-quality, task-aware retrieval and context construction for LLM tools.[^6][^7]
- Expose structural code intelligence (symbols, call graph, tests) as first-class MCP tools.[^8][^9]
- Support continuous evaluation, observability, and security/privacy constraints appropriate for proprietary code.[^10][^11][^12]


## 2. Part 1 – Flaw Catalog (Existing `opencode-codebase-index`)

This section summarizes the key flaws and limitations identified in the current `opencode-codebase-index` implementation and its surrounding design. The list is organized by theme; many details are derived from the Rust native code (`parser.rs`, `chunker.rs`, `db.rs`), the TypeScript orchestrator (`src/indexer/index.ts`, `src/watcher/index.ts`, `src/git/index.ts`), and documentation (`ARCHITECTURE.md`, `docs/evaluation.md`).[^2]

### 2.1 Pipeline Architecture & Incremental Indexing

**Flaw #1 – Monolithic, weakly checkpointed pipeline**  
The indexing flow is essentially a single pass from scan → parse/chunk → embed → index, without explicit persisted checkpoints between stages. Failures mid-run can leave the index in a partially updated state, and recovery typically requires re-running the entire pipeline.[^2]

**Flaw #2 – Incomplete dirty/clean model for pipeline stages**  
Incremental behavior is mostly per-file hashing plus re-indexing changed files. There is no per-stage dirty/clean state for parse, chunk, embed, and graph stages, especially when configuration or model versions change. This makes evolution of the pipeline brittle and often forces full rebuilds.[^2]

**Flaw #13 – No clear separation between cold start and hot updates**  
Cold start (indexing a new repo or after a major schema change) and hot updates (day-to-day file changes, branch switches) largely share the same `index()` path, with no differentiated guarantees, budgets, or failure handling.[^2]

### 2.2 Git Lifecycle, Branching, and Monorepos

**Flaw #3 – Git lifecycle handling is not fully first-class**  
While branches and branch-specific metadata exist in the DB, git events (branch creation, deletion, rebases, force-pushes, detached HEAD) are not modeled as explicit lifecycle events with corresponding index updates and pruning. The system assumes the working tree is truth without a robust notion of branch history.

**Flaw #16 – Watcher always funnels into full `index()` calls**  
File and git watchers debounce events but eventually call `indexer.index()` for the entire repo. Although internal delta logic avoids re-embedding unchanged files, it still requires scanning all tracked files and re-running the high-level pipeline for each update batch, which is costly on large repos.

**Flaw #18 – Flat per-file hashing instead of hierarchical (Merkle) deltas**  
Change detection is based on per-file xxhash hashes stored in `file-hashes.json`, with no directory-level or tree-level hashing. On each run, all tracked files must be considered to determine which ones changed, which scales poorly to monorepos.[^2]

**Flaw #23 – No explicit concept of hot vs cold code**  
All files and chunks are treated similarly in indexing and retrieval, regardless of how frequently they are used. There is no notion of hotspot files or modules that should receive more aggressive freshness and richer indexing.

**Flaw #26 – No repo-internal sharding/partitioning**  
Large repos are effectively indexed into a single logical index (one DB, one vector index, one BM25 index), rather than being partitioned or sharded along meaningful boundaries (e.g., services, directories, ownership).

**Flaw #24 – Incomplete handling of branch edge cases**  
Detached HEAD checkouts, shallow clones, and force-reset branches are not fully modeled in the index. The branch catalog may accumulate stale data, and there is no background reconciliation that uses git history to prune or reorganize branch metadata.

**Flaw #27 – No explicit branch lifecycle and pruning strategy**  
Short-lived branches accumulate in the DB without a process to mark them stale or deleted and clean up their associated data. Over time, branch tables drift away from actual git refs.

### 2.3 Index Integrity, Crash Recovery, and Corruption

**Flaw #4 – No WAL or atomic index versioning for main index structures**  
Crash recovery focuses on JSON metadata (e.g., file hashes) using temp files and renames, but the main SQLite DB, vector index, and BM25 index are updated in-place. There is no write-ahead log or atomic swap between index versions, making partial writes and corruption hard to detect and recover from.[^2]

**Flaw #17 – Crash recovery only partially addresses consistency**  
Tests ensure that stale lock files and file-hash metadata are cleared on crash, but they do not verify consistency across all index structures (DB, vector index, BM25). Orphaned embeddings and mismatched chunk-to-embedding relationships can persist.

**Flaw #11 – Limited integrity checking and drift detection**  
Besides basic sanity checks, there is no systematic integrity check that cross-validates DB rows, vector index entries, and on-disk source files, nor a mechanism for detecting and repairing drift over time.

**Flaw #28 – No index-wide validation on startup**  
On startup, the system does not run a holistic validation of index health. It assumes that existing index files are valid, which allows silent corruption to persist until retrieval behavior becomes obviously wrong.

### 2.4 Chunking and Context Construction

**Flaw #6 – Chunking not fully tuned to code semantics**  
The project uses Tree-sitter and has a native chunker, but chunking still mixes static size thresholds with relatively generic structural rules; fallbacks for unknown languages are line-based. Large constructs are not consistently broken at semantic boundaries, and small sibling nodes are not always merged into coherent units. This leads to fragmented or suboptimal chunks for LLM consumption.

**Flaw #7 – Context construction is flat and chunk-centric**  
Retrieval returns ranked chunks, but context assembly for LLMs is largely a matter of concatenating top-K chunks, rather than building task-aware context bundles (e.g., definition + call sites + tests + config). Different tasks (definition lookup vs refactor vs test debugging) are not explicitly modeled in context selection.

**Flaw #19 – Call graph is under-utilized in retrieval**  
The system extracts a call graph via Tree-sitter queries and stores it in the native DB, but this graph is not systematically used as a second-stage expander for retrieval. It behaves more like an auxiliary feature than a central driver of multi-hop code understanding.

**Flaw #21 – Incremental granularity stops at file level**  
Incremental updates are expressed at the file level: when a file changes, all its chunks and embeddings are recomputed. For large files or frequent small edits, this is more work than necessary.

### 2.5 Retrieval Quality and Reranking

**Flaw #5 – Limited use of reranking on top of hybrid retrieval**  
The project already supports hybrid retrieval (BM25 + dense via uSearch), but there is no full-fledged second-stage reranker using cross-encoders or LLM-based scoring across fused candidates. This limits precision, especially on ambiguous queries.

**Flaw #10 – Limited handling of large repos and retrieval hotspots**  
The retrieval engine does not differentiate between hotspots (frequently queried files, central modules) and cold areas of the codebase. It lacks prioritization strategies for indexing and caching around high-value code.

**Flaw #20 – Retrieval not explicitly task-aware**  
Although evaluation datasets label query types, the runtime retrieval path does not strongly differentiate behavior by task type (e.g., definition lookup vs test failure analysis). Context assembly remains mostly uniform across tasks.

### 2.6 Evaluation, Diagnostics, and Builder UX

**Flaw #9 (Refined) – Evaluation harness under-leveraged**  
`opencode-codebase-index` has an unusually strong evaluation harness for retrieval, with golden queries, metrics, and benchmarks. The flaw is not absence, but that this harness is not treated as a central gate for pipeline changes, nor heavily integrated into a builder workflow for tuning.[^2]

**Flaw #15 – Limited builder-facing diagnostics**  
There is no single “status dashboard” answering key questions such as: indexing lag versus working tree, counts of dirty vs clean chunks, distribution of model versions, or retrieval latency by repo size. Diagnostics are scattered across logs and tests.

**Flaw #25 – Under-specified status and metrics surface**  
While there are status commands, the system does not provide a consolidated, builder-friendly view of index health and performance (e.g., Time-To-Intelligence per repo, retrieval latency distributions, error rates).

### 2.7 Ignore Rules, Vendor Code, and Generated Artifacts

**Flaw #14 – Vendor and generated code not strategically handled**  
Beyond reading `.gitignore` and obvious path filters, there is no rich strategy for identifying and down-weighting vendor, generated, or third-party code. These files can bloat the index and pollute retrieval results when not managed carefully.


## 3. Part 2 – State-of-the-Art Techniques

This section summarizes the main techniques and patterns from the literature and practitioner reports that inform the new design.

### 3.1 AST-Aware and Semantic Chunking

Recent work has shown that AST-aware, split-and-merge chunking significantly improves retrieval quality and downstream code generation compared to simple line or fixed-size chunking.[^13][^6]

Key techniques:

- **AST-based chunking (cAST)**: Parse code with Tree-sitter and recursively divide the AST into chunks that respect semantic boundaries (functions, classes, methods). Large nodes are split by recursively descending into children until chunks fit under a token budget, while small siblings are merged to avoid undersized chunks.[^6]
- **Code-chunk libraries**: Tools like Supermemory’s `code-chunk` package expose AST-aware chunking as a simple `chunk(file, code)` API and have been shown to improve retrieval and LLM answer quality.[^13]
- **Hybrid structural + semantic chunking**: For documentation and large text blocks, approaches like OneUptime’s HybridChunker first do structural splits, then use embeddings to detect low-similarity boundaries and split further, followed by merging small chunks.[^14][^15]

These patterns provide a blueprint for robust, language-aware chunkers tailored to code, tests, and docs.

### 3.2 Hybrid Retrieval and Reranking

Best-in-class RAG systems and vector databases converge on a two-stage pattern:

1. **Hybrid retrieval** combining sparse (BM25) and dense vectors.  
2. **Second-stage reranking** with cross-encoders or LLMs over a small candidate set.[^7][^16][^17]

Key techniques:

- **BM25 + dense fusion**: Systems like Qdrant and Weaviate run BM25 and dense vector search in parallel, then fuse results using weighted scoring or reciprocal rank fusion (RRF). In code search tutorials, BM25 is often emphasized for identifiers and rare tokens, while dense vectors capture semantics.[^18][^16][^19][^7]
- **Cross-encoder reranking**: Candidate chunks (e.g., top 50–200) are reranked with a cross-encoder or small LLM scoring model that reads both query and candidate text. Sentence-Transformers provide a reference implementation and show measurable gains in Recall@k and NDCG when reranking is added.[^20][^17]
- **Preference-aligned reranking**: CodeRAG and similar work introduce rerankers trained on preference signals about which snippets actually helped an LLM solve tasks, resulting in better alignment with downstream performance.[^3][^21]

Hybrid retrieval plus reranking is now a de facto standard for high-precision semantic search and should be considered baseline for OpenCode.

### 3.3 Real-Time and Incremental Indexing for Large Repos

Modern code-assistant tools need near-real-time indexing that scales to large monorepos without frequent full rescans.

Key techniques:

- **Merkle-tree change detection (Cursor)**: Cursor’s indexing pipeline builds a Merkle tree of file hashes and compares roots between client and server to identify changed subtrees. Only files in changed subtrees are uploaded and re-embedded, dramatically reducing work for large repos.[^22][^1]
- **Incremental pipelines (CocoIndex)**: CocoIndex organizes ingest → parse → chunk → embed → index as a declarative DAG with per-stage hashes. Only changed chunks are re-processed, and real-time behavior is achieved by wiring editor or file-system events into this incremental engine.[^23][^24]
- **Sparse index patterns (Git, Sourcegraph)**: Git’s sparse index and Sourcegraph’s Time-To-Intelligence (TTI) optimizations demonstrate how tree-vs-tree comparisons and cached analysis shrink the perceived size of monorepos while keeping code intelligence fresh.[^25][^4]

These techniques suggest that OpenCode should model indexing as a DAG with per-stage hashes and use a Merkle tree for efficient change detection.

### 3.4 Graph-Based Retrieval and Context Construction

Graph-based RAG and code-intelligence research argue for combining vector retrieval with structured graphs over code entities.

Key techniques:

- **CodeRAG’s requirement and DS-code graphs**: CodeRAG builds a requirement graph (intent-level nodes with semantic relations) and a DS-code graph (code elements and dependencies). Retrieval starts in the requirement graph and then travels through the DS-code graph to identify “supportive code” for a task.[^3]
- **Simple Graph RAG / call-graph traversal**: Practical systems use code graphs built from Tree-sitter (functions, classes, imports, calls) and then perform neighborhood expansion around nodes found via vector search, adding callers, callees, and related tests to the context.[^26][^27]
- **GraphRAG for multi-hop reasoning**: General GraphRAG research shows that graph-based retrieval improves multi-hop question answering and allows more efficient, high-recall retrieval for complex tasks.[^28][^29]
- **Codebase-memory-style knowledge graphs**: Codebase-Memory and related tools build long-lived knowledge graphs over codebases and expose them via APIs for impact analysis, call-graph traversal, and discovery.[^9]

Using graphs as a second-stage context expander on top of hybrid retrieval is the state of the art for repository-level code understanding.

### 3.5 Evaluation Harnesses and Benchmarks

`opencode-codebase-index` already includes a retrieval evaluation harness with golden query sets and metrics. Recent benchmarks and RAG research suggest how to extend and use it effectively.[^2]

Key techniques:

- **Retrieval metrics (CodeRAG-Bench)**: CodeRAG-Bench evaluates retrieval and retrieval-augmented code generation with metrics such as Recall@k, NDCG, MRR, and success@k across datasets like RepoEval and SWE-bench. It shows substantial gains from improved retrieval and reranking, but also highlights retrieval as a persistent bottleneck.[^10]
- **Repository-level agent benchmarks**: Benchmarks like RepoEval and SWE-bench Verified evaluate end-to-end agents on real repositories and bug-fix tasks, measuring resolution rates and other metrics.[^30][^31]
- **Retrieve+rerank evaluation setups**: Sentence-Transformers and vector DB tutorials provide blueprints for evaluating BM25, dense, hybrid, and rerank pipelines side by side.[^19][^17]

A state-of-the-art OpenCode indexer should treat this eval harness as a gate for any indexing or retrieval change.

### 3.6 Observability, Feedback Loops, Security, and Privacy

Two non-functional dimensions are increasingly considered part of “state of the art” RAG systems:

- **RAG observability**: Tools and practices like tracing, LLM observability platforms, and detailed logging allow developers to see query flows, retrieval behavior, and failures end-to-end. This is crucial for diagnosing retrieval issues and tuning systems in production.[^11][^32][^33]
- **Feedback loops and active learning**: RAG systems can use human or user feedback on retrieved context and answers to improve retrieval and reranking over time, sometimes via methods like reinforcement learning from human feedback (RLHF) or preference optimization.[^34][^35][^36]
- **RAG security and privacy**: Formal threat models and best practices address data leakage, membership inference, poisoning, and PII exposure in RAG pipelines. They recommend clear modes (local-only vs remote service), access control, and sensitive-data masking.[^12][^37][^38][^39]

These themes inform cross-cutting components in the new architecture (observability/telemetry and security/privacy).


## 4. Part 3 – Proposed Architecture for OpenCode

### 4.1 Design Goals

The proposed architecture aims to:

1. **Scale gracefully to large monorepos and many branches**, minimizing redundant work through Merkle-tree-based change detection and fine-grained dirty/clean tracking (addressing Flaws #1, #2, #16, #18, #23, #26).[^1][^22][^4]
2. **Provide robust consistency and recovery guarantees** via snapshotting, integrity checks, and startup validation (Flaws #4, #11, #17, #28).[^40][^5]
3. **Deliver high-quality, task-aware retrieval and context assembly**, using AST-aware chunking, hybrid retrieval with reranking, and graph-based expansion (Flaws #5, #6, #7, #19, #20).[^7][^6][^3]
4. **Expose structural code intelligence via MCP tools**, in the style of CodeRLM and Codebase-Memory, so agents can query structure (symbols, callers, tests) directly (Flaws #7, #19).[^41][^8][^9]
5. **Support continuous evaluation, observability, and security/privacy** as first-class concerns, not afterthoughts (Flaws #9, #15, #25).[^11][^12][^10]

### 4.2 Layered Architecture

The architecture is organized into four main layers, inspired by indexing-platform patterns.[^42][^5]

1. **Execution layer (local worker)**  
   - Runs on the developer’s machine.  
   - Handles repo scanning, Merkle hashing, parsing, and chunking.  
   - Optionally performs embedding locally in “privacy mode,” or forwards chunks to a remote embedding/index server.

2. **Indexing platform layer**  
   - Central orchestration engine.  
   - Implements cold-start and hot-update pipelines as a DAG with clear stages: scan → parse → chunk → embed → index → graph → integrity checks.  
   - Manages job queues, retries, and per-stage checkpoints.

3. **Storage & query layer**  
   - **Chunk & embedding store**: DB tables for files, chunks, embeddings, and sparse signatures; vector index (uSearch/IVF/HNSW); BM25 index.  
   - **Code graph store**: symbols, nodes, and edges for call/import/test graphs and other relationships.  
   - **Metadata & integrity store**: Merkle trees, per-stage hashes, config versions, integrity snapshots.

4. **MCP / tooling API layer**  
   - Exposes semantic search tools (`codebase_search`, `find_similar`), structural tools (`structure`, `impl`, `callers`, `tests_for`), and context-planning tools to agents and editor integrations.[^43][^8][^41]

### 4.3 Data Model

Key entities and relationships:

- **Repo**: identifies an indexed repository, with a reference to its root path and a `config_version_hash` capturing the current chunker/embedding configuration.
- **Branch**: tracks per-branch metadata (name, head commit, lifecycle state, timestamps) for git lifecycle management and pruning.
- **File**: per-branch file metadata, including `relative_path`, `language`, `content_hash`, and flags indicating whether symbol and graph indexes are present.
- **Chunk**: fine-grained units for retrieval, with fields: `file_id`, `branch_id`, `granularity` (file/function/class/block/doc), `chunk_hash`, `type` (code/test/doc/config), AST node kind, line span, and `stage_hashes` (`parse_hash`, `chunker_hash`, `graph_hash`).
- **Embedding**: per-chunk embedding records, keyed by `chunk_id` and `model_id`, with a link to the vector index entry and an `embed_config_hash`.
- **SparseSignature** (optional): per-chunk sparse representation for advanced hybrid search.
- **GraphNode / GraphEdge**: code graph nodes (functions, classes, files, tests, configs) and edges (calls, imports, inheritance, tested_by), forming the DS-code graph.
- **ConfigVersion**: captures embedding model, dimension, chunker version, hybrid strategy version, and graph extractor version; hashed into `config_version_hash`.
- **IntegritySnapshot**: stored checksums and counts across tables and index files, used for startup validation and drift detection.

This schema directly supports multi-granularity indexing, incremental updates at chunk level, and graph-based context assembly.

### 4.4 Cold-Start Pipeline

Cold start is used when indexing a new repo or after a major schema/config change.

Stages:

1. **Scan and Merkle tree construction**  
   - Walk the repo, applying ignore rules from `.gitignore`, language-specific patterns, and heuristics for vendor/generated code (e.g., large files in `node_modules`, `dist`, etc.).[^44][^23]
   - Compute per-file hashes and build a directory-level Merkle tree as in Cursor’s design, storing node hashes in a dedicated structure.[^22][^4][^1]

2. **Parsing & AST extraction**  
   - Use Tree-sitter for supported languages to parse each file and produce an AST.  
   - Extract symbol information and record `parse_hash` based on AST structure.[^45][^9]

3. **Chunking (AST-aware + semantic)**  
   - Run cAST-style AST-based chunking: split and merge nodes to produce function/class/test-level chunks under size constraints, attaching docstrings/comments to their definitions.[^13][^6]
   - For very large nodes or less-structured text, apply semantic chunking as described by OneUptime’s HybridChunker, splitting on embedding-similarity drops and merging undersized segments.[^15][^14]
   - For docs and markdown, use semantic chunking directly.  
   - Persist chunk records with `chunk_hash` and `chunker_hash`.

4. **Embedding**  
   - Batch chunks and generate embeddings using a code-specialized model; optionally generate natural-language embeddings for issue/PR text–style queries.[^18]
   - Cache embeddings keyed by `(chunk_hash, model_id)` to avoid recomputing identical chunks, following Cursor’s content-addressed embedding cache pattern.[^1][^22]

5. **Index construction**  
   - Insert dense vectors into uSearch or a dedicated vector DB (HNSW/IVF).  
   - Build or populate a BM25 index over chunk content and selected metadata (paths, symbol names), as in Qdrant code search and Weaviate hybrid examples.[^16][^19][^18]
   - Optionally generate sparse signatures (SPLADE-like) for future hybrid strategies.[^46][^47]

6. **Graph construction**  
   - Use Tree-sitter queries (e.g., `*-calls.scm`) to populate `GraphNode` and `GraphEdge` tables with call/import/inheritance/test edges, forming a DS-code graph.[^9][^3]

7. **Integrity snapshot & evaluation**  
   - Compute and store an `IntegritySnapshot` (row counts, sums, random sample checks) and associate it with the index directory.[^5][^40]
   - Run the retrieval evaluation harness on the repo’s golden queries, storing metrics as a baseline for this config.[^10][^2]

Each stage persists its completion status, allowing the orchestrator to resume from the last successful stage after a crash.

### 4.5 Hot-Update Pipeline

Hot updates cover file edits, branch switches, and configuration changes.

1. **Event ingestion**  
   - File watcher and Git watcher push events (file changes, HEAD changes) into an event queue, with debouncing and coalescing by path and branch.[^23][^41]

2. **Merkle-based delta detection**  
   - For a batch of events, update Merkle hashes only for affected directories and compare against stored hashes to identify changed subtrees.  
   - Restrict downstream work to files under changed subtrees, avoiding global scans (addressing Flaws #16, #18, #26).[^4][^22][^1]

3. **Dirty set computation**  
   - For each changed file:  
     - Recompute file content hash; if changed, mark file dirty.  
     - Re-parse and re-chunk; recompute `chunk_hash` for each chunk.  
     - Mark chunks with changed `chunk_hash` as dirty for embedding and index; chunks with identical hashes reuse prior embeddings and index entries.  
   - For configuration changes (e.g., new embedding model or chunker version):  
     - Compare `ConfigVersion` against stored `chunker_hash`/`embed_config_hash` and mark affected chunks as dirty (Flaw #12).[^5]

4. **Incremental re-indexing**  
   - For each dirty chunk:  
     - Re-embed and upsert vector index entry.  
     - Update BM25 postings accordingly.  
     - Update graph nodes/edges if AST structure changed.  
   - This per-chunk pipeline avoids full `index()` runs on each event batch.

5. **Branch lifecycle reconciliation**  
   - The Git lifecycle manager periodically reconciles DB branches with git refs, marking deleted or force-reset branches and cleaning associated mappings, which reduces drift and bloat (Flaw #27).[^4]

6. **Continuous integrity checks**  
   - Background tasks perform cheap consistency checks (random chunk ↔ embedding ↔ vector index entries; file hashes vs disk) and compare with snapshots.  
   - On detection of significant drift or corruption, the system can either drop back to the last known good snapshot or mark the index as unhealthy and prompt a rebuild (Flaws #11, #17, #28).[^40][^5]

Hot updates are designed to respect latency budgets (TTI), e.g., save → updated index within a couple of seconds on typical repos, and these metrics are tracked.

### 4.6 Core Components and Flaw Mapping

#### 4.6.1 Incremental Index Orchestrator

- **Role**: Encapsulate the indexing DAG and dirty/clean logic for all stages.  
- **Fixes**: Flaws #1, #2, #13, #16, #21, #22.[^2]
- **Techniques**: Declarative, incremental pipelines as in CocoIndex and general RAG pipeline best practices.[^24][^23][^5]

Responsibilities:

- Maintain a job queue keyed by file and chunk, with deduplication and priorities (e.g., active file edits before background branch rescans).  
- Provide entrypoints for cold indexing and event-driven updates.  
- Store per-stage hashes and completion markers to support resumption after failure.

#### 4.6.2 Merkle Tree Change Detector

- **Role**: Efficiently detect changed subtrees for large repos.  
- **Fixes**: Flaws #16, #18, #26.[^2]
- **Techniques**: Cursor-style Merkle trees over file hierarchies; Git sparse index ideas.[^22][^1][^4]

It maintains an in-DB or on-disk representation of directory hashes, updated incrementally and used to skip unchanged areas on hot updates.

#### 4.6.3 AST-Aware Chunker

- **Role**: Produce semantically coherent, LLM-friendly chunks.  
- **Fixes**: Flaws #6, #21.[^2]
- **Techniques**: Tree-sitter-based AST-aware chunking (cAST, code-chunk) plus semantic chunking for docs and large blocks.[^15][^6][^13]

The chunker runs as a separate stage with its own versioning, enabling safe evolution without forcing full reindexing of unchanged files when only chunking defaults change.

#### 4.6.4 Hybrid Retrieval Engine + Reranker

- **Role**: Perform BM25 + dense hybrid retrieval and rerank candidates using cross-encoders/LLMs and later preference-aligned rerankers.  
- **Fixes**: Flaws #5, #7, #10, #20, #23.[^2]
- **Techniques**: Qdrant/Weaviate style hybrid search, retrieve+rerank patterns, CodeRAG BestFit reranking.[^17][^21][^16][^7]

It supports different retrieval recipes per task type and incorporates multiple granularities (file-level and symbol-level embeddings) and metadata (e.g., symbol kinds, file roles).

#### 4.6.5 Code Graph Store & Graph Retrieval

- **Role**: Store and query a DS-code graph for structural retrieval and context expansion.  
- **Fixes**: Flaws #7, #19, #23.[^2]
- **Techniques**: CodeRAG’s requirement and code graphs, Simple Graph RAG, and Tree-sitter-based code graphs (Codebase-Memory).[^26][^3][^9]

Given a set of retrieved chunks, the graph retriever expands the context by traversing nodes and edges (callers, callees, tests, imports) according to task-specific strategies.

#### 4.6.6 Git Lifecycle Manager

- **Role**: Manage branch lifecycle, including creation, deletion, and force-resets, and reconcile DB state with git history.  
- **Fixes**: Flaws #3, #24, #27.[^2]
- **Techniques**: Git’s own branch and sparse index behavior; regular reconciliation passes.

It also tracks branch metadata (e.g., last indexed commit) and can trigger partial or full reindexing when branch histories diverge significantly.

#### 4.6.7 Integrity & Snapshot Manager

- **Role**: Provide robust index health checks, snapshots, and recovery.  
- **Fixes**: Flaws #4, #11, #17, #28.[^2]
- **Techniques**: Write-ahead logging/atomic swap patterns and periodic integrity checks from production RAG/data pipelines.[^40][^5]

It orchestrates startup validation, ongoing drift detection, and rollback to last good snapshots when necessary.

#### 4.6.8 Evaluation Harness & Metrics

- **Role**: Centralize quantitative evaluation of retrieval and end-to-end tasks.  
- **Fixes (refined)**: Flaws #9, #15, #25.[^2]
- **Techniques**: CodeRAG-Bench style metrics (Recall@k, NDCG, MRR), SWE-bench/RepoEval tasks, retrieve+rerank evaluations.[^17][^30][^10]

It is used as a gate for pipeline changes and as the main tool for tuning chunking, hybrid weights, graph expansion depth, and reranking strategies.

#### 4.6.9 MCP / Tooling Surface

- **Role**: Expose index capabilities through MCP tools for agents and editors.  
- **Fixes**: Operationalization of several flaws around context construction and structural access (#7, #19, #20).  
- **Techniques**: CodeRLM’s structured API (structure, impl, callers, grep) and Code Index MCP / Local Code Search MCP patterns.[^48][^49][^8][^43][^41]

Tools include semantic search, symbol search, definition/caller queries, test discovery, and task-specific context builders.

#### 4.6.10 Observability & Telemetry Manager

- **Role**: Provide end-to-end tracing and metrics for indexing and retrieval.  
- **Fixes**: Strengthens Flaw #15 and #25.  
- **Techniques**: RAG observability patterns such as tracing retrieval stages, logging per-request context bundles, and integrating with monitoring tools.[^50][^32][^33][^11]

It records:

- Indexing metrics (TTI, per-stage durations, failure rates).  
- Retrieval traces (query, retrieved chunks, hybrid/rerank scores, graph expansions).  
- LLM call metadata (prompt sizes, latency, costs) where applicable.

#### 4.6.11 Security & Privacy Layer

- **Role**: Ensure the indexing system respects privacy, access control, and secure handling of sensitive content.  
- **Fixes**: Complements flaws around vendor code handling (#14) and addresses security concerns not explicitly in the original prompt.  
- **Techniques**: RAG security threat models and sensitive-data masking.[^37][^38][^39][^12]

Responsibilities:

- Support local-only and remote-service modes with clear guarantees on what data leaves the machine.  
- Implement repo-level and potentially chunk-level access control when multi-tenant indexing is introduced.  
- Integrate PII/secret detectors to avoid storing or exposing sensitive literals in index text, using masking where possible.

### 4.7 Phased Implementation Plan

The phases below assume a single strong developer working part time to full time. They are ordered so each phase delivers meaningful value while building toward the full architecture.

#### Phase 1 – Infrastructure Hardening and AST Chunking

Focus:

- Introduce Merkle-tree-based change detection and refactor indexing into an incremental orchestrator.
- Replace simple chunking with AST-aware chunking for key languages.
- Add integrity snapshots and startup validation.

Outcomes:

- Significant reduction in wasted work for large repos during hot updates.  
- Stronger guarantees that the index is consistent or will self-rebuild on corruption.  
- Better average chunk quality for LLM tools.

#### Phase 2 – Retrieval Quality and Graph-Aware Context

Focus:

- Implement hybrid BM25 + dense retrieval with RRF and cross-encoder/LLM reranking.  
- Extend the existing call graph into a DS-code graph and integrate graph-based context expansion.  
- Introduce task-aware context recipes and make the evaluation harness a gate for retrieval changes.

Outcomes:

- Noticeably better relevance for semantic queries and definition/test-related tasks.  
- More “aware” assistants that bring in definitions, call sites, and tests together.  
- A quantitative basis for tuning retrieval and verifying improvements.

#### Phase 3 – Codebase Memory, Preference Reranking, and Agent-First API

Focus:

- Develop the code graph into a long-lived knowledge graph with impact analysis and extended relationships.  
- Train and integrate a preference-aligned reranker using feedback data and eval harness outputs.  
- Expand MCP tools with structural and context-planning operations, and enhance observability and security/privacy.

Outcomes:

- An index that functions as a rich codebase memory rather than a static search backend.  
- LLM tools that feel more “native” to the codebase, with recursive exploration and high-quality context.  
- A system that can be safely evolved over time with quantitative feedback and security guarantees.


## 5. Conclusion

The proposed architecture takes `opencode-codebase-index` from a strong foundation to a truly state-of-the-art indexing core suitable for OpenCode. It systematically addresses identified flaws through concrete, implementable components and aligns closely with leading practices in code-aware chunking, hybrid retrieval with reranking, Merkle-based incremental indexing, graph-based RAG, robust evaluation, observability, and security. With a phased plan, a single focused developer can iteratively bring OpenCode’s indexing capabilities to parity with—and in some respects beyond—the best systems described in current literature and industry practice.[^6][^3][^1][^2]

---

## References

1. [How Cursor Indexes Codebases Fast - by Engineer's Codex](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast) - Cursor, the popular AI IDE that recently announced they hit $300M ARR, uses Merkle trees to index co...

2. [Comet.md](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/103203160/0c49ff23-5a9d-4bd7-ad00-dc355e474ef6/Comet.md?AWSAccessKeyId=ASIA2F3EMEYEWYNMQXMZ&Signature=sB9%2FbzxLp6HnQXJia%2BZge1xbsJs%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPv%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIEsP%2BeY44HqDnP7VwD48%2FTUzS3Rdb3fSdXp65S1XfLW%2BAiAlMPFFQPXnI3NVXcQNaKvs79FOYuSRRb11XqN45LhsYir8BAjD%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMnTUK%2BXJC4qbZd555KtAEC5OVLlSbFaNzfpazaqy40VWfRN8%2FtxDZsQ%2Fl2uLWlL4MFhIlttI2j8WlQegtE%2B7lVl7H3X0kx25WgLhlNduq641beAg6MTdpnLwumd8eOaClauPp2LGzHW%2Bt3pyQu2JPZu5wOJLPHF303DmfHa5HIJRupeKq8n2UbdWiX%2BOg6fzZuOSqzs5fRYO5Q8lHjQ0D9KC%2FlX6IQZBUTB%2FyIB7pQJklsb0kqy2tZ2gtd3teTnyOenfyfTIomjj5pyj8Ja84UoOHtFp6AMY44ylMe1djZd3NFRm84lyPotPMpdOZ0PSQznRcYHUx1NMpnOSCTUPRLMtZ%2F4yJ8tHbzbyCuhJaif9IbJFGFXZMe30pdsSeoVXNJyaPeOc0pRQTQQdafXjK%2FRHMeA5B9eZrKKU1VGrJIloe%2BB3ffipJf7BTGgt%2B7QNW%2B4WUdL2BtyRJEnSjkc%2BGthyuriHr%2FkMa2F%2FB3Se7hFXLvxIXZ7MHFsYZGWyCP3pwikHqRc2Kkzqx5W6tCW2ADRFVXkP9qfPbDRtSTr3u8T4NkfFSawPrhdZjgsdkaCj5m2kfHYKzUHnRf19Ro6D5XcKknjiGMH5pC3L1x6oGwHQXYJgK1IxQHHCMXhRxgQy0xCj4D2GYJTrghUZIdgBiZpdQIox8wMoVirVYFouEvfkg%2BXHUKk2%2FtZK2sUX2K7nXPCT9qKpcF8lfxAS7y4JAFvSxsB3y3jelk2PkcoiqVDXocdxE1OYLLDxbOeOzqP7C8e4aIqb1rWGLVvKSafJwCwcVoHw%2FU0hrEKeX2pqh5jDorszOBjqZAbqcDiNjocE%2BKAhtbes2Lw1AE1rHDVqIj%2FnxqcK9LR9WC%2BlPGdhtqPtyGXTEmrTsAFgTHeywq5TbWV%2B3xMyUNFMchuuIeXF3YLOeejvI7j%2B6xZtg3bgy6bYs5uHTtc2AwkTbHORcL6nD%2B%2BtnUW7vvj67ZNqTWEGqB0KM5sxaQcnGf4R3nw0SgncNuSKZjVwvRE2vGCrQNEqUGw%3D%3D&Expires=1775445307) - You are a senior software architect and AI systems researcher specializing in
LLM-powered developer ...

3. [CodeRAG: Supportive Code Retrieval on Bigraph for Real-World ...](https://arxiv.org/html/2504.10046v1) - In this paper, we propose CodeRAG, a retrieval-augmented code generation (RAG) framework to comprehe...

4. [Make your monorepo feel small with Git's sparse index](https://github.blog/open-source/git/make-your-monorepo-feel-small-with-gits-sparse-index/) - The new sparse index feature makes it feel like you are working in a small repository when working i...

5. [Best Practices for Implementing RAG Systems in Production](https://unstructured.io/insights/rag-systems-best-practices-unstructured-data-pipeline) - This article breaks down how to build and run a production RAG pipeline, from offline ingestion and ...

6. [cAST: Enhancing Code Retrieval-Augmented Generation ... - arXiv](https://arxiv.org/html/2506.15655v1) - We propose chunking via Abstract Syntax Trees (cAST), a structure-aware method that recursively brea...

7. [Qdrant Hybrid Search with Reranking](https://qdrant.tech/documentation/tutorials-search-engineering/reranking-hybrid-search/) - Specifically, we'll use BM25, a probabilistic retrieval model. BM25 ranks documents based on how rel...

8. [CodeRLM – Tree-sitter-backed code indexing for LLM agents](https://news.ycombinator.com/item?id=46974515) - Tree-sitter handles structural queries giving the LLM the ability to evaluate function signatures, h...

9. [Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM ...](https://arxiv.org/html/2603.27277v1) - A knowledge-graph architecture for code that combines Tree-Sitter parsing across 66 languages, a mul...

10. [[PDF] CODERAG-BENCH: Can Retrieval Augment Code Generation?](https://aclanthology.org/2025.findings-naacl.176.pdf) - Based on CODERAG-BENCH, we conduct large-scale evaluations of 10 retrievers and 10 LMs and systemati...

11. [How We Built End-to-End LLM Observability with Splunk and RAG](https://www.splunk.com/en_us/blog/artificial-intelligence/how-we-built-end-to-end-llm-observability-with-splunk-and-rag.html) - Summary in RAG Observability Context. This screenshot below shows observability monitoring of a RAG ...

12. [RAG Security and Privacy: Formalizing the Threat Model and Attack ...](https://arxiv.org/html/2509.20324v1) - RAG systems introduce novel attack vectors for privacy and security breaches due to their hybrid arc...

13. [Building code-chunk: AST Aware Code Chunking - Supermemory](https://supermemory.ai/blog/building-code-chunk-ast-aware-code-chunking/) - How code-chunk Works · Step 1: Parse with tree-sitter · Step 2: Extract Entities · Step 3: Build the...

14. [How to Build Semantic Chunking - OneUptime](https://oneuptime.com/blog/post/2026-01-30-semantic-chunking/view) - A practical guide to implementing semantic chunking for RAG applications, with working code examples...

15. [Splitting with purpose: Semantic chunking for advanced RAG systems](https://ai.plainenglish.io/splitting-with-purpose-semantic-chunking-for-advanced-rag-systems-dbbdb73fe421) - This article explores a sophisticated approach to RAG that leverages semantic chunking, hybrid searc...

16. [Hybrid Search Explained | Weaviate](https://weaviate.io/blog/hybrid-search-explained) - Hybrid search merges dense and sparse vectors together to deliver the best of both search methods. G...

17. [Retrieve & Re-Rank — Sentence Transformers documentation](https://sbert.net/examples/sparse_encoder/applications/retrieve_rerank/README.html) - Re-ranking both sparse and dense results with cross-encoder/ms-marco-MiniLM-L6-v2. Hybrid Search usi...

18. [Semantic Search for Code - Qdrant](https://qdrant.tech/documentation/tutorials-search-engineering/code-search/) - Qdrant is an Open-Source Vector Search Engine written in Rust. It provides fast and scalable vector ...

19. [Hybrid Search and the Universal Query API - Qdrant](https://qdrant.tech/course/essentials/day-3/hybrid-search/) - Learn how to combine dense and sparse vector search methods to build powerful hybrid search pipeline...

20. [Cross-Encoder Rediscovers a Semantic Variant of BM25 - Shaped.ai](https://www.shaped.ai/blog/cross-encoder-rediscovers-a-semantic-variant-of-bm25) - This article explores how cross-encoders, long praised for their performance in neural ranking, may ...

21. [CodeRAG: Retrieval-Augmented Code Synthesis - Emergent Mind](https://www.emergentmind.com/topics/coderag) - CodeRAG is a family of retrieval-augmented generation methodologies designed for automated code comp...

22. [How Cursor uses Merkle trees for code indexing and privacy](https://www.linkedin.com/posts/pratikdaga-sf_indexing-a-large-codebase-quickly-without-activity-7343708355628015619-G6Mm) - At its core, a Merkle tree is just a hash tree. You take your files, hash them, then hash those hash...

23. [Build Real-Time Codebase Indexing for AI Code Generation](https://cocoindex.io/blogs/index-code-base-for-rag) - In this blog, we will show you how to index a codebase for RAG with CocoIndex. CocoIndex provides bu...

24. [Build a Real-Time Codebase Index in 5 Minutes with CocoIndex ...](https://dev.to/badmonster0/build-a-real-time-codebase-index-in-5-minutes-with-cocoindex-rust-tree-sitter-eo3) - ✓ Proper code parsing (not just text chunking) ✓ Vector embeddings for semantic search ✓ Real-time s...

25. [Optimizing a code intelligence indexer | Sourcegraph Blog](https://sourcegraph.com/blog/optimizing-a-code-intel-indexer) - In the comment extraction process is this innocuous-looking line of code that finds the closest comm...

26. [The Simple Graph RAG Strategy That Finally Makes Multi ... - ByteBell](https://bytebell.ai/blog/simple-graph-rag) - Vector search finds relevant code but misses the blast radius. Learn how combining lightweight code ...

27. [callgraph traversal RAG implementation for coding agents - Reddit](https://www.reddit.com/r/Rag/comments/1s3qxtw/callgraph_traversal_rag_implementation_for_coding/) - Tracing Coding Agents: Complete OpenTelemetry Instrumentation Guide · Complex RAG accomplished using...

28. [GraphRAG in Practice: How to Build Cost-Efficient, High-Recall ...](https://towardsdatascience.com/graphrag-in-practice-how-to-build-cost-efficient-high-recall-retrieval-systems/) - A beginner's guide to building a Retrieval Augmented Generation (RAG) application from scratch · Lar...

29. [Understanding Graph-based RAG and Multi-Hop Question Answering](https://www.zyphra.com/post/understanding-graph-based-rag-and-multi-hop-question-answering) - This blog post discusses the relation between multi-hop question-answering and retrieval from graph-...

30. [A Benchmark for Evaluating Repository-Level Code Agents ... - arXiv](https://arxiv.org/html/2603.26337v1) - Most existing code agents are evaluated using benchmarks such as SWE-bench (Jimenez et al., 2023) , ...

31. [What does SWE-bench Verified actually measure?](https://epochai.substack.com/p/what-skills-does-swe-bench-verified-evaluate) - SWE-bench Verified is a set of 500 issues and patches from real python repositories. Each benchmark ...

32. [RAG Observability and Evals - Langfuse](https://langfuse.com/blog/2025-10-28-rag-observability-and-evals) - The @observe() decorator wraps your RAG function and creates a trace for each invocation, capturing ...

33. [Mastering RAG: How To Observe Your RAG Post-Deployment](https://galileo.ai/blog/mastering-rag-how-to-observe-your-rag-post-deployment) - Observing and monitoring systems post-deployment is crucial for identifying potential risks and main...

34. [Enhancing Retrieval-Augmented Generation with Human Feedback](https://arxiv.org/html/2407.00072v5) - We propose Pistis-RAG, a new RAG framework designed with a content-centric approach to better align ...

35. [What Is Reinforcement Learning From Human Feedback (RLHF)?](https://www.ibm.com/think/topics/rlhf) - RLHF is a machine learning technique in which a “reward model” is trained with direct human feedback...

36. [Feedback Loops & Active Learning in RAG - LinkedIn](https://www.linkedin.com/pulse/feedback-loops-active-learning-rag-supercharging-accuracy-agarwal-twsuc) - Why Feedback Loops Matter in RAG · Learn from user corrections or thumbs-downs · Identify failure mo...

37. [How to Secure RAG Applications? A Detailed Overview](https://www.uscsinstitute.org/cybersecurity-insights/blog/how-to-secure-rag-applications-a-detailed-overview) - Learn about top risks and how to secure Retrieval-Augmented Generation (RAG) applications with best ...

38. [RAG: How to protect sensitive and PII info with Elasticsearch ...](https://www.elastic.co/search-labs/blog/rag-security-masking-pii) - In this post we will look at ways to protect Personal Identifiable Information (PII) and sensitive d...

39. [What is RAG, and how to secure it - Snyk](https://snyk.io/articles/what-is-rag-and-how-to-secure-it/) - Learn how Retrieval-Augmented Generation improves LLMs with your data. Understand critical RAG secur...

40. [Build an unstructured data pipeline for RAG | Databricks on AWS](https://docs.databricks.com/aws/en/generative-ai/tutorials/ai-cookbook/quality-data-pipeline-rag) - This article describes how to build an unstructured data pipeline for gen AI applications. Unstructu...

41. [Code-Index-MCP](https://mcpservers.org/servers/ViperJuice/Code-Index-MCP) - Modular, extensible local-first code indexer designed to enhance Claude Code and other LLMs with dee...

42. [From Microservices Mesh to Streamlined Video Indexing - TwelveLabs](https://www.twelvelabs.io/blog/indexing-3-0-part-1) - Learn how TwelveLabs redesigned video indexing with a layered architecture to scale teams, reduce co...

43. [Code Index: Analyze & Search Code Repositories with LLMs](https://mcpmarket.com/server/code-index) - Code Index is a Model Context Protocol server designed to help large language models (LLMs) effectiv...

44. [Building RAG on codebases: Part 1 - LanceDB](https://lancedb.com/blog/building-rag-on-codebases-part-1/) - Building a Cursor-like @codebase RAG solution. Part 1 focuses on indexing techniques, chunking strat...

45. [Tree-Sitter Code Indexing: The Secret to Better AI Code ... - Groundy](https://groundy.com/articles/tree-sitter-code-indexing-the-secret-to-better-ai-code-understanding/) - Tree-sitter generates concrete syntax trees that preserve every detail of the source code while stil...

46. [Integrating BM25 in Hybrid Search and Reranking Pipelines](https://dev.to/negitamaai/integrating-bm25-in-hybrid-search-and-reranking-pipelines-strategies-and-applications-4joi) - This report examines BM25's dual role in hybrid search systems and reranking pipelines, analyzing im...

47. [Hybrid Search in RAG: Dense + Sparse (BM25/SPLADE ... - GoPenAI](https://blog.gopenai.com/hybrid-search-in-rag-dense-sparse-bm25-splade-reciprocal-rank-fusion-and-when-to-use-which-fafe4fd6156e) - Run hybrid retrieval: BM25 + Dense → RRF Fusion → optional Reranking. retrieval_k: how many results ...

48. [GitHub - JaredStewart/coderlm: Tree-sitter-powered code indexing ...](https://github.com/JaredStewart/coderlm) - CodeRLM applies the Recursive Language Model (RLM) pattern to codebases. A Rust server indexes a pro...

49. [Local Code Search Index MCP Server Based on Zoekt - AIBase](https://mcp.aibase.com/server/1586804740191429026) - Code Index MCP Server is a tool specifically designed for code search. It can build a code index on ...

50. [Observability of Retrieval-Augmented Generation pipelines](https://docs.dynatrace.com/docs/observe/dynatrace-for-ai-observability/sample-use-cases/self-service-ai-observability-tutorial) - We can now see traces that describe each step taken by the LangChain RAG pipeline and identify bottl...

