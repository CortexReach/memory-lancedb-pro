import { describe, it } from "node:test";
import assert from "node:assert";

describe("retrieval metrics", () => {
  it("recallAtK should compute correctly", async () => {
    const { recallAtK } = await import("../benchmark/metrics/retrieval-metrics.ts");
    const retrieved = ["a", "b", "c", "d", "e"];
    const relevant = ["a", "c", "f"];
    assert.strictEqual(recallAtK(retrieved, relevant, 5), 2 / 3);
    assert.strictEqual(recallAtK(retrieved, relevant, 1), 1 / 3);
  });

  it("mrr should compute correctly", async () => {
    const { mrr } = await import("../benchmark/metrics/retrieval-metrics.ts");
    assert.strictEqual(mrr(["a", "b"], ["a"]), 1.0);
    assert.strictEqual(mrr(["x", "y", "a"], ["a"]), 1 / 3);
    assert.strictEqual(mrr(["x", "y"], ["a"]), 0);
  });

  it("ndcgAtK perfect ranking should be 1.0", async () => {
    const { ndcgAtK } = await import("../benchmark/metrics/retrieval-metrics.ts");
    assert.strictEqual(ndcgAtK(["a", "b", "c"], ["a", "b", "c"], 3), 1.0);
  });

  it("computePercentiles should compute p50/p95/p99", async () => {
    const { computePercentiles } = await import("../benchmark/metrics/performance.ts");
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = computePercentiles(values);
    assert.strictEqual(p.p50, 50);
    assert.strictEqual(p.p95, 95);
    assert.strictEqual(p.p99, 99);
  });

  it("computePercentiles with empty array should return zeros", async () => {
    const { computePercentiles } = await import("../benchmark/metrics/performance.ts");
    const p = computePercentiles([]);
    assert.strictEqual(p.p50, 0);
    assert.strictEqual(p.mean, 0);
  });
});
