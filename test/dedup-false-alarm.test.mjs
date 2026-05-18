/**
 * P0 驗證測試：確認 bulkStore 不會因 batchDedup 去重
 *
 * 問題：是否 bulkStore 內部呼叫 batchDedup，導致 near-duplicate entries
 *       被錯誤過濾，造成 countAfter - countBefore < createEntries.length？
 *
 * 測試策略：
 *   1. 直接構造兩個 cosine similarity = 0.95 的向量（保證是 near-duplicate）
 *   2. 用 batchDedup 確認它們確實被視為 duplicates
 *   3. 透過 bulkStore 寫入這兩個 entry
 *   4. 驗證 count 增加 2（而非 1）→ 確認 bulkStore 不去重
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { batchDedup } = jiti("../src/batch-dedup.ts");

/** 256-dim constant vector with a controlled cosine similarity to a base vector */
function makeNearDuplicateVector(baseVec, similarity = 0.95) {
  const dim = baseVec.length;
  // Scale factor: cosine = scale * |base| / |target| = scale (since |base|=|target|=1)
  // Actually: cos(base, target) = scale when target = scale * base + orth
  const scale = similarity;
  return baseVec.map(v => v * scale);
}

/** Two identical vectors — maximum similarity */
function makeIdenticalVector(dim = 256) {
  const rng = makeRng(42);
  return Array.from({ length: dim }, () => rng());
}

/** Seeded LCG RNG for deterministic vectors */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const TEST_DB_PREFIX = "/tmp/test-dedup-p0-";

describe("P0: bulkStore does NOT deduplicate near-duplicate entries", () => {
  /** @type {MemoryStore} */
  let store;
  let dbPath;

  afterEach(async () => {
    if (store) {
      try { await store.deleteAll("test-session"); } catch {}
      try { await store.destroy(); } catch {}
    }
  });

  it("bulkStore writes both near-duplicate entries (cosine = 0.95)", async () => {
    // Step 1: Create base vector and a near-duplicate (cosine = 0.95)
    const dim = 256;
    const baseVec = makeIdenticalVector(dim);
    const dupVec = makeNearDuplicateVector(baseVec, 0.95);

    const cosSim = cosineSimilarity(baseVec, dupVec);
    console.log(`[P0] cosine similarity between base and near-duplicate: ${cosSim.toFixed(4)}`);
    assert(cosSim > 0.94, `Near-duplicate should have cosine > 0.94, got ${cosSim}`);

    // Step 2: Verify batchDedup marks one as duplicate
    const dedupResult = batchDedup(
      ["abstract one", "abstract two"],
      [baseVec, dupVec],
      0.85  // default threshold
    );
    console.log(`[P0] batchDedup: ${dedupResult.inputCount} → ${dedupResult.outputCount}, duplicates=${JSON.stringify(dedupResult.duplicateIndices)}`);
    assert(dedupResult.outputCount < dedupResult.inputCount,
      `batchDedup should mark one as duplicate (input=${dedupResult.inputCount}, output=${dedupResult.outputCount})`);

    // Step 3: Create MemoryStore and write both via bulkStore
    dbPath = TEST_DB_PREFIX + Date.now() + "-1";
    store = new MemoryStore({ dbPath, vectorDim: dim });
    const countBefore = await store.count();

    await store.bulkStore([
      {
        text: "Meeting attendance — quarterly business review",
        vector: baseVec,
        category: "fact",
        scope: "test-session",
        importance: 0.5,
        metadata: JSON.stringify({ l0_abstract: "abstract one" }),
      },
      {
        text: "Quarterly business review with team lead",
        vector: dupVec,
        category: "fact",
        scope: "test-session",
        importance: 0.5,
        metadata: JSON.stringify({ l0_abstract: "abstract two" }),
      },
    ]);

    const countAfter = await store.count();
    const delta = countAfter - countBefore;

    console.log(`[P0 result] countBefore=${countBefore}, countAfter=${countAfter}, delta=${delta}`);

    // KEY ASSERTION: delta should be exactly 2 — bulkStore does NOT dedupe
    assert.strictEqual(delta, 2,
      `bulkStore should write both entries (delta=2), got delta=${delta}. ` +
      `If delta=1, bulkStore is internally deduplicating near-duplicate entries — this is a P0 bug.`);
  });

  it("bulkStore writes all 5 entries even when batchDedup would reduce them to 1", async () => {
    const dim = 256;

    // Create 5 identical vectors — batchDedup with threshold 0.85 will keep only 1
    const baseVec = makeIdenticalVector(dim);
    const vectors = Array.from({ length: 5 }, () => baseVec);

    const dedupResult = batchDedup(
      Array(5).fill("abstract"),
      vectors,
      0.85
    );
    console.log(`[P0 batch] batchDedup: 5 identical vectors → ${dedupResult.outputCount} survivors`);
    assert(dedupResult.outputCount < 5,
      "Sanity: 5 identical vectors should produce < 5 survivors in batchDedup");

    // Now write all 5 via bulkStore
    dbPath = TEST_DB_PREFIX + Date.now() + "-2";
    store = new MemoryStore({ dbPath, vectorDim: dim });
    const countBefore = await store.count();

    await store.bulkStore(vectors.map((v, i) => ({
      text: `Event ${i + 1}`,
      vector: v,
      category: "fact",
      scope: "test-session",
      importance: 0.5,
      metadata: JSON.stringify({ l0_abstract: `abstract ${i}` }),
    })));

    const countAfter = await store.count();
    const delta = countAfter - countBefore;

    console.log(`[P0 batch result] countBefore=${countBefore}, countAfter=${countAfter}, delta=${delta}`);

    // KEY ASSERTION: all 5 should be written despite batchDedup saying they're duplicates
    assert.strictEqual(delta, 5,
      `bulkStore should write all 5 entries even if batchDedup would drop 4 of them (delta=5), got delta=${delta}`);
  });
});
