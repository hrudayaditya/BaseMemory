import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";

import { extractCalls, Database, hashContent } from "../src/native/index.js";
import { Indexer } from "../src/indexer/index.js";

const fixturesDir = path.join(__dirname, "fixtures", "call-graph");

describe("call-graph", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("call extraction", () => {
    it("should extract direct function calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "simple-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("directCall");
      expect(callNames).toContain("helper");
      expect(callNames).toContain("compute");

      const directCall = calls.find((c) => c.calleeName === "directCall");
      expect(directCall).toBeDefined();
      expect(directCall!.callType).toBe("Call");

      const helperCall = calls.find((c) => c.calleeName === "helper");
      expect(helperCall).toBeDefined();
      expect(helperCall!.callType).toBe("Call");
    });

    it("should extract method calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "method-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("validate");
      expect(callNames).toContain("reset");
      expect(callNames).toContain("add");
      expect(callNames).toContain("subtract");
      expect(callNames).toContain("square");
    });

    it("should extract constructor calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "constructors.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const constructorCalls = calls.filter((c) => c.callType === "Constructor");
      const constructorNames = constructorCalls.map((c) => c.calleeName);
      expect(constructorNames).toContain("SimpleClass");
      expect(constructorNames).toContain("ClassWithArgs");
      expect(constructorNames).toContain("NestedConstruction");
      expect(constructorNames).toContain("GenericBox");
    });

    it("should extract imports", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "imports.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const importCalls = calls.filter((c) => c.callType === "Import");
      const importNames = importCalls.map((c) => c.calleeName);
      expect(importNames).toContain("parseFile");
      expect(importNames).toContain("hashContent");
      expect(importNames).toContain("Indexer");
      expect(importNames).toContain("Logger");
      expect(importNames).toContain("Database");
    });

    it("should handle nested calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "nested-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("inner");
      expect(callNames).toContain("middle");
      expect(callNames).toContain("deep");
      expect(callNames).toContain("compute");
      expect(callNames).toContain("transform");
      expect(callNames).toContain("getData");
    });

    it("should handle edge cases", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "edge-cases.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("method");
      expect(callNames).toContain("trueCase");
      expect(callNames).toContain("falseCase");
      expect(callNames).toContain("riskyOperation");
      expect(callNames).toContain("handleError");
      expect(callNames).toContain("cleanup");
      expect(callNames).toContain("fetchData");
    });

    describe("php call extraction", () => {
      it("should extract direct function calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const callNames = calls.map((c) => c.calleeName);
        expect(callNames).toContain("directcall");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("compute");

        const directCall = calls.find((c) => c.calleeName === "directcall");
        expect(directCall).toBeDefined();
        expect(directCall!.callType).toBe("Call");
      });

      it("should normalize PHP function names to lowercase", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const helperCalls = calls.filter((c) => c.calleeName === "helper" && c.callType === "Call");
        expect(helperCalls.length).toBe(2);
      });

      it("should extract method calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const methodCalls = calls.filter((c) => c.callType === "MethodCall");
        const methodNames = methodCalls.map((c) => c.calleeName);
        expect(methodNames).toContain("validate");
        expect(methodNames).toContain("add");
        expect(methodNames).toContain("subtract");
      });

      it("should extract nullsafe method calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const resetCall = calls.find((c) => c.calleeName === "reset");
        expect(resetCall).toBeDefined();
        expect(resetCall!.callType).toBe("MethodCall");
      });

      it("should extract static method calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const createCall = calls.find((c) => c.calleeName === "create");
        expect(createCall).toBeDefined();
        expect(createCall!.callType).toBe("MethodCall");
      });

      it("should extract constructor calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-constructors.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const constructorCalls = calls.filter((c) => c.callType === "Constructor");
        const constructorNames = constructorCalls.map((c) => c.calleeName);
        expect(constructorNames).toContain("SimpleClass");
        expect(constructorNames).toContain("ClassWithArgs");
      });

      it("should extract use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("User");
        expect(importNames).toContain("AuthService");
      });

      it("should extract grouped use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("StringHelper");
        expect(importNames).toContain("ArrayHelper");
      });
    });
  });

  describe("call graph storage", () => {
    it("should store symbols in database", () => {
      const db = new Database(path.join(tempDir, "test.db"));
      const symbols: SymbolData[] = [
        {
          id: "sym_001",
          filePath: "/src/foo.ts",
          name: "fooFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_002",
          filePath: "/src/foo.ts",
          name: "barFunc",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];

      db.upsertSymbolsBatch(symbols);
      const retrieved = db.getSymbolsByFile("/src/foo.ts");
      expect(retrieved.length).toBe(2);

      const names = retrieved.map((s) => s.name);
      expect(names).toContain("fooFunc");
      expect(names).toContain("barFunc");

      const byName = db.getSymbolsByName("fooFunc");
      expect(byName.length).toBe(1);
      expect(byName[0]?.filePath).toBe("/src/foo.ts");

      const byNameCi = db.getSymbolsByNameCi("foofunc");
      expect(byNameCi.length).toBe(1);
      expect(byNameCi[0]?.filePath).toBe("/src/foo.ts");
    });

    it("should store call edges", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_a",
          filePath: "/src/a.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_b",
          filePath: "/src/a.ts",
          name: "callee",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_001",
          branch: "test",
          fromSymbolId: "sym_a",
          targetName: "callee",
          callType: "Call",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      db.addSymbolsToBranchBatch("test", ["sym_a", "sym_b"]);
      const callees = db.getCallees("sym_a", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].targetName).toBe("callee");
      expect(callees[0].callType).toBe("Call");
    });

    it("should store branch relationships", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_br1",
          filePath: "/src/x.ts",
          name: "branchFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);
      db.addSymbolsToBranchBatch("main", ["sym_br1"]);

      // Create an edge from sym_br1 targeting "branchFunc" so getCallers can find it
      const edges: CallEdgeData[] = [
        {
          id: "edge_br1",
          branch: "main",
          fromSymbolId: "sym_br1",
          targetName: "branchFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // getCallers filters by branch
      const callers = db.getCallers("branchFunc", "main");
      expect(callers.length).toBe(1);
      expect(callers[0].fromSymbolId).toBe("sym_br1");
    });

    it("filters contextual callers by resolved target symbol id", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_execute_a",
          filePath: "/src/a.ts",
          name: "execute",
          kind: "method",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_execute_b",
          filePath: "/src/b.ts",
          name: "execute",
          kind: "method",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_caller_a",
          filePath: "/src/caller-a.ts",
          name: "callA",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_caller_b",
          filePath: "/src/caller-b.ts",
          name: "callB",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);
      db.addSymbolsToBranchBatch("main", symbols.map((symbol) => symbol.id));

      const edges: CallEdgeData[] = [
        {
          id: "edge_a",
          branch: "main",
          fromSymbolId: "sym_caller_a",
          fromSymbolName: "callA",
          fromSymbolFilePath: "/src/caller-a.ts",
          callerFilePath: "/src/caller-a.ts",
          targetName: "execute",
          targetFilePath: "/src/a.ts",
          targetKind: "method",
          toSymbolId: "sym_execute_a",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: true,
        },
        {
          id: "edge_b",
          branch: "main",
          fromSymbolId: "sym_caller_b",
          fromSymbolName: "callB",
          fromSymbolFilePath: "/src/caller-b.ts",
          callerFilePath: "/src/caller-b.ts",
          targetName: "execute",
          targetFilePath: "/src/b.ts",
          targetKind: "method",
          toSymbolId: "sym_execute_b",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: true,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      const callers = db.getCallersWithContextByTargetSymbolId("sym_execute_a", "main");
      expect(callers).toHaveLength(1);
      expect(callers[0].fromSymbolId).toBe("sym_caller_a");
    });
  });

  describe("call resolution", () => {
    it("should resolve same-file calls", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_caller",
          filePath: "/src/file.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_target",
          filePath: "/src/file.ts",
          name: "target",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 12,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_resolve",
          branch: "test",
          fromSymbolId: "sym_caller",
          targetName: "target",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve the edge
      db.resolveCallEdge("edge_resolve", "test", "sym_target", "/src/file.ts", "function");

      // Verify resolution
      db.addSymbolsToBranchBatch("test", ["sym_caller", "sym_target"]);
      const callees = db.getCallees("sym_caller", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_target");
    });

    it("should leave cross-file calls unresolved", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_local",
          filePath: "/src/local.ts",
          name: "localFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_cross",
          branch: "test",
          fromSymbolId: "sym_local",
          targetName: "externalFunc",
          callType: "Import",
          line: 1,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Don't resolve — it's cross-file
      db.addSymbolsToBranchBatch("test", ["sym_local"]);
      const callees = db.getCallees("sym_local", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });

    it("should handle multiple targets with same name", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_m",
          filePath: "/src/main.ts",
          name: "main",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_a",
          filePath: "/src/a.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_b",
          filePath: "/src/b.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_multi",
          branch: "test",
          fromSymbolId: "sym_caller_m",
          targetName: "helper",
          callType: "Call",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve to only one of the targets
      db.resolveCallEdge("edge_multi", "test", "sym_helper_a", "/src/a.ts", "function");

      db.addSymbolsToBranchBatch("test", ["sym_caller_m", "sym_helper_a", "sym_helper_b"]);
      const callees = db.getCallees("sym_caller_m", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_helper_a");
    });

    it("should keep ambiguous same-file target unresolved", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_amb",
          filePath: "/src/file.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_dup_1",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_dup_2",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 15,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ambiguous",
          branch: "test",
          fromSymbolId: "sym_caller_amb",
          targetName: "dup",
          callType: "Call",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      db.addSymbolsToBranchBatch("test", ["sym_caller_amb", "sym_dup_1", "sym_dup_2"]);
      const callees = db.getCallees("sym_caller_amb", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });
  });

  describe("branch awareness", () => {
    it("should filter symbols by current branch", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_main_1",
          filePath: "/src/main.ts",
          name: "mainFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_feat_1",
          filePath: "/src/feat.ts",
          name: "featFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_main_1"]);
      db.addSymbolsToBranchBatch("feature", ["sym_feat_1"]);

      // Create edges so getCallers can find them
      const edges: CallEdgeData[] = [
        {
          id: "edge_main_1",
          branch: "main",
          fromSymbolId: "sym_main_1",
          targetName: "mainFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_feat_1",
          branch: "feature",
          fromSymbolId: "sym_feat_1",
          targetName: "featFunc",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Query with branch "main" should only return main symbols
      const mainCallers = db.getCallers("mainFunc", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_main_1");

      // Query with branch "main" should not return feature symbols
      const featOnMain = db.getCallers("featFunc", "main");
      expect(featOnMain.length).toBe(0);
    });

    it("should filter call edges by branch", () => {
      const db = new Database(path.join(tempDir, "test.db"));

      const symbols: SymbolData[] = [
        {
          id: "sym_br_a",
          filePath: "/src/a.ts",
          name: "funcA",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_br_b",
          filePath: "/src/b.ts",
          name: "funcB",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_br_a"]);
      db.addSymbolsToBranchBatch("other", ["sym_br_b"]);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ba",
          branch: "main",
          fromSymbolId: "sym_br_a",
          targetName: "sharedTarget",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_bb",
          branch: "other",
          fromSymbolId: "sym_br_b",
          targetName: "sharedTarget",
          callType: "Call",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Only sym_br_a is on "main"
      const mainCallers = db.getCallers("sharedTarget", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_br_a");

      // Only sym_br_b is on "other"
      const otherCallers = db.getCallers("sharedTarget", "other");
      expect(otherCallers.length).toBe(1);
      expect(otherCallers[0].fromSymbolId).toBe("sym_br_b");
    });
  });

  describe("integration", () => {
    it("attributes nested tool calls to the innermost execute method", () => {
      const content = `
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

function someInternalCall() {
  return "ok";
}

export const outer: ToolDefinition = tool({
  async execute() {
    return someInternalCall();
  },
});
`;

      const outerStart = content.indexOf("export const outer");
      const outerEnd = content.indexOf("});", outerStart) + 3;
      const executeStart = content.indexOf("async execute()");
      const executeEnd = content.indexOf("  },", executeStart) + 4;
      const helperStart = content.indexOf("function someInternalCall()");
      const helperEnd = content.indexOf("}\n\nexport", helperStart) + 1;

      const indexer = Object.create(Indexer.prototype) as Indexer;

      const internals = indexer as unknown as {
        buildFileGraphData: (
          parsedFiles: unknown[]
        ) => Map<string, { symbols: SymbolData[]; edges: Array<Omit<CallEdgeData, "branch">> }>;
      };

      const parsedFiles = [
        {
          path: "src/tools.ts",
          content,
          hash: hashContent(content),
          chunks: [
            {
              content: content.slice(helperStart, helperEnd),
              startLine: 4,
              endLine: 6,
              startByte: helperStart,
              endByte: helperEnd,
              chunkType: "function",
              name: "someInternalCall",
              language: "typescript",
              chunkHash: hashContent(content.slice(helperStart, helperEnd)),
            },
            {
              content: content.slice(outerStart, outerEnd),
              startLine: 8,
              endLine: 12,
              startByte: outerStart,
              endByte: outerEnd,
              chunkType: "module",
              name: "outer",
              language: "typescript",
              chunkHash: hashContent(content.slice(outerStart, outerEnd)),
            },
            {
              content: content.slice(executeStart, executeEnd),
              startLine: 9,
              endLine: 11,
              startByte: executeStart,
              endByte: executeEnd,
              chunkType: "method",
              name: "execute",
              language: "typescript",
              chunkHash: hashContent(content.slice(executeStart, executeEnd)),
            },
          ],
        },
      ];

      const graph = internals.buildFileGraphData(parsedFiles).get("src/tools.ts");
      expect(graph).toBeDefined();

      const internalCallEdge = graph?.edges.find((edge) => edge.targetName === "someInternalCall");
      expect(internalCallEdge).toBeDefined();

      const fromSymbol = graph?.symbols.find((symbol) => symbol.id === internalCallEdge?.fromSymbolId);
      expect(graph?.symbols.some((symbol) => symbol.name === "outer")).toBe(true);
      expect(graph?.symbols.some((symbol) => symbol.name === "execute")).toBe(true);
      expect(fromSymbol?.name).toBe("execute");
    });

    it("should build complete call graph for simple project", () => {
      const db = new Database(path.join(tempDir, "test.db"));
      const content = fs.readFileSync(path.join(fixturesDir, "same-file-refs.ts"), "utf-8");
      const filePath = path.join(fixturesDir, "same-file-refs.ts");

      // Extract calls
      const callSites = extractCalls(content, "typescript");
      expect(callSites.length).toBeGreaterThan(0);

      // Build symbols from known functions in the fixture
      const functionDefs = [
        { name: "entryPoint", startLine: 5, endLine: 13 },
        { name: "helperA", startLine: 15, endLine: 18 },
        { name: "helperB", startLine: 20, endLine: 22 },
        { name: "internalUtil", startLine: 24, endLine: 26 },
        { name: "MyClass", startLine: 28, endLine: 41 },
        { name: "outerScope", startLine: 54, endLine: 60 },
        { name: "fibonacci", startLine: 63, endLine: 66 },
        { name: "evenOdd", startLine: 68, endLine: 71 },
        { name: "isOdd", startLine: 73, endLine: 76 },
        { name: "exported", startLine: 79, endLine: 81 },
      ];

      const symbols: SymbolData[] = functionDefs.map((def) => ({
        id: `sym_${hashContent(filePath + ":" + def.name + ":function:" + def.startLine).slice(0, 16)}`,
        filePath,
        name: def.name,
        kind: "function",
        startLine: def.startLine,
        startCol: 0,
        endLine: def.endLine,
        endCol: 0,
        language: "typescript",
      }));

      db.upsertSymbolsBatch(symbols);

      // Build edges from call sites
      const edges: CallEdgeData[] = [];
      for (const site of callSites) {
        const enclosing = symbols.find(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine
        );
        if (!enclosing) continue;

        const edgeId = `edge_${hashContent(enclosing.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
        edges.push({
          id: edgeId,
          branch: "main",
          fromSymbolId: enclosing.id,
          targetName: site.calleeName,
          callType: site.callType,
          line: site.line,
          col: site.column,
          isResolved: false,
        });
      }

      expect(edges.length).toBeGreaterThan(0);
      db.upsertCallEdgesBatch(edges);

      // Resolve same-file calls
      for (const edge of edges) {
        const matchingSymbol = symbols.find((sym) => sym.name === edge.targetName);
        if (matchingSymbol) {
          db.resolveCallEdge(edge.id, "main", matchingSymbol.id, matchingSymbol.filePath, matchingSymbol.kind);
        }
      }

      // Add symbols to branch
      db.addSymbolsToBranchBatch("main", symbols.map((s) => s.id));

      // Verify: helperA should be called by entryPoint, arrowFunc, outerScope (innerScope), exported
      const helperACallers = db.getCallers("helperA", "main");
      expect(helperACallers.length).toBeGreaterThan(0);

      // Verify: helperB should be called by entryPoint and helperA
      const helperBCallers = db.getCallers("helperB", "main");
      expect(helperBCallers.length).toBeGreaterThan(0);

      // Verify entryPoint's callees
      const entryPointSymbol = symbols.find((s) => s.name === "entryPoint");
      expect(entryPointSymbol).toBeDefined();
      const entryCallees = db.getCallees(entryPointSymbol!.id, "main");
      expect(entryCallees.length).toBeGreaterThan(0);

      const entryCalleeNames = entryCallees.map((e) => e.targetName);
      expect(entryCalleeNames).toContain("helperA");
      expect(entryCalleeNames).toContain("helperB");

      // Verify resolved edges have toSymbolId set
      const resolvedCallees = entryCallees.filter((e) => e.isResolved);
      expect(resolvedCallees.length).toBeGreaterThan(0);
      for (const resolved of resolvedCallees) {
        expect(resolved.toSymbolId).toBeDefined();
      }
    });
  });
});
