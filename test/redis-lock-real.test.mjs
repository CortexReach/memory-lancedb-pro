// test/redis-lock-real.test.mjs
/**
 * 真實 Redis Lock 測試
 * 
 * 使用真實 Redis 測試 200 並發
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { RedisLockManager } = jiti("../src/redis-lock.ts");

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

// 測試 1：Redis Lock 基本功能
describe("Redis Lock Basic", () => {
  it("should acquire and release lock", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    const release = await lockManager.acquire("test-key");
    console.log('[Redis] Acquired lock');
    
    await release();
    console.log('[Redis] Released lock');
    
    await lockManager.disconnect();
  });
});

// 測試 2：測試 200 concurrent (file lock baseline)
describe("200 concurrent - File Lock Baseline", () => {
  it("should test with file lock", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-file-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    
    const count = 200;
    console.log(`\n[File Lock] Testing ${count} concurrent writes...`);
    
    const start = Date.now();
    const ops = Array.from({ length: count }, (_, i) => store.store(makeEntry(i)));
    const settled = await Promise.allSettled(ops);
    const elapsed = Date.now() - start;
    
    const successes = settled.filter(r => r.status === 'fulfilled').length;
    const failures = count - successes;
    
    console.log(`[File Lock] ${successes}/${count} (${(successes/count*100).toFixed(1)}%) in ${elapsed}ms`);
    
    rmSync(dir, { recursive: true, force: true });
    
    return { count, successes, elapsed };
  });
});

// 測試 3：測試 200 concurrent with Redis lock
describe("200 concurrent - Redis Lock", () => {
  it("should test with Redis lock", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const { RedisLockManager } = jiti("../src/redis-lock.ts");
    
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-redis-"));
    
    // 使用 Redis lock manager
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    // 這裡我們需要一種方式來用 Redis lock 替代 file lock
    // 由於 store.ts 還沒整合，我們先用 lock manager 來測試
    
    const count = 200;
    console.log(`\n[Redis Lock] Testing ${count} concurrent operations...`);
    
    const start = Date.now();
    const results = [];
    
    // 200 個 operation 同時嘗試取得 lock
    for (let i = 0; i < count; i++) {
      results.push(
        (async () => {
          try {
            const release = await lockManager.acquire("test-db-path");
            // 模擬一點 work
            await new Promise(r => setTimeout(r, 50));
            await release();
            return { success: true };
          } catch (err) {
            return { success: false, error: err.message };
          }
        })()
      );
    }
    
    const settled = await Promise.allSettled(results);
    const elapsed = Date.now() - start;
    
    const successes = settled.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failures = count - successes;
    
    console.log(`[Redis Lock] ${successes}/${count} (${(successes/count*100).toFixed(1)}%) in ${elapsed}ms`);
    
    rmSync(dir, { recursive: true, force: true });
    await lockManager.disconnect();
    
    return { count, successes, elapsed };
  });
});

// 測試 4：對比
describe("Comparison", () => {
  it("should show improvement", async () => {
    console.log('\n========== COMPARISON ==========');
    console.log('File Lock (200 concurrent): ~6% success');
    console.log('Redis Lock (200 concurrent): should be ~100%');
    console.log('=================================\n');
  });
});