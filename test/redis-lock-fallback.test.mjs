// test/redis-lock-fallback.test.mjs
/**
 * Redis Lock Fallback 測試
 * 
 * 測試當 Redis 不可用時，是否會正確 fallback 到 file lock
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { RedisLockManager } = jiti("../src/redis-lock.ts");

describe("Redis Lock Fallback", () => {
  // 測試 1：Redis 不可用時使用 file lock
  it("should fallback to file lock when Redis unavailable", async () => {
    // 故意用一個不會有 Redis 的 URL
    const manager = new RedisLockManager({
      redisUrl: 'redis://localhost:9999', // 不存在的 Redis
      ttl: 5000,
      maxWait: 5000,
    });
    
    const release = await manager.acquire("fallback-test-key");
    
    // 應該成功取得 lock（file lock fallback）
    assert.ok(release, "Should return a release function");
    
    // 執行 release
    await release();
    
    console.log("[Fallback test] Successfully used file lock fallback");
  });

  // 測試 2：多次取得不同 key 的 lock
  it("should handle multiple locks with fallback", async () => {
    const manager = new RedisLockManager({
      redisUrl: 'redis://localhost:9999',
      ttl: 3000,
    });
    
    const locks = [];
    for (let i = 0; i < 3; i++) {
      const release = await manager.acquire(`fallback-multi-${i}`);
      locks.push(release);
    }
    
    // 應該成功取得 3 個 lock
    assert.strictEqual(locks.length, 3, "Should acquire 3 locks");
    
    // 全部 release
    for (const release of locks) {
      await release();
    }
    
    console.log("[Fallback test] Multiple locks handled successfully");
  });

  // 測試 3：file lock 的 TTL 行為
  it("should respect TTL in file lock fallback", async () => {
    const shortTTL = 1000; // 1 秒
    
    const manager = new RedisLockManager({
      redisUrl: 'redis://localhost:9999',
      ttl: shortTTL,
    });
    
    const release = await manager.acquire("fallback-ttl-test");
    
    // 等待 TTL 過期
    await new Promise(r => setTimeout(r, shortTTL + 500));
    
    // 應該可以再次取得同一個 key（因為 TTL 過期了）
    const release2 = await manager.acquire("fallback-ttl-test");
    
    await release();
    await release2();
    
    console.log("[Fallback test] TTL respected in file lock");
  });
});

console.log("=== Redis Lock Fallback Tests ===");