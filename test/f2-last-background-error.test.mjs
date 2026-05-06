// test/f2-last-background-error.test.mjs
/**
 * F2 + F1 Fix Verification Test
 *
 * F2 Fix: Timer-driven doFlush() 是 fire-and-forget，失敗時 caller 的 reject()
 * 不會被呼叫（fire-and-forget 沒人 .catch()）。
 * F2 Fix:
 * 1. Timer callback .then() → 儲存錯誤到 lastBackgroundError
 * 2. flush() 在 pendingBatch 為空時 → rethrow lastBackgroundError
 * 3. Settlement loop 每個 caller 包 try-catch → 避免 double-settle 中斷 loop
 * 4. doFlush() 內部 catch 並回傳 { hasError: true } 而非 throw
 *
 * F1 Fix: destroy() 原本不等待 flushLock、不檢查 lastBackgroundError，
 * 若 timer callback 的 doFlush() 在 destroy() 返回後執行並失敗，錯誤被靜音。
 * F1 Fix: destroy() 加 await flushLock + 檢查 lastBackgroundError。
 *
 * S1/S2 直接單元測試（Option B）：
 * 不依賴 timer 時序，直接測試 F2 的兩個子行為：
 * - S1: 移除（fast-path 的 pendingBatch 在 doFlush() 前就被清空，物理上不可能觸發 settlement loop 錯誤路徑）
 * - S2: flush() 在 pendingBatch 空 + lastBackgroundError 有值時 → rethrow
 *
 * S5/S6 直接單元測試（F1 destroy() fix）：
 * - S5: destroy() 在 pendingBatch 空 + lastBackgroundError 有值時 → rethrow
 * - S6: destroy() 在無 lastBackgroundError 時 → 正常返回
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
  // S2: flush() 在 pendingBatch 空 + lastBackgroundError 有值時 → rethrow（F2 核心機制）
  // 流程：bulkStore() settlement loop 的 .then() 設定 lastBackgroundError
  // → warmup flush() 把 pendingBatch 清空 → explicit flush() 看到空 batch + lastBackgroundError → rethrow
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

      // 此時：pendingBatch 為空，lastBackgroundError 已被設定
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

  // ============================================================
  // S5: destroy() 在 pendingBatch 空 + lastBackgroundError 有值時拋出（F1 fix）
  // 流程：手動設定 lastBackgroundError（模擬 timer callback 的 doFlush() 失敗）
  // → destroy() 的 await flushLock 完成（無排隊中的 doFlush）
  // → destroy() 檢查 lastBackgroundError → throw
  // 驗證 destroy() 會 rethrow timer callback 的錯誤
  // ============================================================
  it("S5: destroy() rethrows lastBackgroundError when pendingBatch is empty", async () => {
    const { store, dir } = makeStore();

    try {
      // Warm-up：確保 store 初始化完成，pendingBatch 清空
      await store.bulkStore([makeEntry(0)]);
      await store.flush();

      // 手動設定 lastBackgroundError（模擬 timer callback 的 doFlush() 失敗）
      const bgError = new Error("timer callback flush failed: simulated");
      store.lastBackgroundError = { hasError: true, lastError: bgError };

      // destroy() 應該 rethrow lastBackgroundError
      let destroyThrew = false;
      let destroyError;
      try {
        await store.destroy();
      } catch (err) {
        destroyThrew = true;
        destroyError = err;
      }

      assert.strictEqual(destroyThrew, true, "destroy() should throw lastBackgroundError");
      assert.ok(
        destroyError?.message.includes("timer callback flush failed"),
        `destroy() error should mention timer failure, got: ${destroyError?.message}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // S7: destroy() 自己 doFlush() 失敗 + lastBackgroundError 也有值
  //
  // Bug scenario（方案 A 前）：
  //   destroy() 先檢查 lastBackgroundError → throw "timer callback"
  //   → destroy() 自己的錯誤被靜默丟失（result.lastError 從未被 throw）
  //   → S7 FAIL：拋出 "timer callback" 而不是 "destroy callback"
  //
  // 方案 A fix（交換 if 順序）：
  //   destroy() 先檢查 result.hasError → throw "destroy callback"
  //   → S7 PASS
  // ============================================================
  it("S7: destroy() throws own error (not timer error) when both exist", async () => {
    const { store, dir } = makeStore();

    try {
      // Warm-up：確保 store 初始化完成，pendingBatch 清空
      await store.bulkStore([makeEntry(0)]);
      await store.flush();

      // 步驟 1：塞一個 entry 到 pendingBatch（手動，不走 bulkStore settlement loop）
      // 因為 warmup 後 pendingBatch 為空，doFlush() 會直接 return { hasError: false }
      // 我們需要 pendingBatch 有 entry，doFlush() 才會真正嘗試寫入並失敗
      const entry = makeEntry(99);
      store.pendingBatch.push({ entries: [entry], resolve: () => {}, reject: () => {}, chunkIdx: 0 });

      // 步驟 2：手動設定 lastBackgroundError（模擬 timer callback 的 doFlush() 失敗）
      const bgError = new Error("timer callback flush failed: simulated");
      store.lastBackgroundError = { hasError: true, lastError: bgError };

      // 步驟 3：破壞 table，讓 destroy() 的 doFlush() 也失敗
      // table = null → doFlush() 的 table.add() 會 throw
      store.table = null;

      // 步驟 4：呼叫 destroy()
      // 預期（方案 A fix 後）：throw destroy 自己 doFlush() 的錯誤
      // 實際（方案 A 前，bug）：throw "timer callback"（lastBackgroundError）
      let destroyThrew = false;
      let destroyError;
      try {
        await store.destroy();
      } catch (err) {
        destroyThrew = true;
        destroyError = err;
      }

      assert.strictEqual(destroyThrew, true, "destroy() should throw when doFlush() fails");

      // 關鍵驗證：應該 throw destroy() 自己的錯誤，不是 timer 的舊錯誤
      // 方案 A 前（bug）：throw "timer callback flush failed: simulated" → FAIL
      // 方案 A 後（fix）：throw "Cannot read properties of null" 或包含 "null" 的錯誤 → PASS
      assert.ok(
        destroyError?.message.includes("null") ||
        destroyError?.message.includes("table"),
        `destroy() should throw its OWN error (about null/table), not timer error. Got: "${destroyError?.message}"`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // S6: destroy() 成功（無 lastBackgroundError）→ 不拋出
  // ============================================================
  it("S6: destroy() succeeds when no background error", async () => {
    const { store, dir } = makeStore();

    try {
      await store.bulkStore([makeEntry(0)]);
      await store.flush();

      // lastBackgroundError 為 null
      assert.strictEqual(store.lastBackgroundError, null, "lastBackgroundError should be null");

      let destroyThrew = false;
      try {
        await store.destroy();
      } catch (err) {
        destroyThrew = true;
      }

      assert.strictEqual(destroyThrew, false, "destroy() should not throw when no background error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
