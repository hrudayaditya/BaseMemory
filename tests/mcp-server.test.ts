import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { parseConfig } from "../src/config/schema.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const indexerMocks = vi.hoisted(() => ({
  searchDetailed: vi.fn(),
}));

vi.mock("../src/indexer/index.js", () => {
  class MockIndexer {
    initialize = vi.fn().mockResolvedValue(undefined);
    searchDetailed = indexerMocks.searchDetailed;
    constructor() {
      this.searchDetailed.mockResolvedValue({
      primaryResults: [
        {
          filePath: "src/auth.ts",
          startLine: 10,
          endLine: 25,
          name: "validateToken",
          chunkType: "function",
          chunkKind: "Code",
          content: "function validateToken(token: string) {\n  return token.length > 0;\n}",
          score: 0.95,
          lane: "semantic",
          reranked: true,
          rerankerScore: 0.95,
          scoreBreakdown: {
            lanes: {
              arctic: { score: 0.91, rank: 1 },
              bm25: { score: 4.2, rank: 2 },
            },
            fusion: {
              strategy: "rrf",
              score: 0.88,
              rank: 1,
            },
            sources: ["arctic", "bm25", "hybrid"],
            stages: [
              {
                name: "finalReranker",
                kind: "replace",
                before: 0.88,
                after: 0.95,
                reason: "backend=fixed-score; rank=1",
              },
            ],
            preRerankScore: 0.88,
            reranker: {
              score: 0.95,
              rank: 1,
              backend: "fixed-score",
            },
            finalScore: 0.95,
          },
        },
      ],
      expandedContext: [],
      taskType: "general",
      graphDirection: "both",
      timings: { prefilterMs: 0 },
      retrieval: {
        voyageLaneConfigured: false,
        voyageLaneUsed: false,
      },
      reranker: {
        applied: true,
        backend: "transformers-cross-encoder",
      },
    });
    }
    search = vi.fn().mockResolvedValue([
      {
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        name: "validateToken",
        chunkType: "function",
        content: "function validateToken(token: string) {\n  return token.length > 0;\n}",
        score: 0.95,
      },
    ]);
    findSimilar = vi.fn().mockResolvedValue([
      {
        filePath: "src/utils.ts",
        startLine: 5,
        endLine: 15,
        name: "checkAuth",
        chunkType: "function",
        content: "function checkAuth(token: string) {\n  return !!token;\n}",
        score: 0.88,
      },
    ]);
    indexForeground = vi.fn().mockResolvedValue({
      filesProcessed: 10,
      totalChunks: 50,
      chunksIndexed: 50,
      removedChunks: 0,
      durationMs: 500,
      bm25Ready: true,
      callGraphReady: true,
      embeddingStatus: "pending",
      embeddingProgress: {
        embedded: 0,
        total: 50,
        startedAt: null,
        updatedAt: null,
        failed: null,
      },
    });
    getStatus = vi.fn().mockResolvedValue({
      indexed: true,
      vectorCount: 50,
      provider: "openai",
      model: "text-embedding-3-small",
      indexPath: "/tmp/index",
      currentBranch: "main",
      baseBranch: "main",
      compatibility: { compatible: true },
      foreground: {
        bm25Ready: true,
        callGraphReady: true,
      },
      embedding: {
        status: "in_progress",
        embedded: 10,
        total: 50,
        startedAt: 1,
        updatedAt: 2,
        failed: null,
      },
    });
    getCoverageReport = vi.fn().mockResolvedValue({
      branch: "main",
      truncatedFiles: [
        {
          filePath: "src/indexer/index.ts",
          capLimit: 300,
          keptChunks: 300,
          droppedChunks: 2,
          droppedNamedSymbols: ["rankHybridResults", "fuseResultsWeighted"],
          indexedAt: 123,
        },
      ],
      totalDroppedChunks: 2,
      totalDroppedNamedSymbols: 2,
    });
    getSymbolInfo = vi.fn().mockResolvedValue({
      symbols: [
        {
          symbolId: "sym_validateToken",
          name: "validateToken",
          kind: "function",
          fileUri: "file:///tmp/test-project/src/auth.ts",
          relativePath: "src/auth.ts",
          startLine: 10,
          endLine: 25,
          signature: "function validateToken(token: string) {",
          chunkKind: "code",
        },
      ],
      total: 1,
      ambiguous: false,
    });
    getStructuralCallers = vi.fn().mockResolvedValue({
      callers: [
        {
          symbolName: "handleRequest",
          fileUri: "file:///tmp/test-project/src/server.ts",
          relativePath: "src/server.ts",
          line: 42,
          chunkKind: "code",
        },
      ],
      total: 1,
      cursor: null,
      resolved: true,
    });
    getStructuralCallees = vi.fn().mockResolvedValue({
      callees: [
        {
          symbolName: "parseToken",
          fileUri: "file:///tmp/test-project/src/auth.ts",
          relativePath: "src/auth.ts",
          line: 5,
          resolved: true,
        },
      ],
      total: 1,
      resolved: true,
    });
    getStructuralCallChain = vi.fn().mockResolvedValue({
      found: true,
      path: [
        {
          symbolName: "entrypoint",
          fileUri: "file:///tmp/test-project/src/server.ts",
          relativePath: "src/server.ts",
          line: 12,
        },
        {
          symbolName: "validateToken",
          fileUri: "file:///tmp/test-project/src/auth.ts",
          relativePath: "src/auth.ts",
          line: 10,
        },
      ],
      depth: 1,
      searchDepthReached: false,
      warning: null,
    });
    getStructuralTests = vi.fn().mockResolvedValue({
      tests: [
        {
          testName: "testValidateToken",
          fileUri: "file:///tmp/test-project/tests/auth.test.ts",
          relativePath: "tests/auth.test.ts",
          line: 5,
          confidence: 0.95,
          method: "call_graph",
        },
      ],
      total: 1,
      symbolResolved: true,
    });
    healthCheck = vi.fn().mockResolvedValue({
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      gcOrphanSymbols: 0,
      gcOrphanCallEdges: 0,
      filePaths: [],
    });
    clearIndex = vi.fn().mockResolvedValue(undefined);
    estimateCost = vi.fn().mockResolvedValue({
      filesCount: 10,
      totalSizeBytes: 50000,
      estimatedChunks: 50,
      estimatedTokens: 1000,
      estimatedCost: 0.01,
      isFree: false,
      provider: "openai",
      model: "text-embedding-3-small",
    });
    getLogger = vi.fn().mockReturnValue({
      isEnabled: vi.fn().mockReturnValue(false),
      isMetricsEnabled: vi.fn().mockReturnValue(false),
      getLogs: vi.fn().mockReturnValue([]),
      getLogsByCategory: vi.fn().mockReturnValue([]),
      getLogsByLevel: vi.fn().mockReturnValue([]),
      formatMetrics: vi.fn().mockReturnValue(""),
    });
  }
  return { Indexer: MockIndexer };
});

describe("createMcpServer", () => {
  it("should create a server instance", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
    expect(server).toHaveProperty("connect");
  });

  it("should have the correct server name", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
  });

});

describe("MCP server tools and prompts", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    indexerMocks.searchDetailed.mockClear();
    const config = parseConfig({});
    server = createMcpServer("/tmp/test-project", config);
    client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("should register all 16 tools", async () => {
    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(16);

    const toolNames = tools.tools.map(t => t.name).sort();
    const expectedNames = [
      "call_graph",
      "call_chain",
      "callers",
      "callees",
      "codebase_peek",
      "codebase_search",
      "find_similar",
      "implementation_lookup",
      "index_codebase",
      "index_coverage",
      "index_health_check",
      "index_logs",
      "index_metrics",
      "index_status",
      "symbol_info",
      "tests_for",
    ].sort();

    expect(toolNames).toEqual(expectedNames);
  });

  it("declares score_breakdown in the codebase_search output schema", async () => {
    const tools = await client.listTools();
    const searchTool = tools.tools.find((tool) => tool.name === "codebase_search") as {
      outputSchema?: {
        properties?: {
          results?: {
            items?: {
              properties?: Record<string, unknown>;
            };
          };
        };
      };
    } | undefined;

    expect(searchTool?.outputSchema?.properties?.results?.items?.properties).toHaveProperty("score_breakdown");
  });

  it("should register all 5 prompts", async () => {
    const prompts = await client.listPrompts();

    expect(prompts.prompts).toHaveLength(5);

    const promptNames = prompts.prompts.map(p => p.name).sort();
    const expectedNames = ["definition", "find", "index", "search", "status"].sort();

    expect(promptNames).toEqual(expectedNames);
  });

  it("should execute codebase_search tool", async () => {
    const result = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query", filters: { chunk_type: "test" }, include_scores: true },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 results");
    expect(content[0].text).toContain("validateToken");
    const structured = (result as { structuredContent?: { results?: Array<{ lane?: string; reranker_score?: number | null; score_breakdown?: unknown }> } }).structuredContent;
    expect(structured?.results?.[0]?.lane).toBe("semantic");
    expect(structured?.results?.[0]?.reranker_score).toBe(0.95);
    expect(structured?.results?.[0]?.score_breakdown).toEqual(expect.objectContaining({
      lanes: expect.any(Object),
      fusion: expect.any(Object),
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "finalReranker" }),
      ]),
      pre_rerank_score: 0.88,
      final_score: 0.95,
    }));
    expect(indexerMocks.searchDetailed.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      includeScoreBreakdown: true,
    }));
  });

  it("omits score_breakdown and keeps breakdown disabled when codebase_search scores are not requested", async () => {
    const result = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query" },
    });

    const structured = (result as { structuredContent?: { results?: Array<{ score_breakdown?: unknown; reranker_score?: number | null }> } }).structuredContent;
    expect(structured?.results?.[0]).not.toHaveProperty("score_breakdown");
    expect(structured?.results?.[0]?.reranker_score).toBeNull();
    expect(indexerMocks.searchDetailed.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      includeScoreBreakdown: false,
    }));
  });

  it("keeps codebase_search result identity stable with and without score breakdown", async () => {
    const withoutScores = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query" },
    });
    const withScores = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query", include_scores: true },
    });

    const withoutResult = (withoutScores as { structuredContent?: { results?: Array<{ file_path: string; start_line: number; end_line: number; reranker_score?: number | null }> } }).structuredContent?.results?.[0];
    const withResult = (withScores as { structuredContent?: { results?: Array<{ file_path: string; start_line: number; end_line: number; reranker_score?: number | null }> } }).structuredContent?.results?.[0];
    expect(withResult?.file_path).toBe(withoutResult?.file_path);
    expect(withResult?.start_line).toBe(withoutResult?.start_line);
    expect(withResult?.end_line).toBe(withoutResult?.end_line);
  });

  it("should execute codebase_peek tool", async () => {
    const result = await client.callTool({
      name: "codebase_peek",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 locations");
  });

  it("should execute index_status tool", async () => {
    const result = await client.callTool({
      name: "index_status",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Index status");
    expect(content[0].text).toContain("50");
  });

  it("should execute index_coverage tool", async () => {
    const result = await client.callTool({
      name: "index_coverage",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("\"truncatedFiles\"");
    expect(content[0].text).toContain("rankHybridResults");
  });

  it("should execute index_codebase with estimateOnly", async () => {
    const result = await client.callTool({
      name: "index_codebase",
      arguments: { estimateOnly: true },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Estimate");
  });

  it("should execute index_health_check tool", async () => {
    const result = await client.callTool({
      name: "index_health_check",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("healthy");
  });

  it("should execute find_similar tool", async () => {
    const result = await client.callTool({
      name: "find_similar",
      arguments: { code: "function test() {}" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 similar");
  });

  it("should execute implementation_lookup tool", async () => {
    const result = await client.callTool({
      name: "implementation_lookup",
      arguments: { query: "validateToken" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Definition found");
    expect(content[0].text).toContain("validateToken");
  });

  it("should execute symbol_info tool", async () => {
    const result = await client.callTool({
      name: "symbol_info",
      arguments: { symbol: "validateToken" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Symbol: validateToken");
    expect((result as { structuredContent?: { total?: number } }).structuredContent?.total).toBe(1);
  });

  it("should execute callers tool", async () => {
    const result = await client.callTool({
      name: "callers",
      arguments: { symbol: "validateToken" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Found 1 callers");
    expect((result as { structuredContent?: { total?: number } }).structuredContent?.total).toBe(1);
  });

  it("should execute callees tool", async () => {
    const result = await client.callTool({
      name: "callees",
      arguments: { symbol: "validateToken" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Found 1 callees");
    expect((result as { structuredContent?: { total?: number } }).structuredContent?.total).toBe(1);
  });

  it("should execute call_chain tool", async () => {
    const result = await client.callTool({
      name: "call_chain",
      arguments: { from_symbol: "entrypoint", to_symbol: "validateToken" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Call path from");
    expect((result as { structuredContent?: { found?: boolean; depth?: number } }).structuredContent?.found).toBe(true);
    expect((result as { structuredContent?: { found?: boolean; depth?: number } }).structuredContent?.depth).toBe(1);
  });

  it("should execute tests_for tool", async () => {
    const result = await client.callTool({
      name: "tests_for",
      arguments: { symbol: "validateToken" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Found 1 tests covering");
    expect((result as { structuredContent?: { total?: number } }).structuredContent?.total).toBe(1);
  });

  it("should get search prompt", async () => {
    const prompt = await client.getPrompt({
      name: "search",
      arguments: { query: "auth logic" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.type).toBe("text");
    expect(msgContent.text).toContain("auth logic");
  });

  it("should get find prompt", async () => {
    const prompt = await client.getPrompt({
      name: "find",
      arguments: { query: "validation" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("validation");
  });

  it("should get index prompt", async () => {
    const prompt = await client.getPrompt({
      name: "index",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_codebase");
  });

  it("should get status prompt", async () => {
    const prompt = await client.getPrompt({
      name: "status",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_status");
  });

  it("should get definition prompt", async () => {
    const prompt = await client.getPrompt({
      name: "definition",
      arguments: { query: "validateToken" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.type).toBe("text");
    expect(msgContent.text).toContain("validateToken");
    expect(msgContent.text).toContain("implementation_lookup");
  });

  it("should execute index_metrics tool", async () => {
    const result = await client.callTool({
      name: "index_metrics",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("should execute index_logs tool", async () => {
    const result = await client.callTool({
      name: "index_logs",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});
