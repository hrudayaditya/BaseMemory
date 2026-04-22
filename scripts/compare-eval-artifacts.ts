import { existsSync, readFileSync } from "fs";
import * as path from "path";

const RERANKED_SCORE_TOLERANCE = 0.005;
const NON_RERANKED_SCORE_TOLERANCE = 0.002;
const TOP_THREE_NON_RERANKED_SCORE_TOLERANCE = 0.005;
const TAIL_NON_RERANKED_SCORE_TOLERANCE = 0.015;
const METRIC_TOLERANCE = 0.0001;

type CompareMode = "quality" | "strict";

interface ScoreStage {
  name: string;
}

interface ScoreBreakdown {
  stages?: ScoreStage[];
}

interface EvalResult {
  filePath: string;
  startLine: number;
  endLine: number;
  name?: string | null;
  score: number;
  scoreBreakdown?: ScoreBreakdown | null;
}

interface PerQueryResult {
  id: string;
  hitAt1?: boolean;
  hitAt3?: boolean;
  hitAt5?: boolean;
  hitAt10?: boolean;
  fileHitAt1?: boolean;
  fileHitAt3?: boolean;
  fileHitAt10?: boolean;
  reciprocalRankAt10?: number;
  ndcgAt10?: number;
  results: EvalResult[];
}

interface PerQueryArtifact {
  queries: PerQueryResult[];
}

interface SummaryArtifact {
  metrics?: {
    hitAt1?: number;
    hitAt3?: number;
    hitAt5?: number;
    hitAt10?: number;
    fileHitAt1?: number;
    fileHitAt3?: number;
    fileHitAt10?: number;
    mrrAt10?: number;
    ndcgAt10?: number;
  };
}

interface Regression {
  queryId: string;
  resultIndex: number;
  reason: string;
}

interface QueryRegression {
  queryId: string;
  reason: string;
}

interface LoadedArtifact {
  perQuery: PerQueryArtifact;
  summary: SummaryArtifact | null;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/compare-eval-artifacts.ts <artifact-dir-a> <artifact-dir-b> [--mode quality|strict]",
    "Default mode is quality. Use --mode strict for forensic score-by-score drift checks.",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  leftDir: string;
  rightDir: string;
  mode: CompareMode;
} {
  const positional: string[] = [];
  let mode: CompareMode = "quality";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") {
      mode = "strict";
      continue;
    }
    if (arg === "--quality") {
      mode = "quality";
      continue;
    }
    if (arg === "--mode") {
      const value = argv[index + 1];
      if (value !== "quality" && value !== "strict") {
        throw new Error(`Invalid --mode value: ${value ?? "<missing>"}\n${usage()}`);
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "quality" && value !== "strict") {
        throw new Error(`Invalid --mode value: ${value}\n${usage()}`);
      }
      mode = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}\n${usage()}`);
    }
    positional.push(arg);
  }

  const [leftDir, rightDir] = positional;
  if (!leftDir || !rightDir || positional.length > 2) {
    throw new Error(usage());
  }

  return { leftDir, rightDir, mode };
}

function loadArtifact(artifactDir: string): PerQueryArtifact {
  const artifactPath = path.join(artifactDir, "per-query.json");
  if (!existsSync(artifactPath)) {
    throw new Error(`per-query.json not found: ${artifactPath}`);
  }

  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { queries?: unknown }).queries)
  ) {
    throw new Error(`Invalid per-query artifact: ${artifactPath}`);
  }

  return parsed as PerQueryArtifact;
}

function loadSummary(artifactDir: string): SummaryArtifact | null {
  const summaryPath = path.join(artifactDir, "summary.json");
  if (!existsSync(summaryPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid summary artifact: ${summaryPath}`);
  }
  return parsed as SummaryArtifact;
}

function loadArtifacts(artifactDir: string): LoadedArtifact {
  const resolvedDir = path.resolve(process.cwd(), artifactDir);
  return {
    perQuery: loadArtifact(resolvedDir),
    summary: loadSummary(resolvedDir),
  };
}

function hasFinalReranker(result: EvalResult): boolean {
  return result.scoreBreakdown?.stages?.some((stage) => stage.name === "finalReranker") ?? false;
}

function sameResultIdentity(left: EvalResult, right: EvalResult): boolean {
  return (
    left.filePath === right.filePath &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine &&
    (left.name ?? null) === (right.name ?? null)
  );
}

function findResultIndex(results: EvalResult[], target: EvalResult | undefined): number | null {
  if (!target) {
    return null;
  }

  const index = results.findIndex((result) => sameResultIdentity(result, target));
  return index >= 0 ? index : null;
}

function compareArtifacts(left: PerQueryArtifact, right: PerQueryArtifact): {
  passCount: number;
  rerankedJitterCount: number;
  nonRerankedJitterCount: number;
  tieSwapCount: number;
  regressions: Regression[];
} {
  let passCount = 0;
  let rerankedJitterCount = 0;
  let nonRerankedJitterCount = 0;
  let tieSwapCount = 0;
  const regressions: Regression[] = [];
  const rightQueries = new Map(right.queries.map((query) => [query.id, query]));

  for (const leftQuery of left.queries) {
    const rightQuery = rightQueries.get(leftQuery.id);
    if (!rightQuery) {
      regressions.push({
        queryId: leftQuery.id,
        resultIndex: -1,
        reason: "query missing from second artifact",
      });
      continue;
    }

    const maxResults = Math.max(leftQuery.results.length, rightQuery.results.length);
    for (let resultIndex = 0; resultIndex < maxResults; resultIndex += 1) {
      const leftResult = leftQuery.results[resultIndex];
      const rightResult = rightQuery.results[resultIndex];
      if (!leftResult || !rightResult) {
        regressions.push({
          queryId: leftQuery.id,
          resultIndex,
          reason: "result missing from one artifact",
        });
        continue;
      }

      if (!sameResultIdentity(leftResult, rightResult)) {
        const positionalReranked = hasFinalReranker(leftResult) || hasFinalReranker(rightResult);
        const positionalTolerance = positionalReranked
          ? RERANKED_SCORE_TOLERANCE
          : NON_RERANKED_SCORE_TOLERANCE;
        if (Math.abs(leftResult.score - rightResult.score) <= positionalTolerance) {
          tieSwapCount += 1;
          continue;
        }

        const nextLeftResult = leftQuery.results[resultIndex + 1];
        const nextRightResult = rightQuery.results[resultIndex + 1];
        const isAdjacentSwap =
          nextLeftResult !== undefined &&
          nextRightResult !== undefined &&
          sameResultIdentity(leftResult, nextRightResult) &&
          sameResultIdentity(nextLeftResult, rightResult);
        if (isAdjacentSwap) {
          const currentReranked = hasFinalReranker(leftResult) || hasFinalReranker(rightResult);
          const nextReranked = hasFinalReranker(nextLeftResult) || hasFinalReranker(nextRightResult);
          const currentTolerance = currentReranked ? RERANKED_SCORE_TOLERANCE : NON_RERANKED_SCORE_TOLERANCE;
          const nextTolerance = nextReranked ? RERANKED_SCORE_TOLERANCE : NON_RERANKED_SCORE_TOLERANCE;
          const currentScoreDelta = Math.abs(leftResult.score - nextRightResult.score);
          const nextScoreDelta = Math.abs(nextLeftResult.score - rightResult.score);
          const currentRunGap = Math.abs(leftResult.score - nextLeftResult.score);
          const nextRunGap = Math.abs(rightResult.score - nextRightResult.score);
          if (
            currentScoreDelta <= currentTolerance &&
            nextScoreDelta <= nextTolerance &&
            currentRunGap <= Math.max(currentTolerance, nextTolerance) &&
            nextRunGap <= Math.max(currentTolerance, nextTolerance)
          ) {
            tieSwapCount += 1;
            resultIndex += 1;
            continue;
          }
        }

        regressions.push({
          queryId: leftQuery.id,
          resultIndex,
          reason: "result identity changed",
        });
        continue;
      }

      const scoreDelta = Math.abs(leftResult.score - rightResult.score);
      const reranked = hasFinalReranker(leftResult) || hasFinalReranker(rightResult);
      if (!reranked) {
        if (scoreDelta === 0) {
          passCount += 1;
        } else if (scoreDelta <= NON_RERANKED_SCORE_TOLERANCE) {
          nonRerankedJitterCount += 1;
        } else {
          regressions.push({
            queryId: leftQuery.id,
            resultIndex,
            reason: `non-reranked score changed by ${scoreDelta}`,
          });
        }
        continue;
      }

      if (scoreDelta > RERANKED_SCORE_TOLERANCE) {
        regressions.push({
          queryId: leftQuery.id,
          resultIndex,
          reason: `reranked score changed by ${scoreDelta}`,
        });
      } else if (scoreDelta > 0) {
        rerankedJitterCount += 1;
      }
    }
  }

  for (const rightQuery of right.queries) {
    if (!left.queries.some((query) => query.id === rightQuery.id)) {
      regressions.push({
        queryId: rightQuery.id,
        resultIndex: -1,
        reason: "query missing from first artifact",
      });
    }
  }

  return {
    passCount,
    rerankedJitterCount,
    nonRerankedJitterCount,
    tieSwapCount,
    regressions,
  };
}

function booleanRegressed(leftValue: boolean | undefined, rightValue: boolean | undefined): boolean {
  return leftValue === true && rightValue !== true;
}

function numberRegressed(leftValue: number | undefined, rightValue: number | undefined): boolean {
  return (
    typeof leftValue === "number" &&
    typeof rightValue === "number" &&
    rightValue + METRIC_TOLERANCE < leftValue
  );
}

function compareMetric(
  regressions: QueryRegression[],
  queryId: string,
  label: string,
  leftValue: boolean | number | undefined,
  rightValue: boolean | number | undefined
): void {
  if (typeof leftValue === "boolean" || typeof rightValue === "boolean") {
    if (booleanRegressed(leftValue as boolean | undefined, rightValue as boolean | undefined)) {
      regressions.push({
        queryId,
        reason: `${label} regressed from true to ${String(rightValue)}`,
      });
    }
    return;
  }

  if (numberRegressed(leftValue as number | undefined, rightValue as number | undefined)) {
    regressions.push({
      queryId,
      reason: `${label} decreased from ${leftValue} to ${rightValue}`,
    });
  }
}

function topResultChanged(leftQuery: PerQueryResult, rightQuery: PerQueryResult): boolean {
  const leftTop = leftQuery.results[0];
  const rightTop = rightQuery.results[0];
  return Boolean(leftTop && rightTop && !sameResultIdentity(leftTop, rightTop));
}

function isQualityNeutralRankOneChange(leftQuery: PerQueryResult, rightQuery: PerQueryResult): boolean {
  return leftQuery.hitAt1 === true && rightQuery.hitAt1 === true;
}

function compareSummaries(left: SummaryArtifact | null, right: SummaryArtifact | null): QueryRegression[] {
  const regressions: QueryRegression[] = [];
  if (!left?.metrics || !right?.metrics) {
    return regressions;
  }

  const metrics = [
    "hitAt1",
    "hitAt3",
    "hitAt5",
    "hitAt10",
    "fileHitAt1",
    "fileHitAt3",
    "fileHitAt10",
    "mrrAt10",
    "ndcgAt10",
  ] as const;

  for (const metric of metrics) {
    const leftValue = left.metrics[metric];
    const rightValue = right.metrics[metric];
    if (numberRegressed(leftValue, rightValue)) {
      regressions.push({
        queryId: "__summary__",
        reason: `${metric} decreased from ${leftValue} to ${rightValue}`,
      });
    }
  }

  return regressions;
}

function compareQuality(left: LoadedArtifact, right: LoadedArtifact): {
  summaryRegressions: QueryRegression[];
  hitRegressions: QueryRegression[];
  rankMetricRegressions: QueryRegression[];
  rankOneIdentityRegressions: QueryRegression[];
  topThreeIdentityWarnings: number;
  rankOneNeutralChanges: number;
  expectedRankImprovements: number;
  tailIdentityJitter: number;
  qualityDrift: ReturnType<typeof countQualityDriftWarnings>;
  strictDrift: ReturnType<typeof compareArtifacts>;
} {
  const summaryRegressions = compareSummaries(left.summary, right.summary);
  const hitRegressions: QueryRegression[] = [];
  const rankMetricRegressions: QueryRegression[] = [];
  const rankOneIdentityRegressions: QueryRegression[] = [];
  let topThreeIdentityWarnings = 0;
  let rankOneNeutralChanges = 0;
  let expectedRankImprovements = 0;
  let tailIdentityJitter = 0;
  const rightQueries = new Map(right.perQuery.queries.map((query) => [query.id, query]));

  for (const leftQuery of left.perQuery.queries) {
    const rightQuery = rightQueries.get(leftQuery.id);
    if (!rightQuery) {
      hitRegressions.push({
        queryId: leftQuery.id,
        reason: "query missing from second artifact",
      });
      continue;
    }

    const hitMetrics = [
      "hitAt1",
      "hitAt3",
      "hitAt5",
      "hitAt10",
      "fileHitAt1",
      "fileHitAt3",
      "fileHitAt10",
    ] as const;
    for (const metric of hitMetrics) {
      compareMetric(hitRegressions, leftQuery.id, metric, leftQuery[metric], rightQuery[metric]);
    }

    const previousMrr = leftQuery.reciprocalRankAt10 ?? 0;
    const nextMrr = rightQuery.reciprocalRankAt10 ?? 0;
    compareMetric(rankMetricRegressions, leftQuery.id, "reciprocalRankAt10", previousMrr, nextMrr);
    compareMetric(rankMetricRegressions, leftQuery.id, "ndcgAt10", leftQuery.ndcgAt10, rightQuery.ndcgAt10);
    if (nextMrr > previousMrr + METRIC_TOLERANCE) {
      expectedRankImprovements += 1;
    }

    if (topResultChanged(leftQuery, rightQuery)) {
      if (isQualityNeutralRankOneChange(leftQuery, rightQuery)) {
        rankOneNeutralChanges += 1;
      } else {
        rankOneIdentityRegressions.push({
          queryId: leftQuery.id,
          reason: "rank-1 identity changed without both runs having hitAt1=true",
        });
      }
    }

    for (let index = 0; index < Math.min(3, leftQuery.results.length); index += 1) {
      const leftResult = leftQuery.results[index];
      const rightIndex = findResultIndex(rightQuery.results.slice(0, 3), leftResult);
      if (leftResult && rightIndex !== null && rightIndex !== index) {
        topThreeIdentityWarnings += 1;
      }
    }

    for (let index = 3; index < Math.min(10, leftQuery.results.length); index += 1) {
      const leftResult = leftQuery.results[index];
      const rightIndex = findResultIndex(rightQuery.results.slice(3, 10), leftResult);
      if (leftResult && rightIndex !== null && rightIndex !== index - 3) {
        tailIdentityJitter += 1;
      }
    }
  }

  for (const rightQuery of right.perQuery.queries) {
    if (!left.perQuery.queries.some((query) => query.id === rightQuery.id)) {
      hitRegressions.push({
        queryId: rightQuery.id,
        reason: "query missing from first artifact",
      });
    }
  }

  return {
    summaryRegressions,
    hitRegressions,
    rankMetricRegressions,
    rankOneIdentityRegressions,
    topThreeIdentityWarnings,
    rankOneNeutralChanges,
    expectedRankImprovements,
    tailIdentityJitter,
    qualityDrift: countQualityDriftWarnings(left.perQuery, right.perQuery),
    strictDrift: compareArtifacts(left.perQuery, right.perQuery),
  };
}

function scoreToleranceForResult(result: EvalResult, index: number): number {
  if (hasFinalReranker(result)) {
    return RERANKED_SCORE_TOLERANCE;
  }
  return index < 3 ? TOP_THREE_NON_RERANKED_SCORE_TOLERANCE : TAIL_NON_RERANKED_SCORE_TOLERANCE;
}

function countQualityDriftWarnings(left: PerQueryArtifact, right: PerQueryArtifact): {
  rerankedScoreJitter: number;
  nonRerankedTopThreeJitter: number;
  nonRerankedTailJitter: number;
  candidatePoolChanges: number;
} {
  let rerankedScoreJitter = 0;
  let nonRerankedTopThreeJitter = 0;
  let nonRerankedTailJitter = 0;
  let candidatePoolChanges = 0;
  const rightQueries = new Map(right.queries.map((query) => [query.id, query]));

  for (const leftQuery of left.queries) {
    const rightQuery = rightQueries.get(leftQuery.id);
    if (!rightQuery) {
      continue;
    }

    for (let index = 0; index < Math.min(10, leftQuery.results.length); index += 1) {
      const leftResult = leftQuery.results[index];
      const rightIndex = findResultIndex(rightQuery.results, leftResult);
      if (!leftResult || rightIndex === null) {
        candidatePoolChanges += 1;
        continue;
      }

      const rightResult = rightQuery.results[rightIndex];
      const scoreDelta = Math.abs(leftResult.score - rightResult.score);
      if (scoreDelta === 0) {
        continue;
      }

      const tolerance = Math.max(
        scoreToleranceForResult(leftResult, index),
        scoreToleranceForResult(rightResult, rightIndex)
      );
      if (scoreDelta > tolerance) {
        candidatePoolChanges += 1;
        continue;
      }

      if (hasFinalReranker(leftResult) || hasFinalReranker(rightResult)) {
        rerankedScoreJitter += 1;
      } else if (index < 3 || rightIndex < 3) {
        nonRerankedTopThreeJitter += 1;
      } else {
        nonRerankedTailJitter += 1;
      }
    }
  }

  return {
    rerankedScoreJitter,
    nonRerankedTopThreeJitter,
    nonRerankedTailJitter,
    candidatePoolChanges,
  };
}

function printStrictComparison(comparison: ReturnType<typeof compareArtifacts>): void {
  console.log(`PASS: ${comparison.passCount} results identical (non-reranked)`);
  console.log(`JITTER: ${comparison.rerankedJitterCount} results within tolerance (reranked Jina variance)`);
  console.log(`JITTER: ${comparison.nonRerankedJitterCount} results within tolerance (non-reranked retrieval variance)`);
  console.log(`JITTER: ${comparison.tieSwapCount} tie swaps (identical scores, position changed)`);
  console.log(`REGRESSION: ${comparison.regressions.length} results (score delta exceeds tolerance)`);

  if (comparison.regressions.length > 0) {
    for (const regression of comparison.regressions.slice(0, 20)) {
      console.error(
        `${regression.queryId} result ${regression.resultIndex}: ${regression.reason}`
      );
    }
  }
}

function printQualityComparison(comparison: ReturnType<typeof compareQuality>): void {
  const qualityRegressionCount =
    comparison.summaryRegressions.length +
    comparison.hitRegressions.length +
    comparison.rankMetricRegressions.length +
    comparison.rankOneIdentityRegressions.length;
  console.log(qualityRegressionCount === 0 ? "QUALITY PASS:" : "QUALITY FAIL:");
  console.log(`Summary metric regressions: ${comparison.summaryRegressions.length}`);
  console.log(`Hit regressions: ${comparison.hitRegressions.length}`);
  console.log(`Expected-rank regressions: ${comparison.rankMetricRegressions.length}`);
  console.log(`Rank-1 identity regressions: ${comparison.rankOneIdentityRegressions.length}`);
  console.log(`Rank-1 neutral changes: ${comparison.rankOneNeutralChanges}`);
  console.log(`Expected-rank improvements: ${comparison.expectedRankImprovements}`);
  console.log("");
  console.log("DRIFT REPORT:");
  console.log(`Strict score regressions: ${comparison.strictDrift.regressions.length}`);
  console.log(`Reranked score jitter: ${comparison.qualityDrift.rerankedScoreJitter}`);
  console.log(`Non-reranked top-3 jitter: ${comparison.qualityDrift.nonRerankedTopThreeJitter}`);
  console.log(`Non-reranked tail jitter: ${comparison.qualityDrift.nonRerankedTailJitter}`);
  console.log(`Candidate pool changes: ${comparison.qualityDrift.candidatePoolChanges}`);
  console.log(`Top-3 identity warnings: ${comparison.topThreeIdentityWarnings}`);
  console.log(`Tail identity jitter: ${comparison.tailIdentityJitter}`);
  console.log(`Tie swaps: ${comparison.strictDrift.tieSwapCount}`);

  const regressionGroups = [
    ...comparison.summaryRegressions,
    ...comparison.hitRegressions,
    ...comparison.rankMetricRegressions,
    ...comparison.rankOneIdentityRegressions,
  ];
  for (const regression of regressionGroups.slice(0, 20)) {
    console.error(`${regression.queryId}: ${regression.reason}`);
  }

  console.log(
    qualityRegressionCount === 0
      ? "PASS: retrieval quality stable"
      : "FAIL: retrieval quality regressed"
  );
}

function main(): void {
  const { leftDir, rightDir, mode } = parseArgs(process.argv.slice(2));
  const left = loadArtifacts(leftDir);
  const right = loadArtifacts(rightDir);

  if (mode === "strict") {
    const comparison = compareArtifacts(left.perQuery, right.perQuery);
    printStrictComparison(comparison);
    if (comparison.regressions.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const comparison = compareQuality(left, right);
  printQualityComparison(comparison);
  const qualityRegressionCount =
    comparison.summaryRegressions.length +
    comparison.hitRegressions.length +
    comparison.rankMetricRegressions.length +
    comparison.rankOneIdentityRegressions.length;
  if (qualityRegressionCount > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
