import cors from "cors";
import Database from "better-sqlite3";
import express, { type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { createServer } from "http";
import { IncomingForm } from "formidable";
import { tmpdir } from "os";
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
  type GraphDbInfoResponse,
  type GraphDemoRepo,
  type GraphServerInstance,
  type GraphServerOptions,
  type GraphServerState,
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
  let dbPath: string | undefined = DEFAULT_DB_PATH;
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

function createLoadedState(dbPath: string, requestedBranch?: string): GraphServerState {
  const db = new Database(dbPath, { readonly: true });
  const queries = createGraphQueries(db);
  const branches = queries.listBranches();
  if (branches.length === 0) {
    db.close();
    throw new Error(`No branches found in DB: ${dbPath}`);
  }

  const defaultBranch = requestedBranch ?? branches[0];
  if (!branches.includes(defaultBranch)) {
    db.close();
    throw new Error(`Unknown branch: ${defaultBranch}`);
  }

  return {
    db,
    queries,
    branches,
    defaultBranch,
    dbPath,
    activeRequests: 0,
    retired: false,
  };
}

function createDbInfo(state: GraphServerState | null): GraphDbInfoResponse {
  if (!state) {
    return {
      available: false,
      dbPath: null,
      branch: null,
      symbolCount: 0,
      resolvedEdgeCount: 0,
      branches: [],
      version: SERVER_VERSION,
    };
  }

  return {
    available: true,
    dbPath: state.dbPath,
    branch: state.defaultBranch,
    symbolCount: state.queries.getSymbolCount(state.defaultBranch),
    resolvedEdgeCount: state.queries.getResolvedEdgeCount(state.defaultBranch),
    branches: state.branches,
    version: SERVER_VERSION,
  };
}

function buildDemoRegistry(repoRoot: string): GraphDemoRepo[] {
  return [
    {
      id: "trpc",
      name: "tRPC",
      language: "typescript",
      description: "A type-safe API layer for TypeScript",
      dbPath: join(repoRoot, "..", "trpc", ".opencode", "index", "codebase.db"),
    },
    {
      id: "basememory",
      name: "BaseMemory",
      language: "typescript",
      description: "The indexer powering HyperBase",
      dbPath: join(repoRoot, ".opencode", "index", "codebase.db"),
    },
  ];
}

export function createGraphServer(options: GraphServerOptions): GraphServerInstance {
  const app = express();
  const server = createServer(app);
  const port = options.port ?? DEFAULT_PORT;
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(sourceDir);
  const graphUiDir = join(sourceDir, "hyperbase", "dist");
  const uploadsDir = join(tmpdir(), "hyperbase-uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const demoRegistry = buildDemoRegistry(repoRoot);
  let currentState: GraphServerState | null = null;
  let switchInProgress = false;

  if (options.dbPath && existsSync(options.dbPath)) {
    currentState = createLoadedState(options.dbPath, options.branch);
  }

  app.use(cors());
  app.use(express.json());
  app.use("/", express.static(graphUiDir));

  function resolveBranch(state: GraphServerState, branchQuery: unknown): string | null {
    if (typeof branchQuery !== "string" || branchQuery.length === 0) {
      return state.defaultBranch;
    }
    return state.branches.includes(branchQuery) ? branchQuery : null;
  }

  function releaseState(state: GraphServerState): void {
    state.activeRequests -= 1;
    if (state.activeRequests <= 0 && state.retired) {
      state.db.close();
    }
  }

  function withState(
    _req: Request,
    res: Response,
    handler: (state: GraphServerState) => void
  ): void {
    const state = currentState;
    if (!state) {
      sendError(res, 503, "NO_DATABASE", "No database loaded. Upload or select a demo database to begin.");
      return;
    }

    state.activeRequests += 1;
    let released = false;
    const cleanup = () => {
      if (released) {
        return;
      }
      released = true;
      releaseState(state);
    };
    res.once("finish", cleanup);
    res.once("close", cleanup);

    try {
      handler(state);
    } catch (error) {
      if (isSqliteError(error)) {
        sendError(res, 500, "DB_ERROR", error.message);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
      cleanup();
    }
  }

  function withBranch(
    req: Request,
    res: Response,
    handler: (state: GraphServerState, branch: string) => void
  ): void {
    withState(req, res, (state) => {
      const branch = resolveBranch(state, req.query.branch);
      if (!branch) {
        sendError(res, 400, "BRANCH_NOT_FOUND", `Unknown branch: ${String(req.query.branch)}`);
        return;
      }
      handler(state, branch);
    });
  }

  function getSymbolOr404(state: GraphServerState, branch: string, symbolId: string, res: Response): GraphSymbolRow | null {
    const symbol = state.queries.getSymbolById(branch, symbolId);
    if (!symbol) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${symbolId}`);
      return null;
    }
    return symbol;
  }

  app.get("/api/health", (_req, res) => {
    const info = createDbInfo(currentState);
    res.json({
      status: "ok",
      dbPath: info.dbPath,
      branch: info.branch,
      symbolCount: info.symbolCount,
      resolvedEdgeCount: info.resolvedEdgeCount,
      version: SERVER_VERSION,
    });
  });

  app.get("/api/db/info", (_req, res) => {
    res.json(createDbInfo(currentState));
  });

  app.get("/api/db/demos", (_req, res) => {
    const demos = demoRegistry
      .filter((demo) => existsSync(demo.dbPath))
      .map((demo) => {
        const state = createLoadedState(demo.dbPath);
        const fileCount = state.queries.getFullGraphNodes(state.defaultBranch).length;
        const symbolCount = state.queries.getSymbolCount(state.defaultBranch);
        state.db.close();
        return {
          id: demo.id,
          name: demo.name,
          language: demo.language,
          description: demo.description,
          fileCount,
          symbolCount,
        };
      });
    res.json({ demos });
  });

  function swapState(nextState: GraphServerState): GraphDbInfoResponse {
    const previousState = currentState;
    currentState = nextState;
    if (previousState) {
      previousState.retired = true;
      if (previousState.activeRequests === 0) {
        previousState.db.close();
      }
    }
    return createDbInfo(nextState);
  }

  app.post("/api/db/select", (req, res) => {
    if (switchInProgress) {
      sendError(res, 409, "DB_SWITCH_IN_PROGRESS", "A database switch is already in progress.");
      return;
    }
    const demoId = typeof req.body?.demoId === "string" ? req.body.demoId : "";
    const demo = demoRegistry.find((entry) => entry.id === demoId && existsSync(entry.dbPath));
    if (!demo) {
      sendError(res, 404, "NOT_FOUND", `Unknown demo: ${demoId}`);
      return;
    }

    switchInProgress = true;
    try {
      const nextState = createLoadedState(demo.dbPath);
      res.json(swapState(nextState));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to switch database";
      sendError(res, 400, "INVALID_INPUT", message);
    } finally {
      switchInProgress = false;
    }
  });

  app.post("/api/db/upload", (req, res) => {
    if (switchInProgress) {
      sendError(res, 409, "DB_SWITCH_IN_PROGRESS", "A database switch is already in progress.");
      return;
    }

    const form = new IncomingForm({
      uploadDir: uploadsDir,
      keepExtensions: true,
      multiples: false,
      maxFiles: 1,
      allowEmptyFiles: false,
    });

    switchInProgress = true;
    form.parse(req, (parseError: unknown, fields: Record<string, string | string[]>, files: Record<string, unknown>) => {
      try {
        if (parseError) {
          sendError(res, 400, "INVALID_INPUT", "This file doesn't look like a HyperBase index. Make sure to select a `.opencode/index/codebase.db` file.");
          return;
        }

        const entry = (files as { file?: { filepath?: string; originalFilename?: string; newFilename?: string } | Array<{ filepath?: string; originalFilename?: string; newFilename?: string }> }).file;
        const uploaded = Array.isArray(entry) ? entry[0] : entry;
        if (!uploaded?.filepath || !uploaded.originalFilename?.endsWith(".db")) {
          sendError(res, 400, "INVALID_INPUT", "This file doesn't look like a HyperBase index. Make sure to select a `.opencode/index/codebase.db` file.");
          return;
        }

        const persistedPath = join(uploadsDir, `${Date.now()}-${uploaded.newFilename || "codebase"}.db`);
        renameSync(uploaded.filepath, persistedPath);
        const requestedBranch = typeof fields.branch === "string" ? fields.branch : undefined;
        const nextState = createLoadedState(persistedPath, requestedBranch);
        res.json(swapState(nextState));
      } catch (error) {
        void error;
        sendError(res, 400, "INVALID_INPUT", "This file doesn't look like a HyperBase index. Make sure to select a `.opencode/index/codebase.db` file.");
      } finally {
        switchInProgress = false;
      }
    });
  });

  app.get("/api/branches", (req, res) => withState(req, res, (state) => {
    res.json({ branches: state.branches });
  }));

  app.get("/api/search", (req, res) => withBranch(req, res, (state, branch) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameter: q");
      return;
    }

    const results = state.queries.searchSymbols(branch, q).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
    }));

    res.json({ results });
  }));

  app.get("/api/symbol/:id", (req, res) => withBranch(req, res, (state, branch) => {
    const symbol = getSymbolOr404(state, branch, req.params.id, res);
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
        callerCount: state.queries.getCallerCount(branch, symbol.id),
        calleeCount: state.queries.getCalleeCount(branch, symbol.id),
      },
    });
  }));

  app.get("/api/neighborhood/:id", (req, res) => withBranch(req, res, (state, branch) => {
    const depth = parseInteger(req.query.depth) ?? 1;
    if (depth < 1 || depth > MAX_NEIGHBORHOOD_DEPTH) {
      sendError(res, 400, "INVALID_INPUT", "depth must be between 1 and 3");
      return;
    }

    const neighborhood = buildNeighborhoodGraph(state.queries, branch, req.params.id, depth);
    if (!neighborhood) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json(neighborhood);
  }));

  app.get("/api/graph/directory", (req, res) => withBranch(req, res, (state, branch) => {
    const directoryPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!directoryPath) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameter: path");
      return;
    }

    const directoryGraph = buildDirectoryGraph(state.queries, branch, directoryPath);
    if (!directoryGraph) {
      sendError(res, 404, "NOT_FOUND", `Unknown directory: ${directoryPath}`);
      return;
    }

    res.json(directoryGraph);
  }));

  app.get("/api/graph/full", (req, res) => withBranch(req, res, (state, branch) => {
    res.json(buildFullGraph(state.queries, branch));
  }));

  app.get("/api/blast-radius/:id", (req, res) => withBranch(req, res, (state, branch) => {
    const blast = buildBlastRadiusGraph(state.queries, branch, req.params.id);
    if (!blast) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json(blast);
  }));

  app.get("/api/path", (req, res) => withBranch(req, res, (state, branch) => {
    const fromId = typeof req.query.from === "string" ? req.query.from : "";
    const toId = typeof req.query.to === "string" ? req.query.to : "";
    if (!fromId || !toId) {
      sendError(res, 400, "INVALID_INPUT", "Missing query parameters: from and to");
      return;
    }

    const pathResponse = buildShortestPath(state.queries, branch, fromId, toId);
    if (pathResponse === "NOT_FOUND") {
      sendError(res, 404, "NOT_FOUND", "One or both symbols do not exist");
      return;
    }

    res.json(pathResponse);
  }));

  app.get("/api/peek/:symbolId", (req, res) => withBranch(req, res, (state, branch) => {
    const row = state.queries.getPeekSymbolAndChunk(branch, req.params.symbolId);
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
  app.get("/api/mcp/neighborhood/:id", (req, res) => withBranch(req, res, (state, branch) => {
    const depth = parseInteger(req.query.depth) ?? 1;
    if (depth < 1 || depth > MAX_NEIGHBORHOOD_DEPTH) {
      sendError(res, 400, "INVALID_INPUT", "depth must be between 1 and 3");
      return;
    }

    const neighborhood = buildNeighborhoodGraph(state.queries, branch, req.params.id, depth);
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
    getCurrentState: () => currentState,
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
          currentState?.db.close();
          resolve();
          return;
        }
        server.close((error) => {
          currentState?.db.close();
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
  const state = instance.getCurrentState();

  console.log("╔════════════════════════════════════════╗");
  console.log("║     HyperBase Graph Server v0.1        ║");
  console.log(`║     http://localhost:${instance.port.toString().padEnd(20, " ")}║`);
  console.log("╚════════════════════════════════════════╝");
  if (state) {
    console.log(
      `Symbols: ${state.queries.getSymbolCount(state.defaultBranch)} | Resolved edges: ${state.queries.getResolvedEdgeCount(state.defaultBranch)} | Branch: ${state.defaultBranch}`
    );
  } else {
    console.log("No database loaded. Open HyperBase in the browser and upload or select a demo database.");
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
