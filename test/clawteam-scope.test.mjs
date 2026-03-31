import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryScopeManager, _resetLegacyFallbackWarningState } = jiti("../src/scopes.ts");
const { parseClawteamScopes, applyClawteamScopes } = jiti("../src/clawteam-scope.ts");

describe("ClawTeam Scope Integration", () => {
  let manager;

  beforeEach(() => {
    manager = new MemoryScopeManager({ default: "global", agentAccess: {} });
    _resetLegacyFallbackWarningState();
  });

  // ── parseClawteamScopes ──────────────────────────────────────────────

  describe("parseClawteamScopes", () => {
    it("parses comma-separated scope names", () => {
      assert.deepStrictEqual(
        parseClawteamScopes("custom:team-a,custom:team-b"),
        ["custom:team-a", "custom:team-b"],
      );
    });

    it("trims whitespace around scope names", () => {
      assert.deepStrictEqual(
        parseClawteamScopes("  custom:team-a , custom:team-b  "),
        ["custom:team-a", "custom:team-b"],
      );
    });

    it("returns empty array for undefined", () => {
      assert.deepStrictEqual(parseClawteamScopes(undefined), []);
    });

    it("returns empty array for empty string", () => {
      assert.deepStrictEqual(parseClawteamScopes(""), []);
    });

    it("filters out empty segments from trailing commas", () => {
      assert.deepStrictEqual(
        parseClawteamScopes("custom:team-a,,, "),
        ["custom:team-a"],
      );
    });

    it("handles single scope without commas", () => {
      assert.deepStrictEqual(
        parseClawteamScopes("custom:team-demo"),
        ["custom:team-demo"],
      );
    });
  });

  // ── applyClawteamScopes ──────────────────────────────────────────────

  describe("applyClawteamScopes", () => {
    it("registers scope definitions for unknown scopes", () => {
      assert.strictEqual(manager.getScopeDefinition("custom:team-x"), undefined);

      applyClawteamScopes(manager, ["custom:team-x"]);

      const def = manager.getScopeDefinition("custom:team-x");
      assert.notStrictEqual(def, undefined);
      assert.match(def.description, /ClawTeam shared scope/);
    });

    it("does not overwrite existing scope definitions", () => {
      manager.addScopeDefinition("custom:team-x", { description: "My custom def" });

      applyClawteamScopes(manager, ["custom:team-x"]);

      assert.strictEqual(manager.getScopeDefinition("custom:team-x").description, "My custom def");
    });

    it("extends getAccessibleScopes for a normal agent", () => {
      applyClawteamScopes(manager, ["custom:team-demo"]);

      const scopes = manager.getAccessibleScopes("agent-1");
      assert.ok(scopes.includes("custom:team-demo"), "should include team scope");
    });

    it("preserves original agent scopes after extension", () => {
      applyClawteamScopes(manager, ["custom:team-demo"]);

      const scopes = manager.getAccessibleScopes("main");
      assert.ok(scopes.includes("global"), "should still have global");
      assert.ok(scopes.includes("agent:main"), "should still have agent:main");
      assert.ok(scopes.includes("reflection:agent:main"), "should still have reflection scope");
    });

    it("does not duplicate scopes already in the base list", () => {
      // global is always in the base list
      applyClawteamScopes(manager, ["global"]);

      const scopes = manager.getAccessibleScopes("main");
      const globalCount = scopes.filter(s => s === "global").length;
      assert.strictEqual(globalCount, 1, "global should appear exactly once");
    });

    it("supports multiple team scopes", () => {
      applyClawteamScopes(manager, ["custom:team-a", "custom:team-b"]);

      const scopes = manager.getAccessibleScopes("agent-1");
      assert.ok(scopes.includes("custom:team-a"));
      assert.ok(scopes.includes("custom:team-b"));
    });

    it("no-ops when given empty scopes array", () => {
      const before = manager.getAccessibleScopes("main");
      applyClawteamScopes(manager, []);
      const after = manager.getAccessibleScopes("main");
      assert.deepStrictEqual(before, after);
    });
  });

  // ── Baseline (no ClawTeam) ───────────────────────────────────────────

  describe("without applyClawteamScopes", () => {
    it("agent does not have team scopes by default", () => {
      const scopes = manager.getAccessibleScopes("main");
      assert.ok(!scopes.includes("custom:team-demo"), "should NOT include team scope");
      assert.deepStrictEqual(scopes, ["global", "agent:main", "reflection:agent:main"]);
    });
  });
});
