import { describe, expect, it } from "vitest";

import { inferRelationshipGraphDirection, inferTaskType } from "../src/indexer/index.js";
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
});
