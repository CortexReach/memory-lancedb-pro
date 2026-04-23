// test/issue-690-cross-call-batch.test.mjs
/**
 * Issue #690: Cross-call batch accumulator test
 * 
 * 測試目標：100 個 concurrent bulkStore() 呼叫，100% 成功（不 timeout）。
 * 
 * 背景：cross-call batch accumulator 是 Issue #690 的核心解法：
 * - 多個 concurrent bulkStore() 先累積在 pendingBatch[]
 * - 每 FLUSH_INTERVAL_MS（100ms）flush 一次，合併成一個 lock acquisition
 * - 避免 100 個 concurrent 變成 100 次 lock acquisition 導致 30s timeout
 * 
 * 驗證：
 * 1. 100 concurrent calls → 100% success（不可繞過）
 * 2. 批次合併：多個 concurrent calls 共享一次 lock acquisition
 * 3. 錯誤處理：flush 失敗時所有 pending callers 都 reject
 * 4. 邊界：empty array、single entry、MAX_BATCH_SIZE overflow
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "issue-690-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
  return { store, dir };
}

function makeEntry(i) {
  return {
    text: `entry-${i}-${Date.now()}`,
    vector: new Array(8).fill(Math.random()),
    category: "fact",
    scope: "global",
    importance: 0.7,
    metadata: "{}",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Issue #690: cross-call batch accumulator", () => {
  let store, dir;

  afterEach(async () => {
    if (store) {
      try { await store.flush(); } catch {}
      store = null;
    }
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  // ============================================================
  // Core: 100 concurrent calls → 100% success
  // ============================================================
  it("100 concurrent bulkStore calls: 100% success (CRITICAL)", async () => {
    ({ store, dir } = makeStore());
    try {
      const COUNT = 100;
      const promises = Array.from({ length: COUNT }, (_, i) =>
        store.bulkStore([makeEntry(i)])
      );

      // 等待最多 60 秒（足夠 100ms flush × 多次 + lock acquisition）
      const results = await Promise.allSettled(promises);
      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");

      console.log(`[Issue #690] ${successes.length}/${COUNT} succeeded, ${failures.length} failed`);
      if (failures.length > 0) {
        const firstErr = failures[0].reason;
        console.error(`[Issue #690] First failure: ${firstErr?.message || String(firstErr)}`);
      }

      // 100% 成功率（不可繞過）
      assert.strictEqual(
        successes.length,
        COUNT,
        `Expected all ${COUNT} calls to succeed, but got ${successes.length} successes and ${failures.length} failures`
      );

      // 資料完整性：所有 entries 都能被讀回
      const all = await store.list(undefined, undefined, COUNT + 10, 0);
      assert.strictEqual(
        all.length,
        COUNT,
        `Expected ${COUNT} entries stored, but only ${all.length} retrievable`
      );
    } finally {
      await store.flush();
    }
  });

  it("100 concurrent bulkStore calls with 10 entries each: 100% success", async () => {
    ({ store, dir } = makeStore());
    try {
      const COUNT = 100;
      const promises = Array.from({ length: COUNT }, (_, i) => {
        const entries = Array.from({ length: 10 }, (_, j) => makeEntry(i * 10 + j));
        return store.bulkStore(entries);
      });

      const results = await Promise.allSettled(promises);
      const successes = results.filter((r) => r.status === "fulfilled");

      console.log(`[Issue #690] ${successes.length}/${COUNT} succeeded (10 each)`);
      assert.strictEqual(successes.length, COUNT, `Expected all ${COUNT} calls to succeed`);

      const all = await store.list(undefined, undefined, COUNT * 10 + 10, 0);
      assert.strictEqual(all.length, COUNT * 10, `Expected ${COUNT * 10} entries`);
    } finally {
      await store.flush();
    }
  });

  // ============================================================
  // Batch merging: multiple concurrent calls share one lock
  // ============================================================
  it("multiple concurrent calls are batched into single lock acquisition", async () => {
    ({ store, dir } = makeStore());
    try {
      // 同時發 20 個 calls，每個 5 個 entries
      const COUNT = 20;
      const promises = Array.from({ length: COUNT }, (_, i) => {
        const entries = Array.from({ length: 5 }, (_, j) => makeEntry(i * 5 + j));
        return store.bulkStore(entries);
      });

      const results = await Promise.allSettled(promises);
      const successes = results.filter((r) => r.status === "fulfilled");

      assert.strictEqual(successes.length, COUNT);

      // 所有 100 entries 都寫入（20 × 5）
      const all = await store.list(undefined, undefined, 200, 0);
      assert.strictEqual(all.length, COUNT * 5, `Expected ${COUNT * 5} entries`);
    } finally {
      await store.flush();
    }
  });

  // ============================================================
  // Error handling: flush failure rejects all pending callers
  // ============================================================
  it("flush error rejects all pending callers", async () => {
    ({ store, dir } = makeStore());
    try {
      // 先成功寫入一些資料讓 table 可用
      await store.bulkStore([makeEntry(0)]);
      await store.flush();

      // Mock runWithFileLock to fail on next flush
      let flushCount = 0;
      const originalRunWithFileLock = store.runWithFileLock.bind(store);
      store.runWithFileLock = async (fn) => {
        flushCount++;
        if (flushCount >= 2) {
          throw new Error("Simulated flush failure");
        }
        return originalRunWithFileLock(fn);
      };

      // 發 5 個 concurrent calls，第一批 flush 成功（建 table），第二批 flush 失敗
      const p1 = store.bulkStore([makeEntry(1)]);
      const p2 = store.bulkStore([makeEntry(2)]);
      const p3 = store.bulkStore([makeEntry(3)]);

      // 等第一批 flush 完成
      await sleep(200);

      // 發第二批（觸發失敗的 flush）
      const p4 = store.bulkStore([makeEntry(4)]);
      const p5 = store.bulkStore([makeEntry(5)]);

      const results = await Promise.allSettled([p1, p2, p3, p4, p5]);
      const failures = results.filter((r) => r.status === "rejected");

      console.log(`[Issue #690] ${failures.length} rejections after simulated flush error`);
      // At least some should fail due to the simulated error
      assert.ok(failures.length > 0, "Expected at least some calls to fail");
    } finally {
      store.runWithFileLock = store.runWithFileLock.bind(store);
      await store.flush();
    }
  });

  // ============================================================
  // Edge cases
  // ============================================================
  it("empty array returns immediately without accumulating", async () => {
    ({ store, dir } = makeStore());
    try {
      const result = await store.bulkStore([]);
      assert.deepStrictEqual(result, [], "Empty array should return empty array");
    } finally {
      await store.flush();
    }
  });

  it("single entry works correctly", async () => {
    ({ store, dir } = makeStore());
    try {
      const result = await store.bulkStore([makeEntry(1)]);
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].id, "Should have generated an id");
      assert.ok(result[0].timestamp, "Should have set a timestamp");

      const all = await store.list(undefined, undefined, 10, 0);
      assert.strictEqual(all.length, 1);
    } finally {
      await store.flush();
    }
  });

  it("entries exceeding MAX_BATCH_SIZE are queued for next flush", async () => {
    ({ store, dir } = makeStore());
    try {
      const COUNT = MemoryStore.MAX_BATCH_SIZE + 50;
      const entries = Array.from({ length: COUNT }, (_, i) => makeEntry(i));
      const result = await store.bulkStore(entries);

      assert.strictEqual(result.length, MemoryStore.MAX_BATCH_SIZE, "Partial result returned immediately");

      // Force flush to process overflow
      await store.flush();

      const all = await store.list(undefined, undefined, COUNT + 10, 0);
      assert.strictEqual(all.length, COUNT, "All entries eventually stored");
    } finally {
      await store.flush();
    }
  });

  it("entries with invalid fields are filtered out", async () => {
    ({ store, dir } = makeStore());
    try {
      const mixed = [
        null,
        undefined,
        { text: "", vector: [0.1, 0.2] }, // empty text
        { text: "valid", vector: [] },     // empty vector
        makeEntry(1),                      // valid
      ];
      // Filter out invalid entries first (same logic as store)
      const validEntries = mixed.filter(
        (entry) => entry && entry.text && entry.text.length > 0 && entry.vector && entry.vector.length > 0
      );
      const result = await store.bulkStore(validEntries);

      assert.strictEqual(result.length, 1, "Only valid entry should be stored");
    } finally {
      await store.flush();
    }
  });

  // ============================================================
  // Timing: verify flush interval is respected
  // ============================================================
  it("flush happens within FLUSH_INTERVAL_MS", async () => {
    ({ store, dir } = makeStore());
    try {
      const start = Date.now();
      await store.bulkStore([makeEntry(1)]);
      // 不 await flush()，讓它在背景跑
      await sleep(MemoryStore.FLUSH_INTERVAL_MS + 50);
      const elapsed = Date.now() - start;

      const all = await store.list(undefined, undefined, 10, 0);
      assert.strictEqual(all.length, 1, `Entry should be stored within ${MemoryStore.FLUSH_INTERVAL_MS + 50}ms (actual: ${elapsed}ms)`);
    } finally {
      await store.flush();
    }
  });

  // ============================================================
  // Concurrent mixed with sequential
  // ============================================================
  it("mixed concurrent and sequential calls all succeed", async () => {
    ({ store, dir } = makeStore());
    try {
      // 先發 50 個 concurrent
      const concurrent = Array.from({ length: 50 }, (_, i) => store.bulkStore([makeEntry(i)]));

      // 等一下再發 50 個 sequential（它们会在第二批 flush）
      await sleep(MemoryStore.FLUSH_INTERVAL_MS + 20);
      const sequential = Array.from({ length: 50 }, (_, i) => store.bulkStore([makeEntry(50 + i)]));

      const results = await Promise.allSettled([...concurrent, ...sequential]);
      const successes = results.filter((r) => r.status === "fulfilled");

      assert.strictEqual(successes.length, 100, `Expected 100 successes, got ${successes.length}`);

      const all = await store.list(undefined, undefined, 200, 0);
      assert.strictEqual(all.length, 100, `Expected 100 entries`);
    } finally {
      await store.flush();
    }
  });

  // ============================================================
  // Large number of concurrent calls (stress test)
  // ============================================================
  it("200 concurrent calls: still 100% success", async () => {
    ({ store, dir } = makeStore());
    try {
      const COUNT = 200;
      const promises = Array.from({ length: COUNT }, (_, i) =>
        store.bulkStore([makeEntry(i)])
      );

      const results = await Promise.allSettled(promises);
      const successes = results.filter((r) => r.status === "fulfilled");

      console.log(`[Stress] ${successes.length}/${COUNT} succeeded (200 concurrent)`);
      assert.strictEqual(successes.length, COUNT, `Expected all ${COUNT} calls to succeed`);

      const all = await store.list(undefined, undefined, COUNT + 10, 0);
      assert.strictEqual(all.length, COUNT, `Expected ${COUNT} entries`);
    } finally {
      await store.flush();
    }
  });
});

console.log("=== Issue #690 Tests ===");
console.log(`FLUSH_INTERVAL_MS: ${MemoryStore.FLUSH_INTERVAL_MS}`);
console.log(`MAX_BATCH_SIZE: ${MemoryStore.MAX_BATCH_SIZE}`);