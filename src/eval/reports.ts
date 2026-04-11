import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

import type {
  EvalComparison,
  EvalGateResult,
  EvalSummary,
  PerQueryEvalResult,
  SweepAggregateReport,
} from "./types.js";

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(3)}ms`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatEffectiveFinalRerankTopN(value: number): string {
  return value < 0 ? "mixed per-query" : String(value);
}

function formatEffectiveGraphDepth(value: number): string {
  return value < 0 ? "mixed per-query" : String(value);
}

function formatRawSearchConfig(config: EvalSummary["searchConfig"]): string {
  const fusionMode = config.fusionStrategy;
  const hybridBlend = config.hybridWeight;
  const reciprocalRankWindow = config.rrfK;
  const earlyRerankLimit = config.rerankTopN;
  const recipeOverrideParts = config.recipeOverrides
    ? Object.entries(config.recipeOverrides)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
    : [];

  const base = `fusion=${fusionMode}, hybrid weight=${hybridBlend}, RRF k=${reciprocalRankWindow}, early rerank top-N=${earlyRerankLimit}`;
  return recipeOverrideParts.length > 0
    ? `${base}, recipe overrides={${recipeOverrideParts.join(", ")}}`
    : base;
}

function signed(value: number, digits = 4): string {
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

export function loadSummary(summaryPath: string): EvalSummary {
  const raw = readFileSync(summaryPath, "utf-8");
  return JSON.parse(raw) as EvalSummary;
}

export function createRunDirectory(outputRoot: string, timestampOverride?: string): string {
  const timestamp = (timestampOverride ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const dir = path.join(outputRoot, timestamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export function writeText(filePath: string, value: string): void {
  writeFileSync(filePath, value, "utf-8");
}

export function createSummaryMarkdown(
  summary: EvalSummary,
  comparison?: EvalComparison,
  gate?: EvalGateResult,
  sweep?: SweepAggregateReport
): string {
  const lines: string[] = [];
  const useQueryTypes = summary.searchConfig.useQueryTypes ?? false;
  const effectiveTaskType = summary.searchConfig.effectiveTaskType ?? "general";
  const effectiveFinalRerankTopN = summary.searchConfig.effectiveFinalRerankTopN ?? 0;
  const effectiveGraphDepth = summary.searchConfig.effectiveGraphDepth ?? 0;

  lines.push("# Evaluation Summary");
  lines.push("");
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Dataset: ${summary.datasetName} (v${summary.datasetVersion})`);
  lines.push(`- Query count: ${summary.queryCount}`);
  lines.push("");

  lines.push("## Search Config");
  lines.push("");
  lines.push(`- Raw config: ${formatRawSearchConfig(summary.searchConfig)}`);
  lines.push(`- Query-type recipe mapping: ${useQueryTypes ? "enabled" : "disabled"}`);
  lines.push(`- Task recipe: ${effectiveTaskType}`);
  lines.push(
    `- Final rerank top-N: ${formatEffectiveFinalRerankTopN(effectiveFinalRerankTopN)}`
  );
  lines.push(`- Graph depth: ${formatEffectiveGraphDepth(effectiveGraphDepth)}`);
  lines.push("");

  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Hit@1 | ${formatPct(summary.metrics.hitAt1)} |`);
  lines.push(`| Hit@3 | ${formatPct(summary.metrics.hitAt3)} |`);
  lines.push(`| Hit@5 | ${formatPct(summary.metrics.hitAt5)} |`);
  lines.push(`| Hit@10 | ${formatPct(summary.metrics.hitAt10)} |`);
  lines.push(`| Combined Recall@10 | ${formatPct(summary.metrics.combinedRecallAt10)} |`);
  lines.push(`| Expansion Hit Rate | ${formatPct(summary.metrics.expansionHitRate)} |`);
  lines.push(`| MRR@10 | ${summary.metrics.mrrAt10.toFixed(4)} |`);
  lines.push(`| nDCG@10 | ${summary.metrics.ndcgAt10.toFixed(4)} |`);
  lines.push(`| Latency p50 | ${formatMs(summary.metrics.latencyMs.p50)} |`);
  lines.push(`| Latency p95 | ${formatMs(summary.metrics.latencyMs.p95)} |`);
  lines.push(`| Latency p99 | ${formatMs(summary.metrics.latencyMs.p99)} |`);
  lines.push(`| Embedding calls | ${summary.metrics.embedding.callCount} |`);
  lines.push(`| Embedding tokens | ${summary.metrics.tokenEstimate.embeddingTokensUsed} |`);
  lines.push(`| Estimated embedding cost | ${formatUsd(summary.metrics.embedding.estimatedCostUsd)} |`);
  if (summary.metrics.reranker) {
    const rerankerAppliedLabel =
      summary.metrics.reranker.appliedCount === 0 &&
      effectiveFinalRerankTopN === 0
        ? `${summary.metrics.reranker.appliedCount} (disabled in selected recipe)`
        : summary.metrics.reranker.appliedCount === 0 &&
            effectiveFinalRerankTopN < 0
          ? `${summary.metrics.reranker.appliedCount} (varies by query recipe)`
          : String(summary.metrics.reranker.appliedCount);
    lines.push(`| Reranker applied queries | ${rerankerAppliedLabel} |`);
    lines.push(`| Reranker failures | ${summary.metrics.reranker.failureCount} |`);
    lines.push(`| Reranker last ms | ${formatMs(summary.metrics.reranker.lastMs)} |`);
    lines.push(`| Reranker backends | ${JSON.stringify(summary.metrics.reranker.backendUsage)} |`);
  }
  lines.push("");

  lines.push("## Failure Buckets");
  lines.push("");
  lines.push("| Bucket | Count |");
  lines.push("|---|---:|");
  lines.push(
    `| wrong-file | ${summary.metrics.failureBuckets["wrong-file"]} |`
  );
  lines.push(
    `| wrong-symbol | ${summary.metrics.failureBuckets["wrong-symbol"]} |`
  );
  lines.push(
    `| docs/tests outranking source | ${summary.metrics.failureBuckets["docs-tests-outranking-source"]} |`
  );
  lines.push(
    `| no relevant hit in top-k | ${summary.metrics.failureBuckets["no-relevant-hit-top-k"]} |`
  );
  lines.push("");

  if (comparison) {
    lines.push("## Comparison vs Baseline");
    lines.push("");
    lines.push(`- Against: ${comparison.againstPath}`);
    lines.push("");
    lines.push("| Metric | Baseline | Current | Delta |");
    lines.push("|---|---:|---:|---:|");
    lines.push(
      `| Hit@1 | ${formatPct(comparison.deltas.hitAt1.baseline)} | ${formatPct(comparison.deltas.hitAt1.current)} | ${signed(comparison.deltas.hitAt1.absolute)} |`
    );
    lines.push(
      `| Hit@5 | ${formatPct(comparison.deltas.hitAt5.baseline)} | ${formatPct(comparison.deltas.hitAt5.current)} | ${signed(comparison.deltas.hitAt5.absolute)} |`
    );
    lines.push(
      `| Combined Recall@10 | ${formatPct(comparison.deltas.combinedRecallAt10.baseline)} | ${formatPct(comparison.deltas.combinedRecallAt10.current)} | ${signed(comparison.deltas.combinedRecallAt10.absolute)} |`
    );
    lines.push(
      `| Expansion Hit Rate | ${formatPct(comparison.deltas.expansionHitRate.baseline)} | ${formatPct(comparison.deltas.expansionHitRate.current)} | ${signed(comparison.deltas.expansionHitRate.absolute)} |`
    );
    lines.push(
      `| MRR@10 | ${comparison.deltas.mrrAt10.baseline.toFixed(4)} | ${comparison.deltas.mrrAt10.current.toFixed(4)} | ${signed(comparison.deltas.mrrAt10.absolute)} |`
    );
    lines.push(
      `| nDCG@10 | ${comparison.deltas.ndcgAt10.baseline.toFixed(4)} | ${comparison.deltas.ndcgAt10.current.toFixed(4)} | ${signed(comparison.deltas.ndcgAt10.absolute)} |`
    );
    lines.push(
      `| p95 latency (ms) | ${comparison.deltas.latencyP95Ms.baseline.toFixed(3)} | ${comparison.deltas.latencyP95Ms.current.toFixed(3)} | ${signed(comparison.deltas.latencyP95Ms.absolute, 3)} |`
    );
    lines.push("");
  }

  if (gate) {
    lines.push("## CI Gate");
    lines.push("");
    lines.push(`- Result: ${gate.passed ? "PASS ✅" : "FAIL ❌"}`);
    if (gate.regressions.length > 0) {
      lines.push("- Regressions:");
      for (const regression of gate.regressions) {
        lines.push(
          `  - ${regression.metric}: baseline=${regression.baseline.toFixed(4)} current=${regression.current.toFixed(4)} delta=${regression.delta.toFixed(4)} threshold=${regression.threshold.toFixed(4)}`
        );
      }
    }
    if (gate.violations.length > 0) {
      lines.push("- Violations:");
      for (const violation of gate.violations) {
        lines.push(`  - ${violation.metric}: ${violation.message}`);
      }
    }
    lines.push("");
  }

  if (sweep) {
    lines.push("## Parameter Sweep");
    lines.push("");
    lines.push(`- Run count: ${sweep.runCount}`);
    if (sweep.bestByHitAt5) {
      lines.push(
        `- Best Hit@5: ${formatPct(sweep.bestByHitAt5.summary.metrics.hitAt5)} with ${formatRawSearchConfig(sweep.bestByHitAt5.searchConfig)}`
      );
    }
    if (sweep.bestByMrrAt10) {
      lines.push(
        `- Best MRR@10: ${sweep.bestByMrrAt10.summary.metrics.mrrAt10.toFixed(4)} with ${formatRawSearchConfig(sweep.bestByMrrAt10.searchConfig)}`
      );
    }
    if (sweep.bestByP95Latency) {
      lines.push(
        `- Best p95 latency: ${formatMs(sweep.bestByP95Latency.summary.metrics.latencyMs.p95)} with ${formatRawSearchConfig(sweep.bestByP95Latency.searchConfig)}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function buildPerQueryArtifact(perQuery: PerQueryEvalResult[]): {
  queryCount: number;
  queries: PerQueryEvalResult[];
} {
  return {
    queryCount: perQuery.length,
    queries: [...perQuery].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
