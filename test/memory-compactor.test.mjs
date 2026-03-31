import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  cosineSimilarity,
  buildClusters,
  buildMergedEntry,
  runCompaction,
} = jiti("../src/memory-compactor.ts");

// ============================================================================
// Helpers
// ============================================================================

function vec(dims, ...values) {
  // Create a vector of `dims` dimensions, placing `values` at the first positions
  const v = new Array(dims).fill(0);
  values.forEach((val, i) => { v[i] = val; });
  return v;
}

function entry(overrides = {}) {
  return {
    id: overrides.id ?? "id-" + Math.random().toString(36).slice(2),
    text: overrides.text ?? "some memory",
    vector: overrides.vector ?? vec(4, 1, 0, 0, 0),
    category: overrides.category ?? "fact",
    scope: overrides.scope ?? "global",
    importance: overrides.importance ?? 0.5,
    timestamp: overrides.timestamp ?? Date.now() - 8 * 24 * 60 * 60 * 1000,
    metadata: overrides.metadata ?? "{}",
  };
}

function makeStore(entries = []) {
  const db = new Map(entries.map((e) => [e.id, { ...e }]));
  return {
    stored: [],
    deleted: [],
    async fetchForCompaction(_maxTs, _scopes, limit = 200) {
      return [...db.values()].slice(0, limit);
    },
    async store(e) {
      const newEntry = { id: "merged-" + Math.random().toString(36).slice(2), ...e };
      db.set(newEntry.id, newEntry);
      this.stored.push(newEntry);
      return newEntry;
    },
    async delete(id) {
      if (db.has(id)) { db.delete(id); this.deleted.push(id); return true; }
      return false;
    },
  };
}

function makeEmbedder(dim = 4) {
  return {
    async embedPassage(text) {
      // Deterministic fake embedding: hash first char into first dimension
      const v = new Array(dim).fill(0);
      v[0] = (text.charCodeAt(0) % 10) / 10;
      return v;
    },
  };
}

const defaultConfig = {
  enabled: true,
  minAgeDays: 7,
  similarityThreshold: 0.88,
  minClusterSize: 2,
  maxMemoriesToScan: 200,
  dryRun: false,
  cooldownHours: 24,
};

// ============================================================================
// cosineSimilarity
// ============================================================================

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = vec(4, 1, 2, 3, 4);
    assert.equal(cosineSimilarity(v, v), 1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(cosineSimilarity(vec(4, 1, 0, 0, 0), vec(4, 0, 1, 0, 0)), 0);
  });

  it("returns ~0.71 for 45-degree vectors", () => {
    const sim = cosineSimilarity(vec(2, 1, 0), vec(2, 1, 1));
    assert.ok(sim > 0.7 && sim < 0.72, `expected ~0.71, got ${sim}`);
  });

  it("returns 0 for zero-norm vector without NaN", () => {
    assert.equal(cosineSimilarity(vec(4), vec(4, 1, 0, 0, 0)), 0);
  });

  it("returns 0 for mismatched dimensions", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });

  it("clamps result to [0, 1]", () => {
    // Floating point can produce tiny values outside [0,1]
    const v = vec(4, 0.9999999, 0.0000001, 0, 0);
    const sim = cosineSimilarity(v, v);
    assert.ok(sim >= 0 && sim <= 1);
  });
});

// ============================================================================
// buildClusters
// ============================================================================

describe("buildClusters", () => {
  it("returns empty array when fewer entries than minClusterSize", () => {
    const e = entry({ vector: vec(4, 1, 0, 0, 0) });
    const result = buildClusters([e], 0.9, 2);
    assert.deepEqual(result, []);
  });

  it("clusters two very similar entries", () => {
    const a = entry({ vector: vec(4, 1, 0.01, 0, 0), importance: 0.8 });
    const b = entry({ vector: vec(4, 1, 0.02, 0, 0), importance: 0.5 });
    const clusters = buildClusters([a, b], 0.88, 2);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].memberIndices.length, 2);
  });

  it("does not cluster orthogonal entries", () => {
    const a = entry({ vector: vec(4, 1, 0, 0, 0) });
    const b = entry({ vector: vec(4, 0, 1, 0, 0) });
    const clusters = buildClusters([a, b], 0.88, 2);
    assert.equal(clusters.length, 0);
  });

  it("seeds cluster with highest-importance entry", () => {
    const lo = entry({ vector: vec(4, 1, 0, 0, 0), importance: 0.3 });
    const hi = entry({ vector: vec(4, 1, 0.01, 0, 0), importance: 0.9 });
    const clusters = buildClusters([lo, hi], 0.88, 2);
    assert.equal(clusters.length, 1);
    // The merged importance should reflect the hi entry
    assert.equal(clusters[0].merged.importance, 0.9);
  });

  it("produces two separate clusters for two disjoint similar pairs", () => {
    const a1 = entry({ vector: vec(4, 1, 0.01, 0, 0), importance: 0.9 });
    const a2 = entry({ vector: vec(4, 1, 0.02, 0, 0), importance: 0.6 });
    const b1 = entry({ vector: vec(4, 0, 0, 1, 0.01), importance: 0.8 });
    const b2 = entry({ vector: vec(4, 0, 0, 1, 0.02), importance: 0.5 });
    const clusters = buildClusters([a1, a2, b1, b2], 0.88, 2);
    assert.equal(clusters.length, 2);
  });

  it("skips entries with empty vectors", () => {
    const a = entry({ vector: [], importance: 0.9 });
    const b = entry({ vector: [], importance: 0.5 });
    const clusters = buildClusters([a, b], 0.5, 2);
    assert.equal(clusters.length, 0);
  });
});

// ============================================================================
// buildMergedEntry
// ============================================================================

describe("buildMergedEntry", () => {
  it("deduplicates identical lines across members", () => {
    const a = entry({ text: "learned TypeScript\nuses vim" });
    const b = entry({ text: "learned TypeScript\nprefers dark mode" });
    const merged = buildMergedEntry([a, b]);
    const lines = merged.text.split("\n");
    const tsLines = lines.filter((l) => l.includes("TypeScript"));
    assert.equal(tsLines.length, 1, "duplicate line should appear once");
  });

  it("preserves unique lines from all members", () => {
    const a = entry({ text: "uses vim" });
    const b = entry({ text: "prefers dark mode" });
    const merged = buildMergedEntry([a, b]);
    assert.ok(merged.text.includes("uses vim"));
    assert.ok(merged.text.includes("prefers dark mode"));
  });

  it("takes max importance", () => {
    const a = entry({ importance: 0.4 });
    const b = entry({ importance: 0.9 });
    const c = entry({ importance: 0.6 });
    const merged = buildMergedEntry([a, b, c]);
    assert.equal(merged.importance, 0.9);
  });

  it("caps importance at 1.0", () => {
    const a = entry({ importance: 1.0 });
    const b = entry({ importance: 1.0 });
    const merged = buildMergedEntry([a, b]);
    assert.ok(merged.importance <= 1.0);
  });

  it("uses plurality category", () => {
    const a = entry({ category: "preference" });
    const b = entry({ category: "fact" });
    const c = entry({ category: "fact" });
    const merged = buildMergedEntry([a, b, c]);
    assert.equal(merged.category, "fact");
  });

  it("marks metadata as compacted with sourceCount", () => {
    const members = [entry(), entry(), entry()];
    const merged = buildMergedEntry(members);
    const meta = JSON.parse(merged.metadata);
    assert.equal(meta.compacted, true);
    assert.equal(meta.sourceCount, 3);
    assert.ok(typeof meta.compactedAt === "number");
  });
});

// ============================================================================
// runCompaction
// ============================================================================

describe("runCompaction", () => {
  it("merges a similar pair and reports correct counts", async () => {
    const a = entry({ text: "pref: dark mode", vector: vec(4, 1, 0.01, 0, 0), importance: 0.7 });
    const b = entry({ text: "pref: always dark theme", vector: vec(4, 1, 0.02, 0, 0), importance: 0.5 });
    const store = makeStore([a, b]);
    const embedder = makeEmbedder(4);

    const result = await runCompaction(store, embedder, defaultConfig);

    assert.equal(result.clustersFound, 1);
    assert.equal(result.memoriesDeleted, 2);
    assert.equal(result.memoriesCreated, 1);
    assert.equal(result.dryRun, false);
    assert.equal(store.stored.length, 1);
    assert.equal(store.deleted.length, 2);
  });

  it("dry-run does not write anything", async () => {
    const a = entry({ vector: vec(4, 1, 0.01, 0, 0) });
    const b = entry({ vector: vec(4, 1, 0.02, 0, 0) });
    const store = makeStore([a, b]);

    const result = await runCompaction(store, makeEmbedder(), {
      ...defaultConfig,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesDeleted, 0);
    assert.equal(result.memoriesCreated, 0);
    assert.equal(store.stored.length, 0);
    assert.equal(store.deleted.length, 0);
    assert.equal(result.clustersFound, 1);
  });

  it("returns zero counts when no entries are available", async () => {
    const store = makeStore([]);
    const result = await runCompaction(store, makeEmbedder(), defaultConfig);
    assert.equal(result.scanned, 0);
    assert.equal(result.clustersFound, 0);
  });

  it("skips singleton clusters (no merge when similarity below threshold)", async () => {
    const a = entry({ vector: vec(4, 1, 0, 0, 0) });
    const b = entry({ vector: vec(4, 0, 1, 0, 0) }); // orthogonal
    const store = makeStore([a, b]);

    const result = await runCompaction(store, makeEmbedder(), defaultConfig);

    assert.equal(result.clustersFound, 0);
    assert.equal(result.memoriesDeleted, 0);
  });

  it("respects maxMemoriesToScan limit", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ vector: vec(4, 1, i * 0.001, 0, 0) })
    );
    const store = makeStore(entries);

    const result = await runCompaction(store, makeEmbedder(), {
      ...defaultConfig,
      maxMemoriesToScan: 3,
    });

    assert.ok(result.scanned <= 3);
  });
});
