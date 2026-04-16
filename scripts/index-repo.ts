import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "../src/config/schema.js";
import { Indexer, type IndexProgress } from "../src/indexer/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_MEMORY_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(BASE_MEMORY_ROOT, ".opencode", "codebase-index.json");
const TARGET_REPO = "/Users/aditya3/Desktop/zod";
function loadConfig(configPath: string) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  return parseConfig(JSON.parse(readFileSync(configPath, "utf-8")));
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  const startedAt = Date.now();

  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Target repo: ${TARGET_REPO}`);
  console.log(`Provider: ${config.embeddingProvider}`);
  if (config.customProvider) {
    console.log(`Model: ${config.customProvider.model} (${config.customProvider.dimensions} dims)`);
    console.log(`Base URL: ${config.customProvider.baseUrl}`);
  } else if (config.embeddingModel) {
    console.log(`Model: ${config.embeddingModel}`);
  }

  const indexer = new Indexer(TARGET_REPO, config);

  console.log("Initializing indexer...");
  await indexer.initialize();
  console.log("Initialization complete.");

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
