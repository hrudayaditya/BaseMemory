import { describe, expect, it } from "vitest";

import { inferRelationshipGraphDirection, inferSubIntent, inferTaskType } from "../src/indexer/index.js";
import { getSearchRecipe } from "../src/indexer/search-recipes.js";

describe("relationship query routing", () => {
  it("routes caller phrasing to the graph-aware definition recipe", () => {
    const queries = [
      "what calls buildPerQueryResult",
      "who uses parseConfig",
      "callers of loadEnv",
      "where is initDb called",
    ];

    for (const query of queries) {
      const taskType = inferTaskType(query);
      const recipe = getSearchRecipe(taskType);

      expect(taskType).toBe("definition");
      expect(inferRelationshipGraphDirection(query)).toBe("caller");
      expect(recipe.graphDepth ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("routes callee phrasing to the graph-aware definition recipe", () => {
    const queries = [
      "what does rerankResults call",
      "what does finalizeEvaluationRun depend on",
      "callees of searchEntry",
    ];

    for (const query of queries) {
      const taskType = inferTaskType(query);
      const recipe = getSearchRecipe(taskType);

      expect(taskType).toBe("definition");
      expect(inferRelationshipGraphDirection(query)).toBe("callee");
      expect(recipe.graphDepth ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not route unrelated intent queries to the relationship path", () => {
    const query = "how does authentication work";

    expect(inferTaskType(query)).toBe("general");
    expect(inferRelationshipGraphDirection(query)).toBeNull();
  });

  it("classifies executable definition sub-intent from definition lookup phrasing", () => {
    expect(inferSubIntent("where is createBuilder defined", "definition")).toBe("definition:executable");
    expect(
      inferSubIntent(
        "where is the singleton builder object exported that every tRPC server bootstraps from exactly once",
        "definition"
      )
    ).toBe("definition:executable");
  });

  it("classifies declarative definition sub-intent from type/shape phrasing", () => {
    expect(inferSubIntent("what type represents the router config", "definition")).toBe("definition:declarative");
  });

  it("reuses relationship graph direction for caller sub-intent", () => {
    const query = "what calls mapEvalQueryTypeToTaskType";
    expect(inferRelationshipGraphDirection(query)).toBe("caller");
    expect(inferSubIntent(query, "definition")).toBe("relationship:caller");
  });

  it("detects error-source bug sub-intent from exception-like phrasing", () => {
    expect(inferSubIntent("TypeError: Cannot read properties of undefined", "bug")).toBe("bug:error-source");
    expect(inferSubIntent("throws TRPCClientError when the request fails", "bug")).toBe("bug:error-source");
    expect(
      inferSubIntent(
        "where does bootstrapping the root object throw if the runtime is treated as non-server",
        "bug"
      )
    ).toBe("bug:error-source");
  });

  it("classifies agentic bug-owner phrasing as bug behavior-owner", () => {
    expect(
      inferSubIntent(
        "find the code path that discards successful Voyage embeddings when Arctic fails",
        "bug"
      )
    ).toBe("bug:behavior-owner");
    expect(
      inferSubIntent(
        "find the branch filtering fallback bug for a branch literally named default",
        "bug"
      )
    ).toBe("bug:behavior-owner");
  });

  it("returns null for ambiguous queries instead of forcing a sub-intent", () => {
    expect(inferSubIntent("find code related to routing", "general")).toBeNull();
  });

  it("classifies adapter and handler forwarding patterns as relationship callees", () => {
    expect(
      inferSubIntent(
        "which Node IncomingMessage handler awaits the shared resolveResponse after wrapping the socket pair as a Request",
        "definition"
      )
    ).toBe("relationship:callee");
    expect(
      inferSubIntent(
        "what exported fetch adapter entrypoint forwards the trimmed path and Request into the shared HTTP resolver",
        "definition"
      )
    ).toBe("relationship:callee");
  });

  it("lets the outer definition frame win over relationship vocabulary", () => {
    expect(
      inferSubIntent(
        "where is the factory that returns the mutable procedure builder used by initTRPC.procedure defined",
        "definition"
      )
    ).toBe("definition:executable");
  });

  it("classifies broader framework/runtime phrasing as concept implementation", () => {
    expect(
      inferSubIntent(
        "where does the runtime decode newline-delimited JSON RPC chunks from a readable byte stream on the consumer side",
        "semantic"
      )
    ).toBe("concept:implementation");
    expect(
      inferSubIntent(
        "where are periodic ping symbols merged into an async iterable so idle streams still emit heartbeats",
        "semantic"
      )
    ).toBe("concept:implementation");
    expect(inferSubIntent("which file implements the eval runner", "semantic")).toBe("concept:implementation");
    expect(
      inferSubIntent("what function writes eval artifacts and final summary output", "semantic")
    ).toBe("concept:implementation");
  });

  it("classifies file ownership phrasing as concept architecture", () => {
    expect(inferSubIntent("which file owns graph expansion", "semantic")).toBe("concept:architecture");
  });

  it("classifies broader test discovery phrasing", () => {
    expect(
      inferSubIntent(
        "what integration tests exercise the fetch request handler adapter end to end",
        "test_debug"
      )
    ).toBe("test:discovery");
    expect(
      inferSubIntent(
        "what tests validate initTRPC context meta and transformer typing behavior",
        "test_debug"
      )
    ).toBe("test:discovery");
    expect(
      inferSubIntent(
        "show me the graph expansion search integration tests",
        "test_debug"
      )
    ).toBe("test:discovery");
  });

  it("classifies config hunts as declarative definition sub-intent", () => {
    expect(
      inferSubIntent(
        "show me where fusionStrategy hybridWeight rrfK and rerankTopN are defined in config",
        "general"
      )
    ).toBe("definition:declarative");
  });
});
