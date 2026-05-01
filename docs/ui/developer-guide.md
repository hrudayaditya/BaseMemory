# Developer Guide

This guide is for changing HyperBase without getting lost in stale assumptions.

## Commands

From the repo root:

```bash
npm run graph
npm run hyperbase:build
npm run test:run
```

For frontend-only iteration:

```bash
cd src/hyperbase
npm run dev
npm run check
```

Useful focused suites:

```bash
npx vitest run tests/graph-server.test.ts tests/graph-server-integration.test.ts
npx vitest run tests/hyperbase-graph-views.test.ts
```

## What runs where

Server:

- [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- [src/graph-server/queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- [src/graph-server/assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)
- [src/graph-server/types.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/types.ts)

Browser UI:

- [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)
- [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)
- [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)
- [src/hyperbase/src/components](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components)
- [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)

Shared browser infrastructure:

- [src/hyperbase/src/api/client.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/api/client.ts)
- [src/hyperbase/src/lib/graph-utils.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/graph-utils.ts)
- [src/hyperbase/src/lib/layout-cache.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/layout-cache.ts)
- [src/hyperbase/src/lib/url-state.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/url-state.ts)
- [src/hyperbase/src/lib/sigma-config.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/sigma-config.ts)

## Current startup model

HyperBase now supports three startup paths:

1. convenience local DB via `npm run graph`
2. landing-screen upload in the browser
3. landing-screen demo repo selection

The server is no longer “one DB forever.”

`createGraphServer(...)` now owns a mutable runtime DB state and supports:

- `GET /api/db/info`
- `GET /api/db/demos`
- `POST /api/db/upload`
- `POST /api/db/select`

In-flight requests keep their captured DB snapshot while a new DB is swapped in.

## Current graph controller structure

The authoritative loading module is the `GraphController` in [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts).

It owns:

- DB/bootstrap state
- graph loads
- request cancellation
- graph identity
- layout-running and settled-node state
- graph error/loading/truncation state
- current payload/view metadata

Components should not fetch graphs directly.

Use exported controller commands instead:

- `initializeGraph(...)`
- `loadOverviewGraph(...)`
- `loadGalaxyGraph(...)`
- `loadFullSymbolGraph(...)`
- `loadNeighborhoodGraph(...)`
- `loadDirectoryGraph(...)`
- `loadFileGraph(...)`
- `loadBlastRadiusGraph(...)`
- `loadPathGraph(...)`
- `changeActiveBranch(...)`
- `changeGraphDepth(...)`
- `retryGraphLoad()`
- `setGraphOverlay(...)`
- `selectDemoGraph(...)`
- `uploadDatabaseGraph(...)`

## Current view model

There are three top-level sidebar views:

- `overview` → shown in the UI as `Folders`
- `galaxy` → shown in the UI as `Files`
- `full-symbol` → shown in the UI as `Functions`

And several drill-in modes:

- `directory`
- `file`
- `neighborhood`
- `blast-radius`
- `path`

Keep this distinction clear when you add features. `Folders / Files / Functions` are not just overlays; they are separate graph loads with separate payloads and content ids.

## Graph identity

HyperBase still uses two identities:

- `graphContentId`
- `graphLoadId`

`graphContentId` is deterministic and drives:

- seeded positions
- layout cache restore/save
- cross-reload spatial stability

`graphLoadId` is monotonic and drives:

- worker restart semantics
- stale result rejection

If you add a new graph kind, extend the content-id builder. Do not try to bypass it.

## Layout system

Important current behavior:

1. Graph builders assign seeded positions first.
2. The graph is committed immediately so Sigma can render without a blank screen.
3. The worker then refines the layout.
4. On cache hit, the worker is skipped.

For large function graphs:

- full-symbol view uses hierarchical seeding
- files are placed on a ring
- symbols cluster around their file anchor
- ForceAtlas2 is skipped above the configured threshold

Current tuning lives in:

- [src/hyperbase/src/lib/constants.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/constants.ts)

## Search model

Search is now view-aware.

In `Functions`:

- selecting a result keeps the current full-symbol graph
- camera flies to the symbol
- detail panel opens in place

In other views:

- selecting a symbol still loads its neighborhood graph

If you change search behavior, keep that distinction intact.

## Sidebar model

The left sidebar is now primary navigation.

File:

- [src/hyperbase/src/components/controls/ViewSidebar.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/controls/ViewSidebar.svelte)

It owns:

- `Folders / Files / Functions`
- current graph stats
- branch selector
- codebase switching UI

Do not add the branch selector back to the control bar.

## Rendering model

Files:

- [src/hyperbase/src/components/canvas/GraphCanvas.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/canvas/GraphCanvas.svelte)
- [src/hyperbase/src/lib/sigma-config.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/sigma-config.ts)

Current rendering rules:

- Sigma instance lifecycle lives in `GraphCanvas`
- render reducers read a snapshot, not live graph mutation on every hover
- function view uses label and edge LOD
- cinematic search focus and blast animations are renderer concerns

## Tests

Use both layers:

- route/behavior tests: [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)
- real HTTP tests: [tests/graph-server-integration.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server-integration.test.ts)

And use the graph-view tests when you touch builders or renderer expectations:

- [tests/hyperbase-graph-views.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/hyperbase-graph-views.test.ts)

## Safe extension rules

If you add a new graph representation:

1. add a new `GraphLoadTarget` variant
2. add a payload type
3. add a content-id builder
4. add a controller command
5. add URL-state behavior if the view is shareable
6. add tests for both the server payload and the graph builder if applicable

If you add a new DB-side capability:

1. add SQL to the query layer
2. add shaping in the assembly layer
3. keep the route thin
4. document it in [docs/ui/api-reference.md](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md)
