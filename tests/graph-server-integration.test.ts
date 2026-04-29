import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createGraphServer } from "../src/graph-server.js";
import type {
  HealthResponse,
  NeighborhoodResponse,
  SearchResult,
} from "../src/hyperbase/src/types/index.ts";

type TestContext = {
  root: string;
  dbPath: string;
  baseUrl: string;
  server: ReturnType<typeof createGraphServer>;
};

function seedTestDb(root: string): string {
  const dbPath = join(root, "codebase.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE symbols (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_col INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_col INTEGER NOT NULL,
      language TEXT NOT NULL,
      symbol_aliases TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE branch_symbols (
      branch TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (branch, symbol_id)
    );
    CREATE TABLE call_edges (
      id TEXT NOT NULL,
      branch TEXT NOT NULL,
      from_symbol_id TEXT NOT NULL,
      caller_file_path TEXT,
      target_name TEXT NOT NULL,
      target_file_path TEXT,
      target_kind TEXT,
      to_symbol_id TEXT,
      call_type TEXT NOT NULL,
      line INTEGER NOT NULL,
      col INTEGER NOT NULL,
      is_resolved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, branch)
    );
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      node_type TEXT,
      name TEXT,
      language TEXT NOT NULL,
      chunk_kind TEXT,
      symbol_kind TEXT,
      embedding_input_hash TEXT NOT NULL DEFAULT '',
      symbol_aliases TEXT NOT NULL DEFAULT ''
    );
  `);

  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "src", "core"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "callers"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "helpers"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "search"), { recursive: true });

  const files = {
    center: join(repoRoot, "src", "core", "center.ts"),
    helper: join(repoRoot, "src", "helpers", "helper.ts"),
    caller: join(repoRoot, "src", "callers", "caller.ts"),
    search: join(repoRoot, "src", "search", "spawn.ts"),
  };

  writeFileSync(files.center, [
    "export function buildPerQueryResult() {",
    "  return helperAlpha();",
    "}",
  ].join("\n"));
  writeFileSync(files.helper, "export function helperAlpha() { return 1; }\n");
  writeFileSync(files.caller, "export function computeMetrics() { return buildPerQueryResult(); }\n");
  writeFileSync(files.search, "export function spawn() { return 1; }\n");

  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      id, file_path, name, kind, start_line, start_col, end_line, end_col, language, symbol_aliases
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')
  `);
  const insertBranchSymbol = db.prepare("INSERT INTO branch_symbols (branch, symbol_id) VALUES (?, ?)");
  const insertChunk = db.prepare(`
    INSERT INTO chunks (
      chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, chunk_kind, symbol_kind, embedding_input_hash, symbol_aliases
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')
  `);
  const insertEdge = db.prepare(`
    INSERT INTO call_edges (
      id, branch, from_symbol_id, caller_file_path, target_name, target_file_path, target_kind, to_symbol_id, call_type, line, col, is_resolved
    ) VALUES (?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const symbols = [
    ["sym_center", files.center, "buildPerQueryResult", "function", 1, 0, 3, 1, "typescript"],
    ["sym_helper", files.helper, "helperAlpha", "function", 1, 0, 1, 35, "typescript"],
    ["sym_caller", files.caller, "computeMetrics", "function", 1, 0, 1, 56, "typescript"],
    ["sym_spawn", files.search, "spawn", "function", 1, 0, 1, 35, "typescript"],
  ] as const;

  for (const symbol of symbols) {
    insertSymbol.run(...symbol);
    insertBranchSymbol.run("main", symbol[0]);
  }

  insertChunk.run("chunk_center", "hash1", files.center, 1, 3, "function", "buildPerQueryResult", "typescript", "Code", "Function");
  insertChunk.run("chunk_helper", "hash2", files.helper, 1, 1, "function", "helperAlpha", "typescript", "Code", "Function");
  insertChunk.run("chunk_caller", "hash3", files.caller, 1, 1, "function", "computeMetrics", "typescript", "Code", "Function");

  insertEdge.run("edge_center_helper", "sym_center", files.center, "helperAlpha", files.helper, "function", "sym_helper", "Call", 2, 9, 1);
  insertEdge.run("edge_caller_center", "sym_caller", files.caller, "buildPerQueryResult", files.center, "function", "sym_center", "Call", 1, 9, 1);
  insertEdge.run("edge_center_ghost", "sym_center", files.center, "ghostUtility", null, "function", null, "Call", 2, 15, 0);

  db.close();
  return dbPath;
}

describe("graph server integration", () => {
  const ctx = {} as TestContext;

  beforeAll(async () => {
    ctx.root = mkdtempSync(join(tmpdir(), "hyperbase-graph-integration-"));
    ctx.dbPath = seedTestDb(ctx.root);
    ctx.server = createGraphServer({ dbPath: ctx.dbPath, branch: "main", port: 0 });
    await ctx.server.start();
    const address = ctx.server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a real TCP address from graph server");
    }
    ctx.baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await ctx.server.close();
    rmSync(ctx.root, { recursive: true, force: true });
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${ctx.baseUrl}${path}`);
    return {
      status: response.status,
      body: (await response.json()) as T,
    };
  }

  it("integration_health_endpoint_returns_parseable_health_response", async () => {
    const response = await getJson<HealthResponse>("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.branch).toBe("main");
    expect(response.body.symbolCount).toBeTypeOf("number");
    expect(response.body.resolvedEdgeCount).toBeTypeOf("number");
  });

  it("integration_search_endpoint_returns_parseable_results", async () => {
    const response = await getJson<{ results: SearchResult[] }>("/api/search?q=spawn");
    expect(response.status).toBe(200);
    expect(response.body.results.map((result) => result.name)).toEqual(["spawn"]);
    expect(response.body.results[0]?.startLine).toBe(1);
  });

  it("integration_neighborhood_endpoint_returns_parseable_graph", async () => {
    const response = await getJson<NeighborhoodResponse>("/api/neighborhood/sym_center?depth=1");
    expect(response.status).toBe(200);
    expect(response.body.centerSymbolId).toBe("sym_center");
    expect(response.body.nodes.some((node) => node.id === "sym_center")).toBe(true);
    const unresolved = response.body.edges.find((edge) => edge.isResolved === false);
    expect(unresolved?.to).toBeNull();
  });

  it("integration_error_response_returns_branch_not_found", async () => {
    const response = await getJson<{ error: string; code: string }>("/api/health?branch=does-not-exist");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Unknown branch: does-not-exist",
      code: "BRANCH_NOT_FOUND",
    });
  });

  it("integration_mcp_endpoint_wraps_the_same_neighborhood_graph", async () => {
    const bare = await getJson<NeighborhoodResponse>("/api/neighborhood/sym_center?depth=1");
    const wrapped = await getJson<{
      schema: string;
      generatedAt: string;
      query: { symbolId: string; branch: string; depth: number };
      graph: NeighborhoodResponse;
    }>("/api/mcp/neighborhood/sym_center?depth=1");

    expect(bare.status).toBe(200);
    expect(wrapped.status).toBe(200);
    expect(wrapped.body.schema).toBe("hyperbase-graph-v1");
    expect(wrapped.body.query).toEqual({
      symbolId: "sym_center",
      branch: "main",
      depth: 1,
    });
    expect(wrapped.body.graph).toEqual(bare.body);
  });
});
