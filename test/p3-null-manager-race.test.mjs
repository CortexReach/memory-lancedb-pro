/**
 * P3 Verification: Cache behavior - can callers get null manager directly?
 *
 * Test: When initPromise is in-flight, do concurrent callers get the same Promise
 * (not the manager=null from the initial cache entry)?
 *
 * Key assertion: After all concurrent calls resolve, all must return identical results.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });

describe("P3 — null manager cache entry race", () => {
  it("concurrent calls return identical results (no null manager leak)", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPath = `/tmp/p3-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Fire 5 concurrent calls for the SAME dbPath
    const results = await Promise.all([
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
    ]);

    // Key assertion: ALL calls must return identical results
    for (let i = 1; i < results.length; i++) {
      assert.strictEqual(results[i], results[0],
        `Call ${i} result differs from call 0 (${results[i]} vs ${results[0]})`);
    }

    console.log(`  ✅ P3: ${results.length} concurrent calls → identical result (${results[0]})`);
  });

  it("different dbPaths get different results (isolated cache)", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPathA = `/tmp/p3-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPathB = `/tmp/p3-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const [resultA, resultB] = await Promise.all([
      storeModule.getRedisLockManager(dbPathA),
      storeModule.getRedisLockManager(dbPathB),
    ]);

    // If Redis is available, they should be different instances
    // If Redis is unavailable, both should be null
    // They should NEVER be different types (one null one manager)
    if (resultA !== null && resultB !== null) {
      assert.notStrictEqual(resultA, resultB, "Different dbPaths should get different instances");
    } else if (resultA === null && resultB !== null) {
      assert.fail("BUG: dbPathA got null but dbPathB got manager - cache leaking!");
    } else if (resultA !== null && resultB === null) {
      assert.fail("BUG: dbPathA got manager but dbPathB got null - cache leaking!");
    }
    // Both null is fine (Redis unavailable, correct isolation)

    console.log(`  ✅ P3: Different dbPaths are properly isolated (A=${resultA}, B=${resultB})`);
  });

  it("calling getRedisLockManager twice sequentially returns cached result", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPath = `/tmp/p3-sequential-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // First call - populates cache
    const result1 = await storeModule.getRedisLockManager(dbPath);

    // Second call - should return same value (from cache)
    const result2 = await storeModule.getRedisLockManager(dbPath);

    assert.strictEqual(result1, result2, "Sequential calls should return same cached result");
    console.log(`  ✅ P3: Sequential calls return same cached result (${result1})`);
  });
});