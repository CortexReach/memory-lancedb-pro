import { describe, it } from "node:test";
import assert from "node:assert";

describe("end-to-end metrics", () => {
  it("tokenF1 exact match should be 1.0", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    assert.strictEqual(tokenF1("the cat sat", "the cat sat"), 1.0);
  });

  it("tokenF1 no overlap should be 0", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    assert.strictEqual(tokenF1("hello world", "foo bar"), 0);
  });

  it("tokenF1 partial overlap should be between 0 and 1", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    const score = tokenF1("the cat sat on the mat", "the cat is here");
    assert.ok(score > 0 && score < 1, `Expected partial F1, got ${score}`);
  });

  it("tokenF1 both empty should be 1.0", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    assert.strictEqual(tokenF1("", ""), 1.0);
  });

  it("tokenF1 one empty should be 0", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    assert.strictEqual(tokenF1("hello", ""), 0);
    assert.strictEqual(tokenF1("", "hello"), 0);
  });

  it("tokenF1 multiset should handle duplicate tokens correctly", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.ts");
    // "the the" vs "the" — one "the" matches, one doesn't
    // precision = 1/2, recall = 1/1 → F1 = 2*(0.5*1)/(0.5+1) = 2/3
    const score = tokenF1("the the", "the");
    assert.ok(Math.abs(score - 2/3) < 0.001, `Expected ~0.667, got ${score}`);
  });
});
