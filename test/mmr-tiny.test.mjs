import { describe, it } from "node:test";
import assert from "node:assert";

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function applyMMRDiversity_NEW(results, similarityThreshold) {
  similarityThreshold = similarityThreshold || 0.85;
  if (results.length <= 1) return results;
  var vectors = results.map(function(r) {
    var v = r.entry.vector;
    return v && v.length ? Array.from(v) : null;
  });
  var idToIdx = new Map(results.map(function(r, i) {
    return [r.entry.id, i];
  }));
  var selected = [];
  var deferred = [];
  for (var i = 0; i < results.length; i++) {
    var candidate = results[i];
    var cVec = vectors[i];
    if (!cVec) {
      selected.push(candidate);
      continue;
    }
    var tooSimilar = selected.some(function(s) {
      var sVec = vectors[idToIdx.get(s.entry.id) || -1];
      if (!sVec) return false;
      var sim = cosineSimilarity(sVec, cVec);
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
  var selected = [];
  var deferred = [];
  for (var i = 0; i < results.length; i++) {
    var candidate = results[i];
    var tooSimilar = selected.some(function(s) {
      var sVec = s.entry.vector;
      var cVec = candidate.entry.vector;
      if (!sVec || !sVec.length || !cVec || !cVec.length) return false;
      var sArr = Array.from(sVec);
      var cArr = Array.from(cVec);
      var sim = cosineSimilarity(sArr, cArr);
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

describe("applyMMRDiversity", function() {
  describe("NEW function", function() {
    it("empty returns empty", function() {
      var result = applyMMRDiversity_NEW([], 0.85);
      assert.strictEqual(result.length, 0);
    });

    it("single returns single", function() {
      var result = applyMMRDiversity_NEW([
        { entry: { id: "m1", text: "test", vector: [1, 0, 0] } }
      ], 0.85);
      assert.strictEqual(result.length, 1);
    });

    it("null vector items selected", function() {
      var result = applyMMRDiversity_NEW([
        { entry: { id: "n1", text: "no vec", vector: null } }
      ], 0.85);
      assert.strictEqual(result.length, 1);
    });
  });

  describe("OLD vs NEW comparison", function() {
    it("mixed vectors should match", function() {
      var results = [
        { entry: { id: "v1", text: "v1", vector: [1, 0, 0] } },
        { entry: { id: "n1", text: "no vector", vector: null } },
        { entry: { id: "v2", text: "v2", vector: [0.9, 0.1, 0] } }
      ];
      var oldResult = applyMMRDiversity_OLD(results, 0.85);
      var newResult = applyMMRDiversity_NEW(results, 0.85);
      
      var oldIds = oldResult.map(function(r) { return r.entry.id; }).join(",");
      var newIds = newResult.map(function(r) { return r.entry.id; }).join(",");
      
        assert.strictEqual(oldIds, newIds, "OLD and NEW should match");
    });

    it("all diverse vectors", function() {
      var results = [
        { entry: { id: "x", text: "x", vector: [1, 0, 0] } },
        { entry: { id: "y", text: "y", vector: [0, 1, 0] } },
        { entry: { id: "z", text: "z", vector: [0, 0, 1] } }
      ];
      var oldResult = applyMMRDiversity_OLD(results, 0.85);
      var newResult = applyMMRDiversity_NEW(results, 0.85);
      assert.strictEqual(oldResult.length, newResult.length);
    });
  });

  describe("performance", function() {
    it("n=50 performance", function() {
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
      });

    it("n=100 performance", function() {
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
      });
  });
});