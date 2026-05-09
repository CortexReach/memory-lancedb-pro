/**
 * Redis Lock Error Types Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });
const mod = jitiImport("../src/redis-lock.ts");

describe("RedisUnavailableError", () => {
  it("is an Error subclass", () => {
    const err = new mod.RedisUnavailableError("Redis is down");
    assert.ok(err instanceof Error, "should be an Error instance");
    assert.ok(err instanceof mod.RedisUnavailableError, "should be RedisUnavailableError instance");
  });

  it("has correct name", () => {
    const err = new mod.RedisUnavailableError("connection refused");
    assert.strictEqual(err.name, "RedisUnavailableError");
  });

  it("preserves message", () => {
    const msg = "Redis at localhost:6379 refused connection";
    const err = new mod.RedisUnavailableError(msg);
    assert.strictEqual(err.message, msg);
  });

  it("has Symbol.for marker", () => {
    const err = new mod.RedisUnavailableError("test");
    const marker = Symbol.for("RedisUnavailableError");
    assert.strictEqual(err[marker], true);
  });

  it("marker is same across module instances", () => {
    const err1 = new mod.RedisUnavailableError("first");
    const err2 = new mod.RedisUnavailableError("second");
    const marker = Symbol.for("RedisUnavailableError");
    assert.strictEqual(err1[marker], true);
    assert.strictEqual(err2[marker], true);
  });

  it("toString() includes name and message", () => {
    const err = new mod.RedisUnavailableError("test message");
    const str = err.toString();
    assert.ok(str.includes("RedisUnavailableError"), `toString() should include name: ${str}`);
    assert.ok(str.includes("test message"), `toString() should include message: ${str}`);
  });
});

describe("isRedisConnectionError", () => {
  it("returns false for null/undefined", () => {
    assert.strictEqual(mod.isRedisConnectionError(null), false);
    assert.strictEqual(mod.isRedisConnectionError(undefined), false);
  });

  it("returns false for non-Error values", () => {
    assert.strictEqual(mod.isRedisConnectionError("not an error"), false);
    assert.strictEqual(mod.isRedisConnectionError(42), false);
    assert.strictEqual(mod.isRedisConnectionError({}), false);
  });

  it("returns false for ReplyError (Redis command error)", () => {
    const err = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    err.name = "ReplyError";
    assert.strictEqual(mod.isRedisConnectionError(err), false);
  });

  it("returns false for NOPERM (Redis permission error)", () => {
    const err = Object.assign(new Error("NOPERM this user has no permissions"), { name: "ReplyError", code: "NOPERM" });
    assert.strictEqual(mod.isRedisConnectionError(err), false);
  });

  it("returns true for MaxRetriesPerRequestError", () => {
    const err = new Error("MAX_RETRIES_PER_REQUEST_ERROR");
    err.name = "MaxRetriesPerRequestError";
    assert.strictEqual(mod.isRedisConnectionError(err), true);
  });

  it("returns true for ConnectionTimeoutError", () => {
    const err = new Error("Connection timed out");
    err.name = "ConnectionTimeoutError";
    assert.strictEqual(mod.isRedisConnectionError(err), true);
  });

  it("returns true for ReconnectionAttemptsLimitError", () => {
    const err = new Error("Reconnection limit reached");
    err.name = "ReconnectionAttemptsLimitError";
    assert.strictEqual(mod.isRedisConnectionError(err), true);
  });

  it("returns true for AbortedError", () => {
    const err = new Error("Connection aborted");
    err.name = "AbortedError";
    assert.strictEqual(mod.isRedisConnectionError(err), true);
  });

  it("returns true for cause chain with ECONNREFUSED", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = Object.assign(new Error("Redis connection failed"), { cause: inner });
    assert.strictEqual(mod.isRedisConnectionError(outer), true);
  });

  it("returns true for errors[] array (ioredis AggregateError)", () => {
    const inner = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const outer = Object.assign(new Error("Aggregate error"), { errors: [inner] });
    assert.strictEqual(mod.isRedisConnectionError(outer), true);
  });

  it("returns false for deeply nested non-connection error", () => {
    const inner = Object.assign(new Error("deep error"), { code: "UNKNOWN" });
    const level2 = Object.assign(new Error("level 2"), { cause: inner });
    const level3 = Object.assign(new Error("level 3"), { cause: level2 });
    assert.strictEqual(mod.isRedisConnectionError(level3), false);
  });
});

describe("LockConfig", () => {
  it("dbPath is stored in RedisLockManager", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379",
      dbPath: "/custom/db/path",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("accepts all LockConfig fields", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://redis.example.com:6380/2",
      ttl: 30000,
      maxWait: 15000,
      retryDelay: 200,
      dbPath: "/tmp/memory-test",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });
});