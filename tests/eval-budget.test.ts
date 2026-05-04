import { describe, expect, it } from "vitest";

import { checkGate, evaluateBudgetGate } from "../src/eval/budget.js";
import type { EvalBudget, EvalComparison, EvalSummary } from "../src/eval/types.js";

function summary(p95: number): EvalSummary {
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: "/tmp/project",
    datasetPath: "benchmarks/golden/small.json",
    datasetName: "small",
    datasetVersion: "1.0.0",
    queryCount: 1,
    topK: 10,
    searchConfig: {
      fusionStrategy: "rrf",
      hybridWeight: 0.4,
      rrfK: 60,
      rerankTopN: 20,
      useQueryTypes: false,
      effectiveTaskType: "general",
      effectiveFinalRerankTopN: 0,
      effectiveGraphDepth: 0,
    },
    metrics: {
      hitAt1: 1,
      hitAt3: 1,
      hitAt5: 1,
      hitAt10: 1,
      combinedRecallAt10: 1,
      expansionHitRate: 1,
      mrrAt10: 1,
      ndcgAt10: 1,
      latencyMs: {
        p50: p95,
        p95,
        p99: p95,
      },
      tokenEstimate: {
        queryTokens: 10,
        embeddingTokensUsed: 10,
      },
      embedding: {
        callCount: 1,
        estimatedCostUsd: 0,
        costPer1MTokensUsd: 0,
      },
      failureBuckets: {
        "wrong-file": 0,
        "wrong-symbol": 0,
        "docs-tests-outranking-source": 0,
        "no-relevant-hit-top-k": 0,
      },
    },
  };
}

function comparisonWithBaselineP95(baselineP95: number): EvalComparison {
  return {
    againstPath: "benchmarks/baselines/eval-baseline-summary.json",
    deltas: {
      hitAt1: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt3: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt5: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      mrrAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      ndcgAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      combinedRecallAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      expansionHitRate: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      latencyP50Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      latencyP95Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      latencyP99Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      embeddingCallCount: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      estimatedCostUsd: { current: 0, baseline: 0, absolute: 0, relativePct: 0 },
    },
  };
}

describe("eval budget gate", () => {
  it("skips p95 multiplier violation when baseline p95 is near zero", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        p95LatencyMaxMultiplier: 1.1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5), comparisonWithBaselineP95(0));
    expect(gate.passed).toBe(true);
    expect(gate.violations).toHaveLength(0);
    expect(gate.regressions).toHaveLength(0);
  });

  it("still applies absolute p95 cap with near-zero baseline", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        p95LatencyMaxMultiplier: 1.1,
        p95LatencyMaxAbsoluteMs: 1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5), comparisonWithBaselineP95(0));
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "p95LatencyMaxAbsoluteMs")).toBe(true);
  });

  it("passes when baseline-sensitive metrics stay within threshold", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        hitAt1MaxDrop: 0.03,
        hitAt5MaxDrop: 0.03,
        mrrAt10MaxDrop: 0.03,
        combinedRecallAt10MaxDrop: 0.05,
        expansionHitRateMaxDrop: 0.1,
      },
    };

    const baseline = summary(5);
    const current = {
      ...summary(5),
      metrics: {
        ...summary(5).metrics,
        hitAt1: 0.98,
        hitAt5: 0.98,
        mrrAt10: 0.98,
        combinedRecallAt10: 0.96,
        expansionHitRate: 0.92,
      },
    };

    const gate = checkGate(current, baseline, budget);
    expect(gate.passed).toBe(true);
    expect(gate.regressions).toEqual([]);
  });

  it("fails and reports regression details when baseline-sensitive metrics drop too far", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        hitAt1MaxDrop: 0.03,
        hitAt5MaxDrop: 0.03,
        combinedRecallAt10MaxDrop: 0.05,
        expansionHitRateMaxDrop: 0.1,
      },
    };

    const baseline = summary(5);
    const current = {
      ...summary(5),
      metrics: {
        ...summary(5).metrics,
        hitAt1: 0.9,
        hitAt5: 0.9,
        combinedRecallAt10: 0.8,
        expansionHitRate: 0.85,
      },
    };

    const gate = checkGate(current, baseline, budget);
    expect(gate.passed).toBe(false);
    expect(gate.regressions.map((item) => item.metric).sort()).toEqual([
      "combinedRecallAt10",
      "hitAt1",
      "hitAt5",
      "expansionHitRate",
    ].sort());
    expect(gate.violations).toHaveLength(4);
  });

  it("enforces absolute minimum Hit@1 when configured", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        minHitAt1: 0.9,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          hitAt1: 0.8,
        },
      },
      comparisonWithBaselineP95(5)
    );
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((violation) => violation.metric === "minHitAt1")).toBe(true);
  });
});
