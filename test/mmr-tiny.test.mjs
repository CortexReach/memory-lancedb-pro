import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryRetriever } = jiti("../src/retriever.ts");

// ============================================================================
// Test helpers
// ============================================================================

function makeRetriever(results = []) {
  const entriesMap = new Map(results.map((e) => [e.id, e]));
  const store = {
    hasFtsSupport: true,
    async bm25Search() { return []; },
    async vectorSearch() { return []; },
    async hasId(id) { return entriesMap.has(id); },
  };
  const embedder = { async embedQuery() { return new Array(384).fill(0.1); } };
  return new MemoryRetriever(store, embedder, {});
}

// ============================================================================
// applyMMRDiversity — production method tests
// ============================================================================

describe("applyMMRDiversity (production)", function () {
  // --------------------------------------------------------------------------
  // Basic edge cases
  // --------------------------------------------------------------------------

  it("empty returns empty", function () {
    const retriever = makeRetriever([]);
    const result = retriever.applyMMRDiversity([]);
    assert.strictEqual(result.length, 0);
  });

  it("single returns single", function () {
    const retriever = makeRetriever([]);
    const result = retriever.applyMMRDiversity([
      { entry: { id: "m1", text: "test", vector: [1, 0, 0] } }
    ]);
    assert.strictEqual(result.length, 1);
  });

  it("null vector items are always selected", function () {
    const retriever = makeRetriever([]);
    const result = retriever.applyMMRDiversity([
      { entry: { id: "n1", text: "no vec", vector: null } }
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].entry.id, "n1", "null-vector item must be returned");
  });

  it("undefined vector items are always selected", function () {
    const retriever = makeRetriever([]);
    const result = retriever.applyMMRDiversity([
      { entry: { id: "u1", text: "undefined vec" } }
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].entry.id, "u1", "undefined-vector item must be returned");
  });

  // --------------------------------------------------------------------------
  // Diversity filtering — NEW optimized path (unique IDs)
  // --------------------------------------------------------------------------

  it("orthogonal vectors all selected", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "x", text: "x", vector: [1, 0, 0] } },
      { entry: { id: "y", text: "y", vector: [0, 1, 0] } },
      { entry: { id: "z", text: "z", vector: [0, 0, 1] } }
    ];
    const result = retriever.applyMMRDiversity(results, 0.85);
    // All three orthogonal vectors should appear in selected portion (none deferred)
    assert.strictEqual(result.length, 3);
    const resultIds = result.map((r) => r.entry.id);
    assert.deepStrictEqual(resultIds, ["x", "y", "z"], "all orthogonal vectors selected in order");
  });

  it("identical vectors trigger deferral", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "a", text: "a", vector: [1, 0, 0] } },
      { entry: { id: "b", text: "b", vector: [1, 0, 0] } }
    ];
    const result = retriever.applyMMRDiversity(results, 0.85);
    // First should be selected; second deferred (identical → sim=1.0 > threshold)
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].entry.id, "a");
    assert.strictEqual(result[1].entry.id, "b");
  });

  it("mixed vectors with null — null items selected first", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "v1", text: "v1", vector: [1, 0, 0] } },
      { entry: { id: "n1", text: "no vector", vector: null } },
      { entry: { id: "v2", text: "v2", vector: [0.9, 0.1, 0] } }
    ];
    const result = retriever.applyMMRDiversity(results, 0.85);
    assert.strictEqual(result.length, 3);
    // n1 (null vector) should appear in selected portion (first 2)
    const selectedIds = result.slice(0, 2).map((r) => r.entry.id);
    assert.ok(selectedIds.includes("n1"), "null-vector item should be in first two");
  });

  it("similar vectors (sim > 0.85) are deferred", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "r1", text: "r1", vector: [1.0, 0.0, 0.0] } },
      { entry: { id: "r2", text: "r2", vector: [0.95, 0.05, 0.0] } }, // cos-sim(r1,r2) ≈ 0.998 > 0.85 → deferred
      { entry: { id: "r3", text: "r3", vector: [0.1, 0.0, 0.995] } }  // cos-sim(r1,r3) ≈ 0.1, cos-sim(r2,r3) ≈ 0.095 → selected
    ];
    const result = retriever.applyMMRDiversity(results, 0.85);
    assert.strictEqual(result.length, 3);
    // Expected: [r1(selected), r3(selected/orthogonal), r2(deferred/similar)]
    const resultIds = result.map((r) => r.entry.id);
    assert.deepStrictEqual(resultIds, ["r1", "r3", "r2"],
      "r1 and r3 (orthogonal to r1) selected; r2 (similar to r1) deferred last");
    // Explicitly verify r2 is NOT in the selected portion (first 2)
    const selectedIds = result.slice(0, 2).map((r) => r.entry.id);
    assert.ok(selectedIds.includes("r1"), "r1 (first/anchor) must be selected");
    assert.ok(selectedIds.includes("r3"), "r3 (orthogonal to r1) must be selected");
    assert.strictEqual(selectedIds.includes("r2"), false, "r2 must NOT be in selected portion");
    // Verify r2 IS in the deferred portion (last 1)
    const deferredIds = result.slice(2).map((r) => r.entry.id);
    assert.deepStrictEqual(deferredIds, ["r2"], "r2 (similar to r1) must be deferred last");
  });

  // --------------------------------------------------------------------------
  // Fallback path — duplicate IDs trigger applyMMRDiversity_Fallback
  // --------------------------------------------------------------------------

  it("duplicate IDs trigger fallback path", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "dup", text: "first", vector: [1, 0, 0] } },
      { entry: { id: "other", text: "other", vector: [0, 1, 0] } },
      { entry: { id: "dup", text: "second", vector: [0, 0, 1] } }
    ];
    // Should not throw — fallback handles duplicate IDs gracefully
    const result = retriever.applyMMRDiversity(results, 0.85);
    assert.strictEqual(result.length, 3);
  });

  it("all duplicate IDs — fallback handles gracefully", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "same", text: "a", vector: [1, 0, 0] } },
      { entry: { id: "same", text: "b", vector: [0, 1, 0] } },
      { entry: { id: "same", text: "c", vector: null } }
    ];
    const result = retriever.applyMMRDiversity(results, 0.85);
    assert.strictEqual(result.length, 3);
  });

  // --------------------------------------------------------------------------
  // Threshold boundary
  // --------------------------------------------------------------------------

  it("threshold 0.9 defers only very similar pairs", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "t1", text: "t1", vector: [1.0, 0.0, 0.0] } },
      { entry: { id: "t2", text: "t2", vector: [0.9, 0.1, 0.0] } } // cos-sim ≈ 0.995 > 0.9
    ];
    const result = retriever.applyMMRDiversity(results, 0.9);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].entry.id, "t1");
    assert.strictEqual(result[1].entry.id, "t2"); // deferred
  });

  it("threshold 1.0 keeps everything (no deferral)", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "c1", text: "c1", vector: [1, 0, 0] } },
      { entry: { id: "c2", text: "c2", vector: [1, 0, 0] } } // identical
    ];
    const result = retriever.applyMMRDiversity(results, 1.0);
    assert.strictEqual(result.length, 2);
  });

  // --------------------------------------------------------------------------
  // Cross-validation: optimized vs Fallback produce identical results
  // --------------------------------------------------------------------------

  it("optimized path matches Fallback for diverse inputs (unique IDs)", function () {
    const retriever = makeRetriever([]);
    // Diverse set: all orthogonal — none deferred, original order preserved
    const results = [
      { entry: { id: "a", text: "a", vector: [1.0, 0.0, 0.0] } },
      { entry: { id: "b", text: "b", vector: [0.0, 1.0, 0.0] } },
      { entry: { id: "c", text: "c", vector: [0.0, 0.0, 1.0] } },
      { entry: { id: "d", text: "d", vector: [0.5, 0.5, 0.0] } }, // cos(a,d) = 0.707 < 0.85 → selected
    ];
    const optimized = retriever.applyMMRDiversity(results, 0.85);
    // Call Fallback directly (unique IDs → should behave identically)
    const fallback = retriever.applyMMRDiversity_Fallback(results, 0.85);
    const optIds = optimized.map((r) => r.entry.id);
    const fbIds = fallback.map((r) => r.entry.id);
    assert.deepStrictEqual(optIds, fbIds,
      "optimized path and Fallback must produce identical results for unique-ID diverse inputs");
  });

  it("optimized path matches Fallback for similar-inputs (unique IDs)", function () {
    const retriever = makeRetriever([]);
    // All similar to r1 — r2 and r3 should be deferred in both paths
    const results = [
      { entry: { id: "r1", text: "r1", vector: [1.0, 0.0, 0.0] } },
      { entry: { id: "r2", text: "r2", vector: [0.98, 0.02, 0.0] } }, // cos-sim ≈ 0.999 > 0.85
      { entry: { id: "r3", text: "r3", vector: [0.99, 0.01, 0.0] } }, // cos-sim ≈ 0.999 > 0.85
    ];
    const optimized = retriever.applyMMRDiversity(results, 0.85);
    const fallback = retriever.applyMMRDiversity_Fallback(results, 0.85);
    const optIds = optimized.map((r) => r.entry.id);
    const fbIds = fallback.map((r) => r.entry.id);
    assert.deepStrictEqual(optIds, fbIds,
      "optimized path and Fallback must produce identical results for similar inputs");
    assert.deepStrictEqual(optIds, ["r1", "r2", "r3"],
      "r1 selected; r2 and r3 deferred (all similar to r1)");
  });

  it("optimized path routes to Fallback for duplicate IDs", function () {
    const retriever = makeRetriever([]);
    const results = [
      { entry: { id: "dup", text: "first", vector: [1.0, 0.0, 0.0] } },
      { entry: { id: "unique", text: "unique", vector: [0.0, 1.0, 0.0] } },
      { entry: { id: "dup", text: "second", vector: [0.0, 0.0, 1.0] } },
    ];
    // applyMMRDiversity should internally route to Fallback (no throw)
    const result = retriever.applyMMRDiversity(results, 0.85);
    assert.strictEqual(result.length, 3);
    // Fallback result must be deterministic
    const fallback = retriever.applyMMRDiversity_Fallback(results, 0.85);
    const resultIds = result.map((r) => r.entry.id);
    const fbIds = fallback.map((r) => r.entry.id);
    assert.deepStrictEqual(resultIds, fbIds,
      "optimized path with dup IDs must match Fallback output exactly");
  });

  // --------------------------------------------------------------------------
  // Performance (sanity — ensure no crashes on larger inputs)
  // --------------------------------------------------------------------------

  it("n=50 completes without error", function () {
    const retriever = makeRetriever([]);
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push({
        entry: {
          id: "m" + i,
          text: "r" + i,
          vector: [Math.random(), Math.random(), Math.random()]
        }
      });
    }
    const start = performance.now();
    const result = retriever.applyMMRDiversity(results, 0.85);
    const elapsed = performance.now() - start;
    assert.strictEqual(result.length, 50);
    assert.ok(elapsed < 1000, `n=50 took ${elapsed.toFixed(1)}ms — should be < 1s`);
  });

  it("n=100 completes without error", function () {
    const retriever = makeRetriever([]);
    const results = [];
    for (let i = 0; i < 100; i++) {
      results.push({
        entry: {
          id: "m" + i,
          text: "r" + i,
          vector: [Math.random(), Math.random(), Math.random()]
        }
      });
    }
    const start = performance.now();
    const result = retriever.applyMMRDiversity(results, 0.85);
    const elapsed = performance.now() - start;
    assert.strictEqual(result.length, 100);
    assert.ok(elapsed < 2000, `n=100 took ${elapsed.toFixed(1)}ms — should be < 2s`);
  });
});