# Getting Started

This guide is the fastest way to get HyperBase running and understand what you are looking at.

## Prerequisites

- Node `18+`
- Rust/Cargo for the native module build
- an indexed `codebase.db`, or use the built-in demo repos

If you have not installed dependencies yet:

```bash
npm install
cd src/hyperbase && npm install
```

## Fastest way to run HyperBase

From the repo root:

```bash
npm run graph
```

Open:

- [http://127.0.0.1:7842](http://127.0.0.1:7842)

What happens:

- the graph server starts
- the built HyperBase UI is served from `src/hyperbase/dist`
- if a local `.opencode/index/codebase.db` exists, HyperBase can start from that DB
- if no DB is loaded, you get the landing screen

## Development mode

If you are changing the UI, run the backend and frontend separately.

Terminal 1:

```bash
npm run graph
```

Terminal 2:

```bash
cd src/hyperbase
npm run dev
```

Open:

- [http://127.0.0.1:5173](http://127.0.0.1:5173)

In dev mode:

- Vite serves the Svelte UI
- `/api/*` requests still go to the graph server on `:7842`

## If the UI looks stale

Rebuild the production UI:

```bash
npm run hyperbase:build
```

That writes the static app into:

- [src/hyperbase/dist](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/hyperbase/dist)

## First-run flow

When HyperBase opens with no DB loaded, you land on a startup screen with:

- a drag-and-drop zone for `codebase.db`
- a file-picker fallback
- demo repo cards such as `tRPC` and `BaseMemory`

You have three ways to start:

1. Click a demo repo card.
2. Upload a `codebase.db` file from the landing screen.
3. Start the server directly against a DB from the command line.

Example direct server run:

```bash
npx tsx src/graph-server.ts \
  --db /absolute/path/to/.opencode/index/codebase.db \
  --port 7843
```

Then open:

- [http://127.0.0.1:7843](http://127.0.0.1:7843)

## What you see first

The default graph is now the **Folders** view, not the old file-level galaxy.

This overview:

- groups the repo into a readable directory-level graph
- is designed to stay in the `8-25` node range when possible
- is the best starting point for understanding codebase shape

The left sidebar is your primary navigation:

- `Folders`: directory-level overview
- `Files`: file-level graph
- `Functions`: full symbol graph across the codebase

The right side controls include:

- depth buttons for neighborhood queries
- overlays
- current node/edge counts
- export and handoff actions

## Recommended first demo flow

If you want to understand the app in under a minute:

1. Open the landing screen.
2. Click `tRPC`.
3. Stay in `Folders` to see the high-level codebase shape.
4. Switch to `Files`.
5. Switch to `Functions`.
6. Search for a symbol such as `createTRPCClient`.
7. Press `Enter` to fly to it and open the detail panel.
8. Click `Blast Radius`.

## Search behavior

The search bar works differently depending on the current view:

- in `Folders` or `Files`, selecting a symbol loads its neighborhood graph
- in `Functions`, selecting a symbol stays in the full-symbol graph and flies the camera to that node

This is intentional. The `Functions` view is search-first.

## Other important views

HyperBase now has more than one “symbol graph” mode:

- `atom` neighborhood view: a selected symbol plus its local caller/callee graph
- `blast` view: downstream impact by depth
- `path` view: shortest resolved path between two symbols
- `directory` view: files within a directory, plus external files at the periphery
- `file` atom view: symbols inside a single file

## Useful shortcuts

- `/`: focus search
- `?`: open shortcut help
- `Escape`: close transient UI
- `G`: go back to the overview/file graph path
- `R`: open blast radius for the selected symbol
- `P`: start path-finding mode
- `F`: toggle focus mode

## Health checks

DB info:

- [http://127.0.0.1:7842/api/db/info](http://127.0.0.1:7842/api/db/info)

Server health:

- [http://127.0.0.1:7842/api/health](http://127.0.0.1:7842/api/health)

Overview graph:

- [http://127.0.0.1:7842/api/graph/overview](http://127.0.0.1:7842/api/graph/overview)

File graph:

- [http://127.0.0.1:7842/api/graph/full](http://127.0.0.1:7842/api/graph/full)

Full symbol graph:

- [http://127.0.0.1:7842/api/graph/symbols](http://127.0.0.1:7842/api/graph/symbols)

## Common problems

### The app opens but I only see the landing screen

That means no active DB is loaded. Either:

- click a demo repo
- upload a `codebase.db`
- or restart the server with `--db /path/to/codebase.db`

### The app loads but the UI looks outdated

Rebuild the production frontend:

```bash
npm run hyperbase:build
```

### I changed UI code but nothing updates on `:7842`

That is expected. `:7842` serves the built UI. Use:

- `http://127.0.0.1:5173` for hot reload

### I uploaded a wrong file

HyperBase should show a human-readable error:

`This file doesn't look like a HyperBase index. Make sure to select a .opencode/index/codebase.db file.`
