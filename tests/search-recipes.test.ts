import * as path from "path";

import { describe, expect, it } from "vitest";

import { loadGoldenDataset } from "../src/eval/schema.js";
import type { GoldenQueryType } from "../src/eval/types.js";
import { getSearchRecipe, mapEvalQueryTypeToTaskType } from "../src/indexer/search-recipes.js";

describe("search recipes", () => {
  it("keeps general behavior on the non-reranked baseline", () => {
    const general = getSearchRecipe("general");

    expect(general.finalRerankTopN).toBe(0);
    expect(general.enableIdentifierPromotion).toBe(true);
    expect(general.enableSymbolDefinitionLane).toBe(true);
    expect(general.pathPreference).toBe("auto");
  });

  it("weights definition retrieval differently than general", () => {
    const general = getSearchRecipe("general");
    const definition = getSearchRecipe("definition");

    expect(definition.forceDefinitionIntent).toBe(true);
    expect(definition.pathPreference).toBe("source");
    expect(definition.finalRerankTopN).toBeGreaterThan(general.finalRerankTopN);
    expect(definition.hybridWeight).not.toBe(general.hybridWeight);
  });

  it("maps eval query types into explicit task recipes", () => {
    expect(mapEvalQueryTypeToTaskType("definition")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("implementation-intent")).toBe("definition");
    expect(mapEvalQueryTypeToTaskType("similarity")).toBe("semantic");
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
    ]);
    expect(queryTypes.map((queryType) => mapEvalQueryTypeToTaskType(queryType))).toEqual([
      "definition",
      "definition",
      "semantic",
      "general",
    ]);
  });
});
