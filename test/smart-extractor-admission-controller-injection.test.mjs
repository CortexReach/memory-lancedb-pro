import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeStore(overrides = {}) {
  return {
    async vectorSearch() {
      return [];
    },
    async store() {},
    async bulkStore() {},
    ...overrides,
  };
}

function makeEmbedder() {
  return {
    async embed() {
      return Array(8).fill(0.1);
    },
    async embedBatch(texts) {
      return (texts || []).map(() => Array(8).fill(0.1));
    },
  };
}

function makeLlm() {
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: [
            {
              category: "events",
              abstract: "user did something notable",
              overview: "## Event",
              content: "the user did something notable",
            },
          ],
        };
      }
      throw new Error(`unexpected mode: ${mode}`);
    },
  };
}

function baseAudit(decision, hint) {
  return {
    version: "amac-v1",
    decision,
    hint,
    score: decision === "reject" ? 0 : 0.9,
    reason: `test-${decision}`,
    thresholds: { reject: 0.45, admit: 0.6 },
    weights: { utility: 0.1, confidence: 0.1, novelty: 0.1, recency: 0.1, typePrior: 0.6 },
    feature_scores: { utility: 0, confidence: 0, novelty: 0, recency: 0, typePrior: 0 },
    matched_existing_memory_ids: [],
    compared_existing_memory_ids: [],
    max_similarity: 0,
    evaluated_at: Date.now(),
  };
}

describe("SmartExtractor admission controller injection", () => {
  it("gates candidates through an externally-constructed admission controller", async () => {
    let evaluateCalls = 0;
    const injectedController = {
      async evaluate() {
        evaluateCalls++;
        return { decision: "reject", audit: baseAudit("reject") };
      },
    };

    const extractor = new SmartExtractor(makeStore(), makeEmbedder(), makeLlm(), {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      admissionController: injectedController,
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist(
      "the user did something notable today",
      "session-1",
      { scope: "global" },
    );

    assert.equal(evaluateCalls, 1, "expected the injected controller's evaluate() to be called");
    assert.equal(stats.rejected, 1);
    assert.equal(stats.created, 0);
  });

  it("stores admitted candidates when the injected controller passes them", async () => {
    let evaluateCalls = 0;
    const injectedController = {
      async evaluate() {
        evaluateCalls++;
        return { decision: "pass_to_dedup", hint: "add", audit: baseAudit("pass_to_dedup", "add") };
      },
    };

    const extractor = new SmartExtractor(makeStore(), makeEmbedder(), makeLlm(), {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      admissionController: injectedController,
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist(
      "the user did something notable today",
      "session-2",
      { scope: "global" },
    );

    assert.equal(evaluateCalls, 1);
    assert.equal(stats.created, 1);
    assert.equal(stats.rejected ?? 0, 0);
  });

  it("skips admission gating entirely when no controller is configured (today's off-behavior)", async () => {
    const extractor = new SmartExtractor(makeStore(), makeEmbedder(), makeLlm(), {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist(
      "the user did something notable today",
      "session-3",
      { scope: "global" },
    );

    assert.equal(stats.rejected ?? 0, 0);
    assert.equal(stats.created, 1);
  });
});
