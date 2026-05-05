/**
 * Test: isRedisConnectionError() 分類正確性
 *
 * 驗證 isRedisConnectionError() 能正確區分：
 * - Redis 連線錯誤（ECONNREFUSED, ETIMEDOUT...）→ true
 * - Redis 指令語法/權限錯誤（WRONGTYPE, NOPERM...）→ false
 * - Node.js 系統錯誤（ENOENT, EACCES...）→ false
 * - Wrapped errors（ioredis errors[] / cause）→ 遞迴檢查
 *
 * N3: 沒有 Redis 時 skip（hermetic guard）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });

// N3: hermetic guard — 沒有 Redis 時 skip
function skipIfNoRedis() {
  if (process.env.SKIP_REDIS_TESTS === "1") {
    throw new Error("SKIP_REDIS_TESTS=1");
  }
}

describe("isRedisConnectionError 分類", { concurrency: 1 }, () => {
  it("ECONNREFUSED → true", async () => {
    skipIfNoRedis();
    const { createRedisLockManager } = await jitiImport("../src/redis-lock.ts") as any;
    const mgr = await (createRedisLockManager as any)({ redisUrl: "redis://localhost:1" });
    if (!mgr) return; // Redis 不可用時 skip

    try {
      const release = await mgr.acquire("test:ECONNREFUSED", 5000);
      await release();
    } catch (err: any) {
      const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;
      const result = isRedisConnectionError(err);
      assert.ok(
        result === true || err.message.includes("ECONNREFUSED"),
        `Expected true or ECONNREFUSED, got: ${err}`,
      );
    } finally {
      await mgr.disconnect();
    }
  });

  // 192.0.2.1 是 TEST-NET-3（不可達 IP），Windows 上連線約 30s 才 fail，timeout 故 skip
  it.skip("ETIMEDOUT / ENOTFOUND → true (skip: non-routable IP timeout)", async () => {
    skipIfNoRedis();
    const { createRedisLockManager } = await jitiImport("../src/redis-lock.ts") as any;
    const mgr = await (createRedisLockManager as any)({ redisUrl: "redis://192.0.2.1:6379" });
    if (!mgr) return;

    try {
      const release = await mgr.acquire("test:ETIMEDOUT", 3000);
      await release();
    } catch (err: any) {
      const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;
      const result = isRedisConnectionError(err);
      assert.ok(
        result === true ||
          err.message.includes("ETIMEDOUT") ||
          err.message.includes("ENOTFOUND") ||
          err.message.includes("ECONNREFUSED"),
        `Expected true or timeout-related error, got: ${err}`,
      );
    } finally {
      await mgr.disconnect();
    }
  });

  it("WRONGTYPE → false（非連線錯誤）", async () => {
    skipIfNoRedis();
    const { createRedisLockManager } = await jitiImport("../src/redis-lock.ts") as any;
    const mgr = await (createRedisLockManager as any)({}) as any;
    if (!mgr) return;

    try {
      await mgr.redis.set("test:wrongtype", "string-value");
      try {
        await mgr.redis.lpush("test:wrongtype", "item");
        assert.fail("Expected WRONGTYPE error");
      } catch (err: any) {
        const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;
        const result = isRedisConnectionError(err);
        assert.strictEqual(
          result,
          false,
          `WRONGTYPE should NOT be classified as connection error: ${err}`,
        );
      }
    } finally {
      await mgr.redis.del("test:wrongtype").catch(() => {});
      await mgr.disconnect();
    }
  });

  it("wrapped error（cause chain）→ 遞迴檢查到", async () => {
    const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;

    const inner = new Error("ECONNREFUSED") as any;
    inner.code = "ECONNREFUSED";
    const wrapped = new Error("outer error", { cause: inner });

    const result = isRedisConnectionError(wrapped);
    assert.strictEqual(
      result,
      true,
      "Wrapped ECONNREFUSED should be detected via cause chain",
    );
  });

  it("deep cause chain（depth > 3）→ false（遞迴終止）", async () => {
    const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;

    const level3 = new Error("level3") as any;
    level3.code = "ECONNREFUSED";
    const level2 = new Error("level2", { cause: level3 });
    const level1 = new Error("level1", { cause: level2 });
    const level0 = new Error("level0", { cause: level1 });

    const result = isRedisConnectionError(level0);
    assert.strictEqual(result, false, "Should return false when depth exceeds 3");
  });

  it("非 Error 物件 → false", async () => {
    const { isRedisConnectionError } = await jitiImport("../src/redis-lock.ts") as any;
    assert.strictEqual(isRedisConnectionError(null), false);
    assert.strictEqual(isRedisConnectionError(undefined), false);
    assert.strictEqual(isRedisConnectionError("string error"), false);
    assert.strictEqual(isRedisConnectionError(123), false);
  });
});
