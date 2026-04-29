# Getting Started

## Open HyperBase

From the BaseMemory repo root:

```bash
npm run graph
```

Open:

- [http://127.0.0.1:7842](http://127.0.0.1:7842)

The graph server serves the built HyperBase UI from `src/hyperbase/dist`.
If you changed the UI and have not rebuilt it yet:

```bash
npm run hyperbase:build
```

Then run `npm run graph` again.

## What you see first

The first screen is the galaxy view:

- one node per file
- one edge per aggregated cross-file resolved call relationship
- branch selector
- depth controls
- overlay controls
- search bar
- minimap
- detail panel on the right

This view is meant for orientation. Search is how you move from file-level structure to symbol-level structure.

## Find a symbol

Use the search bar at the top.

Type a symbol name like `buildPerQueryResult`.
Pick one result.

That loads a symbol neighborhood:

- the selected symbol becomes the center
- direct callers and callees appear around it
- the detail panel opens
- the URL hash updates so the view is linkable

Example URL after loading a symbol:

```text
#branch=after-tune/refactor&symbol=sym_49a3e9f893f1d15e&depth=1&view=atom
```

## Use the detail panel

When a symbol is selected, the right panel shows:

- name
- kind
- full file path
- line range
- language
- caller count
- callee count
- code preview from the smallest containing chunk

Actions:

- `Set as center` reloads the neighborhood around that symbol
- `Open in editor` opens a `vscode://file/...` link

If you click a file node in galaxy view, the panel still opens, but symbol-specific API data is only available for symbol nodes.

## What the overlays mean

Current overlay behavior:

- `None`: default node colors
- `Community`: Louvain communities computed off the main thread and cached on the graph load
- `Degree`: UI toggle exists but does not apply a visual transform yet
- `Language`: UI toggle exists but does not apply a visual transform yet

Only `Community` is implemented visually today.

## What the minimap does

The minimap is a real projection of the Sigma graph state:

- dots show the full graph
- the rectangle shows the current viewport
- clicking the minimap moves the main camera to that graph region

The minimap now uses Sigma’s graph/framed-graph/viewport transforms instead of guessed arithmetic.

## Why the graph stops moving after the first load

HyperBase persists completed layouts in `localStorage`.

For the same graph content:

- reloads restore the same layout
- a second tab with the same URL shows the same layout
- the worker is skipped on exact layout cache hits

That is intentional. It preserves spatial memory.

## Useful API shortcuts

Health:

- [http://127.0.0.1:7842/api/health](http://127.0.0.1:7842/api/health)

Search:

- [http://127.0.0.1:7842/api/search?q=buildPerQueryResult](http://127.0.0.1:7842/api/search?q=buildPerQueryResult)

File graph:

- [http://127.0.0.1:7842/api/graph/full](http://127.0.0.1:7842/api/graph/full)

Neighborhood:

- [http://127.0.0.1:7842/api/neighborhood/sym_49a3e9f893f1d15e?depth=1](http://127.0.0.1:7842/api/neighborhood/sym_49a3e9f893f1d15e?depth=1)

Blast radius:

- [http://127.0.0.1:7842/api/blast-radius/sym_49a3e9f893f1d15e](http://127.0.0.1:7842/api/blast-radius/sym_49a3e9f893f1d15e)

Code preview:

- [http://127.0.0.1:7842/api/peek/sym_49a3e9f893f1d15e](http://127.0.0.1:7842/api/peek/sym_49a3e9f893f1d15e)

## Development mode

If you are changing the UI:

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

The Vite dev server proxies `/api` requests to `http://127.0.0.1:7842`.
