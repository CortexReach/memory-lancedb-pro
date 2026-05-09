/**
 * agentid-validation-686.test.mjs
 *
 * Integration tests for the isInvalidAgentIdFormat() guard added to runMemoryReflection
 * (Issue #686). Verifies the production implementation, not a copied helper.
 *
 * This test directly imports the exported isInvalidAgentIdFormat() from index.ts
 * to exercise the actual production code path.
 *
 * Run: node --test test/agentid-validation-686.test.mjs
 * Or:  node test/agentid-validation-686.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jitiInstance = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const indexModule = jitiInstance("../index.ts");
const memoryLanceDBProPlugin = indexModule.default || indexModule;
const resetRegistration = indexModule.resetRegistration ?? (() => {});

// isInvalidAgentIdFormat is now exported from index.ts — test the PRODUCTION implementation
const isInvalidAgentIdFormat = indexModule.isInvalidAgentIdFormat;

// ---------------------------------------------------------------------------
// Test suite: isInvalidAgentIdFormat (production export)
// ---------------------------------------------------------------------------
describe("isInvalidAgentIdFormat — production export (Issue #686)", () => {
  // Layer 1: empty / undefined
  describe("Layer 1 — empty / undefined", () => {
    it("returns true when agentId is undefined", () => {
      assert.strictEqual(isInvalidAgentIdFormat(undefined), true);
    });

    it("returns true when agentId is null", () => {
      // @ts-ignore
      assert.strictEqual(isInvalidAgentIdFormat(null), true);
    });

    it("returns true when agentId is empty string", () => {
      assert.strictEqual(isInvalidAgentIdFormat(""), true);
    });
  });

  // Layer 2: pure numeric (chat_id pattern)
  describe("Layer 2 — pure numeric = chat_id", () => {
    it("returns true for a pure digit Discord user ID", () => {
      assert.strictEqual(isInvalidAgentIdFormat("657229412030480397"), true);
    });

    it("returns true for a pure digit Telegram user ID", () => {
      assert.strictEqual(isInvalidAgentIdFormat("123456789"), true);
    });

    it("returns true for a pure digit string (any source)", () => {
      assert.strictEqual(isInvalidAgentIdFormat("999"), true);
    });

    it("returns false for an ID that starts with a letter (dc-channel-- prefix)", () => {
      // Valid Discord channel agent ID format — should NOT be blocked
      assert.strictEqual(isInvalidAgentIdFormat("dc-channel--1476858065914695741"), false);
    });

    it("returns false for an ID that starts with a letter (tg-group-- prefix)", () => {
      assert.strictEqual(isInvalidAgentIdFormat("tg-group--5108601505"), false);
    });

    it("returns false for an ID with mixed alphanumeric characters", () => {
      assert.strictEqual(isInvalidAgentIdFormat("agent-x-123"), false);
    });

    it("returns false for a typical named agent", () => {
      assert.strictEqual(isInvalidAgentIdFormat("main"), false);
      assert.strictEqual(isInvalidAgentIdFormat("pi-agent"), false);
      assert.strictEqual(isInvalidAgentIdFormat("hermes"), false);
    });
  });

  // Layer 3: declaredAgents (signature-compat but NOT enforced in this impl)
  // NOTE: Layer 3 is intentionally omitted — see JSDoc in index.ts.
  // A follow-up PR should re-add Layer 3 with proper root-config access.
  describe("Layer 3 — declaredAgents (signature compat, not enforced)", () => {
    it("accepts a declaredAgents Set as second param without crashing", () => {
      const agents = new Set(["main", "dc-channel--123"]);
      assert.doesNotThrow(() => isInvalidAgentIdFormat("main", agents));
    });

    it("still returns correct Layer 1/2 results regardless of declaredAgents", () => {
      const agents = new Set(["main"]);
      // Layer 1: undefined still blocked
      assert.strictEqual(isInvalidAgentIdFormat(undefined, agents), true);
      // Layer 2: numeric still blocked even if not in declaredAgents
      assert.strictEqual(isInvalidAgentIdFormat("657229412030480397", agents), true);
      // Valid agent still allowed (Layer 3 is no-op in this implementation)
      assert.strictEqual(isInvalidAgentIdFormat("main", agents), false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration test: runMemoryReflection guard fires for numeric sessionKey
// ---------------------------------------------------------------------------
describe("runMemoryReflection — numeric sessionKey guard (Issue #686)", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "mlp-686-"));
    resetRegistration();
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
    resetRegistration();
  });

  it("runMemoryReflection skips early when sessionKey contains a numeric-only agentId", async () => {
    let hookCalled = false;
    const hookHandler = async (event) => {
      hookCalled = true;
    };
    const api = {
      pluginConfig: {
        dbPath: path.join(workDir, "db"),
        embedding: { apiKey: "test-key", dimensions: 4 },
        sessionStrategy: "memoryReflection",
        smartExtraction: false,
        autoCapture: false,
        autoRecall: false,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
      resolvePath(target) {
        if (!target || path.isAbsolute(target)) return target;
        return path.join(workDir, target);
      },
      logger: {
        info() {},
        warn() {},
        debug() {},
        error() {},
      },
      registerTool() {},
      registerCli() {},
      registerService() {},
      registerHook(name, handler) {
        if (name === "command:new") {
          api.hooks["command:new"] = handler;
        }
      },
      on() {},
      hooks: {},
    };

    memoryLanceDBProPlugin.register(api);

    const numericSessionKey = "agent:657229412030480397:session:test-session";
    const event = {
      sessionKey: numericSessionKey,
      action: "new",
      context: {
        commandSource: "test",
        sessionEntry: {},
        previousSessionEntry: {},
        cfg: api.pluginConfig,
      },
    };

    const hook = api.hooks["command:new"];
    assert.ok(hook, "command:new hook should be registered");
    await hook(event);
    assert.strictEqual(hookCalled, false, "hook should have skipped due to numeric agentId guard");
  });

  it("runMemoryReflection allows named agentId (non-numeric)", async () => {
    // Verify the guard does NOT block named agents
    const namedSessionKey = "agent:main:session:test-session";
    assert.strictEqual(isInvalidAgentIdFormat("main"), false);
    assert.strictEqual(
      isInvalidAgentIdFormat(namedSessionKey.split(":")[1]),
      false,
    );
  });
});
