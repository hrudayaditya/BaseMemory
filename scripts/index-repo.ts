import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "../src/config/schema.js";
import { Indexer, type IndexProgress } from "../src/indexer/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_MEMORY_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(BASE_MEMORY_ROOT, ".opencode", "codebase-index.json");

interface ScriptArgs {
  repoPath: string;
  verbose: boolean;
  reindex: boolean;
}

interface TimingBreakdown {
  chunkingMs: number;
  embeddingMs: number;
  dbWriteMs: number;
}

interface InstrumentedIndexerInternals {
  provider?: { embedBatch: (texts: string[]) => Promise<unknown> } | null;
  voyageProvider?: { embedBatch: (texts: string[]) => Promise<unknown> } | null;
  database?: Record<string, unknown> | null;
  store?: { save: () => void } | null;
  voyageStore?: { save: () => void } | null;
  invertedIndex?: { save: () => void } | null;
}

function usage(): string {
  return "Usage: npx tsx scripts/index-repo.ts <repo-path> [--verbose] [--reindex]";
}

function parseArgs(argv: string[]): ScriptArgs {
  let repoPath: string | null = null;
  let verbose = false;
  let reindex = false;

  for (const arg of argv) {
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--reindex") {
      reindex = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}\n${usage()}`);
    }

    if (repoPath !== null) {
      throw new Error(`Unexpected extra argument: ${arg}\n${usage()}`);
    }

    repoPath = arg;
  }

  if (!repoPath) {
    throw new Error(usage());
  }

  return {
    repoPath: path.resolve(process.cwd(), repoPath),
    verbose,
    reindex,
  };
}

function loadConfig(configPath: string) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  return parseConfig(JSON.parse(readFileSync(configPath, "utf-8")));
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatMilliseconds(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function logProgress(progress: IndexProgress): void {
  const parts = [
    `phase=${progress.phase}`,
    `files=${progress.filesProcessed}/${progress.totalFiles}`,
    `chunks=${progress.chunksProcessed}/${progress.totalChunks}`,
  ];

  if (progress.currentFile) {
    parts.push(`current=${progress.currentFile}`);
  }

  console.log(`[progress] ${parts.join(" ")}`);
}

function enableVerboseMetrics(config: ReturnType<typeof loadConfig>): void {
  config.debug = {
    ...config.debug,
    enabled: true,
    metrics: true,
  };
}

function wrapAsyncDuration<TArgs extends unknown[], TResult>(
  target: Record<string, unknown>,
  methodName: string,
  accumulate: (durationMs: number) => void
): void {
  const original = target[methodName];
  if (typeof original !== "function") {
    return;
  }

  target[methodName] = (async (...args: TArgs): Promise<TResult> => {
    const startedAt = performance.now();
    try {
      return await Reflect.apply(original, target, args) as TResult;
    } finally {
      accumulate(performance.now() - startedAt);
    }
  }) as typeof original;
}

function wrapSyncDuration<TArgs extends unknown[], TResult>(
  target: Record<string, unknown>,
  methodName: string,
  accumulate: (durationMs: number) => void
): void {
  const original = target[methodName];
  if (typeof original !== "function") {
    return;
  }

  target[methodName] = ((...args: TArgs): TResult => {
    const startedAt = performance.now();
    try {
      return Reflect.apply(original, target, args) as TResult;
    } finally {
      accumulate(performance.now() - startedAt);
    }
  }) as typeof original;
}

function installTimingInstrumentation(indexer: Indexer): TimingBreakdown {
  const timings: TimingBreakdown = {
    chunkingMs: 0,
    embeddingMs: 0,
    dbWriteMs: 0,
  };

  const logger = indexer.getLogger() as Record<string, unknown>;
  wrapSyncDuration<[number], void>(logger, "recordParseDuration", (durationMs) => {
    timings.chunkingMs += durationMs;
  });

  const internals = indexer as unknown as InstrumentedIndexerInternals;

  if (internals.provider) {
    wrapAsyncDuration<[string[]], unknown>(
      internals.provider as Record<string, unknown>,
      "embedBatch",
      (durationMs) => {
        timings.embeddingMs += durationMs;
      }
    );
  }

  if (internals.voyageProvider) {
    wrapAsyncDuration<[string[]], unknown>(
      internals.voyageProvider as Record<string, unknown>,
      "embedBatch",
      (durationMs) => {
        timings.embeddingMs += durationMs;
      }
    );
  }

  if (internals.database) {
    for (const methodName of [
      "upsertChunksBatch",
      "upsertEmbeddingsBatch",
      "addChunksToBranchBatch",
      "upsertSymbolsBatch",
      "upsertCallEdgesBatch",
    ]) {
      wrapSyncDuration<Record<string, unknown>[], unknown>(
        internals.database as Record<string, unknown>,
        methodName,
        (durationMs) => {
          timings.dbWriteMs += durationMs;
        }
      );
    }
  }

  for (const persistTarget of [internals.store, internals.voyageStore, internals.invertedIndex]) {
    if (!persistTarget) {
      continue;
    }
    wrapSyncDuration<[], void>(
      persistTarget as Record<string, unknown>,
      "save",
      (durationMs) => {
        timings.dbWriteMs += durationMs;
      }
    );
  }

  return timings;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.repoPath)) {
    throw new Error(`Repo path not found: ${args.repoPath}`);
  }

  const config = loadConfig(CONFIG_PATH);
  if (args.verbose) {
    enableVerboseMetrics(config);
  }

  const startedAt = Date.now();

  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Target repo: ${args.repoPath}`);
  console.log(`Provider: ${config.embeddingProvider}`);
  if (config.customProvider) {
    console.log(`Model: ${config.customProvider.model} (${config.customProvider.dimensions} dims)`);
    console.log(`Base URL: ${config.customProvider.baseUrl}`);
  } else if (config.embeddingModel) {
    console.log(`Model: ${config.embeddingModel}`);
  }

  const indexer = new Indexer(args.repoPath, config);

  console.log("Initializing indexer...");
  await indexer.initialize();
  console.log("Initialization complete.");

  if (args.reindex) {
    console.log("Clearing existing index (--reindex)...");
    await indexer.clearIndex();
    console.log("Existing index cleared.");
  }

  const timings = args.verbose ? installTimingInstrumentation(indexer) : null;

  console.log("Starting cold start index...");
  const stats = await indexer.index(logProgress);
  const elapsedMs = Date.now() - startedAt;

  console.log("");
  console.log("Index complete.");
  console.log(`Files processed: ${stats.totalFiles}`);
  console.log(`Total chunks in run: ${stats.totalChunks}`);
  console.log(`New chunks embedded: ${stats.indexedChunks}`);
  console.log(`Existing chunks reused: ${stats.existingChunks}`);
  console.log(`Removed chunks: ${stats.removedChunks}`);
  console.log(`Failed chunks: ${stats.failedChunks}`);
  console.log(`Tokens used: ${stats.tokensUsed}`);
  console.log(`Indexer duration: ${formatDuration(stats.durationMs)}`);
  console.log(`Wall time: ${formatDuration(elapsedMs)}`);

  if (args.verbose && timings) {
    console.log("");
    console.log("Phase timing breakdown:");
    console.log(`Chunking ms: ${formatMilliseconds(timings.chunkingMs)}`);
    console.log(`Embedding ms: ${formatMilliseconds(timings.embeddingMs)}`);
    console.log(`DB write ms: ${formatMilliseconds(timings.dbWriteMs)}`);
    console.log(`Total ms: ${formatMilliseconds(elapsedMs)}`);
  }

  if (stats.parseFailures.length > 0) {
    console.log(`Parse failures: ${stats.parseFailures.length}`);
  }

  if (stats.skippedFiles.length > 0) {
    console.log(`Skipped files: ${stats.skippedFiles.length}`);
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
);
