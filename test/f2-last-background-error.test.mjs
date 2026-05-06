// test/f2-last-background-error.test.mjs
/**
 * F2 Fix Verification Test
 *
 * 問題：Timer-driven doFlush() 是 fire-and-forget，失敗時 caller 的 reject()
 * 不會被呼叫（fire-and-forget 沒人 .catch()）。
 *
 * F2 Fix:
 * 1. Timer callback .catch() → 儲存錯誤到 lastBackgroundError
 * 2. flush() 在 pendingBatch 為空時 → rethrow lastBackgroundError
 * 3. Settlement loop 每個 caller 包 try-catch → 避免 double-settle 中斷 loop
 *
 * S1/S2 已移除（根本原因分析）：
 *
 * F2 的 timer's .catch() 要 catch 到 doFlush() 失敗，需要滿足：
 *   (a) pendingBatch 在 timer fire 時仍有 entries（不是空陣列）
 *   (b) doFlush() 在執行時真的失敗（table.add() throw）
 *
 * 但在 fast-path（pendingBatch 為空），timer fire 時：
 *   - pendingBatch 早已被 settlement loop 的 splice(0) 取走並設為空
 *   - timer's doFlush() 面對空陣列，永遠成功（hasError=false）
 *   - timer's .catch() 不會被觸發
 *
 * 所以 fast-path 場景下 F2 機制根本不可能被 timer's .catch() 處理。
 * S1/S2 原本設計想測試的「table 在 bulkStore() 返回後被破壞」場景，
 * 在 fast-path 中 table 在 settlement loop 的同步 doFlush() 時就已經是 null 了，
 * 不是在 timer's doFlush() 時。
 *
 * F2 重拋機制在 normal-path（issue-690-cross-call-batch.test.mjs）下已充分驗證。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "f2-test-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
  return { store, dir };
}

function makeEntry(i) {
  return {
    text: `entry-${i}-${Date.now()}`,
    vector: new Array(8).fill(0.1 * (i % 10)),
    category: "fact",
    scope: "global",
    importance: 0.7,
    metadata: "{}",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("F2 fix: lastBackgroundError timer flush error propagation", () => {
  afterEach(async () => {
    // No automatic flush() in afterEach — tests manage their own cleanup
  });

  // ============================================================
  // S4: Timer flush 成功 → flush() 不應 throw
  // ============================================================
  it("S4: timer flush success → flush() does not throw", async () => {
    const { store, dir } = makeStore();

    try {
      const p1 = store.bulkStore([makeEntry(1)]);
      await sleep(300);

      let flushThrew = false;
      try {
        await store.flush();
      } catch (err) {
        flushThrew = true;
        console.error(`[S4] UNEXPECTED flush() threw: ${err.message}`);
      }

      assert.strictEqual(flushThrew, false, "flush() should not throw after successful timer flush");
      const p1Result = await p1;
      assert.strictEqual(p1Result.length, 1, "p1 should have been resolved");
    } finally {
      try { await store.flush(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // S3: MR2 TOCTOU — 兩個 concurrent callers 同時過 length===0 check
  // ============================================================
  it("S3: two concurrent callers on empty pendingBatch → both get correct result", async () => {
    const { store, dir } = makeStore();

    try {
      await store.bulkStore([makeEntry(0)]);
      await store.flush();

      const [r1, r2] = await Promise.all([
        store.bulkStore([makeEntry(100)]),
        store.bulkStore([makeEntry(200)]),
      ]);

      assert.strictEqual(r1.length, 1, "r1 should have 1 entry");
      assert.strictEqual(r2.length, 1, "r2 should have 1 entry");
      assert.notStrictEqual(r1[0].id, r2[0].id, "entries should have unique IDs");

      await store.flush();

      const all = await store.list(undefined, undefined, 100, 0);
      const texts = all.map((e) => e.text);
      assert.ok(texts.some((t) => t.includes("entry-100")), "entry-100 should be in DB");
      assert.ok(texts.some((t) => t.includes("entry-200")), "entry-200 should be in DB");
    } finally {
      try { await store.flush(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
