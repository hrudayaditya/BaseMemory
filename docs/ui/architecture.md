# Architecture

This document describes the current HyperBase product architecture after the Phase 4 UI work.

## Server

The server is still split into three layers.

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

- overview aggregation
- file graph assembly
- full-symbol graph assembly
- neighborhood BFS
- blast-radius BFS
- shortest-path traversal
- directory/file-symbol shaping
- truncation
- degree attachment
- stable node/edge ordering

Important current behavior:

- neighborhoods preserve unresolved edges as `to: null`
- path and neighborhood traversal batch frontier expansion by hop
- overview is directory-first and adapts granularity instead of exposing raw file counts immediately

### Handler layer

File:

- [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)

Responsibilities:

- Express setup
- static file serving from `src/hyperbase/dist`
- DB state bootstrap and runtime DB switching
- parameter validation
- branch resolution
- error mapping
- final JSON serialization

Important current behavior:

- route handlers capture an immutable DB snapshot at request start
- DB upload/select swaps the runtime DB atomically
- retired DB states are only closed after active requests complete

## Browser UI

### Root

Files:

- [src/hyperbase/src/main.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/main.ts)
- [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)

`main.ts` initializes theme state before mounting Svelte.

`App.svelte` is the root layout and startup coordinator. It mounts:

- landing screen
- sidebar
- canvas
- controls
- search
- detail panel
- minimap
- modals

### Graph controller

File:

- [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)

This file is the central loading state machine.

It owns:

- DB bootstrap state
- graph request cancellation
- deterministic `graphContentId`
- per-load `graphLoadId`
- current payload/view metadata
- graph/truncation/loading/error stores
- layout-running and settled-node stores
- overlay-triggered community computation

### Selection and detail loading

File:

- [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)

This file owns:

- selected node id
- hovered node id
- selected node data
- symbol detail fetch
- peek fetch
- stale-request cancellation
- clearing selection when the current graph no longer contains the selected node

That separation is intentional. Graph loading and detail loading are different concerns.

## View model

### Primary views

The sidebar exposes three top-level graph representations:

- `Folders` → `overview`
- `Files` → `galaxy`
- `Functions` → `full-symbol`

### Drill-in views

The app can then move into:

- `directory`
- `file`
- `atom` neighborhood
- `blast`
- `path`

These are separate graph loads, not camera-only transforms.

## Graph identity and layout

### `graphContentId`

Purpose:

- stable identity for identical graph content

Used for:

- deterministic seeded positions
- `localStorage` layout cache
- cross-reload and cross-tab layout stability

### `graphLoadId`

Purpose:

- unique identity per load event

Used for:

- restarting the layout worker on every new graph load
- rejecting stale worker/controller results

### Layout strategy by graph type

- overview: small directory-first graph, fast FA2 convergence
- files: file-level graph
- functions: hierarchical seed with optional FA2 skip above threshold
- atom/path/blast/directory/file: content-specific seeded layouts

The graph is committed before the worker refines it. Users should see seeded positions immediately, not a blank canvas waiting for layout completion.

## Worker protocol

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
- convergence can stop the worker early
- progress posts deltas rather than full maps where possible
- community detection also runs in the worker
- large full-symbol graphs can skip FA2 entirely

## Rendering

### Sigma

Files:

- [src/hyperbase/src/components/canvas/GraphCanvas.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/canvas/GraphCanvas.svelte)
- [src/hyperbase/src/lib/sigma-config.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/sigma-config.ts)

Current rendering model:

- Sigma lifecycle lives in `GraphCanvas`
- reducers read a render snapshot rather than mutating the graph on every pointer event
- function view uses label and edge LOD
- blast ripple and cinematic focus are renderer-side effects

### Minimap

File:

- [src/hyperbase/src/components/minimap/Minimap.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/minimap/Minimap.svelte)

Current behavior:

- uses Sigma transforms instead of guessed coordinate math
- renders the real viewport rectangle
- supports click-to-move navigation

## Theme

Files:

- [src/hyperbase/src/styles/tokens.css](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/styles/tokens.css)
- [src/hyperbase/src/lib/theme.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/theme.ts)

Current behavior:

- CSS variables are the source of truth
- runtime code reads them into a typed theme object
- renderer/canvas code uses the theme instead of hardcoded color literals

## Tests

### Fast route tests

File:

- [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)

### Real HTTP integration tests

File:

- [tests/graph-server-integration.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server-integration.test.ts)

These cover the product surface:

- real port bind
- real `fetch`
- real JSON serialization
- DB info / graph endpoints

### Graph-view tests

File:

- [tests/hyperbase-graph-views.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/hyperbase-graph-views.test.ts)

These validate:

- graph builders
- seeding behavior
- duplicate-edge collapse
- specialized view shaping

Keep both the server and client test layers. Do not replace them with one giant browser-only suite.
