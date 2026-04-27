// isOwnedByAgent unit tests — Issue #448 fix verification
import { describe, it } from "node:test";
import assert from "node:assert";

// Import from production source — NOT a local copy
import { isOwnedByAgent } from "../src/reflection-store.ts";

describe("isOwnedByAgent — derived ownership fix (Issue #448)", () => {
  describe("itemKind === 'derived' (memory-reflection-item)", () => {
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

  describe("legacy / mapped (no itemKind — maintain fallback)", () => {
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

  describe("malformed itemKind (fail-closed)", () => {
    // When itemKind is not a string, it cannot be "derived" (typeof guard)
    // Falls through to fallback: empty owner -> true, owner-main -> true
    it("itemKind = null falls through to fallback (main -> sub visible)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: null, agentId: "main" }, "sub-agent-A"), true);
    });
    it("itemKind = undefined falls through to fallback (main -> sub visible)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: undefined, agentId: "main" }, "sub-agent-A"), true);
    });
    it("itemKind = number falls through to fallback (main -> sub visible)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: 42, agentId: "main" }, "sub-agent-A"), true);
    });
    it("itemKind = non-derived string falls through to fallback (main -> sub visible)", () => {
      assert.strictEqual(isOwnedByAgent({ itemKind: "weird-kind", agentId: "main" }, "sub-agent-A"), true);
    });
  });
});
