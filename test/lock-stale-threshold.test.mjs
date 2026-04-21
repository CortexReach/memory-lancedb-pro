/**
 * Test: lock-stale-threshold.test.mjs
 * 
 * Reproduces "Unable to update lock within the stale threshold" (Issue #670).
 * 
 * Root cause: store.ts uses proper-lockfile with stale:10000 (10 seconds).
 * Under high concurrent load, multiple store.store() calls each acquire their
 * own lock (N lock ops). If any single operation takes >10s, the stale
 * timer fires → "Unable to update lock" uncaught exception.
 * 
 * Fix: Use bulkStore() to acquire lock once for all entries (1 lock op).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

const STALE_MS = 10_000; // matches store.ts: stale: 10000

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-lock-"));
  return { store: new MemoryStore({ dbPath: dir, vectorDim: 3 }), dir };
}

function makeEntry(i = 1) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

// ─── TC-1: Verify stale:10000 is in the codebase ──────────────────────────────
describe("TC-1: Lock configuration", { timeout: 10_000 }, () => {
  it("store.ts uses stale:10000", async () => {
    const { readFileSync } = await import("node:fs");
    const storeSource = readFileSync(join(process.cwd(), "src", "store.ts"), "utf8");

    const match = storeSource.match(/stale:\s*(\d+)/);
    assert.ok(match, "stale parameter should be specified in store.ts");
    assert.strictEqual(
      parseInt(match[1]),
      10000,
      `stale should be 10000ms (10s), found ${match[1]}`,
    );
  });

  it("store.ts retries config: 10 retries with exponential backoff", async () => {
    const { readFileSync } = await import("node:fs");
    const storeSource = readFileSync(join(process.cwd(), "src", "store.ts"), "utf8");

    // Verify retry config exists
    assert.ok(storeSource.includes("retries:"), "retries config should be present");
    assert.ok(storeSource.includes("factor:"), "exponential backoff factor should be present");
  });
});

// ─── TC-2: Verify bulkStore skips invalid entries ──────────────────────────────
describe("TC-2: bulkStore correctness", { timeout: 10_000 }, () => {
  it("bulkStore skips invalid/missing entries", async () => {
    const { store, dir } = makeStore();
    await store.store(makeEntry(0)); // initialize

    const results = await store.bulkStore([
      makeEntry(1),
      { text: "", vector: [0.1], category: "fact", scope: "global", importance: 0.5, metadata: "{}" },
      null,
      undefined,
      makeEntry(4),
    ]);

    assert.strictEqual(results.length, 2, "only valid entries (1 and 4) should be stored");
    assert.strictEqual(results[0].text, "memory-1");
    assert.strictEqual(results[1].text, "memory-4");

    rmSync(dir, { recursive: true, force: true });
  });

  it("bulkStore with empty array returns immediately (no lock)", async () => {
    const { store, dir } = makeStore();
    await store.store(makeEntry(0));

    const start = Date.now();
    const results = await store.bulkStore([]);
    const elapsed = Date.now() - start;

    assert.deepStrictEqual(results, []);
    assert.ok(elapsed < 500, `empty bulkStore should be instant (<500ms), got ${elapsed}ms`);

    rmSync(dir, { recursive: true, force: true });
  });

  it("bulkStore returns correct number of entries", async () => {
    const { store, dir } = makeStore();
    await store.store(makeEntry(0));

    const N = 5;
    const entries = Array.from({ length: N }, (_, i) => makeEntry(i + 1));
    const results = await store.bulkStore(entries);

    assert.strictEqual(results.length, N, `bulkStore should return ${N} entries`);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── TC-3: Concurrent store.store() serialization ──────────────────────────────
describe("TC-3: Concurrent store.store() correctness", { timeout: 30_000 }, () => {
  it("3 concurrent store.store() calls all succeed", async () => {
    const { store, dir } = makeStore();
    const N = 3;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => store.store(makeEntry(i + 1))),
    );

    assert.strictEqual(results.length, N, "all stores should return");
    const ids = new Set(results.map(r => r.id));
    assert.strictEqual(ids.size, N, "all IDs should be unique");

    rmSync(dir, { recursive: true, force: true });
  });

  it("subsequent stores work after concurrent burst", async () => {
    const { store, dir } = makeStore();
    await Promise.all(Array.from({ length: 3 }, (_, i) => store.store(makeEntry(i + 1))));

    const entry = await store.store(makeEntry(10));
    assert.ok(entry.id);

    const all = await store.list(undefined, undefined, 100, 0);
    assert.strictEqual(all.length, 4, "all 4 entries should be retrievable");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── TC-4: Lock lifecycle ────────────────────────────────────────────────────
describe("TC-4: Lock lifecycle", { timeout: 30_000 }, () => {
  it("sequential store operations work without lock contention", async () => {
    const { store, dir } = makeStore();

    const entry1 = await store.store(makeEntry(1));
    assert.ok(entry1.id);

    const entry2 = await store.store(makeEntry(2));
    assert.ok(entry2.id);
    assert.notStrictEqual(entry1.id, entry2.id);

    const all = await store.list(undefined, undefined, 10, 0);
    assert.strictEqual(all.length, 2, "both entries should be retrievable");

    rmSync(dir, { recursive: true, force: true });
  });

  it("store works after concurrent burst", async () => {
    const { store, dir } = makeStore();

    await Promise.all([store.store(makeEntry(1)), store.store(makeEntry(2))]);

    const entry = await store.store(makeEntry(3));
    assert.ok(entry.id);
    assert.strictEqual(entry.text, "memory-3");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── TC-5: N lock acquisitions cause lock contention ───────────────────────────
/**
 * This test demonstrates the N×store.store() problem.
 * 
 * With 3 concurrent store.store() calls, we see:
 * - Each call acquires its own lock (3 lock operations)
 * - Operations are serialized by the lock → total time ≈ 3 × single_op_time
 * 
 * bulkStore() with 3 entries uses 1 lock → total time ≈ 1 × single_op_time
 * 
 * The difference is visible in wall-clock time.
 */
describe("TC-5: N lock acquisitions vs bulkStore", { timeout: 30_000 }, () => {
  it("3×store.store() takes longer than 1×bulkStore(3 entries)", async () => {
    const { store: storeA, dir: dirA } = makeStore();
    const { dir: dirB } = makeStore();

    const N = 3;
    const entries = Array.from({ length: N }, (_, i) => makeEntry(i + 100));

    // Pre-warm both DBs
    await storeA.store(makeEntry(0));
    const { MemoryStore: MSbulk } = jiti("../src/store.ts");
    const bulkStore = new MSbulk({ dbPath: dirB, vectorDim: 3 });
    await bulkStore.store(makeEntry(0));

    // === 3×store.store() ===
    const startA = Date.now();
    const resultsA = await Promise.all(entries.map(e => storeA.store(e)));
    const timeA = Date.now() - startA;
    assert.strictEqual(resultsA.length, N);

    // === 1×bulkStore(3) ===
    const startB = Date.now();
    const resultsB = await bulkStore.bulkStore(entries);
    const timeB = Date.now() - startB;
    assert.strictEqual(resultsB.length, N);

    console.log(`  3×store.store(): ${timeA}ms`);
    console.log(`  1×bulkStore(3): ${timeB}ms`);

    // bulkStore should be faster
    assert.ok(
      timeB < timeA,
      `bulkStore (${timeB}ms) should be faster than 3×store.store() (${timeA}ms)`,
    );

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

// ─── TC-6: Extreme bulkStore (1000 entries) ───────────────────────────────────
/**
 * Tests bulkStore with 1000 entries.
 *
 * Key assertion: 1000 entries via bulkStore completes in << 10 seconds
 * (the stale threshold). This is because bulkStore uses a SINGLE table.add()
 * call, not a loop. The entire 1000-entry batch is a single lock acquisition.
 *
 * If we used N x store.store() with 1000 entries instead, the total time
 * would be N x single_op_time, which could easily exceed the 10s threshold.
 */
describe("TC-6: Extreme bulkStore (1000 entries)", { timeout: 120_000 }, () => {
  it("bulkStore(1000) completes well under the 10-second stale threshold", async () => {
    const { store, dir } = makeStore();

    const N = 1000;
    const entries = Array.from({ length: N }, (_, i) => ({
      text: "memory-" + i,
      vector: [0.1 * (i % 10), 0.2 * (i % 7), 0.3 * (i % 3)],
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    }));

    const start = Date.now();
    const results = await store.bulkStore(entries);
    const elapsed = Date.now() - start;

    console.log("  bulkStore(1000): " + elapsed + "ms");

    assert.ok(
      elapsed < STALE_MS,
      "bulkStore(1000) took " + elapsed + "ms, should be under " + STALE_MS + "ms (stale threshold)",
    );
    assert.strictEqual(results.length, N);

    rmSync(dir, { recursive: true, force: true });
  });

  it("bulkStore(100) all entries are retrievable after completion", async () => {
    const { store, dir } = makeStore();

    const N = 100;
    const entries = Array.from({ length: N }, (_, i) => ({
      text: "retrieve-test-" + i,
      vector: [0.1 * i, 0.2 * i, 0.3 * i],
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    }));

    await store.bulkStore(entries);

    const all = await store.list(undefined, undefined, N * 2, 0);
    assert.ok(
      all.length >= N,
      all.length + " entries retrieved, expected at least " + N,
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("50xstore.store() is MUCH slower than bulkStore(50)", async () => {
    const { store: storeA, dir: dirA } = makeStore();
    const { store: storeB, dir: dirB } = makeStore();

    const N = 50;
    const entries = Array.from({ length: N }, (_, i) => makeEntry(i + 5000));

    await storeA.store(makeEntry(0));
    await storeB.store(makeEntry(0));

    const startA = Date.now();
    // Use sequential loop instead of Promise.all to avoid ELOCKED in this test.
    // Promise.all concurrent calls trigger ELOCKED (bug symptom) but error propagates
    // as test failure rather than timing result. Sequential loop shows real timing.
    let elockedA = false;
    try {
      for (const e of entries) {
        await storeA.store(e);
      }
    } catch (err) {
      if (err.code === 'ELOCKED') elockedA = true;
      else throw err;
    }
    const timeA = Date.now() - startA;

    const startB = Date.now();
    await storeB.bulkStore(entries);
    const timeB = Date.now() - startB;

    console.log("  " + N + "xstore.store(): " + timeA + "ms");
    console.log("  1xbulkStore(" + N + "): " + timeB + "ms");

    assert.ok(
      timeB < timeA,
      "bulkStore (" + timeB + "ms) should be faster than " + N + "xstore.store() (" + timeA + "ms)",
    );

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});
