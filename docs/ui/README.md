# HyperBase

HyperBase is BaseMemory’s local codebase graph explorer.

What it does now:

- serves a real browser UI from the graph server
- opens on a file-level galaxy view without requiring search
- lets you search for symbols and load symbol neighborhoods
- shows symbol details, code preview, caller/callee counts, and blast-radius data
- keeps graph URLs shareable through `window.location.hash`
- reuses deterministic layouts for the same graph content across reloads and tabs

Start here:

- [Getting Started](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/getting-started.md>)
- [API Reference](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md>)
- [Architecture](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/architecture.md>)
- [Developer Guide](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/developer-guide.md>)

What exists in the repo:

- server entrypoint: [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- server query layer: [src/graph-server/queries.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/queries.ts)
- server graph assembly layer: [src/graph-server/assembly.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server/assembly.ts)
- launcher: [scripts/start-graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/scripts/start-graph.ts)
- browser UI: [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)
- graph controller: [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)
- selection/detail loader: [src/hyperbase/src/stores/selection.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/selection.ts)
- layout worker: [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)
- layout cache: [src/hyperbase/src/lib/layout-cache.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/lib/layout-cache.ts)
- unit-style route tests: [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)
- real HTTP integration tests: [tests/graph-server-integration.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server-integration.test.ts)

Defaults:

- graph server URL: `http://127.0.0.1:7842`
- Vite dev URL: `http://127.0.0.1:5173`
- DB path: `.opencode/index/codebase.db`
- branch: first branch found in the DB unless you override it

If you want to use HyperBase right now, go to the getting started guide.
If you want to change how it works, go to the architecture and developer docs.
