import cors from "cors";
import Database from "better-sqlite3";
import express, { type Request, type Response } from "express";
import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  buildBlastRadiusGraph,
  buildDirectoryGraph,
  buildFullGraph,
  buildNeighborhoodGraph,
  buildShortestPath,
  MAX_NEIGHBORHOOD_DEPTH,
} from "./graph-server/assembly.js";
import { createGraphQueries } from "./graph-server/queries.js";
import {
  type ErrorCode,
  type GraphServerInstance,
  type GraphServerOptions,
  type GraphSymbolRow,
} from "./graph-server/types.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_PORT = 7842;
const DEFAULT_DB_PATH = ".opencode/index/codebase.db";
const DEFAULT_HOST = "127.0.0.1";

function sendError(res: Response, status: number, code: ErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

function parseInteger(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFileLines(filePath: string, startLine: number, endLine: number): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const start = Math.max(1, startLine) - 1;
    const end = Math.max(start, endLine);
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}

function isSqliteError(error: unknown): error is Error {
  return error instanceof Error && "code" in error;
}

function parseArgs(argv: string[]): GraphServerOptions {
  let dbPath = DEFAULT_DB_PATH;
  let branch: string | undefined;
  let port = DEFAULT_PORT;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db" && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg === "--branch" && argv[i + 1]) {
      branch = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
      }
    }
  }

  return { dbPath, branch, port };
}

export function createGraphServer(options: GraphServerOptions): GraphServerInstance {
  const db = new Database(options.dbPath, { readonly: true });
  const queries = createGraphQueries(db);
  const branches = queries.listBranches();

  if (branches.length === 0) {
    throw new Error(`No branches found in DB: ${options.dbPath}`);
  }

  const defaultBranch = options.branch ?? branches[0];
  if (!branches.includes(defaultBranch)) {
    throw new Error(`Unknown branch: ${defaultBranch}`);
  }

  const branchSet = new Set(branches);
  const app = express();
  const server = createServer(app);
  const port = options.port ?? DEFAULT_PORT;
  const graphUiDir = join(dirname(fileURLToPath(import.meta.url)), "hyperbase", "dist");

  app.use(cors());
  app.use(express.json());
  app.use("/", express.static(graphUiDir));

  function resolveBranch(branchQuery: unknown): string | null {
    if (typeof branchQuery !== "string" || branchQuery.length === 0) {
      return defaultBranch;
    }
    return branchSet.has(branchQuery) ? branchQuery : null;
  }

  function withBranch(
    req: Request,
    res: Response,
    handler: (branch: string) => void
  ): void {
    const branch = resolveBranch(req.query.branch);
    if (!branch) {
      sendError(res, 400, "BRANCH_NOT_FOUND", `Unknown branch: ${String(req.query.branch)}`);
      return;
    }

    try {
      handler(branch);
    } catch (error) {
      if (isSqliteError(error)) {
        sendError(res, 500, "DB_ERROR", error.message);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, "INTERNAL_ERROR", message);
    }
  }

  function getSymbolOr404(branch: string, symbolId: string, res: Response): GraphSymbolRow | null {
    const symbol = queries.getSymbolById(branch, symbolId);
    if (!symbol) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${symbolId}`);
      return null;
    }
    return symbol;
  }

  app.get("/api/health", (req, res) => withBranch(req, res, (branch) => {
    res.json({
      status: "ok",
      dbPath: options.dbPath,
      branch,
      symbolCount: queries.getSymbolCount(branch),
      resolvedEdgeCount: queries.getResolvedEdgeCount(branch),
      version: SERVER_VERSION,
    });
  }));

  app.get("/api/branches", (req, res) => withBranch(req, res, () => {
    res.json({ branches });
  }));

  app.get("/api/search", (req, res) => withBranch(req, res, (branch) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameter: q");
      return;
    }

    const results = queries.searchSymbols(branch, q).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
    }));

    res.json({ results });
  }));

  app.get("/api/symbol/:id", (req, res) => withBranch(req, res, (branch) => {
    const symbol = getSymbolOr404(branch, req.params.id, res);
    if (!symbol) {
      return;
    }

    res.json({
      symbol: {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.file_path,
        language: symbol.language,
        startLine: symbol.start_line,
        endLine: symbol.end_line,
        callerCount: queries.getCallerCount(branch, symbol.id),
        calleeCount: queries.getCalleeCount(branch, symbol.id),
      },
    });
  }));

  app.get("/api/neighborhood/:id", (req, res) => withBranch(req, res, (branch) => {
    const depth = parseInteger(req.query.depth) ?? 1;
    if (depth < 1 || depth > MAX_NEIGHBORHOOD_DEPTH) {
      sendError(res, 400, "INVALID_INPUT", "depth must be between 1 and 3");
      return;
    }

    const neighborhood = buildNeighborhoodGraph(queries, branch, req.params.id, depth);
    if (!neighborhood) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json(neighborhood);
  }));

  app.get("/api/graph/directory", (req, res) => withBranch(req, res, (branch) => {
    const directoryPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!directoryPath) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameter: path");
      return;
    }

    const directoryGraph = buildDirectoryGraph(queries, branch, directoryPath);
    if (!directoryGraph) {
      sendError(res, 404, "NOT_FOUND", `Unknown directory: ${directoryPath}`);
      return;
    }

    res.json(directoryGraph);
  }));

  app.get("/api/graph/full", (req, res) => withBranch(req, res, (branch) => {
    res.json(buildFullGraph(queries, branch));
  }));

  app.get("/api/blast-radius/:id", (req, res) => withBranch(req, res, (branch) => {
    const blast = buildBlastRadiusGraph(queries, branch, req.params.id);
    if (!blast) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json(blast);
  }));

  app.get("/api/path", (req, res) => withBranch(req, res, (branch) => {
    const fromId = typeof req.query.from === "string" ? req.query.from : "";
    const toId = typeof req.query.to === "string" ? req.query.to : "";
    if (!fromId || !toId) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameters: from and to");
      return;
    }

    const pathResponse = buildShortestPath(queries, branch, fromId, toId);
    if (pathResponse === "NOT_FOUND") {
      sendError(res, 404, "NOT_FOUND", "One or both symbols do not exist");
      return;
    }

    res.json(pathResponse);
  }));

  app.get("/api/peek/:symbolId", (req, res) => withBranch(req, res, (branch) => {
    const row = queries.getPeekSymbolAndChunk(branch, req.params.symbolId);
    if (!row) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.symbolId}`);
      return;
    }

    const startLine = row.chunk_start_line ?? row.start_line;
    const endLine = row.chunk_end_line ?? row.end_line;
    const content = readFileLines(row.file_path, startLine, endLine);

    res.json({
      symbolId: row.id,
      name: row.name,
      filePath: row.file_path,
      startLine,
      endLine,
      content,
    });
  }));

  /**
   * MCP Extensibility Hook — hyperbase-graph-v1
   *
   * This endpoint exposes the canonical graph JSON schema for HyperBase.
   * The future `visualize_subgraph` MCP tool will return this same shape,
   * allowing agents to receive and reason about graph data programmatically
   * using the same data the UI renders.
   *
   * Schema: hyperbase-graph-v1
   * Consumers: HyperBase UI, future MCP tool `visualize_subgraph`
   */
  app.get("/api/mcp/neighborhood/:id", (req, res) => withBranch(req, res, (branch) => {
    const depth = parseInteger(req.query.depth) ?? 1;
    if (depth < 1 || depth > MAX_NEIGHBORHOOD_DEPTH) {
      sendError(res, 400, "INVALID_INPUT", "depth must be between 1 and 3");
      return;
    }

    const neighborhood = buildNeighborhoodGraph(queries, branch, req.params.id, depth);
    if (!neighborhood) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json({
      schema: "hyperbase-graph-v1",
      generatedAt: new Date().toISOString(),
      query: {
        symbolId: req.params.id,
        branch,
        depth,
      },
      graph: neighborhood,
    });
  }));

  return {
    app,
    server,
    db,
    defaultBranch,
    dbPath: options.dbPath,
    port,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, DEFAULT_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          db.close();
          resolve();
          return;
        }
        server.close((error) => {
          db.close();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function startGraphServer(options: GraphServerOptions): Promise<GraphServerInstance> {
  const instance = createGraphServer(options);
  await instance.start();
  return instance;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const instance = await startGraphServer(args);
  const symbolCount = instance.db.prepare(
    "SELECT COUNT(*) AS c FROM branch_symbols WHERE branch = ?"
  ).get(instance.defaultBranch) as { c: number };
  const resolvedEdgeCount = instance.db.prepare(
    "SELECT COUNT(*) AS c FROM call_edges WHERE branch = ? AND is_resolved = 1"
  ).get(instance.defaultBranch) as { c: number };

  console.log("╔════════════════════════════════════════╗");
  console.log("║     HyperBase Graph Server v0.1        ║");
  console.log(`║     http://localhost:${instance.port.toString().padEnd(20, " ")}║`);
  console.log("╚════════════════════════════════════════╝");
  console.log(
    `Symbols: ${symbolCount.c} | Resolved edges: ${resolvedEdgeCount.c} | Branch: ${instance.defaultBranch}`
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
