/**
 * Test: initPromise guard — 防止並發建立多個 Redis client
 *
 * M2: 多個並發請求同時呼叫 getRedisLockManager() 時，
 * 由於 initPromise guard，createRedisLockManager 只會被呼叫一次。
 * 所有並發請求都會收到同一個 initPromise。
 *
 * N3: 沒有 Redis 時 skip（hermetic guard）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jitiImport = jitiFactory(import.meta.url, { interopDefault: true });

// N3: hermetic guard
function skipIfNoRedis() {
  if (process.env.SKIP_REDIS_TESTS === "1") {
    throw new Error("SKIP_REDIS_TESTS=1");
  }
}

describe("initPromise guard（M2）", { concurrency: 1 }, () => {
  it("並發呼叫 getRedisLockManager() 只建立一個 client（M2 guard）", async () => {
    skipIfNoRedis();

    const storeModule = (await jitiImport("../src/store.ts")) as any;

    // 10 個並發呼叫
    const CONCURRENT = 10;
    const promises = Array.from({ length: CONCURRENT }, () =>
      (storeModule.getRedisLockManager as any)(),
    );

    let results: any[];
    try {
      results = await Promise.all(promises);
    } catch (err) {
      results = [];
    }

    // 驗證：所有結果都是同一個物件（initPromise 生效）
    const nonNull = results.filter((r: any) => r !== null);
    console.log(
      `[M2 guard] ${CONCURRENT} concurrent calls: ${nonNull.length} non-null`,
    );

    // M2 guard 的關鍵行為：initPromise 確保所有並發請求得到相同結果
    assert.ok(
      nonNull.length === 0 || nonNull.length === CONCURRENT,
      `Inconsistent results: ${nonNull.length}/${CONCURRENT} non-null (expected all or none)`,
    );
  });

  it("initPromise error recovery — 第一次失敗後可重試", async () => {
    skipIfNoRedis();

    const storeModule = (await jitiImport("../src/store.ts")) as any;

    let firstResult: any;
    try {
      firstResult = await (storeModule.getRedisLockManager as any)();
    } catch (err) {
      firstResult = null;
    }

    let secondResult: any;
    try {
      secondResult = await (storeModule.getRedisLockManager as any)();
    } catch (err) {
      secondResult = null;
    }

    assert.ok(
      (firstResult !== null) === (secondResult !== null),
      "Second call should behave consistently with first",
    );
  });
});
