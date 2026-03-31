import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { batchDedup, createExtractionCostStats } = jiti(
  "../src/batch-dedup.ts",
);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a normalized unit vector with slight variation.
 * seed controls the angle: same seed = same direction = high cosine similarity.
 */
function makeVector(seed, dim = 128) {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(seed * (i + 1)) + Math.cos(seed * (i + 2));
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Create a vector very similar to a base vector (add small noise).
 */
function makeSimilarVector(base, noise = 0.01) {
  const vec = base.map((v) => v + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

// ============================================================================
// batchDedup tests
// ============================================================================

describe("batchDedup", () => {
  it("returns all indices when no duplicates", () => {
    const v1 = makeVector(1.0);
    const v2 = makeVector(5.0);
    const v3 = makeVector(10.0);

    const result = batchDedup(
      ["abstract A", "abstract B", "abstract C"],
      [v1, v2, v3],
      0.85,
    );

    assert.equal(result.inputCount, 3);
    assert.equal(result.outputCount, 3);
    assert.deepEqual(result.survivingIndices, [0, 1, 2]);
    assert.deepEqual(result.duplicateIndices, []);
  });

  it("marks similar candidates as duplicates", () => {
    const v1 = makeVector(1.0);
    const v2 = makeSimilarVector(v1, 0.001); // Very similar to v1
    const v3 = makeVector(10.0); // Very different

    const result = batchDedup(
      ["similar abstract 1", "similar abstract 2", "different abstract"],
      [v1, v2, v3],
      0.85,
    );

    assert.equal(result.inputCount, 3);
    assert.equal(result.outputCount, 2);
    assert.ok(result.survivingIndices.includes(0));
    assert.ok(result.survivingIndices.includes(2));
    assert.ok(result.duplicateIndices.includes(1));
  });

  it("keeps first of duplicate pair", () => {
    const v1 = makeVector(1.0);
    const v2 = makeSimilarVector(v1, 0.0001); // Nearly identical

    const result = batchDedup(
      ["abstract A", "abstract A (duplicate)"],
      [v1, v2],
      0.85,
    );

    assert.equal(result.outputCount, 1);
    assert.deepEqual(result.survivingIndices, [0]);
    assert.deepEqual(result.duplicateIndices, [1]);
  });

  it("handles single candidate", () => {
    const result = batchDedup(
      ["only abstract"],
      [makeVector(1.0)],
      0.85,
    );

    assert.equal(result.inputCount, 1);
    assert.equal(result.outputCount, 1);
    assert.deepEqual(result.survivingIndices, [0]);
    assert.deepEqual(result.duplicateIndices, []);
  });

  it("handles empty input", () => {
    const result = batchDedup([], [], 0.85);

    assert.equal(result.inputCount, 0);
    assert.equal(result.outputCount, 0);
    assert.deepEqual(result.survivingIndices, []);
    assert.deepEqual(result.duplicateIndices, []);
  });

  it("respects threshold: low threshold drops more", () => {
    const v1 = makeVector(1.0);
    const v2 = makeVector(1.3); // Somewhat similar
    const v3 = makeVector(10.0); // Very different

    const strictResult = batchDedup(
      ["a", "b", "c"],
      [v1, v2, v3],
      0.5, // Very low threshold - more aggressive dedup
    );

    const lenientResult = batchDedup(
      ["a", "b", "c"],
      [v1, v2, v3],
      0.99, // Very high threshold - almost no dedup
    );

    // Strict should drop more or equal candidates
    assert.ok(strictResult.outputCount <= lenientResult.outputCount);
  });

  it("handles empty/missing vectors gracefully", () => {
    const v1 = makeVector(1.0);

    const result = batchDedup(
      ["abstract A", "abstract B", "abstract C"],
      [v1, [], v1], // Second vector is empty
      0.85,
    );

    // Should not crash; candidates with empty vectors survive
    assert.ok(result.outputCount >= 1);
  });

  it("deduplicates multiple similar pairs correctly", () => {
    const v1 = makeVector(1.0);
    const v1dup = makeSimilarVector(v1, 0.0001);
    const v2 = makeVector(10.0);
    const v2dup = makeSimilarVector(v2, 0.0001);

    const result = batchDedup(
      ["topic A", "topic A copy", "topic B", "topic B copy"],
      [v1, v1dup, v2, v2dup],
      0.85,
    );

    assert.equal(result.inputCount, 4);
    assert.equal(result.outputCount, 2);
    assert.ok(result.survivingIndices.includes(0));
    assert.ok(result.survivingIndices.includes(2));
  });
});

// ============================================================================
// ExtractionCostStats tests
// ============================================================================

describe("ExtractionCostStats", () => {
  it("creates fresh stats with zero values", () => {
    const stats = createExtractionCostStats();
    assert.equal(stats.batchDeduped, 0);
    assert.equal(stats.durationMs, 0);
    assert.equal(stats.llmCalls, 0);
  });

  it("tracks batch dedup count", () => {
    const stats = createExtractionCostStats();
    stats.batchDeduped = 3;
    stats.durationMs = 1500;
    stats.llmCalls = 2;

    assert.equal(stats.batchDeduped, 3);
    assert.equal(stats.durationMs, 1500);
    assert.equal(stats.llmCalls, 2);
  });
});
