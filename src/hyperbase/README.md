# HyperBase UI

HyperBase is BaseMemory's browser-based code graph explorer.

This app is a standalone Svelte + Vite frontend that talks to the graph server in the repo root. It is not a generic Vite template anymore.

## Run it locally

From the repo root:

```bash
npm run graph
```

That starts the graph server on:

- `http://127.0.0.1:7842`

If you want hot-reload UI development, start the Vite app in a second terminal:

```bash
cd src/hyperbase
npm run dev
```

That starts the frontend on:

- `http://127.0.0.1:5173`

In dev mode:

- Vite serves the Svelte app
- `/api/*` requests still go to the graph server on `:7842`

## Build the production UI

From the repo root:

```bash
npm run hyperbase:build
```

The build output is written to:

- [src/hyperbase/dist](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/dist)

The graph server serves that built UI directly when you open `http://127.0.0.1:7842`.

## What HyperBase does now

- shows a landing screen when no database is loaded
- lets you upload a `codebase.db` file directly in the browser
- ships demo repo switching for the investor flow
- opens into a directory-first overview by default
- supports three main graph modes from the sidebar:
  - `Folders`
  - `Files`
  - `Functions`
- supports neighborhood, blast radius, path, directory, and file-symbol views
- keeps graph state shareable through the URL hash
- persists deterministic layouts by graph content id

## Main UI entry points

- root app: [src/hyperbase/src/App.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/App.svelte)
- graph controller: [src/hyperbase/src/stores/graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/stores/graph.ts)
- graph canvas: [src/hyperbase/src/components/canvas/GraphCanvas.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/canvas/GraphCanvas.svelte)
- sidebar: [src/hyperbase/src/components/controls/ViewSidebar.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/controls/ViewSidebar.svelte)
- search: [src/hyperbase/src/components/search/SearchBar.svelte](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/components/search/SearchBar.svelte)
- layout worker: [src/hyperbase/src/workers/layout.worker.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/src/workers/layout.worker.ts)

## Useful commands

```bash
cd src/hyperbase
npm run check
npm run build
```

From repo root:

```bash
npm run hyperbase:build
npm run test:run
```
