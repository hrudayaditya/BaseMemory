export type DefinitionWinnerCategory =
  | "wrapper-export"
  | "options-shape"
  | "type-interface"
  | "module"
  | "implementation"
  | "test"
  | "doc"
  | "other";

export interface DefinitionPolicyStageLike {
  reason: string;
}

export interface DefinitionPolicyCandidateInput {
  query: string;
  filePath: string;
  chunkType: string;
  name?: string | null;
  stages?: DefinitionPolicyStageLike[] | null;
  expectedFilePath?: string | null;
}

export interface DefinitionImplementationPolicy {
  wrapperExportPenalty: number;
  optionsShapePenalty: number;
  typeInterfacePenalty: number;
  modulePenalty: number;
  implementationBonus: number;
  sameFileImplementationBonus: number;
}

export const CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY: DefinitionImplementationPolicy = {
  wrapperExportPenalty: 0.05,
  optionsShapePenalty: 0.08,
  typeInterfacePenalty: 0.06,
  modulePenalty: 0.04,
  implementationBonus: 0.035,
  sameFileImplementationBonus: 0.025,
};

export function isLikelyTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|test)(\/|$)|\.(test|spec)\.[cm]?[tj]sx?$/i.test(filePath);
}

export function isLikelyDocPath(filePath: string): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i.test(filePath);
}

export function isImplementationSeekingDefinitionQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return /\b(?:function|method|helper|factory|routine|implementation|defined|wrap|wraps|return|returns|create|creates|parse|parses|read|reads|call|calls|build|builds|implemented)\b/.test(lower);
}

export function hasExactSymbolEvidence(stages: DefinitionPolicyStageLike[] | null | undefined): boolean {
  return (stages ?? []).some((stage) => /identifierQuality=exact-symbol\b/.test(stage.reason));
}

export function classifyDefinitionWinnerCategory(
  filePath: string,
  chunkType: string,
  name?: string | null
): DefinitionWinnerCategory {
  if (isLikelyTestPath(filePath)) return "test";
  if (isLikelyDocPath(filePath)) return "doc";
  if (chunkType === "module" && (name ?? "").startsWith("export{")) return "wrapper-export";
  if ((chunkType === "type" || chunkType === "interface") && /(Options|Config|Params|Args|Props)$/.test(name ?? "")) {
    return "options-shape";
  }
  if (chunkType === "type" || chunkType === "interface") return "type-interface";
  if (chunkType === "module") return "module";
  if (["function", "method", "class", "constant"].includes(chunkType)) return "implementation";
  return "other";
}

export function getDefinitionImplementationPenalty(
  input: DefinitionPolicyCandidateInput,
  policy: DefinitionImplementationPolicy = CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY
): number {
  if (!isImplementationSeekingDefinitionQuery(input.query)) {
    return 0;
  }
  if (hasExactSymbolEvidence(input.stages)) {
    return 0;
  }

  switch (classifyDefinitionWinnerCategory(input.filePath, input.chunkType, input.name)) {
    case "wrapper-export":
      return policy.wrapperExportPenalty;
    case "options-shape":
      return policy.optionsShapePenalty;
    case "type-interface":
      return policy.typeInterfacePenalty;
    case "module":
      return policy.modulePenalty;
    default:
      return 0;
  }
}

export function getDefinitionImplementationBonus(
  input: DefinitionPolicyCandidateInput,
  policy: DefinitionImplementationPolicy = CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY
): number {
  if (!isImplementationSeekingDefinitionQuery(input.query)) {
    return 0;
  }
  if (hasExactSymbolEvidence(input.stages)) {
    return 0;
  }
  if (classifyDefinitionWinnerCategory(input.filePath, input.chunkType, input.name) !== "implementation") {
    return 0;
  }

  const sameExpectedFile = Boolean(
    input.expectedFilePath &&
    input.filePath.replaceAll("\\", "/").endsWith(input.expectedFilePath.replaceAll("\\", "/"))
  );

  return policy.implementationBonus + (sameExpectedFile ? policy.sameFileImplementationBonus : 0);
}
