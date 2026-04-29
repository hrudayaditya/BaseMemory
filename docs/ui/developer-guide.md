# Developer Guide

## Commands

Start the graph server:

```bash
npm run graph
```

Build the browser UI:

```bash
npm run hyperbase:build
```

Run the full test suite:

```bash
npm run test:run
```

Run the route-focused suite:

```bash
npx vitest run tests/graph-server.test.ts tests/graph-server-integration.test.ts
```

Run the UI in dev mode:

```bash
cd src/hyperbase
npm run dev
```

## What runs where

Server:

- [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- [src/graph-server/queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- [src/graph-server/assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)
- [src/graph-server/types.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/types.ts)

UI:

- [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)
- [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)
- [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)
- [src/hyperbase/src/components](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components)
- [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)

Shared browser-side infrastructure:

- [src/hyperbase/src/api/client.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/api/client.ts)
- [src/hyperbase/src/lib/graph-utils.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/graph-utils.ts)
- [src/hyperbase/src/lib/layout-cache.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/layout-cache.ts)
- [src/hyperbase/src/lib/theme.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/theme.ts)
- [src/hyperbase/src/lib/url-state.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/url-state.ts)

Launcher:

- [scripts/start-graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/scripts/start-graph.ts)

## Current server structure

The graph server is no longer a monolith.

Layer split:

- query layer: prepared SQLite statements and typed row-returning methods in [queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- graph assembly layer: BFS, node/edge shaping, truncation, unresolved-edge policy, and shortest-path logic in [assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)
- handler layer: Express routes, input validation, branch resolution, and JSON serialization in [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)

That boundary matters. If you add a new endpoint, keep SQL out of the handler and keep HTTP out of the assembly layer.

## Current UI structure

Graph loading is controller-owned.

The authoritative loading module is the `GraphController` class in [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts).

It owns:

- branch initialization
- graph loads
- cancellation of in-flight graph requests
- graph identity
- graph error/loading/truncation state
- community computation scheduling

Components do not fetch graph data directly.
They dispatch intent through exported controller functions:

- `initializeGraph(...)`
- `loadGalaxyGraph(...)`
- `loadNeighborhoodGraph(...)`
- `changeActiveBranch(...)`
- `changeGraphDepth(...)`
- `retryGraphLoad()`
- `setGraphOverlay(...)`

Detail loading is separate. It lives in [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts), which owns symbol detail and peek fetch cancellation.

## Graph identity

HyperBase uses two graph identities:

- `graphContentId`
- `graphLoadId`

`graphContentId` is deterministic. It is derived from:

- view kind
- branch
- neighborhood center + depth when relevant
- sorted node keys
- sorted edge keys

It is used for:

- deterministic layout seeding
- layout cache keys
- cross-reload and cross-tab layout stability

`graphLoadId` is a monotonic per-load revision.

It is used for:

- worker restart semantics
- ignoring stale worker/controller results tied to an older load

## Layout system

Initial positions are deterministic.

The seed boundary is the graph builder in [src/hyperbase/src/lib/graph-utils.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/graph-utils.ts).
The worker does not invent its own randomness anymore.

Layout flow:

1. controller computes `graphContentId`
2. graph builder assigns seeded node positions from that content id
3. `layout-cache.ts` checks `localStorage`
4. if a cached layout exists for `hyperbase:layout:v1:${graphContentId}`, positions are restored and the worker is skipped
5. otherwise the worker runs ForceAtlas2 from the deterministic seed positions
6. the worker posts deltas during layout and a full snapshot on `done`
7. the main thread persists the final snapshot

The layout cache is opportunistic. Corrupt or mismatched cache entries are discarded.

## Theme system

The token system is enforced at runtime now.

Tokens live in:

- [src/hyperbase/src/styles/tokens.css](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/styles/tokens.css)

Runtime theme loading lives in:

- [src/hyperbase/src/lib/theme.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/theme.ts)

Use the theme object for:

- Sigma colors
- canvas/minimap colors
- derived palette choices such as community colors

Do not add hardcoded color literals back into renderer or canvas code.

## Tests

There are now two server test layers.

Unit-style route and behavior tests:

- [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)

These still use in-process request/response mocking. They are fast and good for graph logic and route behavior.

Real HTTP integration tests:

- [tests/graph-server-integration.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server-integration.test.ts)

These:

- start a real Express server on an ephemeral port
- make real HTTP requests with `fetch`
- validate health, search, neighborhood, one error case, and the MCP wrapper
- parse responses using HyperBase’s TypeScript API types

In sandboxed environments that block `listen(2)`, these tests need to run outside the sandbox. Do not replace them with mocked requests just to make the environment quieter.

## Safe extension rules

If you add a new graph view or trigger:

1. add a controller command instead of fetching from a component
2. decide whether it needs a new `GraphLoadTarget` variant
3. extend `graphContentId` generation so identical content stays identical
4. keep the worker/cache behavior aligned with that content id
5. keep URL state in sync if the view should be shareable

If you add a new endpoint:

1. add SQL to the query layer
2. add graph shaping to the assembly layer if needed
3. keep the handler thin
4. add both a fast route test and a real HTTP integration test when the route is user-facing
5. update [api-reference.md](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md)

## Things that are intentionally not finished

- `Degree` and `Language` overlays have UI toggles but no visual transform yet
- `/api/graph/directory/:path` is still reserved, not implemented
- unresolved `to: null` edges are preserved in API responses but skipped by the concrete Graphology renderer

Those are current system facts, not future promises.
