export const SEARCH_TASK_TYPES = [
  "general",
  "definition",
  "bug",
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
  voyageWeight?: number;
  identifierBoost?: number;
  forceDefinitionIntent: boolean;
  pathPreference: SearchPathPreference;
  enableIdentifierPromotion: boolean;
  enableDeterministicIdentifierLane: boolean;
  enableIdentifierDefinitionLane: boolean;
  enableSymbolDefinitionLane: boolean;
  implementationOnlyOnCodeHints: boolean;
  testDocChunkPenalty?: number;
  finalRerankTopN: number;
}

export const DEFAULT_FINAL_RERANK_TOP_N = 20;
export const GENERAL_FINAL_RERANK_TOP_N = 10;

const RECIPE_BY_TASK_TYPE: Record<SearchTaskType, SearchRecipe> = {
  general: {
    taskType: "general",
    hybridWeight: 0.3,
    bm25Weight: 0.2,
    denseWeight: 0.6,
    voyageWeight: 0.2,
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
    hybridWeight: 0.5,
    graphDepth: 1,
    bm25Weight: 0.5,
    denseWeight: 0.2,
    voyageWeight: 0.3,
    identifierBoost: 2.0,
    forceDefinitionIntent: true,
    pathPreference: "source",
    enableIdentifierPromotion: true,
    enableDeterministicIdentifierLane: true,
    enableIdentifierDefinitionLane: true,
    enableSymbolDefinitionLane: true,
    implementationOnlyOnCodeHints: true,
    testDocChunkPenalty: 0.7,
    finalRerankTopN: DEFAULT_FINAL_RERANK_TOP_N,
  },
  bug: {
    taskType: "bug",
    hybridWeight: 0.4,
    graphDepth: 1,
    bm25Weight: 0.4,
    denseWeight: 0.2,
    voyageWeight: 0.4,
    identifierBoost: 1.8,
    forceDefinitionIntent: false,
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
    hybridWeight: 0.4,
    graphDepth: 1,
    bm25Weight: 0.4,
    denseWeight: 0.2,
    voyageWeight: 0.4,
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
    hybridWeight: 0.1,
    bm25Weight: 0.1,
    denseWeight: 0.7,
    voyageWeight: 0.2,
    identifierBoost: 1.0,
    forceDefinitionIntent: false,
    pathPreference: "balanced",
    enableIdentifierPromotion: false,
    enableDeterministicIdentifierLane: false,
    enableIdentifierDefinitionLane: false,
    enableSymbolDefinitionLane: false,
    implementationOnlyOnCodeHints: false,
    testDocChunkPenalty: 0.6,
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
  queryType:
    | "definition"
    | "identifier-heavy"
    | "implementation-intent"
    | "similarity"
    | "keyword-heavy"
    | "config-lookup"
    | "config-constant-lookup"
    | "test-discovery"
    | "bug-report"
    | "bug-error-lookup"
    | "cross-file-relationship"
    | "file-intent"
    | "concept"
): SearchTaskType {
  switch (queryType) {
    case "definition":
    case "implementation-intent":
    case "config-constant-lookup":
    case "config-lookup":
    case "cross-file-relationship":
      return "definition";
    case "test-discovery":
      return "test_debug";
    case "bug-report":
    case "bug-error-lookup":
      return "bug";
    case "identifier-heavy":
      return "general";
    case "similarity":
    case "file-intent":
    case "concept":
      return "semantic";
    case "keyword-heavy":
      return "general";
  }
}
