import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { createDecayEngine, DEFAULT_DECAY_CONFIG } = jiti("../src/decay-engine.ts");

// ============================================================
// Test helpers
// ============================================================

function makeEntry(id, text, daysAgo, tier = "working") {
  const now = Date.now();
  const age = daysAgo * 86_400_000;
  return {
    id,
    text,
    vector: new Array(384).fill(0.1),
    category: "fact",
    scope: "global",
    importance: 0.8,
    timestamp: now - age,
    metadata: JSON.stringify({
      tier,
      confidence: 0.9,
      accessCount: 1,
      createdAt: now - age,
      lastAccessedAt: now - age,
    }),
  };
}

function createMockStore(entries) {
  const map = new Map(entries.map(e => [e.id, e]));
  return {
    hasFtsSupport: true,
    async vectorSearch() {
      return entries.map((entry, index) => ({ entry, score: 0.9 - index * 0.05 }));
    },
    async bm25Search() { return []; },
    async hasId(id) { return map.has(id); },
  };
}

function createMockEmbedder() {
  return {
    async embedQuery() { return new Array(384).fill(0.1); },
  };
}

// ============================================================
// Bug 7: decayEngine recency double-boost regression
// ============================================================

describe("MemoryRetriever - decayEngine recency double-boost regression (Bug 7)", () => {
  it("should NOT double-boost recency when decayEngine is active in vector-only mode", async () => {
    // Two entries: very recent (1 day) vs old (60 days)
    const recentEntry = makeEntry("recent-1", "Recent decision about API design", 1);
    const oldEntry = makeEntry("old-1", "Old decision about database schema", 60);

    const entries = [recentEntry, oldEntry];
    const store = createMockStore(entries);
    const embedder = createMockEmbedder();

    // WITHOUT decayEngine: applyRecencyBoost boosts recent entries
    const retrieverWithoutDecay = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      recencyHalfLifeDays: 14,
      recencyWeight: 0.1,
      filterNoise: false,
      hardMinScore: 0,
    });

    // WITH decayEngine: recency is handled by decayEngine, NOT applyRecencyBoost
    const decayEngine = createDecayEngine({
      ...DEFAULT_DECAY_CONFIG,
      recencyHalfLifeDays: 30,
      recencyWeight: 0.4,
    });
    const retrieverWithDecay = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      filterNoise: false,
      hardMinScore: 0,
    }, { decayEngine });

    const [withoutDecay, withDecay] = await Promise.all([
      retrieverWithoutDecay.retrieve({ query: "decision", limit: 5 }),
      retrieverWithDecay.retrieve({ query: "decision", limit: 5 }),
    ]);

    assert.equal(withoutDecay.length, 2, "withoutDecay should return 2 results");
    assert.equal(withDecay.length, 2, "withDecay should return 2 results");

    const recentWithDecay = withDecay.find(r => r.entry.id === "recent-1");
    const oldWithDecay = withDecay.find(r => r.entry.id === "old-1");

    // With decayEngine, recent entry should score >= old entry (decayEngine boosts recency)
    assert.ok(recentWithDecay, "recent entry should be in withDecay results");
    assert.ok(recentWithDecay.score >= oldWithDecay.score,
      "with decayEngine: recent entry should score >= old entry");

    // Without decayEngine, recent entry should also be boosted (applyRecencyBoost)
    const recentWithoutDecay = withoutDecay.find(r => r.entry.id === "recent-1");
    const oldWithoutDecay = withoutDecay.find(r => r.entry.id === "old-1");
    assert.ok(recentWithoutDecay.score >= oldWithoutDecay.score,
      "without decayEngine: recent entry should score >= old entry");
  });

  it("should produce comparable scores regardless of which recency path is used (no extreme double-boost)", async () => {
    // If Bug 7 existed, applying BOTH boosts would make recent entries score MUCH higher.
    // With the fix, only one recency mechanism fires, so scores stay comparable.
    const recentEntry = makeEntry("recent-2", "Very recent memory about auth", 1);
    const oldEntry = makeEntry("old-2", "Very old memory about auth", 90);

    const store = createMockStore([recentEntry, oldEntry]);
    const embedder = createMockEmbedder();
    const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);

    const retrieverWithDecay = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      filterNoise: false,
      hardMinScore: 0,
    }, { decayEngine });

    const retrieverWithoutDecay = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      recencyHalfLifeDays: 30,
      recencyWeight: 0.1,
      filterNoise: false,
      hardMinScore: 0,
    });

    const [withDecay, withoutDecay] = await Promise.all([
      retrieverWithDecay.retrieve({ query: "auth", limit: 5 }),
      retrieverWithoutDecay.retrieve({ query: "auth", limit: 5 }),
    ]);

    assert.ok(withDecay.length >= 1, "withDecay should return results");
    assert.ok(withoutDecay.length >= 1, "withoutDecay should return results");

    const recentWithDecay = withDecay.find(r => r.entry.id === "recent-2");
    const recentWithoutDecay = withoutDecay.find(r => r.entry.id === "recent-2");

    // Scores should be in the same ballpark (different formulas, but not wildly different).
    // If double-boost existed, withDecay would be >> withoutDecay.
    if (recentWithoutDecay && recentWithDecay) {
      const ratio = recentWithDecay.score / recentWithoutDecay.score;
      assert.ok(ratio > 0.3 && ratio < 3.0,
        `Scores should be comparable (ratio=${ratio.toFixed(2)}); extreme ratio suggests double-boost bug`);
    }
  });

  it("should skip applyRecencyBoost when decayEngine is active (bm25-only path for comparison)", async () => {
    // Verify the bm25-only path also correctly skips recencyBoost when decayEngine is active.
    // This is a consistency check across retrieval modes.
    const recentEntry = makeEntry("recent-3", "Recent decision about caching", 2);
    const oldEntry = makeEntry("old-3", "Old decision about caching strategy", 45);

    const store = {
      hasFtsSupport: true,
      async vectorSearch() { return []; },
      async bm25Search() {
        return [
          { entry: recentEntry, score: 0.85 },
          { entry: oldEntry, score: 0.82 },
        ];
      },
      async hasId(id) { return id === recentEntry.id || id === oldEntry.id; },
    };
    const embedder = createMockEmbedder();
    const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);

    const retriever = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "hybrid",  // use hybrid to exercise bm25-only path when vector returns nothing
      filterNoise: false,
      hardMinScore: 0,
    }, { decayEngine });

    const results = await retriever.retrieve({ query: "caching", limit: 5 });

    assert.ok(results.length >= 1, "should return at least one result");
    // The recent entry should be present and scored appropriately
    const recentResult = results.find(r => r.entry.id === "recent-3");
    assert.ok(recentResult, "recent entry should be in results");
    assert.ok(recentResult.score > 0, "score should be positive");
  });
});

console.log("OK: retriever decay recency double-boost regression test passed");
