import cors from "cors";
import Database from "better-sqlite3";
import express, { type Express, type Request, type Response } from "express";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createServer, type Server } from "http";

type ErrorCode =
  | "INVALID_INPUT"
  | "BRANCH_NOT_FOUND"
  | "NOT_FOUND"
  | "DB_ERROR"
  | "INTERNAL_ERROR";

type GraphSymbolRow = {
  id: string;
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  language: string;
  symbol_aliases: string;
};

type GraphEdgeRow = {
  id: string;
  branch: string;
  from_symbol_id: string;
  caller_file_path: string | null;
  target_name: string;
  target_file_path: string | null;
  target_kind: string | null;
  to_symbol_id: string | null;
  call_type: string;
  line: number;
  col: number;
  is_resolved: number;
};

type GraphNode = {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  degree: number;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  callType: string;
  isResolved: boolean;
  callerFilePath: string | null;
  targetFilePath: string | null;
  line: number;
};

type NeighborhoodResponse = {
  centerSymbolId: string;
  depth: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type BlastRadiusResponse = {
  symbolId: string;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: Record<string, number>;
};

type PathNode = {
  id: string;
  name: string;
  filePath: string;
};

type PathResponse = {
  found: boolean;
  exhausted: boolean;
  path: PathNode[];
  edges: GraphEdge[];
};

type GraphServerOptions = {
  dbPath: string;
  branch?: string;
  port?: number;
};

type GraphServerInstance = {
  app: Express;
  server: Server;
  db: Database.Database;
  defaultBranch: string;
  dbPath: string;
  port: number;
  start: () => Promise<void>;
  close: () => Promise<void>;
};

type StatementBundle = {
  branches: Database.Statement<[], { branch: string }>;
  branchesFromSymbols: Database.Statement<[], { branch: string }>;
  symbolCount: Database.Statement<[string], { c: number }>;
  resolvedEdgeCount: Database.Statement<[string], { c: number }>;
  symbolById: Database.Statement<[string, string], GraphSymbolRow>;
  symbolByIds: Database.Statement<[string, string], GraphSymbolRow>;
  searchSymbols: Database.Statement<[string, string], GraphSymbolRow>;
  callerCount: Database.Statement<[string, string], { c: number }>;
  calleeCount: Database.Statement<[string, string], { c: number }>;
  resolvedCallersBatch: Database.Statement<[string, string], GraphEdgeRow>;
  resolvedCalleesBatch: Database.Statement<[string, string], GraphEdgeRow>;
  unresolvedOutgoingBatch: Database.Statement<[string, string], GraphEdgeRow>;
  degreesBatch: Database.Statement<[string, string, string, string], { symbol_id: string; degree: number }>;
  fullGraphNodes: Database.Statement<[string], {
    file_path: string;
    language: string;
    symbol_count: number;
  }>;
  fullGraphEdges: Database.Statement<[string], {
    from_file_path: string;
    to_file_path: string;
    call_count: number;
  }>;
  peekSymbolAndChunk: Database.Statement<[string, string], {
    id: string;
    name: string;
    file_path: string;
    start_line: number;
    end_line: number;
    chunk_start_line: number | null;
    chunk_end_line: number | null;
  }>;
};

type BranchRow = { branch: string };
type DegreeRow = { symbol_id: string; degree: number };
type FileNodeRow = { file_path: string; language: string; symbol_count: number };
type FileEdgeRow = { from_file_path: string; to_file_path: string; call_count: number };
type PeekRow = {
  id: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_start_line: number | null;
  chunk_end_line: number | null;
};

const SERVER_VERSION = "0.1.0";
const DEFAULT_PORT = 7842;
const DEFAULT_DB_PATH = ".opencode/index/codebase.db";
const DEFAULT_HOST = "127.0.0.1";
const MAX_NEIGHBORHOOD_DEPTH = 3;
const MAX_NEIGHBORHOOD_NODES = 300;
const MAX_BLAST_RADIUS_NODES = 500;
const MAX_PATH_VISITED_NODES = 1000;

function jsonArray(values: Iterable<string>): string {
  return JSON.stringify(Array.from(values));
}

function sendError(res: Response, status: number, code: ErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) =>
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.line - b.line ||
    a.id.localeCompare(b.id)
  );
}

function toDirectoryPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : ".";
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

function makeNode(row: GraphSymbolRow, degree: number = 0): GraphNode {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    degree,
  };
}

function makeResolvedEdge(row: GraphEdgeRow): GraphEdge | null {
  if (!row.to_symbol_id) {
    return null;
  }

  return {
    id: row.id,
    from: row.from_symbol_id,
    to: row.to_symbol_id,
    callType: row.call_type,
    isResolved: row.is_resolved === 1,
    callerFilePath: row.caller_file_path,
    targetFilePath: row.target_file_path,
    line: row.line,
  };
}

function pickUnresolvedTarget(
  row: GraphEdgeRow,
  nodesById: Map<string, GraphSymbolRow>,
  idsByLowerName: Map<string, string[]>
): string | null {
  const candidates = idsByLowerName.get(row.target_name.toLowerCase()) ?? [];
  if (candidates.length === 0) {
    return null;
  }

  let narrowed = candidates;
  if (row.target_file_path) {
    const byFile = narrowed.filter((id) => nodesById.get(id)?.file_path === row.target_file_path);
    if (byFile.length > 0) {
      narrowed = byFile;
    }
  }

  if (row.target_kind) {
    const byKind = narrowed.filter((id) => nodesById.get(id)?.kind === row.target_kind);
    if (byKind.length > 0) {
      narrowed = byKind;
    }
  }

  return narrowed.length === 1 ? narrowed[0] : null;
}

function prepareStatements(db: Database.Database): StatementBundle {
  return {
    branches: db.prepare("SELECT DISTINCT branch FROM call_edges ORDER BY branch"),
    branchesFromSymbols: db.prepare("SELECT DISTINCT branch FROM branch_symbols ORDER BY branch"),
    symbolCount: db.prepare("SELECT COUNT(*) AS c FROM branch_symbols WHERE branch = ?"),
    resolvedEdgeCount: db.prepare("SELECT COUNT(*) AS c FROM call_edges WHERE branch = ? AND is_resolved = 1"),
    symbolById: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ? AND s.id = ?
      LIMIT 1
    `),
    symbolByIds: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
        AND s.id IN (SELECT value FROM json_each(?))
    `),
    searchSymbols: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
        AND s.name LIKE '%' || ? || '%' COLLATE NOCASE
      ORDER BY length(s.name) ASC, s.name ASC
      LIMIT 20
    `),
    callerCount: db.prepare(`
      SELECT COUNT(*) AS c
      FROM call_edges
      WHERE branch = ? AND is_resolved = 1 AND to_symbol_id = ?
    `),
    calleeCount: db.prepare(`
      SELECT COUNT(*) AS c
      FROM call_edges
      WHERE branch = ? AND is_resolved = 1 AND from_symbol_id = ?
    `),
    resolvedCallersBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.to_symbol_id IN (SELECT value FROM json_each(?))
    `),
    resolvedCalleesBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.from_symbol_id IN (SELECT value FROM json_each(?))
    `),
    unresolvedOutgoingBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 0
        AND ce.from_symbol_id IN (SELECT value FROM json_each(?))
    `),
    degreesBatch: db.prepare(`
      SELECT symbol_id, COUNT(*) AS degree
      FROM (
        SELECT from_symbol_id AS symbol_id
        FROM call_edges
        WHERE branch = ?
          AND is_resolved = 1
          AND from_symbol_id IN (SELECT value FROM json_each(?))
        UNION ALL
        SELECT to_symbol_id AS symbol_id
        FROM call_edges
        WHERE branch = ?
          AND is_resolved = 1
          AND to_symbol_id IN (SELECT value FROM json_each(?))
      )
      GROUP BY symbol_id
    `),
    fullGraphNodes: db.prepare(`
      SELECT
        s.file_path,
        MIN(s.language) AS language,
        COUNT(*) AS symbol_count
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
      GROUP BY s.file_path
      ORDER BY s.file_path
    `),
    fullGraphEdges: db.prepare(`
      SELECT
        ce.caller_file_path AS from_file_path,
        ce.target_file_path AS to_file_path,
        COUNT(*) AS call_count
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.caller_file_path IS NOT NULL
        AND ce.target_file_path IS NOT NULL
        AND ce.caller_file_path != ce.target_file_path
      GROUP BY ce.caller_file_path, ce.target_file_path
      ORDER BY ce.caller_file_path, ce.target_file_path
    `),
    peekSymbolAndChunk: db.prepare(`
      SELECT
        s.id,
        s.name,
        s.file_path,
        s.start_line,
        s.end_line,
        c.start_line AS chunk_start_line,
        c.end_line AS chunk_end_line
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      LEFT JOIN chunks c
        ON c.file_path = s.file_path
       AND c.start_line <= s.start_line
       AND c.end_line >= s.end_line
      WHERE bs.branch = ? AND s.id = ?
      ORDER BY
        CASE WHEN c.chunk_id IS NULL THEN 1 ELSE 0 END ASC,
        (c.end_line - c.start_line) ASC
      LIMIT 1
    `),
  };
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
  const statements = prepareStatements(db);

  const discoveredBranches = statements.branches.all().map((row: BranchRow) => row.branch);
  const fallbackBranches = statements.branchesFromSymbols.all().map((row: BranchRow) => row.branch);
  const branches = Array.from(new Set([...discoveredBranches, ...fallbackBranches]));
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
  const graphUiDir = join(dirname(fileURLToPath(import.meta.url)), "graph-ui");

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
    const symbol = statements.symbolById.get(branch, symbolId);
    if (!symbol) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${symbolId}`);
      return null;
    }
    return symbol;
  }

  function getDegrees(branch: string, symbolIds: Iterable<string>): Map<string, number> {
    const ids = Array.from(new Set(symbolIds));
    if (ids.length === 0) {
      return new Map();
    }

    const rows = statements.degreesBatch.all(branch, jsonArray(ids), branch, jsonArray(ids));
    return new Map(rows.map((row: DegreeRow) => [row.symbol_id, row.degree]));
  }

  function getSymbolsByIds(branch: string, symbolIds: Iterable<string>): Map<string, GraphSymbolRow> {
    const ids = Array.from(new Set(symbolIds));
    if (ids.length === 0) {
      return new Map();
    }

    const rows = statements.symbolByIds.all(branch, jsonArray(ids));
    return new Map(rows.map((row: GraphSymbolRow) => [row.id, row]));
  }

  function buildNeighborhood(
    branch: string,
    centerSymbolId: string,
    depth: number
  ): NeighborhoodResponse | null {
    const center = statements.symbolById.get(branch, centerSymbolId);
    if (!center) {
      return null;
    }

    const nodesById = new Map<string, GraphSymbolRow>([[center.id, center]]);
    const edgesById = new Map<string, GraphEdge>();
    let frontier = [center.id];
    let truncated = false;

    for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth++) {
      const callerRows = statements.resolvedCallersBatch.all(branch, jsonArray(frontier));
      const calleeRows = statements.resolvedCalleesBatch.all(branch, jsonArray(frontier));
      const resolvedRows = [...callerRows, ...calleeRows];

      const missingIds = new Set<string>();
      for (const row of resolvedRows) {
        if (row.from_symbol_id && !nodesById.has(row.from_symbol_id)) {
          missingIds.add(row.from_symbol_id);
        }
        if (row.to_symbol_id && !nodesById.has(row.to_symbol_id)) {
          missingIds.add(row.to_symbol_id);
        }
      }

      const fetchedSymbols = getSymbolsByIds(branch, missingIds);
      const nextFrontier: string[] = [];
      for (const [symbolId, symbol] of fetchedSymbols) {
        if (nodesById.has(symbolId)) {
          continue;
        }
        if (nodesById.size >= MAX_NEIGHBORHOOD_NODES) {
          truncated = true;
          break;
        }
        nodesById.set(symbolId, symbol);
        nextFrontier.push(symbolId);
      }

      for (const row of resolvedRows) {
        const edge = makeResolvedEdge(row);
        if (!edge || !nodesById.has(edge.from) || !nodesById.has(edge.to)) {
          continue;
        }
        edgesById.set(edge.id, edge);
      }

      if (truncated) {
        break;
      }
      frontier = nextFrontier;
    }

    const idsByLowerName = new Map<string, string[]>();
    for (const symbol of nodesById.values()) {
      const key = symbol.name.toLowerCase();
      const existing = idsByLowerName.get(key) ?? [];
      existing.push(symbol.id);
      idsByLowerName.set(key, existing);
    }

    const unresolvedRows = statements.unresolvedOutgoingBatch.all(branch, jsonArray(nodesById.keys()));
    for (const row of unresolvedRows) {
      if (!nodesById.has(row.from_symbol_id)) {
        continue;
      }
      const targetId = pickUnresolvedTarget(row, nodesById, idsByLowerName);
      if (!targetId || !nodesById.has(targetId)) {
        continue;
      }

      const edgeId = `${row.id}::${targetId}`;
      edgesById.set(edgeId, {
        id: edgeId,
        from: row.from_symbol_id,
        to: targetId,
        callType: row.call_type,
        isResolved: false,
        callerFilePath: row.caller_file_path,
        targetFilePath: row.target_file_path,
        line: row.line,
      });
    }

    const degrees = getDegrees(branch, nodesById.keys());
    const nodes = sortNodes(Array.from(nodesById.values(), (row) => makeNode(row, degrees.get(row.id) ?? 0)));
    const edges = sortEdges(Array.from(edgesById.values()));

    return {
      centerSymbolId,
      depth,
      truncated,
      nodes,
      edges,
    };
  }

  function buildBlastRadius(branch: string, symbolId: string): BlastRadiusResponse | null {
    const center = statements.symbolById.get(branch, symbolId);
    if (!center) {
      return null;
    }

    const nodesById = new Map<string, GraphSymbolRow>([[center.id, center]]);
    const depths = new Map<string, number>([[center.id, 0]]);
    const edgesById = new Map<string, GraphEdge>();
    let frontier = [center.id];
    let truncated = false;

    while (frontier.length > 0 && !truncated) {
      const callerRows = statements.resolvedCallersBatch.all(branch, jsonArray(frontier));
      const nextFrontier: string[] = [];
      const missingIds = new Set<string>();

      for (const row of callerRows) {
        if (row.from_symbol_id && !nodesById.has(row.from_symbol_id)) {
          missingIds.add(row.from_symbol_id);
        }
      }

      const fetchedSymbols = getSymbolsByIds(branch, missingIds);
      for (const [nodeId, symbol] of fetchedSymbols) {
        if (nodesById.has(nodeId)) {
          continue;
        }
        if (nodesById.size >= MAX_BLAST_RADIUS_NODES) {
          truncated = true;
          break;
        }
        nodesById.set(nodeId, symbol);
      }

      for (const row of callerRows) {
        const edge = makeResolvedEdge(row);
        if (!edge || !nodesById.has(edge.from) || !nodesById.has(edge.to)) {
          continue;
        }
        edgesById.set(edge.id, edge);

        if (!depths.has(edge.from)) {
          const baseDepth = depths.get(edge.to) ?? 0;
          depths.set(edge.from, baseDepth + 1);
          nextFrontier.push(edge.from);
        }
      }

      frontier = nextFrontier;
    }

    const degrees = getDegrees(branch, nodesById.keys());
    const nodes = sortNodes(Array.from(nodesById.values(), (row) => makeNode(row, degrees.get(row.id) ?? 0)));
    const edges = sortEdges(Array.from(edgesById.values()));
    const depthMap = Object.fromEntries(
      Array.from(depths.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );

    return {
      symbolId,
      truncated,
      nodes,
      edges,
      depth: depthMap,
    };
  }

  function buildPath(branch: string, fromId: string, toId: string): PathResponse | "NOT_FOUND" {
    const fromSymbol = statements.symbolById.get(branch, fromId);
    const toSymbol = statements.symbolById.get(branch, toId);
    if (!fromSymbol || !toSymbol) {
      return "NOT_FOUND";
    }

    if (fromId === toId) {
      return {
        found: true,
        exhausted: false,
        path: [{ id: fromSymbol.id, name: fromSymbol.name, filePath: fromSymbol.file_path }],
        edges: [],
      };
    }

    const visited = new Set<string>([fromId]);
    const queue: string[] = [fromId];
    const previousNode = new Map<string, string>();
    const previousEdge = new Map<string, GraphEdge>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const callers = statements.resolvedCallersBatch.all(branch, jsonArray([current]));
      const callees = statements.resolvedCalleesBatch.all(branch, jsonArray([current]));
      const edges = [...callers, ...callees];

      for (const row of edges) {
        const edge = makeResolvedEdge(row);
        if (!edge) {
          continue;
        }

        const neighbor = edge.from === current ? edge.to : edge.from;
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        previousNode.set(neighbor, current);
        previousEdge.set(neighbor, edge);

        if (visited.size > MAX_PATH_VISITED_NODES) {
          return {
            found: false,
            exhausted: true,
            path: [],
            edges: [],
          };
        }

        if (neighbor === toId) {
          const pathIds = [toId];
          const pathEdges: GraphEdge[] = [];
          let cursor = toId;
          while (cursor !== fromId) {
            const prev = previousNode.get(cursor);
            const prevEdge = previousEdge.get(cursor);
            if (!prev || !prevEdge) {
              break;
            }
            pathEdges.push(prevEdge);
            pathIds.push(prev);
            cursor = prev;
          }

          pathIds.reverse();
          pathEdges.reverse();
          const pathSymbols = getSymbolsByIds(branch, pathIds);
          return {
            found: true,
            exhausted: false,
            path: pathIds.map((id) => {
              const symbol = pathSymbols.get(id)!;
              return { id: symbol.id, name: symbol.name, filePath: symbol.file_path };
            }),
            edges: sortEdges(pathEdges),
          };
        }

        queue.push(neighbor);
      }
    }

    return {
      found: false,
      exhausted: false,
      path: [],
      edges: [],
    };
  }

  app.get("/api/health", (req, res) => withBranch(req, res, (branch) => {
    res.json({
      status: "ok",
      dbPath: options.dbPath,
      branch,
      symbolCount: statements.symbolCount.get(branch)?.c ?? 0,
      resolvedEdgeCount: statements.resolvedEdgeCount.get(branch)?.c ?? 0,
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

    const results = statements.searchSymbols.all(branch, q).map((row: GraphSymbolRow) => ({
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
        callerCount: statements.callerCount.get(branch, symbol.id)?.c ?? 0,
        calleeCount: statements.calleeCount.get(branch, symbol.id)?.c ?? 0,
      },
    });
  }));

  app.get("/api/neighborhood/:id", (req, res) => withBranch(req, res, (branch) => {
    const depth = parseInteger(req.query.depth) ?? 1;
    if (depth < 1 || depth > MAX_NEIGHBORHOOD_DEPTH) {
      sendError(res, 400, "INVALID_INPUT", "depth must be between 1 and 3");
      return;
    }

    const neighborhood = buildNeighborhood(branch, req.params.id, depth);
    if (!neighborhood) {
      sendError(res, 404, "NOT_FOUND", `Unknown symbol: ${req.params.id}`);
      return;
    }

    res.json(neighborhood);
  }));

  // Reserved route space for Phase 2: /api/graph/directory/:path (solar-system zoom level).
  app.get("/api/graph/full", (req, res) => withBranch(req, res, (branch) => {
    const nodes = statements.fullGraphNodes.all(branch).map((row: FileNodeRow) => ({
      id: `file::${row.file_path}`,
      filePath: row.file_path,
      language: row.language,
      symbolCount: row.symbol_count,
      directory: toDirectoryPath(row.file_path),
    }));

    const edges = statements.fullGraphEdges.all(branch).map((row: FileEdgeRow) => ({
      from: `file::${row.from_file_path}`,
      to: `file::${row.to_file_path}`,
      callCount: row.call_count,
    }));

    res.json({ nodes, edges });
  }));

  app.get("/api/blast-radius/:id", (req, res) => withBranch(req, res, (branch) => {
    const blast = buildBlastRadius(branch, req.params.id);
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

    const pathResponse = buildPath(branch, fromId, toId);
    if (pathResponse === "NOT_FOUND") {
      sendError(res, 404, "NOT_FOUND", "One or both symbols do not exist");
      return;
    }

    res.json(pathResponse);
  }));

  app.get("/api/peek/:symbolId", (req, res) => withBranch(req, res, (branch) => {
    const row = statements.peekSymbolAndChunk.get(branch, req.params.symbolId) as PeekRow | undefined;
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

    const neighborhood = buildNeighborhood(branch, req.params.id, depth);
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
