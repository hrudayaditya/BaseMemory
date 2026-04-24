import { existsSync, readFileSync } from "fs";
import * as path from "path";

import { Database, type ChunkData } from "../src/native/index.js";

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
    stages?: ScoreStage[];
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
};

function usage(): string {
  return "Usage: npx tsx scripts/analyze-definition-implementation-failures.ts <artifact-dir>";
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

  const matchingChunks = [...fileChunksById.values()].filter((chunk) => chunkMatchesExpected(chunk, expected));
  return {
    indexed: matchingChunks.length > 0,
    matchingChunks,
  };
}

function getExpectedRank(query: PerQuery, expected: Expected): number | null {
  const index = query.results.findIndex((result) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function isLikelyTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|test)(\/|$)|\.(test|spec)\.[cm]?[tj]sx?$/i.test(filePath);
}

function isLikelyDocPath(filePath: string): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i.test(filePath);
}

function classifyWinnerCategory(result: EvalResult): string {
  if (isLikelyTestPath(result.filePath)) return "test";
  if (isLikelyDocPath(result.filePath)) return "doc";
  if (result.chunkType === "module" && (result.name ?? "").startsWith("export{")) return "wrapper-export";
  if ((result.chunkType === "type" || result.chunkType === "interface") && /(Options|Config|Params|Args|Props)$/.test(result.name ?? "")) {
    return "options-shape";
  }
  if (result.chunkType === "type" || result.chunkType === "interface") return "type-interface";
  if (result.chunkType === "module") return "module";
  if (["function", "method", "class", "constant"].includes(result.chunkType)) return "wrong-implementation";
  return result.chunkType || "other";
}

function getLaneCategory(result: EvalResult): string {
  const sources = new Set(result.scoreBreakdown?.sources ?? []);
  if (sources.has("graph")) return "graph";
  if (sources.has("identifier")) return "identifier";
  if (sources.has("symbol")) return "symbol";
  if (sources.has("hybrid")) return "hybrid";
  if (sources.has("bm25")) return "bm25";
  if (sources.has("arctic") || sources.has("voyage")) return "dense";
  return "unknown";
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

function getRerankerEffect(query: PerQuery, expected: Expected): string {
  if (!query.results.some((result) => result.scoreBreakdown?.reranker)) {
    return "not-reranked";
  }
  const finalRank = getExpectedRank(query, expected);
  const preRank = getPreRerankRank(query, expected);
  if (preRank === null || finalRank === null) {
    return "not-observable";
  }
  if (finalRank < preRank) return "helped";
  if (finalRank > preRank) return "hurt";
  return "neutral";
}

function formatStages(result: EvalResult | undefined): string {
  const stages = result?.scoreBreakdown?.stages ?? [];
  if (stages.length === 0) return "(no stages)";
  return stages
    .map((stage) => `${stage.name}[${stage.kind}] ${stage.before} -> ${stage.after}: ${stage.reason}`)
    .join(" | ");
}

function printMap(title: string, map: Map<string, number>): void {
  console.log(`\n${title}`);
  for (const [key, count] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${key}: ${count}`);
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
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
  const goldenById = new Map(dataset.queries.map((query) => [query.id, query]));
  const dbPath = path.join(summary.projectRoot, ".opencode", "index", "codebase.db");
  const database = new Database(dbPath);

  const rows = perQuery.queries
    .filter((query) => query.effectiveTaskType === "definition")
    .filter((query) => query.queryType === "definition")
    .filter((query) => !query.hitAt1)
    .map((query) => {
      const golden = goldenById.get(query.id);
      if (!golden) return null;
      const expectedRank = getExpectedRank(query, golden.expected);
      const expectedStatus = getIndexedExpectedStatus(database, summary.projectRoot, golden.expected);
      const winner = query.results[0];
      const expectedResult = expectedRank ? query.results[expectedRank - 1] : undefined;

      return {
        query,
        golden,
        expectedRank,
        expectedStatus,
        winner,
        expectedResult,
        winnerCategory: winner ? classifyWinnerCategory(winner) : "none",
        winnerLane: winner ? getLaneCategory(winner) : "none",
        rerankerEffect: getRerankerEffect(query, golden.expected),
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  const indexedMap = new Map<string, number>();
  const top10Map = new Map<string, number>();
  const winnerCategoryMap = new Map<string, number>();
  const winnerLaneMap = new Map<string, number>();
  const rerankerMap = new Map<string, number>();

  for (const row of rows) {
    increment(indexedMap, row.expectedStatus.indexed ? "indexed" : "missing-from-index");
    increment(top10Map, row.expectedRank === null ? "not-in-top10" : "in-top10");
    increment(winnerCategoryMap, row.winnerCategory);
    increment(winnerLaneMap, row.winnerLane);
    increment(rerankerMap, row.rerankerEffect);
  }

  console.log(`Artifact: ${artifactDir}`);
  console.log(`Project: ${summary.projectRoot}`);
  console.log(`Definition failures analyzed: ${rows.length}`);

  printMap("Expected chunk index status", indexedMap);
  printMap("Expected chunk top-10 status", top10Map);
  printMap("Rank-1 winner category", winnerCategoryMap);
  printMap("Rank-1 winner lane", winnerLaneMap);
  printMap("Reranker effect on expected chunk", rerankerMap);

  console.log("\nFailure Details");
  for (const row of rows) {
    console.log(
      `\n${row.query.id} | expectedRank=${row.expectedRank ?? "not-top10"} | indexed=${row.expectedStatus.indexed} | ` +
      `winnerCategory=${row.winnerCategory} | winnerLane=${row.winnerLane} | reranker=${row.rerankerEffect}`
    );
    console.log(`  query: ${row.query.query}`);
    console.log(`  expected: ${row.golden.expected.filePath ?? "(unknown)"} :: ${row.golden.expected.symbol ?? "(unknown)"}`);
    if (row.winner) {
      console.log(`  rank1: ${path.relative(summary.projectRoot, row.winner.filePath)}:${row.winner.startLine}-${row.winner.endLine} ${row.winner.name ?? "(unnamed)"} ${row.winner.chunkType} score=${row.winner.score}`);
      console.log(`  rank1 stages: ${formatStages(row.winner)}`);
    }
    if (row.expectedResult) {
      console.log(`  expected result in top10: ${path.relative(summary.projectRoot, row.expectedResult.filePath)}:${row.expectedResult.startLine}-${row.expectedResult.endLine} ${row.expectedResult.name ?? "(unnamed)"} ${row.expectedResult.chunkType} score=${row.expectedResult.score}`);
      console.log(`  expected stages: ${formatStages(row.expectedResult)}`);
    } else if (row.expectedStatus.indexed) {
      console.log("  expected result indexed but not retrieved in top10");
    } else {
      console.log("  expected result missing from index");
    }
  }

  const closable = database as Database & { close?: () => void };
  closable.close?.();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
