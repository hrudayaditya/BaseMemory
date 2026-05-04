import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { spawn } from "child_process";
import { createRequire } from "module";

function loadJson(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveDbPath(projectRoot: string): string {
  const configPath = join(projectRoot, ".opencode", "codebase-index.json");
  const rawConfig = loadJson(configPath);
  if (rawConfig && typeof rawConfig === "object") {
    const record = rawConfig as Record<string, unknown>;
    const explicitPath =
      (typeof record.dbPath === "string" && record.dbPath) ||
      (typeof record.databasePath === "string" && record.databasePath) ||
      (typeof record.indexPath === "string" && join(record.indexPath, "codebase.db")) ||
      null;
    if (explicitPath) {
      return resolve(projectRoot, explicitPath);
    }
  }

  return join(projectRoot, ".opencode", "index", "codebase.db");
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const extraArgs = process.argv.slice(2);
  const hasDbArg = extraArgs.includes("--db");
  const dbPath = hasDbArg ? null : resolveDbPath(projectRoot);

  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const graphServerPath = join(projectRoot, "src", "graph-server.ts");
  const args = [tsxCli, graphServerPath];
  if (dbPath) {
    args.push("--db", dbPath);
  }
  args.push(...extraArgs);

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    cwd: projectRoot,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
