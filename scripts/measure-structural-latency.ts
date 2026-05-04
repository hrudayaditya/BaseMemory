import * as fs from "fs";
import * as path from "path";

import { performance } from "perf_hooks";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

type ToolName = "symbol_info" | "callers" | "callees" | "call_chain" | "tests_for";

interface Measurement {
  tool: ToolName;
  label: string;
  durationMs: number;
}

interface SummaryRow {
  tool: ToolName;
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index] ?? 0;
}

function summarize(tool: ToolName, values: number[]): SummaryRow {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    tool,
    samples: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = path.join(projectRoot, ".opencode", "codebase-index.json");
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const config = parseConfig(rawConfig);
  const indexer = new Indexer(projectRoot, config);

  await indexer.initialize();
  const status = await indexer.getStatus();
  console.log(`Project: ${projectRoot}`);
  console.log(`Index path: ${status.indexPath}`);
  console.log(`Branch: ${status.currentBranch}`);
  console.log("");

  const measurements: Measurement[] = [];

  const record = async (
    tool: ToolName,
    label: string,
    operation: () => Promise<unknown>
  ): Promise<void> => {
    const startedAt = performance.now();
    await operation();
    measurements.push({
      tool,
      label,
      durationMs: performance.now() - startedAt,
    });
  };

  const symbolInfoSymbols = [
    "searchDetailed",
    "index",
    "processEmbedStage",
    "searchDetailed",
    "index",
    "processEmbedStage",
    "searchDetailed",
    "index",
    "processEmbedStage",
    "searchDetailed",
  ];
  for (const symbol of symbolInfoSymbols) {
    await record("symbol_info", symbol, () => indexer.getSymbolInfo(symbol));
  }

  const callerSymbols = [
    "searchDetailed",
    "processEmbedStage",
    "searchDetailed",
    "processEmbedStage",
    "searchDetailed",
    "processEmbedStage",
    "searchDetailed",
    "processEmbedStage",
    "searchDetailed",
    "processEmbedStage",
  ];
  for (const symbol of callerSymbols) {
    await record("callers", symbol, () => indexer.getStructuralCallers({ symbol }));
  }

  const calleeSymbols = [
    "searchDetailed",
    "index",
    "searchDetailed",
    "index",
    "searchDetailed",
    "index",
    "searchDetailed",
    "index",
    "searchDetailed",
    "index",
  ];
  for (const symbol of calleeSymbols) {
    await record("callees", symbol, () => indexer.getStructuralCallees({ symbol }));
  }

  for (let iteration = 0; iteration < 10; iteration += 1) {
    await record(
      "call_chain",
      `index_codebase -> processEmbedStage (${iteration + 1})`,
      () =>
        indexer.getStructuralCallChain({
          fromSymbol: "index_codebase",
          toSymbol: "processEmbedStage",
          maxDepth: 3,
        })
    );
  }

  const testSymbols = [
    "processEmbedStage",
    "index",
    "processEmbedStage",
    "index",
    "processEmbedStage",
    "index",
    "processEmbedStage",
    "index",
    "processEmbedStage",
    "index",
  ];
  for (const symbol of testSymbols) {
    await record("tests_for", symbol, () => indexer.getStructuralTests({ symbol }));
  }

  const summaryRows = (["symbol_info", "callers", "callees", "call_chain", "tests_for"] as ToolName[])
    .map((tool) =>
      summarize(
        tool,
        measurements.filter((measurement) => measurement.tool === tool).map((measurement) => measurement.durationMs)
      )
    );

  const tableRows = [
    "| Tool | Samples | Min | p50 | p95 | Max |",
    "|---|---:|---:|---:|---:|---:|",
    ...summaryRows.map(
      (row) =>
        `| ${row.tool} | ${row.samples} | ${formatMs(row.minMs)} | ${formatMs(row.p50Ms)} | ${formatMs(row.p95Ms)} | ${formatMs(row.maxMs)} |`
    ),
  ];

  console.log("Structural latency summary");
  console.log(tableRows.join("\n"));
  console.log("");
  console.log("Per-call measurements");
  for (const measurement of measurements) {
    console.log(
      `${measurement.tool}\t${measurement.label}\t${formatMs(measurement.durationMs)}`
    );
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
