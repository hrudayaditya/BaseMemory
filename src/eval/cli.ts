import * as path from "path";

import { isSearchTaskType, type SearchTaskType } from "../indexer/search-recipes.js";

import { compareSummaries } from "./compare.js";
import { createSummaryMarkdown, createRunDirectory, loadSummary, writeJson, writeText } from "./reports.js";
import { runEvaluation, runSweep } from "./runner.js";
import type { EvalRunOptions, SweepDefinition } from "./types.js";

interface ParsedArgs {
  projectRoot: string;
  configPath?: string;
  datasetPath: string;
  currentPath?: string;
  outputRoot: string;
  againstPath?: string;
  budgetPath?: string;
  ciMode: boolean;
  reindex: boolean;
  fusionStrategy?: "rrf" | "weighted";
  hybridWeight?: number;
  rrfK?: number;
  rerankTopN?: number;
  taskType?: SearchTaskType;
  bm25Weight?: number;
  denseWeight?: number;
  voyageWeight?: number;
  identifierBoost?: number;
  graphDepth?: number;
  finalRerankTopN?: number;
  sweep: SweepDefinition;
}

interface EvalSubcommandOptions {
  parsed: ParsedArgs;
  explicitAgainst?: string;
}

function printUsage(): void {
  console.log(`
Usage:
  opencode-codebase-index-mcp eval run [options]
  opencode-codebase-index-mcp eval gate [options]
  opencode-codebase-index-mcp eval compare --against <summary.json> [options]
  opencode-codebase-index-mcp eval diff --current <summary.json> --against <summary.json> [options]

Options:
  --project <path>                 Project root (default: cwd)
  --config <path>                  Config JSON path
  --dataset <path>                 Golden dataset path (default: benchmarks/golden/small.json)
  --current <path>                 Current summary.json path (required for eval diff)
  --output <path>                  Output root dir (default: benchmarks/results)
  --against <path>                 Baseline summary.json to compare against
  --budget <path>                  Budget file for CI mode (default: benchmarks/budgets/default.json)
  --ci                             Enable CI gate mode
  --reindex                        Force reindex before eval

Search overrides:
  --fusionStrategy <rrf|weighted>
  --hybridWeight <0-1>
  --rrfK <number>
  --rerankTopN <number>
  --taskType <general|definition|bug|test_debug|semantic>
  --bm25Weight <0-1>
  --denseWeight <0-1>
  --voyageWeight <0-1>
  --identifierBoost <number>
  --graphDepth <number>
  --finalRerankTopN <number>

Sweep options (comma-separated values):
  --sweepFusionStrategy <rrf,weighted>
  --sweepHybridWeight <0.3,0.5,0.7>
  --sweepRrfK <30,60,90>
  --sweepRerankTopN <10,20,40>
  --sweepTaskType <general,test_debug,bug>
  --sweepBm25Weight <0.3,0.5,0.7>
  --sweepDenseWeight <0.3,0.5,0.7>
  --sweepVoyageWeight <0.1,0.2,0.4>
  --sweepIdentifierBoost <1,1.5,2>
  --sweepGraphDepth <0,1,2>
  --sweepFinalRerankTopN <0,10,20>
`);
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be a number`);
  }
  return parsed;
}

function parseCsvNumbers(value: string, flag: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => parseNumber(item, flag));
}

function parseCsvFusion(value: string): Array<"rrf" | "weighted"> {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const parsed: Array<"rrf" | "weighted"> = [];
  for (const candidate of values) {
    if (candidate !== "rrf" && candidate !== "weighted") {
      throw new Error("--sweepFusionStrategy accepts only rrf,weighted");
    }
    parsed.push(candidate);
  }
  return parsed;
}

function parseTaskTypeArg(value: string, flag: string): SearchTaskType {
  if (!isSearchTaskType(value)) {
    throw new Error(`${flag} must be one of: general, definition, bug, test_debug, semantic`);
  }
  return value;
}

function parseCsvTaskTypes(value: string, flag: string): SearchTaskType[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => parseTaskTypeArg(item, flag));
}

function hasSweepOptions(sweep: SweepDefinition): boolean {
  return Boolean(
    (sweep.fusionStrategy && sweep.fusionStrategy.length > 0) ||
      (sweep.hybridWeight && sweep.hybridWeight.length > 0) ||
      (sweep.rrfK && sweep.rrfK.length > 0) ||
      (sweep.rerankTopN && sweep.rerankTopN.length > 0) ||
      (sweep.taskType && sweep.taskType.length > 0) ||
      (sweep.recipeOverrides?.bm25Weight && sweep.recipeOverrides.bm25Weight.length > 0) ||
      (sweep.recipeOverrides?.denseWeight && sweep.recipeOverrides.denseWeight.length > 0) ||
      (sweep.recipeOverrides?.voyageWeight && sweep.recipeOverrides.voyageWeight.length > 0) ||
      (sweep.recipeOverrides?.identifierBoost && sweep.recipeOverrides.identifierBoost.length > 0) ||
      (sweep.recipeOverrides?.graphDepth && sweep.recipeOverrides.graphDepth.length > 0) ||
      (sweep.recipeOverrides?.finalRerankTopN && sweep.recipeOverrides.finalRerankTopN.length > 0)
  );
}

function parseEvalArgs(argv: string[], cwd: string): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: cwd,
    datasetPath: "benchmarks/golden/small.json",
    outputRoot: "benchmarks/results",
    budgetPath: "benchmarks/budgets/default.json",
    ciMode: false,
    reindex: false,
    sweep: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--project" && next) {
      parsed.projectRoot = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === "--config" && next) {
      parsed.configPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === "--dataset" && next) {
      parsed.datasetPath = next;
      i += 1;
      continue;
    }
    if (arg === "--current" && next) {
      parsed.currentPath = next;
      i += 1;
      continue;
    }
    if (arg === "--output" && next) {
      parsed.outputRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--against" && next) {
      parsed.againstPath = next;
      i += 1;
      continue;
    }
    if (arg === "--budget" && next) {
      parsed.budgetPath = next;
      i += 1;
      continue;
    }
    if (arg === "--ci") {
      parsed.ciMode = true;
      continue;
    }
    if (arg === "--reindex") {
      parsed.reindex = true;
      continue;
    }
    if (arg === "--fusionStrategy" && next) {
      if (next !== "rrf" && next !== "weighted") {
        throw new Error("--fusionStrategy must be rrf or weighted");
      }
      parsed.fusionStrategy = next;
      i += 1;
      continue;
    }
    if (arg === "--hybridWeight" && next) {
      parsed.hybridWeight = parseNumber(next, "--hybridWeight");
      i += 1;
      continue;
    }
    if (arg === "--rrfK" && next) {
      parsed.rrfK = parseNumber(next, "--rrfK");
      i += 1;
      continue;
    }
    if (arg === "--rerankTopN" && next) {
      parsed.rerankTopN = parseNumber(next, "--rerankTopN");
      i += 1;
      continue;
    }
    if (arg === "--taskType" && next) {
      parsed.taskType = parseTaskTypeArg(next, "--taskType");
      i += 1;
      continue;
    }
    if (arg === "--bm25Weight" && next) {
      parsed.bm25Weight = parseNumber(next, "--bm25Weight");
      i += 1;
      continue;
    }
    if (arg === "--denseWeight" && next) {
      parsed.denseWeight = parseNumber(next, "--denseWeight");
      i += 1;
      continue;
    }
    if (arg === "--voyageWeight" && next) {
      parsed.voyageWeight = parseNumber(next, "--voyageWeight");
      i += 1;
      continue;
    }
    if (arg === "--identifierBoost" && next) {
      parsed.identifierBoost = parseNumber(next, "--identifierBoost");
      i += 1;
      continue;
    }
    if (arg === "--graphDepth" && next) {
      parsed.graphDepth = parseNumber(next, "--graphDepth");
      i += 1;
      continue;
    }
    if (arg === "--finalRerankTopN" && next) {
      parsed.finalRerankTopN = parseNumber(next, "--finalRerankTopN");
      i += 1;
      continue;
    }
    if (arg === "--sweepFusionStrategy" && next) {
      parsed.sweep.fusionStrategy = parseCsvFusion(next);
      i += 1;
      continue;
    }
    if (arg === "--sweepHybridWeight" && next) {
      parsed.sweep.hybridWeight = parseCsvNumbers(next, "--sweepHybridWeight");
      i += 1;
      continue;
    }
    if (arg === "--sweepRrfK" && next) {
      parsed.sweep.rrfK = parseCsvNumbers(next, "--sweepRrfK");
      i += 1;
      continue;
    }
    if (arg === "--sweepRerankTopN" && next) {
      parsed.sweep.rerankTopN = parseCsvNumbers(next, "--sweepRerankTopN");
      i += 1;
      continue;
    }
    if (arg === "--sweepTaskType" && next) {
      parsed.sweep.taskType = parseCsvTaskTypes(next, "--sweepTaskType");
      i += 1;
      continue;
    }
    if (arg === "--sweepBm25Weight" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        bm25Weight: parseCsvNumbers(next, "--sweepBm25Weight"),
      };
      i += 1;
      continue;
    }
    if (arg === "--sweepDenseWeight" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        denseWeight: parseCsvNumbers(next, "--sweepDenseWeight"),
      };
      i += 1;
      continue;
    }
    if (arg === "--sweepVoyageWeight" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        voyageWeight: parseCsvNumbers(next, "--sweepVoyageWeight"),
      };
      i += 1;
      continue;
    }
    if (arg === "--sweepIdentifierBoost" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        identifierBoost: parseCsvNumbers(next, "--sweepIdentifierBoost"),
      };
      i += 1;
      continue;
    }
    if (arg === "--sweepGraphDepth" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        graphDepth: parseCsvNumbers(next, "--sweepGraphDepth"),
      };
      i += 1;
      continue;
    }
    if (arg === "--sweepFinalRerankTopN" && next) {
      parsed.sweep.recipeOverrides = {
        ...parsed.sweep.recipeOverrides,
        finalRerankTopN: parseCsvNumbers(next, "--sweepFinalRerankTopN"),
      };
      i += 1;
      continue;
    }
  }

  return parsed;
}

function parseEvalSubcommandOptions(argv: string[], cwd: string): EvalSubcommandOptions {
  let explicitAgainst: string | undefined;
  const filtered: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--against" && next) {
      explicitAgainst = next;
      i += 1;
      continue;
    }

    filtered.push(current);
  }

  return {
    parsed: parseEvalArgs(filtered, cwd),
    explicitAgainst,
  };
}

function toRunOptions(parsed: ParsedArgs): EvalRunOptions {
  return {
    projectRoot: parsed.projectRoot,
    configPath: parsed.configPath,
    datasetPath: parsed.datasetPath,
    outputRoot: parsed.outputRoot,
    againstPath: parsed.againstPath,
    budgetPath: parsed.budgetPath,
    ciMode: parsed.ciMode,
    reindex: parsed.reindex,
    taskTypeOverride: parsed.taskType,
    searchOverrides: {
      ...(parsed.fusionStrategy !== undefined ? { fusionStrategy: parsed.fusionStrategy } : {}),
      ...(parsed.hybridWeight !== undefined ? { hybridWeight: parsed.hybridWeight } : {}),
      ...(parsed.rrfK !== undefined ? { rrfK: parsed.rrfK } : {}),
      ...(parsed.rerankTopN !== undefined ? { rerankTopN: parsed.rerankTopN } : {}),
    },
    recipeOverrides: {
      ...(parsed.bm25Weight !== undefined ? { bm25Weight: parsed.bm25Weight } : {}),
      ...(parsed.denseWeight !== undefined ? { denseWeight: parsed.denseWeight } : {}),
      ...(parsed.voyageWeight !== undefined ? { voyageWeight: parsed.voyageWeight } : {}),
      ...(parsed.identifierBoost !== undefined ? { identifierBoost: parsed.identifierBoost } : {}),
      ...(parsed.graphDepth !== undefined ? { graphDepth: parsed.graphDepth } : {}),
      ...(parsed.finalRerankTopN !== undefined ? { finalRerankTopN: parsed.finalRerankTopN } : {}),
    },
  };
}

export async function handleEvalCommand(args: string[], cwd: string): Promise<number> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return 0;
  }

  if (subcommand === "run") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (explicitAgainst) {
      parsed.againstPath = explicitAgainst;
    }
    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval sweep complete. Artifacts: ${sweep.outputDir}`);
      console.log(`Sweep runs: ${sweep.aggregate.runCount}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval run complete. Artifacts: ${result.outputDir}`);
    console.log(
      `Hit@5=${(result.summary.metrics.hitAt5 * 100).toFixed(2)}% MRR@10=${result.summary.metrics.mrrAt10.toFixed(4)} p95=${result.summary.metrics.latencyMs.p95.toFixed(3)}ms`
    );

    if (result.gate && !result.gate.passed) {
      for (const violation of result.gate.violations) {
        console.error(`[CI-GATE] ${violation.metric}: ${violation.message}`);
      }
      return 1;
    }

    return 0;
  }

  if (subcommand === "gate") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (explicitAgainst) {
      parsed.againstPath = explicitAgainst;
    }
    parsed.ciMode = true;
    const result = await runEvaluation(toRunOptions(parsed));
    console.log(`Eval gate complete. Artifacts: ${result.outputDir}`);
    if (result.gate && !result.gate.passed) {
      for (const regression of result.gate.regressions) {
        console.error(
          `[CI-GATE] ${regression.metric}: baseline=${regression.baseline.toFixed(4)} current=${regression.current.toFixed(4)} delta=${regression.delta.toFixed(4)} threshold=${regression.threshold.toFixed(4)}`
        );
      }
      for (const violation of result.gate.violations) {
        console.error(`[CI-GATE] ${violation.metric}: ${violation.message}`);
      }
      return 1;
    }
    return 0;
  }

  if (subcommand === "compare") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);

    if (!explicitAgainst) {
      throw new Error("eval compare requires --against <baseline summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval compare sweep complete. Artifacts: ${sweep.outputDir}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval compare complete. Artifacts: ${result.outputDir}`);
    return 0;
  }

  if (subcommand === "diff") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (!explicitAgainst) {
      throw new Error("eval diff requires --against <baseline summary.json>");
    }
    if (!parsed.currentPath) {
      throw new Error("eval diff requires --current <current summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const currentPath = parsed.currentPath;
    if (!currentPath.endsWith(".json")) {
      throw new Error("eval diff --current must point to a summary JSON file");
    }
    if (!parsed.againstPath.endsWith(".json")) {
      throw new Error("eval diff --against must point to a summary JSON file");
    }
    const currentSummary = loadSummary(path.resolve(parsed.projectRoot, currentPath));
    const baselineSummary = loadSummary(path.resolve(parsed.projectRoot, parsed.againstPath));
    const comparison = compareSummaries(
      currentSummary,
      baselineSummary,
      path.resolve(parsed.projectRoot, parsed.againstPath)
    );

    const outputDir = createRunDirectory(path.resolve(parsed.projectRoot, parsed.outputRoot));
    const summaryMd = createSummaryMarkdown(currentSummary, comparison);
    writeJson(path.join(outputDir, "compare.json"), comparison);
    writeText(path.join(outputDir, "summary.md"), summaryMd);
    writeJson(path.join(outputDir, "summary.json"), currentSummary);
    console.log(`Eval diff complete. Artifacts: ${outputDir}`);
    return 0;
  }

  throw new Error(`Unknown eval subcommand: ${subcommand}`);
}
