import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Indexer, type IndexStats } from "./indexer/index.js";
import { SEARCH_TASK_TYPES } from "./indexer/search-recipes.js";
import type { ParsedCodebaseIndexConfig, LogLevel } from "./config/schema.js";
import { formatCoverageReport, formatDefinitionLookup, formatExpandedContext, formatStatus as formatToolStatus } from "./tools/utils.js";
import { formatCostEstimate } from "./utils/cost.js";
import type { LogEntry } from "./utils/logger.js";

const MAX_CONTENT_LINES = 30;

function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

function formatIndexStats(stats: IndexStats, verbose: boolean = false): string {
  const lines: string[] = [];

  if (stats.indexedChunks === 0 && stats.removedChunks === 0) {
    lines.push(`Indexed. ${stats.totalFiles} files processed, ${stats.existingChunks} code chunks already up to date.`);
  } else if (stats.indexedChunks === 0) {
    lines.push(`Indexed. ${stats.totalFiles} files, removed ${stats.removedChunks} stale chunks, ${stats.existingChunks} chunks remain.`);
  } else {
    let main = `Indexed. ${stats.totalFiles} files processed, ${stats.indexedChunks} new chunks embedded.`;
    if (stats.existingChunks > 0) {
      main += ` ${stats.existingChunks} unchanged chunks skipped.`;
    }
    lines.push(main);

    if (stats.removedChunks > 0) {
      lines.push(`Removed ${stats.removedChunks} stale chunks.`);
    }

    if (stats.failedChunks > 0) {
      lines.push(`Failed: ${stats.failedChunks} chunks.`);
    }

    lines.push(`Tokens: ${stats.tokensUsed.toLocaleString()}, Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
  }

  if (verbose) {
    if (stats.skippedFiles.length > 0) {
      const tooLarge = stats.skippedFiles.filter(f => f.reason === "too_large");
      const excluded = stats.skippedFiles.filter(f => f.reason === "excluded");
      const gitignored = stats.skippedFiles.filter(f => f.reason === "gitignore");

      lines.push("");
      lines.push(`Skipped files: ${stats.skippedFiles.length}`);
      if (tooLarge.length > 0) {
        lines.push(`  Too large (${tooLarge.length}): ${tooLarge.slice(0, 5).map(f => f.path).join(", ")}${tooLarge.length > 5 ? "..." : ""}`);
      }
      if (excluded.length > 0) {
        lines.push(`  Excluded (${excluded.length}): ${excluded.slice(0, 5).map(f => f.path).join(", ")}${excluded.length > 5 ? "..." : ""}`);
      }
      if (gitignored.length > 0) {
        lines.push(`  Gitignored (${gitignored.length}): ${gitignored.slice(0, 5).map(f => f.path).join(", ")}${gitignored.length > 5 ? "..." : ""}`);
      }
    }

    if (stats.parseFailures.length > 0) {
      lines.push("");
      lines.push(`Files with no extractable chunks (${stats.parseFailures.length}): ${stats.parseFailures.slice(0, 10).join(", ")}${stats.parseFailures.length > 10 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

const CHUNK_TYPE_ENUM = [
  "function", "class", "method", "interface", "type",
  "enum", "struct", "impl", "trait", "module", "constant", "other",
] as const;
const TASK_TYPE_ENUM = [...SEARCH_TASK_TYPES] as [typeof SEARCH_TASK_TYPES[number], ...typeof SEARCH_TASK_TYPES[number][]];
const CHUNK_KIND_FILTER_ENUM = ["code", "test", "doc", "config"] as const;

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = Number.parseInt(decoded, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function createMcpServer(projectRoot: string, config: ParsedCodebaseIndexConfig): McpServer {
  const server = new McpServer({
    name: "opencode-codebase-index",
    version: "0.5.1",
  });

  const indexer = new Indexer(projectRoot, config);
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (!initialized) {
      await indexer.initialize();
      initialized = true;
    }
  }

  // --- Tools ---

  server.registerTool(
    "codebase_search",
    {
      description:
        "Search codebase by MEANING, not keywords. Returns full code content. For just finding WHERE code is (saves ~90% tokens), use codebase_peek instead.",
      inputSchema: {
        query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
        limit: z.number().optional().default(5).describe("Maximum number of results to return"),
        fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
        directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
        chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
        contextLines: z.number().optional().describe("Number of extra lines to include before/after each match (default: 0)"),
        taskType: z.enum(TASK_TYPE_ENUM).optional().describe("Retrieval recipe to apply (default: general)"),
        graphDepth: z.number().optional().describe("Optional call-graph expansion depth (0-2, default: 0)"),
        filters: z.object({
          chunk_type: z.enum(CHUNK_KIND_FILTER_ENUM).optional().describe("Restrict to chunks of this kind."),
          path_glob: z.string().optional().describe("Glob pattern for file paths, e.g. 'src/**/*.ts'."),
          language: z.string().optional().describe("Restrict to one language, e.g. 'typescript', 'rust'."),
        }).optional().describe("Optional filters to narrow scope."),
        include_scores: z.boolean().optional().default(false).describe("If true, include lane and reranker score per result."),
        cursor: z.string().optional().describe("Pagination cursor from a previous response."),
      },
      outputSchema: {
        results: z.array(z.object({
          file_path: z.string(),
          start_line: z.number(),
          end_line: z.number(),
          content: z.string(),
          chunk_type: z.string(),
          chunk_kind: z.string().nullable().optional(),
          name: z.string().nullable().optional(),
          lane: z.enum(["bm25", "semantic", "hybrid"]),
          reranker_score: z.number().nullable(),
        })),
        cursor: z.string().nullable(),
      },
    },
    async (args) => {
      await ensureInitialized();

      const pageSize = args.limit ?? 5;
      const offset = decodeCursor(args.cursor);
      const requestedLimit = Math.max(pageSize, offset + pageSize);
      const graphDepth = args.graphDepth ?? 0;
      const response = await indexer.searchDetailed(args.query, requestedLimit, {
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        chunkKind: args.filters?.chunk_type,
        language: args.filters?.language,
        pathGlob: args.filters?.path_glob,
        contextLines: args.contextLines,
        taskType: args.taskType,
        graphDepth,
      });

      if (response.primaryResults.length === 0 || offset >= response.primaryResults.length) {
        return {
          content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }],
          structuredContent: {
            results: [],
            cursor: null,
          },
        };
      }

      const pagedResults = response.primaryResults.slice(offset, offset + pageSize);
      const nextOffset = offset + pagedResults.length;
      const cursor = nextOffset < response.primaryResults.length ? encodeCursor(nextOffset) : null;
      const formatted = pagedResults.map((r, idx) => {
        const relationPrefix = r.relation ? `${r.relation} depth=${r.depth ?? 1} ` : "";
        const provenance = r.viaSymbol ? ` via ${r.viaSymbol}` : "";
        const header = r.name
          ? `[${offset + idx + 1}] ${relationPrefix}${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}${provenance}`
          : `[${offset + idx + 1}] ${relationPrefix}${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}${provenance}`;
        return `${header} (score: ${r.score.toFixed(2)})\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
      });

      const primary = `Found ${response.primaryResults.length} results for "${args.query}":\n\n${formatted.join("\n\n")}`;
      const expanded = formatExpandedContext(response.expandedContext);
      return {
        content: [{ type: "text", text: expanded.length > 0 ? `${primary}\n\n${expanded}` : primary }],
        structuredContent: {
          results: pagedResults.map((result) => ({
            file_path: result.filePath,
            start_line: result.startLine,
            end_line: result.endLine,
            content: result.content,
            chunk_type: result.chunkType,
            chunk_kind: result.chunkKind ? result.chunkKind.toLowerCase() : null,
            name: result.name ?? null,
            lane: result.lane ?? "hybrid",
            reranker_score: args.include_scores ? (result.rerankerScore ?? null) : null,
          })),
          cursor,
        },
      };
    },
  );

  server.tool(
    "codebase_peek",
    "Quick lookup of code locations by meaning. Returns only metadata (file, line, name, type) WITHOUT code content. Saves ~90% tokens vs codebase_search.",
    {
      query: z.string().describe("Natural language description of what code you're looking for."),
      limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
      taskType: z.enum(TASK_TYPE_ENUM).optional().describe("Retrieval recipe to apply (default: general)"),
      graphDepth: z.number().optional().describe("Optional call-graph expansion depth (0-2, default: 0)"),
    },
    async (args) => {
      await ensureInitialized();
      const response = args.graphDepth && args.graphDepth > 0
        ? await indexer.searchDetailed(args.query, args.limit ?? 10, {
            fileType: args.fileType,
            directory: args.directory,
            chunkType: args.chunkType,
            metadataOnly: true,
            taskType: args.taskType,
            graphDepth: args.graphDepth,
          })
        : {
            primaryResults: await indexer.search(args.query, args.limit ?? 10, {
              fileType: args.fileType,
              directory: args.directory,
              chunkType: args.chunkType,
              metadataOnly: true,
              taskType: args.taskType,
            }),
            expandedContext: [],
          };

      if (response.primaryResults.length === 0) {
        return { content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }] };
      }

      const formatted = response.primaryResults.map((r, idx) => {
        const relationPrefix = r.relation ? `${r.relation} depth=${r.depth ?? 1} ` : "";
        const provenance = r.viaSymbol ? ` via ${r.viaSymbol}` : "";
        const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
        const name = r.name ? `"${r.name}"` : "(anonymous)";
        return `[${idx + 1}] ${relationPrefix}${r.chunkType} ${name} at ${location}${provenance} (score: ${r.score.toFixed(2)})`;
      });

      const primary = `Found ${response.primaryResults.length} locations for "${args.query}":\n\n${formatted.join("\n")}\n\nUse Read tool to examine specific files.`;
      const expanded = formatExpandedContext(response.expandedContext, true);
      return { content: [{ type: "text", text: expanded.length > 0 ? `${primary}\n\n${expanded}` : primary }] };
    },
  );

  server.tool(
    "index_codebase",
    "Index the codebase for semantic search. Creates vector embeddings of code chunks. Incremental - only re-indexes changed files. Run before first codebase_search.",
    {
      force: z.boolean().optional().default(false).describe("Force reindex even if already indexed"),
      estimateOnly: z.boolean().optional().default(false).describe("Only show cost estimate without indexing"),
      verbose: z.boolean().optional().default(false).describe("Show detailed info about skipped files and parsing failures"),
    },
    async (args) => {
      await ensureInitialized();

      if (args.estimateOnly) {
        const estimate = await indexer.estimateCost();
        return { content: [{ type: "text", text: formatCostEstimate(estimate) }] };
      }

      if (args.force) {
        await indexer.clearIndex();
      }

      const stats = await indexer.index();
      return { content: [{ type: "text", text: formatIndexStats(stats, args.verbose ?? false) }] };
    },
  );

  server.tool(
    "index_status",
    "Check the status of the codebase index. Shows whether the codebase is indexed, how many chunks are stored, and the embedding provider being used.",
    {},
    async () => {
      await ensureInitialized();
      const status = await indexer.getStatus();
      return { content: [{ type: "text", text: formatToolStatus(status) }] };
    },
  );

  server.tool(
    "index_coverage",
    "Show durable index coverage limits, including files truncated by the per-file chunk cap and the named symbols currently invisible to retrieval.",
    {},
    async () => {
      await ensureInitialized();
      const report = await indexer.getCoverageReport();
      return { content: [{ type: "text", text: formatCoverageReport(report) }] };
    },
  );

  server.tool(
    "index_health_check",
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
    {},
    async () => {
      await ensureInitialized();
      const result = await indexer.healthCheck();

      if (result.removed === 0 && result.gcOrphanEmbeddings === 0 && result.gcOrphanChunks === 0 && result.gcOrphanSymbols === 0 && result.gcOrphanCallEdges === 0) {
        return { content: [{ type: "text", text: "Index is healthy. No stale entries found." }] };
      }

      const lines = [`Health check complete:`];

      if (result.removed > 0) {
        lines.push(`  Removed stale entries: ${result.removed}`);
      }

      if (result.gcOrphanEmbeddings > 0) {
        lines.push(`  Garbage collected orphan embeddings: ${result.gcOrphanEmbeddings}`);
      }

      if (result.gcOrphanChunks > 0) {
        lines.push(`  Garbage collected orphan chunks: ${result.gcOrphanChunks}`);
      }

      if (result.gcOrphanSymbols > 0) {
        lines.push(`  Garbage collected orphan symbols: ${result.gcOrphanSymbols}`);
      }

      if (result.gcOrphanCallEdges > 0) {
        lines.push(`  Garbage collected orphan call edges: ${result.gcOrphanCallEdges}`);
      }

      if (result.filePaths.length > 0) {
        lines.push(`  Cleaned paths: ${result.filePaths.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "index_metrics",
    "Get metrics and performance statistics for the codebase index. Requires debug.enabled=true and debug.metrics=true in config.",
    {},
    async () => {
      await ensureInitialized();
      const logger = indexer.getLogger();

      if (!logger.isEnabled()) {
        return { content: [{ type: "text", text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```" }] };
      }

      if (!logger.isMetricsEnabled()) {
        return { content: [{ type: "text", text: "Metrics collection is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```" }] };
      }

      return { content: [{ type: "text", text: logger.formatMetrics() }] };
    },
  );

  server.tool(
    "index_logs",
    "Get recent debug logs from the codebase indexer. Requires debug.enabled=true in config.",
    {
      limit: z.number().optional().default(20).describe("Maximum number of log entries to return"),
      category: z.enum(["search", "embedding", "cache", "gc", "branch", "general"]).optional().describe("Filter by log category"),
      level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Filter by minimum log level"),
    },
    async (args) => {
      await ensureInitialized();
      const logger = indexer.getLogger();

      if (!logger.isEnabled()) {
        return { content: [{ type: "text", text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true\n  }\n}\n```" }] };
      }

      let logs: LogEntry[];
      if (args.category) {
        logs = logger.getLogsByCategory(args.category, args.limit);
      } else if (args.level) {
        logs = logger.getLogsByLevel(args.level as LogLevel, args.limit);
      } else {
        logs = logger.getLogs(args.limit);
      }

      if (logs.length === 0) {
        return { content: [{ type: "text", text: "No logs recorded yet. Logs are captured during indexing and search operations." }] };
      }

      const text = logs.map(l => {
        const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
        return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${dataStr}`;
      }).join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "find_similar",
    "Find code similar to a given snippet. Use for duplicate detection, pattern discovery, or refactoring prep.",
    {
      code: z.string().describe("The code snippet to find similar code for"),
      limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: z.enum(CHUNK_TYPE_ENUM).optional().describe("Filter by code chunk type"),
      excludeFile: z.string().optional().describe("Exclude results from this file path"),
    },
    async (args) => {
      await ensureInitialized();
      const results = await indexer.findSimilar(args.code, args.limit ?? 10, {
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        excludeFile: args.excludeFile,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No similar code found. Try a different snippet or run index_codebase first." }] };
      }

      const formatted = results.map((r, idx) => {
        const header = r.name
          ? `[${idx + 1}] ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}-${r.endLine}`
          : `[${idx + 1}] ${r.chunkType} in ${r.filePath}:${r.startLine}-${r.endLine}`;
        return `${header} (similarity: ${(r.score * 100).toFixed(1)}%)\n\`\`\`\n${truncateContent(r.content)}\n\`\`\``;
      });

      return { content: [{ type: "text", text: `Found ${results.length} similar code blocks:\n\n${formatted.join("\n\n")}` }] };
    },
  );

  server.tool(
    "implementation_lookup",
    "Jump to symbol definition. Find WHERE something is defined. Returns the authoritative source location(s). Prefers real implementation files over tests, docs, examples, and fixtures.",
    {
      query: z.string().describe("Symbol name or natural language description (e.g., 'validateToken', 'where is the payment handler defined')"),
      limit: z.number().optional().default(5).describe("Maximum number of results"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py')"),
      directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils')"),
      taskType: z.enum(TASK_TYPE_ENUM).optional().describe("Retrieval recipe to apply (default: definition)"),
      graphDepth: z.number().optional().describe("Optional call-graph expansion depth (0-2, default: 0)"),
    },
    async (args) => {
      await ensureInitialized();
      const response = args.graphDepth && args.graphDepth > 0
        ? await indexer.searchDetailed(args.query, args.limit ?? 5, {
            fileType: args.fileType,
            directory: args.directory,
            definitionIntent: true,
            taskType: args.taskType ?? "definition",
            graphDepth: args.graphDepth,
          })
        : {
            primaryResults: await indexer.search(args.query, args.limit ?? 5, {
              fileType: args.fileType,
              directory: args.directory,
              definitionIntent: true,
              taskType: args.taskType ?? "definition",
            }),
            expandedContext: [],
          };

      const primary = formatDefinitionLookup(response.primaryResults, args.query);
      const expanded = formatExpandedContext(response.expandedContext);
      return { content: [{ type: "text", text: expanded.length > 0 ? `${primary}\n\n${expanded}` : primary }] };
    },
  );

  server.tool(
    "call_graph",
    "Query the call graph to find callers or callees of a function/method. Use to understand code flow and dependencies.",
    {
      name: z.string().describe("Function or method name to query"),
      direction: z.enum(["callers", "callees"]).default("callers").describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
      symbolId: z.string().optional().describe("Symbol ID (required for 'callees' direction)"),
    },
    async (args) => {
      await ensureInitialized();
      if (args.direction === "callees") {
        if (!args.symbolId) {
          return { content: [{ type: "text", text: "Error: 'symbolId' is required when direction is 'callees'." }] };
        }
        const callees = await indexer.getCallees(args.symbolId);
        if (callees.length === 0) {
          return { content: [{ type: "text", text: `No callees found for symbol ${args.symbolId}.` }] };
        }
        const formatted = callees.map((e, i) =>
          `[${i + 1}] \u2192 ${e.targetName} (${e.callType}) at line ${e.line}${e.isResolved ? ` [resolved: ${e.toSymbolId}]` : " [unresolved]"}`
        );
        return { content: [{ type: "text", text: `Callees (${callees.length}):\n\n${formatted.join("\n")}` }] };
      }
      const callers = await indexer.getCallers(args.name);
      if (callers.length === 0) {
        return { content: [{ type: "text", text: `No callers found for "${args.name}".` }] };
      }
      const formatted = callers.map((e, i) =>
        `[${i + 1}] \u2190 from ${e.fromSymbolName ?? "<unknown>"} in ${e.fromSymbolFilePath ?? "<unknown file>"} [${e.fromSymbolId}] (${e.callType}) at line ${e.line}${e.isResolved ? " [resolved]" : " [unresolved]"}`
      );
      return { content: [{ type: "text", text: `"${args.name}" is called by ${callers.length} function(s):\n\n${formatted.join("\n")}` }] };
    },
  );

  server.tool(
    "symbol_info",
    "Return the indexed identity card for a symbol, including stable symbol id, file location, kind, signature, and chunk classification.",
    {
      symbol: z.string().describe("Symbol name to look up. Simple name or fully-qualified name."),
      file_path: z.string().optional().describe("Optional relative file path to disambiguate duplicate symbol names."),
    },
    async (args) => {
      await ensureInitialized();
      const result = await indexer.getSymbolInfo(args.symbol, args.file_path);
      const text = result.total === 0
        ? `No symbol named '${args.symbol}' found in the current branch.`
        : result.ambiguous
          ? `Found ${result.total} symbols named '${args.symbol}'. Provide file_path to disambiguate.`
          : `Symbol: ${result.symbols[0]?.name ?? args.symbol} (${result.symbols[0]?.kind ?? "unknown"}) at ${result.symbols[0]?.relativePath ?? "<unknown>"}:${result.symbols[0]?.startLine ?? 0}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          symbols: result.symbols.map((symbol) => ({
            symbol_id: symbol.symbolId,
            name: symbol.name,
            kind: symbol.kind,
            file_uri: symbol.fileUri,
            relative_path: symbol.relativePath,
            start_line: symbol.startLine,
            end_line: symbol.endLine,
            signature: symbol.signature,
            chunk_kind: symbol.chunkKind,
          })),
          total: result.total,
          ambiguous: result.ambiguous,
        },
      };
    },
  );

  server.tool(
    "callers",
    "List functions that call a given symbol. Use this for impact analysis and dependency tracing.",
    {
      symbol: z.string().describe("Function or method name to find callers of."),
      file_path: z.string().optional().describe("Optional relative file path to disambiguate duplicate symbol names."),
      include_tests: z.boolean().optional().default(true).describe("If false, exclude test callers from results."),
      max_results: z.number().int().min(1).max(100).optional().default(20).describe("Maximum callers to return."),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous response."),
    },
    async (args) => {
      await ensureInitialized();
      const result = await indexer.getStructuralCallers({
        symbol: args.symbol,
        filePath: args.file_path,
        includeTests: args.include_tests,
        maxResults: args.max_results,
        cursor: args.cursor,
      });
      const text = result.total === 0
        ? `No callers found for '${args.symbol}' in the current branch.`
        : `Found ${result.total} callers of '${args.symbol}'.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          callers: result.callers.map((caller) => ({
            symbol_name: caller.symbolName,
            file_uri: caller.fileUri,
            relative_path: caller.relativePath,
            line: caller.line,
            chunk_kind: caller.chunkKind,
          })),
          total: result.total,
          cursor: result.cursor,
          resolved: result.resolved,
        },
      };
    },
  );

  server.tool(
    "callees",
    "List symbols invoked by a given function or method, including unresolved graph edges.",
    {
      symbol: z.string().describe("Function or method name to find callees of."),
      file_path: z.string().optional().describe("Optional relative file path to disambiguate duplicate symbol names."),
      max_results: z.number().int().min(1).max(100).optional().default(20).describe("Maximum callees to return."),
    },
    async (args) => {
      await ensureInitialized();
      const result = await indexer.getStructuralCallees({
        symbol: args.symbol,
        filePath: args.file_path,
        maxResults: args.max_results,
      });
      const unresolvedCount = result.callees.filter((entry) => !entry.resolved).length;
      const text = result.total === 0
        ? `No callees found for '${args.symbol}' in the current branch.`
        : `Found ${result.total} callees of '${args.symbol}' (${unresolvedCount} unresolved).`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          callees: result.callees.map((callee) => ({
            symbol_name: callee.symbolName,
            file_uri: callee.fileUri,
            relative_path: callee.relativePath,
            line: callee.line,
            resolved: callee.resolved,
          })),
          total: result.total,
          resolved: result.resolved,
        },
      };
    },
  );

  server.tool(
    "call_chain",
    "Find the shortest call path between two symbols using the resolved call graph.",
    {
      from_symbol: z.string().describe("Starting function or method name."),
      to_symbol: z.string().describe("Target function or method name."),
      from_file: z.string().optional().describe("Optional file path to disambiguate from_symbol."),
      to_file: z.string().optional().describe("Optional file path to disambiguate to_symbol."),
      max_depth: z.number().int().min(1).max(15).optional().default(8).describe("Maximum hop depth before giving up."),
    },
    async (args) => {
      await ensureInitialized();
      const result = await indexer.getStructuralCallChain({
        fromSymbol: args.from_symbol,
        toSymbol: args.to_symbol,
        fromFile: args.from_file,
        toFile: args.to_file,
        maxDepth: args.max_depth,
      });
      const text = result.found
        ? `Call path from '${args.from_symbol}' to '${args.to_symbol}': ${result.depth} hops.`
        : `No call path found from '${args.from_symbol}' to '${args.to_symbol}' within depth ${args.max_depth}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          found: result.found,
          path: result.path.map((entry) => ({
            symbol_name: entry.symbolName,
            file_uri: entry.fileUri,
            relative_path: entry.relativePath,
            line: entry.line,
          })),
          depth: result.depth,
          search_depth_reached: result.searchDepthReached,
          warning: result.warning,
        },
      };
    },
  );

  server.tool(
    "tests_for",
    "Find test functions that cover a given symbol or file using call-graph and naming heuristics.",
    {
      symbol: z.string().optional().describe("Function or method name to find tests for."),
      file_path: z.string().optional().describe("Source file path. If provided without symbol, returns tests covering any symbol in this file."),
    },
    async (args) => {
      await ensureInitialized();
      if (!args.symbol && !args.file_path) {
        return {
          isError: true,
          content: [{ type: "text", text: "At least one of 'symbol' or 'file_path' is required." }],
        };
      }

      const result = await indexer.getStructuralTests({
        symbol: args.symbol,
        filePath: args.file_path,
      });
      const callGraphCount = result.tests.filter((entry) => entry.method === "call_graph").length;
      const namingCount = result.tests.filter((entry) => entry.method === "name_convention").length;
      const label = args.symbol ?? args.file_path ?? "target";
      const text = `Found ${result.total} tests covering '${label}' (${callGraphCount} via call graph, ${namingCount} via naming).`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          tests: result.tests.map((entry) => ({
            test_name: entry.testName,
            file_uri: entry.fileUri,
            relative_path: entry.relativePath,
            line: entry.line,
            confidence: entry.confidence,
            method: entry.method,
          })),
          total: result.total,
          symbol_resolved: result.symbolResolved,
        },
      };
    },
  );

  // --- Prompts ---

  server.prompt(
    "search",
    "Search codebase by meaning using semantic search",
    { query: z.string().describe("What to search for in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Search the codebase for: "${args.query}"\n\nUse the codebase_search tool with this query. If you need just locations first, use codebase_peek instead to save tokens.`,
        },
      }],
    }),
  );

  server.prompt(
    "find",
    "Find code using hybrid approach (semantic + grep)",
    { query: z.string().describe("What to find in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find code related to: "${args.query}"\n\nUse a hybrid approach:\n1. First use codebase_peek to find semantic matches by meaning\n2. Then use grep for exact identifier matches\n3. Combine results for comprehensive coverage`,
        },
      }],
    }),
  );

  server.prompt(
    "index",
    "Index the codebase for semantic search",
    { options: z.string().optional().describe("Options: 'force' to rebuild, 'estimate' to check costs") },
    (args) => {
      const opts = args.options?.toLowerCase() ?? "";
      let instruction = "Use the index_codebase tool to index the codebase for semantic search.";
      if (opts.includes("force")) {
        instruction = "Use the index_codebase tool with force=true to rebuild the entire index from scratch.";
      } else if (opts.includes("estimate")) {
        instruction = "Use the index_codebase tool with estimateOnly=true to check the cost estimate before indexing.";
      }
      return {
        messages: [{
          role: "user",
          content: { type: "text", text: instruction },
        }],
      };
    },
  );

  server.prompt(
    "status",
    "Check if the codebase is indexed and ready",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Use the index_status tool to check if the codebase index is ready and show its current state.",
        },
      }],
    }),
  );

  server.prompt(
    "definition",
    "Find where a symbol is defined in the codebase",
    { query: z.string().describe("Symbol name or description to find the definition of") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find the definition of: "${args.query}"\n\nUse the implementation_lookup tool to find where this symbol is defined. This prioritizes real implementation files over tests, docs, and examples. If no definition is found, fall back to codebase_search for broader discovery.`,
        },
      }],
    }),
  );

  return server;
}
