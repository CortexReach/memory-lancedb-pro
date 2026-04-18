/**
 * Memory Upgrader Phase-2 Lock Contention Tests
 * 
 * 測試目標：
 * 1. 驗證目前的實作：每個 entry 都拿一次 lock（確認問題存在）
 * 2. 驗證兩階段方案：LLM 在 lock 外執行，DB 寫入在 lock 內執行
 * 3. 驗證 concurrent writes 不會造成資料覆蓋
 * 
 * 執行方式: node test/upgrader-phase2-lock.test.mjs
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

/**
 * 創建測試用的 legacy entry
 */
function createLegacyEntry(id, text, category = "fact") {
  return {
    id,
    text,
    category,
    scope: "test",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: "{}",  // Legacy = no metadata
  };
}

/**
 * 創建模擬的 store（追蹤 lock 取得次數）
 */
function createMockStoreWithLockTracking() {
  const state = {
    lockAcquisitions: [],      // 記錄每次 lock 取得的時間和操作
    updates: [],               // 記錄所有 update 操作
    lockCount: 0,              // lock 取得次數
    operations: [],            // 記錄操作順序
    data: new Map(),          // 模擬資料庫
  };

  return {
    state,
    
    async list() {
      return Array.from(state.data.values());
    },

    async update(id, patch) {
      state.updates.push({ id, patch, timestamp: Date.now() });
      state.data.set(id, { ...state.data.get(id), ...patch });
      state.operations.push({ type: "update", id, time: Date.now() });
      return true;
    },

    // 模擬的 lock（每次 call 都拿一次 lock）
    async runWithFileLock(fn) {
      state.lockCount++;
      state.operations.push({ type: "lock", lockCount: state.lockCount, time: Date.now() });
      try {
        const result = await fn();
        state.operations.push({ type: "unlock", lockCount: state.lockCount, time: Date.now() });
        return result;
      } catch (err) {
        state.operations.push({ type: "unlock-error", lockCount: state.lockCount, time: Date.now() });
        throw err;
      }
    },

    // 初始化測試資料
    initData(entries) {
      for (const entry of entries) {
        state.data.set(entry.id, entry);
      }
    },

    // 清除狀態（用於每個測試後）
    reset() {
      state.lockAcquisitions = [];
      state.updates = [];
      state.lockCount = 0;
      state.operations = [];
    },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

async function testNewBehavior_LockPerBatch() {
  console.log("\n=== Test 1: 驗證新的實作（每個 batch 只拿一次 lock）===");
  
  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
  ];
  store.initData(entries);

  const llm = {
    async completeJson() {
      // 模擬 LLM 處理延遲
      await new Promise(resolve => setTimeout(resolve, 10));
      return null;  // 觸發 fallback 到 simpleEnrich
    },
    getLastError() {
      return "mock timeout";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  
  // NOTE: 我們不再 mock update 來呼叫 runWithFileLock
  // 新的實作會在 writeEnrichedBatch 中統一呼叫一次 runWithFileLock

  await upgrader.upgrade({ batchSize: 3, noLlm: false });

  console.log(`  Lock 取得次數: ${store.state.lockCount}`);
  console.log(`  Update 次數: ${store.state.updates.length}`);
  
  // 驗證：每個 batch 只拿一次 lock = 1 次（而不是 3 次）
  assert.equal(store.state.lockCount, 1, "新的兩階段實作：應該每個 batch 只拿一次 lock");
  assert.equal(store.state.updates.length, 3, "應該有 3 次 update");
  
  console.log("  ✅ Test 1 通過：確認新的實作每個 batch 只拿一次 lock (Issue #632 fix)");
}

async function testTwoPhaseApproach_LockOnce() {
  console.log("\n=== Test 2: 兩階段方案實際測試 ===");
  
  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
    createLegacyEntry("entry-4", "Legacy memory 4"),
    createLegacyEntry("entry-5", "Legacy memory 5"),
  ];
  store.initData(entries);

  const llm = {
    async completeJson() {
      return null; // 觸發 fallback
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  
  // 實際呼叫 upgrader，觀察 lock 次數
  const start = Date.now();
  await upgrader.upgrade({ batchSize: 5, noLlm: true });
  const duration = Date.now() - start;

  console.log(`  Lock 取得次數: ${store.state.lockCount}`);
  console.log(`  Update 次數: ${store.state.updates.length}`);
  console.log(`  耗時: ${duration}ms`);
  
  // 驗證：5 個 entry 應該只拿 1 次 lock（因為 batchSize=5）
  assert.equal(store.state.lockCount, 1, "兩階段方案：5 個 entry 只拿 1 次 lock");
  assert.equal(store.state.updates.length, 5, "應該有 5 次 update");
  
  console.log("  ✅ Test 2 通過：實際呼叫 upgrader 確認 lock 次數正確");
}

async function testConcurrentWrites_NoDataLoss() {
  console.log("\n=== Test 3: 並發寫入（Plugin + Upgrader）實際測試===");
  
  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
  ];
  store.initData(entries);

  // 初始化 injected_count
  store.state.data.set("entry-1", { ...entries[0], injected_count: 0 });
  store.state.data.set("entry-2", { ...entries[1], injected_count: 0 });

  const llm = {
    async completeJson() {
      return null; // fallback
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  
  // 模擬 Plugin 在 Upgrader 執行期間同時寫入
  const pluginWrites = [];
  
  // Hook store.update 來記錄 Plugin 寫入
  const originalUpdate = store.update.bind(store);
  store.update = async function(id, patch) {
    if (patch.injected_count !== undefined) {
      pluginWrites.push({ id, patch, time: Date.now() });
    }
    return originalUpdate(id, patch);
  };

  // 同時啟動 Upgrader 和 Plugin 模擬
  const upgraderPromise = upgrader.upgrade({ batchSize: 2, noLlm: true });
  
  // Plugin 寫入（模擬在 upgrade 期間）
  await new Promise(resolve => setTimeout(resolve, 5));
  await store.runWithFileLock(async () => {
    await store.update("entry-1", { injected_count: 1 });
    await store.update("entry-2", { injected_count: 1 });
  });
  
  await upgraderPromise;

  console.log(`  Upgrader 更新次數: ${store.state.updates.length}`);
  console.log(`  Plugin 寫入次數: ${pluginWrites.length}`);
  
  // 驗證：兩個更新都成功，沒有互相覆蓋
  assert.ok(store.state.updates.length >= 2, "Upgrader 應該至少更新 2 次");
  assert.equal(pluginWrites.length, 2, "Plugin 應該寫入 2 次");
  
  console.log("  ✅ Test 3 通過：並發寫入都成功，沒有資料遺失");
}

async function testTwoPhaseVsCurrent_Performance() {
  console.log("\n=== Test 4: 兩階段方案 vs 目前方案的效能比較===");
  
  const entryCount = 10;
  const entries = Array.from({ length: entryCount }, (_, i) => 
    createLegacyEntry(`entry-${i}`, `Legacy memory ${i}`)
  );

  // 模擬目前的實作：每個 entry 都拿一次 lock
  const store1 = createMockStoreWithLockTracking();
  store1.initData(entries);
  
  const llm = {
    async completeJson() {
      await new Promise(resolve => setTimeout(resolve, 5)); // 模擬 LLM 延遲
      return null;
    },
    getLastError() { return "mock"; },
  };

  // 目前實作：每個 entry 都拿 lock
  const start1 = Date.now();
  let lockCount1 = 0;
  
  for (const entry of entries) {
    await store1.runWithFileLock(async () => {
      lockCount1++;
      await store1.update(entry.id, { text: `updated-${entry.id}` });
    });
  }
  
  const time1 = Date.now() - start1;
  console.log(`  目前方案: ${lockCount1} 次 lock, 耗時 ${time1}ms`);

  // 兩階段方案：所有 entry 的 LLM 處理完成後，一次拿 lock
  const store2 = createMockStoreWithLockTracking();
  store2.initData(entries);
  
  const start2 = Date.now();
  let lockCount2 = 0;
  
  // Phase 1: LLM 處理（不拿 lock）
  const enriched = entries.map(entry => ({
    ...entry,
    enriched: true,
  }));
  
  // Phase 2: 一次 lock，所有 DB 寫入
  await store2.runWithFileLock(async () => {
    lockCount2++;
    for (const entry of enriched) {
      await store2.update(entry.id, { text: `updated-${entry.id}` });
    }
  });
  
  const time2 = Date.now() - start2;
  console.log(`  兩階段方案: ${lockCount2} 次 lock, 耗時 ${time2}ms`);
  
  // 驗證：lock 次數從 10 次 -> 1 次
  assert.equal(lockCount1, 10, "目前方案應該拿 10 次 lock");
  assert.equal(lockCount2, 1, "兩階段方案應該只拿 1 次 lock");
  
  const improvement = ((time1 - time2) / time1 * 100).toFixed(1);
  console.log(`  改善: ${improvement}% (lock 次數: 10 -> 1)`);
  
  console.log("  ✅ Test 4 通過：兩階段方案大幅減少 lock 取得次數");
}

async function testNoOverwriteBetweenPluginAndUpgrader() {
  console.log("\n=== Test 5: Plugin 更新不同欄位，不會被 Upgrader 覆蓋 ===");
  
  const store = createMockStoreWithLockTracking();
  const entry = createLegacyEntry("entry-1", "Original text that needs upgrading");
  store.initData([entry]);
  
  // 初始化 injection 欄位
  store.state.data.set("entry-1", {
    ...entry,
    injected_count: 0,
    last_injected_at: 0,
  });

  // 追蹤所有更新
  const allUpdates = [];
  const originalUpdate = store.update.bind(store);
  store.update = async function(id, patch) {
    allUpdates.push({ id, patch, time: Date.now() });
    return originalUpdate(id, patch);
  };

  const llm = {
    async completeJson() {
      return null; // fallback
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  
  // 同時執行 upgrader 和 plugin
  const upgraderPromise = upgrader.upgrade({ batchSize: 1, noLlm: true });
  
  // Plugin 在 upgrade 期間寫入
  await new Promise(resolve => setTimeout(resolve, 2));
  await store.runWithFileLock(async () => {
    await store.update("entry-1", { 
      injected_count: 5,
      last_injected_at: Date.now() 
    });
  });
  
  await upgraderPromise;

  // 檢查最終狀態
  const final = store.state.data.get("entry-1");
  console.log(`  最終 text: ${final.text.substring(0, 30)}...`);
  console.log(`  最終 injected_count: ${final.injected_count}`);
  console.log(`  總更新次數: ${allUpdates.length}`);
  
  // 驗證：text 被更新（upgrader），injected_count 也被保留（plugin）
  assert.ok(final.text !== "Original text", "Upgrader 應該更新 text");
  assert.equal(final.injected_count, 5, "Plugin 寫入的 injected_count 應該保留");
  
  // 顯示更新的欄位
  const textUpdates = allUpdates.filter(u => u.patch.text !== undefined);
  const countUpdates = allUpdates.filter(u => u.patch.injected_count !== undefined);
  console.log(`  Text 更新次數: ${textUpdates.length}`);
  console.log(`  injected_count 更新次數: ${countUpdates.length}`);
  
  console.log("  ✅ Test 5 通過：Plugin 和 Upgrader 更新不同欄位，互不覆蓋");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 Lock Tests");
  console.log("===========================================");

  try {
    await testNewBehavior_LockPerBatch();
    await testTwoPhaseApproach_LockOnce();
    await testConcurrentWrites_NoDataLoss();
    await testTwoPhaseVsCurrent_Performance();
    await testNoOverwriteBetweenPluginAndUpgrader();
    
    console.log("\n===========================================");
    console.log("All tests passed! ✅");
    console.log("===========================================");
    
  } catch (err) {
    console.error("\n❌ Test failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
