// test/bulk-store.test.mjs
/**
 * Bulk Store Test
 * 
 * 測試 bulkStore 是否正確運作
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("bulkStore", () => {
  it("should store multiple entries with single lock", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-store-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 8,
    });
    
    const entries = Array(10).fill(null).map((_, i) => ({
      text: `Bulk test memory ${i}`,
      vector: new Array(8).fill(0.1),
      category: "fact",
      scope: "test",
      importance: 0.5,
      metadata: "{}",
    }));
    
    const start = Date.now();
    const stored = await store.bulkStore(entries);
    const duration = Date.now() - start;
    
    console.log(`[bulkStore] ${entries.length} entries stored in ${duration}ms`);
    console.log(`[bulkStore] First id: ${stored[0].id}`);
    
    assert.strictEqual(stored.length, 10);
    assert.ok(stored[0].id.length > 0);
  });

  it("should handle empty array", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-empty-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    const result = await store.bulkStore([]);
    assert.strictEqual(result.length, 0);
    console.log("[Edge] Empty array handled correctly");
  });

  it("should handle single entry", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-single-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    const result = await store.bulkStore([{
      text: "Single entry",
      vector: new Array(4).fill(0.1),
      category: "fact",
      scope: "test",
      importance: 0.5,
      metadata: "{}",
    }]);
    
    assert.strictEqual(result.length, 1);
    console.log("[Edge] Single entry handled correctly");
  });

  it("should handle concurrent bulkStore calls", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-concurrent-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    const promises = Array(10).fill(null).map((_, i) => 
      store.bulkStore([{
        text: `Concurrent ${i}`,
        vector: new Array(4).fill(0.1),
        category: "fact",
        scope: "test",
        importance: 0.5,
        metadata: "{}",
      }])
    );
    
    const results = await Promise.allSettled(promises);
    const success = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;
    
    console.log(`[Stress] ${success} success, ${failed} failed`);
    assert.ok(success >= 8, `Expected at least 8, got ${success}`);
  }, 60000);
});

console.log("=== Bulk Store Tests ===");