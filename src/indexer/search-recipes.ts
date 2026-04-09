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
  graphDepth?: number;
  bm25Weight?: number;
  denseWeight?: number;
  identifierBoost?: number;
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
export const GENERAL_FINAL_RERANK_TOP_N = 10;

const RECIPE_BY_TASK_TYPE: Record<SearchTaskType, SearchRecipe> = {
  general: {
    taskType: "general",
    hybridWeight: 0.3,
    bm25Weight: 0.3,
    denseWeight: 0.7,
    identifierBoost: 1.0,
    forceDefinitionIntent: false,
    pathPreference: "auto",
    enableIdentifierPromotion: true,
    enableDeterministicIdentifierLane: true,
    enableIdentifierDefinitionLane: true,
    enableSymbolDefinitionLane: true,
    implementationOnlyOnCodeHints: true,
    finalRerankTopN: GENERAL_FINAL_RERANK_TOP_N,
  },
  definition: {
    taskType: "definition",
    hybridWeight: 0.7,
    graphDepth: 1,
    bm25Weight: 0.7,
    denseWeight: 0.3,
    identifierBoost: 2.0,
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
    hybridWeight: 0.5,
    graphDepth: 1,
    bm25Weight: 0.5,
    denseWeight: 0.5,
    identifierBoost: 1.5,
    forceDefinitionIntent: false,
    pathPreference: "test",
    enableIdentifierPromotion: true,
    enableDeterministicIdentifierLane: false,
    enableIdentifierDefinitionLane: false,
    enableSymbolDefinitionLane: false,
    implementationOnlyOnCodeHints: false,
    finalRerankTopN: DEFAULT_FINAL_RERANK_TOP_N,
  },
  semantic: {
    taskType: "semantic",
    hybridWeight: 0.2,
    bm25Weight: 0.2,
    denseWeight: 0.8,
    identifierBoost: 1.0,
    forceDefinitionIntent: false,
    pathPreference: "balanced",
    enableIdentifierPromotion: false,
    enableDeterministicIdentifierLane: false,
    enableIdentifierDefinitionLane: false,
    enableSymbolDefinitionLane: false,
    implementationOnlyOnCodeHints: false,
    finalRerankTopN: 0,
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
