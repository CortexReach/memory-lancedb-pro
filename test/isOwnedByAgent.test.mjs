// isOwnedByAgent unit tests — Issue #448 fix verification
import { describe, it } from "node:test";
import assert from "node:assert";

// From reflection-store.ts: isOwnedByAgent function for isolated testing
function isOwnedByAgent(metadata, agentId) {
  const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";

  const itemKind = metadata.itemKind;

  // derived: no main fallback, empty owner -> completely invisible
  if (itemKind === "derived") {
    if (!owner) return false;
    return owner === agentId;
  }

  // invariant / legacy / mapped: maintain original main fallback
  if (!owner) return true;
  return owner === agentId || owner === "main";
}

describe("isOwnedByAgent — derived ownership fix (Issue #448)", () => {
  describe("itemKind === 'derived'", () => {
    it("main's derived -> main visible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "main" }, "main"), true);
    });
    it("main's derived -> sub-agent invisible (core bug fix)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "main" }, "sub-agent-A"), false);
    });
    it("agent-x's derived -> agent-x visible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "agent-x" }, "agent-x"), true);
    });
    it("agent-x's derived -> agent-y invisible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "agent-x" }, "agent-y"), false);
    });
    it("derived + empty owner -> completely invisible (guard)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "" }, "main"), false);
      assert.strictEqual(isOwnedByAgent({ itemKind: "derived", agentId: "" }, "sub-agent"), false);
    });
  });

  describe("itemKind === 'invariant' (maintain fallback)", () => {
    it("main's invariant -> sub-agent visible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "invariant", agentId: "main" }, "sub-agent-A"), true);
    });
    it("agent-x's invariant -> agent-x visible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "invariant", agentId: "agent-x" }, "agent-x"), true);
    });
    it("agent-x's invariant -> agent-y invisible", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "invariant", agentId: "agent-x" }, "agent-y"), false);
    });
  });

  describe("legacy / mapped (no itemKind, maintain fallback)", () => {
    it("main legacy -> sub-agent visible", () => {
      assert.strictEqual(isOwnedByAgent({ agentId: "main" }, "sub-agent-A"), true);
    });
    it("agent-x legacy -> agent-x visible", () => {
      assert.strictEqual(isOwnedByAgent({ agentId: "agent-x" }, "agent-x"), true);
    });
    it("agent-x legacy -> agent-y invisible", () => {
      assert.strictEqual(isOwnedByAgent({ agentId: "agent-x" }, "agent-y"), false);
    });
  });
});