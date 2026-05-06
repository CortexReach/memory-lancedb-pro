import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
import { join } from "path";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { resolveRejectedAuditFilePath } = jiti("../src/admission-control.ts");

// ============================================================================
// resolveRejectedAuditFilePath — path construction regression tests
//
// Issue #682 (PR #695): OpenClaw 2026.4.x strict plugin API causes
//   api.resolvePath(already-absolute-path) → undefined
//
// This function is the shared path-construction layer used by both:
//   - runBackup() in index.ts  (fixed by PR #695)
//   - admission rejection audit writer in index.ts (fixed alongside PR #695)
//
// When no explicit rejectedAuditFilePath is configured, the default derived
// path is already absolute (join of resolvedDbPath + "..").  The caller must
// NOT wrap it again in api.resolvePath.
//
// When an explicit path IS configured, the caller is responsible for resolving
// it based on whether it is relative or absolute.
// ============================================================================

describe("resolveRejectedAuditFilePath", () => {
  const ABSOLUTE_DB_PATH = "/home/user/.openclaw/memory/lancedb-pro";

  // --------------------------------------------------------------------------
  // Default path — always derived from dbPath, always absolute
  // --------------------------------------------------------------------------
  it("returns an already-absolute path when no explicit config is set", () => {
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, null);
    assert.ok(result.startsWith("/"), `Expected absolute path, got: ${result}`);
  });

  it("derived path contains admission-audit segment", () => {
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, null);
    assert.ok(
      result.includes("admission-audit"),
      `Expected "admission-audit" in path, got: ${result}`,
    );
  });

  it("derived path ends with rejections.jsonl", () => {
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, null);
    assert.ok(
      result.endsWith("rejections.jsonl"),
      `Expected "rejections.jsonl" suffix, got: ${result}`,
    );
  });

  it("derived path is based on dbPath .. parent", () => {
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, null);
    const expectedParent = join(ABSOLUTE_DB_PATH, "..");
    assert.ok(
      result.startsWith(expectedParent),
      `Expected path to start with "${expectedParent}", got: ${result}`,
    );
  });

  // --------------------------------------------------------------------------
  // Explicit relative path — returned as-is for caller to resolve
  // --------------------------------------------------------------------------
  it("returns explicit relative path as-is (caller must resolve)", () => {
    const config = { rejectedAuditFilePath: "data/audit/rejections.jsonl" };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.strictEqual(result, "data/audit/rejections.jsonl");
  });

  it("trims whitespace from explicit relative path", () => {
    const config = { rejectedAuditFilePath: "  data/audit/rejections.jsonl  " };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.strictEqual(result, "data/audit/rejections.jsonl");
  });

  // --------------------------------------------------------------------------
  // Explicit absolute path — returned as-is, must NOT be re-resolved
  // --------------------------------------------------------------------------
  it("returns explicit absolute path as-is", () => {
    const config = { rejectedAuditFilePath: "/var/log/memory/rejections.jsonl" };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.strictEqual(result, "/var/log/memory/rejections.jsonl");
  });

  it("explicit absolute path starts with / and must not be re-resolved", () => {
    const config = { rejectedAuditFilePath: "/custom/path/rejections.jsonl" };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.ok(result.startsWith("/"), `Expected absolute, got: ${result}`);
  });

  // --------------------------------------------------------------------------
  // Empty / whitespace-only explicit path — falls back to default
  // --------------------------------------------------------------------------
  it("treats empty string explicit path as unset (uses default)", () => {
    const config = { rejectedAuditFilePath: "" };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.ok(result.endsWith("rejections.jsonl"), `Expected default, got: ${result}`);
  });

  it("treats whitespace-only explicit path as unset (uses default)", () => {
    const config = { rejectedAuditFilePath: "   " };
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.ok(result.endsWith("rejections.jsonl"), `Expected default, got: ${result}`);
  });

  // --------------------------------------------------------------------------
  // Config object with no rejectedAuditFilePath key — uses default
  // --------------------------------------------------------------------------
  it("uses default when config has no rejectedAuditFilePath key", () => {
    const config = {};
    const result = resolveRejectedAuditFilePath(ABSOLUTE_DB_PATH, config);
    assert.ok(result.endsWith("rejections.jsonl"), `Expected default, got: ${result}`);
  });
});
