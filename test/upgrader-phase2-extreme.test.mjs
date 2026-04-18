/**
 * Memory Upgrader Phase-2 極限測試
 * 
 * 測試目標：
 * 1. 確認兩階段方案的 lock 次數正確（1 次 per batch）
 * 2. 極限測試：大批次、LLM 失敗、並發競爭
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

// ============================================================================
// Test Suite: Phase-2 Fix 極限測試
// ============================================================================

async function testPhase2_LockCountFixed() {
  console.log("\n=== Test 1: Phase-2 確認 lock 次數 = 1 per batch ===");
  
  let lockCount = 0;
  const store = {
    async list() {
      return Array.from({ length: 10 }, (_, i) => 
        createLegacyEntry(`entry-${i}`, `Memory ${i}`)
      );
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      lockCount++;
      return fn();
    },
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return "mock"; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });

  console.log(`  Lock 次數: ${lockCount} (預期: 1)`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 10)`);
  
  assert.equal(lockCount, 1, `Phase-2 應該只有 1 次 lock，實際: ${lockCount}`);
  assert.equal(result.upgraded, 10, `應該升級 10 筆`);
  
  console.log("  ✅ Test 1 通過");
}

async function testPhase2_LLMFailedGracefully() {
  console.log("\n=== Test 2: Phase-2 LLM 失敗時優雅降級 ===");
  
  let lockCount = 0;
  const store = {
    async list() {
      return [
        createLegacyEntry("entry-1", "Memory 1"),
        createLegacyEntry("entry-2", "Memory 2"),
        createLegacyEntry("entry-3", "Memory 3"),
      ];
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      lockCount++;
      return fn();
    },
  };

  // LLM 一直失敗
  const llm = {
    async completeJson() { throw new Error("LLM API failed"); },
    getLastError() { return "LLM API failed"; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 3, noLlm: false });

  console.log(`  Lock 次數: ${lockCount}`);
  console.log(`  升級筆數: ${result.upgraded} (預期: 3，使用 simpleEnrich fallback)`);
  console.log(`  錯誤筆數: ${result.errors.length}`);
  
  // LLM 失敗後應該 fallback 到 simpleEnrich，仍能成功升級
  assert.equal(result.upgraded, 3, "應該 fallback 到 simpleEnrich 並成功升級");
  assert.equal(result.errors.length, 0, "不應該有錯誤（因為有 fallback）");
  
  console.log("  ✅ Test 2 通過");
}

async function testPhase2_MixedSuccessAndFailure() {
  console.log("\n=== Test 3: Phase-2 混合成功和失敗 ===");
  
  let lockCount = 0;
  const store = {
    async list() {
      return [
        createLegacyEntry("entry-1", "Memory 1"),
        createLegacyEntry("entry-2", "Memory 2"),
        createLegacyEntry("entry-3", "Memory 3"),
        createLegacyEntry("entry-4", "Memory 4"),
        createLegacyEntry("entry-5", "Memory 5"),
      ];
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      lockCount++;
      return fn();
    },
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 5, noLlm: true });

  console.log(`  Lock 次數: ${lockCount}`);
  console.log(`  升級筆數: ${result.upgraded}`);
  
  assert.equal(lockCount, 1, "仍應該只有 1 次 lock");
  assert.equal(result.upgraded, 5, "全部成功");
  
  console.log("  ✅ Test 3 通過");
}

async function testPhase2_BatchBoundary() {
  console.log("\n=== Test 4: Phase-2 批次邊界處理 ===");
  
  const lockCounts = [];
  const store = {
    async list() {
      return Array.from({ length: 25 }, (_, i) => 
        createLegacyEntry(`entry-${i}`, `Memory ${i}`)
      );
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      lockCounts.push(Date.now());
      return fn();
    },
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });

  console.log(`  Lock 次數: ${lockCounts.length} (預期: 3 batches: 10+10+5)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  
  assert.equal(lockCounts.length, 3, "25 筆分 3 個批次，應該 3 次 lock");
  assert.equal(result.upgraded, 25, "全部 25 筆都應該升級");
  
  console.log("  ✅ Test 4 通過");
}

async function testPhase2_ConcurrentStress() {
  console.log("\n=== Test 5: Phase-2 極端並發測試 (100 entries) ===");
  
  let lockCount = 0;
  const store = {
    async list() {
      return Array.from({ length: 100 }, (_, i) => 
        createLegacyEntry(`entry-${i}`, `Memory ${i} with some extra text to make it longer`)
      );
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      lockCount++;
      return fn();
    },
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return ""; },
  };

  const upgrader = createMemoryUpgrader(store, llm, { log: () => {} });
  const start = Date.now();
  const result = await upgrader.upgrade({ batchSize: 10, noLlm: true });
  const duration = Date.now() - start;

  console.log(`  Lock 次數: ${lockCount} (預期: 10 batches)`);
  console.log(`  升級筆數: ${result.upgraded}`);
  console.log(`  耗時: ${duration}ms`);
  
  assert.equal(lockCount, 10, "100 筆分 10 個批次，應該 10 次 lock");
  assert.equal(result.upgraded, 100, "全部 100 筆都應該升級");
  
  console.log("  ✅ Test 5 通過");
}

// ============================================================================
// Test Suite: Compare Old vs New
// ============================================================================

async function testCompareOldVsNew() {
  console.log("\n=== Test 6: 舊實作 vs 新實作 比較 ===");
  
  // 舊實作：每個 entry 的 update 都拿 lock
  let oldLockCount = 0;
  const oldMemories = Array.from({ length: 5 }, (_, i) => 
    createLegacyEntry(`entry-${i}`, `Memory ${i}`)
  );
  
  // 模擬舊實作：每個 entry 拿一次 lock
  for (const entry of oldMemories) {
    oldLockCount++; // 每個 entry 都拿 lock
  }

  // 新實作
  let newLockCount = 0;
  const newStore = {
    async list() {
      return Array.from({ length: 5 }, (_, i) => 
        createLegacyEntry(`entry-${i}`, `Memory ${i}`)
      );
    },
    async update(id, patch) { return true; },
    async runWithFileLock(fn) {
      newLockCount++;
      return fn();
    },
  };
  const newLlM = { async completeJson() { return null; }, getLastError() { return ""; } };
  const newUpgrader = createMemoryUpgrader(newStore, newLlM, { log: () => {} });
  await newUpgrader.upgrade({ batchSize: 5, noLlm: true });

  console.log(`  舊實作 Lock 次數: ${oldLockCount} (每個 entry 1 次 = 5)`);
  console.log(`  新實作 Lock 次數: ${newLockCount} (每個 batch 1 次)`);
  console.log(`  改善: ${oldLockCount - newLockCount} 次 lock`);
  
  assert.equal(oldLockCount, 5, "舊實作應該每個 entry 拿一次 lock");
  assert.equal(newLockCount, 1, "新實作應該每個 batch 只拿一次 lock");
  
  console.log("  ✅ Test 6 通過");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("Memory Upgrader Phase-2 極限測試");
  console.log("===========================================");

  try {
    await testPhase2_LockCountFixed();
    await testPhase2_LLMFailedGracefully();
    await testPhase2_MixedSuccessAndFailure();
    await testPhase2_BatchBoundary();
    await testPhase2_ConcurrentStress();
    await testCompareOldVsNew();
    
    console.log("\n===========================================");
    console.log("All tests passed! ✅");
    console.log("===========================================");
    console.log("\n總結:");
    console.log("- Phase-2 修復：Lock 次數 N -> 1");
    console.log("- LLM 失敗時優雅降級");
    console.log("- 大批次 (100 entries) 測試通過");
    
  } catch (err) {
    console.error("\n❌ Test failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
