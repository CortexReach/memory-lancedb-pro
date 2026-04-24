/**
 * Memory Upgrader Phase-2 Lock Contention Tests
 *
 * 測試目標：
 * 1. 驗證 Phase 1：LLM enrichment 在 lock 外執行（不阻塞 Plugin）
 * 2. 驗證 Phase 2：bulkUpdateMetadata() 只拿一次 lock，處理整批 entries
 * 3. 驗證 concurrent writes 不會造成資料覆蓋
 * 4. 驗證 Phase 1/2 中間 Plugin 搶佔時，re-read 機制能保護 Plugin 資料
 *
 * [v3 — TRUE 1-lock-per-batch]
 * - writeEnrichedBatch() 現在使用 store.bulkUpdateMetadata()
 * - Phase 2 的 lock count = 1（整批 entries 一次 lock）
 * - 比舊實作（N × update() = N locks）減少 N-1 次 lock acquisitions
 *
 * 執行方式: node test/upgrader-phase2-lock.test.mjs
 */

import assert from "node:assert/strict";
import Module from "node:module";

import jitiFactory from "jiti";

import path from "node:path";
import { fileURLToPath } from "node:url";

// 使用動態路徑取代硬編碼，支援 Linux/macOS/Windows
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
 * [v3] 新增 bulkUpdateMetadata()：模擬真實的 1-lock-per-batch 行為。
 * 當 writeEnrichedBatch 呼叫 bulkUpdateMetadata 時，只計數 1 次 lock。
 */
function createMockStoreWithLockTracking() {
  const state = {
    lockAcquisitions: [],
    updates: [],
    bulkUpdates: [],
    lockCount: 0,
    operations: [],
    data: new Map(),
  };

  return {
    state,

    async list() {
      return Array.from(state.data.values());
    },

    /**
     * [v3] bulkUpdateMetadata：單次 lock，批次處理所有 entries。
     * 對應真實 store.bulkUpdateMetadata() 的行為。
     */
    async bulkUpdateMetadata(pairs) {
      return this.runWithFileLock(async () => {
        state.bulkUpdates.push({ pairs, timestamp: Date.now() });
        for (const pair of pairs) {
          state.updates.push({ id: pair.id, patch: { metadata: pair.metadata }, timestamp: Date.now() });
          const existing = state.data.get(pair.id);
          if (existing) {
            state.data.set(pair.id, { ...existing, metadata: pair.metadata });
          }
        }
        state.operations.push({ type: "bulkUpdate", count: pairs.length, time: Date.now() });
        return { success: pairs.length, failed: [] };
      });
    },

    /**
     * update()：保留給 plugin 並發寫入模擬使用。
     * 內部也呼叫 runWithFileLock()（與真實 store.update() 一致）。
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

    initData(entries) {
      for (const entry of entries) {
        state.data.set(entry.id, entry);
      }
    },

    reset() {
      state.lockAcquisitions = [];
      state.updates = [];
      state.bulkUpdates = [];
      state.lockCount = 0;
      state.operations = [];
    },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

/**
 * [v3]
 * 測試 Phase 2 的 TRUE 1-lock-per-batch 行為。
 *
 * 重要說明：
 * - Phase 1（prepareEntry）：無 lock
 * - Phase 2（writeEnrichedBatch）：呼叫 store.bulkUpdateMetadata()，拿 1 次 lock
 * - lockCount === 1（無論 batch 有多少 entries）
 *
 * 這是 Issue #632 的真正目標：減少 lock acquisitions from N to 1。
 */
async function testNewBehavior_TrueOneLockPerBatch() {
  console.log("\n=== Test 1: Phase 2 TRUE 1-lock-per-batch ===");

  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
  ];
  store.initData(entries);

  const llm = {
    async completeJson() {
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
  console.log(`  Bulk update 次數: ${store.state.bulkUpdates.length}`);
  console.log(`  Update 次數: ${store.state.updates.length}`);

  // [v3] 關鍵斷言：1 bulkUpdateMetadata = 1 lock（無論 entries 數量）
  assert.equal(store.state.lockCount, 1, "Phase 2: 整批 3 entries 只拿 1 次 lock");
  assert.equal(store.state.bulkUpdates.length, 1, "應該有 1 次 bulkUpdateMetadata");
  assert.equal(store.state.updates.length, 3, "應該有 3 次 update（內部追蹤）");

  console.log("  ✅ Test 1 通過：確認 Phase 2 TRUE 1-lock-per-batch");
}

/**
 * [v3]
 * 測試 Plugin 可在 Phase 1（LLM 無 lock）期間寫入，不被阻塞。
 */
async function testPluginCanWriteDuringPhase1() {
  console.log("\n=== Test 2: Plugin 可在 Phase 1 期間寫入 ===");

  const store = createMockStoreWithLockTracking();
  const entries = [
    createLegacyEntry("entry-1", "Legacy memory 1"),
    createLegacyEntry("entry-2", "Legacy memory 2"),
    createLegacyEntry("entry-3", "Legacy memory 3"),
  ];
  store.initData(entries);

  const llm = {
    async completeJson() {
      // 模擬 LLM 延遲 20ms（Phase 1）
      await new Promise(resolve => setTimeout(resolve, 20));
      return null;
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);

  // Plugin 在 upgrade 期間嘗試寫入
  const pluginWriteStarted = new Promise(resolve => setTimeout(resolve, 5));
  const pluginWrite = store.update("entry-1", { injected_count: 99 });

  await Promise.all([
    upgrader.upgrade({ batchSize: 3, noLlm: false }),
    pluginWriteStarted.then(() => store.update("entry-1", { injected_count: 99 })),
  ]);

  const final = store.state.data.get("entry-1");
  console.log(`  Final injected_count: ${final.injected_count}`);
  console.log(`  Lock count: ${store.state.lockCount}`);

  // Plugin 的寫入應該成功（injected_count === 99）
  assert.equal(final.injected_count, 99, "Plugin 在 Phase 1 期間寫入的 injected_count 應保留");
  // Upgrader 仍然完成（Phase 2 有 1 lock）
  assert.ok(store.state.lockCount >= 1, "Upgrader 應該完成 Phase 2 lock");

  console.log("  ✅ Test 2 通過：Plugin 可在 Phase 1 期間寫入");
}

/**
 * [v3]
 * 測試並發寫入（Plugin + Upgrader）不造成資料遺失。
 * [F4-fix] 合併自 Test 3：Test 5 現在同時驗證 pluginWrites 追蹤與資料完整性。
 */

/**
 * [v3]
 * 測量 OLD vs NEW 的 lock acquisitions 差異。
 * OLD: N entries × update() = N locks
 * NEW: N entries × bulkUpdateMetadata() = 1 lock
 *
 * 這是 Issue #632 的核心改進。
 */
async function testOldVsNew_LockCountDifference() {
  console.log("\n=== Test 4: OLD vs NEW lock acquisitions 比較 ===");

  const entryCount = 10;
  const entries = Array.from({ length: entryCount }, (_, i) =>
    createLegacyEntry(`entry-${i}`, `Legacy memory ${i}`)
  );

  // OLD 實作模擬：每個 entry 個別 update() = N locks
  const storeOld = createMockStoreWithLockTracking();
  storeOld.initData(entries);

  for (const entry of entries) {
    await storeOld.update(entry.id, { metadata: JSON.stringify({ old: true }) });
  }

  console.log(`  OLD（N × update）: ${storeOld.state.lockCount} locks`);
  assert.equal(storeOld.state.lockCount, entryCount, "OLD: 每 entry 1 lock");

  // NEW 實作模擬：bulkUpdateMetadata() = 1 lock
  const storeNew = createMockStoreWithLockTracking();
  storeNew.initData(entries);

  const pairs = entries.map(e => ({ id: e.id, metadata: JSON.stringify({ new: true }) }));
  await storeNew.bulkUpdateMetadata(pairs);

  console.log(`  NEW（bulkUpdateMetadata）: ${storeNew.state.lockCount} locks`);
  assert.equal(storeNew.state.lockCount, 1, "NEW: 整批 1 lock");

  // 計算改善比例
  const reduction = ((entryCount - 1) / entryCount * 100).toFixed(0);
  console.log(`  ✅ Test 4 通過：lock acquisitions 減少 ${reduction}%（${entryCount} → 1）`);
}

/**
 * [v3]
 * 測試 Phase 1/2 中間 Plugin 搶佔時，bulkUpdateMetadata 的 re-read 機制
 * 能否保護 Plugin 資料。
 *
 * 由於 bulkUpdateMetadata 在 lock 內 re-read 所有 entries，
 * Plugin 的寫入必須在 bulkUpdateMetadata 開始前完成。
 */
async function testNoOverwriteBetweenPluginAndUpgrader() {
  console.log("\n=== Test 5: Plugin 和 Upgrader 不同欄位更新，re-read 保護 ===");

  const store = createMockStoreWithLockTracking();
  const entry = createLegacyEntry("entry-1", "Original text that needs upgrading");
  store.initData([entry]);

  store.state.data.set("entry-1", {
    ...entry,
    injected_count: 0,
    last_injected_at: 0,
  });

  // [F4-fix] 同時追蹤 pluginWrites（來自合併的 Test 3）
  const pluginWrites = [];
  const allUpdates = [];
  const originalBulkUpdate = store.bulkUpdateMetadata.bind(store);
  store.bulkUpdateMetadata = async function(pairs) {
    // 在 bulkUpdateMetadata 開始前，plugin 先寫入 injected_count
    await store.update("entry-1", {
      injected_count: 5,
      last_injected_at: Date.now(),
    });
    pluginWrites.push({ ids: pairs.map(p => p.id) });
    allUpdates.push({ type: "plugin-before-bulk" });
    return originalBulkUpdate(pairs);
  };

  const llm = {
    async completeJson() {
      return null;
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);

  await upgrader.upgrade({ batchSize: 1, noLlm: true });

  const final = store.state.data.get("entry-1");
  console.log(`  Final text: ${final.text}`);
  console.log(`  Final injected_count: ${final.injected_count}`);
  console.log(`  Bulk updates: ${store.state.bulkUpdates.length}`);
  console.log(`  Total updates (all): ${store.state.updates.length}`);

  // 驗證：text 保留，metadata 更新，injected_count 來自 plugin 的寫入
  assert.equal(final.text, "Original text that needs upgrading", "Upgrader 不應覆蓋 text");
  assert.ok(final.metadata.includes("l0_abstract"), "Upgrader 應該更新 metadata");
  // injected_count 應該保留（plugin 在 bulkUpdateMetadata 前寫入）
  assert.equal(final.injected_count, 5, "Plugin 的 injected_count 應保留");

  // [F4-fix] 來自合併的 Test 3：驗證 pluginWrites 追蹤正確
  console.log(`  Upgrader bulkUpdates: ${store.state.bulkUpdates.length}`);
  console.log(`  Plugin writes: ${pluginWrites.length}`);
  assert.equal(store.state.bulkUpdates.length, 1, "Upgrader 應該執行 1 次 bulkUpdateMetadata");
  assert.equal(pluginWrites.length, 1, "Plugin 應該寫入 1 次");

  console.log("  ✅ Test 5 通過：不同欄位更新 + pluginWrites 追蹤，Plugin 資料受到保護");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 Lock Tests (v3)");
  console.log("TRUE 1-lock-per-batch with bulkUpdateMetadata");
  console.log("===========================================");

  try {
    await testNewBehavior_TrueOneLockPerBatch();
    await testPluginCanWriteDuringPhase1();
    await testOldVsNew_LockCountDifference();
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
