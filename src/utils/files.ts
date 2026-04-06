import ignore from "ignore";
import { existsSync, readFileSync, promises as fsPromises } from "fs";
import * as path from "path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "CMakeLists.txt",
  "Makefile",
  ".opencode",
];

export function hasProjectMarker(projectRoot: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(path.join(projectRoot, marker))) {
      return true;
    }
  }
  return false;
}

export interface SkippedFile {
  path: string;
  reason: "too_large" | "excluded" | "gitignore" | "no_match";
}

export interface CollectFilesResult {
  files: Array<{ path: string; size: number }>;
  skipped: SkippedFile[];
}

export interface IgnoreFilter {
  ignores(filePath: string, isDirectory?: boolean): boolean;
}

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "coverage/",
  "__pycache__/",
  "target/",
  "vendor/",
  ".opencode/",
];

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

class HierarchicalIgnoreFilter implements IgnoreFilter {
  private matcherCache = new Map<string, ReturnType<typeof ignore>>();

  constructor(private readonly projectRoot: string) {}

  ignores(filePath: string, isDirectory: boolean = false): boolean {
    const relativePath = normalizeRelativePath(filePath);
    if (!relativePath) {
      return false;
    }

    const segments = relativePath.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestorPath = segments.slice(0, depth).join("/");
      if (this.evaluatePath(ancestorPath, true)) {
        return true;
      }
    }

    return this.evaluatePath(relativePath, isDirectory);
  }

  private evaluatePath(relativePath: string, isDirectory: boolean): boolean {
    const normalizedPath = normalizeRelativePath(relativePath);
    if (!normalizedPath) {
      return false;
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    let ignored = false;

    for (let depth = 0; depth < segments.length; depth++) {
      const baseRelativePath = depth === 0 ? "" : segments.slice(0, depth).join("/");
      let candidatePath = segments.slice(depth).join("/");
      if (isDirectory && !candidatePath.endsWith("/")) {
        candidatePath = `${candidatePath}/`;
      }

      const result = this.getMatcher(baseRelativePath).test(candidatePath);
      if (result.unignored) {
        ignored = false;
      } else if (result.ignored) {
        ignored = true;
      }
    }

    return ignored;
  }

  private getMatcher(baseRelativePath: string): ReturnType<typeof ignore> {
    const cached = this.matcherCache.get(baseRelativePath);
    if (cached) {
      return cached;
    }

    const matcher = ignore();
    if (baseRelativePath.length === 0) {
      matcher.add(DEFAULT_IGNORE_PATTERNS);
      this.addIgnoreFileIfPresent(matcher, path.join(this.projectRoot, ".git", "info", "exclude"));
    }

    const baseAbsolutePath =
      baseRelativePath.length === 0
        ? this.projectRoot
        : path.join(this.projectRoot, ...baseRelativePath.split("/"));
    this.addIgnoreFileIfPresent(matcher, path.join(baseAbsolutePath, ".gitignore"));

    this.matcherCache.set(baseRelativePath, matcher);
    return matcher;
  }

  private addIgnoreFileIfPresent(matcher: ReturnType<typeof ignore>, filePath: string): void {
    if (!existsSync(filePath)) {
      return;
    }

    matcher.add(readFileSync(filePath, "utf-8"));
  }
}

export function createIgnoreFilter(projectRoot: string): IgnoreFilter {
  return new HierarchicalIgnoreFilter(projectRoot);
}

export function shouldIncludeFile(
  filePath: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: IgnoreFilter
): boolean {
  const relativePath = normalizeRelativePath(path.relative(projectRoot, filePath));

  if (ignoreFilter.ignores(relativePath, false)) {
    return false;
  }

  for (const pattern of excludePatterns) {
    if (matchesExcludePattern(relativePath, pattern)) {
      return false;
    }
  }

  for (const pattern of includePatterns) {
    if (matchGlob(relativePath, pattern)) {
      return true;
    }
  }

  return false;
}

export function matchesExcludePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);

  if (normalizedPattern.endsWith("/")) {
    const directoryPrefix = normalizedPattern.slice(0, -1);
    return normalizedPath === directoryPrefix || normalizedPath.startsWith(`${directoryPrefix}/`);
  }

  return matchGlob(normalizedPath, normalizedPattern);
}

function matchGlob(filePath: string, pattern: string): boolean {
  let regexPattern = pattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`);

  // **/*.js → matches both root "file.js" and nested "dir/file.js"
  if (regexPattern.startsWith(".*/")) {
    regexPattern = `(.*\\/)?${regexPattern.slice(3)}`;
  }

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

export async function* walkDirectory(
  dir: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: IgnoreFilter,
  maxFileSize: number,
  skipped: SkippedFile[]
): AsyncGenerator<{ path: string; size: number }> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, fullPath));

    if (ignoreFilter.ignores(relativePath, entry.isDirectory())) {
      if (entry.isFile()) {
        skipped.push({ path: relativePath, reason: "gitignore" });
      }
      continue;
    }

    let excluded = false;
    for (const pattern of excludePatterns) {
      if (matchesExcludePattern(relativePath, pattern)) {
        if (entry.isFile()) {
          skipped.push({ path: relativePath, reason: "excluded" });
        }
        excluded = true;
        break;
      }
    }
    if (excluded) {
      continue;
    }

    if (entry.isDirectory()) {
      yield* walkDirectory(
        fullPath,
        projectRoot,
        includePatterns,
        excludePatterns,
        ignoreFilter,
        maxFileSize,
        skipped
      );
    } else if (entry.isFile()) {
      const stat = await fsPromises.stat(fullPath);

      if (stat.size > maxFileSize) {
        skipped.push({ path: relativePath, reason: "too_large" });
        continue;
      }

      let matched = false;
      for (const pattern of includePatterns) {
        if (matchGlob(relativePath, pattern)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        yield { path: fullPath, size: stat.size };
      } else {
        skipped.push({ path: relativePath, reason: "no_match" });
      }
    }
  }
}

export async function collectFiles(
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  maxFileSize: number
): Promise<CollectFilesResult> {
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const files: Array<{ path: string; size: number }> = [];
  const skipped: SkippedFile[] = [];

  for await (const file of walkDirectory(
    projectRoot,
    projectRoot,
    includePatterns,
    excludePatterns,
    ignoreFilter,
    maxFileSize,
    skipped
  )) {
    files.push(file);
  }

  return { files, skipped };
}
