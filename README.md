# BaseMemory Docs

This directory is the current documentation set for the codebase indexer.

Important: treat these docs as the source of truth for current behavior.

## Start Here

- [MCP Clients and Tool Guide](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/mcp-clients.md)
  - How to run the MCP server
  - Which clients are supported
  - What each tool does
  - When to use which tool
- [Developer Guide](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/developer-guide.md)
  - Local development setup
  - Build/test commands
  - Indexing and reindexing
  - Eval runs for BaseMemory and external repos
  - Config reference
  - Supported embedding providers and reranker backends

## Existing Deep Dives

- [Evaluation Harness](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/evaluation.md)
- [Cross-repo Benchmarking](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/benchmarking-cross-repo.md)
- [Adding Language Support](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/adding-language-support.md)
- [Incremental Index Orchestrator Handoff](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/incremental-index-orchestrator-handoff.md)

## Which Doc To Read

- You use Claude Code, Cursor, Windsurf, or another MCP client:
  - read [MCP Clients and Tool Guide](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/mcp-clients.md)
- You are changing code in this repo:
  - read [Developer Guide](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/developer-guide.md)
- You are tuning retrieval quality or running benchmark gates:
  - read [Evaluation Harness](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/evaluation.md)
- You are adding another parser/chunker/call-graph language:
  - read [Adding Language Support](/Users/aady/Desktop/OpenSourceContributions/BaseMemory/docs/adding-language-support.md)
