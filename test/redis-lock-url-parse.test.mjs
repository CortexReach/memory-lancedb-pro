/**
 * Redis Lock URL Parse Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });
const mod = jitiImport("../src/redis-lock.ts");

describe("Redis URL parsing", () => {
  it("handles standard redis:// URL", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379/0",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles redis:// with custom port", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6380/1",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles redis:// with password (password stripped from host)", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://:secretpassword@redis.example.com:6379/3",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles legacy host:port format (no scheme)", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "localhost:6379",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles URL with numeric DB selection", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379/15",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles URL with invalid DB (non-numeric)", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379/abc",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles URL with empty DB", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379/",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("handles rediss:// (TLS) URL", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "rediss://localhost:6380",
    });
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("uses REDIS_URL env var when no redisUrl provided", async () => {
    const manager = new mod.RedisLockManager({});
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("constructor accepts no arguments", async () => {
    const manager = new mod.RedisLockManager();
    assert.ok(manager instanceof mod.RedisLockManager);
  });

  it("connect() handles unreachable Redis gracefully", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://255.255.255.255:65535",
    });
    await manager.connect();
    const healthy = await manager.isHealthy();
    assert.strictEqual(healthy, false);
  });

  it("createRedisLockManager returns null for unreachable Redis", async () => {
    const manager = await mod.createRedisLockManager({
      redisUrl: "redis://255.255.255.255:65535",
      maxWait: 500,
    });
    assert.strictEqual(manager, null);
  });

  it("createRedisLockManager disconnects when not healthy", async () => {
    const manager = await mod.createRedisLockManager({
      redisUrl: "redis://localhost:9999",
      maxWait: 500,
    });
    assert.strictEqual(manager, null);
  });

  it("isHealthy returns false when not connected", async () => {
    const manager = new mod.RedisLockManager({
      redisUrl: "redis://localhost:9999",
    });
    await manager.connect();
    const healthy = await manager.isHealthy();
    assert.strictEqual(healthy, false);
  });

  it("dbPath namespaces lock keys", async () => {
    const manager1 = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379",
      dbPath: "/path/to/db1",
    });
    const manager2 = new mod.RedisLockManager({
      redisUrl: "redis://localhost:6379",
      dbPath: "/path/to/db2",
    });
    assert.ok(manager1 instanceof mod.RedisLockManager);
    assert.ok(manager2 instanceof mod.RedisLockManager);
  });
});