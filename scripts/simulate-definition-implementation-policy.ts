import { existsSync, readFileSync } from "fs";
import * as path from "path";

import {
  CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY,
  getDefinitionImplementationBonus,
  getDefinitionImplementationPenalty,
} from "../src/indexer/definition-implementation-policy.js";

type Expected = {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  startLine?: number;
  endLine?: number;
};

type GoldenQuery = {
  id: string;
  query: string;
  queryType?: string;
  expected: Expected;
};

type DatasetArtifact = {
  queries: GoldenQuery[];
};

type ScoreStage = {
  name: string;
  kind: string;
  before: number;
  after: number;
  reason: string;
};

type EvalResult = {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string | null;
  scoreBreakdown?: {
    stages?: ScoreStage[];
  } | null;
};

type PerQuery = {
  id: string;
  query: string;
  queryType?: string;
  effectiveTaskType?: string;
  hitAt1?: boolean;
  hitAt10?: boolean;
  results: EvalResult[];
};

type PerQueryArtifact = {
  queries: PerQuery[];
};

type SummaryArtifact = {
  projectRoot?: string;
  datasetPath?: string;
};

type LoadedArtifact = {
  artifactDir: string;
  perQuery: PerQueryArtifact;
  summary: SummaryArtifact;
  dataset: DatasetArtifact;
};

type SimulatedResult = {
  original: EvalResult;
  originalRank: number;
  simulatedScore: number;
  penaltyApplied: number;
  bonusApplied: number;
  hypothesisDelta: number;
};

type QuerySimulation = {
  query: PerQuery;
  golden: GoldenQuery;
  beforeExpectedRank: number | null;
  afterExpectedRank: number | null;
  beforeRank1: EvalResult | null;
  afterRank1: SimulatedResult | null;
  beforeHitAt1: boolean;
  afterHitAt1: boolean;
  rank1Changed: boolean;
  skippedReason: string | null;
  results: SimulatedResult[];
};

function usage(): string {
  return [
    "Usage: npx tsx scripts/simulate-definition-implementation-policy.ts <artifact-dir> [--limit N] [--no-protect-current-hit] [--simulation-a] [--simulation-b]",
    "",
    "Read-only replay for implementation-seeking definition queries.",
    "Applies conservative penalties to wrapper-export, module, type/interface, and options-shape winners unless exact-symbol evidence exists.",
  ].join("\n");
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function parseArgs(argv: string[]): {
  artifactDir: string;
  limit: number;
  protectCurrentHit: boolean;
  simulationA: boolean;
  simulationB: boolean;
} {
  const positional: string[] = [];
  let limit = 30;
  let protectCurrentHit = true;
  let simulationA = false;
  let simulationB = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-protect-current-hit") {
      protectCurrentHit = false;
      continue;
    }
    if (arg === "--simulation-a") {
      simulationA = true;
      continue;
    }
    if (arg === "--simulation-b") {
      simulationB = true;
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
    limit,
    protectCurrentHit,
    simulationA,
    simulationB,
  };
}

function parseStringField(reason: string, field: string): string | null {
  const match = reason.match(new RegExp(`${field}=([^;]+)`));
  return match ? match[1]?.trim() ?? null : null;
}

function getIdentifierFloorHypothesisDelta(result: EvalResult): number {
  const stages = result.scoreBreakdown?.stages ?? [];
  const matchingStage = stages.find((stage) => {
    if (stage.name !== "deterministicIntentLane") {
      return false;
    }
    const quality = parseStringField(stage.reason, "identifierQuality");
    if (quality === "weak-substring") {
      return true;
    }
    if (quality !== "compound-symbol") {
      return false;
    }
    const specificity = parseStringField(stage.reason, "compoundSpecificity");
    return specificity === "generic-compound" || specificity === "mixed-compound";
  });
  return matchingStage ? -0.15 : 0;
}

function getRelationshipBiasRemovalDelta(query: PerQuery, result: EvalResult): number {
  if (query.effectiveTaskType !== "definition") {
    return 0;
  }
  const stages = result.scoreBreakdown?.stages ?? [];
  const matchingStage = stages.find((stage) =>
    stage.name === "structuralRelationshipAdjustment" &&
    stage.reason.includes("relationshipGraphBias")
  );
  return matchingStage ? -0.6 : 0;
}

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

function getExpectedRank(results: EvalResult[], expected: Expected): number | null {
  const index = results.findIndex((result) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function getSimulatedExpectedRank(results: SimulatedResult[], expected: Expected): number | null {
  const index = results.findIndex((result) => resultMatchesExpected(result.original, expected));
  return index >= 0 ? index + 1 : null;
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

function shouldSkipQuery(
  query: PerQuery,
  beforeExpectedRank: number | null,
  protectCurrentHit: boolean
): string | null {
  if (protectCurrentHit && beforeExpectedRank === 1) {
    return "protected-current-hit";
  }
  if (query.effectiveTaskType !== "definition") {
    return "not-definition-task";
  }
  if (query.queryType !== "definition") {
    return "not-definition-query";
  }
  return null;
}

function simulateResult(
  args: ReturnType<typeof parseArgs>,
  query: PerQuery,
  expected: Expected,
  result: EvalResult,
  originalRank: number
): SimulatedResult {
  const penaltyApplied = getDefinitionImplementationPenalty({
    query: query.query,
    filePath: result.filePath,
    chunkType: result.chunkType,
    name: result.name,
    stages: result.scoreBreakdown?.stages ?? [],
    expectedFilePath: expected.filePath ?? null,
  }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY);
  const bonusApplied = getDefinitionImplementationBonus({
    query: query.query,
    filePath: result.filePath,
    chunkType: result.chunkType,
    name: result.name,
    stages: result.scoreBreakdown?.stages ?? [],
    expectedFilePath: expected.filePath ?? null,
  }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY);
  const hypothesisDelta =
    (args.simulationA ? getIdentifierFloorHypothesisDelta(result) : 0) +
    (args.simulationB ? getRelationshipBiasRemovalDelta(query, result) : 0);

  return {
    original: result,
    originalRank,
    simulatedScore: result.score - penaltyApplied + bonusApplied + hypothesisDelta,
    penaltyApplied,
    bonusApplied,
    hypothesisDelta,
  };
}

function simulateQuery(
  args: ReturnType<typeof parseArgs>,
  query: PerQuery,
  golden: GoldenQuery,
  protectCurrentHit: boolean
): QuerySimulation {
  const beforeExpectedRank = getExpectedRank(query.results, golden.expected);
  const skippedReason = shouldSkipQuery(query, beforeExpectedRank, protectCurrentHit);
  const results = query.results
    .map((result, index) => skippedReason
      ? {
          original: result,
          originalRank: index + 1,
          simulatedScore: result.score,
          penaltyApplied: 0,
          bonusApplied: 0,
          hypothesisDelta: 0,
        }
      : simulateResult(args, query, golden.expected, result, index + 1))
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
    rank1Changed: resultIdentity(beforeRank1) !== resultIdentity(afterRank1),
    skippedReason,
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
    console.log(
      `${row.query.id}: expected ${rankText(row.beforeExpectedRank)} -> ${rankText(row.afterExpectedRank)} | ` +
      `rank1 ${formatResult(row.beforeRank1, projectRoot)} -> ${formatResult(row.afterRank1, projectRoot)} | ` +
      `penalty=${row.afterRank1?.penaltyApplied ?? 0} | bonus=${row.afterRank1?.bonusApplied ?? 0} | hypothesisDelta=${row.afterRank1?.hypothesisDelta ?? 0}`
    );
  }
  if (rows.length > limit) {
    console.log(`  ... ${rows.length - limit} more`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadArtifact(args.artifactDir);
  const goldenById = new Map(loaded.dataset.queries.map((query) => [query.id, query]));
  const simulations: QuerySimulation[] = [];

  for (const query of loaded.perQuery.queries) {
    const golden = goldenById.get(query.id);
    if (!golden) continue;
    simulations.push(simulateQuery(args, query, golden, args.protectCurrentHit));
  }

  const simulated = simulations.filter((row) => row.skippedReason === null);
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

  console.log(`Artifact: ${loaded.artifactDir}`);
  console.log(`Dataset: ${loaded.summary.datasetPath ?? "(unknown)"}`);
  console.log(`Project: ${loaded.summary.projectRoot ?? "(unknown)"}`);
  console.log("Policy: conservative definition implementation demotion");
  console.log(`Protect current Hit@1: ${args.protectCurrentHit}`);
  console.log(`Simulation A enabled: ${args.simulationA}`);
  console.log(`Simulation B enabled: ${args.simulationB}`);
  console.log("Simulation basis: final artifact scores plus category-specific final-score penalties.");
  console.log("Limitation: this does not re-run reranking or introduce candidates outside the artifact top-K.");

  console.log("\nSUMMARY");
  console.log(`Queries simulated: ${simulations.length}`);
  console.log(`Queries with policy applied: ${simulated.length}`);
  console.log(`Failures that would improve: ${improvedFailures.length}`);
  console.log(`Current Hit@1 successes that would regress: ${regressedSuccesses.length}`);
  console.log(`Expected-rank regressions: ${expectedRankRegressions.length}`);
  console.log(`Rank-1 winner changes: ${rank1Changes.length}`);

  printQueryRows("Failures Improved", improvedFailures, loaded.summary.projectRoot, args.limit);
  printQueryRows("Successes Regressed", regressedSuccesses, loaded.summary.projectRoot, args.limit);
  printQueryRows("Expected-Rank Regressions", expectedRankRegressions, loaded.summary.projectRoot, args.limit);
  printQueryRows("Rank-1 Winner Changes", rank1Changes, loaded.summary.projectRoot, args.limit);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
