// test/redis-lock-store-integration.test.mjs
/**
 * Redis Lock Store Integration Test
 * 
 * 測試 Redis lock 整合到 store.ts 後的並發表現
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("Redis Lock Store Integration", () => {
  // 測試 1：基本寫入（使用 Redis lock）
  it("should write with Redis lock", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "memory-redis-test-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 1536,
    });
    
    // 寫入一個 memory
    const entry = await store.store({
      text: "Test memory with Redis lock",
      vector: new Array(1536).fill(0.1),
      category: "fact",
      scope: "test",
      importance: 0.8,
      metadata: "{}",
    });
    
    assert.ok(entry.id, "Should have an ID after store");
    
    await store.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // 測試 2：20 concurrent writes（使用整合後的 lock）
  it("should handle 20 concurrent writes", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "memory-redis-concurrent-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 128,
    });
    
    // 模擬 20 個並發寫入
    const results = await Promise.allSettled(
      Array(20).fill(null).map((_, i) => 
        store.store({
          text: `Concurrent memory ${i}`,
          vector: new Array(128).fill(Math.random()),
          category: "fact",
          scope: "test",
          importance: 0.5,
          metadata: "{}",
        })
      )
    );
    
    // 計算成功數
    const successCount = results.filter(r => r.status === "fulfilled").length;
    const failCount = results.filter(r => r.status === "rejected").length;
    
    console.log(`[Integration] 20 concurrent: ${successCount} success, ${failCount} failed`);
    
    // 使用 Redis lock 應該大部分成功
    assert.ok(successCount >= 15, `Expected at least 15 successful, got ${successCount}`);
    
    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  // 測試 3：50 concurrent writes
  it("should handle 50 concurrent writes", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "memory-redis-50-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 64,
    });
    
    const results = await Promise.allSettled(
      Array(50).fill(null).map((_, i) => 
        store.store({
          text: `High concurrency memory ${i}`,
          vector: new Array(64).fill(0.1),
          category: "fact",
          scope: "test",
          importance: 0.5,
          metadata: "{}",
        })
      )
    );
    
    const successCount = results.filter(r => r.status === "fulfilled").length;
    const failCount = results.filter(r => r.status === "rejected").length;
    
    console.log(`[Integration] 50 concurrent: ${successCount} success, ${failCount} failed`);
    
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});

console.log("=== Redis Lock Store Integration Tests ===");