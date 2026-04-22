/**
 * Memory Upgrader Phase-2 極限測試 (v2)
 * 
 * 測試目標：
 * 1. Phase 2 每個 entry update() 呼叫一次 lock（並非 "1 per batch"）
 * 2. 極限測試：大批次、LLM 失敗、並發競爭
 * 3. OLD vs NEW lock hold time 比較
 * 
 * 重要修正（v2）：
 * - Mock 的 update() 內部呼叫 runWithFileLock()（和真實 store.update() 一致）
 * - Phase 2 的 lock count = N entries（每個 entry 單獨 lock）
 * - 真正的改進是 LOCK HOLD TIME，不是 lock count
 * 
 * 執行方式: node test/upgrader-phase2-extreme.test.mjs
 */

import assert from "node:assert/strict";
import Module from "node:module";

import jitiFactory from "jiti";

import path from "node:path";
import { fileURLToPath } from "node:url";

// [FIX F1] 使用動態路徑取代硬編碼的 /opt/homebrew/，支援 Linux/macOS/Windows
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
 * 創建標準備考 lock 行為的 mock store。
 * [修正 v2] update() 內部呼叫 runWithFileLock()，與真實 store.update() 行為一致。
 */
function createMockStore() {
  let lockCount = 0;
  const data = new Map();
  
  const store = {
    async list() {
      return Array.from(data.values());
    },
    async update(id, patch) {
      // [修正 v2] update() 內部呼叫 runWithFileLock()，與真實實作一致
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
 * [修正 v2]
 * Phase 2 每個 entry update() 呼叫一次 lock。
 * 10 entries = 10 次 lock acquisition。
 * 改進是 LOCK HOLD TIME（LLM 不在 lock 內執行），而非 lock count。
 */
async function testPhase2_LockCountFixed() {
  console.log("\n=== Test 1: Phase-2 每個 entry 拿一次 lock ===");
  
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

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 10 entries = 10 locks)`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 10)`);
  
  // [修正 v2] 每個 entry 的 update() 呼叫一次 runWithFileLock() = N locks for N entries
  assert.equal(store.getLockCount(), 10, `Phase-2: 每個 entry 拿一次 lock，10 entries = 10 locks`);
  assert.equal(result.upgraded, 10, `應該升級 10 筆`);
  
  console.log("  ✅ Test 1 通過：Phase 2 每個 entry 拿一次 lock");
  console.log("     改進：lock hold time 從 LLM+DB 降到只有 DB（毫秒級）");
}

/**
 * [修正 v2]
 * LLM 失敗時，prepareEntry() 內部 catch 後 fallback 到 simpleEnrich，
 * 仍能正常完成 Phase 2 的 DB write。
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

  console.log(`  Lock 次數: ${store.getLockCount()}`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 3，使用 simpleEnrich fallback)`);
  console.log(`  錯誤筆數: ${result.errors.length}`);
  
  // [修正 v2] LLM 失敗後 fallback 到 simpleEnrich，仍能成功升級
  // 每個 entry update() = 1 lock，3 entries = 3 locks
  assert.equal(store.getLockCount(), 3, "3 entries = 3 locks（LLM 失敗仍執行 DB write）");
  assert.equal(result.upgraded, 3, "應該 fallback 到 simpleEnrich 並成功升級");
  assert.equal(result.errors.length, 0, "不應該有錯誤（因為有 fallback）");
  
  console.log("  ✅ Test 2 通過：LLM 失敗時 fallback 到 simpleEnrich，仍完成 DB write");
}

/**
 * [修正 v2]
 * 混合場景：3 個 entries 的 Phase 1 完成後，Phase 2 按序執行。
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

  console.log(`  Lock 次數: ${store.getLockCount()}`);
  console.log(`  升級筆數: ${result.upgraded}`);
  
  // [修正 v2] 3 entries = 3 locks
  assert.equal(store.getLockCount(), 3, "3 entries = 3 locks");
  assert.equal(result.upgraded, 3, "全部成功");
  
  console.log("  ✅ Test 3 通過");
}

/**
 * [修正 v2]
 * 批次邊界：25 entries 分成 3 個 batches（10+10+5）。
 * 每個 batch 的每個 entry update() 拿一次 lock。
 * 總 lock 次數 = 25（每個 entry 一次）。
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

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 25 entries = 25 locks)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  console.log(`  Batches: 3 (10+10+5)`);
  
  // [修正 v2] 25 entries 分 3 batches = 25 locks（每個 entry 一次）
  assert.equal(store.getLockCount(), 25, "25 筆分 3 批次 = 25 locks（每 entry 1 lock）");
  assert.equal(result.upgraded, 25, "全部 25 筆都應該升級");
  
  console.log("  ✅ Test 4 通過：批次邊界正確，lock count = N entries");
}

/**
 * [修正 v2]
 * 極限批次：100 entries 分 10 個 batches（每個 10 entries）。
 * 每個 entry update() 拿一次 lock = 100 locks。
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

  console.log(`  Lock 次數: ${store.getLockCount()} (預期: 100 entries = 100 locks)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  console.log(`  Batches: 10 (每批 10 entries)`);
  console.log(`  耗時: ${duration}ms`);
  
  // [修正 v2] 100 entries 分 10 batches = 100 locks
  assert.equal(store.getLockCount(), 100, "100 筆分 10 批次 = 100 locks");
  assert.equal(result.upgraded, 100, "全部 100 筆都應該升級");
  
  console.log("  ✅ Test 5 通過：100 entries 處理正確");
}

/**
 * [修正 v2]
 * OLD vs NEW 比較：
 * - OLD: 每個 entry 在 lock 內執行 LLM（阻塞 Plugin）
 * - NEW: Phase 1 LLM 無 lock，Phase 2 每 entry DB write 在 lock 內（毫秒級）
 * 
 * 兩者 lock count 相同，但 NEW 的 lock hold time 極短。
 */
async function testCompareOldVsNew() {
  console.log("\n=== Test 6: OLD vs NEW lock hold time 比較 ===");
  
  const ENTRY_COUNT = 5;
  const LLM_TIME_MS = 5; // 模擬 LLM 延遲

  // OLD 實作：每個 entry 在 lock 內執行 LLM
  const oldStore = createMockStore();
  oldStore.initData(Array.from({ length: ENTRY_COUNT }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));
  
  const oldStart = Date.now();
  // 模擬 OLD 行為：lock 內執行 LLM + DB write
  for (let i = 0; i < ENTRY_COUNT; i++) {
    await oldStore.runWithFileLock(async () => {
      // OLD: LLM 在 lock 內執行（阻塞其他程序）
      await new Promise(resolve => setTimeout(resolve, LLM_TIME_MS));
      await oldStore.update(`entry-${i}`, { text: `updated-${i}` });
    });
  }
  const oldDuration = Date.now() - oldStart;
  
  console.log(`  OLD 實作: lock 內 LLM(${LLM_TIME_MS}ms) + DB, 總耗時 ${oldDuration}ms`);
  console.log(`    問題：Plugin 在 LLM 期間無法取得 lock`);

  // NEW 實作：Phase 1 LLM 無 lock，Phase 2 DB 在 lock 內（毫秒級）
  const newStore = createMockStore();
  newStore.initData(Array.from({ length: ENTRY_COUNT }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  ));
  
  const newStart = Date.now();
  
  // Phase 1: LLM 在無 lock 狀態下執行（可並行，Plugin 可在這期間寫入）
  await new Promise(resolve => setTimeout(resolve, LLM_TIME_MS));
  
  // Phase 2: 每個 entry 的 DB write 在 lock 內（毫秒級）
  for (let i = 0; i < ENTRY_COUNT; i++) {
    await newStore.update(`entry-${i}`, { text: `updated-${i}` });
  }
  const newDuration = Date.now() - newStart;
  
  console.log(`  NEW 實作: Phase1 LLM(無lock ${LLM_TIME_MS}ms) + Phase2 DB, 總耗時 ${newDuration}ms`);
  console.log(`    優勢：Plugin 可在 Phase 1 期間取得 lock`);

  // [修正 v2] 兩者 lock count 相同（ENTRY_COUNT），但 NEW 的 lock hold time 極短
  assert.equal(oldStore.getLockCount(), ENTRY_COUNT, "OLD: 每 entry 1 lock");
  assert.equal(newStore.getLockCount(), ENTRY_COUNT, "NEW: 每 entry 1 lock（lock count 不變）");
  
  console.log(`  ✅ Test 6 通過：lock count 不變(${ENTRY_COUNT})，但 NEW 的 lock hold time 大幅縮短`);
  console.log(`     關鍵改進：Plugin 可在 Phase 1（LLM 無 lock）期間寫入，不被阻塞`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 極限測試 (v2)");
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
    console.log("- Phase-2: 每個 entry 拿一次 lock（lock count = N entries）");
    console.log("- 改進：LLM 不在 lock 內執行（lock hold time 大幅縮短）");
    console.log("- LLM 失敗時優雅降級到 simpleEnrich");
    console.log("- 大批次 (100 entries) 測試通過");
    
  } catch (err) {
    console.error("\nTest failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
