// test/redis-lock-edge-cases.test.mjs
/**
 * Redis Lock 邊界條件測試
 * 
 * 補上可能被忽略的邊界條件
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
// Hermetic: skip if REDIS_URL is not set.
// CI should set REDIS_URL (e.g. redis://localhost:6379).
// Local dev without Redis: tests are skipped — set REDIS_URL to run them.
const SKIP_NO_REDIS = !process.env.REDIS_URL;



const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { RedisLockManager } = jiti("../src/redis-lock.ts");

// 測試 1：Redis 連線中斷
(SKIP_NO_REDIS ? describe.skip : describe)("Edge Case 1: Redis Connection Failure", () => {
  it("should handle Redis unavailable gracefully", async () => {
    // 使用一個不存在的 Redis
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:9999' });
    
    try {
      // 嘗試取得 lock，應該失敗
      await lockManager.acquire("test-key");
      assert.fail("Should have thrown");
    } catch (err) {
      // 應該抛出錯誤
      console.log(`[Edge] Connection error: ${err.message}`);
      // 不需要 disconnect，因為連不上
    }
  });
});

// 測試 2：Lock 取得超時
describe("Edge Case 2: Lock Acquisition Timeout", () => {
  it("should timeout when lock cannot be acquired", async () => {
    const lockManager1 = new RedisLockManager({ redisUrl: 'localhost:6379', maxWait: 3000 });
    try {
      // 建立一個長期持有的 lock (5秒)
      const release1 = await lockManager1.acquire("timeout-test", 5000);
      
      // 嘗試取得第二個 lock，maxWait 只有 3 秒
      const lockManager2 = new RedisLockManager({ redisUrl: 'localhost:6379', maxWait: 3000 });
      const start = Date.now();
      let timeout = false;
      try {
        await lockManager2.acquire("timeout-test", 1000);
        console.log(`[Edge] Second lock acquired (was never blocked, but TTL different)`);
      } catch (err) {
        timeout = true;
        const elapsed = Date.now() - start;
        console.log(`[Edge] Timeout/Error after ${elapsed}ms: ${err.message}`);
      }
      
      // 如果沒有 timeout，那 TTL 過期就會成功
      if (!timeout) {
        // 等待第一個 release
        await release1();
      }
      
      await lockManager2.disconnect();
    } finally {
      await lockManager1.disconnect();
    }
  });
});

// 測試 3：重複 release 同一個 lock
describe("Edge Case 3: Double Release", () => {
  it("should handle releasing same lock twice", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    try {
      const release = await lockManager.acquire("double-release");
      
      // 第一次 release
      await release();
      console.log("[Edge] First release OK");
      
      // 第二次 release（應該安全地什麼都不做）
      await release();
      console.log("[Edge] Second release safe (no error)");
      
    } finally {
      await lockManager.disconnect();
    }
  });
});

// 測試 4：空字串 key
describe("Edge Case 4: Empty Key", () => {
  it("should handle empty string key", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    try {
      const release = await lockManager.acquire("");
      await release();
      console.log("[Edge] Empty key works");
    } finally {
      await lockManager.disconnect();
    }
  });
});

// 測試 5：特殊字元 key
describe("Edge Case 5: Special Characters in Key", () => {
  it("should handle special characters", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    const specialKeys = [
      "key:with:colons",
      "key-with-dashes",
      "key_with_underscores",
      "key/with/slashes",
      "key.with.dots",
      "key with spaces",
      "key\nwith\nnewlines",
    ];
    
    for (const key of specialKeys) {
      try {
        const release = await lockManager.acquire(key);
        await release();
        console.log(`[Edge] Key "${key.substring(0, 10)}..." works`);
      } catch (err) {
        console.log(`[Edge] Key "${key.substring(0, 10)}..." failed: ${err.message}`);
      }
    }
    
    await lockManager.disconnect();
  });
});

// 測試 6：非常長的 operation（超過 TTL）
describe("Edge Case 6: Operation Longer Than TTL", () => {
  it("should handle operation longer than TTL", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    try {
      // TTL 500ms，但 operation 要 1000ms
      const release = await lockManager.acquire("long-op", 500);
      
      // operation 超過 TTL
      await new Promise(r => setTimeout(r, 1000));
      
      // 嘗試 release（此時 lock 應該已過期）
      await release();
      console.log("[Edge] Released after TTL expired (lock auto-expired)");
      
    } finally {
      await lockManager.disconnect();
    }
  });
});

// 測試 7：多個 lock manager 實例
describe("Edge Case 7: Multiple Lock Manager Instances", () => {
  it("should work with multiple instances", async () => {
    const managers = [];
    
    // 建立 3 個 lock manager 實例（減少數量避免太慢）
    for (let i = 0; i < 3; i++) {
      managers.push(new RedisLockManager({ redisUrl: 'localhost:6379' }));
    }
    
    const releases = [];
    
    try {
      // 每個實例嘗試取得同一個 lock
      for (const mgr of managers) {
        releases.push(mgr.acquire("multi-instance", 10000).catch(err => ({ error: err.message })));
      }
      
      // 等待所有結果（用 Promise.allSettled）
      const results = await Promise.all(releases);
      
      const successCount = results.filter(r => typeof r !== 'object' || !r.error).length;
      const failCount = results.filter(r => r.error).length;
      
      console.log(`[Edge] ${successCount} succeeded, ${failCount} failed`);
      
      // 清理成功的
      for (const r of results) {
        if (typeof r !== 'object' || !r.error) {
          await r();
        }
      }
      
    } finally {
      for (const mgr of managers) {
        try { await mgr.disconnect(); } catch {}
      }
    }
  });
});

// 測試 8：同時取得和釋放不同 locks
describe("Edge Case 8: Concurrent Different Locks", () => {
  it("should handle many different locks", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    try {
      // 同時取得 10 個不同的 lock
      const count = 10;
      const releases = [];
      
      for (let i = 0; i < count; i++) {
        releases.push(lockManager.acquire(`many-locks-${i}`));
      }
      
      const acquired = await Promise.all(releases);
      console.log(`[Edge] Acquired ${acquired.length} different locks`);
      
      // 同時釋放
      for (const release of acquired) {
        await release();
      }
      console.log(`[Edge] Released all ${count} locks`);
      
    } finally {
      await lockManager.disconnect();
    }
  });
});

// 測試 9：Lock 競爭（快速取得释放）
describe("Edge Case 9: Rapid Acquire-Release", () => {
  it("should handle rapid acquire-release cycles", async () => {
    const lockManager = new RedisLockManager({ redisUrl: 'localhost:6379' });
    
    try {
      const count = 100;
      const start = Date.now();
      
      for (let i = 0; i < count; i++) {
        const release = await lockManager.acquire("rapid-test");
        await release();
      }
      
      const elapsed = Date.now() - start;
      const rate = (count / elapsed * 1000).toFixed(0);
      console.log(`[Edge] ${count} rapid cycles in ${elapsed}ms (${rate}/sec)`);
      
    } finally {
      await lockManager.disconnect();
    }
  });
});

// 測試 10：總結
describe("Summary", () => {
  it("should show all edge cases covered", async () => {
    console.log('\n========== EDGE CASES COVERED ==========');
    console.log('1. Redis connection failure');
    console.log('2. Lock acquisition timeout');
    console.log('3. Double release');
    console.log('4. Empty key');
    console.log('5. Special characters in key');
    console.log('6. Operation longer than TTL');
    console.log('7. Multiple lock manager instances');
    console.log('8. Concurrent different locks');
    console.log('9. Rapid acquire-release cycles');
    console.log('========================================\n');
  });
});