# MCP Clients and Tool Guide

This guide explains how to use the BaseMemory indexer from Claude Code, Cursor, Windsurf, and any other MCP-compatible client that can launch a stdio server.

## What This Server Actually Provides

The MCP server is a local code-intelligence server over your repo. It gives the client:

- hybrid retrieval: BM25 + dense embeddings + deterministic ranking + reranking
- semantic code search by meaning, not just exact strings
- definition lookup
- call graph navigation
- symbol lookup
- callers/callees/call chains
- test discovery
- indexing, status, coverage, health, logs, and metrics

The current MCP server exposes these tools:

- `codebase_search`
- `codebase_peek`
- `index_codebase`
- `index_status`
- `index_coverage`
- `index_health_check`
- `index_metrics`
- `index_logs`
- `find_similar`
- `implementation_lookup`
- `call_graph`
- `symbol_info`
- `callers`
- `callees`
- `call_chain`
- `tests_for`

It also exposes these prompts:

- `search`
- `find`
- `index`
- `status`
- `definition`

## Supported Clients

Anything that supports MCP over stdio should work. In practice, the project is designed to be used from:

- Claude Code
- Cursor
- Windsurf
- any other MCP client that can launch a command and talk stdio

## Starting the MCP Server

The server entrypoint is the CLI:

```bash
npx tsx src/cli.ts --project /absolute/path/to/repo
```

For packaged usage, the published binary is:

```bash
npx opencode-codebase-index-mcp --project /absolute/path/to/repo
```

Useful flags:

- `--project <path>`
  - repo root to index/search
- `--config <path>`
  - explicit config file path

If `--config` is omitted, config resolution is:

1. `<projectRoot>/.opencode/codebase-index.json`
2. `~/.config/opencode/codebase-index.json`
3. defaults

## Example MCP Configs

Use these as templates. Different client versions sometimes use slightly different wrapper JSON, but the command/args are the important part.

### Cursor

```json
{
  "mcpServers": {
    "basememory-index": {
      "command": "npx",
      "args": [
        "opencode-codebase-index-mcp",
        "--project",
        "/absolute/path/to/repo"
      ]
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "basememory-index": {
      "command": "npx",
      "args": [
        "opencode-codebase-index-mcp",
        "--project",
        "/absolute/path/to/repo"
      ]
    }
  }
}
```

### Windsurf or another generic MCP client

Use the same command shape:

```json
{
  "command": "npx",
  "args": [
    "opencode-codebase-index-mcp",
    "--project",
    "/absolute/path/to/repo"
  ]
}
```

## How To Think About The Tools

### Fast rule of thumb

- You want code content by meaning:
  - use `codebase_search`
- You only want locations first:
  - use `codebase_peek`
- You want “where is this defined”:
  - use `implementation_lookup`
- You want exact symbol metadata:
  - use `symbol_info`
- You want impact / dependency flow:
  - use `callers`, `callees`, or `call_chain`
- You want tests for a symbol or file:
  - use `tests_for`
- You want duplicate or pattern matches from a snippet:
  - use `find_similar`
- You want to initialize or inspect the index:
  - use the `index_*` tools

## Tool-by-Tool Guide

### `codebase_search`

Use this when the user describes behavior or intent and you want actual code content back.

Best for:

- “where is request validation handled?”
- “show me the retry logic for database busy errors”
- “find the code that converts arbitrary causes into client errors”

Useful inputs:

- `query`
- `taskType`
  - `general`
  - `definition`
  - `bug`
  - `test_debug`
  - `semantic`
- `graphDepth`
  - expands into related callers/callees
- `filters`
  - `chunk_type`
  - `path_glob`
  - `language`

Use `taskType` when you know the user intent:

- `definition` for “where is X defined”
- `bug` for debugging/failure analysis
- `test_debug` for tests
- `semantic` for concept-heavy natural-language retrieval
- `general` for mixed/default use

### `codebase_peek`

Use this for the same retrieval path as `codebase_search`, but metadata only.

Best for:

- saving tokens
- quickly finding 5 to 10 candidate locations
- interactive navigation where the client can open files separately

Typical workflow:

1. `codebase_peek`
2. inspect the returned file + line locations
3. open the best one with the client’s read/open tool

### `implementation_lookup`

Use this when the request is explicitly “where is this defined?” or “jump me to the implementation.”

It prefers:

- implementation files
- source files

and deprioritizes:

- tests
- docs
- examples

This is the best tool for definition jumps.

### `symbol_info`

Use this when you already know the symbol name and want the indexed identity card.

Returns:

- stable symbol id
- file
- lines
- kind
- signature
- chunk kind

Use this before structural graph queries when a name may be ambiguous.

### `call_graph`

Legacy/simple call-graph query surface.

Use it when you want:

- simple callers of a function name
- simple callees by symbol id

For richer structural workflows, the newer tools are usually better:

- `callers`
- `callees`
- `call_chain`

### `callers`

Best for impact analysis.

Use it when you need:

- who calls this symbol
- what upstream code depends on it
- whether tests call it

Supports:

- file-based disambiguation
- excluding tests
- pagination

### `callees`

Best for downstream flow analysis.

Use it when you need:

- what this function invokes
- which edges are resolved vs unresolved

### `call_chain`

Best for shortest-path reasoning in the resolved call graph.

Use it when you need:

- “how do we get from A to B?”
- “is there a path from request entrypoint to this sink?”

### `tests_for`

Use it when the agent needs to find the tests for a symbol or file.

It combines:

- call-graph evidence
- naming heuristics

Good for:

- regression work
- test updates
- finding coverage around a changed symbol

### `find_similar`

Use it when you already have a code snippet and want near-neighbor patterns.

Best for:

- finding duplicate logic
- seeing how a pattern is implemented elsewhere
- refactor prep

### `index_codebase`

Use this to build or refresh the index.

Modes:

- normal
  - incremental index
- `force=true`
  - clear and rebuild
- `estimateOnly=true`
  - cost estimate only

### `index_status`

Use this to check whether the repo is indexed and which provider/reranker state is active.

### `index_coverage`

Use this when retrieval quality looks suspicious and you want coverage diagnostics:

- files truncated by chunk caps
- currently invisible named symbols

### `index_health_check`

Use this after deletes, branch churn, or suspicious stale results.

It cleans:

- stale entries from deleted files
- orphaned embeddings
- orphaned chunks
- orphaned symbols
- orphaned call edges

### `index_metrics`

Use this only when debug metrics are enabled in config.

Good for:

- timing analysis
- embedding call counts
- cache behavior

### `index_logs`

Use this only when debug logging is enabled in config.

Good categories:

- `search`
- `embedding`
- `cache`
- `gc`
- `branch`
- `general`

## What To Use In Common Situations

### “I don’t know the identifier”

Use:

1. `codebase_peek`
2. then `codebase_search` if you need the content

### “I know the symbol name”

Use:

1. `symbol_info`
2. `implementation_lookup` if you want definition-ranked locations

### “I need all callers / impact”

Use:

1. `symbol_info` if name may be ambiguous
2. `callers`

### “I need downstream flow”

Use:

1. `symbol_info`
2. `callees`
3. `call_chain` if you need path reasoning

### “I need the tests”

Use:

- `tests_for`

### “I need to initialize the repo”

Use:

1. `index_status`
2. `index_codebase`

## Notes About Initialization

The MCP server is lazy-initialized:

- creating the server does not immediately initialize the `Indexer`
- initialization happens on the first tool call

So if a client connects successfully but the first real request feels slower, that is usually the first `ensureInitialized()` path, not a broken server.

## Notes About Reranking

Search candidate ordering is not just embeddings.

The current server can use:

- Jina API reranker if `jinaApiKey` is configured
- local Transformers.js cross-encoder if Jina is not configured
- heuristic local fallback if reranking backends fail

So if quality seems degraded, check:

- `index_status`
- `index_logs`
- `index_metrics`

## Recommended Client Workflow

For most agent work:

1. `index_status`
2. `codebase_peek` or `implementation_lookup`
3. open/read the best file
4. `callers` / `callees` / `tests_for` if needed
5. `codebase_search` only when you need code content immediately

That keeps token usage and latency lower than defaulting to content-heavy search for everything.

## Decision Tree: Which Tool Comes Next

This is the practical workflow section. The point is not just knowing what each tool does. The point is driving the agent toward the next best action.

### Start state

If the repo may not be indexed yet:

1. `index_status`
2. if needed, `index_codebase`

If the repo is already indexed:

1. decide whether you need discovery, exact symbol identity, or graph/navigation context

### You are starting from a natural-language request

Examples:

- “where is retry logic for SQLite busy errors?”
- “find the code that converts arbitrary causes into client errors”
- “where is header sanitization implemented?”

Use:

1. `codebase_peek` if you want fast candidate locations first
2. `codebase_search` if you need code content immediately
3. `implementation_lookup` if the user is really asking for the definition, not just related code

### You already know the symbol name

Examples:

- `retry_busy_sqlite`
- `sanitizeHeaderValue`
- `_parse`

Use:

1. `symbol_info`
2. if you need the actual definition jump, `implementation_lookup`
3. if ambiguous, pass `file_path`

### You are about to modify a function

Use:

1. `symbol_info`
2. `tests_for`
3. `callers`
4. then read/edit

Reason:

- `tests_for` tells you what protects the behavior
- `callers` tells you blast radius

This should be the default workflow before changing nontrivial code.

### You need impact analysis

Examples:

- “what breaks if I change this?”
- “who depends on this helper?”

Use:

1. `symbol_info`
2. `callers`
3. optionally `tests_for`

### You need downstream execution flow

Examples:

- “what does this function call?”
- “what happens after this handler?”

Use:

1. `symbol_info`
2. `callees`
3. `call_chain` if you need a path from one symbol to another

### You need to trace execution from A to B

Examples:

- “is there a path from request parsing to DB write?”
- “how do we get from router entrypoint to retry_busy_sqlite?”

Use:

1. `symbol_info` for both ends if names may be ambiguous
2. `call_chain`
3. if no path is found, inspect `callers` / `callees` around the endpoints

### You are debugging a failure from a stack trace or log

Examples:

- `_parse`
- `_request`
- internal helper names that may not be public API

Use:

1. `symbol_info`
2. `implementation_lookup`
3. `callers` if you need upstream context
4. `tests_for` before modifying behavior

### You are exploring an unfamiliar subsystem

Use:

1. `codebase_peek`
2. read the top 2 to 5 results
3. `callers` / `callees` around the best symbol
4. `tests_for` to find behavior examples

### You already have one code snippet and want related implementations

Use:

1. `find_similar`
2. `codebase_peek` if you need broader concept search around the same area

## Recommended Agent Workflows

### Workflow: definition jump

1. `implementation_lookup`
2. if ambiguous, `symbol_info`
3. open/read the winning file

### Workflow: safe code edit

1. `symbol_info`
2. `tests_for`
3. `callers`
4. read/edit
5. run relevant tests

### Workflow: bug investigation

1. `codebase_search` with `taskType="bug"` or `implementation_lookup` if symbol is known
2. `callers`
3. `callees`
4. `tests_for`

### Workflow: architecture trace

1. `codebase_peek`
2. `symbol_info` on the best hit
3. `call_chain`
4. `callers` / `callees` on adjacent nodes

### Workflow: token-efficient navigation

1. `codebase_peek`
2. open/read exact files
3. `symbol_info` or graph tools as needed

Only switch to `codebase_search` when you need inline code content immediately.
