import { existsSync, readFileSync } from "fs";
import * as path from "path";

type IdentifierQuality =
  | "exact-symbol"
  | "alias-symbol"
  | "file-anchored-symbol"
  | "compound-symbol"
  | "weak-substring"
  | "path-only"
  | "type-only"
  | "unknown";

type CompoundSpecificity =
  | "strong-compound"
  | "generic-compound"
  | "mixed-compound"
  | "not-compound"
  | "unknown";

type PolicyName = "conservative" | "balanced" | "aggressive";
type SimulationScope = "definition-risk" | "all";

interface Expected {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

interface GoldenQuery {
  id: string;
  query: string;
  queryType?: string;
  expected: Expected;
}

interface DatasetArtifact {
  queries: GoldenQuery[];
}

interface ScoreStage {
  name: string;
  kind: string;
  before: number;
  after: number;
  reason: string;
}

interface ScoreBreakdown {
  stages?: ScoreStage[];
  preRerankScore?: number;
  finalScore?: number;
  reranker?: {
    score: number;
    rank: number;
    backend: string;
  };
}

interface EvalResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string | null;
  scoreBreakdown?: ScoreBreakdown | null;
}

interface PerQuery {
  id: string;
  query: string;
  queryType?: string;
  effectiveTaskType?: string;
  hitAt1?: boolean;
  hitAt10?: boolean;
  failureBucket?: string;
  results: EvalResult[];
}

interface PerQueryArtifact {
  queries: PerQuery[];
}

interface SummaryArtifact {
  projectRoot?: string;
  datasetPath?: string;
}

interface LoadedArtifact {
  artifactDir: string;
  perQuery: PerQueryArtifact;
  summary: SummaryArtifact;
  dataset: DatasetArtifact;
}

interface Policy {
  name: PolicyName;
  description: string;
  floors: Record<IdentifierQuality, number | null>;
  additiveMultipliers: Record<IdentifierQuality, number>;
  typeOnlyPenalty: number;
}

interface SimulatedResult {
  original: EvalResult;
  originalRank: number;
  simulatedScore: number;
  identifierQualities: IdentifierQuality[];
  compoundSpecificities: CompoundSpecificity[];
  identifierDelta: number;
}

interface QuerySimulation {
  query: PerQuery;
  golden: GoldenQuery;
  beforeExpectedRank: number | null;
  afterExpectedRank: number | null;
  beforeRank1: EvalResult | null;
  afterRank1: SimulatedResult | null;
  beforeHitAt1: boolean;
  afterHitAt1: boolean;
  beforeHitAt10: boolean;
  afterHitAt10: boolean;
  rank1Changed: boolean;
  skippedReason: string | null;
  dangerousReplacement: boolean;
  results: SimulatedResult[];
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/simulate-identifier-policy.ts <artifact-dir> [--policy conservative|balanced|aggressive] [--scope definition-risk|all] [--limit N] [--no-protect-current-hit]",
    "",
    "Replays existing eval per-query artifacts and simulates alternative identifier-lane confidence policies.",
    "This is read-only and only reorders candidates already present in the artifact.",
    "Default scope is definition-risk: definition failures only when rank 1 is a weak/path/type identifier promotion.",
  ].join("\n");
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function parseArgs(argv: string[]): {
  artifactDir: string;
  policyName: PolicyName;
  scope: SimulationScope;
  limit: number;
  protectCurrentHit: boolean;
} {
  const positional: string[] = [];
  let policyName: PolicyName = "balanced";
  let scope: SimulationScope = "definition-risk";
  let limit = 30;
  let protectCurrentHit = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") {
      const value = argv[index + 1];
      if (value !== "conservative" && value !== "balanced" && value !== "aggressive") {
        throw new Error(`Invalid --policy value: ${value ?? "<missing>"}\n${usage()}`);
      }
      policyName = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--policy=")) {
      const value = arg.slice("--policy=".length);
      if (value !== "conservative" && value !== "balanced" && value !== "aggressive") {
        throw new Error(`Invalid --policy value: ${value}\n${usage()}`);
      }
      policyName = value;
      continue;
    }
    if (arg === "--scope") {
      const value = argv[index + 1];
      if (value !== "definition-risk" && value !== "all") {
        throw new Error(`Invalid --scope value: ${value ?? "<missing>"}\n${usage()}`);
      }
      scope = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (value !== "definition-risk" && value !== "all") {
        throw new Error(`Invalid --scope value: ${value}\n${usage()}`);
      }
      scope = value;
      continue;
    }
    if (arg === "--no-protect-current-hit") {
      protectCurrentHit = false;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid --limit value: ${argv[index + 1] ?? "<missing>"}\n${usage()}`);
      }
      limit = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid --limit value: ${arg}\n${usage()}`);
      }
      limit = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}\n${usage()}`);
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error(usage());
  }

  return {
    artifactDir: positional[0] as string,
    policyName,
    scope,
    limit,
    protectCurrentHit,
  };
}

const POLICIES: Record<PolicyName, Policy> = {
  conservative: {
    name: "conservative",
    description: "Only trims the weakest identifier evidence; safest first production candidate.",
    floors: {
      "exact-symbol": null,
      "alias-symbol": null,
      "file-anchored-symbol": 0.97,
      "compound-symbol": 0.965,
      "weak-substring": 0.9,
      "path-only": 0.88,
      "type-only": 0.86,
      unknown: 0.9,
    },
    additiveMultipliers: {
      "exact-symbol": 1,
      "alias-symbol": 1,
      "file-anchored-symbol": 0.9,
      "compound-symbol": 0.75,
      "weak-substring": 0.25,
      "path-only": 0.15,
      "type-only": 0,
      unknown: 0.25,
    },
    typeOnlyPenalty: 0.04,
  },
  balanced: {
    name: "balanced",
    description: "Preserves strong symbol evidence while demoting broad substring/path/type-only promotions.",
    floors: {
      "exact-symbol": null,
      "alias-symbol": null,
      "file-anchored-symbol": 0.965,
      "compound-symbol": 0.94,
      "weak-substring": null,
      "path-only": null,
      "type-only": null,
      unknown: null,
    },
    additiveMultipliers: {
      "exact-symbol": 1,
      "alias-symbol": 1,
      "file-anchored-symbol": 0.85,
      "compound-symbol": 0.55,
      "weak-substring": 0,
      "path-only": 0,
      "type-only": 0,
      unknown: 0,
    },
    typeOnlyPenalty: 0.08,
  },
  aggressive: {
    name: "aggressive",
    description: "Turns the identifier lane into a strict exact/anchored-symbol lane.",
    floors: {
      "exact-symbol": null,
      "alias-symbol": null,
      "file-anchored-symbol": 0.955,
      "compound-symbol": 0.9,
      "weak-substring": null,
      "path-only": null,
      "type-only": null,
      unknown: null,
    },
    additiveMultipliers: {
      "exact-symbol": 1,
      "alias-symbol": 1,
      "file-anchored-symbol": 0.7,
      "compound-symbol": 0.25,
      "weak-substring": 0,
      "path-only": 0,
      "type-only": 0,
      unknown: 0,
    },
    typeOnlyPenalty: 0.12,
  },
};

function loadArtifact(artifactDir: string): LoadedArtifact {
  const perQueryPath = path.join(artifactDir, "per-query.json");
  const summaryPath = path.join(artifactDir, "summary.json");

  if (!existsSync(perQueryPath)) {
    throw new Error(`Missing per-query artifact: ${perQueryPath}`);
  }
  if (!existsSync(summaryPath)) {
    throw new Error(`Missing summary artifact: ${summaryPath}`);
  }

  const perQuery = readJsonFile<PerQueryArtifact>(perQueryPath);
  const summary = readJsonFile<SummaryArtifact>(summaryPath);
  if (!summary.datasetPath || !existsSync(summary.datasetPath)) {
    throw new Error(`Summary datasetPath is missing or unreadable: ${summary.datasetPath ?? "<missing>"}`);
  }

  return {
    artifactDir,
    perQuery,
    summary,
    dataset: readJsonFile<DatasetArtifact>(summary.datasetPath),
  };
}

function normalizePathForCompare(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function pathMatchesExpected(actualPath: string, expectedPath: string): boolean {
  const actual = normalizePathForCompare(actualPath);
  const expected = normalizePathForCompare(expectedPath);
  return actual === expected || actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
}

function lineRangesOverlap(
  actualStartLine: number,
  actualEndLine: number,
  expectedStartLine: number,
  expectedEndLine: number
): boolean {
  return actualStartLine <= expectedEndLine && actualEndLine >= expectedStartLine;
}

function resultMatchesExpected(result: EvalResult, expected: Expected): boolean {
  const expectedPaths = [expected.filePath, ...(expected.acceptableFiles ?? [])].filter(
    (value): value is string => Boolean(value)
  );

  if (expectedPaths.length > 0 && !expectedPaths.some((expectedPath) => pathMatchesExpected(result.filePath, expectedPath))) {
    return false;
  }

  if (expected.symbol && result.name !== expected.symbol) {
    return false;
  }

  if (expected.startLine !== undefined && expected.endLine !== undefined) {
    return lineRangesOverlap(result.startLine, result.endLine, expected.startLine, expected.endLine);
  }

  return true;
}

function resultIdentity(result: EvalResult | SimulatedResult | null): string {
  if (!result) {
    return "<none>";
  }
  const item = "original" in result ? result.original : result;
  return [
    item.filePath,
    item.startLine,
    item.endLine,
    item.name ?? "",
    item.chunkType,
  ].join(":");
}

function formatResult(result: EvalResult | SimulatedResult | null, projectRoot: string | undefined): string {
  if (!result) {
    return "(none)";
  }
  const item = "original" in result ? result.original : result;
  const relative = projectRoot ? path.relative(projectRoot, item.filePath) : item.filePath;
  const filePath = relative.startsWith("..") ? item.filePath : relative;
  return `${filePath}:${item.startLine}-${item.endLine} ${item.name ?? "(unnamed)"} ${item.chunkType}`;
}

function getExpectedRank(results: EvalResult[], expected: Expected): number | null {
  const index = results.findIndex((result) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function getSimulatedExpectedRank(results: SimulatedResult[], expected: Expected): number | null {
  const index = results.findIndex((result) => resultMatchesExpected(result.original, expected));
  return index >= 0 ? index + 1 : null;
}

function parseStringField(reason: string, field: string): string | null {
  const match = reason.match(new RegExp(`${field}=([^;]+)`));
  return match ? match[1]?.trim() ?? null : null;
}

function parseIdentifierQuality(stage: ScoreStage): IdentifierQuality {
  const quality = parseStringField(stage.reason, "identifierQuality");
  switch (quality) {
    case "exact-symbol":
    case "alias-symbol":
    case "file-anchored-symbol":
    case "compound-symbol":
    case "weak-substring":
    case "path-only":
    case "type-only":
      return quality;
    default:
      return "unknown";
  }
}

function parseCompoundSpecificity(stage: ScoreStage): CompoundSpecificity {
  const specificity = parseStringField(stage.reason, "compoundSpecificity");
  switch (specificity) {
    case "strong-compound":
    case "generic-compound":
    case "mixed-compound":
    case "not-compound":
      return specificity;
    default:
      return "unknown";
  }
}

function isRiskyIdentifierStage(
  quality: IdentifierQuality,
  compoundSpecificity: CompoundSpecificity
): boolean {
  return quality === "weak-substring" ||
    quality === "path-only" ||
    quality === "type-only";
}

function isIdentifierStage(stage: ScoreStage): boolean {
  return stage.reason.includes("deterministicIdentifierLane") ||
    stage.reason.includes("identifierPromotion") ||
    stage.reason.includes("identifierDefinitionLane");
}

function getIdentifierQualities(result: EvalResult | null): IdentifierQuality[] {
  if (!result) {
    return [];
  }
  const qualities = (result.scoreBreakdown?.stages ?? [])
    .filter(isIdentifierStage)
    .map(parseIdentifierQuality);
  return Array.from(new Set(qualities));
}

function getCompoundSpecificities(result: EvalResult | null): CompoundSpecificity[] {
  if (!result) {
    return [];
  }
  const specificities = (result.scoreBreakdown?.stages ?? [])
    .filter(isIdentifierStage)
    .map(parseCompoundSpecificity)
    .filter((value) => value !== "unknown");
  return Array.from(new Set(specificities));
}

function hasRiskyIdentifierQuality(result: EvalResult | null): boolean {
  if (!result) {
    return false;
  }
  return (result.scoreBreakdown?.stages ?? [])
    .filter(isIdentifierStage)
    .some((stage) => isRiskyIdentifierStage(parseIdentifierQuality(stage), parseCompoundSpecificity(stage)));
}

function isImplementationChunk(chunkType: string): boolean {
  return chunkType === "function" ||
    chunkType === "method" ||
    chunkType === "class" ||
    chunkType === "constant";
}

function isShapeOrCoarseChunk(chunkType: string): boolean {
  return chunkType === "interface" ||
    chunkType === "type" ||
    chunkType === "module" ||
    chunkType === "other";
}

function isDangerousRank1Replacement(before: EvalResult | null, after: SimulatedResult | null): boolean {
  if (!before || !after || resultIdentity(before) === resultIdentity(after)) {
    return false;
  }
  return isImplementationChunk(before.chunkType) && isShapeOrCoarseChunk(after.original.chunkType);
}

function shouldSkipQuery(
  query: PerQuery,
  beforeExpectedRank: number | null,
  scope: SimulationScope,
  protectCurrentHit: boolean
): string | null {
  if (protectCurrentHit && beforeExpectedRank === 1) {
    return "protected-current-hit";
  }
  if (scope === "all") {
    return null;
  }
  if (query.effectiveTaskType !== "definition") {
    return "not-definition-task";
  }
  if (query.queryType === "cross-file-relationship") {
    return "relationship-query";
  }
  if (query.queryType?.includes("config") || query.id.startsWith("cfg-")) {
    return "config-query";
  }
  if (!hasRiskyIdentifierQuality(query.results[0] ?? null)) {
    return "rank1-not-risky-identifier";
  }
  if (beforeExpectedRank === null) {
    return "expected-not-in-artifact-top-k";
  }
  return null;
}

function getPolicyStageAfter(stage: ScoreStage, quality: IdentifierQuality, policy: Policy): number {
  if (stage.kind === "set" || stage.kind === "set-min") {
    const floor = policy.floors[quality];
    let after = floor === null ? stage.before : Math.max(stage.before, floor);
    if (quality === "type-only") {
      after -= policy.typeOnlyPenalty;
    }
    return after;
  }

  if (stage.kind === "add") {
    const multiplier = policy.additiveMultipliers[quality];
    let after = stage.before + (stage.after - stage.before) * multiplier;
    if (quality === "type-only") {
      after -= policy.typeOnlyPenalty;
    }
    return after;
  }

  return stage.after;
}

function simulateResult(result: EvalResult, originalRank: number, policy: Policy, scope: SimulationScope): SimulatedResult {
  const stages = result.scoreBreakdown?.stages ?? [];
  const identifierStages = stages.filter(isIdentifierStage);
  let simulatedScore = result.score;
  let identifierDelta = 0;
  const qualities: IdentifierQuality[] = [];
  const compoundSpecificities: CompoundSpecificity[] = [];

  for (const stage of identifierStages) {
    const quality = parseIdentifierQuality(stage);
    const compoundSpecificity = parseCompoundSpecificity(stage);
    qualities.push(quality);
    compoundSpecificities.push(compoundSpecificity);
    if (
      scope === "definition-risk" &&
      !isRiskyIdentifierStage(quality, compoundSpecificity)
    ) {
      continue;
    }
    const policyAfter = getPolicyStageAfter(stage, quality, policy);
    const delta = policyAfter - stage.after;
    identifierDelta += delta;
    simulatedScore += delta;
  }

  return {
    original: result,
    originalRank,
    simulatedScore,
    identifierQualities: Array.from(new Set(qualities)),
    compoundSpecificities: Array.from(new Set(compoundSpecificities.filter((value) => value !== "unknown"))),
    identifierDelta,
  };
}

function simulateQuery(
  query: PerQuery,
  golden: GoldenQuery,
  policy: Policy,
  scope: SimulationScope,
  protectCurrentHit: boolean
): QuerySimulation {
  const beforeExpectedRank = getExpectedRank(query.results, golden.expected);
  const skippedReason = shouldSkipQuery(query, beforeExpectedRank, scope, protectCurrentHit);
  const results = query.results
    .map((result, index) => skippedReason
      ? {
          original: result,
          originalRank: index + 1,
          simulatedScore: result.score,
          identifierQualities: getIdentifierQualities(result),
          compoundSpecificities: getCompoundSpecificities(result),
          identifierDelta: 0,
        }
      : simulateResult(result, index + 1, policy, scope)
    )
    .sort((left, right) => {
      if (right.simulatedScore !== left.simulatedScore) {
        return right.simulatedScore - left.simulatedScore;
      }
      return left.originalRank - right.originalRank;
    });
  const afterExpectedRank = getSimulatedExpectedRank(results, golden.expected);
  const beforeRank1 = query.results[0] ?? null;
  const afterRank1 = results[0] ?? null;

  return {
    query,
    golden,
    beforeExpectedRank,
    afterExpectedRank,
    beforeRank1,
    afterRank1,
    beforeHitAt1: beforeExpectedRank === 1,
    afterHitAt1: afterExpectedRank === 1,
    beforeHitAt10: beforeExpectedRank !== null && beforeExpectedRank <= 10,
    afterHitAt10: afterExpectedRank !== null && afterExpectedRank <= 10,
    rank1Changed: resultIdentity(beforeRank1) !== resultIdentity(afterRank1),
    skippedReason,
    dangerousReplacement: isDangerousRank1Replacement(beforeRank1, afterRank1),
    results,
  };
}

function rankText(rank: number | null): string {
  return rank === null ? "not-top10" : String(rank);
}

function printQueryRows(
  title: string,
  rows: QuerySimulation[],
  projectRoot: string | undefined,
  limit: number
): void {
  console.log(`\n${title}: ${rows.length}`);
  for (const row of rows.slice(0, limit)) {
    const rank1Quality = row.afterRank1?.identifierQualities.join(",") || "none";
    const rank1Compound = row.afterRank1?.compoundSpecificities.join(",") || "none";
    console.log(
      `${row.query.id}: expected ${rankText(row.beforeExpectedRank)} -> ${rankText(row.afterExpectedRank)} | ` +
      `rank1 ${formatResult(row.beforeRank1, projectRoot)} -> ${formatResult(row.afterRank1, projectRoot)} | ` +
      `afterRank1Quality=${rank1Quality} | afterRank1Compound=${rank1Compound}`
    );
  }
  if (rows.length > limit) {
    console.log(`  ... ${rows.length - limit} more`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadArtifact(args.artifactDir);
  const policy = POLICIES[args.policyName];
  const goldenById = new Map(loaded.dataset.queries.map((query) => [query.id, query]));
  const simulations: QuerySimulation[] = [];

  for (const query of loaded.perQuery.queries) {
    const golden = goldenById.get(query.id);
    if (!golden) {
      continue;
    }
    simulations.push(simulateQuery(query, golden, policy, args.scope, args.protectCurrentHit));
  }

  const simulated = simulations.filter((row) => row.skippedReason === null);
  const protectedCurrentHits = simulations.filter((row) => row.skippedReason === "protected-current-hit");
  const expectedNotInTopK = simulations.filter((row) => row.skippedReason === "expected-not-in-artifact-top-k");
  const dangerousReplacements = simulations.filter((row) => row.dangerousReplacement);
  const improvedFailures = simulations.filter((row) =>
    row.skippedReason === null &&
    !row.beforeHitAt1 &&
    (
      row.afterHitAt1 ||
      (row.beforeExpectedRank === null && row.afterExpectedRank !== null) ||
      (row.beforeExpectedRank !== null && row.afterExpectedRank !== null && row.afterExpectedRank < row.beforeExpectedRank)
    )
  );
  const regressedSuccesses = simulations.filter((row) => row.skippedReason === null && row.beforeHitAt1 && !row.afterHitAt1);
  const expectedRankRegressions = simulations.filter((row) =>
    row.skippedReason === null &&
    row.beforeExpectedRank !== null &&
    (row.afterExpectedRank === null || row.afterExpectedRank > row.beforeExpectedRank)
  );
  const rank1Changes = simulations.filter((row) => row.skippedReason === null && row.rank1Changed);
  const rank1Improvements = rank1Changes.filter((row) => !row.beforeHitAt1 && row.afterHitAt1);
  const rank1Regressions = rank1Changes.filter((row) => row.beforeHitAt1 && !row.afterHitAt1);
  const top10Recoveries = simulations.filter((row) => row.skippedReason === null && !row.beforeHitAt10 && row.afterHitAt10);
  const top10Losses = simulations.filter((row) => row.skippedReason === null && row.beforeHitAt10 && !row.afterHitAt10);
  const changedIdentifierWinners = rank1Changes.filter((row) =>
    (row.beforeRank1?.scoreBreakdown?.stages ?? []).some(isIdentifierStage) ||
    (row.afterRank1?.identifierQualities.length ?? 0) > 0
  );

  console.log(`Artifact: ${loaded.artifactDir}`);
  console.log(`Dataset: ${loaded.summary.datasetPath ?? "(unknown)"}`);
  console.log(`Project: ${loaded.summary.projectRoot ?? "(unknown)"}`);
  console.log(`Policy: ${policy.name}`);
  console.log(`Scope: ${args.scope}`);
  console.log(`Protect current Hit@1: ${args.protectCurrentHit}`);
  console.log(`Description: ${policy.description}`);
  console.log("Simulation basis: final artifact scores plus identifier-stage delta adjustments for candidates already present in per-query.json");
  console.log("Limitation: this cannot surface candidates that were outside artifact top-K or re-run the external reranker.");

  console.log("\nSUMMARY");
  console.log(`Queries simulated: ${simulations.length}`);
  console.log(`Queries with policy applied: ${simulated.length}`);
  console.log(`Protected current Hit@1 queries: ${protectedCurrentHits.length}`);
  console.log(`Expected-not-in-top-K skipped: ${expectedNotInTopK.length}`);
  console.log(`Failures that would improve: ${improvedFailures.length}`);
  console.log(`Current Hit@1 successes that would regress: ${regressedSuccesses.length}`);
  console.log(`Expected-rank regressions: ${expectedRankRegressions.length}`);
  console.log(`Dangerous implementation-to-shape rank-1 replacements: ${dangerousReplacements.length}`);
  console.log(`Rank-1 winner changes: ${rank1Changes.length}`);
  console.log(`Rank-1 improvements: ${rank1Improvements.length}`);
  console.log(`Rank-1 regressions: ${rank1Regressions.length}`);
  console.log(`Top-10 recoveries: ${top10Recoveries.length}`);
  console.log(`Top-10 losses: ${top10Losses.length}`);
  console.log(`Rank-1 changes involving identifier-promoted winners: ${changedIdentifierWinners.length}`);
  console.log(`Generic compound rank-1 winners in current artifact: ${simulations.filter((row) => getCompoundSpecificities(row.beforeRank1).includes("generic-compound")).length}`);
  console.log(`Generic compound rank-1 winners after simulation: ${simulations.filter((row) => row.afterRank1?.compoundSpecificities.includes("generic-compound")).length}`);

  printQueryRows("Failures Improved", improvedFailures, loaded.summary.projectRoot, args.limit);
  printQueryRows("Successes Regressed", regressedSuccesses, loaded.summary.projectRoot, args.limit);
  printQueryRows("Expected-Rank Regressions", expectedRankRegressions, loaded.summary.projectRoot, args.limit);
  printQueryRows("Dangerous Rank-1 Replacements", dangerousReplacements, loaded.summary.projectRoot, args.limit);
  printQueryRows("Rank-1 Winner Changes", rank1Changes, loaded.summary.projectRoot, args.limit);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
