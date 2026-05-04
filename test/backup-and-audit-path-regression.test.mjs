/**
 * Regression tests for Issue #682 and the related admission audit path pattern.
 *
 * Issue #682 (PR #695): OpenClaw 2026.4.x tightened the plugin API so that
 * calling api.resolvePath() on an already-absolute path that points outside
 * the agent workspace root now returns undefined. The backup timer and the
 * admission audit writer both previously did this redundant resolve, causing:
 *   - runBackup(): crash (TypeError passed to mkdir)
 *   - admission audit: silent write failure (caught by try/catch)
 *
 * These tests verify the fix: path construction must not double-resolve
 * an already-absolute path through api.resolvePath.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveRejectedAuditFilePath } = jiti("../src/admission-control.ts");

// ============================================================================
// Helper: simulate api.resolvePath behaviour on OpenClaw 2026.3.x (old)
// vs 2026.4.x (strict).  In 2026.4.x, resolving an already-absolute path
// that points *outside* the workspace root returns undefined.
// ============================================================================

/**
 * Simulates OpenClaw 2026.4.x api.resolvePath strict behaviour.
 * In 2026.4.x, when the input is already absolute AND points outside the
 * configured workspace root, the API returns undefined instead of the input.
 *
 * IMPORTANT: this is a behavioural MODEL for testing purposes.
 * The real api.resolvePath is part of the OpenClaw plugin SDK.
 */
function simulateOpenClaw2026_4ResolvePath(inputPath, options = {}) {
  const { workspaceRoot = "/home/user/.openclaw/agent/workspace-abc" } = options;
  // If already absolute and crosses above workspaceRoot boundary → undefined (2026.4.x strict)
  if (inputPath.startsWith("/")) {
    const normalized = inputPath; // already absolute
    // "crosses outside" is when the path is not under workspaceRoot
    // For these tests, paths under workspaceRoot are "inside"
    if (workspaceRoot && !normalized.startsWith(workspaceRoot)) {
      return undefined; // 2026.4.x strict: returns undefined
    }
    return normalized; // safe absolute → returned unchanged
  }
  // Relative path → resolved against workspaceRoot
  return join(workspaceRoot, inputPath);
}

// ============================================================================
// Issue #682 — runBackup() path construction
// ============================================================================
//
// The buggy pattern was:
//   const backupDir = api.resolvePath(join(resolvedDbPath, "..", "backups"));
//
// resolvedDbPath is already absolute (produced by api.resolvePath at plugin
// init).  Wrapping it AGAIN with api.resolvePath was a no-op in 2026.3.x
// but returns undefined in 2026.4.x when the derived path (parent of db dir)
// is outside the workspace root.
//
// The fix: join directly, without api.resolvePath.
//   const backupDir = join(resolvedDbPath, "..", "backups");
//
// These tests verify the path construction is correct and that skipping
// api.resolvePath is safe (the path is already absolute).
// ============================================================================

describe("runBackup path construction (Issue #682 / PR #695)", () => {
  it("derived backupDir from absolute resolvedDbPath is itself absolute", () => {
    // Simulate resolvedDbPath as produced at plugin init (already absolute)
    const resolvedDbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const backupDir = join(resolvedDbPath, "..", "backups");

    assert.ok(backupDir.startsWith("/"), `backupDir should be absolute: ${backupDir}`);
    assert.equal(backupDir, "/home/user/.openclaw/memory/backups");
  });

  it("skipping api.resolvePath is safe: backupDir does not need re-resolution", () => {
    const resolvedDbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const backupDir = join(resolvedDbPath, "..", "backups");

    // The old buggy code would have done:
    //   const oldBuggy = simulateOpenClaw2026_4ResolvePath(backupDir);
    // and backupDir (= "/home/user/.openclaw/memory/backups") IS under
    // the workspace root, so it would return the path unchanged here.
    // BUT: if resolvedDbPath is a path that IS outside the workspace
    // (e.g. a custom dbPath the user configured), the derived backupDir
    // would ALSO be outside → api.resolvePath returns undefined → crash.
    //
    // By skipping api.resolvePath, we guarantee backupDir is always valid.
    assert.ok(backupDir.length > 0, "backupDir must not be empty/undefined");
    assert.ok(backupDir.includes("backups"), "backupDir must contain 'backups'");
  });

  it("derived backupDir parent directory is correct", () => {
    const resolvedDbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const backupDir = join(resolvedDbPath, "..", "backups");

    const backupParent = dirname(backupDir);
    assert.equal(
      backupParent,
      "/home/user/.openclaw/memory",
      "backup dir parent should be the sibling of the lancedb-pro directory",
    );
  });

  it("path construction is robust when resolvedDbPath is deeply nested", () => {
    const resolvedDbPath = "/home/user/.openclaw/agents/agent-xyz/memory/db";
    const backupDir = join(resolvedDbPath, "..", "backups");

    assert.equal(backupDir, "/home/user/.openclaw/agents/agent-xyz/memory/backups");
    assert.ok(backupDir.startsWith("/"));
  });
});

// ============================================================================
// Admission audit path — same redundant resolve pattern (flagged by rwmjhb)
// ============================================================================
//
// The same pattern existed in createAdmissionRejectionAuditWriter:
//   const filePath = api.resolvePath(
//     resolveRejectedAuditFilePath(resolvedDbPath, config.admissionControl),
//   );
//
// Fix: resolveRejectedAuditFilePath returns an already-absolute derived path
// when no explicit user config is set (join of resolvedDbPath + "..").
// Only user-provided relative paths need api.resolvePath.
// Absolute paths (either explicit user config or derived) must NOT be
// re-resolved through api.resolvePath in 2026.4.x strict mode.
// ============================================================================

describe("resolveRejectedAuditFilePath", () => {
  it("derived path (no explicit config) is already absolute", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const result = resolveRejectedAuditFilePath(dbPath, null);

    assert.ok(result.startsWith("/"), `should be absolute: ${result}`);
    assert.ok(result.includes("admission-audit"), "should include admission-audit");
    assert.ok(result.includes("rejections.jsonl"), "should end with rejections.jsonl");
  });

  it("derived path resolves to the sibling admission-audit directory", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const result = resolveRejectedAuditFilePath(dbPath, null);

    const expected = "/home/user/.openclaw/memory/admission-audit/rejections.jsonl";
    assert.equal(result, expected);
  });

  it("explicit absolute user path is returned unchanged", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const explicitPath = "/tmp/my-rejections.jsonl";
    const config = { rejectedAuditFilePath: explicitPath };
    const result = resolveRejectedAuditFilePath(dbPath, config);

    assert.equal(result, explicitPath);
  });

  it("explicit relative user path is returned as-is (no auto-resolution here)", () => {
    // The caller (createAdmissionRejectionAuditWriter) is responsible for
    // resolving relative paths via api.resolvePath. This test documents that
    // resolveRejectedAuditFilePath itself does NOT resolve relative paths.
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const config = { rejectedAuditFilePath: "./my-rejections.jsonl" };
    const result = resolveRejectedAuditFilePath(dbPath, config);

    assert.equal(result, "./my-rejections.jsonl");
  });

  it("whitespace in explicit path is trimmed", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const config = { rejectedAuditFilePath: "  /tmp/rejections.jsonl  " };
    const result = resolveRejectedAuditFilePath(dbPath, config);

    assert.equal(result, "/tmp/rejections.jsonl");
  });

  it("empty-string explicit path falls back to derived path", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const config = { rejectedAuditFilePath: "" };
    const result = resolveRejectedAuditFilePath(dbPath, config);

    assert.ok(result.includes("admission-audit"));
    assert.ok(result.includes("rejections.jsonl"));
  });
});

// ============================================================================
// createAdmissionRejectionAuditWriter path resolution fix
// (the "fix" in this PR)
//
// After the fix, the logic is:
//   const rawFilePath = resolveRejectedAuditFilePath(resolvedDbPath, config);
//   const filePath = rawFilePath.startsWith("/")
//     ? rawFilePath                         // already absolute → use directly
//     : api.resolvePath(rawFilePath);       // relative → resolve it
//
// This test verifies the logic WITHOUT needing to instantiate the full plugin.
// ============================================================================

describe("createAdmissionRejectionAuditWriter path resolution logic", () => {
  /**
   * Replicates the fixed path resolution logic for isolated testing.
   * @param {string} rawFilePath  - output of resolveRejectedAuditFilePath
   * @param {(p: string) => string | undefined} resolvePathImpl - api.resolvePath mock
   */
  function resolveAuditFilePath(rawFilePath, resolvePathImpl) {
    return rawFilePath.startsWith("/")
      ? rawFilePath
      : resolvePathImpl(rawFilePath);
  }

  it("absolute derived path skips api.resolvePath (no double-resolve)", () => {
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const rawFilePath = resolveRejectedAuditFilePath(dbPath, null); // absolute

    let resolvePathCalled = false;
    const mockResolve = (_p) => {
      resolvePathCalled = true;
      return "/mocked/path";
    };

    const filePath = resolveAuditFilePath(rawFilePath, mockResolve);

    assert.equal(
      filePath,
      rawFilePath,
      "absolute path should be used directly without calling api.resolvePath",
    );
    assert.ok(
      !resolvePathCalled,
      "api.resolvePath should NOT be called for absolute paths",
    );
  });

  it("relative explicit path triggers api.resolvePath", () => {
    const config = { rejectedAuditFilePath: "./my-audit.jsonl" };
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const rawFilePath = resolveRejectedAuditFilePath(dbPath, config); // relative

    assert.ok(!rawFilePath.startsWith("/"), "rawFilePath should be relative");

    const resolvedResult = "/home/user/.openclaw/agent/workspace-abc/my-audit.jsonl";
    const mockResolve = (_p) => resolvedResult;

    const filePath = resolveAuditFilePath(rawFilePath, mockResolve);

    assert.equal(filePath, resolvedResult);
  });

  it("absolute explicit user path skips api.resolvePath", () => {
    const config = { rejectedAuditFilePath: "/tmp/explicit-audit.jsonl" };
    const dbPath = "/home/user/.openclaw/memory/lancedb-pro";
    const rawFilePath = resolveRejectedAuditFilePath(dbPath, config); // absolute

    assert.ok(rawFilePath.startsWith("/"));

    let resolvePathCalled = false;
    const mockResolve = (_p) => {
      resolvePathCalled = true;
      return undefined; // simulate 2026.4.x strict returning undefined
    };

    const filePath = resolveAuditFilePath(rawFilePath, mockResolve);

    assert.equal(
      filePath,
      "/tmp/explicit-audit.jsonl",
      "absolute explicit path should be used directly",
    );
    assert.ok(
      !resolvePathCalled,
      "api.resolvePath should NOT be called for absolute paths",
    );
  });
});
