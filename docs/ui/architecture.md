# Architecture

## Server

The server is split into three layers.

### Query layer

Files:

- [src/graph-server/queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- [src/graph-server/types.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/types.ts)

Responsibilities:

- prepare SQLite statements once
- execute SQL
- return typed rows and counts

It does not:

- know about Express
- build JSON responses
- own BFS traversal rules

### Graph assembly layer

File:

- [src/graph-server/assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)

Responsibilities:

- neighborhood BFS
- blast-radius BFS
- full-graph aggregation
- shortest-path traversal
- truncation
- degree attachment
- unresolved-edge policy
- stable node/edge ordering

Important current behavior:

- unresolved neighborhood edges are returned with `to: null`
- shortest path batches frontier expansion per hop instead of querying per node

### Handler layer

File:

- [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)

Responsibilities:

- Express setup
- static file serving from `src/hyperbase/dist`
- branch resolution
- parameter validation
- error code mapping
- final JSON serialization

## Browser UI

### Root

Files:

- [src/hyperbase/src/main.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/main.ts)
- [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)

`main.ts` initializes the theme before mounting Svelte.

`App.svelte` is the root layout and startup coordinator. It mounts the canvas, controls, search, detail panel, and minimap, and kicks off initialization through the graph controller.

### Graph controller

File:

- [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)

This file is the central loading state machine in practice.

It owns:

- branch bootstrap
- graph request cancellation
- deterministic `graphContentId`
- per-load `graphLoadId`
- graph/truncation/loading/error stores
- overlay-triggered community computation

The controller exposes readable state through Svelte stores and intent commands through exported functions.

### Selection and detail loading

File:

- [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)

This file owns:

- selected node id
- hovered node id
- selected node data
- symbol detail fetch
- peek fetch
- aborting stale detail requests

That separation is intentional. Graph loading and detail loading are independent concerns.

## Graph identity and layout

### `graphContentId`

Purpose:

- stable identity for identical graph content

Used for:

- deterministic seeded initial positions
- `localStorage` key `hyperbase:layout:v1:${graphContentId}`
- cross-tab and cross-reload layout stability

### `graphLoadId`

Purpose:

- unique identity per load event

Used for:

- restarting the layout worker on every new graph load
- rejecting stale worker/controller results

### Worker protocol

File:

- [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)

Current messages:

- `start`
- `stop`
- `communities`
- `progress`
- `done`

Current behavior:

- layout runs off the main thread
- `progress` posts only positions that moved beyond the configured threshold
- `done` posts the full final position snapshot
- community detection also runs in the worker

### Layout cache

File:

- [src/hyperbase/src/lib/layout-cache.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/layout-cache.ts)

Save path:

- main thread saves the final `done` snapshot

Restore path:

- main thread checks cache before starting the worker
- exact cache hit applies positions directly and skips worker execution

## Rendering

### Sigma

Files:

- [src/hyperbase/src/components/canvas/GraphCanvas.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/canvas/GraphCanvas.svelte)
- [src/hyperbase/src/lib/sigma-config.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/sigma-config.ts)

Current rendering model:

- Sigma instance lifecycle lives in `GraphCanvas`
- hover and selection use a component-local render snapshot
- reducers read that snapshot during render
- graph attributes are not rewritten on every pointer event

### Minimap

File:

- [src/hyperbase/src/components/minimap/Minimap.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/minimap/Minimap.svelte)

Current behavior:

- uses Sigma’s public camera and transform APIs
- projects the full graph into minimap space
- draws the real viewport polygon
- converts minimap clicks back into the framed-graph camera coordinates Sigma expects

## Theme

Files:

- [src/hyperbase/src/styles/tokens.css](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/styles/tokens.css)
- [src/hyperbase/src/lib/theme.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/theme.ts)

Current behavior:

- CSS variables are the source of truth
- runtime code reads them into a typed theme object
- Sigma and canvas code use that object instead of hardcoded color literals

## Tests

### Fast route tests

File:

- [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)

These are fast and broad.

### Real HTTP integration tests

File:

- [tests/graph-server-integration.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server-integration.test.ts)

These cover the product surface:

- real port bind
- real `fetch`
- real JSON serialization
- real client type compatibility

That split is deliberate. Keep both layers.
