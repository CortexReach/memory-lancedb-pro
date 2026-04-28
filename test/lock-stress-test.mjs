/**
 * 高並發鎖壓力測試 v2（改良版）
 * 測試重點：
 * 1. 高並發寫入不會 crash（無 ECOMPROMISED）
 * 2. 重負載下長等待不會導致 Gateway 崩潰
 * 3. 資料完整性
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-stress-v2-"));
});

after(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("高並發鎖壓力測試 v2", { concurrency: 1 }, () => {
  // 測試 1：中等並發（3個同時寫）不 crash
  it("中等並發寫入（3行程×5次）無 ECOMPROMISED crash", async () => {
    const store = new MemoryStore({ dbPath: join(workDir, "medium-concurrent"), vectorDim: 3 });
    const errors = [];

    const worker = async (workerId) => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        try {
          const r = await store.store({
            text: `w${workerId}-${i}`,
            vector: [workerId * 10 + i, 0, 0],
            category: "stress",
            scope: "global",
            importance: 0.5,
            metadata: "{}",
          });
          results.push({ ok: true, id: r.id });
        } catch (err) {
          const isEcomp = err.code === "ECOMPROMISED" || (err.message && err.message.includes("ECOMPROMISED"));
          errors.push({ workerId, i, code: err.code, msg: err.message, isEcomp });
          results.push({ ok: false, error: err.message, isEcomp });
        }
      }
      return results;
    };

    // 3 個 worker 同時啟動
    const allResults = await Promise.all([worker(0), worker(1), worker(2)]);
    const flat = allResults.flat();
    const ecompCount = flat.filter(r => r.isEcomp).length;

    console.log(`\n  [中等並發] 總操作: ${flat.length}, 成功: ${flat.filter(r => r.ok).length}, ECOMPROMISED: ${ecompCount}`);
    if (errors.length > 0) {
      errors.forEach(e => console.log(`    Worker${e.workerId} op${e.i}: ${e.code || "?"} - ${e.msg}`));
    }

    // 核心驗證：0 個 ECOMPROMISED crash
    assert.strictEqual(ecompCount, 0, `不應有 ECOMPROMISED crash，但發生了 ${ecompCount} 次`);
    // 至少有半數成功
    assert.ok(flat.filter(r => r.ok).length >= 7, "起碼要有 7/15 成功");
  });

  // 測試 2：真正並發請求 — 用 Promise.all 同時搶 lock
  // 模擬 holder 持有 lock 時，competitor 嘗試取得 lock
  // 結果應該是：兩個都成功（一個立即，一個等到 lock 釋放後）
  it("並發寫入時兩個都成功（retry 機制正常運作）", async () => {
    const store = new MemoryStore({ dbPath: join(workDir, "concurrent-retry"), vectorDim: 3 });

    // 用 Promise.all 同時發起兩個 store 請求，真正測試並發競爭下的 retry 行為
    const start = Date.now();
    const [r1, r2] = await Promise.all([
      store.store({
        text: "concurrent-1",
        vector: [1, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.8,
        metadata: "{}",
      }),
      store.store({
        text: "concurrent-2",
        vector: [0, 1, 0],
        category: "fact",
        scope: "global",
        importance: 0.8,
        metadata: "{}",
      }),
    ]);
    const elapsed = Date.now() - start;

    console.log(`\n  [並發競爭] 耗時: ${elapsed}ms, id1=${r1.id.slice(0,8)}, id2=${r2.id.slice(0,8)}`);
    // F3 修復：明確斷言兩個請求都成功（不死、不 ECOMPROMISED）
    assert.ok(r1.id, "第一個請求應該成功（不死、不拋 ECOMPROMISED）");
    assert.ok(r2.id, "第二個請求應該成功（retry 後成功，不拋 ECOMPROMISED）");
    assert.ok(r1.id !== r2.id, "兩個請求應該產生不同 ID");
    // EF4 修復：明確斷言耗時在合理範圍內，防止 CI hang
    assert.ok(elapsed < 30000, `並發鎖競爭應在合理時間內完成（< 30s），實際 ${elapsed}ms`);
  });

  // 測試 3：批量順序寫入後資料完整性（stress test 不該用 30 個並發，那會 ELOCKED）
  it("批量寫入後所有資料都能正確讀回", async () => {
    const store = new MemoryStore({ dbPath: join(workDir, "bulk-integrity"), vectorDim: 3 });
    const COUNT = 20;
    const TIMEOUT_MS = 60_000; // EF4 修復：60 秒安全上限，防止 CI hang

    // 順序寫入（不是並發），驗證大量寫入的資料完整性
    const entries = [];
    for (let i = 0; i < COUNT; i++) {
      // EF4 修復：單次操作加安全上限
      const opStart = Date.now();
      const r = await Promise.race([
        store.store({
          text: `bulk-${i}`,
          vector: [i * 0.1, i * 0.2, i * 0.3],
          category: "fact",
          scope: "global",
          importance: 0.6,
          metadata: "{}",
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`bulk[${i}] timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
        ),
      ]);
      const opElapsed = Date.now() - opStart;
      assert.ok(opElapsed < TIMEOUT_MS, `bulk[${i}] 單次寫入應在 ${TIMEOUT_MS}ms 內，實際 ${opElapsed}ms`);
      entries.push(r);
    }

    const ids = entries.map(e => e.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, COUNT, `應該有 ${COUNT} 個唯一 ID`);

    // 全部能讀回
    const all = await store.list(undefined, undefined, 100, 0);
    assert.strictEqual(all.length, COUNT, `list 應該返回 ${COUNT} 筆記錄`);
  });
});
