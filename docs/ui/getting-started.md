# Getting Started

## Start HyperBase

From the BaseMemory repo root:

```bash
npm run graph
```

By default this:

- reads the graph DB from `.opencode/index/codebase.db`
- uses the first branch found in the DB
- starts the server on `127.0.0.1:7842`

Open:

- [http://127.0.0.1:7842](http://127.0.0.1:7842)

Right now the root page is a placeholder. The useful part today is the API.

## Check that it is alive

Open:

- [http://127.0.0.1:7842/api/health](http://127.0.0.1:7842/api/health)

You should see JSON like:

```json
{
  "status": "ok",
  "dbPath": "/absolute/path/to/.opencode/index/codebase.db",
  "branch": "after-tune/refactor",
  "symbolCount": 3262,
  "resolvedEdgeCount": 7651,
  "version": "0.1.0"
}
```

## Find a symbol

Search by name:

- [http://127.0.0.1:7842/api/search?q=buildPerQueryResult](http://127.0.0.1:7842/api/search?q=buildPerQueryResult)

This gives you symbol ids. You need those ids for the graph endpoints.

Example result shape:

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

## See a symbol’s local graph

Once you have a symbol id:

- [http://127.0.0.1:7842/api/neighborhood/sym_49a3e9f893f1d15e?depth=1](http://127.0.0.1:7842/api/neighborhood/sym_49a3e9f893f1d15e?depth=1)

What you get:

- `nodes`: the center symbol and its nearby symbols
- `edges`: resolved call edges, plus some unresolved edges when both endpoints are already in the node set
- `degree`: resolved degree only
- `truncated`: whether the server stopped expanding because the node cap was hit

Use `depth=1`, `depth=2`, or `depth=3`.

## See blast radius

This answers “what depends on this?”

- [http://127.0.0.1:7842/api/blast-radius/sym_49a3e9f893f1d15e](http://127.0.0.1:7842/api/blast-radius/sym_49a3e9f893f1d15e)

The response includes:

- `nodes`
- `edges`
- `depth`: distance from the center symbol

Direct dependents are depth `1`. Their callers are depth `2`, and so on.

## See the whole repo at file level

This is the Phase 1 galaxy view payload:

- [http://127.0.0.1:7842/api/graph/full](http://127.0.0.1:7842/api/graph/full)

What it contains:

- file nodes
- cross-file resolved call edges aggregated as `callCount`

This is the right starting point for a real UI because it is much smaller than the full symbol graph.

## Read the actual code for a symbol

Once you have a symbol id:

- [http://127.0.0.1:7842/api/peek/sym_49a3e9f893f1d15e](http://127.0.0.1:7842/api/peek/sym_49a3e9f893f1d15e)

This returns:

- symbol name
- file path
- line range
- source content from the smallest containing chunk

## Change branch, port, or DB path

Examples:

```bash
npm run graph -- --branch main
npm run graph -- --port 9000
npm run graph -- --db /absolute/path/to/codebase.db
```

If you pass a branch that does not exist in the DB, HyperBase returns:

```json
{
  "error": "Unknown branch: your-branch",
  "code": "BRANCH_NOT_FOUND"
}
```

## Best first workflow for a new team member

1. Open `/api/health` and confirm the branch and symbol count.
2. Search for a symbol or file you keep hearing about.
3. Open its `/api/neighborhood/:id?depth=1`.
4. Open `/api/blast-radius/:id` for “what breaks if I change this?”
5. Open `/api/peek/:id` to read the real code.
6. Open `/api/graph/full` if you need the file-level system map.

If you are building UI on top of this, go to the API reference next.
