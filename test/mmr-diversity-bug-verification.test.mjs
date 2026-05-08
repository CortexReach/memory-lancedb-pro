/**
 * PR #769 Bug Verification Tests
 * 
 * These tests verify potential issues with the PR #769 fix
 * If tests fail, it means the bug exists
 * 
 * Run: node --test test/mmr-diversity-bug-verification.test.mjs
 */

import assert from "node:assert";
import { describe, it } from "node:test";

/**
 * New applyMMRDiversity (after PR #769 fix)
 */
function applyMMRDiversity_NEW(results, similarityThreshold = 0.85) {
  if (results.length <= 1) return results;

  // Pre-convert all vectors (optimization)
  const vectors = results.map((r) => {
    const v = r.entry.vector;
    return v?.length ? Array.from(v) : null;
  });

  // Map lookup (optimization)
  const idToIdx = new Map(results.map((r, i) => [r.entry.id, i]));

  const selected = [];
  const deferred = [];

  for (let i = 0; i < results.length; i++) {
    const candidate = results[i];
    const cVec = vectors[i];
    
    // OPTIMIZATION: direct push without similarity check
    if (!cVec) {
      selected.push(candidate);
      continue;
    }

    const tooSimilar = selected.some((s) => {
      const sVec = vectors[idToIdx.get(s.entry.id) ?? -1];
      if (!sVec) return false;
      const sim = cosineSimilarity(sVec, cVec);
      return sim > similarityThreshold;
    });

    if (tooSimilar) {
      deferred.push(candidate);
    } else {
      selected.push(candidate);
    }
  }

  return [...selected, ...deferred];
}

/**
 * Old applyMMRDiversity (before PR #769 fix - original)
 */
function applyMMRDiversity_OLD(results, similarityThreshold = 0.85) {
  if (results.length <= 1) return results;

  const selected = [];
  const deferred = [];

  for (const candidate of results) {
    const tooSimilar = selected.some((s) => {
      const sVec = s.entry.vector;
      const cVec = candidate.entry.vector;
      
      // ORIGINAL: both must have vectors to compare
      if (!sVec?.length || !cVec?.length) return false;
      
      const sArr = Array.from(sVec);
      const cArr = Array.from(cVec);
      const sim = cosineSimilarity(sArr, cArr);
      return sim > similarityThreshold;
    });

    if (tooSimilar) {
      deferred.push(candidate);
    } else {
      selected.push(candidate);
    }
  }

  return [...selected, ...deferred];
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================
// Bug Verification Tests
// ============================================================

describe("PR #769 Bug Verification Tests", () => {
  
  // ----------------------------------------------------------
  // Issue 1: Non-vector items behavior difference
  // ----------------------------------------------------------
  describe("Issue 1: Non-vector items direct push", () => {
    it("CASE: Multiple null vector items in a row", () => {
      const results = [
        { entry: { id: "n1", text: "no vector 1", vector: null } },
        { entry: { id: "n2", text: "no vector 2", vector: null } },
        { entry: { id: "n3", text: "no vector 3", vector: null } },
      ];

      const newResult = applyMMRDiversity_NEW(results, 0.85);
      
      assert.strictEqual(newResult.length, 3, "All null vectors should be selected");
      assert.strictEqual(newResult[0].entry.id, "n1");
      assert.strictEqual(newResult[1].entry.id, "n2");
      assert.strictEqual(newResult[2].entry.id, "n3");
    });

    it("CASE: First has vector, second null - order test", () => {
      const results = [
        { entry: { id: "v1", text: "has vector", vector: [1, 0, 0] } },
        { entry: { id: "n1", text: "no vector", vector: null } },
        { entry: { id: "v2", text: "another vector", vector: [0, 1, 0] } },
      ];

      const newResult = applyMMRDiversity_NEW(results, 0.85);
      
      console.log("Order:", newResult.map(r => r.entry.id).join(", "));
      assert.strictEqual(newResult.length, 3);
    });

    it("CASE: Mixed vectors - OLD vs NEW comparison", () => {
      const results = [
        { entry: { id: "v1", text: "vector 1", vector: [1, 0, 0] } },
        { entry: { id: "n1", text: "no vector", vector: null } },
        { entry: { id: "v2", text: "vector 2", vector: [0.9, 0.1, 0] },
      ];

      const oldResult = applyMMRDiversity_OLD(results, 0.85);
      const newResult = applyMMRDiversity_NEW(results, 0.85);

      console.log("OLD order:", oldResult.map(r => r.entry.id).join(", "));
      console.log("NEW order:", newResult.map(r => r.entry.id).join(", "));
      
      const oldIds = oldResult.map(r => r.entry.id).join(",");
      const newIds = newResult.map(r => r.entry.id).join(",");
      
      assert.strictEqual(
        oldIds, 
        newIds, 
        "OLD and NEW should produce same order"
      );
    });
  });

  // ----------------------------------------------------------
  // Issue 2: Map lookup fallback to -1
  // ----------------------------------------------------------
  describe("Issue 2: Map lookup fallback", () => {
    it("CASE: Non-existent ID returns undefined", () => {
      const idToIdx = new Map([["exist", 0]]);

      const result = idToIdx.get("notexist");
      assert.strictEqual(result, undefined, "Non-existent key should return undefined");

      const withFallback = idToIdx.get("notexist") ?? -1;
      assert.strictEqual(withFallback, -1, "Fallback should be -1");
    });

    it("CASE: vectors[-1] should be undefined", () => {
      const vectors = [1, 2, 3];
      
      assert.strictEqual(vectors[-1], undefined, "arrays[-1] should be undefined");
      assert.strictEqual(!vectors[-1], true, "undefined is falsy");
    });

    it("CASE: Non-existent ID should handle safely", () => {
      const results = [
        { entry: { id: "a", text: "a", vector: [1, 0, 0] } },
        { entry: { id: "b", text: "b", vector: [0, 1, 0] },
      ];
      
      const idToIdx = new Map(results.map((r, i) => [r.entry.id, i]));
      const vectors = results.map(r => r.entry.vector?.length ? Array.from(r.entry.vector) : null);
      
      const sVec = vectors[idToIdx.get("NOT_EXIST") ?? -1];
      
      assert.strictEqual(sVec, undefined, "Missing ID should return undefined");
      assert.strictEqual(!sVec, true, "undefined is falsy");
    });
  });

  // ----------------------------------------------------------
  // Issue 3: Arrow Vector / ArrayLike types
  // ----------------------------------------------------------
  describe("Issue 3: Arrow Vector type handling", () => {
    it("CASE: Float32Array has length property", () => {
      const f32 = new Float32Array([1, 2, 3]);
      assert.strictEqual(f32.length, 3, "Float32Array has length");
      
      const arr = Array.from(f32);
      assert.deepEqual(arr, [1, 2, 3]);
    });

    it("CASE: Empty length should be treated as no vector", () => {
      const emptyVector = { length: 0 };
      
      const v = emptyVector;
      const converted = v?.length ? Array.from(v) : null;
      
      assert.strictEqual(converted, null, "length=0 should convert to null");
    });

    it("CASE: No length property object", () => {
      const noLengthVector = { 0: 1, 1: 2, 2: 3 };
      
      assert.strictEqual(noLengthVector.length, undefined, "No length property");
    });

    it("CASE: undefined vs null vector", () => {
      const undefinedVec = undefined;
      const nullVec = null;
      
      assert.strictEqual(!undefinedVec, true);
      assert.strictEqual(!nullVec, true);
      
      assert.strictEqual(undefinedVec?.length, undefined);
      assert.strictEqual(nullVec?.length, undefined);
    });
  });

  // ----------------------------------------------------------
  // Issue 4: Vector dimension mismatch
  // ----------------------------------------------------------
  describe("Issue 4: Vector dimension mismatch", () => {
    it("CASE: Different dimensions", () => {
      const v1 = [1, 0, 0];
      const v2 = [1, 0];
      
      const sim = cosineSimilarity(v1, v2);
      
      assert.strictEqual(sim, 0, "Different dimensions should return 0");
    });

    it("CASE: NaN vector", () => {
      const nanVec = [1, NaN, 0];
      const normalVec = [1, 0, 0];
      
      const sim = cosineSimilarity(nanVec, normalVec);
      console.log("NaN similarity:", sim);
    });
  });

  // ----------------------------------------------------------
  // Issue 5: Edge cases
  // ----------------------------------------------------------
  describe("Issue 5: Edge cases", () => {
    it("CASE: Empty array", () => {
      const result = applyMMRDiversity_NEW([], 0.85);
      assert.strictEqual(result.length, 0);
    });

    it("CASE: Single item", () => {
      const result = applyMMRDiversity_NEW([
        { entry: { id: "only", text: "only", vector: [1, 0, 0] } }
      ], 0.85);
      assert.strictEqual(result.length, 1);
    });

    it("CASE: All highly similar", () => {
      const results = [
        { entry: { id: "v1", text: "v1", vector: [1, 0, 0] } },
        { entry: { id: "v2", text: "v2", vector: [0.99, 0.01, 0] },
        { entry: { id: "v3", text: "v3", vector: [0.98, 0.02, 0] },
      ];

      const newResult = applyMMRDiversity_NEW(results, 0.85);
      
      console.log("All similar result:", newResult.map(r => r.entry.id));
      
      assert.strictEqual(newResult[0].entry.id, "v1");
    });

    it("CASE: All diverse", () => {
      const results = [
        { entry: { id: "x", text: "x", vector: [1, 0, 0] } },
        { entry: { id: "y", text: "y", vector: [0, 1, 0] } },
        { entry: { id: "z", text: "z", vector: [0, 0, 1] } },
      ];

      const newResult = applyMMRDiversity_NEW(results, 0.85);
      
      assert.strictEqual(newResult.length, 3, "All should be selected");
    });

    it("CASE: Duplicate IDs - will cause issues", () => {
      const results = [
        { entry: { id: "dup", text: "1", vector: [1, 0, 0] } },
        { entry: { id: "dup", text: "2", vector: [0, 1, 0] },
      ];

      const idToIdx = new Map(results.map((r, i) => [r.entry.id, i]));
      
      console.log("Map size:", idToIdx.size);
      console.log("Map get dup:", idToIdx.get("dup"));
      
      assert.strictEqual(idToIdx.size, 1, "Duplicate IDs only keep one");
    });
  });
});

// ============================================================
// Performance comparison tests
// ============================================================

describe("Performance comparison", () => {
  it("OLD vs NEW performance (n=50)", () => {
    const n = 50;
    const results = Array.from({ length: n }, (_, i) => ({
      entry: { id: `m${i}`, text: `result ${i}`, vector: [Math.random(), Math.random(), Math.random()] },
    }));

    const oldStart = performance.now();
    const oldResult = applyMMRDiversity_OLD(results, 0.85);
    const oldTime = performance.now() - oldStart;

    const newStart = performance.now();
    const newResult = applyMMRDiversity_NEW(results, 0.85);
    const newTime = performance.now() - newStart;

    console.log(`OLD: ${oldTime.toFixed(2)}ms, NEW: ${newTime.toFixed(2)}ms`);
    console.log(`Speedup: ${(oldTime / newTime).toFixed(2)}x`);

    assert.ok(true);
  });

  it("OLD vs NEW performance (n=100)", () => {
    const n = 100;
    const results = Array.from({ length: n }, (_, i) => ({
      entry: { id: `m${i}`, text: `result ${i}`, vector: [Math.random(), Math.random(), Math.random()] },
    }));

    const oldStart = performance.now();
    applyMMRDiversity_OLD(results, 0.85);
    const oldTime = performance.now() - oldStart;

    const newStart = performance.now();
    applyMMRDiversity_NEW(results, 0.85);
    const newTime = performance.now() - newStart;

    console.log(`OLD: ${oldTime.toFixed(2)}ms, NEW: ${newTime.toFixed(2)}ms`);
    console.log(`Speedup: ${(oldTime / newTime).toFixed(2)}x`);
  });
});