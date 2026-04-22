import { existsSync, readFileSync } from "fs";
import * as path from "path";

import { Database, type ChunkData } from "../src/native/index.js";

type Expected = {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  startLine?: number;
  endLine?: number;
  branch?: string;
};

type GoldenQuery = {
  id: string;
  query: string;
  queryType?: string;
  expected: Expected;
};

type EvalResult = {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
  scoreBreakdown?: {
    sources?: string[];
    preRerankScore?: number;
    finalScore?: number;
    reranker?: {
      score: number;
      rank: number;
      backend: string;
    };
    stages?: Array<{
      name: string;
      kind: string;
      before: number;
      after: number;
      reason: string;
    }>;
  };
};

type PerQuery = {
  id: string;
  query: string;
  queryType?: string;
  effectiveTaskType?: string;
  hitAt1: boolean;
  hitAt10: boolean;
  failureBucket?: string;
  reciprocalRankAt10: number;
  ndcgAt10: number;
  results: EvalResult[];
};

type PerQueryArtifact = {
  queries: PerQuery[];
};

type SummaryArtifact = {
  projectRoot: string;
  datasetPath: string;
};

type IndexedExpectedStatus = {
  indexed: boolean;
  matchingChunks: ChunkData[];
  fileChunks: ChunkData[];
};

type RerankerEffect = "helped" | "hurt" | "neutral" | "not-reranked" | "not-observable";

function usage(): string {
  return "Usage: npx tsx scripts/analyze-eval-failures.ts <artifact-dir>";
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
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

function chunkMatchesExpected(chunk: ChunkData, expected: Expected): boolean {
  if (expected.symbol && chunk.name !== expected.symbol) {
    return false;
  }

  if (expected.startLine !== undefined && expected.endLine !== undefined) {
    return lineRangesOverlap(chunk.startLine, chunk.endLine, expected.startLine, expected.endLine);
  }

  return true;
}

function candidateFilePaths(projectRoot: string, expected: Expected): string[] {
  const expectedPaths = [expected.filePath, ...(expected.acceptableFiles ?? [])].filter(
    (value): value is string => Boolean(value)
  );
  const paths = new Set<string>();

  for (const expectedPath of expectedPaths) {
    paths.add(expectedPath);
    paths.add(path.resolve(projectRoot, expectedPath));
  }

  return [...paths];
}

function getIndexedExpectedStatus(
  database: Database,
  projectRoot: string,
  expected: Expected
): IndexedExpectedStatus {
  const fileChunksById = new Map<string, ChunkData>();

  for (const filePath of candidateFilePaths(projectRoot, expected)) {
    for (const chunk of database.getChunksByFile(filePath)) {
      fileChunksById.set(chunk.chunkId, chunk);
    }
  }

  const fileChunks = [...fileChunksById.values()];
  const matchingChunks = fileChunks.filter((chunk) => chunkMatchesExpected(chunk, expected));

  return {
    indexed: matchingChunks.length > 0,
    matchingChunks,
    fileChunks,
  };
}

function isLikelyTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|test)(\/|$)|\.(test|spec)\.[cm]?[tj]sx?$/i.test(filePath);
}

function isLikelyDocPath(filePath: string): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i.test(filePath);
}

function classifyResult(result: EvalResult): string {
  const sources = new Set(result.scoreBreakdown?.sources ?? []);
  if (sources.has("graph")) return "graph";
  if (sources.has("identifier")) return "identifier";
  if (sources.has("symbol")) return "symbol";
  if (isLikelyTestPath(result.filePath)) return "test";
  if (isLikelyDocPath(result.filePath)) return "doc";
  if (["interface", "type", "enum", "trait", "struct"].includes(result.chunkType)) return "type/interface";
  if (result.chunkType === "module") return "module";
  if (["function", "method", "class", "constant"].includes(result.chunkType)) return "implementation";
  return result.chunkType || "other";
}

function topOutrankingCategories(query: PerQuery, expected: Expected): string[] {
  const categories = new Set<string>();
  for (const result of query.results) {
    if (resultMatchesExpected(result, expected)) {
      break;
    }
    categories.add(classifyResult(result));
  }
  return [...categories];
}

function getExpectedRank(query: PerQuery, expected: Expected): number | null {
  const index = query.results.findIndex((result) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function getPreRerankRank(query: PerQuery, expected: Expected): number | null {
  const ranked = query.results
    .map((result, index) => ({
      result,
      originalIndex: index,
      score: result.scoreBreakdown?.preRerankScore ?? result.score,
    }))
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);

  const index = ranked.findIndex(({ result }) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function getRerankerEffect(query: PerQuery, expected: Expected): RerankerEffect {
  if (!query.results.some((result) => result.scoreBreakdown?.reranker)) {
    return "not-reranked";
  }

  const finalRank = getExpectedRank(query, expected);
  const preRank = getPreRerankRank(query, expected);
  if (finalRank === null || preRank === null) {
    return "not-observable";
  }
  if (finalRank < preRank) return "helped";
  if (finalRank > preRank) return "hurt";
  return "neutral";
}

function formatResult(result: EvalResult | undefined): string {
  if (!result) return "(none)";
  return `${path.relative(process.cwd(), result.filePath)}:${result.startLine}-${result.endLine} ${result.name ?? "(unnamed)"} ${result.chunkType} score=${result.score}`;
}

function formatStages(result: EvalResult | undefined): string {
  const stages = result?.scoreBreakdown?.stages ?? [];
  if (stages.length === 0) return "(no scoreBreakdown stages)";
  return stages
    .map((stage) => `${stage.name}[${stage.kind}] ${stage.before} -> ${stage.after}: ${stage.reason}`)
    .join(" | ");
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printMap(title: string, map: Map<string, number>): void {
  console.log(`\n${title}`);
  for (const [key, count] of [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
    console.log(`  ${key}: ${count}`);
  }
}

function main(): void {
  const artifactDir = process.argv[2];
  if (!artifactDir) {
    throw new Error(usage());
  }

  const summaryPath = path.join(artifactDir, "summary.json");
  const perQueryPath = path.join(artifactDir, "per-query.json");
  if (!existsSync(summaryPath) || !existsSync(perQueryPath)) {
    throw new Error(`Artifact directory must contain summary.json and per-query.json: ${artifactDir}`);
  }

  const summary = readJsonFile<SummaryArtifact>(summaryPath);
  const perQuery = readJsonFile<PerQueryArtifact>(perQueryPath);
  const dataset = readJsonFile<{ queries: GoldenQuery[] }>(summary.datasetPath);
  const expectedById = new Map(dataset.queries.map((query) => [query.id, query]));
  const dbPath = path.join(summary.projectRoot, ".opencode", "index", "codebase.db");
  const database = new Database(dbPath);

  const failedQueries = perQuery.queries.filter((query) => !query.hitAt1);
  const failureBuckets = new Map<string, number>();
  const indexedBuckets = new Map<string, number>();
  const top10Buckets = new Map<string, number>();
  const outrankerBuckets = new Map<string, number>();
  const rerankerBuckets = new Map<string, number>();

  console.log(`Artifact: ${artifactDir}`);
  console.log(`Project: ${summary.projectRoot}`);
  console.log(`Dataset: ${summary.datasetPath}`);
  console.log(`Failed rank-1 queries: ${failedQueries.length}/${perQuery.queries.length}`);

  for (const query of failedQueries) {
    const golden = expectedById.get(query.id);
    if (!golden) {
      increment(failureBuckets, query.failureBucket ?? "unknown");
      continue;
    }

    const expected = golden.expected;
    const indexedStatus = getIndexedExpectedStatus(database, summary.projectRoot, expected);
    const expectedRank = getExpectedRank(query, expected);
    const categories = topOutrankingCategories(query, expected);
    const rerankerEffect = getRerankerEffect(query, expected);

    increment(failureBuckets, query.failureBucket ?? "unknown");
    increment(indexedBuckets, indexedStatus.indexed ? "expected indexed" : "expected missing from index");
    increment(top10Buckets, expectedRank ? "expected in top10" : "expected not in top10");
    increment(rerankerBuckets, rerankerEffect);
    for (const category of categories.length > 0 ? categories : ["none-before-expected"]) {
      increment(outrankerBuckets, category);
    }
  }

  printMap("Failure buckets", failureBuckets);
  printMap("Expected chunk index status", indexedBuckets);
  printMap("Expected chunk retrieval status", top10Buckets);
  printMap("Rank-1/above-expected outranker categories", outrankerBuckets);
  printMap("Reranker effect on expected top-10 chunks", rerankerBuckets);

  console.log("\nDetails");
  for (const query of failedQueries) {
    const golden = expectedById.get(query.id);
    if (!golden) {
      console.log(`\n${query.id}: missing golden query definition`);
      continue;
    }

    const expected = golden.expected;
    const indexedStatus = getIndexedExpectedStatus(database, summary.projectRoot, expected);
    const expectedRank = getExpectedRank(query, expected);
    const preRerankRank = getPreRerankRank(query, expected);
    const rerankerEffect = getRerankerEffect(query, expected);
    const rankOne = query.results[0];
    const expectedResult = expectedRank ? query.results[expectedRank - 1] : undefined;
    const scoreGap = expectedResult ? rankOne.score - expectedResult.score : null;

    console.log(`\n${query.id}`);
    console.log(`  query: ${query.query}`);
    console.log(`  task: ${query.effectiveTaskType ?? "(unknown)"}; type: ${query.queryType ?? golden.queryType ?? "(unknown)"}`);
    console.log(`  failureBucket: ${query.failureBucket ?? "(none)"}; hitAt10=${query.hitAt10}; rr=${query.reciprocalRankAt10}; ndcg=${query.ndcgAt10}`);
    console.log(`  expected: ${expected.filePath ?? expected.acceptableFiles?.join(",") ?? "(any file)"} ${expected.symbol ?? "(any symbol)"} ${expected.startLine ?? "?"}-${expected.endLine ?? "?"}`);
    console.log(`  expectedIndexed: ${indexedStatus.indexed}; matchingChunks=${indexedStatus.matchingChunks.length}; fileChunks=${indexedStatus.fileChunks.length}`);
    if (indexedStatus.matchingChunks.length > 0) {
      const chunkPreview = indexedStatus.matchingChunks
        .slice(0, 3)
        .map((chunk) => `${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ${chunk.name ?? "(unnamed)"} ${chunk.nodeType ?? "(unknown type)"} ${chunk.chunkKind ?? "(unknown kind)"}`)
        .join(" | ");
      console.log(`  indexedMatches: ${chunkPreview}`);
    }
    console.log(`  expectedTop10Rank: ${expectedRank ?? "not in top10"}; preRerankRankWithinTop10: ${preRerankRank ?? "not observable"}; rerankerEffect=${rerankerEffect}`);
    console.log(`  outrankingCategories: ${topOutrankingCategories(query, expected).join(", ") || "(none)"}`);
    console.log(`  rank1: ${formatResult(rankOne)}`);
    if (expectedResult) {
      console.log(`  expectedResult: ${formatResult(expectedResult)}`);
      console.log(`  scoreGapRank1MinusExpected: ${scoreGap}`);
    }
    console.log(`  rank1Stages: ${formatStages(rankOne)}`);
    if (expectedResult) {
      console.log(`  expectedStages: ${formatStages(expectedResult)}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
