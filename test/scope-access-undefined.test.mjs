import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryScopeManager, resolveScopeFilter } = jiti("../src/scopes.ts");

describe("MemoryScopeManager - System & Reflection Scopes", () => {
  let manager;
  const config = {
    default: "global",
    agentAccess: {},
  };

  beforeEach(() => {
    manager = new MemoryScopeManager(config);
  });

  describe("System/Admin Bypass", () => {
    const bypassIds = ["undefined", "system", "", undefined];

    bypassIds.forEach(id => {
      it(`allows valid scopes when agentId is '${id}'`, () => {
        assert.strictEqual(manager.isAccessible("global", id), true);
        assert.strictEqual(manager.isAccessible("reflection:agent:main", id), true);
        assert.strictEqual(manager.isAccessible("agent:any-agent", id), true);
      });

      it(`enumerates known scopes when agentId is '${id}'`, () => {
        assert.deepStrictEqual(manager.getAccessibleScopes(id), manager.getAllScopes());
      });

      it(`returns the default scope when agentId is '${id}'`, () => {
        assert.strictEqual(manager.getDefaultScope(id), "global");
      });

      it(`still rejects invalid scope formats when agentId is '${id}'`, () => {
        assert.strictEqual(manager.isAccessible("not a valid scope", id), false);
      });
    });

    it("uses filter bypass only for reserved internal identifiers", () => {
      assert.strictEqual(manager.getScopeFilter("system"), undefined);
      assert.strictEqual(manager.getScopeFilter("undefined"), undefined);
      assert.deepStrictEqual(manager.getScopeFilter("main"), [
        "global",
        "agent:main",
        "reflection:agent:main",
      ]);
    });

    it("does not bypass the store filter for empty or nullish agentId", () => {
      assert.deepStrictEqual(manager.getScopeFilter(""), manager.getAllScopes());
      assert.deepStrictEqual(manager.getScopeFilter(undefined), manager.getAllScopes());
    });

    it("rejects explicit ACL configuration for reserved bypass identifiers", () => {
      assert.throws(() => manager.setAgentAccess("system", ["global"]), /Reserved bypass agent ID/);
      assert.throws(() => manager.setAgentAccess("undefined", ["global"]), /Reserved bypass agent ID/);
    });

    it("warns when a legacy scope manager returns [] for a reserved bypass identifier", () => {
      const originalWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        const legacyManager = {
          getAccessibleScopes(id) {
            return id === "system" ? [] : ["global"];
          },
        };
        // Legacy [] is now normalized to undefined for bypass consistency
        assert.strictEqual(resolveScopeFilter(legacyManager, "system"), undefined);
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /legacy ScopeManager returned \[\] for reserved bypass id 'system'/);
    });
  });

  describe("Reflection scope access for specific agents", () => {
    it("validates reflection scopes through the public API", () => {
      assert.strictEqual(manager.validateScope("reflection:agent:main"), true);
      assert.strictEqual(manager.validateScope("reflection:anything"), true);
    });

    it("automatically grants default agent and reflection scopes", () => {
      assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
        "global",
        "agent:main",
        "reflection:agent:main",
      ]);
      assert.strictEqual(manager.getDefaultScope("main"), "agent:main");
    });

    it("allows an agent to access its own reflection scope automatically", () => {
      assert.strictEqual(manager.isAccessible("reflection:agent:main", "main"), true);
      assert.strictEqual(manager.isAccessible("reflection:agent:sub-agent", "sub-agent"), true);
    });

    it("does not allow an agent to access another agent's reflection scope by default", () => {
      assert.strictEqual(manager.isAccessible("reflection:agent:other", "main"), false);
    });

    it("preserves explicit access while still appending the agent's own reflection scope", () => {
      manager = new MemoryScopeManager({
        ...config,
        agentAccess: {
          main: ["global", "custom:shared"],
        },
      });

      assert.deepStrictEqual(manager.getAccessibleScopes("main"), [
        "global",
        "custom:shared",
        "reflection:agent:main",
      ]);
      assert.strictEqual(manager.isAccessible("reflection:agent:main", "main"), true);
      assert.strictEqual(manager.isAccessible("custom:shared", "main"), true);
      assert.strictEqual(manager.isAccessible("agent:main", "main"), false);
      assert.strictEqual(manager.getDefaultScope("main"), "global");
    });
  });
});
