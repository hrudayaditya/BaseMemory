import { existsSync } from "fs";
import { readFileSync } from "fs";
import { createServer, type Server } from "http";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { parseConfig, type ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { SearchConfig as ConfigSearchConfig } from "../config/schema.js";
import { getDefaultModelForProvider } from "../config/index.js";
import { Indexer } from "../indexer/index.js";
import {
  getSearchRecipe,
  mapEvalQueryTypeToTaskType,
  type SearchTaskType,
} from "../indexer/search-recipes.js";

import { evaluateBudgetGate } from "./budget.js";
import { compareSummaries } from "./compare.js";
import { buildPerQueryResult, computeEvalMetrics } from "./metrics.js";
import {
  createSummaryMarkdown,
  createRunDirectory,
  loadSummary,
  writeJson,
  writeText,
  buildPerQueryArtifact,
} from "./reports.js";
import { loadBudget, loadGoldenDataset } from "./schema.js";
import type {
  EvalComparison,
  EvalGateResult,
  EvalRunOptions,
  EvalSummary,
  PerQueryEvalResult,
  SweepAggregateReport,
  SweepDefinition,
  SweepRunSummary,
} from "./types.js";

const EVAL_MOCK_MODEL_ID = "mock-embedding-model";
const EVAL_PROVIDER_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_EVAL_TASK_TYPE: SearchTaskType = "general";
const DEFAULT_EVAL_GRAPH_DEPTH = 0;
const MIXED_EFFECTIVE_TASK_TYPE = "mixed";
const MIXED_EFFECTIVE_FINAL_RERANK_TOP_N = -1;
const MIXED_EFFECTIVE_GRAPH_DEPTH = -1;

function buildMockEmbedding(text: string): number[] {
  let seed = 0;
  for (const ch of String(text)) {
    seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
  }
  return Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
}

function isLocalEvalHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isBundledEvalMockConfig(config: ParsedCodebaseIndexConfig): boolean {
  if (config.embeddingProvider !== "custom" || !config.customProvider) {
    return false;
  }

  try {
    const baseUrl = new URL(config.customProvider.baseUrl);
    return isLocalEvalHostname(baseUrl.hostname) && config.customProvider.model === EVAL_MOCK_MODEL_ID;
  } catch {
    return false;
  }
}

async function probeCustomEmbeddingEndpoint(
  baseUrl: string,
  model: string,
  timeoutMs: number = EVAL_PROVIDER_PROBE_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: ["eval probe"],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        reason: `HTTP ${response.status}: ${errorText}`,
      };
    }

    return { ok: true };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function startBundledEvalMockServer(baseUrl: string): Promise<Server> {
  const parsed = new URL(baseUrl);
  const requestPath = `${parsed.pathname.replace(/\/+$/, "")}/embeddings`;
  const tagsPath = "/api/tags";
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === requestPath) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const payload = JSON.parse(body || "{}") as { input?: string | string[] };
        const texts = Array.isArray(payload.input)
          ? payload.input
          : typeof payload.input === "string"
            ? [payload.input]
            : [];
        const data = texts.map((text) => ({
          embedding: buildMockEmbedding(text),
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data,
            usage: {
              total_tokens: Math.max(1, texts.length * 8),
            },
          })
        );
      });
      return;
    }

    if (req.method === "GET" && req.url === tagsPath) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: EVAL_MOCK_MODEL_ID }] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, parsed.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withEvalEmbeddingEnvironment<T>(
  config: ParsedCodebaseIndexConfig,
  action: () => Promise<T>
): Promise<T> {
  if (config.embeddingProvider !== "custom" || !config.customProvider) {
    return action();
  }

  const { baseUrl, model, timeoutMs } = config.customProvider;
  let bundledMockServer: Server | null = null;
  let probe = await probeCustomEmbeddingEndpoint(baseUrl, model, timeoutMs);

  if (!probe.ok && isBundledEvalMockConfig(config)) {
    bundledMockServer = await startBundledEvalMockServer(baseUrl);
    probe = await probeCustomEmbeddingEndpoint(baseUrl, model, timeoutMs);
  }

  if (!probe.ok) {
    throw new Error(
      `Evaluation embedding provider is unreachable at ${baseUrl}/embeddings for model '${model}': ${probe.reason}. ` +
      `This previously caused eval to record zero hits against an empty retrievable corpus. ` +
      `Start the configured provider or use the built-in eval mock via customProvider.model='${EVAL_MOCK_MODEL_ID}' on a local baseUrl.`
    );
  }

  try {
    return await action();
  } finally {
    if (bundledMockServer) {
      await closeServer(bundledMockServer);
    }
  }
}

async function assertSearchableEvalCorpus(indexer: Indexer, indexStats: Awaited<ReturnType<Indexer["index"]>>): Promise<void> {
  if (indexStats.failedChunks > 0) {
    const detail = indexStats.failedBatchesPath
      ? ` See ${indexStats.failedBatchesPath} for failed embedding batches.`
      : "";
    throw new Error(
      `Evaluation indexing failed: ${indexStats.failedChunks} chunk(s) did not reach a durable retrievable state.${detail}`
    );
  }

  const status = await indexer.getStatus();
  if (!status.indexed || status.vectorCount === 0) {
    throw new Error(
      `Evaluation produced no searchable vectors at ${status.indexPath}. ` +
      `Refusing to emit retrieval metrics for an empty corpus.`
    );
  }
}

function toAbsolute(projectRoot: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(projectRoot, maybeRelative);
}

function loadRawConfig(projectRoot: string, configPath?: string): unknown {
  const fromPath = configPath ? toAbsolute(projectRoot, configPath) : null;
  if (fromPath && existsSync(fromPath)) {
    return JSON.parse(readFileSync(fromPath, "utf-8"));
  }

  const projectConfig = path.join(projectRoot, ".opencode", "codebase-index.json");
  if (existsSync(projectConfig)) {
    return JSON.parse(readFileSync(projectConfig, "utf-8"));
  }

  const globalConfig = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  if (existsSync(globalConfig)) {
    return JSON.parse(readFileSync(globalConfig, "utf-8"));
  }

  return {};
}

function loadParsedConfig(projectRoot: string, configPath?: string) {
  const raw = loadRawConfig(projectRoot, configPath);
  return parseConfig(raw);
}

function resolveSearchConfig(
  parsedConfig: ReturnType<typeof parseConfig>,
  overrides?: Partial<Pick<ConfigSearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>
) {
  const nextSearch: ConfigSearchConfig = {
    ...parsedConfig.search,
  };

  if (overrides?.fusionStrategy !== undefined) {
    nextSearch.fusionStrategy = overrides.fusionStrategy;
  }
  if (overrides?.hybridWeight !== undefined) {
    nextSearch.hybridWeight = overrides.hybridWeight;
  }
  if (overrides?.rrfK !== undefined) {
    nextSearch.rrfK = overrides.rrfK;
  }
  if (overrides?.rerankTopN !== undefined) {
    nextSearch.rerankTopN = overrides.rerankTopN;
  }

  return {
    ...parsedConfig,
    search: nextSearch,
  };
}

export interface EvalRunResult {
  outputDir: string;
  summary: EvalSummary;
  perQuery: PerQueryEvalResult[];
  comparison?: EvalComparison;
  gate?: EvalGateResult;
}

interface EvalQueryPlan {
  taskType: SearchTaskType;
  finalRerankTopN: number;
  graphDepth: number;
  bm25Weight?: number;
  denseWeight?: number;
  voyageWeight?: number;
  identifierBoost?: number;
  filterByBranch: boolean;
}

function resolveEvalTaskType(
  effectiveConfig: ReturnType<typeof resolveSearchConfig>,
  query: Pick<PerQueryEvalResult, "queryType"> & { taskType?: SearchTaskType },
  taskTypeOverride?: SearchTaskType
): SearchTaskType {
  if (taskTypeOverride) {
    return taskTypeOverride;
  }

  if (query.taskType) {
    return query.taskType;
  }

  if (!effectiveConfig.eval.useQueryTypes || !query.queryType) {
    return DEFAULT_EVAL_TASK_TYPE;
  }

  return mapEvalQueryTypeToTaskType(query.queryType);
}

function resolveEvalQueryPlan(
  effectiveConfig: ReturnType<typeof resolveSearchConfig>,
  query: Pick<PerQueryEvalResult, "queryType"> & { taskType?: SearchTaskType },
  recipeOverrides: EvalRunOptions["recipeOverrides"],
  taskTypeOverride: EvalRunOptions["taskTypeOverride"],
  expectedBranch?: string
): EvalQueryPlan {
  const taskType = resolveEvalTaskType(effectiveConfig, query, taskTypeOverride);
  const recipe = getSearchRecipe(taskType);

  return {
    taskType,
    finalRerankTopN: recipeOverrides?.finalRerankTopN ?? recipe.finalRerankTopN,
    graphDepth: recipeOverrides?.graphDepth ?? recipe.graphDepth ?? DEFAULT_EVAL_GRAPH_DEPTH,
    bm25Weight: recipeOverrides?.bm25Weight,
    denseWeight: recipeOverrides?.denseWeight,
    voyageWeight: recipeOverrides?.voyageWeight,
    identifierBoost: recipeOverrides?.identifierBoost,
    filterByBranch: expectedBranch ? true : false,
  };
}

function summarizeEffectiveEvalConfig(plans: EvalQueryPlan[]): Pick<
  EvalSummary["searchConfig"],
  "effectiveTaskType" | "effectiveFinalRerankTopN" | "effectiveGraphDepth"
> {
  if (plans.length === 0) {
    return {
      effectiveTaskType: DEFAULT_EVAL_TASK_TYPE,
      effectiveFinalRerankTopN: getSearchRecipe(DEFAULT_EVAL_TASK_TYPE).finalRerankTopN,
      effectiveGraphDepth: DEFAULT_EVAL_GRAPH_DEPTH,
    };
  }

  const [firstPlan] = plans;
  const sameTaskType = plans.every((plan) => plan.taskType === firstPlan.taskType);
  const sameFinalRerankTopN = plans.every(
    (plan) => plan.finalRerankTopN === firstPlan.finalRerankTopN
  );
  const sameGraphDepth = plans.every((plan) => plan.graphDepth === firstPlan.graphDepth);

  return {
    effectiveTaskType: sameTaskType ? firstPlan.taskType : MIXED_EFFECTIVE_TASK_TYPE,
    effectiveFinalRerankTopN: sameFinalRerankTopN
      ? firstPlan.finalRerankTopN
      : MIXED_EFFECTIVE_FINAL_RERANK_TOP_N,
    effectiveGraphDepth: sameGraphDepth ? firstPlan.graphDepth : MIXED_EFFECTIVE_GRAPH_DEPTH,
  };
}

/**
 * Orchestrates eval output artifact writing for a completed run.
 * Writes summary.json, per-query.json, compare.json, and summary.md.
 */
async function finalizeEvaluationRun(
  options: EvalRunOptions,
  indexer: Indexer,
  effectiveConfig: ReturnType<typeof resolveSearchConfig>,
  datasetPath: string,
  againstPath: string | undefined,
  budgetPath: string | undefined
): Promise<EvalRunResult> {
  const dataset = loadGoldenDataset(datasetPath);
  const perQuery: PerQueryEvalResult[] = [];
  const effectivePlans: EvalQueryPlan[] = [];

  for (const query of dataset.queries) {
    if (query.expected.branch && query.expected.branch !== indexer.getCurrentBranch()) {
      throw new Error(
        `Query '${query.id}' expects branch '${query.expected.branch}', but current branch is '${indexer.getCurrentBranch()}'. Switch branch before running this dataset.`
      );
    }

    const queryPlan = resolveEvalQueryPlan(
      effectiveConfig,
      query,
      options.recipeOverrides,
      options.taskTypeOverride,
      query.expected.branch
    );
    effectivePlans.push(queryPlan);

    const start = performance.now();
    const searchResponse = await indexer.searchDetailed(query.query, 10, {
      metadataOnly: true,
      filterByBranch: queryPlan.filterByBranch,
      taskType: queryPlan.taskType,
      graphDepth: queryPlan.graphDepth,
      finalRerankTopN: queryPlan.finalRerankTopN,
      bm25Weight: queryPlan.bm25Weight,
      denseWeight: queryPlan.denseWeight,
      voyageWeight: queryPlan.voyageWeight,
      identifierBoost: queryPlan.identifierBoost,
      includeScoreBreakdown: true,
    });
    const elapsed = performance.now() - start;

    const materialized = searchResponse.primaryResults.map((item) => ({
      filePath: item.filePath,
      startLine: item.startLine,
      endLine: item.endLine,
      score: item.score,
      chunkType: item.chunkType,
      name: item.name,
      scoreBreakdown: item.scoreBreakdown,
    }));
    const expandedMaterialized = searchResponse.expandedContext.map((item) => ({
      filePath: item.filePath,
      startLine: item.startLine,
      endLine: item.endLine,
      score: item.score,
      chunkType: item.chunkType,
      name: item.name,
    }));

    perQuery.push(
      buildPerQueryResult(query, materialized, elapsed, 10, {
        effectiveTaskType: queryPlan.taskType,
        subIntent: searchResponse.subIntent,
        effectiveFinalRerankTopN: queryPlan.finalRerankTopN,
        effectiveGraphDepth: queryPlan.graphDepth,
      }, expandedMaterialized, searchResponse.expandedContext.map((entry) => entry.relation), {
        prefilterMs: searchResponse.timings?.prefilterMs,
      })
    );
  }

  const logger = indexer.getLogger();
  const metricSnapshot = logger.getMetrics();

  const costPer1MTokensUsd =
    effectiveConfig.embeddingProvider === "custom" || effectiveConfig.embeddingProvider === "auto"
      ? 0
      : getDefaultModelForProvider(effectiveConfig.embeddingProvider).costPer1MTokens;
  const effectiveSearchConfig = summarizeEffectiveEvalConfig(effectivePlans);

  const summary: EvalSummary = {
    generatedAt: new Date().toISOString(),
    projectRoot: options.projectRoot,
    datasetPath,
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    queryCount: dataset.queries.length,
    topK: 10,
    searchConfig: {
      fusionStrategy: effectiveConfig.search.fusionStrategy,
      hybridWeight: effectiveConfig.search.hybridWeight,
      rrfK: effectiveConfig.search.rrfK,
      rerankTopN: effectiveConfig.search.rerankTopN,
      useQueryTypes: effectiveConfig.eval.useQueryTypes,
      taskTypeOverride: options.taskTypeOverride,
      recipeOverrides: options.recipeOverrides,
      effectiveTaskType: effectiveSearchConfig.effectiveTaskType,
      effectiveFinalRerankTopN: effectiveSearchConfig.effectiveFinalRerankTopN,
      effectiveGraphDepth: effectiveSearchConfig.effectiveGraphDepth,
    },
    metrics: computeEvalMetrics(
      dataset.queries,
      perQuery,
      metricSnapshot.embeddingApiCalls,
      metricSnapshot.embeddingTokensUsed,
      costPer1MTokensUsd
    ),
  };
  summary.metrics.reranker = {
    appliedCount: metricSnapshot.rerankerAppliedCount,
    failureCount: metricSnapshot.rerankerFailureCount,
    backendUsage: metricSnapshot.rerankerBackendCounts,
    lastMs: metricSnapshot.rerankerMs,
  };

  const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
  const perQueryArtifact = buildPerQueryArtifact(perQuery);

  writeJson(path.join(outputDir, "summary.json"), summary);
  writeJson(path.join(outputDir, "per-query.json"), perQueryArtifact);

  let comparison: EvalComparison | undefined;
  if (againstPath) {
    const baseline = loadSummary(againstPath);
    comparison = compareSummaries(summary, baseline, againstPath);
    writeJson(path.join(outputDir, "compare.json"), comparison);
  }

  let gate: EvalGateResult | undefined;
  if (options.ciMode) {
    if (!budgetPath) {
      throw new Error("CI mode requires --budget path");
    }
    const budget = loadBudget(budgetPath);

    if (!comparison && budget.baselinePath) {
      const resolvedBaseline = toAbsolute(options.projectRoot, budget.baselinePath);
      if (existsSync(resolvedBaseline)) {
        const baselineSummary = loadSummary(resolvedBaseline);
        comparison = compareSummaries(summary, baselineSummary, resolvedBaseline);
        writeJson(path.join(outputDir, "compare.json"), comparison);
      } else if (budget.failOnMissingBaseline) {
        throw new Error(
          `Budget baseline is missing: ${resolvedBaseline}. Set failOnMissingBaseline=false to allow CI run without baseline.`
        );
      }
    }

    gate = evaluateBudgetGate(budget, summary, comparison);
  }

  const markdown = createSummaryMarkdown(summary, comparison, gate);
  writeText(path.join(outputDir, "summary.md"), markdown);

  return { outputDir, summary, perQuery, comparison, gate };
}

function applySearchConfigToIndexer(
  indexer: Indexer,
  effectiveConfig: ReturnType<typeof resolveSearchConfig>
): void {
  const mutableIndexer = indexer as unknown as {
    config: ReturnType<typeof resolveSearchConfig>;
  };
  mutableIndexer.config = {
    ...mutableIndexer.config,
    search: { ...effectiveConfig.search },
  };
}

async function prepareEvalIndexer(
  options: EvalRunOptions,
  effectiveConfig: ReturnType<typeof resolveSearchConfig>
): Promise<Indexer> {
  const indexer = new Indexer(options.projectRoot, effectiveConfig);
  if (options.reindex) {
    await indexer.clearIndex();
  }
  return indexer;
}

export async function runEvaluation(options: EvalRunOptions): Promise<EvalRunResult> {
  const datasetPath = toAbsolute(options.projectRoot, options.datasetPath);
  const againstPath = options.againstPath ? toAbsolute(options.projectRoot, options.againstPath) : undefined;
  const budgetPath = options.budgetPath ? toAbsolute(options.projectRoot, options.budgetPath) : undefined;
  const parsedConfig = loadParsedConfig(options.projectRoot, options.configPath);
  const effectiveConfig = resolveSearchConfig(parsedConfig, options.searchOverrides);

  return withEvalEmbeddingEnvironment(parsedConfig, async () => {
    const indexer = await prepareEvalIndexer(options, effectiveConfig);
    const indexStats = await indexer.index();
    await assertSearchableEvalCorpus(indexer, indexStats);

    return finalizeEvaluationRun(
      options,
      indexer,
      effectiveConfig,
      datasetPath,
      againstPath,
      budgetPath
    );
  });
}

export async function runSweep(
  options: EvalRunOptions,
  sweep: SweepDefinition
): Promise<{ outputDir: string; aggregate: SweepAggregateReport }> {
  const datasetPath = toAbsolute(options.projectRoot, options.datasetPath);
  const againstPath = options.againstPath ? toAbsolute(options.projectRoot, options.againstPath) : undefined;
  const budgetPath = options.budgetPath ? toAbsolute(options.projectRoot, options.budgetPath) : undefined;
  const parsedConfig = loadParsedConfig(options.projectRoot, options.configPath);
  const fusionValues: Array<"rrf" | "weighted" | undefined> =
    sweep.fusionStrategy && sweep.fusionStrategy.length > 0
      ? [...sweep.fusionStrategy]
      : [undefined];
  const weightValues: Array<number | undefined> =
    sweep.hybridWeight && sweep.hybridWeight.length > 0 ? [...sweep.hybridWeight] : [undefined];
  const rrfValues: Array<number | undefined> =
    sweep.rrfK && sweep.rrfK.length > 0 ? [...sweep.rrfK] : [undefined];
  const rerankValues: Array<number | undefined> =
    sweep.rerankTopN && sweep.rerankTopN.length > 0 ? [...sweep.rerankTopN] : [undefined];
  const recipeBm25Values: Array<number | undefined> =
    sweep.recipeOverrides?.bm25Weight && sweep.recipeOverrides.bm25Weight.length > 0
      ? [...sweep.recipeOverrides.bm25Weight]
      : [options.recipeOverrides?.bm25Weight];
  const recipeDenseValues: Array<number | undefined> =
    sweep.recipeOverrides?.denseWeight && sweep.recipeOverrides.denseWeight.length > 0
      ? [...sweep.recipeOverrides.denseWeight]
      : [options.recipeOverrides?.denseWeight];
  const recipeVoyageValues: Array<number | undefined> =
    sweep.recipeOverrides?.voyageWeight && sweep.recipeOverrides.voyageWeight.length > 0
      ? [...sweep.recipeOverrides.voyageWeight]
      : [options.recipeOverrides?.voyageWeight];
  const recipeIdentifierBoostValues: Array<number | undefined> =
    sweep.recipeOverrides?.identifierBoost && sweep.recipeOverrides.identifierBoost.length > 0
      ? [...sweep.recipeOverrides.identifierBoost]
      : [options.recipeOverrides?.identifierBoost];
  const recipeGraphDepthValues: Array<number | undefined> =
    sweep.recipeOverrides?.graphDepth && sweep.recipeOverrides.graphDepth.length > 0
      ? [...sweep.recipeOverrides.graphDepth]
      : [options.recipeOverrides?.graphDepth];
  const recipeFinalRerankValues: Array<number | undefined> =
    sweep.recipeOverrides?.finalRerankTopN && sweep.recipeOverrides.finalRerankTopN.length > 0
      ? [...sweep.recipeOverrides.finalRerankTopN]
      : [options.recipeOverrides?.finalRerankTopN];
  const taskTypeValues: Array<SearchTaskType | undefined> =
    sweep.taskType && sweep.taskType.length > 0 ? [...sweep.taskType] : [options.taskTypeOverride];

  const runs: SweepRunSummary[] = [];
  let sweepIndexer: Indexer | null = null;

  await withEvalEmbeddingEnvironment(parsedConfig, async () => {
    for (const fusion of fusionValues) {
      for (const hybridWeight of weightValues) {
        for (const rrfK of rrfValues) {
          for (const rerankTopN of rerankValues) {
            for (const recipeBm25Weight of recipeBm25Values) {
              for (const recipeDenseWeight of recipeDenseValues) {
                for (const recipeIdentifierBoost of recipeIdentifierBoostValues) {
                  for (const recipeVoyageWeight of recipeVoyageValues) {
                    for (const recipeGraphDepth of recipeGraphDepthValues) {
                      for (const recipeFinalRerankTopN of recipeFinalRerankValues) {
                        for (const taskTypeOverride of taskTypeValues) {
                          const effectiveConfig = resolveSearchConfig(parsedConfig, {
                            ...(fusion !== undefined ? { fusionStrategy: fusion } : {}),
                            ...(hybridWeight !== undefined ? { hybridWeight } : {}),
                            ...(rrfK !== undefined ? { rrfK } : {}),
                            ...(rerankTopN !== undefined ? { rerankTopN } : {}),
                          });
                          const effectiveRunOptions: EvalRunOptions = {
                            ...options,
                            taskTypeOverride,
                            recipeOverrides: {
                              ...(recipeBm25Weight !== undefined ? { bm25Weight: recipeBm25Weight } : {}),
                              ...(recipeDenseWeight !== undefined ? { denseWeight: recipeDenseWeight } : {}),
                              ...(recipeVoyageWeight !== undefined ? { voyageWeight: recipeVoyageWeight } : {}),
                              ...(recipeIdentifierBoost !== undefined ? { identifierBoost: recipeIdentifierBoost } : {}),
                              ...(recipeGraphDepth !== undefined ? { graphDepth: recipeGraphDepth } : {}),
                              ...(recipeFinalRerankTopN !== undefined ? { finalRerankTopN: recipeFinalRerankTopN } : {}),
                            },
                          };

                          if (!sweepIndexer) {
                            sweepIndexer = await prepareEvalIndexer(options, effectiveConfig);
                            const indexStats = await sweepIndexer.index();
                            await assertSearchableEvalCorpus(sweepIndexer, indexStats);
                          } else {
                            // Search-parameter sweeps do not change indexed artifacts, so reuse
                            // the same indexer instance and swap only the search config.
                            applySearchConfigToIndexer(sweepIndexer, effectiveConfig);
                          }

                          const run = await finalizeEvaluationRun(
                            effectiveRunOptions,
                            sweepIndexer,
                            effectiveConfig,
                            datasetPath,
                            againstPath,
                            budgetPath
                          );

                          runs.push({
                            searchConfig: run.summary.searchConfig,
                            summary: run.summary,
                            comparison: run.comparison,
                            gate: run.gate,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  const bestByHitAt5 = [...runs].sort(
    (a, b) => b.summary.metrics.hitAt5 - a.summary.metrics.hitAt5
  )[0];
  const bestByMrrAt10 = [...runs].sort(
    (a, b) => b.summary.metrics.mrrAt10 - a.summary.metrics.mrrAt10
  )[0];
  const bestByP95Latency = [...runs].sort(
    (a, b) => a.summary.metrics.latencyMs.p95 - b.summary.metrics.latencyMs.p95
  )[0];

  const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
  const failedGateRuns = runs.filter((run) => run.gate && !run.gate.passed).length;
  const gatePassed = failedGateRuns === 0;
  const aggregate: SweepAggregateReport = {
    generatedAt: new Date().toISOString(),
    againstPath: options.againstPath,
    runCount: runs.length,
    runs,
    gatePassed,
    failedGateRuns,
    bestByHitAt5,
    bestByMrrAt10,
    bestByP95Latency,
  };

  writeJson(path.join(outputDir, "compare.json"), aggregate);
  const md = createSummaryMarkdown(
    bestByHitAt5?.summary ?? runs[0].summary,
    bestByHitAt5?.comparison,
    undefined,
    aggregate
  );
  writeText(path.join(outputDir, "summary.md"), md);
  writeJson(path.join(outputDir, "summary.json"), bestByHitAt5?.summary ?? runs[0].summary);

  return { outputDir, aggregate };
}
