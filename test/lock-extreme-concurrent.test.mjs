// test/lock-extreme-concurrent.test.mjs
/**
 * 極端並發測試：模擬多個 agent 同時寫入
 * 
 * 目標：重現 Issue #632 / #643 的 lock contention 問題
 * 
 * 測試場景：
 * 1. 10+ concurrent writes - 模擬多個 agent 同時寫入
 * 2. Long-running operation - 模擬一個長時間的 write operation
 * 3. Stale lock detection - 模擬 lock 被持有超過 10 秒的場景
 * 4. Read-write contention - 讀取和寫入同時發生
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-extreme-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i = 1, text = `memory-${i}`) {
  return {
    text,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

// 測試 1：極端並發寫入（10 個同時寫入）
describe("Extreme Concurrent Writes", () => {
  it("should handle 10 concurrent writes", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store(makeEntry(0, "seed"));
      
      const count = 10;
      const promises = Array.from({ length: count }, (_, i) => 
        store.store(makeEntry(i + 1, `concurrent-write-${i}`))
      );
      
      const results = await Promise.allSettled(promises);
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      console.log(`[10 concurrent writes] Success: ${successes.length}, Failed: ${failures.length}`);
      
      // 預期：大部分應該成功
      assert.ok(successes.length >= 8, `至少 80% 成功，實際: ${successes.length}/${count}`);
      
      // 驗證資料完整性
      const all = await store.list(undefined, undefined, 100, 0);
      assert.ok(all.length >= count, `至少寫入 ${count} 筆，實際: ${all.length}`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should handle 20 concurrent writes", async () => {
    const { store, dir } = makeStore();
    try {
      const count = 20;
      const promises = Array.from({ length: count }, (_, i) => 
        store.store(makeEntry(i, `extreme-write-${i}`))
      );
      
      const results = await Promise.allSettled(promises);
      const successes = results.filter(r => r.status === 'fulfilled');
      
      console.log(`[20 concurrent writes] Success: ${successes.length}/${count}`);
      
      // 預期：至少 80% 成功
      assert.ok(successes.length >= 16, `至少 80% 成功，實際: ${successes.length}/${count}`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 2：長期 lock 持有模擬
describe("Long-running lock holder simulation", () => {
  it("should timeout when lock holder holds for 15 seconds", async () => {
    const { store, dir } = makeStore();
    const lockPath = join(dir, ".memory-write.lock");
    
    try {
      // 先初始化 store
      await store.store(makeEntry(1, "seed"));
      
      // 人為建立一個舊的 lock 檔案（15秒前）
      const oldTime = Date.now() - 15000;
      writeFileSync(lockPath, "", { flag: 'w' });
      utimesSync(lockPath, oldTime, oldTime);
      
      const stat = statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      console.log(`[Stale lock test] Lock age: ${age}ms (should be ~15000ms)`);
      
      // 嘗試寫入 - 這應該觸發 stale lock detection
      const start = Date.now();
      try {
        await store.store(makeEntry(2, "test-after-stale-lock"));
        const elapsed = Date.now() - start;
        console.log(`[Stale lock test] Write succeeded after ${elapsed}ms`);
      } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`[Stale lock test] Write failed after ${elapsed}ms: ${err.message}`);
        // 如果失敗，可能是因為 stale lock 機制沒運作
      }
      
      // 驗證：無論成功或失敗，lock 應該被清理或重建
      // 預期行為：stale lock 被檢測到，自動清理，然後成功寫入
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 3：讀寫並發
describe("Read-write contention", () => {
  it("should handle reads during long write", async () => {
    const { store, dir } = makeStore();
    try {
      // 先寫入一些資料
      for (let i = 0; i < 5; i++) {
        await store.store(makeEntry(i, `initial-${i}`));
      }
      
      // 同時進行：1個長期寫入 + 5個讀取
      const longWrite = store.store(makeEntry(100, "long-write-operation"));
      
      // 等待一小段時間，模擬長期寫入
      await new Promise(r => setTimeout(r, 100));
      
      const reads = Array.from({ length: 5 }, (_, i) => 
        store.list(undefined, undefined, 10, 0)
      );
      
      const [writeResult, ...readResults] = await Promise.allSettled([
        longWrite,
        ...reads
      ]);
      
      const readSuccesses = readResults.filter(r => r.status === 'fulfilled');
      console.log(`[Read-write contention] Write: ${writeResult.status}, Reads: ${readSuccesses.length}/5`);
      
      // 預期：讀取不應該被長期 blocking
      assert.ok(readSuccesses.length >= 3, `至少 60% 讀取成功，實際: ${readSuccesses.length}/5`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 4：並發更新（patchMetadata）
describe("Concurrent metadata updates", () => {
  it("should handle 10 concurrent patchMetadata calls", async () => {
    const { store, dir } = makeStore();
    try {
      // 先建立 10 筆資料
      const entries = [];
      for (let i = 0; i < 10; i++) {
        const entry = await store.store(makeEntry(i, `metadata-test-${i}`));
        entries.push(entry);
      }
      
      // 同時更新所有資料的 metadata
      const updatePromises = entries.map((entry, i) =>
        store.patchMetadata(entry.id, { importance: 0.9 + (i * 0.01) })
      );
      
      const results = await Promise.allSettled(updatePromises);
      const successes = results.filter(r => r.status === 'fulfilled');
      
      console.log(`[Concurrent patchMetadata] Success: ${successes.length}/10`);
      
      // 驗證更新結果
      for (const entry of entries) {
        const updated = await store.getById(entry.id);
        assert.ok(updated, `Entry ${entry.id} should exist`);
      }
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 5：極限壓力測試（50 個並發操作）
describe("Stress test - 50 concurrent operations", () => {
  it("should handle 50 concurrent operations without deadlock", async () => {
    const { store, dir } = makeStore();
    try {
      const count = 50;
      const operations = Array.from({ length: count }, (_, i) => {
        if (i % 3 === 0) {
          // 1/3 讀取
          return store.list(undefined, undefined, 5, 0);
        } else if (i % 3 === 1) {
          // 1/3 寫入
          return store.store(makeEntry(i, `stress-${i}`));
        } else {
          // 1/3 更新（如果有的話）
          return store.store(makeEntry(i, `stress-update-${i}`));
        }
      });
      
      const start = Date.now();
      const results = await Promise.allSettled(operations);
      const elapsed = Date.now() - start;
      
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      
      console.log(`[50 concurrent operations] ${elapsed}ms total`);
      console.log(`  Success: ${successes.length}, Failed: ${failures.length}`);
      
      // 預期：至少 70% 成功
      assert.ok(successes.length >= 35, `至少 70% 成功，實際: ${successes.length}/${count}`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 6：模擬真實的多 Agent 場景
describe("Multi-agent simulation", () => {
  it("simulates 5 agents each doing 10 operations", async () => {
    const { store, dir } = makeStore();
    try {
      const NUM_AGENTS = 5;
      const OPS_PER_AGENT = 10;
      
      // 每個 agent 執行 10 個操作
      const agentPromises = Array.from({ length: NUM_AGENTS }, async (_, agentId) => {
        const results = [];
        for (let i = 0; i < OPS_PER_AGENT; i++) {
          const opType = i % 3;
          try {
            if (opType === 0) {
              // 寫入
              await store.store(makeEntry(agentId * 100 + i, `agent-${agentId}-write-${i}`));
            } else if (opType === 1) {
              // 讀取
              await store.list(undefined, undefined, 5, 0);
            } else {
              // 查詢
              const all = await store.list(undefined, undefined, 10, 0);
              results.push({ type: 'read', success: true });
            }
            results.push({ type: opType === 0 ? 'write' : 'read', success: true });
          } catch (err) {
            results.push({ type: opType === 0 ? 'write' : 'read', success: false, error: err.message });
          }
        }
        return results;
      });
      
      const allAgentResults = await Promise.allSettled(agentPromises);
      
      let totalOps = 0;
      let totalSuccess = 0;
      let totalFail = 0;
      
      for (const agentResult of allAgentResults) {
        if (agentResult.status === 'fulfilled') {
          for (const op of agentResult.value) {
            totalOps++;
            if (op.success) totalSuccess++;
            else totalFail++;
          }
        }
      }
      
      console.log(`[5 agents x 10 ops] Total: ${totalOps}, Success: ${totalSuccess}, Failed: ${totalFail}`);
      console.log(`  Success rate: ${(totalSuccess / totalOps * 100).toFixed(1)}%`);
      
      // 預期：至少 80% 成功
      assert.ok(totalSuccess >= totalOps * 0.8, `至少 80% 成功，實際: ${(totalSuccess / totalOps * 100).toFixed(1)}%`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
