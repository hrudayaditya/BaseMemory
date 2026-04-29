# API Reference

Base URL:

- `http://127.0.0.1:7842`

All routes are `GET`.
All graph routes are branch-aware.
The browser UI calls these routes through [src/hyperbase/src/api/client.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/api/client.ts).

## Branch behavior

Every endpoint that accepts `?branch=` follows the same rule:

- if `branch` is omitted, HyperBase uses the server default branch
- if `branch` is provided and not present in the DB, HyperBase returns HTTP `400`

Error shape:

```json
{
  "error": "Unknown branch: your-branch",
  "code": "BRANCH_NOT_FOUND"
}
```

## Error codes

Every error response has this shape:

```json
{
  "error": "message",
  "code": "ERROR_CODE"
}
```

Codes in use:

- `INVALID_INPUT`
- `BRANCH_NOT_FOUND`
- `NOT_FOUND`
- `DB_ERROR`
- `INTERNAL_ERROR`

## `GET /api/health`

Response:

```json
{
  "status": "ok",
  "dbPath": "/absolute/path/to/codebase.db",
  "branch": "after-tune/refactor",
  "symbolCount": 3262,
  "resolvedEdgeCount": 7651,
  "version": "0.1.0"
}
```

## `GET /api/branches`

Response:

```json
{
  "branches": ["after-tune/refactor"]
}
```

## `GET /api/search?q=<name>&branch=<branch>`

Searches `symbols.name` with case-insensitive substring matching.

Sort order:

1. `length(name)` ascending
2. `name` ascending

Response:

```json
{
  "results": [
    {
      "id": "sym_49a3e9f893f1d15e",
      "name": "buildPerQueryResult",
      "kind": "function",
      "filePath": "/repo/src/eval/metrics.ts",
      "language": "typescript",
      "startLine": 218
    }
  ]
}
```

## `GET /api/symbol/:id?branch=<branch>`

Returns one symbol plus resolved caller/callee counts.

Response:

```json
{
  "symbol": {
    "id": "sym_49a3e9f893f1d15e",
    "name": "buildPerQueryResult",
    "kind": "function",
    "filePath": "/repo/src/eval/metrics.ts",
    "language": "typescript",
    "startLine": 218,
    "endLine": 266,
    "callerCount": 12,
    "calleeCount": 7
  }
}
```

Errors:

- `404 NOT_FOUND` if the symbol does not exist on the selected branch

## `GET /api/neighborhood/:id?branch=<branch>&depth=<1|2|3>`

The main symbol graph endpoint.

Rules:

- default depth: `1`
- max depth: `3`
- BFS expands resolved callers and resolved callees
- node cap: `300`
- if the cap is hit, `truncated: true`
- unresolved edges are added after the resolved BFS pass
- unresolved edges never create new nodes
- unresolved edges are represented honestly with `to: null`
- node `degree` counts resolved incident edges only

Response:

```json
{
  "centerSymbolId": "sym_49a3e9f893f1d15e",
  "depth": 1,
  "truncated": false,
  "nodes": [
    {
      "id": "sym_49a3e9f893f1d15e",
      "name": "buildPerQueryResult",
      "kind": "function",
      "filePath": "/repo/src/eval/metrics.ts",
      "language": "typescript",
      "startLine": 218,
      "degree": 30
    }
  ],
  "edges": [
    {
      "id": "edge_resolved",
      "from": "sym_a",
      "to": "sym_b",
      "callType": "Call",
      "isResolved": true,
      "callerFilePath": "/repo/src/a.ts",
      "targetFilePath": "/repo/src/b.ts",
      "line": 42
    },
    {
      "id": "edge_unresolved",
      "from": "sym_a",
      "to": null,
      "callType": "Call",
      "isResolved": false,
      "callerFilePath": "/repo/src/a.ts",
      "targetFilePath": null,
      "line": 43
    }
  ]
}
```

Client note:

- the UI’s Graphology builder skips unresolved edges with `to: null`
- they remain in the API payload for inspection and future rendering work

Errors:

- `400 INVALID_INPUT` if `depth` is outside `1..3`
- `404 NOT_FOUND` if the center symbol does not exist

## `GET /api/graph/full?branch=<branch>`

File-level graph for the galaxy view.

Rules:

- nodes are files
- edges are aggregated resolved cross-file call edges
- same-file edges are excluded
- rows with null caller or target file paths are excluded

Response:

```json
{
  "nodes": [
    {
      "id": "file::/repo/src/indexer/index.ts",
      "filePath": "/repo/src/indexer/index.ts",
      "language": "typescript",
      "symbolCount": 48,
      "directory": "/repo/src/indexer"
    }
  ],
  "edges": [
    {
      "from": "file::/repo/src/eval/runner.ts",
      "to": "file::/repo/src/indexer/index.ts",
      "callCount": 12
    }
  ]
}
```

Reserved route space:

- `/api/graph/directory/:path`

It is still not implemented.

## `GET /api/blast-radius/:id?branch=<branch>`

Downstream dependency BFS.

Rules:

- follows callers only
- resolved edges only
- node cap: `500`
- returns a `depth` map keyed by node id

Response:

```json
{
  "symbolId": "sym_target",
  "truncated": false,
  "nodes": [],
  "edges": [],
  "depth": {
    "sym_target": 0,
    "sym_direct_caller": 1,
    "sym_indirect_caller": 2
  }
}
```

## `GET /api/path?from=<id>&to=<id>&branch=<branch>`

Shortest path over resolved edges.

Current implementation details that matter:

- traverses both directions
- batches frontier expansion per hop
- does not issue per-node DB queries during BFS
- hard stop at `1000` visited nodes

Found response:

```json
{
  "found": true,
  "exhausted": false,
  "path": [
    {
      "id": "sym_a",
      "name": "entrypoint",
      "filePath": "/repo/src/a.ts"
    },
    {
      "id": "sym_b",
      "name": "target",
      "filePath": "/repo/src/b.ts"
    }
  ],
  "edges": []
}
```

Not found response:

```json
{
  "found": false,
  "exhausted": false,
  "path": [],
  "edges": []
}
```

Exhausted response:

```json
{
  "found": false,
  "exhausted": true,
  "path": [],
  "edges": []
}
```

Errors:

- `400 INVALID_INPUT` if `from` or `to` is missing
- `404 NOT_FOUND` if either symbol id does not exist

## `GET /api/peek/:symbolId?branch=<branch>`

Returns source content for the smallest chunk containing the symbol span.

Rules:

- looks up the symbol
- finds overlapping chunks in the same file
- picks the smallest containing chunk
- reads source from disk
- returns `content: null` if the file cannot be read

Response:

```json
{
  "symbolId": "sym_49a3e9f893f1d15e",
  "name": "buildPerQueryResult",
  "filePath": "/repo/src/eval/metrics.ts",
  "startLine": 218,
  "endLine": 266,
  "content": "actual source code here"
}
```

## `GET /api/mcp/neighborhood/:id?branch=<branch>&depth=<depth>`

MCP-facing wrapper around the neighborhood response.

The `graph` field is intentionally identical to `/api/neighborhood/:id`.

Response:

```json
{
  "schema": "hyperbase-graph-v1",
  "generatedAt": "2026-04-28T20:00:00.000Z",
  "query": {
    "symbolId": "sym_49a3e9f893f1d15e",
    "branch": "after-tune/refactor",
    "depth": 1
  },
  "graph": {
    "centerSymbolId": "sym_49a3e9f893f1d15e",
    "depth": 1,
    "truncated": false,
    "nodes": [],
    "edges": []
  }
}
```

## Notes for UI builders

- use `/api/graph/full` for the first render
- use `/api/search` to get symbol ids
- use `/api/neighborhood/:id` when the user drills into a symbol
- keep unresolved edges in your data model even if your concrete graph renderer skips them
- do not assume symbol names are unique
- always keep branch in client state
