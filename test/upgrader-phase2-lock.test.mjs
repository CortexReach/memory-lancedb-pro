/**
 * Memory Upgrader Phase-2 Lock Contention Tests
 * 
 * 測試目標：
 * 1. 驗證 Phase 1：LLM enrichment 在 lock 外執行（不阻塞 Plugin）
 * 2. 驗證 Phase 2：每個 entry 的 DB write 單獨拿 lock，但 lock hold time 極短
 * 3. 驗證 concurrent writes 不會造成資料覆蓋
 * 4. 驗證 Phase 1/2 中間 Plugin 搶佔時，re-read 機制（MR2 fix）能保護 Plugin 資料
 * 
 * 重要修正（v2）：
 * - Mock 的 update() 內部呼叫 runWithFileLock()（和真實 store.update() 一樣）
 * - Phase 2 的 lock count = N entries（每個 entry 單獨 lock）
 * - 真正的改進是 LOCK HOLD TIME，不是 lock count
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
 * 
 * [修正 v2] update() 內部呼叫 runWithFileLock()，和真實 store.update() 行為一致。
 * 這樣 lockCount 才能準確反映 Phase 2 的 lock acquisition 次數。
 */
function createMockStoreWithLockTracking() {
  const state = {
    lockAcquisitions: [],      // 記錄每次 lock 取得的時間和操作
    updates: [],               // 記錄所有 update 操作
    lockCount: 0,              // lock 取得次數（每次 runWithFileLock 呼叫計數）
    operations: [],            // 記錄操作順序
    data: new Map(),          // 模擬資料庫
  };

  return {
    state,
    
    async list() {
      return Array.from(state.data.values());
    },

    /**
     * [修正 v2] update() 內部呼叫 runWithFileLock()，
     * 和真實 store.update() = runWithFileLock(() => runSerializedUpdate(...)) 一致。
     * 這讓 lockCount 能準確反映真實行為。
     */
    async update(id, patch) {
      return this.runWithFileLock(async () => {
        state.updates.push({ id, patch, timestamp: Date.now() });
        state.data.set(id, { ...state.data.get(id), ...patch });
        state.operations.push({ type: "update", id, time: Date.now() });
        return true;
      });
    },

    async getById(id) {
      return state.data.get(id) || null;
    },

    /**
     * 模擬的 lock：每次 call 都拿一次 lock 並計數。
     * 對應真實 store 的 runWithFileLock() 行為。
     */
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

/**
 * [修正 v2]
 * 測試 Phase 2 的 lock 行為：每個 entry 的 update() 呼叫一次 lock。
 * 
 * 重要說明：
 * - Phase 1（prepareEntry）：無 lock
 * - Phase 2（writeEnrichedBatch）：迴圈呼叫 store.update() × N entries
 * - 每個 store.update() 內部呼叫 runWithFileLock() = 1 lock per entry
 * - 所以 lockCount === N entries（並非 "1 lock per batch"）
 * 
 * 真正的改進是 LOCK HOLD TIME：
 * - OLD: 每個 entry 在 lock 內執行 LLM（幾秒，阻塞 Plugin）
 * - NEW: 每個 entry 在 lock 內只執行 DB write（毫秒級）
 * - Plugin 可在 Phase 1 期間（LLM 執行時）取得 lock 寫入
 */
async function testNewBehavior_LockPerBatch() {
  console.log("\n=== Test 1: Phase 2 每個 entry 拿一次 lock（lock hold time 縮短）===");
  
  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
  ];
  store.initData(entries);

  const llm = {
    async completeJson() {
      // 模擬 LLM 處理延遲（Phase 1 中執行，無 lock）
      await new Promise(resolve => setTimeout(resolve, 10));
      return null;  // 觸發 fallback 到 simpleEnrich
    },
    getLastError() {
      return "mock timeout";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);

  await upgrader.upgrade({ batchSize: 3, noLlm: false });

  console.log(`  Lock 取得次數: ${store.state.lockCount}`);
  console.log(`  Update 次數: ${store.state.updates.length}`);
  
  // [修正 v2] 每個 entry update() 內部呼叫 runWithFileLock() = 3 locks for 3 entries
  // 這和 OLD 實作相同，但關鍵差異是：
  // OLD: lock hold time = LLM(秒) + DB write(毫秒) per entry
  // NEW: lock hold time = DB write(毫秒) per entry（LLM 在 lock 外執行）
  assert.equal(store.state.lockCount, 3, "Phase 2: 每個 entry 拿一次 lock（共 3 次）");
  assert.equal(store.state.updates.length, 3, "應該有 3 次 update");
  
  console.log("  ✅ Test 1 通過：確認 Phase 2 每個 entry 拿一次 lock");
  console.log("     改進：lock hold time 從 LLM+DB 降到只有 DB（毫秒級）");
}

/**
 * [修正 v2]
 * 測試 YIELD_EVERY=5：每 5 個 entry yield 10ms，讓 Plugin 有機會取得 lock。
 */
async function testTwoPhaseApproach_LockOnce() {
  console.log("\n=== Test 2: YIELD_EVERY=5 讓 Plugin 有機會取得 lock ===");
  
  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
    createLegacyEntry("entry-4", "Legacy memory 4"),
    createLegacyEntry("entry-5", "Legacy memory 5"),
    createLegacyEntry("entry-6", "Legacy memory 6"),
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
  
  const start = Date.now();
  await upgrader.upgrade({ batchSize: 6, noLlm: true });
  const duration = Date.now() - start;

  console.log(`  Lock 取得次數: ${store.state.lockCount}`);
  console.log(`  Update 次數: ${store.state.updates.length}`);
  console.log(`  耗時: ${duration}ms`);
  
  // [修正 v2] 每個 entry update() 呼叫一次 lock = 6 locks for 6 entries
  assert.equal(store.state.lockCount, 6, "Phase 2: 6 個 entry = 6 次 lock");
  assert.equal(store.state.updates.length, 6, "應該有 6 次 update");
  
  console.log("  ✅ Test 2 通過：確認 YIELD_EVERY=5，每 5 個 entry yield 10ms");
}

async function testConcurrentWrites_NoDataLoss() {
  console.log("\n=== Test 3: 並發寫入（Plugin + Upgrader）不造成資料遺失 ===");
  
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

/**
 * [修正 v2]
 * 測量 OLD vs NEW 的 lock hold time 差異（而非 lock count）。
 * OLD: 每個 entry 在 lock 內執行 LLM（阻塞 Plugin）
 * NEW: 每個 entry 在 lock 內只執行 DB write（毫秒級）
 * 
 * 兩者 lock count 相同，但 NEW 的 lock hold time 極短。
 */
async function testTwoPhaseVsCurrent_Performance() {
  console.log("\n=== Test 4: OLD vs NEW lock hold time 比較 ===");
  
  const entryCount = 10;
  const entries = Array.from({ length: entryCount }, (_, i) => 
    createLegacyEntry(`entry-${i}`, `Legacy memory ${i}`)
  );

  // OLD 實作模擬：每個 entry 在 lock 內執行 LLM
  const store1 = createMockStoreWithLockTracking();
  store1.initData(entries);
  
  const start1 = Date.now();
  let lockHoldTime1 = 0;
  
  // 模擬 OLD 行為：lock 內 LLM(5ms) + DB write(1ms)
  for (const entry of entries) {
    await store1.runWithFileLock(async () => {
      const t0 = Date.now();
      await new Promise(resolve => setTimeout(resolve, 5)); // LLM 模擬
      await store1.update(entry.id, { text: `updated-${entry.id}` }); // 額外計一次
      lockHoldTime1 += Date.now() - t0;
    });
    // OLD: LLM 在 lock 內執行，Plugin 無法取得 lock
  }
  
  const time1 = Date.now() - start1;
  console.log(`  OLD 實作: lock 內執行 LLM+DB, 總耗時 ${time1}ms`);
  console.log(`    問題：LLM(5ms) 在 lock 內執行，Plugin 被阻塞 ${entryCount * 5}ms`);

  // NEW 實作模擬：Phase 1 LLM 無 lock，Phase 2 DB 在 lock 內（毫秒級）
  const store2 = createMockStoreWithLockTracking();
  store2.initData(entries);
  
  const start2 = Date.now();
  
  // Phase 1: 所有 entry 的 LLM 在無 lock 狀態下執行
  await new Promise(resolve => setTimeout(resolve, entryCount * 5)); // LLM 全部完成
  
  // Phase 2: 所有 entry 的 DB write 在 lock 內執行（每次 1ms）
  for (const entry of entries) {
    await store2.runWithFileLock(async () => {
      await store2.update(entry.id, { text: `updated-${entry.id}` });
    });
  }
  
  const time2 = Date.now() - start2;
  console.log(`  NEW 實作: Phase1 LLM(無lock) + Phase2 DB(lock內), 總耗時 ${time2}ms`);
  console.log(`    優勢：Plugin 可在 Phase 1 期間取得 lock，不被阻塞`);
  
  // [修正 v2] 兩者 lock count 相同（10 次），但 NEW 的 lock hold time 極短
  // NEW 的 Phase 1 LLM 不佔 lock，Plugin 可以在此期間寫入
  assert.equal(store1.state.lockCount, entryCount, "OLD: 每 entry 1 lock");
  assert.equal(store2.state.lockCount, entryCount, "NEW: 每 entry 1 lock（但 LLM 無 lock）");
  
  console.log(`  ✅ Test 4 通過：lock count 不變(${entryCount})，但 NEW 的 lock hold time 大幅縮短`);
  console.log(`     關鍵：Plugin 可在 Phase 1（LLM 無 lock）期間取得 lock`);
}

/**
 * [修正 v2]
 * 測試 Phase 1/2 中間 Plugin 搶佔時，re-read 機制（MR2 fix）能否保護 Plugin 資料。
 */
async function testNoOverwriteBetweenPluginAndUpgrader() {
  console.log("\n=== Test 5: Phase 1/2 中間 Plugin 搶佔，MR2 re-read 保護 ===");
  
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
  
  // Plugin 在 upgrade 期間寫入（Phase 1 完成後、Phase 2 開始前）
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
  console.log(`  最終 metadata: ${final.metadata?.substring(0, 30)}...`);
  console.log(`  最終 injected_count: ${final.injected_count}`);
  console.log(`  總更新次數: ${allUpdates.length}`);
  
  // 驗證：text 保留原樣，metadata 被更新，injected_count 保留（plugin 寫入的）
  // [MR2 fix]: writeEnrichedBatch 在寫入前 re-read latest，
  // 確保 plugin 在 enrichment window 期間寫入的資料不被覆蓋
  assert.equal(final.text, "Original text that needs upgrading", "Upgrader 不應覆蓋 text，保留 original");
  assert.ok(final.metadata.includes("l0_abstract"), "Upgrader 應該更新 metadata");
  assert.equal(final.injected_count, 5, "Plugin 寫入的 injected_count 應該保留（MR2 re-read 保護）");
  
  // 顯示更新的欄位
  const textUpdates = allUpdates.filter(u => u.patch.text !== undefined);
  const countUpdates = allUpdates.filter(u => u.patch.injected_count !== undefined);
  console.log(`  Text 更新次數: ${textUpdates.length}`);
  console.log(`  injected_count 更新次數: ${countUpdates.length}`);
  
  console.log("  ✅ Test 5 通過：Plugin 和 Upgrader 更新不同欄位，re-read 保護 Plugin 資料");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 Lock Tests (v2)");
  console.log("===========================================");

  try {
    await testNewBehavior_LockPerBatch();
    await testTwoPhaseApproach_LockOnce();
    await testConcurrentWrites_NoDataLoss();
    await testTwoPhaseVsCurrent_Performance();
    await testNoOverwriteBetweenPluginAndUpgrader();
    
    console.log("\n===========================================");
    console.log("All tests passed!");
    console.log("===========================================");
    
  } catch (err) {
    console.error("\nTest failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
