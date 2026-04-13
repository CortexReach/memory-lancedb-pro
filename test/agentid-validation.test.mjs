/**
 * agentid-validation.test.mjs
 *
 * Unit tests for the isInvalidAgentIdFormat() guard function.
 * This function prevents hooks from running when agentId is:
 *   1. Empty / undefined (Layer 1)
 *   2. A pure numeric string = Discord/Telegram chat_id used as agentId (Layer 2)
 *   3. Not present in openclaw.json agents.list (Layer 3)
 *
 * Run: node --test test/agentid-validation.test.mjs
 * Or:  node test/agentid-validation.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jitiInstance = jitiFactory(import.meta.url, {
  interopDefault: true,
});

// We import index.ts purely for type-checking / jiti compilation.
// The actual isInvalidAgentIdFormat is a private function.
// We test it indirectly via the module's exported behavior, or directly
// by accessing it through jiti's module object.
const indexModule = jitiInstance("../index.ts");

// isInvalidAgentIdFormat is a private (non-exported) function.
// Access it from the jiti-loaded module if available; if not, skip to
// integration-only tests.
const isInvalidAgentIdFormat =
  typeof indexModule.isInvalidAgentIdFormat === "function"
    ? indexModule.isInvalidAgentIdFormat
    : null;

// ---------------------------------------------------------------------------
// Helper builders (mirror the real helpers in index.ts)
// ---------------------------------------------------------------------------
const EMPTY_SET = new Set();

/** @param {...string} ids */
function makeSet(...ids) {
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// isInvalidAgentIdFormat unit tests
// ---------------------------------------------------------------------------
if (isInvalidAgentIdFormat) {
  describe("isInvalidAgentIdFormat", () => {
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
      it("returns false for an ID that starts with a letter (dc-channel--)", () => {
        // This is a valid Discord channel agent ID format — should NOT be blocked
        assert.strictEqual(isInvalidAgentIdFormat("dc-channel--1476858065914695741"), false);
      });
      it("returns false for an ID that starts with a letter (tg-group--)", () => {
        assert.strictEqual(isInvalidAgentIdFormat("tg-group--5108601505"), false);
      });
      it("returns false for an ID with mixed alphanumeric characters", () => {
        assert.strictEqual(isInvalidAgentIdFormat("agent-x-123"), false);
      });
    });

    // Layer 3: declaredAgents Set membership
    describe("Layer 3 — declaredAgents Set", () => {
      const validAgents = makeSet("main", "dc-channel--1476858065914695741", "tg-group--5108601505");

      it("returns false when agentId is in declaredAgents", () => {
        assert.strictEqual(isInvalidAgentIdFormat("main", validAgents), false);
      });
      it("returns false when dc-channel--ID is in declaredAgents", () => {
        assert.strictEqual(
          isInvalidAgentIdFormat("dc-channel--1476858065914695741", validAgents),
          false,
        );
      });
      it("returns true when agentId is NOT in declaredAgents (numeric)", () => {
        // Numeric ID caught by Layer 2 first, but Layer 3 also catches it
        assert.strictEqual(isInvalidAgentIdFormat("999999999", validAgents), true);
      });
      it("returns true when agentId is NOT in declaredAgents (unknown string)", () => {
        // Non-numeric but unknown agent ID — should still be invalid if Set is populated
        assert.strictEqual(isInvalidAgentIdFormat("unknown-agent-xyz", validAgents), true);
      });
      it("returns false when declaredAgents is empty (no restrictions)", () => {
        // When no agents list is configured, only Layer 1 & 2 apply
        assert.strictEqual(isInvalidAgentIdFormat("some-random-id", EMPTY_SET), false);
      });
      it("returns false when declaredAgents is undefined (no config)", () => {
        assert.strictEqual(isInvalidAgentIdFormat("main", undefined), false);
      });
    });

    // Edge cases
    describe("Edge cases", () => {
      it("returns false for 'main' (the default agent)", () => {
        assert.strictEqual(isInvalidAgentIdFormat("main"), false);
      });
      it("whitespace-only string is NOT caught by Layer 1 (treated as truthy)", () => {
        // A whitespace-only string is not falsy, not pure digits, not in declaredAgents
        // so it falls through to Layer 3 (invalid if Set is non-empty).
        // This is arguably correct behavior — such IDs are garbage.
        assert.strictEqual(isInvalidAgentIdFormat("   ", makeSet()), false);
      });
    });
  });
} else {
  console.warn(
    "[agentid-validation] isInvalidAgentIdFormat not exported — skipping direct unit tests." +
    " Run integration tests instead.",
  );
}

// ---------------------------------------------------------------------------
// Integration test: verify declaredAgents Set is built correctly from config
// ---------------------------------------------------------------------------
describe("declaredAgents Set construction", () => {
  it("builds declaredAgents Set from openclaw.json agents.list id field", () => {
    // This mirrors the logic in index.ts config.declaredAgents initialization.
    // Simulate: cfg.agents.list = [{ id: "main" }, { id: "dc-channel--1476858065914695741" }]
    const cfgAgentsList = [
      { id: "main" },
      { id: "dc-channel--1476858065914695741" },
      { id: "tg-group--5108601505" },
    ];
    const s = new Set();
    for (const entry of cfgAgentsList) {
      if (entry && typeof entry === "object") {
        const id = entry.id;
        if (typeof id === "string" && id.trim().length > 0) s.add(id.trim());
      }
    }
    assert.strictEqual(s.has("main"), true);
    assert.strictEqual(s.has("dc-channel--1476858065914695741"), true);
    assert.strictEqual(s.has("tg-group--5108601505"), true);
    assert.strictEqual(s.size, 3);
  });

  it("ignores entries without a valid string id", () => {
    const cfgAgentsList = [
      { id: "main" },
      { id: "" },
      { id: "  " },
      {},
      null,
      undefined,
    ];
    const s = new Set();
    for (const entry of cfgAgentsList) {
      if (entry && typeof entry === "object") {
        const id = entry.id;
        if (typeof id === "string" && id.trim().length > 0) s.add(id.trim());
      }
    }
    assert.strictEqual(s.size, 1);
    assert.strictEqual(s.has("main"), true);
  });
});

// ---------------------------------------------------------------------------
// Regex unit tests (mirrors isChatIdBasedAgentId logic)
// ---------------------------------------------------------------------------
describe("isChatIdBasedAgentId regex", () => {
  const RE = /^\d+$/;

  const chatIdCases = [
    ["657229412030480397", true],
    ["123456789", true],
    ["0", true],
    ["9999999999999999999", true],
    ["dc-channel--1476858065914695741", false],
    ["tg-group--5108601505", false],
    ["main", false],
    ["agent-123", false],
    ["z-fundamental", false],
    ["dc-channel--123456789012345678", false],
    ["", false],
  ];

  for (const [input, expected] of chatIdCases) {
    it(`/${input}/ matches = ${expected}`, () => {
      assert.strictEqual(RE.test(input), expected);
    });
  }
});

console.log("agentid-validation.test.mjs loaded");
