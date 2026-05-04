import { estimateTokens } from "../utils/cost.js";

import type {
  EvalMetrics,
  EvalSearchResult,
  FailureBucket,
  GoldenQuery,
  PerQueryEvalResult,
} from "./types.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const x = p * (sorted.length - 1);
  const lowerIndex = Math.floor(x);
  const upperIndex = Math.ceil(x);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const fraction = x - lowerIndex;
  return sorted[lowerIndex] + fraction * (sorted[upperIndex] - sorted[lowerIndex]);
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

function hasExpectedLineRange(query: GoldenQuery): boolean {
  return query.expected.startLine !== undefined && query.expected.endLine !== undefined;
}

function rangesOverlap(
  actualStartLine: number,
  actualEndLine: number,
  expectedStartLine: number,
  expectedEndLine: number
): boolean {
  return actualStartLine <= expectedEndLine && actualEndLine >= expectedStartLine;
}

function resultIdentity(result: EvalSearchResult): string {
  return [
    normalizePath(result.filePath),
    result.startLine,
    result.endLine,
    result.name ?? "",
    result.chunkType,
  ].join(":");
}

function uniqueResultsByIdentity(results: PerQueryEvalResult["results"]): PerQueryEvalResult["results"] {
  const seen = new Set<string>();
  const unique: PerQueryEvalResult["results"] = [];

  for (const result of results) {
    const identity = resultIdentity(result);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(result);
  }

  return unique;
}

function mergeUniqueResultsByIdentity(
  primaryResults: PerQueryEvalResult["results"],
  expandedResults: PerQueryEvalResult["results"]
): PerQueryEvalResult["results"] {
  const merged: PerQueryEvalResult["results"] = [];
  const seen = new Set<string>();

  for (const result of [...primaryResults, ...expandedResults]) {
    const identity = resultIdentity(result);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(result);
  }

  return merged;
}

export function pathMatchesExpected(actualPath: string, expectedPath: string): boolean {
  const actual = normalizePath(actualPath);
  const expected = normalizePath(expectedPath);
  if (actual === expected) return true;
  return actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
}

export function getRelevantPaths(query: GoldenQuery): string[] {
  const fromExact = query.expected.filePath ? [query.expected.filePath] : [];
  const fromAcceptable = query.expected.acceptableFiles ?? [];
  return Array.from(new Set([...fromExact, ...fromAcceptable]));
}

function isRelevantResult(filePath: string, relevantPaths: string[]): boolean {
  return relevantPaths.some((expected) => pathMatchesExpected(filePath, expected));
}

export function matchesExpectedResult(result: EvalSearchResult, query: GoldenQuery): boolean {
  const relevantPaths = getRelevantPaths(query);
  if (!isRelevantResult(result.filePath, relevantPaths)) {
    return false;
  }

  if (query.expected.symbol && result.name !== query.expected.symbol) {
    return false;
  }

  if (
    hasExpectedLineRange(query) &&
    !rangesOverlap(
      result.startLine,
      result.endLine,
      query.expected.startLine!,
      query.expected.endLine!
    )
  ) {
    return false;
  }

  return true;
}

function combinedRecallAtK(
  primaryResults: PerQueryEvalResult["results"],
  expandedResults: PerQueryEvalResult["results"],
  query: GoldenQuery,
  k: number
): number {
  const relevantPaths = getRelevantPaths(query);
  if (relevantPaths.length === 0) {
    return 0;
  }

  const combined = mergeUniqueResultsByIdentity(primaryResults, expandedResults).slice(0, k);
  return combined.some((result) => matchesExpectedResult(result, query)) ? 1 : 0;
}

function reciprocalRankAtK(results: PerQueryEvalResult["results"], query: GoldenQuery, k: number): number {
  const top = uniqueResultsByIdentity(results).slice(0, k);
  for (let i = 0; i < top.length; i += 1) {
    if (matchesExpectedResult(top[i], query)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function dcgFromLabels(labels: number[]): number {
  return labels.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

function ndcgAtK(results: PerQueryEvalResult["results"], query: GoldenQuery, k: number): number {
  const top = uniqueResultsByIdentity(results).slice(0, k);
  const relevanceLabels = top.map((result) => (matchesExpectedResult(result, query) ? 1 : 0));
  const dcg = dcgFromLabels(relevanceLabels);
  const idealLabels = [...relevanceLabels].sort((a, b) => b - a);
  const idcg = dcgFromLabels(idealLabels);

  if (idcg === 0) {
    return 0;
  }

  // Floating-point error should never push a normalized metric outside [0, 1].
  return Math.max(0, Math.min(1, dcg / idcg));
}

function isDocsOrTestsPath(filePath: string): boolean {
  const lowered = normalizePath(filePath).toLowerCase();
  return (
    lowered.includes("/docs/") ||
    lowered.includes("/test/") ||
    lowered.includes("/tests/") ||
    lowered.includes("readme") ||
    lowered.includes("/benchmarks/")
  );
}

export function classifyFailureBucket(
  query: GoldenQuery,
  results: PerQueryEvalResult["results"],
  k: number
): FailureBucket | undefined {
  const relevantPaths = getRelevantPaths(query);
  const top = uniqueResultsByIdentity(results).slice(0, k);
  const hasExactTopK = top.some((result) => matchesExpectedResult(result, query));
  const hasRelevantFileTopK = top.some((result) => isRelevantResult(result.filePath, relevantPaths));

  if (!hasExactTopK) {
    if ((query.expected.symbol || hasExpectedLineRange(query)) && hasRelevantFileTopK) {
      return "wrong-symbol";
    }
    return "no-relevant-hit-top-k";
  }

  const top1 = top[0];
  if (
    top1 &&
    !matchesExpectedResult(top1, query) &&
    isRelevantResult(top1.filePath, relevantPaths) &&
    (query.expected.symbol || hasExpectedLineRange(query))
  ) {
    return "wrong-symbol";
  }

  if (top1 && !matchesExpectedResult(top1, query) && isDocsOrTestsPath(top1.filePath)) {
    return "docs-tests-outranking-source";
  }

  if (top1 && !matchesExpectedResult(top1, query)) {
    return "wrong-file";
  }

  return undefined;
}

export function buildPerQueryResult(
  query: GoldenQuery,
  results: PerQueryEvalResult["results"],
  latencyMs: number,
  k: number,
  effective?: Pick<
    PerQueryEvalResult,
    "effectiveTaskType" | "subIntent" | "effectiveFinalRerankTopN" | "effectiveGraphDepth"
  >,
  expandedResults: PerQueryEvalResult["results"] = [],
  expandedRelations: string[] = [],
  timings?: Pick<PerQueryEvalResult, "prefilterMs">
): PerQueryEvalResult {
  const deduped = uniqueResultsByIdentity(results);
  const dedupedExpanded = uniqueResultsByIdentity(expandedResults);
  const hitAt = (cutoff: number): boolean =>
    deduped.slice(0, cutoff).some((result) => matchesExpectedResult(result, query));
  const fileHitAt = (cutoff: number): boolean => {
    const relevantPaths = getRelevantPaths(query);
    return deduped
      .slice(0, cutoff)
      .some((result) => isRelevantResult(result.filePath, relevantPaths));
  };
  const expandedHit = dedupedExpanded.some((result) => matchesExpectedResult(result, query));

  const perQuery: PerQueryEvalResult = {
    id: query.id,
    query: query.query,
    queryType: query.queryType,
    source: query.source,
    heuristic: query.heuristic,
    effectiveTaskType: effective?.effectiveTaskType,
    subIntent: effective?.subIntent,
    effectiveFinalRerankTopN: effective?.effectiveFinalRerankTopN,
    effectiveGraphDepth: effective?.effectiveGraphDepth,
    latencyMs,
    prefilterMs: timings?.prefilterMs,
    fileHitAt1: fileHitAt(1),
    fileHitAt3: fileHitAt(3),
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    fileHitAt10: fileHitAt(10),
    hitAt10: hitAt(10),
    expandedHit,
    expandedRecallAtK: combinedRecallAtK(deduped, dedupedExpanded, query, k),
    expandedRelations: expandedRelations.length > 0 ? Array.from(new Set(expandedRelations)).sort() : undefined,
    reciprocalRankAt10: reciprocalRankAtK(deduped, query, 10),
    ndcgAt10: ndcgAtK(deduped, query, 10),
    failureBucket: classifyFailureBucket(query, results, k),
    results: deduped,
  };

  return perQuery;
}

export function computeEvalMetrics(
  queries: GoldenQuery[],
  perQuery: PerQueryEvalResult[],
  embeddingCallCount: number,
  embeddingTokensUsed: number,
  costPer1MTokensUsd: number
): EvalMetrics {
  const count = perQuery.length;
  const safeDiv = (value: number): number => (count === 0 ? 0 : value / count);

  const sum = {
    fileHitAt1: 0,
    fileHitAt3: 0,
    hitAt1: 0,
    hitAt3: 0,
    hitAt5: 0,
    fileHitAt10: 0,
    hitAt10: 0,
    combinedRecallAt10: 0,
    expansionHitRate: 0,
    mrrAt10: 0,
    ndcgAt10: 0,
  };

  const failureBuckets: Record<FailureBucket, number> = {
    "wrong-file": 0,
    "wrong-symbol": 0,
    "docs-tests-outranking-source": 0,
    "no-relevant-hit-top-k": 0,
  };

  const latencies = perQuery.map((item) => item.latencyMs);

  for (const query of perQuery) {
    if (query.fileHitAt1) sum.fileHitAt1 += 1;
    if (query.fileHitAt3) sum.fileHitAt3 += 1;
    if (query.hitAt1) sum.hitAt1 += 1;
    if (query.hitAt3) sum.hitAt3 += 1;
    if (query.hitAt5) sum.hitAt5 += 1;
    if (query.fileHitAt10) sum.fileHitAt10 += 1;
    if (query.hitAt10) sum.hitAt10 += 1;
    sum.combinedRecallAt10 += query.expandedRecallAtK ?? 0;
    if (query.expandedHit) sum.expansionHitRate += 1;
    sum.mrrAt10 += query.reciprocalRankAt10;
    sum.ndcgAt10 += query.ndcgAt10;
    if (query.failureBucket) {
      failureBuckets[query.failureBucket] += 1;
    }
  }

  const queryTokens = queries.reduce((acc, q) => acc + estimateTokens(q.query), 0);

  return {
    fileHitAt1: safeDiv(sum.fileHitAt1),
    fileHitAt3: safeDiv(sum.fileHitAt3),
    hitAt1: safeDiv(sum.hitAt1),
    hitAt3: safeDiv(sum.hitAt3),
    hitAt5: safeDiv(sum.hitAt5),
    fileHitAt10: safeDiv(sum.fileHitAt10),
    hitAt10: safeDiv(sum.hitAt10),
    combinedRecallAt10: safeDiv(sum.combinedRecallAt10),
    expansionHitRate: safeDiv(sum.expansionHitRate),
    mrrAt10: safeDiv(sum.mrrAt10),
    ndcgAt10: safeDiv(sum.ndcgAt10),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    tokenEstimate: {
      queryTokens,
      embeddingTokensUsed,
    },
    embedding: {
      callCount: embeddingCallCount,
      estimatedCostUsd: (embeddingTokensUsed / 1_000_000) * costPer1MTokensUsd,
      costPer1MTokensUsd,
    },
    failureBuckets,
  };
}
