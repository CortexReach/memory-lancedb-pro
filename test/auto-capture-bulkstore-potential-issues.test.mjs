// test/auto-capture-bulkstore-potential-issues.test.mjs
/**
 * Auto-Capture bulkStore 改動潛在問題模擬測試
 * 
 * 模擬兩種不同的改動方式，確認問題
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("Auto-Capture bulkStore potential issues", () => {
  
  // ============================================================
  // 我的方式：直接收集後 bulkStore
  // ============================================================
  it("MY APPROACH: simple bulkStore without duplicate check", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "my-approach-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    /* 模擬 auto-capture：現況邏輯（每次單獨寫入）
    for (const text of toCapture) {
      const vector = await embedder.embedPassage(text);
      const existing = await store.vectorSearch(vector, 1, 0.9, [scope]);
      if (existing.length > 0 && existing[0].score > 0.90) continue;
      await store.store({ text, vector, ... });
    }
    */
    
    /* 我的改法：直接收集
    const entries = [];
    for (const text of toCapture) {
      const vector = [Math.random(), Math.random(), Math.random(), Math.random()]; // mock
      entries.push({ text, vector, category: "fact", scope: "test", importance: 0.7, metadata: "{}" });
    }
    await store.bulkStore(entries);
    */
    
    // 測試：直接 bulkStore
    const entries = [
      { text: "Test 1", vector: [0.1, 0.1, 0.1, 0.1], category: "fact", scope: "test", importance: 0.7, metadata: "{}" },
      { text: "Test 2", vector: [0.2, 0.2, 0.2, 0.2], category: "fact", scope: "test", importance: 0.7, metadata: "{}" },
    ];
    
    const result = await store.bulkStore(entries);
    console.log("[My Approach] Stored:", result.length);
    
    // 問題：這樣無法在寫入前檢查 duplicate！
    // 如果有重複的內容，已經直接寫入了
  });

  // ============================================================
  // Claude 的方式：先檢查 duplicate 再收集
  // ============================================================
  it("CLAUDE APPROACH: duplicate check then bulkStore", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "claude-approach-"));
    
    const store = new MemoryStore({
      dbPath: dir,
      vectorDim: 4,
    });
    
    // 先寫入一個
    await store.store({
      text: "Existing memory",
      vector: [0.5, 0.5, 0.5, 0.5],
      category: "fact",
      scope: "test",
      importance: 0.7,
      metadata: "{}",
    });
    
    /* Claude 的改法：
    const entries = [];
    for (const text of toCapture) {
      const vector = await embedder.embedPassage(text);
      // 這裡需要 duplicate check，但 bulkStore 是一次性的
      const existing = await store.vectorSearch(vector, 1, 0.9, [scope]);
      if (existing.length > 0 && existing[0].score > 0.90) {
        console.log("Duplicate found, skipping:", text);
        continue;
      }
      entries.push({ text, vector, ... });
    }
    await store.bulkStore(entries);
    */
    
    // 問題：duplicate check 在 loop 裡，但每個 check 都會觸發 vectorSearch
    // 而且 bulkStore 不能做這件事
    
    const newTexts = ["New 1", "New 2", "Existing memory"]; // 最後一個是重複的
    const entries = [];
    
    for (const text of newTexts) {
      const vector = [Math.random(), Math.random(), Math.random(), Math.random()];
      
      // 需要 duplicate check
      const existing = await store.vectorSearch(vector, 1, 0.9, ["test"]);
      if (existing.length > 0 && existing[0].score > 0.90) {
        console.log("[Claude] Duplicate found, skipping:", text);
        continue;
      }
      
      entries.push({ text, vector, category: "fact", scope: "test", importance: 0.7, metadata: "{}" });
    }
    
    const result = await store.bulkStore(entries);
    console.log("[Claude] Stored after dedup:", result.length);
    
    // ✅ 這方式可以工作，但需要 vectorSearch API 调用 N 次
  });

  // ============================================================
  // CONFLICT: 哪個方式更好？
  // ============================================================
  it("CONFLICT: analyze the problem", async () => {
    console.log("\n=== CONFLICT ANALYSIS ===");
    console.log("問題 1: bulkStore 不能在 lock 內做 duplicate check");
    console.log("問題 2: 在 loop 外做 check = N 次 vectorSearch");
    console.log("問題 3: 如果跳過 = entries.length 變少");
    console.log("");
    console.log("My Approach: 快但可能寫入重複");
    console.log("Claude Approach: 正確但慢（N 次 API call）");
    console.log("");
    console.log("解決方案？");
  });
});

console.log("=== Auto-Capture bulkStore Conflict Test ===");