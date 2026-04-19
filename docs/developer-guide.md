# Developer Guide

This guide is for developers working on the BaseMemory indexer itself or using it to index and evaluate other repos.

## What This Repo Contains

BaseMemory is a hybrid TypeScript + Rust code indexer.

- `src/`
  - CLI
  - MCP server
  - config parsing
  - search / ranking logic
  - embedding provider integration
  - eval harness
- `native/`
  - tree-sitter parsing and chunking
  - SQLite storage
  - vector store
  - BM25 inverted index
  - call graph extraction

## Core Commands

### Build

```bash
npm run build
npm run build:ts
npm run build:native
```

### Validation

```bash
npm run typecheck
npm run test:run
npm run lint
```

### Native-only validation

```bash
cd native
cargo test --locked
```

## Ways To Run The Indexer

There are three main ways to use the system.

### 1. MCP server

Run the stdio MCP server against a repo:

```bash
npx tsx src/cli.ts --project /absolute/path/to/repo
```

Or with an explicit config:

```bash
npx tsx src/cli.ts \
  --project /absolute/path/to/repo \
  --config /absolute/path/to/codebase-index.json
```

Use this path when:

- you want Claude Code / Cursor / Windsurf / another MCP client to talk to the index

### 2. Direct indexing script

Cold-index a target repo from this workspace:

```bash
npx tsx scripts/index-repo.ts /absolute/path/to/repo
```

Important behavior:

- this writes the index into the target repo’s `.opencode/index`
- this script always loads config from:
  - `/Users/aady/Desktop/OpenSourceContributions/BaseMemory/.opencode/codebase-index.json`
- it does not load config from the target repo

Use this path when:

- you want a simple, explicit cold-start indexing command
- you want the benchmarking/indexing script output

### 3. Eval harness

Run evaluation directly:

```bash
npx tsx src/cli.ts eval run --dataset benchmarks/golden/small.json
```

Use this path when:

- you want retrieval metrics
- you want compare/gate/diff workflows
- you optionally want eval-triggered reindex with `--reindex`

## Indexing and Reindexing

### Index BaseMemory itself

Using the indexing script:

```bash
npx tsx scripts/index-repo.ts /Users/aady/Desktop/OpenSourceContributions/BaseMemory
```

### Index an external repo

```bash
npx tsx scripts/index-repo.ts /absolute/path/to/external-repo
```

### Force reindex during eval

```bash
npx tsx src/cli.ts eval run \
  --dataset /absolute/path/to/dataset.json \
  --project /absolute/path/to/repo \
  --config /absolute/path/to/codebase-index.json \
  --reindex
```

### When you do not need to reindex

You do not need to reindex after:

- ranking-only TypeScript changes
- reranker changes
- eval harness/reporting changes

You do need to reindex after:

- native chunker/parser changes
- DB schema changes
- ignore/filter changes that affect which files are indexed
- stored metadata changes

## Running Evals

### Internal eval on BaseMemory

```bash
npx tsx src/cli.ts eval run --dataset benchmarks/golden/small.json
```

### Internal eval with explicit config

```bash
npx tsx src/cli.ts eval run \
  --dataset /Users/aady/Desktop/OpenSourceContributions/BaseMemory/benchmarks/golden/small.json \
  --project /Users/aady/Desktop/OpenSourceContributions/BaseMemory \
  --config /Users/aady/Desktop/OpenSourceContributions/BaseMemory/.opencode/codebase-index.json
```

### External repo eval

Use absolute paths for `--dataset` and `--config`.

This avoids path-resolution mistakes when the project root is not BaseMemory.

Example:

```bash
npx tsx src/cli.ts eval run \
  --dataset /Users/aady/Desktop/OpenSourceContributions/BaseMemory/benchmarks/golden/axios-external.json \
  --project /Users/aady/Desktop/OpenSourceContributions/axios \
  --config /Users/aady/Desktop/OpenSourceContributions/BaseMemory/.opencode/codebase-index.json
```

Same pattern for `trpc`, `zod`, or any other repo.

### Eval subcommands

The CLI supports:

- `eval run`
- `eval gate`
- `eval compare`
- `eval diff`

Useful flags:

- `--project <path>`
- `--config <path>`
- `--dataset <path>`
- `--output <path>`
- `--against <summary.json>`
- `--budget <budget.json>`
- `--ci`
- `--reindex`
- `--fusionStrategy <rrf|weighted>`
- `--hybridWeight <0-1>`
- `--rrfK <number>`
- `--rerankTopN <number>`
- `--taskType <general|definition|bug|test_debug|semantic>`
- `--bm25Weight <0-1>`
- `--denseWeight <0-1>`
- `--voyageWeight <0-1>`
- `--identifierBoost <number>`
- `--graphDepth <number>`
- `--finalRerankTopN <number>`

## Search Task Types

The current supported task types are:

- `general`
- `definition`
- `bug`
- `test_debug`
- `semantic`

Use them intentionally:

- `general`
  - default mixed retrieval
- `definition`
  - definition jumps / implementation lookups
- `bug`
  - bug and failure investigation
- `test_debug`
  - test discovery and test-focused debugging
- `semantic`
  - concept-heavy natural-language search

## Current Config Shape

Config is parsed from JSON and supports:

- `embeddingProvider`
- `embeddingModel`
- `customProvider`
- `jinaApiKey`
- `jinaRerankerModel`
- `voyageApiKey`
- `voyageModelId`
- `scope`
- `include`
- `exclude`
- `indexing`
- `search`
- `debug`
- `eval`

### Minimal default-style config

```json
{
  "embeddingProvider": "auto",
  "scope": "project",
  "indexing": {
    "autoIndex": false,
    "watchFiles": true
  },
  "search": {
    "fusionStrategy": "rrf",
    "hybridWeight": 0.5,
    "rrfK": 60,
    "rerankTopN": 20
  }
}
```

### Custom OpenAI-compatible provider

```json
{
  "embeddingProvider": "custom",
  "customProvider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "timeoutMs": 30000,
    "concurrency": 4,
    "requestIntervalMs": 0
  }
}
```

### Voyage primary + custom secondary lane

This is a supported advanced setup in the current codebase:

```json
{
  "embeddingProvider": "voyage",
  "voyageApiKey": "{env:VOYAGE_API_KEY}",
  "voyageModelId": "voyage-code-2",
  "customProvider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "snowflake-arctic-embed2",
    "dimensions": 1024,
    "timeoutMs": 30000,
    "concurrency": 8,
    "requestIntervalMs": 10
  },
  "jinaApiKey": "{env:JINA_API_KEY}",
  "jinaRerankerModel": "jina-reranker-v3",
  "search": {
    "rerankTopN": 10
  }
}
```

Notes:

- in `voyage` mode, `customProvider` is used as a secondary dense lane
- there is now a startup health probe for that secondary provider
- degraded secondary-lane behavior is cooled down automatically rather than penalizing every query

### Environment variable substitution

String values can use:

```json
"{env:VAR_NAME}"
```

Use this for secrets instead of hardcoding keys.

## Supported Embedding Providers and Models

### Built-in providers

- `github-copilot`
  - `text-embedding-3-small`
- `openai`
  - `text-embedding-3-small`
  - `text-embedding-3-large`
- `google`
  - `text-embedding-005`
  - `gemini-embedding-001`
- `ollama`
  - `nomic-embed-text`
  - `mxbai-embed-large`
- `voyage`
  - `voyage-code-2`
  - `voyage-code-3`

### Custom provider

`embeddingProvider: "custom"` supports any OpenAI-compatible embeddings endpoint as long as you provide:

- `baseUrl`
- `model`
- `dimensions`

Optional:

- `apiKey`
- `maxTokens`
- `timeoutMs`
- `concurrency`
- `requestIntervalMs`
- `maxBatchSize`

## Supported Rerankers

The current reranker stack is:

### Primary, when `jinaApiKey` is configured

- `jina-api`
  - default model: `jina-reranker-v3`

Fallback:

- `heuristic-local`

### Primary, when `jinaApiKey` is not configured

- `transformers-cross-encoder`
  - current local model: `Xenova/ms-marco-MiniLM-L-6-v2`

Fallback:

- `heuristic-local`

Operational note:

- if the reranker degrades, retrieval still works
- but quality can drop materially
- benchmark runs should be treated as noisy if reranker failures are high

## Debug and Ops Features

### Debug config

```json
{
  "debug": {
    "enabled": true,
    "logLevel": "info",
    "logSearch": true,
    "logEmbedding": true,
    "logCache": true,
    "logGc": true,
    "logBranch": true,
    "metrics": true
  }
}
```

Useful with:

- `index_metrics`
- `index_logs`

### Index maintenance tools

- `index_status`
- `index_coverage`
- `index_health_check`

These are often the first things to inspect when retrieval quality seems off.

## Important Operational Gotchas

### `scripts/index-repo.ts` config behavior

This is the biggest one.

When you run:

```bash
npx tsx scripts/index-repo.ts /path/to/other-repo
```

the script:

- indexes the target repo
- writes the index into the target repo
- but uses BaseMemory’s config file, not the target repo’s config

If you then run eval with a different config, indexing and eval are out of sync.

### External eval path resolution

For external repos, prefer absolute paths for:

- `--dataset`
- `--config`

That avoids dataset/config resolution problems relative to the external project root.

### MCP init timing

The MCP server is lazy-initialized.

That means:

- `new Indexer(...)` happens at server creation
- `indexer.initialize()` happens on first tool call

If the first request is slower, that is usually initialization cost.

### External evals and Jina rate limits

Do not run external evals in parallel when you are using the Jina API reranker.

Reason:

- Jina has a practical token-per-minute ceiling
- in our benchmarking work, parallel external evals pushed enough text through reranking to degrade runs
- once the reranker degrades, the run stops being a clean quality signal

Operational rule:

- run external evals sequentially
- especially for larger datasets or external repos with long candidate chunks

### `reranker.failureCount > 2` means the run is not trustworthy

Treat any eval run with:

- `metrics.reranker.failureCount > 2`

as invalid for benchmark signoff.

Why:

- the retrieval stack is no longer being measured under the intended reranker path
- fallback behavior can materially change ranking quality
- comparing such a run against clean baseline runs is misleading

Practical rule:

1. inspect `summary.json`
2. if `reranker.failureCount > 2`, discard the run
3. rerun after load/rate-limit conditions are clean

### `--reindex` p95 inflation is not always a retrieval regression

During `--reindex` eval runs, p95 can inflate even when search quality is fine.

A common cause is local embedding contention, especially with Ollama or another local secondary provider:

- query-time work is competing with embedding-time work
- the run looks slower, but the ranking logic is not the cause

So:

- do not treat every `--reindex` latency spike as a retrieval regression
- compare warm-index runs separately from reindexing runs
- if p95 is high only during `--reindex`, suspect provider contention first

### Fresh-index vs stale-index comparisons

If you changed:

- chunking
- parser behavior
- stored metadata
- ignore rules

then a no-reindex eval against an old index is not a valid quality comparison.

You need:

1. a fresh index
2. then the eval

Ranking-only changes are the exception. Those can be evaluated without reindexing.

## Writing Golden Query Sets For A New Repo

This section is the practical process for authoring a strong external golden dataset.

### Goal

A golden set should measure whether the indexer returns the right implementation location for real developer questions, not whether it can memorize benchmark-specific wording.

### Non-negotiable standards

Every golden query should have:

- one unambiguous correct answer
- a real source-grounded expected location
- wording that a normal developer might plausibly ask

Do not include queries that have:

- multiple equally reasonable answers
- doc/example/test answers when the real implementation is the real target
- vague conceptual wording with no single location

### Query authoring workflow

1. Read the repo first.
2. Identify canonical implementation surfaces.
3. Write candidate queries from those implementation surfaces.
4. Verify every expected answer directly against source.
5. Drop anything ambiguous.
6. Only then run eval.

### How to pick targets

Good targets:

- public API definitions
- implementation functions with clear ownership
- concrete helpers with unique behavior
- test entrypoints with clearly associated coverage
- caller/callee relationships with one authoritative implementation

Bad targets:

- broad concepts spread across many files
- names reused in multiple modules without clear disambiguation
- wrappers/docs/examples unless they are explicitly the intended answer

### Recommended query mix

For a strong external dataset, include a mix of:

- definition lookups
- implementation-intent questions
- bug/error lookups
- test-discovery queries
- a smaller number of concept-style semantic queries

But keep the standard the same:

- one clear correct answer per query

### Examples of good query shapes

Definition:

- “where is sanitizeHeaderValue defined”
- “where is retry_busy_sqlite implemented”

Implementation intent:

- “function that coerces arbitrary causes into a client error”
- “factory that returns the mutable procedure builder”

Bug/error lookup:

- “where SQLite busy errors are retried”
- “where invalid header values are sanitized before assignment”

Test discovery:

- “what tests cover sanitizeHeaderValue”
- “tests for query handler abort behavior”

### How to verify expected answers

For each query:

1. locate the expected file manually
2. confirm the symbol or exact implementation block
3. record the current line range
4. check whether there are duplicates or wrappers that could make the query ambiguous

If there are two plausible answers:

- rewrite the query to sharpen intent
- or remove the query

### Dataset file shape

Use the existing golden schema described in:

- [Evaluation Harness](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/evaluation.md)

In practice, each query should carry:

- stable `id`
- natural-language `query`
- `queryType`
- expected file and, when useful, symbol

### Naming conventions for query ids

Prefer stable, readable ids like:

- `axios-def-sanitize-header-value`
- `trpc-impl-create-builder`
- `zod-tests-safe-parse`

Good ids make per-query diffs much easier to reason about.

### Before you trust the numbers

Do this review pass:

1. scan every query for ambiguity
2. verify line ranges against current source
3. confirm no answer accidentally points to moved code
4. confirm the dataset is testing the implementation you care about, not a duplicate/doc/test file

Bad golden queries produce meaningless metrics. The review pass is mandatory.

## Suggested Workflows

### Develop and validate BaseMemory

```bash
npm run build:native
cargo test --locked
npm run typecheck
npm run test:run
npx tsx scripts/index-repo.ts /Users/aady/Desktop/OpenSourceContributions/BaseMemory
npx tsx src/cli.ts eval run --dataset benchmarks/golden/small.json
```

### Index an external repo with BaseMemory config

```bash
npx tsx scripts/index-repo.ts /absolute/path/to/external-repo
```

### Evaluate an external repo using the same config

```bash
npx tsx src/cli.ts eval run \
  --dataset /absolute/path/to/dataset.json \
  --project /absolute/path/to/external-repo \
  --config /Users/aady/Desktop/OpenSourceContributions/BaseMemory/.opencode/codebase-index.json
```

### Do a clean external benchmark run

```bash
npx tsx src/cli.ts eval run \
  --dataset /absolute/path/to/dataset.json \
  --project /absolute/path/to/external-repo \
  --config /Users/aady/Desktop/OpenSourceContributions/BaseMemory/.opencode/codebase-index.json \
  --reindex
```

## Which Doc To Read Next

- benchmark methodology:
  - [Evaluation Harness](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/evaluation.md)
- cross-repo benchmark runner:
  - [Cross-repo Benchmarking](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/benchmarking-cross-repo.md)
- MCP usage and tool selection:
  - [MCP Clients and Tool Guide](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/mcp-clients.md)
