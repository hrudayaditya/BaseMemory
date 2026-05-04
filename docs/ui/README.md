# HyperBase

HyperBase is BaseMemory's local browser UI for exploring code as graphs.

It is no longer just a file-level galaxy viewer. The current product includes:

- a landing screen with upload + demo repo selection
- a directory-first overview
- file and function graph modes from a persistent sidebar
- neighborhood, blast radius, path, directory, and file-symbol views
- local annotations, handoff generation, and export actions

Start here:

- [Getting Started](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/getting-started.md>)
- [API Reference](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md>)
- [Architecture](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/architecture.md>)
- [Developer Guide](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/developer-guide.md>)

## Current product shape

The main UI flow is:

1. open HyperBase
2. choose or upload a database
3. start in `Folders`
4. move to `Files` or `Functions` from the sidebar
5. search for symbols
6. drill into neighborhood, blast, path, directory, or file-symbol views

## Main files

- server entrypoint: [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- server query layer: [src/graph-server/queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- server assembly layer: [src/graph-server/assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)
- graph controller: [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)
- selection/detail loader: [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)
- sidebar: [src/hyperbase/src/components/controls/ViewSidebar.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/controls/ViewSidebar.svelte)
- canvas: [src/hyperbase/src/components/canvas/GraphCanvas.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/canvas/GraphCanvas.svelte)
- worker: [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)

## Defaults

- graph server: `http://127.0.0.1:7842`
- Vite dev UI: `http://127.0.0.1:5173`
- default DB path when using the convenience launcher: `.opencode/index/codebase.db`

If you just want to get it running, use the getting started guide. If you want to change how it works, jump to the architecture and developer docs.
