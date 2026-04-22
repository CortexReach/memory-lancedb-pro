/**
 * agentid-validation.test.mjs
 *
 * Unit tests for the exported guard functions:
 *   - isInvalidAgentIdFormat(): prevents hooks from running when agentId is invalid
 *   - isAgentOrSessionExcluded(): checks exclusion patterns for agent/session
 *
 * Run: node --test test/agentid-validation.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jitiInstance = jitiFactory(import.meta.url, {
  interopDefault: true,
});

// Load the plugin — both functions are now exported from index.ts
const indexModule = jitiInstance(path.join(testDir, "..", "index.ts"));

const isInvalidAgentIdFormat = indexModule.isInvalidAgentIdFormat;
const isAgentOrSessionExcluded = indexModule.isAgentOrSessionExcluded;

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------
const EMPTY_SET = new Set();

/** @param {...string} ids */
function makeSet(...ids) {
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// isInvalidAgentIdFormat unit tests
// ---------------------------------------------------------------------------
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
      assert.strictEqual(isInvalidAgentIdFormat("999999999", validAgents), true);
    });
    it("returns true when agentId is NOT in declaredAgents (unknown string)", () => {
      assert.strictEqual(isInvalidAgentIdFormat("unknown-agent-xyz", validAgents), true);
    });
    it("returns false when declaredAgents is empty (no restrictions)", () => {
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
      assert.strictEqual(isInvalidAgentIdFormat("   ", makeSet()), false);
    });
  });
});

// ---------------------------------------------------------------------------
// isAgentOrSessionExcluded unit tests
// ---------------------------------------------------------------------------
describe("isAgentOrSessionExcluded", () => {
  // Empty / invalid patterns
  describe("Empty patterns — no exclusion", () => {
    it("returns false when patterns is empty array", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, []), false);
    });
    it("returns false when patterns is undefined", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, undefined), false);
    });
    it("returns false when patterns is not an array", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, "main"), false);
    });
  });

  // Guard against null/undefined agentId (H1 fix)
  describe("Guard: null/undefined agentId", () => {
    it("returns false when agentId is undefined", () => {
      assert.strictEqual(isAgentOrSessionExcluded(undefined, undefined, ["main"]), false);
    });
    it("returns false when agentId is null", () => {
      assert.strictEqual(isAgentOrSessionExcluded(null, undefined, ["main"]), false);
    });
    it("returns false when agentId is empty string", () => {
      assert.strictEqual(isAgentOrSessionExcluded("", undefined, ["main"]), false);
    });
    it("returns false when agentId is whitespace-only", () => {
      assert.strictEqual(isAgentOrSessionExcluded("  ", undefined, ["main"]), false);
    });
  });

  // Exact match
  describe("Exact match", () => {
    it("returns true when agentId exactly matches a pattern", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, ["main"]), true);
    });
    it("returns false when agentId does not match any pattern", () => {
      assert.strictEqual(isAgentOrSessionExcluded("other-agent", undefined, ["main"]), false);
    });
    it("returns true when agentId matches one of multiple patterns", () => {
      assert.strictEqual(isAgentOrSessionExcluded("pi-agent", undefined, ["main", "pi-agent", "dc"]), true);
    });
  });

  // Wildcard prefix match (pattern ends with "-")
  describe("Wildcard prefix match (pattern ends with \"-\")", () => {
    it("'pi-' matches 'pi-agent' but NOT 'pilot'", () => {
      assert.strictEqual(isAgentOrSessionExcluded("pi-agent", undefined, ["pi-"]), true);
      assert.strictEqual(isAgentOrSessionExcluded("pilot", undefined, ["pi-"]), false);
    });
    it("'z-' matches 'z-fundamental' but NOT 'zfoo'", () => {
      assert.strictEqual(isAgentOrSessionExcluded("z-fundamental", undefined, ["z-"]), true);
      assert.strictEqual(isAgentOrSessionExcluded("zfoo", undefined, ["z-"]), false);
    });
    it("'dc-' matches 'dc-channel--xxx' but NOT 'dca-agent'", () => {
      assert.strictEqual(isAgentOrSessionExcluded("dc-channel--1476858065914695741", undefined, ["dc-"]), true);
      assert.strictEqual(isAgentOrSessionExcluded("dca-agent", undefined, ["dc-"]), false);
    });
  });

  // temp:* internal session guard
  describe("temp:* — internal session guard", () => {
    it("returns true for temp:* when sessionKey starts with 'temp:memory-reflection'", () => {
      assert.strictEqual(
        isAgentOrSessionExcluded("main", "temp:memory-reflection/session-123", ["temp:*"]),
        true,
      );
    });
    it("returns false for temp:* when sessionKey is NOT a memory-reflection session", () => {
      assert.strictEqual(
        isAgentOrSessionExcluded("main", "agent:main:session-123", ["temp:*"]),
        false,
      );
    });
    it("returns false for temp:* when sessionKey is undefined", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, ["temp:*"]), false);
    });
  });

  // Combined patterns
  describe("Combined patterns", () => {
    it("returns true if any pattern matches", () => {
      // main matches via exact; pi- matches via prefix; temp:* does not
      assert.strictEqual(
        isAgentOrSessionExcluded("pi-agent", "agent:main", ["main", "pi-", "temp:*"]),
        true,
      );
    });
    it("returns false when no pattern matches", () => {
      assert.strictEqual(
        isAgentOrSessionExcluded("other", "agent:main", ["main", "pi-", "temp:*"]),
        false,
      );
    });
  });

  // Whitespace handling
  describe("Whitespace handling", () => {
    it("trims agentId before matching", () => {
      assert.strictEqual(isAgentOrSessionExcluded("  main  ", undefined, ["main"]), true);
    });
    it("ignores empty/whitespace-only patterns", () => {
      assert.strictEqual(isAgentOrSessionExcluded("main", undefined, ["", "  "]), false);
    });
  });
});

// ---------------------------------------------------------------------------
// declaredAgents Set construction (integration test)
// ---------------------------------------------------------------------------
describe("declaredAgents Set construction", () => {
  it("builds declaredAgents Set from openclaw.json agents.list id field", () => {
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
