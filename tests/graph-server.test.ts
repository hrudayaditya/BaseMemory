import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequest, createResponse } from "node-mocks-http";

import { createGraphServer } from "../src/graph-server.js";

type TestContext = {
  root: string;
  dbPath: string;
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
  mkdirSync(join(repoRoot, "src", "misc"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "fanout"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "search"), { recursive: true });

  const files = {
    center: join(repoRoot, "src", "core", "center.ts"),
    helper: join(repoRoot, "src", "helpers", "helper.ts"),
    callerOne: join(repoRoot, "src", "callers", "caller-one.ts"),
    callerTwo: join(repoRoot, "src", "callers", "caller-two.ts"),
    isolated: join(repoRoot, "src", "misc", "isolated.ts"),
    searchA: join(repoRoot, "src", "search", "spawn.ts"),
    searchB: join(repoRoot, "src", "search", "spawna.ts"),
    searchC: join(repoRoot, "src", "search", "spawnb.ts"),
    fanout: join(repoRoot, "src", "fanout", "fanout.ts"),
  };

  writeFileSync(files.center, [
    "export function buildPerQueryResult() {",
    "  return helperAlpha() + localHelper();",
    "}",
    "",
    "export function localHelper() {",
    "  return 1;",
    "}",
    "",
    "export function unrelatedCenterUtility() {",
    "  return 0;",
    "}",
  ].join("\n"));

  writeFileSync(files.helper, [
    "export function helperAlpha() {",
    "  return 41;",
    "}",
  ].join("\n"));

  writeFileSync(files.callerOne, [
    "export function computeMetrics() {",
    "  return buildPerQueryResult();",
    "}",
  ].join("\n"));

  writeFileSync(files.callerTwo, [
    "export function orchestrateResults() {",
    "  return computeMetrics();",
    "}",
  ].join("\n"));

  writeFileSync(files.isolated, [
    "export function isolatedNode() {",
    "  return 7;",
    "}",
  ].join("\n"));

  writeFileSync(files.searchA, "export function spawn() { return 1; }\n");
  writeFileSync(files.searchB, "export function spawna() { return 1; }\n");
  writeFileSync(files.searchC, "export function spawnb() { return 1; }\n");
  writeFileSync(files.fanout, "export function fanoutCenter() { return 0; }\n");

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
    ["sym_local", files.center, "localHelper", "function", 5, 0, 7, 1, "typescript"],
    ["sym_helper", files.helper, "helperAlpha", "function", 1, 0, 3, 1, "typescript"],
    ["sym_caller1", files.callerOne, "computeMetrics", "function", 1, 0, 3, 1, "typescript"],
    ["sym_caller2", files.callerTwo, "orchestrateResults", "function", 1, 0, 3, 1, "typescript"],
    ["sym_isolated", files.isolated, "isolatedNode", "function", 1, 0, 3, 1, "typescript"],
    ["sym_spawn", files.searchA, "spawn", "function", 1, 0, 1, 35, "typescript"],
    ["sym_spawna", files.searchB, "spawna", "function", 1, 0, 1, 36, "typescript"],
    ["sym_spawnb", files.searchC, "spawnb", "function", 1, 0, 1, 36, "typescript"],
    ["sym_fanout", files.fanout, "fanoutCenter", "function", 1, 0, 1, 42, "typescript"],
  ] as const;

  for (const symbol of symbols) {
    insertSymbol.run(...symbol);
    insertBranchSymbol.run("main", symbol[0]);
  }

  insertChunk.run("chunk_center", "hash1", files.center, 1, 7, "function", "buildPerQueryResult", "typescript", "Code", "Function");
  insertChunk.run("chunk_local", "hash2", files.center, 5, 7, "function", "localHelper", "typescript", "Code", "Function");
  insertChunk.run("chunk_helper", "hash3", files.helper, 1, 3, "function", "helperAlpha", "typescript", "Code", "Function");
  insertChunk.run("chunk_caller1", "hash4", files.callerOne, 1, 3, "function", "computeMetrics", "typescript", "Code", "Function");
  insertChunk.run("chunk_caller2", "hash5", files.callerTwo, 1, 3, "function", "orchestrateResults", "typescript", "Code", "Function");

  insertEdge.run("edge_center_helper", "sym_center", files.center, "helperAlpha", files.helper, "function", "sym_helper", "Call", 2, 9, 1);
  insertEdge.run("edge_center_local", "sym_center", files.center, "localHelper", files.center, "function", "sym_local", "Call", 2, 25, 1);
  insertEdge.run("edge_caller1_center", "sym_caller1", files.callerOne, "buildPerQueryResult", files.center, "function", "sym_center", "Call", 2, 9, 1);
  insertEdge.run("edge_caller2_caller1", "sym_caller2", files.callerTwo, "computeMetrics", files.callerOne, "function", "sym_caller1", "Call", 2, 9, 1);
  insertEdge.run("edge_center_helper_unresolved", "sym_center", files.center, "helperAlpha", files.helper, "function", null, "Call", 2, 12, 0);
  insertEdge.run("edge_center_ghost_unresolved", "sym_center", files.center, "ghostUtility", null, "function", null, "Call", 3, 2, 0);

  for (let i = 0; i < 305; i++) {
    const leafId = `sym_leaf_${i.toString().padStart(3, "0")}`;
    const leafName = `leaf${i.toString().padStart(3, "0")}`;
    const leafFile = join(repoRoot, "src", "fanout", `${leafName}.ts`);
    writeFileSync(leafFile, `export function ${leafName}() { return ${i}; }\n`);
    insertSymbol.run(leafId, leafFile, leafName, "function", 1, 0, 1, 36, "typescript");
    insertBranchSymbol.run("main", leafId);
    insertEdge.run(`edge_fanout_${i}`, "sym_fanout", files.fanout, leafName, leafFile, "function", leafId, "Call", 1, 1, 1);
  }

  db.close();
  return dbPath;
}

describe("graph server", () => {
  const ctx = {} as TestContext;

  beforeAll(async () => {
    ctx.root = mkdtempSync(join(tmpdir(), "hyperbase-graph-"));
    ctx.dbPath = seedTestDb(ctx.root);
    ctx.server = createGraphServer({ dbPath: ctx.dbPath, branch: "main", port: 0 });
  });

  afterAll(async () => {
    await ctx.server.close();
    rmSync(ctx.root, { recursive: true, force: true });
  });

  async function invoke(path: string, query: Record<string, string | number> = {}): Promise<{ status: number; body: unknown }> {
    const req = createRequest({
      method: "GET",
      url: path,
      params: path.split("/").reduce<Record<string, string>>((acc, part, index, all) => {
        if (all[index - 1] === "neighborhood" || all[index - 1] === "blast-radius") {
          acc.id = part;
        }
        if (all[index - 1] === "peek") {
          acc.symbolId = part;
        }
        return acc;
      }, {}),
      query,
    });
    const res = createResponse({ eventEmitter: (await import("events")).EventEmitter });

    await new Promise<void>((resolve) => {
      res.on("end", () => resolve());
      ctx.server.app.handle(req, res);
    });

    return {
      status: res.statusCode,
      body: res._getJSONData(),
    };
  }

  it("health_endpoint_returns_correct_shape", async () => {
    const response = await invoke("/api/health");
    expect(response.status).toBe(200);
    const json = response.body;
    expect(json).toMatchObject({
      status: "ok",
      branch: "main",
      version: "0.1.0",
    });
    expect((json as { symbolCount: number }).symbolCount).toBeTypeOf("number");
    expect((json as { resolvedEdgeCount: number }).resolvedEdgeCount).toBeTypeOf("number");
  });

  it("search_returns_ranked_by_name_length_with_stable_tiebreak", async () => {
    const response = await invoke("/api/search", { q: "spawn" });
    expect(response.status).toBe(200);
    const names = (response.body as { results: Array<{ name: string }> }).results.map((row) => row.name);
    expect(names.slice(0, 3)).toEqual(["spawn", "spawna", "spawnb"]);
  });

  it("neighborhood_depth_1_contains_center_node", async () => {
    const response = await invoke("/api/neighborhood/sym_center", { depth: 1 });
    expect(response.status).toBe(200);
    const nodes = (response.body as { nodes: Array<{ id: string }> }).nodes;
    expect(nodes.some((node) => node.id === "sym_center")).toBe(true);
  });

  it("neighborhood_truncates_at_300_nodes", async () => {
    const response = await invoke("/api/neighborhood/sym_fanout", { depth: 1 });
    expect(response.status).toBe(200);
    expect((response.body as { truncated: boolean }).truncated).toBe(true);
    expect((response.body as { nodes: unknown[] }).nodes.length).toBeLessThanOrEqual(300);
  });

  it("neighborhood_unresolved_edges_do_not_create_new_nodes", async () => {
    const response = await invoke("/api/neighborhood/sym_center", { depth: 1 });
    expect(response.status).toBe(200);
    const nodes = new Set((response.body as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id));
    const unresolvedEdges = (response.body as { edges: Array<{ from: string; to: string; isResolved: boolean }> }).edges
      .filter((edge) => edge.isResolved === false);
    expect(unresolvedEdges.length).toBeGreaterThan(0);
    for (const edge of unresolvedEdges) {
      expect(nodes.has(edge.from)).toBe(true);
      expect(nodes.has(edge.to)).toBe(true);
    }
  });

  it("neighborhood_degree_counts_resolved_edges_only", async () => {
    const response = await invoke("/api/neighborhood/sym_center", { depth: 1 });
    expect(response.status).toBe(200);
    const center = (response.body as { nodes: Array<{ id: string; degree: number }> }).nodes.find((node) => node.id === "sym_center");
    expect(center?.degree).toBe(3);
  });

  it("full_graph_edges_are_cross_file_only", async () => {
    const response = await invoke("/api/graph/full");
    expect(response.status).toBe(200);
    const edges = (response.body as { edges: Array<{ from: string; to: string }> }).edges;
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.from).not.toBe(edge.to);
    }
  });

  it("blast_radius_depth_map_present", async () => {
    const response = await invoke("/api/blast-radius/sym_helper");
    expect(response.status).toBe(200);
    const depth = (response.body as { depth: Record<string, number> }).depth;
    expect(depth.sym_helper).toBe(0);
    expect(depth.sym_center).toBe(1);
    expect(depth.sym_caller1).toBe(2);
  });

  it("path_found_between_connected_symbols", async () => {
    const response = await invoke("/api/path", { from: "sym_caller2", to: "sym_helper" });
    expect(response.status).toBe(200);
    expect((response.body as { found: boolean }).found).toBe(true);
    expect((response.body as { path: unknown[] }).path.length).toBeGreaterThan(0);
  });

  it("path_not_found_returns_correct_shape", async () => {
    const response = await invoke("/api/path", { from: "sym_isolated", to: "sym_helper" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      found: false,
      exhausted: false,
      path: [],
      edges: [],
    });
  });

  it("peek_returns_content_for_valid_symbol", async () => {
    const response = await invoke("/api/peek/sym_center");
    expect(response.status).toBe(200);
    expect((response.body as { content: string | null }).content).toContain("buildPerQueryResult");
  });

  it("unknown_branch_returns_400", async () => {
    const response = await invoke("/api/health", { branch: "does-not-exist" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Unknown branch: does-not-exist",
      code: "BRANCH_NOT_FOUND",
    });
  });

  it("mcp_neighborhood_graph_field_matches_bare_neighborhood", async () => {
    const bare = await invoke("/api/neighborhood/sym_center", { depth: 1 });
    const wrapped = await invoke("/api/mcp/neighborhood/sym_center", { depth: 1 });
    expect(bare.status).toBe(200);
    expect(wrapped.status).toBe(200);
    expect((wrapped.body as { graph: unknown }).graph).toEqual(bare.body);
  });
});
