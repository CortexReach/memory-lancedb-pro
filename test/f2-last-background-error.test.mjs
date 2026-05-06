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
 * S1/S2 直接單元測試（Option B）：
 * 不依賴 timer 時序，直接測試 F2 的兩個子行為：
 * - S1: 移除（fast-path 的 pendingBatch 在 doFlush() 前就被清空，物理上不可能觸發 settlement loop 錯誤路徑）
 * - S2: flush() 在 pendingBatch 空 + lastBackgroundError 有值時 → rethrow
 *
 * 為什麼不依賴時序：
 * F2 的 timer's .catch() 要 catch 到 doFlush() 失敗，需要滿足
 * pendingBatch 在 timer fire 時仍有 entries。但在 fast-path，
 * settlement loop 的 splice(0) 在 timer fire 前就取走了 pendingBatch，
 * timer's doFlush() 面對空陣列，永遠成功。
 * 因此改用直接單元測試驗證 F2 機制。
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
  // S2: flush() 在 pendingBatch 空 + lastBackgroundError 有值時 → rethrow（F2 核心機制 2/2）
  // 流程：bulkStore() settlement loop 的 .then() 設定 lastBackgroundError（當 doFlush() 回
  // 傳 hasError=true）→ warmup flush() 把 pendingBatch 清空 → explicit flush() 看到空 batch +
  // lastBackgroundError → rethrow
  // 驗證 explicit flush() 的 rethrow 邏輯
  // ============================================================
  it("S2: flush() rethrows lastBackgroundError when pendingBatch is empty", async () => {
    const { store, dir } = makeStore();

    try {
      // Warm-up：確保 store 初始化完成，pendingBatch 清空
      await store.bulkStore([makeEntry(0)]);
      await store.flush();
      // warmup 後：pendingBatch 為空，table 正常

      // 破壞 table，讓 settlement loop 的 doFlush() 失敗
      store.table = null;

      // bulkStore() 觸發 settlement loop，settlement loop 的 doFlush().catch() 設定 lastBackgroundError
      // 不 await，讓 settlement loop 在背景跑
      const p1 = store.bulkStore([makeEntry(1)]);
      p1.catch(() => {}); // 抑制同步 rejection

      // 等 settlement loop 完成（bulkStore 返回），並讓 .catch() 有機會執行
      await new Promise((r) => setTimeout(r, 50));

      // 此時：
      // - pendingBatch 為空（已被 settlement loop 的 splice(0) 取走）
      // - lastBackgroundError 已被設定（settlement loop 的 .catch() 設定的）
      // - table 仍是 null（沒恢復）
      assert.ok(
        store.lastBackgroundError !== null && store.lastBackgroundError?.hasError === true,
        `lastBackgroundError should be set, got: ${JSON.stringify(store.lastBackgroundError)}`
      );

      // explicit flush() 應該 rethrow lastBackgroundError
      let flushThrew = false;
      let flushError;
      try {
        await store.flush();
      } catch (err) {
        flushThrew = true;
        flushError = err;
      }

      assert.strictEqual(flushThrew, true, "flush() should throw lastBackgroundError when pendingBatch is empty");
      assert.ok(
        flushError?.message.includes("flush failed") || flushError?.cause?.message?.includes("null"),
        `flush() error should mention flush failure, got: ${flushError?.message}`
      );
    } finally {
      try { await store.flush(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
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
