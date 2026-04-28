# HyperBase

HyperBase is BaseMemory’s local graph explorer for understanding a codebase as a system.

It has two jobs:

- help a new person open a repo and understand what depends on what
- give developers a stable graph API they can extend without guessing how the database works

Start here:

- [Getting Started](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/getting-started.md>)
- [API Reference](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/api-reference.md>)
- [Developer Guide](</Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/ui/developer-guide.md>)

Current Phase 1 scope:

- local Express graph server
- file-level graph endpoint for galaxy view
- symbol neighborhood, blast radius, path, search, and peek endpoints
- MCP-compatible neighborhood JSON wrapper
- placeholder UI at `/`

What exists today:

- server entrypoint: [src/graph-server.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-server.ts)
- launcher: [scripts/start-graph.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/scripts/start-graph.ts)
- placeholder UI: [src/graph-ui/index.html](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/src/graph-ui/index.html)
- endpoint tests: [tests/graph-server.test.ts](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/tests/graph-server.test.ts)

Live defaults in the current BaseMemory repo:

- URL: `http://127.0.0.1:7842`
- DB path: `.opencode/index/codebase.db`
- branch: first branch found in the DB unless overridden

If you just want to use it, go to the getting started guide.
If you want to build on it, go to the developer guide.
