import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../src/config/schema.js";
import { createMcpServer } from "../src/mcp-server.js";

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

describe("MCP structural tools", () => {
  let tempDir: string;
  let client: Client;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 997;
        }
        const embedding = Array.from({ length: 8 }, (_, index) => ((seed + index * 13) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-structural-tools-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });

    writeFile(
      tempDir,
      "src/lib.ts",
      `export function helper() {
  return 1;
}

export function leaf() {
  return 2;
}

export function target() {
  return helper();
}

export function unresolvedSource() {
  missingCall();
  return helper();
}
`
    );

    writeFile(
      tempDir,
      "src/consumer.ts",
      `import { target } from "./lib";

export function caller() {
  return target();
}
`
    );

    writeFile(
      tempDir,
      "tests/lib.test.ts",
      `import { target } from "../src/lib";

export function testTarget() {
  return target();
}
`
    );

    writeFile(
      tempDir,
      "src/duplicate-a.ts",
      `import { helper } from "./lib";

export function duplicate() {
  return helper();
}

export function useDuplicateA() {
  return duplicate();
}
`
    );

    writeFile(
      tempDir,
      "src/duplicate-b.ts",
      `import { leaf } from "./lib";

export function duplicate() {
  return leaf();
}

export function useDuplicateB() {
  return duplicate();
}
`
    );

    writeFile(
      tempDir,
      "src/payment.ts",
      `export function processPayment() {
  return "ok";
}
`
    );

    writeFile(
      tempDir,
      "tests/payment.test.ts",
      `export function testProcessPayment() {
  return true;
}
`
    );

    writeFile(
      tempDir,
      "src/cycle.ts",
      `export function cycleA() {
  return cycleB();
}

export function cycleB() {
  return cycleA();
}
`
    );

    writeFile(
      tempDir,
      "src/rust_tests.rs",
      `fn rust_helper() -> i32 {
  1
}

#[test]
fn test_rust_helper() {
  assert_eq!(rust_helper(), 1);
}
`
    );

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        autoIndex: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const server = createMcpServer(tempDir, config);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "index_codebase",
      arguments: {},
    });
  }, 120_000);

  afterAll(async () => {
    fetchSpy.mockRestore();
    await client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds an exact symbol match", async () => {
    const result = await client.callTool({
      name: "symbol_info",
      arguments: { symbol: "target" },
    });

    const structured = result.structuredContent as {
      symbols: Array<{
        symbol_id: string;
        relative_path: string;
        start_line: number;
        chunk_kind: string | null;
      }>;
      total: number;
      ambiguous: boolean;
    };

    expect(structured.total).toBe(1);
    expect(structured.ambiguous).toBe(false);
    expect(structured.symbols[0]?.symbol_id).toBeTruthy();
    expect(structured.symbols[0]?.relative_path).toBe("src/lib.ts");
    expect(structured.symbols[0]?.start_line).toBeGreaterThan(0);
    expect(structured.symbols[0]?.chunk_kind).toBe("code");
  });

  it("returns an empty result for an unknown symbol without error", async () => {
    const result = await client.callTool({
      name: "symbol_info",
      arguments: { symbol: "doesNotExistAnywhere" },
    });

    const structured = result.structuredContent as { symbols: unknown[]; total: number; ambiguous: boolean };
    expect(structured.symbols).toEqual([]);
    expect(structured.total).toBe(0);
    expect(structured.ambiguous).toBe(false);
    expect(result.isError).not.toBe(true);
  });

  it("reports ambiguity until file_path disambiguates the symbol", async () => {
    const ambiguous = await client.callTool({
      name: "symbol_info",
      arguments: { symbol: "duplicate" },
    });
    const ambiguousStructured = ambiguous.structuredContent as { total: number; ambiguous: boolean };
    expect(ambiguousStructured.total).toBe(2);
    expect(ambiguousStructured.ambiguous).toBe(true);

    const resolved = await client.callTool({
      name: "symbol_info",
      arguments: { symbol: "duplicate", file_path: "src/duplicate-a.ts" },
    });
    const resolvedStructured = resolved.structuredContent as { total: number; ambiguous: boolean };
    expect(resolvedStructured.total).toBe(1);
    expect(resolvedStructured.ambiguous).toBe(false);
  });

  it("returns callers for a known function", async () => {
    const result = await client.callTool({
      name: "callers",
      arguments: { symbol: "target" },
    });

    const structured = result.structuredContent as {
      callers: Array<{ relative_path: string; line: number }>;
      total: number;
      resolved: boolean;
    };
    expect(structured.total).toBeGreaterThanOrEqual(2);
    expect(structured.callers.some((entry) => entry.relative_path === "src/consumer.ts")).toBe(true);
    expect(structured.callers.every((entry) => entry.line > 0)).toBe(true);
    expect(structured.resolved).toBe(true);
  });

  it("excludes test callers when include_tests is false", async () => {
    const result = await client.callTool({
      name: "callers",
      arguments: { symbol: "target", include_tests: false },
    });

    const structured = result.structuredContent as {
      callers: Array<{ relative_path: string; chunk_kind: string }>;
    };
    expect(structured.callers.some((entry) => entry.relative_path === "tests/lib.test.ts")).toBe(false);
    expect(structured.callers.every((entry) => entry.chunk_kind !== "test")).toBe(true);
  });

  it("marks ambiguous caller queries as unresolved", async () => {
    const result = await client.callTool({
      name: "callers",
      arguments: { symbol: "duplicate" },
    });

    const structured = result.structuredContent as { resolved: boolean; total: number };
    expect(structured.total).toBeGreaterThan(0);
    expect(structured.resolved).toBe(false);
  });

  it("returns callees for a known function", async () => {
    const result = await client.callTool({
      name: "callees",
      arguments: { symbol: "target" },
    });

    const structured = result.structuredContent as {
      callees: Array<{ symbol_name: string; resolved: boolean }>;
      total: number;
      resolved: boolean;
    };
    expect(structured.total).toBeGreaterThanOrEqual(1);
    expect(structured.callees.some((entry) => entry.symbol_name === "helper" && entry.resolved)).toBe(true);
    expect(structured.resolved).toBe(true);
  });

  it("includes unresolved callee edges", async () => {
    const result = await client.callTool({
      name: "callees",
      arguments: { symbol: "unresolvedSource" },
    });

    const structured = result.structuredContent as {
      callees: Array<{ symbol_name: string; resolved: boolean; file_uri: string | null }>;
    };
    const unresolved = structured.callees.find((entry) => entry.symbol_name === "missingCall");
    expect(unresolved).toBeDefined();
    expect(unresolved?.resolved).toBe(false);
    expect(unresolved?.file_uri).toBeNull();
  });

  it("marks ambiguous callee queries as unresolved", async () => {
    const result = await client.callTool({
      name: "callees",
      arguments: { symbol: "duplicate" },
    });

    const structured = result.structuredContent as { resolved: boolean; total: number };
    expect(structured.total).toBeGreaterThan(0);
    expect(structured.resolved).toBe(false);
  });

  it("finds the shortest call path between two symbols", async () => {
    const result = await client.callTool({
      name: "call_chain",
      arguments: { from_symbol: "caller", to_symbol: "helper" },
    });

    const structured = result.structuredContent as {
      found: boolean;
      path: Array<{ symbol_name: string }>;
      depth: number;
      search_depth_reached: boolean;
    };
    expect(structured.found).toBe(true);
    expect(structured.depth).toBe(2);
    expect(structured.path.map((entry) => entry.symbol_name)).toEqual(["caller", "target", "helper"]);
    expect(structured.search_depth_reached).toBe(false);
  });

  it("returns found=false when no call path exists", async () => {
    const result = await client.callTool({
      name: "call_chain",
      arguments: { from_symbol: "caller", to_symbol: "leaf" },
    });

    const structured = result.structuredContent as {
      found: boolean;
      path: unknown[];
      depth: number;
      search_depth_reached: boolean;
    };
    expect(structured.found).toBe(false);
    expect(structured.path).toEqual([]);
    expect(structured.depth).toBe(0);
    expect(structured.search_depth_reached).toBe(false);
  });

  it("terminates cleanly on cyclic graphs", async () => {
    const startedAt = Date.now();
    const result = await client.callTool({
      name: "call_chain",
      arguments: { from_symbol: "cycleA", to_symbol: "cycleB", max_depth: 8 },
    });

    const structured = result.structuredContent as {
      found: boolean;
      depth: number;
    };
    expect(structured.found).toBe(true);
    expect(structured.depth).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("finds tests via the call graph", async () => {
    const result = await client.callTool({
      name: "tests_for",
      arguments: { symbol: "target" },
    });

    const structured = result.structuredContent as {
      tests: Array<{ test_name: string; method: string; confidence: number }>;
    };
    expect(structured.tests.some((entry) => entry.test_name === "testTarget" && entry.method === "call_graph" && entry.confidence === 0.95)).toBe(true);
  });

  it("falls back to name conventions for tests", async () => {
    const result = await client.callTool({
      name: "tests_for",
      arguments: { symbol: "processPayment" },
    });

    const structured = result.structuredContent as {
      tests: Array<{ test_name: string; method: string; confidence: number }>;
    };
    expect(structured.tests.some((entry) => entry.test_name === "testProcessPayment" && entry.method === "name_convention" && entry.confidence === 0.7)).toBe(true);
  });

  it("returns an error when tests_for is called without symbol or file_path", async () => {
    const result = await client.callTool({
      name: "tests_for",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("At least one of 'symbol' or 'file_path' is required.");
  });

  it("restricts codebase_search results to chunk_kind test and includes lane", async () => {
    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const testSymbol = execFileSync(
      "sqlite3",
      [
        `file:${dbPath}?mode=ro`,
        "select name from chunks where lower(coalesce(chunk_kind,'')) = 'test' and name is not null order by name limit 1;",
      ],
      { encoding: "utf-8" }
    ).trim();
    expect(testSymbol.length).toBeGreaterThan(0);

    const result = await client.callTool({
      name: "codebase_search",
      arguments: {
        query: testSymbol,
        filters: { chunk_type: "test" },
        include_scores: true,
        taskType: "definition",
      },
    });

    const structured = result.structuredContent as {
      results: Array<{ chunk_kind: string | null; lane: string }>;
    };
    expect(structured.results.length).toBeGreaterThan(0);
    expect(structured.results.every((entry) => entry.chunk_kind === "test")).toBe(true);
    expect(structured.results.every((entry) => ["bm25", "semantic", "hybrid"].includes(entry.lane))).toBe(true);
  });
});
