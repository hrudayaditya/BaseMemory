import { readFileSync } from "fs";

import { isSearchTaskType } from "../indexer/search-recipes.js";

import type {
  EvalBudget,
  GoldenDataset,
  GoldenExpected,
  GoldenQuery,
  GoldenQueryType,
  GoldenQuerySource,
} from "./types.js";

function parseJsonFile(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function parseQueryType(value: unknown, path: string): GoldenQueryType {
  if (
    value === "definition" ||
    value === "identifier-heavy" ||
    value === "implementation-intent" ||
    value === "similarity" ||
    value === "keyword-heavy" ||
    value === "config-lookup" ||
    value === "config-constant-lookup" ||
    value === "test-discovery" ||
    value === "bug-report" ||
    value === "bug-error-lookup" ||
    value === "cross-file-relationship" ||
    value === "file-intent" ||
    value === "concept"
  ) {
    return value;
  }
  throw new Error(
    `${path} must be one of: definition, identifier-heavy, implementation-intent, similarity, keyword-heavy, config-lookup, config-constant-lookup, test-discovery, bug-report, bug-error-lookup, cross-file-relationship, file-intent, concept`
  );
}

function parseSource(value: unknown, path: string): GoldenQuerySource {
  if (value === "curated" || value === "generated") {
    return value;
  }
  throw new Error(`${path} must be one of: curated, generated`);
}

function parseTaskType(value: unknown, path: string) {
  if (typeof value === "string" && isSearchTaskType(value)) {
    return value;
  }
  throw new Error(`${path} must be a valid search task type`);
}

function parseExpected(input: unknown, path: string): GoldenExpected {
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const filePathRaw = input.filePath;
  const acceptableFilesRaw = input.acceptableFiles;
  const symbolRaw = input.symbol;
  const startLineRaw = input.startLine;
  const endLineRaw = input.endLine;
  const branchRaw = input.branch;

  const filePath = typeof filePathRaw === "string" ? filePathRaw : undefined;
  const acceptableFiles = isStringArray(acceptableFilesRaw) ? acceptableFilesRaw : undefined;

  if (!filePath && (!acceptableFiles || acceptableFiles.length === 0)) {
    throw new Error(`${path} must include either expected.filePath or expected.acceptableFiles`);
  }

  if (acceptableFilesRaw !== undefined && !isStringArray(acceptableFilesRaw)) {
    throw new Error(`${path}.acceptableFiles must be an array of strings`);
  }

  if (symbolRaw !== undefined && typeof symbolRaw !== "string") {
    throw new Error(`${path}.symbol must be a string when provided`);
  }

  if (startLineRaw !== undefined || endLineRaw !== undefined) {
    if (typeof startLineRaw !== "number" || !Number.isInteger(startLineRaw) || startLineRaw <= 0) {
      throw new Error(`${path}.startLine must be a positive integer when provided`);
    }
    if (typeof endLineRaw !== "number" || !Number.isInteger(endLineRaw) || endLineRaw <= 0) {
      throw new Error(`${path}.endLine must be a positive integer when provided`);
    }
    if (startLineRaw > endLineRaw) {
      throw new Error(`${path}.startLine must be less than or equal to ${path}.endLine`);
    }
  }

  if (branchRaw !== undefined && typeof branchRaw !== "string") {
    throw new Error(`${path}.branch must be a string when provided`);
  }

  return {
    filePath,
    acceptableFiles,
    symbol: typeof symbolRaw === "string" ? symbolRaw : undefined,
    startLine: typeof startLineRaw === "number" ? startLineRaw : undefined,
    endLine: typeof endLineRaw === "number" ? endLineRaw : undefined,
    branch: typeof branchRaw === "string" ? branchRaw : undefined,
  };
}

function parseQuery(input: unknown, index: number): GoldenQuery {
  const path = `queries[${index}]`;
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const id = input.id;
  const query = input.query;
  const queryType = input.queryType ?? input.query_type;
  const source = input.source;
  const heuristic = input.heuristic ?? input.generationHeuristic ?? input.generation_heuristic;
  const taskType = input.taskType ?? input.type;
  const expected = input.expected;

  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`${path}.query must be a non-empty string`);
  }

  if (heuristic !== undefined && typeof heuristic !== "string") {
    throw new Error(`${path}.heuristic must be a string when provided`);
  }

  const parsedSource =
    source === undefined ? undefined : parseSource(source, `${path}.source`);

  if (parsedSource === "generated" && (typeof heuristic !== "string" || heuristic.trim().length === 0)) {
    throw new Error(`${path}.heuristic must be provided for generated queries`);
  }

  return {
    id,
    query,
    queryType:
      queryType === undefined ? undefined : parseQueryType(queryType, `${path}.queryType`),
    source: parsedSource,
    heuristic: typeof heuristic === "string" ? heuristic : undefined,
    taskType:
      taskType === undefined ? undefined : parseTaskType(taskType, `${path}.taskType`),
    expected: parseExpected(expected, `${path}.expected`),
  };
}

export function parseGoldenDataset(raw: unknown, sourceLabel: string): GoldenDataset {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const version = raw.version;
  const name = raw.name;
  const description = raw.description;
  const queriesRaw = raw.queries;

  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`${sourceLabel}.version must be a non-empty string`);
  }

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (description !== undefined && typeof description !== "string") {
    throw new Error(`${sourceLabel}.description must be a string when provided`);
  }

  if (!Array.isArray(queriesRaw)) {
    throw new Error(`${sourceLabel}.queries must be an array`);
  }

  if (queriesRaw.length === 0) {
    throw new Error(`${sourceLabel}.queries must contain at least one query`);
  }

  const queries = queriesRaw.map((query, idx) => parseQuery(query, idx));
  const idSet = new Set<string>();

  for (const query of queries) {
    if (idSet.has(query.id)) {
      throw new Error(`${sourceLabel}.queries has duplicate id: ${query.id}`);
    }
    idSet.add(query.id);
  }

  return {
    version,
    name,
    description: typeof description === "string" ? description : undefined,
    queries,
  };
}

export function loadGoldenDataset(datasetPath: string): GoldenDataset {
  const parsed = parseJsonFile(datasetPath);
  return parseGoldenDataset(parsed, datasetPath);
}

export function parseBudget(raw: unknown, sourceLabel: string): EvalBudget {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const name = raw.name;
  const baselinePath = raw.baselinePath;
  const failOnMissingBaseline = raw.failOnMissingBaseline;
  const thresholds = raw.thresholds;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (baselinePath !== undefined && typeof baselinePath !== "string") {
    throw new Error(`${sourceLabel}.baselinePath must be a string when provided`);
  }

  if (!isRecord(thresholds)) {
    throw new Error(`${sourceLabel}.thresholds must be an object`);
  }

  return {
    name,
    baselinePath: typeof baselinePath === "string" ? baselinePath : undefined,
    failOnMissingBaseline:
      typeof failOnMissingBaseline === "boolean" ? failOnMissingBaseline : true,
    thresholds: {
      hitAt1MaxDrop:
        thresholds.hitAt1MaxDrop === undefined
          ? undefined
          : asPositiveNumber(thresholds.hitAt1MaxDrop, `${sourceLabel}.thresholds.hitAt1MaxDrop`),
      hitAt5MaxDrop:
        thresholds.hitAt5MaxDrop === undefined
          ? undefined
          : asPositiveNumber(thresholds.hitAt5MaxDrop, `${sourceLabel}.thresholds.hitAt5MaxDrop`),
      mrrAt10MaxDrop:
        thresholds.mrrAt10MaxDrop === undefined
          ? undefined
          : asPositiveNumber(thresholds.mrrAt10MaxDrop, `${sourceLabel}.thresholds.mrrAt10MaxDrop`),
      combinedRecallAt10MaxDrop:
        thresholds.combinedRecallAt10MaxDrop === undefined && thresholds.combinedRecallAt10 === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.combinedRecallAt10MaxDrop ?? thresholds.combinedRecallAt10,
              `${sourceLabel}.thresholds.combinedRecallAt10`
            ),
      expansionHitRateMaxDrop:
        thresholds.expansionHitRateMaxDrop === undefined && thresholds.expansionHitRate === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.expansionHitRateMaxDrop ?? thresholds.expansionHitRate,
              `${sourceLabel}.thresholds.expansionHitRate`
            ),
      p95LatencyMaxMultiplier:
        thresholds.p95LatencyMaxMultiplier === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.p95LatencyMaxMultiplier,
              `${sourceLabel}.thresholds.p95LatencyMaxMultiplier`
            ),
      p95LatencyMaxAbsoluteMs:
        thresholds.p95LatencyMaxAbsoluteMs === undefined
          ? undefined
          : asPositiveNumber(
              thresholds.p95LatencyMaxAbsoluteMs,
              `${sourceLabel}.thresholds.p95LatencyMaxAbsoluteMs`
            ),
      minHitAt1:
        thresholds.minHitAt1 === undefined
          ? undefined
          : asPositiveNumber(thresholds.minHitAt1, `${sourceLabel}.thresholds.minHitAt1`),
      minHitAt5:
        thresholds.minHitAt5 === undefined
          ? undefined
          : asPositiveNumber(thresholds.minHitAt5, `${sourceLabel}.thresholds.minHitAt5`),
      minMrrAt10:
        thresholds.minMrrAt10 === undefined
          ? undefined
          : asPositiveNumber(thresholds.minMrrAt10, `${sourceLabel}.thresholds.minMrrAt10`),
    },
  };
}

export function loadBudget(budgetPath: string): EvalBudget {
  const parsed = parseJsonFile(budgetPath);
  return parseBudget(parsed, budgetPath);
}
