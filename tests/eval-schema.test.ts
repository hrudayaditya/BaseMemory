import { describe, expect, it } from "vitest";

import { parseBudget, parseGoldenDataset } from "../src/eval/schema.js";

describe("eval schema", () => {
  it("parses a valid dataset", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "where is rankHybridResults implementation",
            queryType: "definition",
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.name).toBe("small");
    expect(dataset.queries).toHaveLength(1);
  });

  it("allows queries without queryType", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "where is rankHybridResults implementation",
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0].queryType).toBeUndefined();
  });

  it("parses extended query types and line ranges", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "what tests cover auth?",
            queryType: "test-discovery",
            expected: {
              filePath: "tests/auth.test.ts",
              symbol: "auth spec",
              startLine: 10,
              endLine: 20,
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0].queryType).toBe("test-discovery");
    expect(dataset.queries[0].expected.startLine).toBe(10);
    expect(dataset.queries[0].expected.endLine).toBe(20);
  });

  it("parses query provenance metadata and snake_case query_type", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "EMBEDDING_INPUT_FORMAT_VERSION",
            query_type: "identifier-heavy",
            source: "generated",
            heuristic: "identifier-extraction-from-symbol-content",
            expected: {
              filePath: "src/native/index.ts",
              symbol: "EMBEDDING_INPUT_FORMAT_VERSION",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0].queryType).toBe("identifier-heavy");
    expect(dataset.queries[0].source).toBe("generated");
    expect(dataset.queries[0].heuristic).toBe("identifier-extraction-from-symbol-content");
  });

  it("accepts an explicit taskType alias on golden queries", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "find similar code",
            taskType: "semantic",
            expected: {
              filePath: "src/indexer/index.ts",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0].taskType).toBe("semantic");
  });

  it("rejects dataset with missing expected path", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "definition",
              expected: {},
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/expected.filePath or expected.acceptableFiles/);
  });

  it("rejects duplicate query ids", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "a",
              queryType: "definition",
              expected: { filePath: "a.ts" },
            },
            {
              id: "q1",
              query: "b",
              queryType: "definition",
              expected: { filePath: "b.ts" },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/duplicate id/);
  });

  it("rejects generated queries without heuristics", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              source: "generated",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/heuristic must be provided for generated queries/);
  });

  it("parses budget and validates threshold types", () => {
    const budget = parseBudget(
      {
        name: "default",
        baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
        failOnMissingBaseline: true,
        thresholds: {
          hitAt1MaxDrop: 0.05,
          hitAt5MaxDrop: 0.05,
          mrrAt10MaxDrop: 0.02,
          combinedRecallAt10: 0.05,
          expansionHitRate: 0.1,
          p95LatencyMaxMultiplier: 1.5,
          minHitAt1: 0.2,
        },
      },
      "budget.json"
    );

    expect(budget.thresholds.hitAt1MaxDrop).toBe(0.05);
    expect(budget.thresholds.hitAt5MaxDrop).toBe(0.05);
    expect(budget.thresholds.combinedRecallAt10MaxDrop).toBe(0.05);
    expect(budget.thresholds.expansionHitRateMaxDrop).toBe(0.1);
    expect(budget.thresholds.minHitAt1).toBe(0.2);
    expect(budget.failOnMissingBaseline).toBe(true);
  });

  it("rejects partial or invalid expected line ranges", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where",
              expected: {
                filePath: "a.ts",
                startLine: 10,
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/endLine/);

    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where",
              expected: {
                filePath: "a.ts",
                startLine: 20,
                endLine: 10,
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/startLine must be less than or equal/);
  });

  it("rejects invalid threshold types", () => {
    expect(() =>
      parseBudget(
        {
          name: "default",
          thresholds: {
            hitAt5MaxDrop: "bad",
          },
        },
        "budget.json"
      )
    ).toThrow(/must be a non-negative number/);
  });
});
