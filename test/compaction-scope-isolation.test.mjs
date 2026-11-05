import assert from "node:assert/strict";
import { test } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { runCompaction } = jiti("../src/memory-compactor.ts");
const config = {
  enabled: true, minAgeDays: 7, similarityThreshold: 0.88, minClusterSize: 2,
  maxMemoriesToScan: 200, dryRun: false, cooldownHours: 24,
};
const entry = (id, scope) => ({
  id, scope, text: "Synthetic repeated fact", vector: [1, 0, 0, 0],
  category: "fact", importance: 0.7, timestamp: Date.now() - 10 * 86400000, metadata: "{}",
});
const embedder = { embedPassage: async () => [1, 0, 0, 0] };

function storeFor(entries) {
  const stored = [], deleted = [];
  return {
    stored, deleted,
    async fetchForCompaction() { return entries; },
    async store(value) { stored.push(value); return { ...value, id: `merged-${stored.length}` }; },
    async delete(id) { deleted.push(id); return true; },
  };
}

test("identical memories in different scopes remain separate", async () => {
  const store = storeFor([entry("a", "agent:a"), entry("b", "agent:b")]);
  const result = await runCompaction(store, embedder, config);
  assert.equal(result.clustersFound, 0);
  assert.equal(store.stored.length, 0);
  assert.equal(store.deleted.length, 0);
});

test("same-scope compaction still merges and deletes its source rows", async () => {
  const store = storeFor([entry("a", "agent:a"), entry("b", "agent:a")]);
  const result = await runCompaction(store, embedder, config);
  assert.equal(result.clustersFound, 1);
  assert.equal(store.stored.length, 1);
  assert.equal(store.stored[0].scope, "agent:a");
  assert.deepEqual(store.deleted.sort(), ["a", "b"]);
});

test("two scopes with identical vectors compact into their own rows", async () => {
  const store = storeFor([
    entry("a1", "agent:a"), entry("a2", "agent:a"),
    entry("b1", "agent:b"), entry("b2", "agent:b"),
  ]);
  const result = await runCompaction(store, embedder, config);
  assert.equal(result.clustersFound, 2);
  assert.deepEqual(store.stored.map(row => row.scope).sort(), ["agent:a", "agent:b"]);
  assert.deepEqual(store.deleted.sort(), ["a1", "a2", "b1", "b2"]);
});

test("multi-scope dry-run reports separate clusters without writes", async () => {
  const store = storeFor([
    entry("a1", "agent:a"), entry("a2", "agent:a"),
    entry("b1", "agent:b"), entry("b2", "agent:b"),
  ]);
  const result = await runCompaction(store, embedder, { ...config, dryRun: true });
  assert.equal(result.clustersFound, 2);
  assert.equal(store.stored.length, 0);
  assert.equal(store.deleted.length, 0);
});
