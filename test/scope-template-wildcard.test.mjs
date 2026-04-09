import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  MemoryScopeManager,
  hasTemplateVars,
  resolveTemplateScope,
  resolveImplicitWriteScope,
  matchesWildcardScope,
  inferWildcardFromTemplate,
} = jiti("../src/scopes.ts");

// ============================================================================
// Unit tests for template & wildcard utilities
// ============================================================================

describe("hasTemplateVars", () => {
  it("detects template variables", () => {
    assert.strictEqual(hasTemplateVars("user:${accountId}"), true);
    assert.strictEqual(hasTemplateVars("${agentId}:user:${accountId}"), true);
  });

  it("returns false for static strings", () => {
    assert.strictEqual(hasTemplateVars("global"), false);
    assert.strictEqual(hasTemplateVars("user:alice"), false);
  });

  it("returns false for malformed templates", () => {
    assert.strictEqual(hasTemplateVars("user:$accountId"), false);
  });
});

describe("resolveTemplateScope", () => {
  it("resolves a single variable", () => {
    assert.strictEqual(
      resolveTemplateScope("user:${accountId}", { accountId: "alice" }),
      "user:alice",
    );
  });

  it("resolves multiple variables", () => {
    assert.strictEqual(
      resolveTemplateScope("${agentId}:user:${accountId}", { agentId: "bot-1", accountId: "alice" }),
      "bot-1:user:alice",
    );
  });

  it("returns undefined when ctx is missing", () => {
    assert.strictEqual(resolveTemplateScope("user:${accountId}", undefined), undefined);
  });

  it("returns undefined when a variable is missing from ctx", () => {
    assert.strictEqual(resolveTemplateScope("user:${accountId}", { agentId: "bot-1" }), undefined);
  });

  it("returns undefined when a variable is empty string", () => {
    assert.strictEqual(resolveTemplateScope("user:${accountId}", { accountId: "" }), undefined);
  });
});

describe("matchesWildcardScope", () => {
  it("matches concrete scopes against wildcard", () => {
    assert.strictEqual(matchesWildcardScope("user:*", "user:alice"), true);
    assert.strictEqual(matchesWildcardScope("user:*", "user:bob"), true);
  });

  it("does not match the wildcard pattern itself", () => {
    assert.strictEqual(matchesWildcardScope("user:*", "user:"), false);
  });

  it("does not match unrelated scopes", () => {
    assert.strictEqual(matchesWildcardScope("user:*", "agent:main"), false);
    assert.strictEqual(matchesWildcardScope("user:*", "global"), false);
  });

  it("falls back to exact match for non-wildcard patterns", () => {
    assert.strictEqual(matchesWildcardScope("global", "global"), true);
    assert.strictEqual(matchesWildcardScope("user:alice", "user:bob"), false);
  });

  it("supports compound wildcard prefixes", () => {
    assert.strictEqual(matchesWildcardScope("bot-1:user:*", "bot-1:user:alice"), true);
    assert.strictEqual(matchesWildcardScope("bot-1:user:*", "bot-2:user:alice"), false);
  });
});

describe("inferWildcardFromTemplate", () => {
  it("infers wildcard from simple template", () => {
    assert.strictEqual(inferWildcardFromTemplate("user:${accountId}"), "user:*");
  });

  it("infers wildcard from compound template", () => {
    assert.strictEqual(inferWildcardFromTemplate("bot-1:user:${accountId}"), "bot-1:user:*");
  });

  it("returns undefined when template starts with variable", () => {
    assert.strictEqual(inferWildcardFromTemplate("${agentId}:user:${accountId}"), undefined);
  });

  it("returns undefined for static strings", () => {
    assert.strictEqual(inferWildcardFromTemplate("global"), undefined);
  });

  it("rejects agent:${agentId}:user:${accountId} — would produce overly broad agent:*", () => {
    assert.strictEqual(inferWildcardFromTemplate("agent:${agentId}:user:${accountId}"), undefined);
  });

  it("allows agent:${agentId} as single-var template", () => {
    assert.strictEqual(inferWildcardFromTemplate("agent:${agentId}"), "agent:*");
  });
});

describe("resolveImplicitWriteScope", () => {
  it("returns the concrete resolved scope directly for template defaults", () => {
    const manager = new MemoryScopeManager({
      default: "user:${accountId}",
      agentAccess: { main: ["global", "user:*"] },
    });

    assert.deepStrictEqual(
      resolveImplicitWriteScope({
        configuredDefaultScope: "user:${accountId}",
        scopeManager: manager,
        agentId: "main",
        context: { agentId: "main", accountId: "alice" },
      }),
      { scope: "user:alice" },
    );
  });

  it("returns only failure details when a template default cannot be resolved", () => {
    const manager = new MemoryScopeManager({
      default: "user:${accountId}",
      agentAccess: { main: ["global", "user:*"] },
    });

    assert.deepStrictEqual(
      resolveImplicitWriteScope({
        configuredDefaultScope: "user:${accountId}",
        scopeManager: manager,
        agentId: "main",
        context: { agentId: "main" },
      }),
      { reason: "template_unresolved" },
    );
  });
});

// ============================================================================
// Integration tests: MemoryScopeManager with explicit wildcard agentAccess
// (Plan B: scope system stays static, wildcards only via explicit config)
// ============================================================================

describe("MemoryScopeManager - Explicit Wildcard agentAccess", () => {
  it("isAccessible allows concrete scope matching explicit wildcard", () => {
    const manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { "bot-1": ["global", "user:*"] },
    });
    assert.strictEqual(manager.isAccessible("user:alice", "bot-1"), true);
    assert.strictEqual(manager.isAccessible("user:bob", "bot-1"), true);
    assert.strictEqual(manager.isAccessible("agent:bot-1", "bot-1"), false);
  });

  it("getScopeFilter includes wildcard from explicit agentAccess", () => {
    const manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { "bot-1": ["global", "user:*"] },
    });
    const filter = manager.getScopeFilter("bot-1");
    assert.ok(Array.isArray(filter));
    assert.ok(filter.includes("user:*"));
  });

  it("setAgentAccess accepts wildcard scopes", () => {
    const manager = new MemoryScopeManager({ default: "global" });
    manager.setAgentAccess("bot-1", ["global", "user:*"]);
    assert.strictEqual(manager.isAccessible("user:alice", "bot-1"), true);
  });

  it("validateScope accepts wildcard patterns", () => {
    const manager = new MemoryScopeManager({ default: "global" });
    assert.strictEqual(manager.validateScope("user:*"), true);
    assert.strictEqual(manager.validateScope("custom:*"), true);
  });
});

describe("MemoryScopeManager - Template Default (no auto-wildcard)", () => {
  it("accepts a template default without throwing", () => {
    const manager = new MemoryScopeManager({ default: "user:${accountId}" });
    assert.ok(manager);
  });

  it("getDefaultScope returns static default for template (no resolution in scope layer)", () => {
    // In Plan B, scope system does NOT resolve templates — it returns the raw config default
    // or falls back to agent scope. The hook layer handles template resolution.
    const manager = new MemoryScopeManager({ default: "user:${accountId}" });
    // getDefaultScope without template awareness returns agent scope (default behavior)
    assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
  });

  it("does NOT auto-append wildcard to accessible scopes", () => {
    const manager = new MemoryScopeManager({ default: "user:${accountId}" });
    const scopes = manager.getAccessibleScopes("main");
    assert.ok(!scopes.some(s => s.endsWith(":*")), `Should not contain wildcards: ${JSON.stringify(scopes)}`);
  });

  it("isAccessible does NOT grant access to user:alice without explicit agentAccess", () => {
    const manager = new MemoryScopeManager({ default: "user:${accountId}" });
    assert.strictEqual(manager.isAccessible("user:alice", "main"), false);
  });
});

describe("MemoryScopeManager - Backward Compatibility", () => {
  it("static default still works exactly as before", () => {
    const manager = new MemoryScopeManager({ default: "global" });
    assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
    assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
      "global",
      "agent:main",
      "reflection:agent:main",
    ]);
  });

  it("explicit agentAccess without wildcards still works", () => {
    const manager = new MemoryScopeManager({
      default: "global",
      agentAccess: { main: ["global", "custom:shared"] },
    });
    assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
      "global",
      "custom:shared",
      "reflection:agent:main",
    ]);
    assert.strictEqual(manager.isAccessible("custom:shared", "main"), true);
    assert.strictEqual(manager.isAccessible("agent:main", "main"), false);
  });

  it("system bypass still works with template default", () => {
    const manager = new MemoryScopeManager({ default: "user:${accountId}" });
    assert.strictEqual(manager.getScopeFilter("system"), undefined);
    assert.strictEqual(manager.getScopeFilter(undefined), undefined);
    assert.strictEqual(manager.isAccessible("user:alice", "system"), true);
  });
});
