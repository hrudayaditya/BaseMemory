# HyperBase — World-Class Codebase Graph Explorer

---

## The Core Insight

The best graph visualization tools fail codebases because they treat code as a generic graph. HyperBase treats it as what it actually is: **a living system of dependencies, ownership, and intent**. Every design decision follows from that.

---

## Mental Model

Three zoom levels, seamlessly connected:

**Galaxy view** — the entire codebase as a universe. Directories are star clusters. Files are stars. Brightness = connectivity. You see the shape of the system instantly.

**Solar system view** — zoom into a directory. Files become planets. Call edges between files become orbital paths. You see module boundaries and coupling.

**Atom view** — zoom into a file. Symbols become particles. Call edges within and across files become bonds. You see the actual dependency graph.

No mode switching. Just zoom. The camera determines what level of detail you see.

---

## Tech Stack (revised, genuinely best-in-class)

**Renderer:** `Sigma.js v3` + `WebGL` — purpose-built for large graph rendering in the browser. Handles 50,000+ nodes at 60fps. Not Three.js (3D is wrong for this — code is not spatial in 3D, it creates false depth perception that obscures structure). 2D with extreme zoom range is the right model. Figma, Observable, and every serious graph tool uses 2D WebGL.

**Layout engine:** `Graphology` + `graphology-layout-forceatlas2` running in a **Web Worker** — ForceAtlas2 is the algorithm used by Gephi, the gold standard for software architecture visualization. Runs off main thread so UI stays responsive during layout.

**Frontend framework:** `Svelte 5` — smallest bundle, fastest reactivity, no virtual DOM overhead. Single HTML file output after build. Vite for the build step (fast enough that Claude Code won't notice it).

**Backend:** `Express` + `better-sqlite3` — same as before, unchanged.

**Why not Three.js:** 3D force graphs look impressive in demos and are painful in practice. Depth perception makes it hard to follow edges. Orbit controls fight with graph navigation. Every serious codebase visualization tool (Sourcegraph, CodeScene, Understand) uses 2D. We use 2D WebGL with extreme zoom range instead.

---

## Features — Complete List

### Navigation & Exploration

**Semantic zoom** — three continuous zoom levels with smooth LOD transitions:
- Zoomed out: directory clusters with aggregate labels, edge bundles between clusters
- Mid zoom: file nodes appear, inter-file edges visible
- Zoomed in: individual symbol nodes, all edges, code preview on hover

**Galaxy entry point** — on load, show the full codebase layout immediately. No search required. Users see the shape of the system before they know what to look for. Most-connected nodes are larger and brighter. This is the single most important feature for interns and new team members.

**Semantic search** — top-center search bar. Searches symbol names AND natural language (proxies to BaseMemory's `codebase_search` MCP tool). Results highlight matching nodes on the graph and pan camera to them.

**Breadcrumb trail** — every node you visit is recorded. Back/forward navigation. Shareable URLs that encode exact camera position + selected node + depth.

**Minimap** — bottom-right corner. Always shows full galaxy view. Red dot = current camera position. Click to teleport.

---

### Understanding Code Structure

**Ownership layers** — toggle overlay that colors nodes by directory/module. Immediately shows which parts of the codebase belong together vs. which are tangled across modules. Critical for handoffs.

**Coupling heatmap** — toggle that colors edges by cross-module coupling intensity. Red edges = high coupling between modules that shouldn't be coupled. Green = healthy dependencies. Instant architecture smell detector.

**Blast radius** — click any node, press R. Highlights every node that would be affected if this symbol changed. Color gradient: direct dependents red, second-degree orange, third-degree yellow. Essential for interns making their first change.

**Dead code detector** — toggle that dims nodes with zero incoming resolved edges (nothing calls them). Instant dead code visibility.

**Hotspot view** — toggle that sizes nodes by degree (connection count). The most-connected symbols in the codebase become immediately obvious. Shows new team members where the critical path is.

**Dependency path finder** — click node A, shift-click node B, press P. Draws the shortest call path between them. Highlights every intermediate node. Shows the chain of calls between any two symbols.

**Cluster detection** — automatic community detection (Louvain algorithm via `graphology-communities-louvain`). Groups strongly-connected symbols into communities with colored halos. Shows natural module boundaries that may differ from file structure.

---

### Team Collaboration Features

**Team territory overlay** — import a simple JSON config mapping file paths to team names. Colors nodes by owning team. Cross-team edges highlighted in amber. Instantly shows coupling between teams. Critical for multi-team handoffs.

```json
{
  "teams": {
    "indexing": ["src/indexer/**"],
    "native": ["native/src/**"],
    "eval": ["src/eval/**"]
  }
}
```

**Annotation layer** — right-click any node → add a sticky note. Notes persist in localStorage. Exportable as JSON. Team members can import each other's annotation sets. Interns can annotate what they learn as they explore.

**Focus mode** — select a set of nodes (lasso select with shift-drag), press F. Everything outside the selection dims to 10% opacity. The selected subgraph fills the viewport. Share the URL and your teammate sees the same focused view.

**"Explain this" panel** — click any node, click "Explain". Calls BaseMemory's `codebase_search` and `codebase_peek` MCP tools to fetch the actual code and a semantic summary. Shows the chunk content alongside its graph position. New team members can read code in context without leaving the visualization.

**Handoff report** — select a directory or cluster, click "Generate Handoff". Produces a markdown report listing: all symbols in the selection, their callers from outside the selection (the interface), their callees outside the selection (the dependencies), and any unresolved edges (external dependencies). Downloadable. Paste into a PR or wiki page.

---

### Developer Power Features

**Symbol timeline** — if git history awareness is added later, this slot is reserved. Nodes pulse when recently modified. Slider scrubs through time showing how the graph evolved.

**Search with regex** — search bar accepts `/pattern/` syntax. All matching nodes highlight simultaneously. Find all functions named `*Handler` or all files in `*/tests/*` instantly.

**Edge type filter** — toggle visibility of: resolved calls only / unresolved calls / cross-file only / same-file only / by call_type. Clean up the view to focus on what matters.

**Language filter** — multi-repo support means mixed languages. Filter to show only Rust nodes, only TypeScript nodes, or cross-language edges only.

**Export** — export current view as SVG (for documentation), PNG (for presentations), or JSON (for programmatic use / MCP tool compatibility).

**Keyboard shortcuts** — full keyboard navigation. `G` = galaxy view, `F` = focus mode, `R` = blast radius, `P` = path finder, `Escape` = deselect, `Space` = reset camera, `/` = search.

---

### Performance Architecture

**Progressive loading** — galaxy view loads file-level graph first (fast, small). Symbol-level detail loads on demand as you zoom in. Never load 3,262 symbols upfront.

**Web Worker layout** — ForceAtlas2 runs in a dedicated worker. Main thread stays at 60fps during layout. Layout streams positions back to main thread incrementally.

**Instanced rendering** — Sigma.js uses WebGL instancing. All nodes of the same kind share one draw call. 3,262 nodes = ~8 draw calls total.

**Viewport culling** — only nodes in the current viewport are processed for interaction. Off-screen nodes exist in the graph data but not in the render pipeline.

---

## Information Architecture

```
HyperBase
├── Galaxy View (full codebase)
│   ├── Directory clusters
│   ├── File nodes
│   └── Cross-file edge bundles
├── Focus View (selected subgraph)
│   ├── Symbol nodes
│   ├── All edges
│   └── Code preview panel
├── Overlays (toggleable)
│   ├── Ownership (by team/directory)
│   ├── Coupling heatmap
│   ├── Blast radius
│   ├── Dead code
│   ├── Hotspots
│   └── Cluster communities
└── Panels
    ├── Search (top center)
    ├── Controls (top right)
    ├── Detail (right sidebar, slides in)
    ├── Minimap (bottom right)
    └── Breadcrumb (bottom center)
```

---

## Build Phases

### Phase 1 — Backend + data layer (4-6 hours)
`src/graph-server.ts` with all endpoints. Same as before plus:
- `GET /api/graph/full?branch=<b>` — file-level graph only (nodes = files, edges = cross-file call edges aggregated). Fast to load, used for galaxy view.
- `GET /api/graph/directory/:path?branch=<b>` — all symbols in a directory + their edges
- `GET /api/graph/neighborhood/:id?depth=<n>&branch=<b>` — symbol neighborhood
- `GET /api/graph/path?from=<id>&to=<id>&branch=<b>` — shortest path
- `GET /api/graph/blast-radius/:id?branch=<b>` — all downstream dependents BFS
- `GET /api/search?q=<q>&branch=<b>` — symbol search
- `GET /api/peek/:chunkId` — fetch chunk content for "Explain this" panel

### Phase 2 — Galaxy view (1 day)
Full codebase file-level graph. ForceAtlas2 layout in Web Worker. Sigma.js rendering. Directory clustering with colored halos. Semantic zoom skeleton (zoom levels trigger LOD switches). Minimap. Basic search.

### Phase 3 — Symbol detail + interactions (1 day)
Zoom into symbol level. Node click → detail panel. Blast radius. Path finder. Focus mode. Keyboard shortcuts. URL state.

### Phase 4 — Overlays + team features (1 day)
Ownership overlay. Coupling heatmap. Dead code. Hotspots. Cluster detection. Team territory config. Annotation layer. Handoff report generator.

### Phase 5 — Polish + MCP hook (4-6 hours)
Smooth camera animations. Edge bundling for dense graphs. Export (SVG/PNG/JSON). MCP-compatible `/api/mcp/neighborhood` endpoint with canonical JSON schema. Performance profiling pass.

**Total: 4-5 days for something genuinely world-class.**

---

## What Makes This The Best In The World

Most codebase visualization tools make you search first. HyperBase shows you the whole system first and lets you drill in. That's the difference between a map and a search engine. New team members need the map.

Most graph tools are static. HyperBase overlays meaning — ownership, coupling, blast radius, dead code — on top of structure. That's the difference between seeing edges and understanding what they mean.

Most tools are for individuals. HyperBase has team territory, annotations, focus mode sharing, and handoff reports built in. That's the difference between a dev tool and a collaboration tool.
