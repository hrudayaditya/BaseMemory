import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildMerkleSnapshot,
  Database,
  diffMerkleFromEvents,
  diffMerkleSnapshots,
  type MerkleIgnoreRules,
} from "../src/native/index.js";

describe("merkle tree change detector", () => {
  let tempDir: string;
  let rules: MerkleIgnoreRules;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "merkle-test-"));
    rules = {
      include: ["**/*.ts", "**/*.js"],
      exclude: [],
      maxFileSize: 1024 * 1024,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds deterministic snapshots for identical trees", async () => {
    const firstRepo = path.join(tempDir, "repo-a");
    const secondRepo = path.join(tempDir, "repo-b");

    fs.mkdirSync(path.join(firstRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(firstRepo, "src", "b.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(firstRepo, "src", "a.ts"), "export const a = 1;\n");

    fs.mkdirSync(path.join(secondRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(secondRepo, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(secondRepo, "src", "b.ts"), "export const b = 2;\n");

    const first = await buildMerkleSnapshot(firstRepo, "main", rules);
    const second = await buildMerkleSnapshot(secondRepo, "main", rules);

    expect(first.rootHash).toBe(second.rootHash);
    expect(first.totalFiles).toBe(2);
  });

  it("diffs snapshots into changed, added, and removed files", async () => {
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repoRoot, "src", "b.ts"), "export const b = 2;\n");

    const before = await buildMerkleSnapshot(repoRoot, "main", rules);

    fs.writeFileSync(path.join(repoRoot, "src", "a.ts"), "export const a = 3;\n");
    fs.rmSync(path.join(repoRoot, "src", "b.ts"));
    fs.writeFileSync(path.join(repoRoot, "src", "c.ts"), "export const c = 4;\n");

    const after = await buildMerkleSnapshot(repoRoot, "main", rules);
    const diff = await diffMerkleSnapshots(before.snapshot, after.snapshot);

    expect(diff.changedFiles).toEqual(["src/a.ts"]);
    expect(diff.addedFiles).toEqual(["src/c.ts"]);
    expect(diff.removedFiles).toEqual(["src/b.ts"]);
  });

  it("recomputes only event-driven paths and returns the next snapshot", async () => {
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repoRoot, "src", "b.ts"), "export const b = 2;\n");

    const before = await buildMerkleSnapshot(repoRoot, "main", rules);

    const changedPath = path.join(repoRoot, "src", "a.ts");
    const removedPath = path.join(repoRoot, "src", "b.ts");
    const addedPath = path.join(repoRoot, "src", "c.ts");

    fs.writeFileSync(changedPath, "export const a = 10;\n");
    fs.rmSync(removedPath);
    fs.writeFileSync(addedPath, "export const c = 30;\n");

    const prepared = await diffMerkleFromEvents(
      before.snapshot,
      [changedPath, removedPath, addedPath],
      repoRoot,
      rules
    );

    expect(prepared.changedFiles).toEqual(["src/a.ts"]);
    expect(prepared.addedFiles).toEqual(["src/c.ts"]);
    expect(prepared.removedFiles).toEqual(["src/b.ts"]);

    const after = await buildMerkleSnapshot(repoRoot, "main", rules);
    const committed = await diffMerkleSnapshots(prepared.nextSnapshot, after.snapshot);
    expect(committed.changedFiles).toEqual([]);
    expect(committed.addedFiles).toEqual([]);
    expect(committed.removedFiles).toEqual([]);
  });

  it("persists snapshots per branch in the database", async () => {
    const repoRoot = path.join(tempDir, "repo");
    const dbPath = path.join(tempDir, "codebase.db");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export const value = 1;\n");

    const database = new Database(dbPath);
    const snapshot = await buildMerkleSnapshot(repoRoot, "feature/test", rules);

    database.saveMerkleSnapshot(snapshot.snapshot);
    expect(database.getMerkleSnapshot("feature/test")).toBe(snapshot.snapshot);
    expect(database.deleteMerkleSnapshot("feature/test")).toBe(true);
    expect(database.getMerkleSnapshot("feature/test")).toBeNull();
  });
});
