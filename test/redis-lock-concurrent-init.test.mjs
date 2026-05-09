/**
 * Redis Lock Concurrent Init Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });
const mod = jitiImport("../src/redis-lock.ts");

describe("RedisLockManager concurrent init", () => {
  it("createRedisLockManager returns null when Redis is unavailable", async () => {
    const manager = await mod.createRedisLockManager({
      redisUrl: "redis://255.255.255.255:65535",
      maxWait: 1000,
    });
    assert.strictEqual(manager, null);
  });

  it("createRedisLockManager accepts config without crashing", async () => {
    const manager = await mod.createRedisLockManager({
      redisUrl: "redis://localhost:9999",
      ttl: 30000,
      maxWait: 1000,
      retryDelay: 50,
      dbPath: "/tmp/test-db",
    });
    if (manager === null) {
      // Expected when no Redis server is running
    } else {
      assert.ok(manager instanceof mod.RedisLockManager);
      await manager.disconnect();
    }
  });

  it("RedisUnavailableError has Symbol marker", async () => {
    const err = new mod.RedisUnavailableError("test error");
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, "RedisUnavailableError");
    const marker = Symbol.for("RedisUnavailableError");
    assert.strictEqual(err[marker], true);
  });

  it("isRedisConnectionError classifies connection errors", async () => {
    // ECONNREFUSED
    const connRefused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.strictEqual(mod.isRedisConnectionError(connRefused), true);

    // ETIMEDOUT
    const timedOut = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    assert.strictEqual(mod.isRedisConnectionError(timedOut), true);

    // ECONNRESET
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.strictEqual(mod.isRedisConnectionError(reset), true);

    // ENOTFOUND
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    assert.strictEqual(mod.isRedisConnectionError(notFound), true);

    // Non-connection error (ReplyError with WRONGTYPE)
    const replyErr = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    replyErr.name = "ReplyError";
    assert.strictEqual(mod.isRedisConnectionError(replyErr), false);
  });

  it("isRedisConnectionError handles nested errors", async () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = Object.assign(new Error("Aggregate error"), { errors: [inner] });
    assert.strictEqual(mod.isRedisConnectionError(outer), true);
  });

  it("isRedisConnectionError respects depth limit", async () => {
    const err1 = new Error("level 1");
    const err2 = new Error("level 2");
    const err3 = new Error("level 3");
    const err4 = new Error("level 4");
    err1.cause = err2;
    err2.cause = err3;
    err3.cause = err4;
    assert.strictEqual(mod.isRedisConnectionError(err1, 0), false);
  });
});