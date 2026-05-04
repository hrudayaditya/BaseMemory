import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

describe("tool definition representation", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "representation-gap-"));
    fs.mkdirSync(path.join(tempDir, "src", "tools"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "tools", "index.ts"),
      fs.readFileSync(path.join(process.cwd(), "src", "tools", "index.ts"), "utf-8"),
      "utf-8"
    );

    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes exported tool constants into the symbol index", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = new Indexer(tempDir, config);
    await indexer.index();

    const internals = indexer as unknown as {
      ensureInitialized: () => Promise<{
        database: {
          getSymbolsByName: (name: string) => Array<{ filePath: string; name: string }>;
        };
      }>;
    };
    const { database } = await internals.ensureInitialized();

    for (const symbolName of [
      "codebase_peek",
      "index_codebase",
      "find_similar",
      "codebase_search",
      "implementation_lookup",
      "call_graph",
    ]) {
      const matches = database.getSymbolsByName(symbolName);
      expect(matches.length, `missing symbol ${symbolName}`).toBeGreaterThan(0);
      expect(matches[0]?.filePath).toContain("/src/tools/index.ts");
      expect(matches[0]?.name).toBe(symbolName);
    }
  });
});
