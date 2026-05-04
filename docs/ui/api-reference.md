# API Reference

Base URL:

- `http://127.0.0.1:7842`

The UI calls these routes through [src/hyperbase/src/api/client.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/api/client.ts).

## Error shape

Every error response uses:

```json
{
  "error": "message",
  "code": "ERROR_CODE"
}
```

Codes currently in use include:

- `INVALID_INPUT`
- `BRANCH_NOT_FOUND`
- `NOT_FOUND`
- `DB_ERROR`
- `INTERNAL_ERROR`

## DB routes

### `GET /api/db/info`

Returns the currently loaded database metadata.

Loaded response:

```json
{
  "available": true,
  "dbPath": "/absolute/path/to/codebase.db",
  "branch": "after-tune/refactor",
  "branches": ["after-tune/refactor"],
  "symbolCount": 3262,
  "resolvedEdgeCount": 7651,
  "version": "0.1.0"
}
```

No-DB response:

```json
{
  "available": false,
  "dbPath": null,
  "branch": null,
  "branches": [],
  "symbolCount": 0,
  "resolvedEdgeCount": 0,
  "version": "0.1.0"
}
```

### `GET /api/db/demos`

Returns the server-side demo repo registry for the landing screen.

### `POST /api/db/select`

Switches the active DB to a server-known demo repo or configured server-side DB path.

### `POST /api/db/upload`

Accepts multipart upload of a `codebase.db` file and atomically swaps the active DB.

## General server routes

### `GET /api/health`

Returns health and currently loaded DB metadata.

### `GET /api/branches`

Returns:

```json
{
  "branches": ["after-tune/refactor"]
}
```

## Search and symbol detail

### `GET /api/search?q=<name>&branch=<branch>`

Case-insensitive substring search on symbol names.

Example result:

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

### `GET /api/symbol/:id?branch=<branch>`

Returns one symbol plus resolved caller/callee counts.

### `GET /api/peek/:symbolId?branch=<branch>`

Returns the code preview chunk used by the detail panel.

## Graph routes

### `GET /api/graph/overview?branch=<branch>`

Directory-first overview graph used by the `Folders` sidebar view.

Behavior:

- aggregates files into a readable directory/module-level graph
- chooses a directory granularity intended to stay human-readable
- nodes are semantic directory/module nodes

### `GET /api/graph/full?branch=<branch>`

File-level graph used by the `Files` sidebar view.

Response shape:

```json
{
  "nodes": [
    {
      "id": "file::/repo/src/indexer/index.ts",
      "filePath": "/repo/src/indexer/index.ts",
      "language": "typescript",
      "symbolCount": 48,
      "directory": "/repo/src/indexer",
      "entityType": "file"
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

### `GET /api/graph/symbols?branch=<branch>`

Full symbol graph used by the `Functions` sidebar view.

Behavior:

- returns all symbols for the branch
- returns all resolved call edges for the branch
- intended for hierarchical client-side seeding

### `GET /api/graph/directory?directory=<path>&branch=<branch>`

Directory/module view.

Behavior:

- shows internal files in the chosen directory
- shows external files at the periphery
- distinguishes internal vs external edges

### `GET /api/graph/file?file=<path>&branch=<branch>`

File-symbol view.

Behavior:

- returns symbols contained in a file
- returns edges among those symbols plus relevant boundary context when applicable

## Symbol graph routes

### `GET /api/neighborhood/:id?branch=<branch>&depth=<1|2|3>`

Neighborhood graph around a selected symbol.

Rules:

- default depth: `1`
- max depth: `3`
- node cap: `300`
- unresolved edges are preserved as `to: null`

### `GET /api/blast-radius/:id?branch=<branch>`

Downstream dependency BFS used by the blast view.

Rules:

- follows resolved downstream relationships
- node cap: `500`
- returns per-node blast depth

### `GET /api/path?from=<id>&to=<id>&branch=<branch>`

Shortest resolved path between two symbols.

Behavior:

- batches frontier expansion by hop
- returns `found` / `exhausted` state plus path nodes and edges

## MCP route

### `GET /api/mcp/neighborhood/:id?branch=<branch>&depth=<1|2|3>`

MCP-friendly wrapper around neighborhood graph data.
