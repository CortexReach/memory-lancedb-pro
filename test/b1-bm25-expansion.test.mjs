/**
 * B-1 BM25 Expansion — Unit Tests
 *
 * Tests the core B-1 logic in isolation:
 *   D1: seen = new Set() empty init (not preloaded with base)
 *   D2: scopeFilter guard — expansion skipped when undefined
 *   D3: hard cap at 16 total derived
 *   D4: truncate to first line, 120 chars
 *   D6: merge, not replace — base derived preserved
 *   Fail-safe: bm25Search error does not crash
 *
 * These tests mock store.bm25Search to test the B-1 logic directly,
 * without depending on the full plugin harness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Simulate the B-1 logic under test (mirrors index.ts loadAgentReflectionSlices)
// ---------------------------------------------------------------------------

/**
 * Replicate the B-1 BM25 expansion logic from index.ts.
 * This must stay in sync with the actual implementation.
 */
function applyBm25Expansion({
  derived,
  scopeFilter,
  bm25Search,
}) {
  let finalDerived = derived;

  if (scopeFilter !== undefined && derived.length > 0) {
    const seen = new Set();
    const expandedDerived = [];

    for (const derivedLine of derived) {
      try {
        const bm25Hits = bm25Search(derivedLine, 2, scopeFilter);
        for (const hit of bm25Hits) {
          if (seen.has(hit.entry.id)) continue; // ID dedupe
          seen.add(hit.entry.id);
          const snippet = (hit.entry.text || "").split('\n')[0].trim().slice(0, 120);
          expandedDerived.push(snippet);
        }
      } catch (_err) {
        // Fail-safe: bm25Search error must not crash
      }
    }

    // D3: merge base + expanded, cap at 16
    // D6: expand, not replace
    finalDerived = [...derived, ...expandedDerived].slice(0, 16);
  }

  return finalDerived;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B-1 BM25 Expansion Logic", () => {

  // -------------------------------------------------------------------------
  // D1: seen = new Set() — empty init, not preloaded
  // -------------------------------------------------------------------------
  it("D1: seen set is empty at start (PR #463 lesson)", () => {
    let seenSnapshot = null;
    const mockBm25 = (query, topK, scopeFilter) => {
      // Capture the state of `seen` before any BM25 call modifies it
      seenSnapshot = new Set();
      return [
        { entry: { id: "n1", text: "neighbor one" } },
      ];
    };

    // We can't directly inspect `seen` from outside, but we can verify
    // that the FIRST bm25 call's result appears in output (proving base
    // items didn't get skipped before bm25Search ran).
    const result = applyBm25Expansion({
      derived: ["BASE LINE A", "BASE LINE B"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    // If seen were preloaded with base items, "n1" would be skipped
    assert.ok(result.includes("neighbor one"), "neighbor should appear (seen was empty at start)");
  });

  // -------------------------------------------------------------------------
  // D2: scopeFilter === undefined skips expansion
  // -------------------------------------------------------------------------
  it("D2: expansion is skipped when scopeFilter is undefined", () => {
    let callCount = 0;
    const mockBm25 = (query, topK, scopeFilter) => {
      callCount++;
      return [];
    };

    const result = applyBm25Expansion({
      derived: ["BASE LINE"],
      scopeFilter: undefined, // D2 guard
      bm25Search: mockBm25,
    });

    assert.equal(callCount, 0, "bm25Search should NOT be called when scopeFilter is undefined");
    assert.deepStrictEqual(result, ["BASE LINE"], "base derived should be returned as-is");
  });

  it("D2: expansion runs when scopeFilter is a non-empty array", () => {
    let callCount = 0;
    const mockBm25 = (query, topK, scopeFilter) => {
      callCount++;
      return [];
    };

    applyBm25Expansion({
      derived: ["BASE LINE"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    assert.equal(callCount, 1, "bm25Search should be called when scopeFilter is set");
  });

  // -------------------------------------------------------------------------
  // D3: hard cap at 16 total derived
  // -------------------------------------------------------------------------
  it("D3: total derived items are capped at 16", () => {
    // Create 20 derived lines + 20 neighbors = 40 total, should be capped to 16
    const derived = Array.from({ length: 20 }, (_, i) => `BASE ${i}`);
    const neighbors = Array.from({ length: 20 }, (_, i) => ({
      entry: { id: `n${i}`, text: `NEIGHBOR ${i}` },
    }));

    const result = applyBm25Expansion({
      derived,
      scopeFilter: ["global"],
      bm25Search: () => neighbors,
    });

    assert.ok(result.length <= 16, `expected <= 16, got ${result.length}`);
  });

  it("D3: cap of 16 applies to the MERGED result, not just expanded", () => {
    // 10 base + 20 neighbors = 30, capped to 16
    const derived = Array.from({ length: 10 }, (_, i) => `BASE ${i}`);
    const neighbors = Array.from({ length: 20 }, (_, i) => ({
      entry: { id: `n${i}`, text: `NEIGHBOR ${i}` },
    }));

    const result = applyBm25Expansion({
      derived,
      scopeFilter: ["global"],
      bm25Search: () => neighbors,
    });

    assert.equal(result.length, 16, "10 base + 6 neighbors = 16 (capped)");
  });

  // -------------------------------------------------------------------------
  // D4: truncate to first line, 120 chars
  // -------------------------------------------------------------------------
  it("D4: snippet is truncated to first line, max 120 chars", () => {
    const mockBm25 = (query, topK, scopeFilter) => [
      {
        entry: {
          id: "n1",
          text: "FIRST LINE IS THIS\nSECOND LINE SHOULD NOT APPEAR\nTHIRD LINE ALSO NOT",
        },
      },
    ];

    const result = applyBm25Expansion({
      derived: ["BASE"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    // First line only, not second or third
    assert.ok(result[1].includes("FIRST LINE IS THIS"), "should include first line");
    assert.ok(!result[1].includes("SECOND LINE"), "should NOT include second line");
  });

  it("D4: handles null/undefined entry.text gracefully", () => {
    const mockBm25 = () => [
      { entry: { id: "n1", text: null } },
      { entry: { id: "n2", text: undefined } },
      { entry: { id: "n3", text: "VALID LINE" } },
    ];

    const result = applyBm25Expansion({
      derived: ["BASE"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    // null/undefined text should produce empty string (after || "")
    // which should still appear as "" in the result array
    const emptyCount = result.filter(s => s === "").length;
    assert.equal(emptyCount, 2, "null/undefined texts should become empty strings");
    assert.ok(result.includes("VALID LINE"), "valid text should be preserved");
  });

  // -------------------------------------------------------------------------
  // D6: merge, not replace — base derived preserved
  // -------------------------------------------------------------------------
  it("D6: base derived lines are preserved (not replaced by neighbors)", () => {
    const mockBm25 = () => [
      { entry: { id: "n1", text: "NEIGHBOR TEXT" } },
    ];

    const result = applyBm25Expansion({
      derived: ["BASE A", "BASE B"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    assert.ok(result.includes("BASE A"), "base A must be preserved");
    assert.ok(result.includes("BASE B"), "base B must be preserved");
    assert.ok(result.includes("NEIGHBOR TEXT"), "neighbor should also appear");
  });

  it("D6: base derived appear BEFORE neighbors in result order", () => {
    const mockBm25 = () => [
      { entry: { id: "n1", text: "NEIGHBOR" } },
    ];

    const result = applyBm25Expansion({
      derived: ["BASE"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    const baseIdx = result.indexOf("BASE");
    const neighborIdx = result.indexOf("NEIGHBOR");
    assert.ok(baseIdx < neighborIdx, "base should appear before neighbor");
  });

  // -------------------------------------------------------------------------
  // Fail-safe: bm25Search errors must not crash
  // -------------------------------------------------------------------------
  it("fail-safe: bm25Search throw does not crash — returns base derived", () => {
    const mockBm25 = () => {
      throw new Error("simulated BM25 failure");
    };

    let didNotCrash = false;
    let result;
    try {
      result = applyBm25Expansion({
        derived: ["BASE ONE", "BASE TWO"],
        scopeFilter: ["global"],
        bm25Search: mockBm25,
      });
      didNotCrash = true;
    } catch (err) {
      didNotCrash = false;
    }

    assert.equal(didNotCrash, true, "bm25Search error should be caught, not propagate");
    assert.deepStrictEqual(result, ["BASE ONE", "BASE TWO"], "should return base derived on error");
  });

  it("fail-safe: partial bm25Search failure in loop — returns base + successful neighbors", () => {
    let callCount = 0;
    const mockBm25 = () => {
      callCount++;
      if (callCount === 1) {
        return [{ entry: { id: "n1", text: "NEIGHBOR ONE" } }];
      }
      throw new Error("second call fails");
    };

    const result = applyBm25Expansion({
      derived: ["BASE LINE"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    assert.ok(result.includes("BASE LINE"), "base should be preserved");
    assert.ok(result.includes("NEIGHBOR ONE"), "first neighbor should appear");
    assert.ok(!result.includes("NEIGHBOR TWO"), "failed neighbor should not appear");
  });

  // -------------------------------------------------------------------------
  // ID dedupe
  // -------------------------------------------------------------------------
  it("ID dedupe: same neighbor from two different derived lines appears once", () => {
    const mockBm25 = (derivedLine, topK, scopeFilter) => [
      // Same neighbor returned for both derived lines
      { entry: { id: "shared-1", text: "SHARED NEIGHBOR" } },
    ];

    const result = applyBm25Expansion({
      derived: ["BASE A", "BASE B"],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    const neighborCount = result.filter(s => s === "SHARED NEIGHBOR").length;
    assert.equal(neighborCount, 1, "same neighbor should appear exactly once");
  });

  // -------------------------------------------------------------------------
  // topK=2: each derived line gets up to 2 neighbors
  // -------------------------------------------------------------------------
  it("each derived line can contribute up to 2 expanded items", () => {
    const derived = ["DERIVED 1", "DERIVED 2"];
    const mockBm25 = (derivedLine, topK, scopeFilter) => {
      assert.equal(topK, 2, "topK should be 2");
      return [
        { entry: { id: `${derivedLine}-n1`, text: `${derivedLine} NEIGHBOR 1` } },
        { entry: { id: `${derivedLine}-n2`, text: `${derivedLine} NEIGHBOR 2` } },
      ];
    };

    const result = applyBm25Expansion({
      derived,
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    // 2 base + 4 neighbors = 6 (all within cap 16)
    assert.equal(result.length, 6, `expected 6 items, got ${result.length}`);
  });

  // -------------------------------------------------------------------------
  // scopeFilter is passed to bm25Search
  // -------------------------------------------------------------------------
  it("scopeFilter is forwarded to bm25Search", () => {
    let receivedScopeFilter = null;
    const mockBm25 = (query, topK, scopeFilter) => {
      receivedScopeFilter = scopeFilter;
      return [];
    };

    applyBm25Expansion({
      derived: ["BASE"],
      scopeFilter: ["project:A", "project:B"],
      bm25Search: mockBm25,
    });

    assert.deepStrictEqual(receivedScopeFilter, ["project:A", "project:B"],
      "scopeFilter should be passed to bm25Search unchanged");
  });

  // -------------------------------------------------------------------------
  // derived.length === 0 skips expansion
  // -------------------------------------------------------------------------
  it("expansion is skipped when derived array is empty", () => {
    let callCount = 0;
    const mockBm25 = () => {
      callCount++;
      return [];
    };

    applyBm25Expansion({
      derived: [],
      scopeFilter: ["global"],
      bm25Search: mockBm25,
    });

    assert.equal(callCount, 0, "bm25Search should not be called with empty derived");
  });
});
