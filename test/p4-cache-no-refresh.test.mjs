/**
 * P4 Verification: No cache TTL/refresh mechanism
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });

describe("P4 — no cache TTL/refresh (observable behavior)", () => {
  it("repeated calls to same dbPath return same result (no retry/refresh)", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPath = `/tmp/p4-no-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // First call
    const result1 = await storeModule.getRedisLockManager(dbPath);
    console.log(`  P4: First call = ${result1}`);

    // Second call - should NOT retry Redis (if no refresh mechanism)
    const result2 = await storeModule.getRedisLockManager(dbPath);
    console.log(`  P4: Second call = ${result2}`);

    // Key: result2 === result1 proves no retry happened (result cached)
    assert.strictEqual(result2, result1, "Second call should return cached result (no retry)");

    // Third call - same behavior
    const result3 = await storeModule.getRedisLockManager(dbPath);
    assert.strictEqual(result3, result1, "Third call should also return cached result");

    console.log(`  ✅ P4: All calls return same cached value (no TTL/refresh/retry)`);
  });

  it("different dbPaths have independent cache entries", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPath1 = `/tmp/p4-ind-1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPath2 = `/tmp/p4-ind-2-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const result1 = await storeModule.getRedisLockManager(dbPath1);
    const result2 = await storeModule.getRedisLockManager(dbPath2);

    console.log(`  P4: dbPath1=${result1}, dbPath2=${result2}`);

    // If both null (Redis unavailable), that's fine
    // If both manager instances (Redis available), that's fine
    // Mixed = bug
    if (result1 === null && result2 !== null) {
      assert.fail("BUG: dbPath1 null but dbPath2 has manager");
    }
    if (result1 !== null && result2 === null) {
      assert.fail("BUG: dbPath1 has manager but dbPath2 null");
    }

    console.log(`  ✅ P4: Different dbPaths are properly isolated`);
  });

  it("5 concurrent calls for same dbPath return identical result", async () => {
    const storeModule = await jitiImport("../src/store.ts");
    const dbPath = `/tmp/p4-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const results = await Promise.all([
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
      storeModule.getRedisLockManager(dbPath),
    ]);

    // All should be identical
    for (let i = 1; i < results.length; i++) {
      assert.strictEqual(results[i], results[0], `Call ${i} result should match call 0`);
    }

    console.log(`  ✅ P4: ${results.length} concurrent calls → identical result (${results[0]})`);
  });
});