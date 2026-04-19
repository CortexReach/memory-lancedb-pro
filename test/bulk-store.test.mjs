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
    
    // 建立 10 個 entries
    const entries = Array(10).fill(null).map((_, i) => ({
      text: `Bulk test memory ${i}`,
      vector: new Array(8).fill(0.1),
      category: "fact",
      scope: "test",
      importance: 0.5,
      metadata: "{}",
    }));
    
    // 使用 bulkStore
    const start = Date.now();
    const stored = await store.bulkStore(entries);
    const duration = Date.now() - start;
    
    console.log(`[bulkStore] ${entries.length} entries stored in ${duration}ms`);
    console.log(`[bulkStore] First id: ${stored[0].id}`);
    
    // 驗證
    assert.strictEqual(stored.length, 10);
    assert.ok(stored[0].id.length > 0);
    
    // 不 destroy，讓資料留下
  });
});

console.log("=== Bulk Store Tests ===");