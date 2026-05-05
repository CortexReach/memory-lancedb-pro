import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { buildSmartMetadata, parseSmartMetadata, toLifecycleMemory } = jiti("../src/smart-metadata.ts");
const { createDecayEngine, DEFAULT_DECAY_CONFIG } = jiti("../src/decay-engine.ts");
const { createTierManager, DEFAULT_TIER_CONFIG } = jiti("../src/tier-manager.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { computeTier1Patch } = jiti("../src/auto-recall-tier1.ts");

const now = Date.now();

const legacyEntry = {
  id: "legacy-1",
  text: "My preferred editor is Neovim and I use it every day.",
  category: "preference",
  scope: "global",
  importance: 0.8,
  timestamp: now - 10 * 86_400_000,
  metadata: "{}",
};

const normalized = parseSmartMetadata(legacyEntry.metadata, legacyEntry);
assert.equal(normalized.memory_category, "preferences");
assert.equal(normalized.tier, "working");
assert.equal(normalized.access_count, 0);
assert.equal(normalized.l0_abstract, legacyEntry.text);

const strongEntry = {
  id: "strong-1",
  text: "Use PostgreSQL for the billing service architecture decision.",
  vector: [1, 0],
  category: "decision",
  scope: "global",
  importance: 0.95,
  timestamp: now - 45 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Use PostgreSQL for the billing service architecture decision.",
        category: "decision",
        importance: 0.95,
        timestamp: now - 45 * 86_400_000,
      },
      {
        memory_category: "events",
        tier: "working",
        confidence: 0.95,
        access_count: 12,
        last_accessed_at: now - 1 * 86_400_000,
      },
    ),
  ),
};

const staleEntry = {
  id: "stale-1",
  text: "Temporary note about a deprecated staging host.",
  vector: [0, 1],
  category: "other",
  scope: "global",
  importance: 0.2,
  timestamp: now - 120 * 86_400_000,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Temporary note about a deprecated staging host.",
        category: "other",
        importance: 0.2,
        timestamp: now - 120 * 86_400_000,
      },
      {
        memory_category: "patterns",
        tier: "working",
        confidence: 0.4,
        access_count: 0,
        last_accessed_at: now - 120 * 86_400_000,
      },
    ),
  ),
};

const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
const tierManager = createTierManager(DEFAULT_TIER_CONFIG);

const memories = [
  toLifecycleMemory(strongEntry.id, strongEntry),
  toLifecycleMemory(staleEntry.id, staleEntry),
];
const scores = decayEngine.scoreAll(memories, now);
const transitions = tierManager.evaluateAll(memories, scores, now);

assert.ok(
  transitions.some((t) => t.memoryId === strongEntry.id && t.toTier === "core"),
  "high-access high-importance memory should promote to core",
);
assert.ok(
  transitions.some((t) => t.memoryId === staleEntry.id && t.toTier === "peripheral"),
  "stale low-value working memory should demote to peripheral",
);

const fakeStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [
      { entry: staleEntry, score: 0.72 },
      { entry: strongEntry, score: 0.72 },
    ];
  },
  async bm25Search() {
    return [
      { entry: staleEntry, score: 0.82 },
      { entry: strongEntry, score: 0.82 },
    ];
  },
  async hasId() {
    return true;
  },
};

const fakeEmbedder = {
  async embedQuery() {
    return [1, 0];
  },
};

const retriever = createRetriever(
  fakeStore,
  fakeEmbedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0.1,
    hardMinScore: 0.1,
  },
  { decayEngine },
);

const results = await retriever.retrieve({
  query: "billing service architecture",
  limit: 5,
  scopeFilter: ["global"],
});

assert.equal(results.length, 2);
assert.equal(
  results[0].entry.id,
  strongEntry.id,
  "decay-aware retrieval should rank reinforced memory above stale memory",
);

const freshWorkingEntry = {
  id: "fresh-working-1",
  text: "Work scope secret is beta-work-852.",
  vector: [1, 0],
  category: "fact",
  scope: "agent:work",
  importance: 0.93,
  timestamp: now,
  metadata: JSON.stringify(
    buildSmartMetadata(
      {
        text: "Work scope secret is beta-work-852.",
        category: "fact",
        importance: 0.93,
        timestamp: now,
      },
      {
        memory_category: "facts",
        tier: "working",
        confidence: 1,
        access_count: 0,
        last_accessed_at: now,
      },
    ),
  ),
};

const freshStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: freshWorkingEntry, score: 0.6924 }];
  },
  async bm25Search() {
    return [{ entry: freshWorkingEntry, score: 0.5163 }];
  },
  async hasId() {
    return true;
  },
};

const freshRetriever = createRetriever(
  freshStore,
  fakeEmbedder,
  {
    ...DEFAULT_RETRIEVAL_CONFIG,
    filterNoise: false,
    rerank: "none",
    minScore: 0.6,
    hardMinScore: 0.62,
  },
  { decayEngine },
);

const freshResults = await freshRetriever.retrieve({
  query: "beta-work-852",
  limit: 5,
  scopeFilter: ["agent:work"],
});

assert.equal(
  freshResults.length,
  1,
  "fresh working-tier memories should survive decay + hardMinScore filtering",
);

console.log("OK: smart memory lifecycle test passed");

// ============================================================================
// Tier 1 integration assertion
// ============================================================================
// Verify the auto-recall injection path's computed patch correctly increments
// access_count. Imports the same computeTier1Patch consumed by index.ts so any
// regression in the production helper or in parseSmartMetadata's plumbing
// surfaces here.
{
  const freshMeta = parseSmartMetadata(
    JSON.stringify({ l0_abstract: "lifecycle-tier1", access_count: 0 }),
    { text: "lifecycle-tier1", category: "fact" },
  );
  const patched = computeTier1Patch(freshMeta, { injectedAt: Date.now() });
  assert.equal(patched.access_count, 1, "Tier 1: access_count must increment from 0 to 1 on auto-recall injection");
  console.log("✓ Tier 1 access_count integration assertion passed");
}
