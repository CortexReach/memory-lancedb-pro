// test/issue-690-stress-1000.test.mjs
/**
 * Issue #690: 1000 次迭代測試
 * 
 * 跑 1000 次「100 concurrent bulkStore() → 100% success」，
 * 驗證 cross-call batch accumulator 的穩定性與一致性。
 * 
 * 每個 iteration 使用獨立的 tmpdir（模擬真實 DB），
 * 確保測試乾淨隔離，不互相影響。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

const ITERATIONS = 1000;
const CONCURRENT_CALLS = 100;
const ENTRIES_PER_CALL = 1;

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "issue-690-1k-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
  return { store, dir };
}

function makeEntry(i) {
  return {
    text: `stress-entry-${i}-${Date.now()}-${Math.random()}`,
    vector: new Array(8).fill(Math.random()),
    category: "fact",
    scope: "global",
    importance: 0.7,
    metadata: "{}",
  };
}

describe(`Issue #690 Stress: ${ITERATIONS} iterations × ${CONCURRENT_CALLS} concurrent calls`, () => {
  let store, dir;

  afterEach(async () => {
    if (store) {
      try { await store.destroy(); } catch {}
      store = null;
    }
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it(`${ITERATIONS}x (${CONCURRENT_CALLS} concurrent calls → 100% success)`, async () => {
    let totalSuccess = 0;
    let totalFailed = 0;
    const startTime = Date.now();

    for (let iter = 1; iter <= ITERATIONS; iter++) {
      ({ store, dir } = makeStore());
      try {
        const promises = Array.from({ length: CONCURRENT_CALLS }, (_, i) =>
          store.bulkStore([makeEntry(i)])
        );

        const results = await Promise.allSettled(promises);
        const successes = results.filter((r) => r.status === "fulfilled").length;
        const failures = results.filter((r) => r.status === "rejected").length;

        totalSuccess += successes;
        totalFailed += failures;

        if (failures > 0) {
          const firstErr = results.find((r) => r.status === "rejected")?.reason;
          throw new Error(
            `Iteration ${iter}/${ITERATIONS}: ${failures}/${CONCURRENT_CALLS} failed. First error: ${firstErr?.message || String(firstErr)}`
          );
        }

        // 每 100 次輸出進度
        if (iter % 100 === 0) {
          const elapsed = Date.now() - startTime;
          const rate = Math.round((iter / elapsed) * 1000);
          console.log(`[${iter}/${ITERATIONS}] ${rate} iter/s | ${totalSuccess} total success`);
        }
      } finally {
        // cleanup
        try { await store.destroy(); } catch {}
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        store = null;
        dir = null;
      }
    }

    const totalTime = Date.now() - startTime;
    const expected = ITERATIONS * CONCURRENT_CALLS;

    console.log(`\n=== Stress Test Results ===`);
    console.log(`Iterations: ${ITERATIONS}`);
    console.log(`Concurrent calls/iter: ${CONCURRENT_CALLS}`);
    console.log(`Total expected success: ${expected}`);
    console.log(`Total actual success: ${totalSuccess}`);
    console.log(`Total failed: ${totalFailed}`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`Rate: ${(ITERATIONS / (totalTime / 1000)).toFixed(1)} iter/s`);

    assert.strictEqual(
      totalSuccess,
      expected,
      `Expected ${expected} successes, got ${totalSuccess} (${totalFailed} failed)`
    );
    assert.strictEqual(totalFailed, 0, `Expected 0 failures, got ${totalFailed}`);
  });
});

console.log("=== Issue #690 Stress Test (1000 iterations) ===");
console.log(`ITERATIONS=${ITERATIONS}, CONCURRENT=${CONCURRENT_CALLS}`);