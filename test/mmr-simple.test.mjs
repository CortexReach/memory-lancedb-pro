/**
 * PR #769 Bug Verification Tests - Simplified
 */

import assert from "node:assert";
import { describe, it } from "node:test";

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

function applyMMRDiversity_NEW(results, similarityThreshold) {
  similarityThreshold = similarityThreshold || 0.85;
  if (results.length <= 1) return results;
  const vectors = results.map(function(r) {
    const v = r.entry.vector;
    return v && v.length ? Array.from(v) : null;
  });
  const idToIdx = new Map(results.map(function(r, i) {
    return [r.entry.id, i];
  }));
  const selected = [];
  const deferred = [];
  for (let i = 0; i < results.length; i++) {
    const candidate = results[i];
    const cVec = vectors[i];
    if (!cVec) {
      selected.push(candidate);
      continue;
    }
    const tooSimilar = selected.some(function(s) {
      const sVec = vectors[idToIdx.get(s.entry.id) || -1];
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
  return selected.concat(deferred);
}

function applyMMRDiversity_OLD(results, similarityThreshold) {
  similarityThreshold = similarityThreshold || 0.85;
  if (results.length <= 1) return results;
  const selected = [];
  const deferred = [];
  for (let i = 0; i < results.length; i++) {
    const candidate = results[i];
    const tooSimilar = selected.some(function(s) {
      const sVec = s.entry.vector;
      const cVec = candidate.entry.vector;
      if (!sVec || !sVec.length || !cVec || !cVec.length) return false;
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
  return selected.concat(deferred);
}

describe("PR #769 Tests", function() {
  it("null vectors should be selected", function() {
    var results = [
      { entry: { id: "n1", text: "no vector", vector: null } },
      { entry: { id: "n2", text: "no vector", vector: null } }
    ];
    var result = applyMMRDiversity_NEW(results, 0.85);
    assert.strictEqual(result.length, 2);
  });

  it("mixed vectors OLD vs NEW should match", function() {
    var results = [
      { entry: { id: "v1", text: "v1", vector: [1, 0, 0] } },
      { entry: { id: "n1", text: "no vector", vector: null } },
      { entry: { id: "v2", text: "v2", vector: [0.9, 0.1, 0] }
    ];
    var oldResult = applyMMRDiversity_OLD(results, 0.85);
    var newResult = applyMMRDiversity_NEW(results, 0.85);
    var oldIds = oldResult.map(function(r) { return r.entry.id; }).join(",");
    var newIds = newResult.map(function(r) { return r.entry.id; }).join(",");
    console.log("OLD: " + oldIds + ", NEW: " + newIds);
    assert.strictEqual(oldIds, newIds);
  });

  it("empty array", function() {
    var result = applyMMRDiversity_NEW([], 0.85);
    assert.strictEqual(result.length, 0);
  });

  it("single item", function() {
    var result = applyMMRDiversity_NEW([
      { entry: { id: "only", text: "only", vector: [1, 0, 0] } }
    ], 0.85);
    assert.strictEqual(result.length, 1);
  });

  it("perf n=50", function() {
    var results = [];
    for (var i = 0; i < 50; i++) {
      results.push({
        entry: { id: "m" + i, text: "r" + i, vector: [Math.random(), Math.random(), Math.random()] }
      });
    }
    var oldStart = performance.now();
    applyMMRDiversity_OLD(results, 0.85);
    var oldTime = performance.now() - oldStart;
    var newStart = performance.now();
    applyMMRDiversity_NEW(results, 0.85);
    var newTime = performance.now() - newStart;
    console.log("OLD: " + oldTime.toFixed(2) + "ms, NEW: " + newTime.toFixed(2) + "ms, Speedup: " + (oldTime / newTime).toFixed(2) + "x");
  });

  it("perf n=100", function() {
    var results = [];
    for (var i = 0; i < 100; i++) {
      results.push({
        entry: { id: "m" + i, text: "r" + i, vector: [Math.random(), Math.random(), Math.random()] }
      });
    }
    var oldStart = performance.now();
    applyMMRDiversity_OLD(results, 0.85);
    var oldTime = performance.now() - oldStart;
    var newStart = performance.now();
    applyMMRDiversity_NEW(results, 0.85);
    var newTime = performance.now() - newStart;
    console.log("OLD: " + oldTime.toFixed(2) + "ms, NEW: " + newTime.toFixed(2) + "ms, Speedup: " + (oldTime / newTime).toFixed(2) + "x");
  });
});