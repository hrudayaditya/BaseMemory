import * as path from "path";

import { describe, expect, it } from "vitest";

import { loadGoldenDataset } from "../src/eval/schema.js";
import type { GoldenQueryType } from "../src/eval/types.js";
import { getSearchRecipe, mapEvalQueryTypeToTaskType } from "../src/indexer/search-recipes.js";

describe("search recipes", () => {
  it("assigns the expected general-search retrieval profile", () => {
    const general = getSearchRecipe("general");

    expect(general.finalRerankTopN).toBe(10);
    expect(general.graphDepth ?? 0).toBe(0);
    expect(general.bm25Weight).toBe(0.2);
    expect(general.denseWeight).toBe(0.6);
    expect(general.voyageWeight).toBe(0.2);
    expect(general.identifierBoost).toBe(1.0);
    expect(general.enableIdentifierPromotion).toBe(true);
    expect(general.enableSymbolDefinitionLane).toBe(true);
    expect(general.pathPreference).toBe("auto");
  });

  it("assigns the expected definition-search retrieval profile", () => {
    const definition = getSearchRecipe("definition");

    expect(definition.forceDefinitionIntent).toBe(true);
    expect(definition.pathPreference).toBe("source");
    expect(definition.graphDepth).toBe(1);
    expect(definition.finalRerankTopN).toBe(20);
    expect(definition.bm25Weight).toBe(0.5);
    expect(definition.denseWeight).toBe(0.2);
    expect(definition.voyageWeight).toBe(0.3);
    expect(definition.identifierBoost).toBe(2.0);
    expect(definition.testDocChunkPenalty).toBe(0.5);
  });

  it("assigns the expected bug-search retrieval profile", () => {
    const recipe = getSearchRecipe("bug");

    expect(recipe.graphDepth).toBe(1);
    expect(recipe.finalRerankTopN).toBe(20);
    expect(recipe.bm25Weight).toBe(0.4);
    expect(recipe.denseWeight).toBe(0.2);
    expect(recipe.voyageWeight).toBe(0.4);
    expect(recipe.identifierBoost).toBe(1.8);
    expect(recipe.pathPreference).toBe("source");
  });

  it("assigns the expected test-debug retrieval profile", () => {
    const recipe = getSearchRecipe("test_debug");

    expect(recipe.graphDepth).toBe(1);
    expect(recipe.finalRerankTopN).toBe(20);
    expect(recipe.bm25Weight).toBe(0.4);
    expect(recipe.denseWeight).toBe(0.2);
    expect(recipe.voyageWeight).toBe(0.4);
    expect(recipe.identifierBoost).toBe(1.5);
  });

  it("assigns the expected semantic retrieval profile", () => {
    const recipe = getSearchRecipe("semantic");

    expect(recipe.finalRerankTopN).toBe(0);
    expect(recipe.graphDepth ?? 0).toBe(0);
    expect(recipe.bm25Weight).toBe(0.1);
    expect(recipe.denseWeight).toBe(0.7);
    expect(recipe.voyageWeight).toBe(0.2);
    expect(recipe.identifierBoost).toBe(1.0);
    expect(recipe.testDocChunkPenalty).toBe(0.45);
  });

  it("does not apply test/doc chunk damping to test_debug", () => {
    const recipe = getSearchRecipe("test_debug");

    expect(recipe.testDocChunkPenalty).toBeUndefined();
  });

  it("maps eval query types into explicit task recipes", () => {
    expect(mapEvalQueryTypeToTaskType("definition")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("identifier-heavy")).toBe("general");
    expect(mapEvalQueryTypeToTaskType("implementation-intent")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("config-lookup")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("config-constant-lookup")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("cross-file-relationship")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("test-discovery")).toBe("test_debug");
    expect(mapEvalQueryTypeToTaskType("bug-report")).toBe("bug");
    expect(mapEvalQueryTypeToTaskType("bug-error-lookup")).toBe("bug");
    expect(mapEvalQueryTypeToTaskType("similarity")).toBe("semantic");
    expect(mapEvalQueryTypeToTaskType("file-intent")).toBe("semantic");
    expect(mapEvalQueryTypeToTaskType("concept")).toBe("semantic");
    expect(mapEvalQueryTypeToTaskType("keyword-heavy")).toBe("general");
  });

  it("covers every queryType currently used by the small golden dataset", () => {
    const dataset = loadGoldenDataset(
      path.join(process.cwd(), "benchmarks", "golden", "small.json")
    );
    const queryTypes = Array.from(new Set(dataset.queries.flatMap((query) => {
      return query.queryType ? [query.queryType] : [];
    }))) as GoldenQueryType[];

    expect(queryTypes).toEqual([
      "definition",
      "implementation-intent",
      "similarity",
      "keyword-heavy",
      "config-lookup",
      "test-discovery",
      "bug-report",
      "cross-file-relationship",
      "file-intent",
      "concept",
    ]);
    expect(queryTypes.map((queryType) => mapEvalQueryTypeToTaskType(queryType))).toEqual([
      "definition",
      "definition",
      "semantic",
      "general",
      "definition",
      "test_debug",
      "bug",
      "definition",
      "semantic",
      "semantic",
    ]);
  });

  it("covers the canonical curated benchmark query types", () => {
    const dataset = loadGoldenDataset(
      path.join(process.cwd(), "benchmarks", "golden", "cross-repo-curated", "BaseMemory.json")
    );
    const queryTypes = Array.from(new Set(dataset.queries.flatMap((query) => {
      return query.queryType ? [query.queryType] : [];
    }))) as GoldenQueryType[];

    expect(queryTypes).toEqual([
      "definition",
      "identifier-heavy",
      "cross-file-relationship",
      "bug-error-lookup",
      "config-constant-lookup",
    ]);
  });
});
