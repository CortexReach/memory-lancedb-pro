/**
 * B-1 + B-2 Integration Tests — Real LanceDB
 *
 * Run: node --test test/b1-b2-integration.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": new URL("test/helpers/openclaw-plugin-sdk-stub.mjs", import.meta.url).pathname,
  },
});

const { MemoryStore } = jiti("../src/store.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { expandDerivedWithBm25 } = jiti("../src/bm25-expansion.ts", { default: (m) => m });
const { createScopeManager } = jiti("../src/scopes.ts");
const { createMigrator } = jiti("../src/migrate.ts");

function makeDeterministicEmbedder() {
  const toVector = (text) => {
    const s = String(text || "").toLowerCase();
    return [
      s.includes("oolong") || s.includes("烏龍茶") ? 1 : 0,
      s.includes("coffee") || s.includes("咖啡") ? 1 : 0,
      s.includes("typescript") ? 1 : 0,
      Math.min(1, s.length / 1000),
    ];
  };
  return {
    async embedQuery(text) { return toVector(text); },
    async embedPassage(text) { return toVector(text); },
    async embedBatchPassage(texts) { return texts.map(toVector); },
    async test() { return { success: true, dimensions: 4 }; },
  };
}

function makeApi() {
  return {
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    memory: { store: { async add() {}, async update() {} } },
  };
}

async function addWithVector(store, embedder, entry) {
  const vector = await embedder.embedPassage(entry.text || entry.id);
  await store.importEntry({ ...entry, vector });
}

function createTestStore(workDir) {
  return new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: 4 });
}

function createTestRetriever(store) {
  const embedder = makeDeterministicEmbedder();
  const scopeManager = createScopeManager({ defaultScope: "global" });
  const migrator = createMigrator(store);
  return createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    rerank: "none",
    minScore: 0,
    hardMinScore: 0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
    filterNoise: false,
    candidatePoolSize: 20,
  }, scopeManager, migrator);
}

// ═══════════════════════════════════════════════════════════════════════════════
// B-1 TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("B-1: expandDerivedWithBm25 (real LanceDB)", () => {
  let workDir;
  let embedder;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "b1-integration-"));
    embedder = makeDeterministicEmbedder();
  });

  it("should return derived unchanged when scopeFilter is undefined", async () => {
    const store = createTestStore(workDir);
    const api = makeApi();
    const derived = ["line 1", "line 2"];
    const result = await expandDerivedWithBm25(derived, undefined, store, api);
    assert.deepEqual(result, derived);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("should return derived unchanged when derived array is empty", async () => {
    const store = createTestStore(workDir);
    const api = makeApi();
    const result = await expandDerivedWithBm25([], ["global"], store, api);
    assert.deepEqual(result, []);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("should return derived when no neighbors found", async () => {
    const store = createTestStore(workDir);
    await addWithVector(store, embedder, {
      id: "fact-unrelated",
      text: "totally unrelated content xyz123",
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });
    const api = makeApi();
    const result = await expandDerivedWithBm25(["hello world"], ["global"], store, api);
    assert.ok(result.includes("hello world"));
    rmSync(workDir, { recursive: true, force: true });
  });

  // Self-filter: entry identical to derived line is excluded as neighbor
  it("should filter entry identical to derived line (self-filter)", async () => {
    const store = createTestStore(workDir);
    const entryText = "This is a unique entry text that matches the derived line exactly";
    await addWithVector(store, embedder, {
      id: "fact-self",
      text: entryText,
      category: "fact",
      scope: "global",
      importance: 0.5,
      timestamp: Date.now(),
      metadata: "{}",
    });
    const api = makeApi();
    // Derived line is identical to stored entry → self-filtered
    const result = await expandDerivedWithBm25([entryText], ["global"], store, api);
    // Stored entry filtered as self; result contains only the derived line itself
    const derivedCount = result.filter(t => t === entryText).length;
    assert.equal(derivedCount, 1, `Expected 1 (self only), got ${derivedCount}: ${JSON.stringify(result)}`);
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B-2 TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("B-2: enrichWithNeighbors via auto-recall (real LanceDB)", () => {
  let workDir;
  let embedder;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "b2-integration-"));
    embedder = makeDeterministicEmbedder();
  });

  it("auto-recall should return results without crashing", async () => {
    const store = createTestStore(workDir);
    const retriever = createTestRetriever(store);
    await addWithVector(store, embedder, {
      id: "entry-1", text: "Oolong tea is a popular beverage",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    await addWithVector(store, embedder, {
      id: "entry-2", text: "TypeScript is a programming language",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    const results = await retriever.retrieve({
      query: "oolong",
      source: "auto-recall",
      limit: 10,
      scopeFilter: undefined,
      category: undefined,
    });
    const ids = results.map(r => r.entry.id);
    assert.ok(ids.length > 0, `Should return results. Got: ${JSON.stringify(ids)}`);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("manual recall should return results without crashing (enrichment skipped)", async () => {
    const store = createTestStore(workDir);
    const retriever = createTestRetriever(store);
    await addWithVector(store, embedder, {
      id: "entry-1", text: "Oolong tea is great",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    const results = await retriever.retrieve({
      query: "oolong",
      source: "manual",
      limit: 5,
      scopeFilter: undefined,
      category: undefined,
    });
    assert.ok(results.length > 0, "Manual recall should return results");
    rmSync(workDir, { recursive: true, force: true });
  });

  it("no duplicate IDs in auto-recall results", async () => {
    const store = createTestStore(workDir);
    const retriever = createTestRetriever(store);
    await addWithVector(store, embedder, {
      id: "topic-1", text: "oolong tea contains caffeine",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    await addWithVector(store, embedder, {
      id: "topic-2", text: "oolong tea has vitamins",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    await addWithVector(store, embedder, {
      id: "unrelated", text: "unrelated content xyz",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    const results = await retriever.retrieve({
      query: "oolong",
      source: "auto-recall",
      limit: 10,
      scopeFilter: undefined,
      category: undefined,
    });
    assert.ok(results.length > 0, "Should return results");
    const ids = results.map(r => r.entry.id);
    const uniqueIds = [...new Set(ids)];
    assert.equal(ids.length, uniqueIds.length, `Duplicate IDs: ${JSON.stringify(ids)}`);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("original entries are anchored in auto-recall results", async () => {
    const store = createTestStore(workDir);
    const retriever = createTestRetriever(store);
    await addWithVector(store, embedder, {
      id: "primary-entry", text: "oolong tea varieties",
      category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
    });
    await addWithVector(store, embedder, {
      id: "neighbor-entry", text: "many oolong varieties exist",
      category: "fact", scope: "global", importance: 0.7, timestamp: Date.now(), metadata: "{}",
    });
    const results = await retriever.retrieve({
      query: "oolong",
      source: "auto-recall",
      limit: 5,
      scopeFilter: undefined,
      category: undefined,
    });
    const ids = results.map(r => r.entry.id);
    assert.ok(ids.includes("primary-entry"), `Primary should be anchored. Got: ${JSON.stringify(ids)}`);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("auto-recall results should be capped at limit", async () => {
    const store = createTestStore(workDir);
    const retriever = createTestRetriever(store);
    for (let i = 0; i < 15; i++) {
      await addWithVector(store, embedder, {
        id: `entry-${i}`, text: `entry number ${i} about oolong tea`,
        category: "fact", scope: "global", importance: 0.5, timestamp: Date.now(), metadata: "{}",
      });
    }
    const results = await retriever.retrieve({
      query: "oolong",
      source: "auto-recall",
      limit: 5,
      scopeFilter: undefined,
      category: undefined,
    });
    assert.ok(results.length <= 5, `Should be capped at 5, got ${results.length}`);
    rmSync(workDir, { recursive: true, force: true });
  });
});
