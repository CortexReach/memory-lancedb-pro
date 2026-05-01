// test/bulk-store-edge-cases.test.mjs
/**
 * Bulk Store Edge Cases - 驗證潛在問題
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("bulkStore edge case verification", () => {
  it("should handle undefined/null in entries", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-undefined-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    // 測試包含 undefined/null
    try {
      const result = await store.bulkStore([
        undefined,
        null,
        {
          text: "Valid entry",
          vector: new Array(4).fill(0.1),
          category: "fact",
          scope: "test",
          importance: 0.5,
          metadata: "{}",
        },
      ]);
      console.log("[Edge] undefined/null result:", result.length);
    } catch (err) {
      console.log("[Edge] undefined/null ERROR:", err.message);
    }
  });

  it("should handle missing text/vector fields", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-missing-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    // 測試缺少必要欄位
    try {
      const result = await store.bulkStore([
        { text: "Only text" },  // 缺少 vector
        { vector: new Array(4).fill(0.1) },  // 缺少 text
        {},  // 什麼都沒有
      ]);
      console.log("[Edge] Missing fields result:", result.length);
    } catch (err) {
      console.log("[Edge] Missing fields ERROR:", err.message);
    }
  });

  it("should handle wrong vector dimension", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-dim-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,  // 設定 4 維
    });
    
    // 測試錯誤維度
    try {
      const result = await store.bulkStore([
        {
          text: "Wrong dimension",
          vector: new Array(8).fill(0.1),  // 8 維會怎樣？
          category: "fact",
          scope: "test",
          importance: 0.5,
          metadata: "{}",
        },
      ]);
      console.log("[Edge] Wrong dimension result:", result.length);
    } catch (err) {
      console.log("[Edge] Wrong dimension ERROR:", err.message);
    }
  });

  it("should handle empty text", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "bulk-empty-text-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    // 測試空文字
    try {
      const result = await store.bulkStore([
        {
          text: "",
          vector: new Array(4).fill(0.1),
          category: "fact",
          scope: "test",
          importance: 0.5,
          metadata: "{}",
        },
      ]);
      console.log("[Edge] Empty text result:", result.length);
    } catch (err) {
      console.log("[Edge] Empty text ERROR:", err.message);
    }
  });
});

console.log("=== Bulk Store Edge Case Verification ===");