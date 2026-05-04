import type { EvalBudget, EvalComparison, EvalGateResult, EvalSummary } from "./types.js";

function buildMaxDropRegression(
  metric: string,
  baseline: number,
  current: number,
  threshold: number
) {
  return {
    metric,
    baseline,
    current,
    delta: current - baseline,
    threshold,
  };
}

export function checkGate(
  current: EvalSummary,
  baseline: EvalSummary,
  budget: EvalBudget
): EvalGateResult {
  const comparisonLike = {
    hitAt1: current.metrics.hitAt1 - baseline.metrics.hitAt1,
    hitAt5: current.metrics.hitAt5 - baseline.metrics.hitAt5,
    mrrAt10: current.metrics.mrrAt10 - baseline.metrics.mrrAt10,
    combinedRecallAt10: current.metrics.combinedRecallAt10 - baseline.metrics.combinedRecallAt10,
    expansionHitRate: current.metrics.expansionHitRate - baseline.metrics.expansionHitRate,
  };
  const violations: EvalGateResult["violations"] = [];
  const regressions: EvalGateResult["regressions"] = [];

  if (
    budget.thresholds.hitAt1MaxDrop !== undefined &&
    comparisonLike.hitAt1 < -budget.thresholds.hitAt1MaxDrop
  ) {
    regressions.push(
      buildMaxDropRegression(
        "hitAt1",
        baseline.metrics.hitAt1,
        current.metrics.hitAt1,
        budget.thresholds.hitAt1MaxDrop
      )
    );
  }

  if (
    budget.thresholds.hitAt5MaxDrop !== undefined &&
    comparisonLike.hitAt5 < -budget.thresholds.hitAt5MaxDrop
  ) {
    regressions.push(
      buildMaxDropRegression(
        "hitAt5",
        baseline.metrics.hitAt5,
        current.metrics.hitAt5,
        budget.thresholds.hitAt5MaxDrop
      )
    );
  }

  if (
    budget.thresholds.mrrAt10MaxDrop !== undefined &&
    comparisonLike.mrrAt10 < -budget.thresholds.mrrAt10MaxDrop
  ) {
    regressions.push(
      buildMaxDropRegression(
        "mrrAt10",
        baseline.metrics.mrrAt10,
        current.metrics.mrrAt10,
        budget.thresholds.mrrAt10MaxDrop
      )
    );
  }

  if (
    budget.thresholds.combinedRecallAt10MaxDrop !== undefined &&
    comparisonLike.combinedRecallAt10 < -budget.thresholds.combinedRecallAt10MaxDrop
  ) {
    regressions.push(
      buildMaxDropRegression(
        "combinedRecallAt10",
        baseline.metrics.combinedRecallAt10,
        current.metrics.combinedRecallAt10,
        budget.thresholds.combinedRecallAt10MaxDrop
      )
    );
  }

  if (
    budget.thresholds.expansionHitRateMaxDrop !== undefined &&
    comparisonLike.expansionHitRate < -budget.thresholds.expansionHitRateMaxDrop
  ) {
    regressions.push(
      buildMaxDropRegression(
        "expansionHitRate",
        baseline.metrics.expansionHitRate,
        current.metrics.expansionHitRate,
        budget.thresholds.expansionHitRateMaxDrop
      )
    );
  }

  for (const regression of regressions) {
    violations.push({
      metric: regression.metric,
      message: `${regression.metric} regressed by ${regression.delta.toFixed(4)} against baseline ${regression.baseline.toFixed(4)} (threshold -${regression.threshold.toFixed(4)})`,
    });
  }

  return {
    passed: regressions.length === 0,
    budgetName: budget.name,
    violations,
    regressions,
  };
}

export function evaluateBudgetGate(
  budget: EvalBudget,
  summary: EvalSummary,
  comparison?: EvalComparison
): EvalGateResult {
  const BASELINE_P95_EPSILON_MS = 0.001;
  const violations: EvalGateResult["violations"] = [];
  const regressions: EvalGateResult["regressions"] = [];

  const { thresholds } = budget;

  if (thresholds.minHitAt1 !== undefined && summary.metrics.hitAt1 < thresholds.minHitAt1) {
    violations.push({
      metric: "minHitAt1",
      message: `Hit@1 ${summary.metrics.hitAt1.toFixed(4)} is below minimum ${thresholds.minHitAt1.toFixed(4)}`,
    });
  }

  if (thresholds.minHitAt5 !== undefined && summary.metrics.hitAt5 < thresholds.minHitAt5) {
    violations.push({
      metric: "minHitAt5",
      message: `Hit@5 ${summary.metrics.hitAt5.toFixed(4)} is below minimum ${thresholds.minHitAt5.toFixed(4)}`,
    });
  }

  if (thresholds.minMrrAt10 !== undefined && summary.metrics.mrrAt10 < thresholds.minMrrAt10) {
    violations.push({
      metric: "minMrrAt10",
      message: `MRR@10 ${summary.metrics.mrrAt10.toFixed(4)} is below minimum ${thresholds.minMrrAt10.toFixed(4)}`,
    });
  }

  if (comparison) {
    if (
      thresholds.hitAt1MaxDrop !== undefined &&
      comparison.deltas.hitAt1.absolute < -thresholds.hitAt1MaxDrop
    ) {
      regressions.push(
        buildMaxDropRegression(
          "hitAt1",
          comparison.deltas.hitAt1.baseline,
          comparison.deltas.hitAt1.current,
          thresholds.hitAt1MaxDrop
        )
      );
    }

    if (
      thresholds.hitAt5MaxDrop !== undefined &&
      comparison.deltas.hitAt5.absolute < -thresholds.hitAt5MaxDrop
    ) {
      regressions.push(
        buildMaxDropRegression(
          "hitAt5",
          comparison.deltas.hitAt5.baseline,
          comparison.deltas.hitAt5.current,
          thresholds.hitAt5MaxDrop
        )
      );
    }

    if (
      thresholds.mrrAt10MaxDrop !== undefined &&
      comparison.deltas.mrrAt10.absolute < -thresholds.mrrAt10MaxDrop
    ) {
      regressions.push(
        buildMaxDropRegression(
          "mrrAt10",
          comparison.deltas.mrrAt10.baseline,
          comparison.deltas.mrrAt10.current,
          thresholds.mrrAt10MaxDrop
        )
      );
    }

    if (
      thresholds.combinedRecallAt10MaxDrop !== undefined &&
      comparison.deltas.combinedRecallAt10.absolute < -thresholds.combinedRecallAt10MaxDrop
    ) {
      regressions.push(
        buildMaxDropRegression(
          "combinedRecallAt10",
          comparison.deltas.combinedRecallAt10.baseline,
          comparison.deltas.combinedRecallAt10.current,
          thresholds.combinedRecallAt10MaxDrop
        )
      );
    }

    if (
      thresholds.expansionHitRateMaxDrop !== undefined &&
      comparison.deltas.expansionHitRate.absolute < -thresholds.expansionHitRateMaxDrop
    ) {
      regressions.push(
        buildMaxDropRegression(
          "expansionHitRate",
          comparison.deltas.expansionHitRate.baseline,
          comparison.deltas.expansionHitRate.current,
          thresholds.expansionHitRateMaxDrop
        )
      );
    }

    if (thresholds.p95LatencyMaxMultiplier !== undefined) {
      const baselineP95 = comparison.deltas.latencyP95Ms.baseline;
      if (baselineP95 > BASELINE_P95_EPSILON_MS) {
        const allowed = baselineP95 * thresholds.p95LatencyMaxMultiplier;
        if (summary.metrics.latencyMs.p95 > allowed) {
          violations.push({
            metric: "p95LatencyMaxMultiplier",
            message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds allowed ${allowed.toFixed(3)}ms (${thresholds.p95LatencyMaxMultiplier.toFixed(2)}x baseline)`,
          });
        }
      }
    }
  }

  for (const regression of regressions) {
    violations.push({
      metric: regression.metric,
      message: `${regression.metric} regressed by ${regression.delta.toFixed(4)} against baseline ${regression.baseline.toFixed(4)} (threshold -${regression.threshold.toFixed(4)})`,
    });
  }

  if (
    thresholds.p95LatencyMaxAbsoluteMs !== undefined &&
    summary.metrics.latencyMs.p95 > thresholds.p95LatencyMaxAbsoluteMs
  ) {
    violations.push({
      metric: "p95LatencyMaxAbsoluteMs",
      message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds absolute maximum ${thresholds.p95LatencyMaxAbsoluteMs.toFixed(3)}ms`,
    });
  }

  return {
    passed: violations.length === 0,
    budgetName: budget.name,
    violations,
    regressions,
  };
}
