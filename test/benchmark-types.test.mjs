import { describe, it } from "node:test";
import assert from "node:assert";

describe("benchmark types", () => {
  it("max-recall profile should have expected fields", async () => {
    const { MAX_RECALL_PROFILE } = await import("../benchmark/profiles/max-recall.ts");
    assert.strictEqual(MAX_RECALL_PROFILE.mode, "hybrid");
    assert.strictEqual(MAX_RECALL_PROFILE.hardMinScore, 0.15);
    assert.strictEqual(MAX_RECALL_PROFILE.timeDecayHalfLifeDays, 0);
    assert.strictEqual(MAX_RECALL_PROFILE.recencyHalfLifeDays, 0);
    assert.strictEqual(MAX_RECALL_PROFILE.filterNoise, false);
    assert.strictEqual(MAX_RECALL_PROFILE.candidatePoolSize, 40);
  });
});
