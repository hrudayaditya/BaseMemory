# Developer Guide

## File layout

Phase 1 server files:

- [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- [scripts/start-graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/scripts/start-graph.ts)
- [src/graph-ui/index.html](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-ui/index.html)
- [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)

Runtime script:

- `npm run graph`

## What the server actually is

HyperBase Phase 1 is:

- an Express server
- backed directly by `better-sqlite3`
- serving static UI files from `src/graph-ui/`
- exposing graph endpoints under `/api`

It is intentionally separate from MCP.

That separation is correct:

- MCP is the agent integration surface
- HyperBase is the human and UI graph surface

The bridge between them is `/api/mcp/neighborhood/:id`, which returns the canonical graph JSON envelope.

## Startup model

The launcher in [scripts/start-graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/scripts/start-graph.ts):

1. looks for a DB path override in CLI args
2. tries a few config keys in `.opencode/codebase-index.json`
3. falls back to `.opencode/index/codebase.db`
4. spawns [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts) through `tsx`

Current repo reality:

- BaseMemory’s `.opencode/codebase-index.json` does not define a DB path today
- the normal path is still `.opencode/index/codebase.db`

## CLI flags

`src/graph-server.ts` supports:

- `--db <path>`
- `--branch <branch>`
- `--port <n>`

Defaults:

- DB: `.opencode/index/codebase.db`
- branch: first branch found in the DB
- port: `7842`

## Branch handling

Every branch-aware route uses the same rule:

- omitted `branch` query param: use server default branch
- present but unknown `branch`: return `400 BRANCH_NOT_FOUND`

The branch list is built at startup from:

- `call_edges.branch`
- plus `branch_symbols.branch` as fallback

## Data model

Use `symbols` as graph nodes.
Use `call_edges` as graph edges.
Use `chunks` only when you need retrieval-aligned code previews.

Why:

- graph structure is symbol-level
- `call_edges.to_symbol_id` points at `symbols.id`
- `chunks` represent retrieval/code spans, not graph identity

## Query strategy

All DB statements are prepared once at startup in `prepareStatements(...)`.

Important design choice:

- the BFS endpoints do not concatenate arbitrary SQL lists
- they pass JSON arrays into prepared statements
- SQLite expands them with `json_each(?)`

That keeps the queries reusable while still allowing frontier batches.

## Graph behaviors that matter

### Neighborhood

`/api/neighborhood/:id`

- BFS on resolved callers and resolved callees
- node cap `300`
- unresolved edges are added only after BFS
- unresolved edges never create new nodes
- degree counts resolved edges only

This is the core invariant set for the UI.

### Blast radius

`/api/blast-radius/:id`

- callers only
- resolved edges only
- node cap `500`
- returns depth by node id

This is the right primitive for impact analysis.

### Path

`/api/path`

- shortest path over resolved edges
- traverses both directions
- hard stop at `1000` visited nodes

This is a UI feature primitive, not a general graph analytics engine.

### Full graph

`/api/graph/full`

- file-level nodes
- cross-file resolved edges only
- same-file edges excluded

This is the Phase 1 galaxy-view payload.

## Error model

Only these error codes are used:

- `INVALID_INPUT`
- `BRANCH_NOT_FOUND`
- `NOT_FOUND`
- `DB_ERROR`
- `INTERNAL_ERROR`

Do not invent new codes casually. Keep the API predictable for the future UI and MCP consumers.

## Testing model

Tests live in [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts).

Important detail:

- the sandbox used for CI-like runs here blocks listening sockets
- the tests therefore exercise the Express app fully in-process using mocked request/response objects
- this is why the suite is stable even when localhost binding is unavailable

That is the right test shape for route behavior.

For manual verification, the real server still runs normally with `npm run graph`.

## How to extend HyperBase safely

When adding a new endpoint:

1. decide whether it is symbol-level or file-level
2. keep branch handling consistent with existing routes
3. prepare the SQL at startup
4. avoid ad hoc SQL string construction for list inputs
5. add one focused endpoint test and one failure-mode test
6. document the new route in [api-reference.md](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md)

## Best next additions

These are the most natural Phase 2 server additions:

- `/api/graph/directory/:path`
- `/api/search/semantic?q=...`
- `/api/symbol/:id/callers`
- `/api/symbol/:id/callees`
- `/api/export/subgraph`

The most important missing one is:

- `/api/graph/directory/:path`

That is the bridge between the file-level galaxy view and the symbol-level neighborhood view.

## Integration points

For a browser UI:

- start with `/api/graph/full`
- search with `/api/search`
- drill into `/api/neighborhood/:id`
- use `/api/peek/:id` for the detail panel

For future agent tooling:

- use `/api/mcp/neighborhood/:id`
- treat `schema: "hyperbase-graph-v1"` as the canonical graph envelope

## What not to do

- Do not build the UI directly on raw SQLite queries from the browser.
- Do not treat unresolved edges as equivalent to resolved edges.
- Do not assume names are unique across files.
- Do not render the entire symbol graph by default.
- Do not bypass the branch parameter in the client state model.

## Useful commands

Start the server:

```bash
npm run graph
```

Use a specific branch:

```bash
npm run graph -- --branch after-tune/refactor
```

Use a different port:

```bash
npm run graph -- --port 9000
```

Run all tests:

```bash
npm run test:run
```

Run only the HyperBase route suite:

```bash
npx vitest run tests/graph-server.test.ts
```
