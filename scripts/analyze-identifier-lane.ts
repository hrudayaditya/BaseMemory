import { existsSync, readFileSync } from "fs";
import * as path from "path";

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
  results: EvalResult[];
};

type PerQueryArtifact = {
  queries: PerQuery[];
};

type SummaryArtifact = {
  projectRoot: string;
  datasetPath: string;
};

const STOPWORDS = new Set([
  "about",
  "active",
  "actual",
  "after",
  "against",
  "allow",
  "allows",
  "also",
  "and",
  "any",
  "are",
  "before",
  "being",
  "build",
  "calls",
  "can",
  "client",
  "code",
  "config",
  "defined",
  "does",
  "during",
  "error",
  "expected",
  "factory",
  "file",
  "for",
  "from",
  "function",
  "get",
  "helper",
  "how",
  "implementation",
  "implemented",
  "into",
  "link",
  "method",
  "object",
  "once",
  "options",
  "query",
  "request",
  "result",
  "return",
  "server",
  "should",
  "that",
  "the",
  "this",
  "throw",
  "throws",
  "type",
  "used",
  "when",
  "where",
  "which",
  "with",
]);

type IdentifierStageAudit = {
  queryId: string;
  query: string;
  taskType?: string;
  queryType?: string;
  failureBucket?: string;
  rank: number;
  expectedRank: number | null;
  displacedExpected: boolean;
  candidateName: string;
  candidateFile: string;
  candidateChunkType: string;
  candidateMatchesExpectedSymbol: boolean;
  candidateMatchesExpectedFile: boolean;
  queryIdentifiers: string[];
  matchedIdentifiers: string[];
  stageName: string;
  stageKind: string;
  before: number;
  after: number;
  scoreSetTo: number | null;
  additiveBoost: number | null;
  maxMatch: number | null;
  matchQuality: string;
  pathMatchesFileHint: boolean | null;
  nameMatchesPrimary: boolean | null;
  exactIdentifierMatch: boolean | null;
  databaseSymbol: string | null;
};

function usage(): string {
  return "Usage: npx tsx scripts/analyze-identifier-lane.ts <artifact-dir> [--all]";
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

function getExpectedRank(query: PerQuery, expected: Expected): number | null {
  const index = query.results.findIndex((result) => resultMatchesExpected(result, expected));
  return index >= 0 ? index + 1 : null;
}

function extractIdentifierHints(query: string): string[] {
  const identifiers = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return identifiers
    .filter((identifier) => identifier.length >= 3)
    .filter((identifier) => {
      const lower = identifier.toLowerCase();
      if (STOPWORDS.has(lower)) return false;
      return /[A-Z]/.test(identifier) || identifier.includes("_") || identifier.endsWith("Results") || identifier.endsWith("Result");
    })
    .map((identifier) => identifier.toLowerCase());
}

function extractCodeTermHints(query: string): string[] {
  const terms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term) => !STOPWORDS.has(term));
}

function normalizeIdentifierVariants(identifier: string): string[] {
  const lower = identifier.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const variants = [lower, compact, lower.replace(/_/g, "-")].filter((value) => value.length > 0);
  return [...new Set(variants)];
}

function getQueryIdentifierAuditTerms(query: string): string[] {
  const terms = [...extractIdentifierHints(query), ...extractCodeTermHints(query)];
  return [...new Set(terms)].slice(0, 12);
}

function matchedIdentifiersForResult(result: EvalResult, identifiers: string[]): string[] {
  const nameLower = (result.name ?? "").toLowerCase();
  const pathLower = result.filePath.toLowerCase();
  const matches: string[] = [];

  for (const identifier of identifiers) {
    for (const variant of normalizeIdentifierVariants(identifier)) {
      if (nameLower === variant) {
        matches.push(`${identifier}:name-exact`);
        break;
      }
      if (nameLower.includes(variant)) {
        matches.push(`${identifier}:name-substring`);
        break;
      }
      if (pathLower.includes(variant)) {
        matches.push(`${identifier}:path`);
        break;
      }
    }
  }

  return [...new Set(matches)];
}

function parseNumberField(reason: string, field: string): number | null {
  const match = reason.match(new RegExp(`${field}=(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function parseBooleanField(reason: string, field: string): boolean | null {
  const match = reason.match(new RegExp(`${field}=(true|false)`));
  return match ? match[1] === "true" : null;
}

function parseStringField(reason: string, field: string): string | null {
  const match = reason.match(new RegExp(`${field}=([^;]+)`));
  return match ? match[1].trim() : null;
}

function classifyMatchQuality(stage: ScoreStage, maxMatch: number | null, exactIdentifierMatch: boolean | null): string {
  if (stage.reason.includes("databaseSymbol=")) return "database-symbol";
  if (exactIdentifierMatch === true) return "exact-identifier";
  if (exactIdentifierMatch === false) return "fuzzy-identifier";
  if (maxMatch === 1) return "exact-or-file-anchored";
  if (maxMatch !== null && maxMatch >= 0.85) return "name-substring";
  if (maxMatch !== null && maxMatch >= 0.7) return "path-match";
  return "unknown";
}

function expectedFiles(expected: Expected): string[] {
  return [expected.filePath, ...(expected.acceptableFiles ?? [])].filter((value): value is string => Boolean(value));
}

function resultMatchesExpectedFile(result: EvalResult, expected: Expected): boolean {
  const files = expectedFiles(expected);
  return files.length > 0 && files.some((expectedFile) => pathMatchesExpected(result.filePath, expectedFile));
}

function isIdentifierStage(stage: ScoreStage): boolean {
  return stage.reason.includes("deterministicIdentifierLane") || stage.reason.includes("identifierPromotion");
}

function auditIdentifierStages(query: PerQuery, golden: GoldenQuery): IdentifierStageAudit[] {
  const expectedRank = getExpectedRank(query, golden.expected);
  const identifiers = getQueryIdentifierAuditTerms(query.query);
  const rows: IdentifierStageAudit[] = [];

  query.results.forEach((result, resultIndex) => {
    const rank = resultIndex + 1;
    for (const stage of result.scoreBreakdown?.stages ?? []) {
      if (!isIdentifierStage(stage)) continue;

      const maxMatch = parseNumberField(stage.reason, "maxMatch");
      const exactIdentifierMatch = parseBooleanField(stage.reason, "exactIdentifierMatch");
      const additiveBoost = parseNumberField(stage.reason, "boost");
      const scoreSetTo = stage.reason.includes("deterministicIdentifierLane") ? stage.after : null;

      rows.push({
        queryId: query.id,
        query: query.query,
        taskType: query.effectiveTaskType,
        queryType: query.queryType ?? golden.queryType,
        failureBucket: query.failureBucket,
        rank,
        expectedRank,
        displacedExpected: expectedRank === null ? rank <= 10 : rank < expectedRank,
        candidateName: result.name ?? "(unnamed)",
        candidateFile: result.filePath,
        candidateChunkType: result.chunkType,
        candidateMatchesExpectedSymbol: Boolean(golden.expected.symbol && result.name === golden.expected.symbol),
        candidateMatchesExpectedFile: resultMatchesExpectedFile(result, golden.expected),
        queryIdentifiers: identifiers,
        matchedIdentifiers: matchedIdentifiersForResult(result, identifiers),
        stageName: stage.reason.includes("deterministicIdentifierLane") ? "deterministicIdentifierLane" : "identifierPromotion",
        stageKind: stage.kind,
        before: stage.before,
        after: stage.after,
        scoreSetTo,
        additiveBoost,
        maxMatch,
        matchQuality: classifyMatchQuality(stage, maxMatch, exactIdentifierMatch),
        pathMatchesFileHint: parseBooleanField(stage.reason, "pathMatchesFileHint"),
        nameMatchesPrimary: parseBooleanField(stage.reason, "nameMatchesPrimary"),
        exactIdentifierMatch,
        databaseSymbol: parseStringField(stage.reason, "databaseSymbol"),
      });
    }
  });

  return rows;
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

function formatRelative(filePath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function formatNullable(value: unknown): string {
  return value === null || value === undefined ? "-" : String(value);
}

function main(): void {
  const artifactDir = process.argv[2];
  const includeAllQueries = process.argv.includes("--all");
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

  const queries = includeAllQueries ? perQuery.queries : perQuery.queries.filter((query) => !query.hitAt1);
  const rows = queries.flatMap((query) => {
    const golden = goldenById.get(query.id);
    return golden ? auditIdentifierStages(query, golden) : [];
  });

  const displacedRows = rows.filter((row) => row.displacedExpected);
  const floorMap = new Map<string, number>();
  const floorDisplacedMap = new Map<string, number>();
  const qualityMap = new Map<string, number>();
  const qualityDisplacedMap = new Map<string, number>();
  const chunkTypeDisplacedMap = new Map<string, number>();
  const expectedFileMap = new Map<string, number>();
  const expectedSymbolMap = new Map<string, number>();

  for (const row of rows) {
    const floorKey = row.scoreSetTo !== null ? row.scoreSetTo.toFixed(4) : `boost:${formatNullable(row.additiveBoost)}`;
    increment(floorMap, floorKey);
    increment(qualityMap, row.matchQuality);
    increment(expectedFileMap, row.candidateMatchesExpectedFile ? "same expected file" : "wrong file");
    increment(expectedSymbolMap, row.candidateMatchesExpectedSymbol ? "expected symbol" : "wrong symbol");
    if (row.displacedExpected) {
      increment(floorDisplacedMap, floorKey);
      increment(qualityDisplacedMap, row.matchQuality);
      increment(chunkTypeDisplacedMap, row.candidateChunkType);
    }
  }

  console.log(`Artifact: ${artifactDir}`);
  console.log(`Project: ${summary.projectRoot}`);
  console.log(`Scope: ${includeAllQueries ? "all queries" : "rank-1 failures only"}`);
  console.log(`Identifier-stage rows: ${rows.length}`);
  console.log(`Rows above/missing expected answer: ${displacedRows.length}`);

  printMap("Score set/boost distribution", floorMap);
  printMap("Displacing score set/boost distribution", floorDisplacedMap);
  printMap("Match quality distribution", qualityMap);
  printMap("Displacing match quality distribution", qualityDisplacedMap);
  printMap("Displacing chunk types", chunkTypeDisplacedMap);
  printMap("Expected file alignment", expectedFileMap);
  printMap("Expected symbol alignment", expectedSymbolMap);

  console.log("\nDisplacing Identifier Promotions");
  for (const row of displacedRows) {
    console.log(
      [
        `${row.queryId} rank=${row.rank}`,
        `expectedRank=${row.expectedRank ?? "not-top10"}`,
        `task=${row.taskType ?? "-"}`,
        `stage=${row.stageName}`,
        `scoreSetTo=${formatNullable(row.scoreSetTo)}`,
        `boost=${formatNullable(row.additiveBoost)}`,
        `maxMatch=${formatNullable(row.maxMatch)}`,
        `quality=${row.matchQuality}`,
        `nameMatchesPrimary=${formatNullable(row.nameMatchesPrimary)}`,
        `pathHint=${formatNullable(row.pathMatchesFileHint)}`,
        `exactIdentifier=${formatNullable(row.exactIdentifierMatch)}`,
        `expectedFile=${row.candidateMatchesExpectedFile}`,
        `expectedSymbol=${row.candidateMatchesExpectedSymbol}`,
      ].join(" | ")
    );
    console.log(`  query: ${row.query}`);
    console.log(`  identifiers: ${row.queryIdentifiers.join(", ") || "(none)"}`);
    console.log(`  matched: ${row.matchedIdentifiers.join(", ") || "(none)"}`);
    console.log(`  candidate: ${formatRelative(row.candidateFile, summary.projectRoot)} ${row.candidateName} ${row.candidateChunkType}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
