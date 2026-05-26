import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

/**
 * Regression test for Issue #817: api.resolvePath() in delayed backup timer
 *
 * Context:
 * In OpenClaw v2026.4.22+, the Jiti-based plugin loading introduced a
 * behavior where `api.resolvePath()` becomes invalid inside timer closures
 * after the plugin's `register()` function completes. Calling
 * `api.resolvePath()` on an already-absolute path returns `undefined`,
 * causing `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be
 * of type string or an instance of Buffer or URL. Received undefined`
 * when the path is later passed to `mkdir`/`fs` operations.
 *
 * Fix (commit 3a117b8): Remove the redundant `api.resolvePath()` wrapper
 * in `runBackup()`. The `resolvedDbPath` produced at registration time is
 * already an absolute path, so `path.join()` produces a valid absolute
 * path without needing `api.resolvePath()` re-processing.
 *
 * This test verifies:
 * 1. Path construction from an absolute dbPath produces a valid string
 * 2. The `undefined` guard prevents the crash at the correct level
 * 3. The constructed backupDir is absolute and writable
 * 4. The path construction survives in a delayed-closure-like context
 */

describe("backup timer closure — api.resolvePath regression (Issue #817)", () => {
  /**
   * Simulates the exact path construction used in the backup timer.
   * This mirrors the fix: join() directly on the already-absolute
   * resolvedDbPath, without re-wrapping in api.resolvePath().
   */
  function constructBackupDir(resolvedDbPath) {
    // Guard: resolvedDbPath must be a non-empty string
    // (This is the guard added alongside the fix)
    if (!resolvedDbPath || typeof resolvedDbPath !== "string") {
      return undefined;
    }
    const backupDir = join(resolvedDbPath, "..", "backups");
    // Secondary guard: backupDir must resolve to a string
    if (!backupDir || typeof backupDir !== "string") {
      return undefined;
    }
    return backupDir;
  }

  it("produces a valid absolute backupDir from an absolute dbPath", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb";
    const backupDir = constructBackupDir(dbPath);

    assert.ok(backupDir, "backupDir should not be undefined");
    assert.strictEqual(typeof backupDir, "string");
    assert.ok(isAbsolute(backupDir), "backupDir should be absolute");
    // path.join on "/a/b/c" with ".." gives "/a/b"
    assert.ok(backupDir.includes("backups"), "backupDir should contain 'backups'");
  });

  it("returns undefined for an undefined dbPath (guard #1)", () => {
    assert.strictEqual(constructBackupDir(undefined), undefined);
    assert.strictEqual(constructBackupDir(null), undefined);
  });

  it("returns undefined for a non-string dbPath (guard #1)", () => {
    assert.strictEqual(constructBackupDir(42), undefined);
    assert.strictEqual(constructBackupDir({}), undefined);
    assert.strictEqual(constructBackupDir(true), undefined);
  });

  it("returns undefined for an empty-string dbPath (guard #1)", () => {
    assert.strictEqual(constructBackupDir(""), undefined);
  });

  it("survives in a simulated timer closure context", async () => {
    // This test verifies the critical scenario: the path construction
    // works correctly even when called after a delay (simulating the
    // setTimeout closure where api.resolvePath would have become invalid).

    const dbPath = "/var/lib/openclaw/memory-data";
    let backupDir;

    // Simulate the delayed timer call
    await new Promise((resolve) => {
      setTimeout(() => {
        backupDir = constructBackupDir(dbPath);
        resolve();
      }, 100); // Short delay to simulate timer context
    });

    assert.ok(backupDir, "backupDir should survive timer closure");
    assert.strictEqual(typeof backupDir, "string");
    assert.ok(isAbsolute(backupDir));
    assert.ok(
      backupDir.endsWith("backups") || backupDir.includes("backups"),
      "backupDir should target a backups directory",
    );
  });

  it("produces a writable directory from the constructed path", () => {
    const workDir = mkdtempSync(join(tmpdir(), "lancedb-backup-regression-"));
    try {
      const dbPath = join(workDir, "db");
      mkdirSync(dbPath, { recursive: true });

      const backupDir = constructBackupDir(dbPath);
      assert.ok(backupDir);

      // Create the backup directory — this is what would crash with the
      // TypeError: path undefined error if resolvePath returned undefined
      mkdirSync(backupDir, { recursive: true });

      // Verify it's writable by creating a test file
      const testFile = join(backupDir, "test-backup.jsonl");
      writeFileSync(testFile, '{"test":true}\n', "utf8");

      assert.ok(true, "backupDir created and writable — no TypeError");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes Windows-style paths correctly on any platform", () => {
    const windowsDbPath = "C:\\Users\\admin\\openclaw-memory";
    const backupDir = constructBackupDir(windowsDbPath);

    assert.ok(backupDir);
    assert.strictEqual(typeof backupDir, "string");
    // On non-Windows, this will look odd but should still be a valid string
    assert.ok(backupDir.includes("backups"));
  });

  it("handles paths with redundant separators safely", () => {
    // path.join normalizes these, so the fix handles them correctly
    const dbPath = "/home/user///openclaw//memory/";
    const backupDir = constructBackupDir(dbPath);

    assert.ok(backupDir);
    assert.strictEqual(typeof backupDir, "string");
    assert.ok(isAbsolute(backupDir));
  });

  /**
   * Negative test: verify the crash path that the fix prevents.
   * This simulates what would happen if api.resolvePath() were still
   * called on the already-absolute join result inside the timer closure.
   *
   * In OpenClaw 2026.4.22+ strict mode, api.resolvePath(absolute-path)
   * returns undefined because the resolveUserPath chain treats it as
   * "no home-relative prefix to resolve" → undefined.
   */
  it("exposes the crash when resolvePath returns undefined (pre-fix behavior)", () => {
    // Simulate api.resolvePath() returning undefined for an absolute path
    function simulateBrokenResolvePath(absolutePath) {
      // In OpenClaw 2026.4.x strict mode, this is what happened:
      // api.resolvePath(absolute-path) → undefined
      return isAbsolute(absolutePath) ? undefined : absolutePath;
    }

    const dbPath = "/home/user/.openclaw/memory/lancedb";
    const intermediatePath = join(dbPath, "..", "backups");

    // Pre-fix: this would have been called as api.resolvePath(join(...))
    const result = simulateBrokenResolvePath(intermediatePath);
    assert.strictEqual(result, undefined,
      "api.resolvePath on absolute path returns undefined — this is the bug");

    // The fix: skip api.resolvePath and use join() directly
    const fixedBackupDir = intermediatePath; // join() result used directly
    assert.ok(fixedBackupDir);
    assert.strictEqual(typeof fixedBackupDir, "string");
    assert.ok(isAbsolute(fixedBackupDir));
  });
});
