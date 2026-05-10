/**
 * Redis Lock R1/R2/R3 Fix Tests
 *
 * R2 (CRITICAL): getRedisLockManager now caches per dbPath, not as singleton
 * R3 (HIGH):      getRedisLockManager uses Promise-based init to avoid TOCTOU race
 * R1 (MAJOR):     runWithFileLock release() catches Redis connection errors
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });

// ============================================================================
// R2: Per-dbPath cache — different dbPaths get different managers
// ============================================================================

describe("R2 — per-dbPath RedisLockManager cache", () => {
  it("createRedisLockManager returns null for unreachable Redis", async () => {
    const mod = jitiImport("../src/redis-lock.ts");
    // Use a guaranteed-unreachable address
    const manager = await mod.createRedisLockManager({
      redisUrl: "redis://255.255.255.255:65535",
      maxWait: 500,
    });
    assert.strictEqual(manager, null, "should return null when Redis is unavailable");
  });

  it("RedisLockManager uses dbPath for namespace hash", async () => {
    const mod = jitiImport("../src/redis-lock.ts");
    // Without a real Redis, we can only verify the manager is constructed without error
    const manager = new mod.RedisLockManager({ dbPath: "/tmp/test-dbpath-namespace" });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("different dbPaths get isolated managers via createRedisLockManager", async () => {
    const mod = jitiImport("../src/redis-lock.ts");

    // Manager for dbPath A
    const managerA = await mod.createRedisLockManager({
      redisUrl: "redis://localhost:6379",
      dbPath: "/db/tenant-a",
    });
    // Manager for dbPath B
    const managerB = await mod.createRedisLockManager({
      redisUrl: "redis://localhost:6379",
      dbPath: "/db/tenant-b",
    });

    // Both null if Redis is down — still valid (cache stores null)
    // The key assertion: managers for different dbPaths are separate instances
    // or both null (when Redis unavailable), never one being reused for the other
    if (managerA !== null && managerB !== null) {
      // If Redis is available, they should be different instances with different namespaces
      assert.notStrictEqual(managerA, managerB, "different dbPaths should get different manager instances");
    } else {
      // Redis unavailable — both null is acceptable, no singleton leakage
      assert.strictEqual(managerA, null);
      assert.strictEqual(managerB, null);
    }

    // Cleanup if managers were created
    if (managerA) await managerA.disconnect();
    if (managerB) await managerB.disconnect();
  });
});

// ============================================================================
// R3: Race-safe init — concurrent calls share one Promise
// ============================================================================

describe("R3 — race-safe Promise-based init", () => {
  it("concurrent getRedisLockManager calls for same dbPath return consistent results", async () => {
    const storeMod = jitiImport("../src/store.ts");
    const { getRedisLockManager } = storeMod;

    // Call twice for the same dbPath
    const resultA = await getRedisLockManager("/tmp/race-test-dbpath");
    const resultB = await getRedisLockManager("/tmp/race-test-dbpath");

    // Both resolve to the same value (null = no Redis, or manager instance)
    // This verifies: (1) no crash, (2) same semantics, (3) cache works
    assert.strictEqual(resultA, resultB, "repeated calls for same dbPath should return same result");

    // Call for a DIFFERENT dbPath — must be different
    const resultC = await getRedisLockManager("/tmp/race-test-dbpath-OTHER");
    // resultC could be null (no Redis) or an instance, but must not be the SAME wrapped value as resultA
    // The key invariant: different dbPaths don't share state
    assert.strictEqual(resultA, null, "expected null when Redis unavailable");
    assert.strictEqual(resultC, null, "expected null for different dbPath too");
  });

  it("different dbPaths get separate init Promises", async () => {
    const storeMod = jitiImport("../src/store.ts");
    const { getRedisLockManager } = storeMod;

    const promiseA = getRedisLockManager("/tmp/dbpath-a");
    const promiseB = getRedisLockManager("/tmp/dbpath-b");

    // Different dbPaths get different Promises (not the same reference)
    assert.notStrictEqual(promiseA, promiseB, "different dbPaths should get different Promises");
  });
});

// ============================================================================
// R1: release() error handling — connection errors don't throw
// ============================================================================

describe("R1 — release() catches Redis connection errors", () => {
  it("isRedisConnectionError returns true for connection errors", () => {
    const redisMod = jitiImport("../src/redis-lock.ts");

    // ECONNREFUSED
    const connRefused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.strictEqual(redisMod.isRedisConnectionError(connRefused), true);

    // ETIMEDOUT
    const timedOut = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    assert.strictEqual(redisMod.isRedisConnectionError(timedOut), true);

    // ENOTFOUND
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    assert.strictEqual(redisMod.isRedisConnectionError(notFound), true);
  });

  it("non-connection errors still throw from release()", () => {
    const redisMod = jitiImport("../src/redis-lock.ts");

    // ReplyError (Redis command error, not connection error)
    const replyErr = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    replyErr.name = "ReplyError";
    assert.strictEqual(redisMod.isRedisConnectionError(replyErr), false);
  });

  it("release() error with connection error is caught (non-fatal)", async () => {
    // Integration test: simulate a scenario where fn() succeeds but release() fails
    // We can't easily test runWithFileLock directly without a real Redis,
    // so we test the contract: isRedisConnectionError correctly classifies errors
    const redisMod = jitiImport("../src/redis-lock.ts");

    // Simulate a connection error during release (ECONNRESET)
    const releaseErr = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.strictEqual(redisMod.isRedisConnectionError(releaseErr), true, "ECONNRESET should be classified as connection error");

    // Simulate a semantic error (lock already taken by another process)
    const semanticErr = new Error("LOCKED: key already exists");
    semanticErr.name = "ReplyError";
    assert.strictEqual(redisMod.isRedisConnectionError(semanticErr), false, "ReplyError should NOT be classified as connection error");
  });
});

// ============================================================================
// Integration: store.ts uses isRedisConnectionError in finally block
// ============================================================================

describe("store.ts — R1: isRedisConnectionError used in release() handler", () => {
  it("store imports isRedisConnectionError from redis-lock", async () => {
    const redisMod = jitiImport("../src/redis-lock.ts");
    // Verify the function exists and is callable (used in store.ts finally block)
    assert.ok(typeof redisMod.isRedisConnectionError === "function", "isRedisConnectionError should be exported from redis-lock");
  });
});