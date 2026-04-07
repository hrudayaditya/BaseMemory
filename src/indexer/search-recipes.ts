export const SEARCH_TASK_TYPES = [
  "general",
  "definition",
  "test_debug",
  "semantic",
] as const;

export type SearchTaskType = (typeof SEARCH_TASK_TYPES)[number];

export type SearchPathPreference = "auto" | "source" | "test" | "balanced";

export interface SearchRecipe {
  taskType: SearchTaskType;
  hybridWeight: number | null;
  forceDefinitionIntent: boolean;
  pathPreference: SearchPathPreference;
  enableIdentifierPromotion: boolean;
  enableDeterministicIdentifierLane: boolean;
  enableIdentifierDefinitionLane: boolean;
  enableSymbolDefinitionLane: boolean;
  implementationOnlyOnCodeHints: boolean;
  finalRerankTopN: number;
}

export const DEFAULT_FINAL_RERANK_TOP_N = 20;

const RECIPE_BY_TASK_TYPE: Record<SearchTaskType, SearchRecipe> = {
  general: {
    taskType: "general",
    hybridWeight: null,
    forceDefinitionIntent: false,
    pathPreference: "auto",
    enableIdentifierPromotion: true,
    enableDeterministicIdentifierLane: true,
    enableIdentifierDefinitionLane: true,
    enableSymbolDefinitionLane: true,
    implementationOnlyOnCodeHints: true,
    // The real cross-encoder backend is implemented, but leaving it on for the
    // default recipe regressed the golden eval set. Keep general on the proven
    // baseline order until the backend/model is strong enough to clear the gate.
    finalRerankTopN: 0,
  },
  definition: {
    taskType: "definition",
    hybridWeight: 0.6,
    forceDefinitionIntent: true,
    pathPreference: "source",
    enableIdentifierPromotion: true,
    enableDeterministicIdentifierLane: true,
    enableIdentifierDefinitionLane: true,
    enableSymbolDefinitionLane: true,
    implementationOnlyOnCodeHints: true,
    finalRerankTopN: DEFAULT_FINAL_RERANK_TOP_N,
  },
  test_debug: {
    taskType: "test_debug",
    hybridWeight: 0.45,
    forceDefinitionIntent: false,
    pathPreference: "test",
    enableIdentifierPromotion: false,
    enableDeterministicIdentifierLane: false,
    enableIdentifierDefinitionLane: false,
    enableSymbolDefinitionLane: false,
    implementationOnlyOnCodeHints: false,
    finalRerankTopN: DEFAULT_FINAL_RERANK_TOP_N,
  },
  semantic: {
    taskType: "semantic",
    hybridWeight: 0.25,
    forceDefinitionIntent: false,
    pathPreference: "balanced",
    enableIdentifierPromotion: false,
    enableDeterministicIdentifierLane: false,
    enableIdentifierDefinitionLane: false,
    enableSymbolDefinitionLane: false,
    implementationOnlyOnCodeHints: false,
    finalRerankTopN: DEFAULT_FINAL_RERANK_TOP_N,
  },
};

export function getSearchRecipe(taskType: SearchTaskType = "general"): SearchRecipe {
  return RECIPE_BY_TASK_TYPE[taskType];
}

export function isSearchTaskType(value: string): value is SearchTaskType {
  return SEARCH_TASK_TYPES.includes(value as SearchTaskType);
}

export function mapEvalQueryTypeToTaskType(
  queryType: "definition" | "implementation-intent" | "similarity" | "keyword-heavy"
): SearchTaskType {
  switch (queryType) {
    case "definition":
    case "implementation-intent":
      return "definition";
    case "similarity":
      return "semantic";
    case "keyword-heavy":
      return "general";
  }
}
