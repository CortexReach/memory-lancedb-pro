// test/lock-bottleneck-identification.test.mjs
/**
 * Lock Bottleneck 識別測試
 * 
 * 目標：找出確切的失敗點在哪裡
 * 
 * 測試策略：
 * 1. 測量 lock 取得時間
 * 2. 測量重試次數
 * 3. 測量 total operation 時間
 * 4. 找出瓶頸在哪個階段
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-bottleneck-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i = 1) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

// 測試 1：測量單一寫入的各階段時間
describe("Measure single write latency", () => {
  it("should measure phases of a single write operation", async () => {
    const { store, dir } = makeStore();
    try {
      const phases = {
        storeCallStart: 0,
        storeCallEnd: 0,
        totalMs: 0,
      };
      
      // 測量 store() 花的時間
      phases.storeCallStart = Date.now();
      await store.store(makeEntry(1));
      phases.storeCallEnd = Date.now();
      phases.totalMs = phases.storeCallEnd - phases.storeCallStart;
      
      console.log(`[Single write] Total: ${phases.totalMs}ms`);
      
      // 預期：小於 500ms
      assert.ok(phases.totalMs < 500, `單一寫入應該 < 500ms，實際: ${phases.totalMs}ms`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 2：測量並發時的 lock 取得時間
describe("Measure lock acquisition time", () => {
  it("should measure time to acquire lock under contention", async () => {
    const { store, dir } = makeStore();
    const lockPath = join(dir, ".memory-write.lock");
    
    try {
      // 先建立一個 hold lock 的 operation（在背景）
      const holdLock = async () => {
        // 模擬長期 lock 持有
        await new Promise(r => setTimeout(r, 2000));
        await store.store(makeEntry(999));
      };
      
      // 同時嘗試多個 writes
      const attempts = Array.from({ length: 5 }, (_, i) => {
        const start = Date.now();
        return store.store(makeEntry(i + 100)).then(() => ({
          id: i,
          success: true,
          waitMs: Date.now() - start,
        })).catch(err => ({
          id: i,
          success: false,
          waitMs: Date.now() - start,
          error: err.message,
        }));
      });
      
      // 啟動 hold lock
      holdLock();
      
      // 等待所有 attempts
      const results = await Promise.all(attempts);
      
      // 分析每個 attempt 的等待時間
      console.log(`[Lock contention] 等待時間分佈:`);
      for (const r of results) {
        console.log(`  Attempt ${r.id}: ${r.waitMs}ms ${r.success ? '✅' : '❌ ' + r.error}`);
      }
      
      const successes = results.filter(r => r.success);
      console.log(`[Result] ${successes.length}/5 成功`);
      
      // 預期：部分成功（取決於重試機制）
      assert.ok(successes.length >= 1, `至少 1 個成功，實際: ${successes.length}`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 3：測試不同的重試參數效果
describe("Test retry parameter variations", () => {
  // 測試 A：減少 timeout，增多重試
  async function runWithConfig(retries, minTimeout, maxTimeout) {
    const { store, dir } = makeStore();
    const results = [];
    
    const ops = Array.from({ length: 15 }, (_, i) => store.store(makeEntry(i)));
    const start = Date.now();
    const settled = await Promise.allSettled(ops);
    const elapsed = Date.now() - start;
    
    const successes = settled.filter(r => r.status === 'fulfilled').length;
    return { successes, elapsed, total: ops.length };
  }
  
  it("should compare current vs longer timeout", async () => {
    // 目前配置 (retries: 10, min: 1000, max: 30000)
    const result1 = await runWithConfig(10, 1000, 30000);
    console.log(`[Config 1] retries=10, timeout=30s => ${result1.successes}/${result1.total} (${result1.elapsed}ms)`);
    
    // 這個測試無法修改 runtime 參數，因為 lockfile 是在初始化時配置的
    // 但可以記錄差異
    
    // 預期：15 個 concurrent 應該有顯著失敗
    assert.ok(result1.successes < 15, `應該有些失敗，實際: ${result1.successes}`);
  });
});

// 測試 4：測試 lock 競爭的臨界點
describe("Find the contention threshold", () => {
  it("should find the exact concurrency threshold", async () => {
    const thresholds = [];
    
    // 測試不同並發數
    for (const count of [3, 5, 8, 10, 12, 15, 20]) {
      const { store, dir } = makeStore();
      
      const ops = Array.from({ length: count }, (_, i) => store.store(makeEntry(i)));
      const start = Date.now();
      const settled = await Promise.allSettled(ops);
      const elapsed = Date.now() - start;
      
      const successes = settled.filter(r => r.status === 'fulfilled').length;
      const rate = (successes / count * 100).toFixed(0);
      
      thresholds.push({ count, successes, rate, elapsed });
      console.log(`[${count} concurrent] ${successes}/${count} (${rate}%) in ${elapsed}ms`);
      
      rmSync(dir, { recursive: true, force: true });
    }
    
    console.log(`\n[Threshold analysis]`);
    for (const t of thresholds) {
      const status = t.rate >= 80 ? '✅' : '❌';
      console.log(`  ${t.count} ops: ${t.rate}% ${status}`);
    }
    
    // 找出臨界點：低於 80% 成功的並發數
    const failing = thresholds.find(t => t.rate < 80);
    console.log(`\n[Critical point] 當並發數 >= ${failing.count} 時，開始低於 80% 成功率`);
  });
});

// 測試 5：測量 write vs patch 的 lock 使用差異
describe("Compare write vs patch lock usage", () => {
  it("should show that patchMetadata also causes contention", async () => {
    const { store, dir } = makeStore();
    
    try {
      // 先建立 10 筆資料
      const entries = [];
      for (let i = 0; i < 10; i++) {
        const entry = await store.store(makeEntry(i));
        entries.push(entry);
      }
      
      // 同時 patch 10 筆
      const patchOps = entries.map(e => 
        store.patchMetadata(e.id, { test: true })
      );
      
      const start = Date.now();
      const settled = await Promise.allSettled(patchOps);
      const elapsed = Date.now() - start;
      
      const successes = settled.filter(r => r.status === 'fulfilled').length;
      console.log(`[10 concurrent patchMetadata] ${successes}/10 in ${elapsed}ms`);
      
      // 預期：應該也會有競爭
      assert.ok(successes >= 5, `至少 50% 成功，實際: ${successes}/10`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 測試 6：測試讀取是否真的不需要 lock
describe("Verify read operations are truly lock-free", () => {
  it("should show reads are NOT blocked by writes", async () => {
    const { store, dir } = makeStore();
    
    try {
      // 先建立資料
      for (let i = 0; i < 5; i++) {
        await store.store(makeEntry(i));
      }
      
      // 同時：1個長期寫入 + 5個讀取
      const longWrite = (async () => {
        await new Promise(r => setTimeout(r, 1000));
        await store.store(makeEntry(999));
      })();
      
      const reads = Array.from({ length: 5 }, (_, i) => {
        const start = Date.now();
        return store.list(undefined, undefined, 5, 0).then(() => ({
          success: true,
          waitMs: Date.now() - start,
        })).catch(err => ({
          success: false,
          waitMs: Date.now() - start,
          error: err.message,
        }));
      });
      
      const [writeResult, ...readResults] = await Promise.allSettled([longWrite, ...reads]);
      
      const successfulReads = readResults.filter(r => r.status === 'fulfilled');
      console.log(`[Read during write] ${successfulReads.length}/5 read OK`);
      
      // 預期：讀取不應該被長期 blocking
      // 但在當前實現，讀取也受影響！這就是 bug！
      for (const r of readResults) {
        if (r.status === 'fulfilled') {
          console.log(`  Read: ${r.value.waitMs}ms`);
        } else {
          console.log(`  Read failed: ${r.reason.message}`);
        }
      }
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});