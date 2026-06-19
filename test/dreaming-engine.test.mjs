import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  computeNextDreamingDelayMs,
  createDreamingEngine,
  normalizeDreamingConfig,
  parseDailyCron,
} = jiti("../src/dreaming-engine.ts");
const {
  buildSmartMetadata,
  isMemoryActiveAt,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");
const { createRetriever } = jiti("../src/retriever.ts");

const NOW = Date.UTC(2026, 5, 15, 10, 0, 0);

function memoryEntry({
  id,
  text,
  vector = [1, 0],
  category = "fact",
  scope = "global",
  importance = 0.5,
  timestamp = NOW,
  metadata = {},
}) {
  const base = { text, category, importance, timestamp };
  return {
    id,
    text,
    vector,
    category,
    scope,
    importance,
    timestamp,
    metadata: stringifySmartMetadata(buildSmartMetadata(base, metadata)),
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class MockStore {
  constructor(entries = []) {
    this.entries = entries;
    this.stored = [];
    this.patches = [];
    this.updates = [];
  }

  async stats() {
    const scopeCounts = {};
    for (const entry of this.entries) {
      scopeCounts[entry.scope ?? "global"] = (scopeCounts[entry.scope ?? "global"] ?? 0) + 1;
    }
    return { totalCount: this.entries.length, scopeCounts };
  }

  async list(scopeFilter, category, limit = 20, offset = 0) {
    let rows = this.entries;
    if (scopeFilter?.length) {
      rows = rows.filter((entry) => scopeFilter.includes(entry.scope ?? "global"));
    }
    if (category) {
      rows = rows.filter((entry) => entry.category === category);
    }
    return rows
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry, vector: entry.vector ? [...entry.vector] : [] }));
  }

  async fetchForCompaction(_maxTimestamp, scopeFilter, limit = 200) {
    let rows = this.entries;
    if (scopeFilter?.length) {
      rows = rows.filter((entry) => scopeFilter.includes(entry.scope ?? "global"));
    }
    return rows.slice(0, limit).map((entry) => ({ ...entry, vector: [...entry.vector] }));
  }

  async vectorSearch(vector, limit = 5, minScore = 0, scopeFilter, options = {}) {
    let rows = this.entries;
    if (scopeFilter?.length) {
      rows = rows.filter((entry) => scopeFilter.includes(entry.scope ?? "global"));
    }
    return rows
      .map((entry) => ({ ...entry, vector: entry.vector ? [...entry.vector] : [] }))
      .filter((entry) => !options.excludeInactive || isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry), NOW))
      .map((entry) => ({ entry, score: cosineSimilarity(vector, entry.vector) }))
      .filter((result) => result.score >= minScore)
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit);
  }

  async bm25Search(query, limit = 5, scopeFilter, options = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let rows = this.entries;
    if (scopeFilter?.length) {
      rows = rows.filter((entry) => scopeFilter.includes(entry.scope ?? "global"));
    }
    return rows
      .map((entry) => ({ ...entry, vector: entry.vector ? [...entry.vector] : [] }))
      .filter((entry) => !options.excludeInactive || isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry), NOW))
      .map((entry) => {
        const text = entry.text.toLowerCase();
        const hits = terms.filter((term) => text.includes(term)).length;
        return { entry, score: terms.length ? hits / terms.length : 0 };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit);
  }

  async patchMetadata(id, patch) {
    this.patches.push({ id, patch });
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const parsed = JSON.parse(entry.metadata || "{}");
    entry.metadata = JSON.stringify({ ...parsed, ...patch });
    return entry;
  }

  async update(id, updates) {
    this.updates.push({ id, updates });
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    Object.assign(entry, updates);
    return entry;
  }

  async store(entry) {
    const stored = {
      ...entry,
      id: `stored-${this.stored.length + 1}`,
      timestamp: NOW,
    };
    this.stored.push(stored);
    this.entries.push(stored);
    return stored;
  }
}

const embedder = {
  async embed() {
    return [0.5, 0.5];
  },
  async embedQuery() {
    return [1, 0];
  },
};

test("normalizes dreaming config and daily cron scheduling defaults", () => {
  const disabled = normalizeDreamingConfig(undefined);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.frequency, "0 3 * * *");
  assert.equal(disabled.phases.deep.minUniqueQueries, 0);

  const enabled = normalizeDreamingConfig({
    enabled: true,
    frequency: "@daily",
    phases: {
      light: { limit: "25", dedupeSimilarity: 1.2 },
      deep: { minUniqueQueries: 0 },
    },
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.phases.light.limit, 25);
  assert.equal(enabled.phases.light.dedupeSimilarity, 1);
  assert.equal(enabled.phases.deep.minUniqueQueries, 0);
  assert.deepEqual(parseDailyCron("@daily"), { hour: 0, minute: 0 });

  const delay = computeNextDreamingDelayMs("0 3 * * *", "UTC", Date.UTC(2026, 0, 1, 2, 30));
  assert.equal(delay, 30 * 60 * 1000);

  assert.throws(
    () => normalizeDreamingConfig({ enabled: true, frequency: "every 5 minutes" }),
    /Unsupported dreaming\.frequency/,
  );
  assert.throws(
    () => normalizeDreamingConfig({ enabled: true, phases: { light: { sources: ["unsupported"] } } }),
    /Unsupported dreaming source filter/,
  );
});

test("default-off engine returns without touching the store", async () => {
  const store = {
    async stats() {
      throw new Error("stats should not be called while dreaming is disabled");
    },
    async list() {
      throw new Error("list should not be called while dreaming is disabled");
    },
    async patchMetadata() {
      throw new Error("patchMetadata should not be called while dreaming is disabled");
    },
    async update() {
      throw new Error("update should not be called while dreaming is disabled");
    },
    async store() {
      throw new Error("store should not be called while dreaming is disabled");
    },
  };

  const engine = createDreamingEngine({ store, embedder, now: () => NOW });
  const result = await engine.runSweep(["global"]);

  assert.equal(result.enabled, false);
  assert.deepEqual(result.errors, []);
});

test("light dreaming archives near-duplicate recent memories and skips dream output", async () => {
  const canonical = memoryEntry({
    id: "canonical",
    text: "Deployments use the production checklist.",
    vector: [1, 0],
    importance: 0.9,
    timestamp: NOW - 60_000,
    metadata: { source: "manual", tier: "working", dreaming_phase: "light" },
  });
  const duplicate = memoryEntry({
    id: "duplicate",
    text: "Deployment should use the production checklist.",
    vector: [0.999, 0.001],
    importance: 0.4,
    timestamp: NOW - 30_000,
    metadata: { source: "manual", tier: "working", dreaming_phase: "light" },
  });
  const dreamOutput = memoryEntry({
    id: "dream-output",
    text: "Dreaming reflection about deployments.",
    vector: [1, 0],
    category: "reflection",
    importance: 0.8,
    metadata: { source: "dreaming-engine", dreaming_phase: "rem" },
  });
  const store = new MockStore([canonical, duplicate, dreamOutput]);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: true, limit: 10, dedupeSimilarity: 0.99 },
        deep: { enabled: false },
        rem: { enabled: false },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.light.archived, 1);
  const duplicateMeta = parseSmartMetadata(duplicate.metadata, duplicate);
  assert.equal(duplicateMeta.state, "archived");
  assert.equal(duplicateMeta.canonical_id, "canonical");
  assert.equal(duplicateMeta.invalidated_at, NOW);
  assert.equal(isMemoryActiveAt(duplicateMeta, NOW), false);
  const dreamMeta = parseSmartMetadata(dreamOutput.metadata, dreamOutput);
  assert.equal(dreamMeta.state, "confirmed");

  const retriever = createRetriever(store, embedder, {
    mode: "vector",
    minScore: 0,
    hardMinScore: 0,
    filterNoise: false,
    rerank: "none",
    candidatePoolSize: 10,
  });
  const retrieved = await retriever.retrieve({
    query: "production checklist",
    limit: 10,
    scopeFilter: ["global"],
    source: "manual",
  });
  const retrievedIds = retrieved.map((result) => result.entry.id);
  assert.ok(retrievedIds.includes("canonical"));
  assert.equal(retrievedIds.includes("duplicate"), false);
});

test("light dreaming maps advertised sources and applies recent lookback before limiting", async () => {
  const oldRows = Array.from({ length: 8 }, (_, index) => memoryEntry({
    id: `old-${index}`,
    text: `Old unrelated deployment note ${index}.`,
    vector: [0, 1],
    timestamp: NOW - (5 * 24 * 60 * 60 * 1000) - index,
    metadata: { source: "manual", tier: "working" },
  }));
  const canonical = memoryEntry({
    id: "recent-canonical",
    text: "Release trains use the Friday checklist.",
    vector: [1, 0],
    importance: 0.9,
    timestamp: NOW - 60_000,
    metadata: { source: "manual", tier: "working" },
  });
  const duplicate = memoryEntry({
    id: "recent-duplicate",
    text: "The Friday checklist governs release trains.",
    vector: [0.999, 0.001],
    importance: 0.4,
    timestamp: NOW - 30_000,
    metadata: { source: "manual", tier: "working" },
  });
  const store = new MockStore([...oldRows, canonical, duplicate]);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: true, limit: 2, lookbackDays: 1, dedupeSimilarity: 0.99, sources: ["daily"] },
        deep: { enabled: false },
        rem: { enabled: false },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.light.archived, 1);
  assert.equal(parseSmartMetadata(duplicate.metadata, duplicate).state, "archived");
});

test("deep dreaming promotes high-value recalled working memories", async () => {
  const candidate = memoryEntry({
    id: "candidate",
    text: "The user relies on the release checklist before publishing.",
    importance: 0.72,
    timestamp: NOW - (2 * 60 * 60 * 1000),
    metadata: {
      source: "manual",
      tier: "working",
      memory_layer: "working",
      access_count: 6,
      unique_query_count: 4,
      confidence: 0.9,
    },
  });
  const store = new MockStore([candidate]);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: false },
        deep: { enabled: true, limit: 2, minScore: 0.5, minRecallCount: 3, minUniqueQueries: 3 },
        rem: { enabled: false },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.deep.promoted, 1);
  assert.ok(candidate.importance > 0.72);
  const metadata = parseSmartMetadata(candidate.metadata, candidate);
  assert.equal(metadata.tier, "core");
  assert.equal(metadata.memory_layer, "durable");
  assert.equal(metadata.dreaming_phase, "deep");
  assert.equal(store.patches.length, 0);
  assert.equal(store.updates.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(store.updates[0].updates, "importance"));
  assert.ok(Object.prototype.hasOwnProperty.call(store.updates[0].updates, "metadata"));
});

test("deep dreaming default promotion uses normal access metadata without unique-query counters", async () => {
  const candidate = memoryEntry({
    id: "default-candidate",
    text: "The launch checklist is consulted before every release.",
    importance: 0.74,
    timestamp: NOW - (2 * 60 * 60 * 1000),
    metadata: {
      source: "manual",
      tier: "working",
      memory_layer: "working",
      access_count: 6,
      confidence: 0.9,
    },
  });
  const store = new MockStore([candidate]);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: false },
        deep: { enabled: true, limit: 2, minScore: 0.5, minRecallCount: 3 },
        rem: { enabled: false },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.deep.promoted, 1);
  const metadata = parseSmartMetadata(candidate.metadata, candidate);
  assert.equal(metadata.tier, "core");
  assert.equal(metadata.memory_layer, "durable");
});

test("dreaming stop prevents later phases from starting after in-flight light work", async () => {
  const canonical = memoryEntry({
    id: "canonical-stop",
    text: "Deployments use the stop checklist.",
    vector: [1, 0],
    importance: 0.9,
    metadata: { source: "manual", tier: "working" },
  });
  const duplicate = memoryEntry({
    id: "duplicate-stop",
    text: "Deployment should use the stop checklist.",
    vector: [0.999, 0.001],
    importance: 0.4,
    metadata: { source: "manual", tier: "working" },
  });
  const deepCandidate = memoryEntry({
    id: "deep-stop",
    text: "The shutdown checklist is recalled often.",
    vector: [0, 1],
    importance: 0.8,
    metadata: {
      source: "manual",
      tier: "working",
      memory_layer: "working",
      access_count: 6,
      confidence: 0.9,
    },
  });
  const store = new MockStore([canonical, duplicate, deepCandidate]);
  const originalPatchMetadata = store.patchMetadata.bind(store);
  let engine;
  store.patchMetadata = async (...args) => {
    const result = await originalPatchMetadata(...args);
    engine.stop();
    return result;
  };
  engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: true, limit: 10, dedupeSimilarity: 0.99 },
        deep: { enabled: true, limit: 2, minScore: 0.5, minRecallCount: 3 },
        rem: { enabled: true, limit: 5, minPatternStrength: 0.5 },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.light.archived, 1);
  assert.equal(result.phases.deep.promoted ?? 0, 0);
  assert.equal(store.stored.length, 0);
  assert.equal(parseSmartMetadata(deepCandidate.metadata, deepCandidate).tier, "working");
});

test("dreaming engine can run again after stop and start", async () => {
  const canonical = memoryEntry({
    id: "canonical-restart",
    text: "Deployments use the restart checklist.",
    vector: [1, 0],
    importance: 0.9,
    metadata: { source: "manual", tier: "working" },
  });
  const duplicate = memoryEntry({
    id: "duplicate-restart",
    text: "Deployment should use the restart checklist.",
    vector: [0.999, 0.001],
    importance: 0.4,
    metadata: { source: "manual", tier: "working" },
  });
  const store = new MockStore([canonical, duplicate]);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      phases: {
        light: { enabled: true, limit: 10, dedupeSimilarity: 0.99 },
        deep: { enabled: false },
        rem: { enabled: false },
      },
    },
  });

  engine.stop();
  const stoppedResult = await engine.runSweep(["global"]);
  assert.equal(stoppedResult.phases.light.archived ?? 0, 0);
  assert.equal(store.patches.length, 0);

  engine.start();
  const restartedResult = await engine.runSweep(["global"]);
  assert.equal(restartedResult.errors.length, 0);
  assert.equal(restartedResult.phases.light.archived, 1);
  assert.equal(store.patches.length, 1);
  assert.equal(store.patches[0].id, "duplicate-restart");
});

test("REM dreaming writes a reflection with durable dreaming-engine source metadata", async () => {
  const entries = [
    memoryEntry({
      id: "a",
      text: "Nebula deployment needs checklist review.",
      category: "fact",
      metadata: { source: "manual", memory_category: "patterns" },
    }),
    memoryEntry({
      id: "b",
      text: "Nebula deployment blocked on checklist item.",
      category: "fact",
      metadata: { source: "manual", memory_category: "patterns" },
    }),
    memoryEntry({
      id: "c",
      text: "Nebula deployment checklist passed.",
      category: "fact",
      metadata: { source: "manual", memory_category: "patterns" },
    }),
  ];
  const store = new MockStore(entries);
  const engine = createDreamingEngine({
    store,
    embedder,
    now: () => NOW,
    config: {
      enabled: true,
      timezone: "UTC",
      phases: {
        light: { enabled: false },
        deep: { enabled: false },
        rem: { enabled: true, limit: 5, minPatternStrength: 0.66 },
      },
    },
  });

  const result = await engine.runSweep(["global"]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.phases.rem.created, 1);
  assert.equal(store.stored.length, 1);
  assert.equal(store.stored[0].category, "reflection");
  const metadata = parseSmartMetadata(store.stored[0].metadata, store.stored[0]);
  assert.equal(metadata.source, "dreaming-engine");
  assert.equal(metadata.memory_layer, "reflection");
  assert.equal(metadata.dreaming_phase, "rem");
  assert.equal(metadata.dream_date, "2026-06-15");
});
