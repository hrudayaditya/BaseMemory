import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_MEMORY_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(BASE_MEMORY_ROOT, ".opencode", "codebase-index.json");
const RESULT_LIMIT = 5;
const SNIPPET_LENGTH = 240;

interface SearchScriptArgs {
  repoPath: string;
  query: string;
}

function usage(): string {
  return 'Usage: npx tsx scripts/search-repo.ts <repo-path> "<search query>"';
}

function parseArgs(argv: string[]): SearchScriptArgs {
  if (argv.length < 2) {
    throw new Error(usage());
  }

  const [repoPath, ...queryParts] = argv;
  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error(usage());
  }

  return {
    repoPath: path.resolve(process.cwd(), repoPath),
    query,
  };
}

function loadConfig(configPath: string) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  return parseConfig(JSON.parse(readFileSync(configPath, "utf-8")));
}

function formatSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= SNIPPET_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SNIPPET_LENGTH - 3)}...`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.repoPath)) {
    throw new Error(`Repo path not found: ${args.repoPath}`);
  }

  const config = loadConfig(CONFIG_PATH);
  const indexer = new Indexer(args.repoPath, config);

  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Target repo: ${args.repoPath}`);
  console.log(`Query: ${args.query}`);
  console.log("Initializing indexer...");

  await indexer.initialize();

  console.log("Searching...");
  const response = await indexer.searchDetailed(args.query, RESULT_LIMIT);

  console.log("");
  console.log(`Task type: ${response.taskType}`);
  console.log(
    `Voyage lane: configured=${response.retrieval.voyageLaneConfigured} used=${response.retrieval.voyageLaneUsed}`
  );
  console.log(`Final reranker applied: ${response.reranker.applied}`);
  console.log(`Final reranker backend: ${response.reranker.backend ?? "none"}`);
  console.log("");

  if (response.primaryResults.length === 0) {
    console.log("No results.");
    return;
  }

  for (const [index, result] of response.primaryResults.entries()) {
    console.log(`${index + 1}. ${result.filePath}`);
    console.log(`   Symbol: ${result.name ?? "<anonymous>"}`);
    console.log(`   Lines: ${result.startLine}-${result.endLine}`);
    console.log(`   Score: ${result.score.toFixed(4)}`);
    console.log(`   Snippet: ${formatSnippet(result.content)}`);
    console.log("");
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
