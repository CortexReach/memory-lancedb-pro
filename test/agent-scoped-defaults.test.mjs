/**
 * Tests for the autoAgentScope feature (Phase 1 / C1).
 *
 * Target behavior when autoAgentScope is enabled:
 *   - default write scope becomes agent:<agentId>
 *   - default accessible scopes become global + agent:<agentId> (always as baseline)
 *   - explicit agentAccess overrides remain authoritative (extend baseline, not replace)
 *   - system bypass behavior is unchanged
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryScopeManager } = jiti("../src/scopes.ts");

// ─────────────────────────────────────────────────────────────────────────────
// autoAgentScope: false (default — backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────
describe("autoAgentScope: false (default — backward compatibility)", () => {
  let manager;

  beforeEach(() => {
    manager = new MemoryScopeManager({ default: "global" });
  });

  it("exposes accessible scopes [global, agent:<id>, reflection:<id>] with no explicit ACL", () => {
    assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
      "global",
      "agent:main",
      "reflection:agent:main",
    ]);
  });

  it("returns agent:<id> as default write scope with no explicit ACL", () => {
    assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
  });

  it("with explicit ACL, accessible scopes are exactly the ACL list + reflection (no auto-baseline)", () => {
    manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { main: ["global", "custom:shared"] },
    });

    assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
      "global",
      "custom:shared",
      "reflection:agent:main",
    ]);
  });

  it("with explicit ACL excluding agent:<id>, default scope falls back to config.default", () => {
    manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { main: ["global", "custom:shared"] },
    });

    assert.strictEqual(manager.getDefaultScope("main"), "global");
  });

  it("with explicit ACL excluding agent:<id>, agent:<id> is not accessible", () => {
    manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { main: ["global", "custom:shared"] },
    });

    assert.strictEqual(manager.isAccessible("agent:main", "main"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// autoAgentScope: true
// ─────────────────────────────────────────────────────────────────────────────
describe("autoAgentScope: true", () => {
  let manager;

  beforeEach(() => {
    manager = new MemoryScopeManager({ default: "global", autoAgentScope: true });
  });

  // ── No explicit ACL ────────────────────────────────────────────────────────

  it("no explicit ACL: accessible scopes are still [global, agent:<id>, reflection:<id>]", () => {
    assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
      "global",
      "agent:main",
      "reflection:agent:main",
    ]);
  });

  it("no explicit ACL: default write scope is agent:<id>", () => {
    assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
  });

  // ── With explicit ACL ──────────────────────────────────────────────────────

  it("with explicit ACL, global + agent:<id> are injected as baseline before the explicit list", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["custom:shared"] },
    });

    const scopes = manager.getAccessibleScopes("main");
    assert.ok(scopes.includes("global"), "must include global");
    assert.ok(scopes.includes("agent:main"), "must include agent:main");
    assert.ok(scopes.includes("custom:shared"), "must include explicit custom:shared");
    assert.ok(scopes.includes("reflection:agent:main"), "must include reflection scope");
  });

  it("with explicit ACL, default write scope is still agent:<id>", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["global", "custom:shared"] },
    });

    assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
  });

  it("with explicit ACL, agent:<id> is accessible even if not listed", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["global", "custom:shared"] },
    });

    assert.strictEqual(manager.isAccessible("agent:main", "main"), true);
  });

  it("with explicit ACL, global is accessible even if not listed", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["custom:shared"] },
    });

    assert.strictEqual(manager.isAccessible("global", "main"), true);
  });

  it("does not duplicate scopes when explicit ACL already includes agent:<id>", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["global", "agent:main", "custom:shared"] },
    });

    const scopes = manager.getAccessibleScopes("main");
    const agentMainCount = scopes.filter(s => s === "agent:main").length;
    assert.strictEqual(agentMainCount, 1, "agent:main must not be duplicated");
  });

  it("does not duplicate global when explicit ACL already includes global", () => {
    manager = new MemoryScopeManager({
      default: "global",
      autoAgentScope: true,
      agentAccess: { main: ["global", "custom:shared"] },
    });

    const scopes = manager.getAccessibleScopes("main");
    const globalCount = scopes.filter(s => s === "global").length;
    assert.strictEqual(globalCount, 1, "global must not be duplicated");
  });

  // ── Runtime setAgentAccess with autoAgentScope: true ──────────────────────

  it("setAgentAccess at runtime: baseline floor still enforced even if stored ACL omits global and agent:<id>", () => {
    // Start with no explicit ACL
    const m = new MemoryScopeManager({ default: "global", autoAgentScope: true });
    // Narrow the ACL at runtime to only custom:shared — omitting global and agent:alice
    m.setAgentAccess("alice", ["custom:shared"]);
    // The autoAgentScope floor must still enforce global + agent:alice
    assert.strictEqual(m.isAccessible("global", "alice"), true);
    assert.strictEqual(m.isAccessible("agent:alice", "alice"), true);
    assert.strictEqual(m.isAccessible("custom:shared", "alice"), true);
    assert.strictEqual(m.getDefaultScope("alice"), "agent:alice");
  });

  it("setAgentAccess at runtime: ACL update on autoAgentScope: false does not inject baseline", () => {
    const m = new MemoryScopeManager({ default: "global" });
    m.setAgentAccess("bob", ["custom:shared"]);
    assert.strictEqual(m.isAccessible("agent:bob", "bob"), false);
    assert.strictEqual(m.getDefaultScope("bob"), "global");
  });

  // ── Cross-agent isolation ──────────────────────────────────────────────────

  it("agent main cannot access agent:other even with autoAgentScope enabled", () => {
    assert.strictEqual(manager.isAccessible("agent:other", "main"), false);
  });

  it("agent main cannot access another agent's reflection scope", () => {
    assert.strictEqual(manager.isAccessible("reflection:agent:other", "main"), false);
  });

  // ── System bypass unchanged ────────────────────────────────────────────────

  it("system bypass still returns undefined for getScopeFilter", () => {
    assert.strictEqual(manager.getScopeFilter("system"), undefined);
    assert.strictEqual(manager.getScopeFilter("undefined"), undefined);
  });

  it("system bypass still throws on getDefaultScope", () => {
    assert.throws(() => manager.getDefaultScope("system"), /must provide an explicit write scope/);
  });

  // ── Config round-trip ──────────────────────────────────────────────────────

  it("exportConfig preserves autoAgentScope: true", () => {
    const exported = manager.exportConfig();
    assert.strictEqual(exported.autoAgentScope, true);
  });

  it("importConfig propagates autoAgentScope: true", () => {
    const plain = new MemoryScopeManager({ default: "global" });
    plain.importConfig({ autoAgentScope: true });

    // After import, autoAgentScope should be active
    plain.importConfig({
      agentAccess: { alice: ["custom:shared"] },
    });
    assert.strictEqual(plain.isAccessible("agent:alice", "alice"), true);
  });

  it("importConfig can disable autoAgentScope", () => {
    // Start with autoAgentScope: true
    manager.importConfig({
      autoAgentScope: false,
      agentAccess: { main: ["custom:shared"] },
    });
    // Now agent:main should NOT be auto-added
    const scopes = manager.getAccessibleScopes("main");
    assert.ok(!scopes.includes("agent:main"), "agent:main should not be present after disabling autoAgentScope");
  });
});
