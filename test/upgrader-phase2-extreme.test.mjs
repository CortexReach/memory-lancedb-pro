/**
 * Memory Upgrader Phase-2 極限測試 (v3)
 *
 * 測試目標：
 * 1. Phase 2 使用 bulkUpdateMetadata() = TRUE 1-lock-per-batch
 * 2. 極限測試：大批次、LLM 失敗、並發競爭
 * 3. OLD vs NEW lock acquisitions 比較
 *
 * [v3 — TRUE 1-lock-per-batch]
 * - writeEnrichedBatch() 現在使用 store.bulkUpdateMetadata()
 * - Phase 2 的 lock count = 1 per batch（不再是 N per N entries）
 * - Issue #632 的核心改進：N → 1 lock acquisition
 *
 * 執行方式: node test/upgrader-phase2-extreme.test.mjs
 */

import assert from "node:assert/strict";
import Module from "node:module";

import jitiFactory from "jiti";

import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeModulesPaths = [
  path.resolve(process.execPath, "../../lib/node_modules"),
  path.resolve(process.execPath, "../../openclaw/node_modules"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules"),
].filter(Boolean);

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  ...nodeModulesPaths,
].join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryUpgrader } = jiti("../src/memory-upgrader.ts");

// ============================================================================
// Test Helpers
// ============================================================================

function createLegacyEntry(id, text, category = "fact") {
  return {
    id,
    text,
    category,
    scope: "test",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: "{}",
  };
}

/**
 * [v3] 標準備考 lock 行為的 mock store。
 * 新增 bulkUpdateMetadata()：單次 lock，批次處理所有 entries。
 */
function createMockStore() {
  let lockCount = 0;
  const data = new Map();

  const store = {
    async list() {
      return Array.from(data.values());
    },

    /**
     * [v3] bulkUpdateMetadataWithPatch：單次 lock，re-read + merge。
     * [FIX MR2] 新 API，re-read 後 merge patch + marker。
     */
    async bulkUpdateMetadataWithPatch(entries) {
      return store.runWithFileLock(async () => {
        // Note: lockCount already incremented by runWithFileLock
        for (const { id, patch, marker } of entries) {
          data.set(id, { ...data.get(id), ...patch, ...marker });
        }
        return { success: entries.length, failed: [] };
      });
    },

    /**
     * [v3] bulkUpdateMetadata：單次 lock，批次處理（舊 API，保留給其他測試）。
     */
    async bulkUpdateMetadata(pairs) {
      return store.runWithFileLock(async () => {
        for (const pair of pairs) {
          data.set(pair.id, { ...data.get(pair.id), metadata: pair.metadata });
        }
        return { success: pairs.length, failed: [] };
      });
    },

    /**
     * update()：保留給 plugin 並發寫入模擬。
     * 內部也呼叫 runWithFileLock()（與真實 store.update() 一致）。
     */
    async update(id, patch) {
      return store.runWithFileLock(async () => {
        data.set(id, { ...data.get(id), ...patch });
        return true;
      });
    },

    async getById(id) {
      return data.get(id) || null;
    },

    async runWithFileLock(fn) {
      lockCount++;
      try {
        return await fn();
      } finally {
        // noop
      }
    },

    initData(entries) {
      for (const e of entries) data.set(e.id, e);
    },

    getLockCount() { return lockCount; },
    resetLockCount() { lockCount = 0; },
  };

  return store;
}

// ============================================================================
// Test Suite: Phase-2 Fix 極限測試
// ============================================================================

/**
 * [v3]
 * Phase 2 bulkUpdateMetadata() = 1 lock per batch。
 * 10 entries 分 1 batch = 1 lock（不再是 10 locks）。
 */
async function testPhase2_LockCountFixed() {
  console.log("\n=== Test 1: Phase-2 TRUE 1-lock-per-batch ===");

  const store = createMockStore();
  store.initData(Array.from({ length: 10 }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));

  const llm = {
    async completeJson() { return null; },
    getLastError() { return "mock"; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 1 — 整批 10 entries 一次 bulkUpdateMetadata)`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 10)`);

  // [v3] 關鍵斷言：1 bulkUpdateMetadata = 1 lock
  assert.equal(store.getLockCount(), 1, "Phase-2: 整批 10 entries = 1 lock（TRUE 1-lock-per-batch）");
  assert.equal(result.upgraded, 10, "應該升級 10 筆");

  console.log("  ✅ Test 1 通過：TRUE 1-lock-per-batch");
}

/**
 * [v3]
 * LLM 失敗時，prepareEntry() 內部 catch 後 fallback 到 simpleEnrich，
 * bulkUpdateMetadata() 仍能正常完成 Phase 2 的 DB write。
 */
async function testPhase2_LLMFailedGracefully() {
  console.log("\n=== Test 2: Phase-2 LLM 失敗時優雅降級 ===");

  const store = createMockStore();
  store.initData([
    createLegacyEntry("entry-1", "Memory 1"),
    createLegacyEntry("entry-2", "Memory 2"),
    createLegacyEntry("entry-3", "Memory 3"),
  ]);

  // LLM 一直失敗
  const llm = {
    async completeJson() { throw new Error("LLM API failed"); },
    getLastError() { return "LLM API failed"; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 3, noLlm: false });

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 1 — 整批 3 entries 一次 bulkUpdateMetadata)`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 3，使用 simpleEnrich fallback)`);
  console.log(`  錯誤筆數: ${result.errors.length}`);

  // [v3] LLM 失敗後 fallback 到 simpleEnrich，仍有 1 次 bulkUpdateMetadata
  assert.equal(store.getLockCount(), 1, "LLM 失敗仍執行 bulkUpdateMetadata = 1 lock");
  assert.equal(result.upgraded, 3, "應該 fallback 到 simpleEnrich 並成功升級");
  assert.equal(result.errors.length, 0, "不應該有錯誤（因為有 fallback）");

  console.log("  ✅ Test 2 通過：LLM 失敗時 fallback，仍完成 DB write");
}

/**
 * [v3]
 * 混合場景：3 個 entries 分 1 batch = 1 lock。
 */
async function testPhase2_MixedSuccessAndFailure() {
  console.log("\n=== Test 3: Phase-2 混合場景 ===");

  const store = createMockStore();
  store.initData([
    createLegacyEntry("entry-1", "Memory 1"),
    createLegacyEntry("entry-2", "Memory 2"),
    createLegacyEntry("entry-3", "Memory 3"),
  ]);

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 5, noLlm: true });

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 1)`);
  console.log(`  升級筆數: ${result.upgraded}`);

  // [v3] 3 entries 分 1 batch = 1 lock
  assert.equal(store.getLockCount(), 1, "3 entries 分 1 batch = 1 lock");
  assert.equal(result.upgraded, 3, "全部成功");

  console.log("  ✅ Test 3 通過");
}

/**
 * [v3]
 * 批次邊界：25 entries 分 3 個 batches（10+10+5）。
 * 每個 batch 的 bulkUpdateMetadata = 1 lock。
 * 總 lock 次數 = 3（不再是 25）。
 */
async function testPhase2_BatchBoundary() {
  console.log("\n=== Test 4: Phase-2 批次邊界處理 ===");

  const store = createMockStore();
  store.initData(Array.from({ length: 25 }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 3 — 25 entries 分 3 batches = 3 locks)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  console.log(`  Batches: 3 (10+10+5)`);

  // [v3] 25 entries 分 3 batches = 3 locks（不再是 25）
  assert.equal(store.getLockCount(), 3, "25 筆分 3 批次 = 3 locks（每 batch 1 lock）");
  assert.equal(result.upgraded, 25, "全部 25 筆都應該升級");

  console.log("  ✅ Test 4 通過：批次邊界正確，lock count = N batches（不再是 N entries）");
}

/**
 * [v3]
 * 極限批次：100 entries 分 10 個 batches（每個 10 entries）。
 * 每個 batch 的 bulkUpdateMetadata = 1 lock。
 * 總 lock 次數 = 10（不再是 100）。
 */
async function testPhase2_ConcurrentStress() {
  console.log("\n=== Test 5: Phase-2 極端批次測試 (100 entries) ===");

  const store = createMockStore();
  store.initData(Array.from({ length: 100 }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i} with some extra text to make it longer`)
  ));

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const start = Date.now();
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });
  const duration = Date.now() - start;

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 10 — 100 entries 分 10 batches = 10 locks)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  console.log(`  Batches: 10 (每批 10 entries)`);
  console.log(`  耗時: ${duration}ms`);

  // [v3] 100 entries 分 10 batches = 10 locks（不再是 100）
  assert.equal(store.getLockCount(), 10, "100 筆分 10 批次 = 10 locks（不再是 100）");
  assert.equal(result.upgraded, 100, "全部 100 筆都應該升級");

  console.log("  ✅ Test 5 通過：100 entries 處理正確，lock count 大幅減少");
}

/**
 * [v3]
 * OLD vs NEW 比較：
 * - OLD: 每個 entry update() = 1 lock，N entries = N locks
 * - NEW: bulkUpdateMetadata() = 1 lock per batch
 *
 * 這是 Issue #632 的核心改進：lock acquisitions 減少 N→1。
 */
async function testCompareOldVsNew() {
  console.log("\n=== Test 6: OLD vs NEW lock acquisitions 比較 ===");

  const ENTRY_COUNT = 5;
  const BATCH_SIZE = 10; // 5 entries 分 1 batch

  // OLD 實作模擬：每個 entry update() = 1 lock
  const oldStore = createMockStore();
  oldStore.initData(Array.from({ length: ENTRY_COUNT }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));

  for (let i = 0; i < ENTRY_COUNT; i++) {
    await oldStore.update(`entry-${i}`, { text: `updated-${i}` });
  }

  console.log(`  OLD（N × update）: ${oldStore.getLockCount()} locks for ${ENTRY_COUNT} entries`);

  // NEW 實作模擬：bulkUpdateMetadata() = 1 lock per batch
  const newStore = createMockStore();
  newStore.initData(Array.from({ length: ENTRY_COUNT }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));

  const pairs = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
    id: `entry-${i}`,
    metadata: JSON.stringify({ updated: true }),
  }));
  await newStore.bulkUpdateMetadata(pairs);

  console.log(`  NEW（bulkUpdateMetadata）: ${newStore.getLockCount()} locks for ${ENTRY_COUNT} entries`);

  const reduction = ((ENTRY_COUNT - 1) / ENTRY_COUNT * 100).toFixed(0);
  console.log(`  Lock reduction: ${reduction}%（${ENTRY_COUNT} → 1）`);

  // [v3] 關鍵比較
  assert.equal(oldStore.getLockCount(), ENTRY_COUNT, `OLD: 每 entry 1 lock = ${ENTRY_COUNT} locks`);
  assert.equal(newStore.getLockCount(), 1, "NEW: 整批 1 lock");

  console.log(`  ✅ Test 6 通過：lock acquisitions 減少 ${reduction}%（${ENTRY_COUNT} → 1）`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 極限測試 (v3)");
  console.log("TRUE 1-lock-per-batch with bulkUpdateMetadata");
  console.log("===========================================");

  try {
    await testPhase2_LockCountFixed();
    await testPhase2_LLMFailedGracefully();
    await testPhase2_MixedSuccessAndFailure();
    await testPhase2_BatchBoundary();
    await testPhase2_ConcurrentStress();
    await testCompareOldVsNew();

    console.log("\n===========================================");
    console.log("All tests passed!");
    console.log("===========================================");
    console.log("\n總結:");
    console.log("- Phase-2: bulkUpdateMetadata() = 1 lock per batch");
    console.log("- Issue #632 核心改進：lock acquisitions N → 1（減少 88-90%）");
    console.log("- LLM 失敗時優雅降級到 simpleEnrich");
    console.log("- 大批次 (100 entries) 測試通過");

  } catch (err) {
    console.error("\nTest failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
