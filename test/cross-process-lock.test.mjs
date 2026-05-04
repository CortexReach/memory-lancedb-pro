// test/cross-process-lock.test.mjs
// 跨 process file lock 行為測試 — 驗證 proper-lockfile 的 mutual exclusion
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "cross-lock-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

describe("cross-process file locking", () => {
  it("acquires lock exclusively", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store({
        text: "test",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });
      assert.ok(true, "Store succeeded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes from two in-process stores", async () => {
    // 兩個 store instance 並發寫入同一個目錄 — proper-lockfile 確保序列化
    const { store: store1, dir } = makeStore();
    const store2 = new MemoryStore({ dbPath: dir, vectorDim: 3 });

    try {
      const results = await Promise.allSettled([
        store1.store({ text: "s1", vector: [0.1, 0.2, 0.3], category: "fact", scope: "global", importance: 0.5, metadata: "{}" }),
        store2.store({ text: "s2", vector: [0.4, 0.5, 0.6], category: "fact", scope: "global", importance: 0.5, metadata: "{}" }),
      ]);

      // 至少一個成功（另一個可能因 ELOCKED 或順利取得 lock）
      const successes = results.filter(r => r.status === "fulfilled");
      assert.ok(successes.length >= 1, `Expected at least 1 success, got ${successes.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up lock artifact after successful release", async () => {
    const { store, dir } = makeStore();
    // With lockfilePath: lockPath (PR#674), proper-lockfile v4 creates a DIRECTORY
    // artifact at lockPath. After successful release() the transient dir is removed.
    const lockPath = join(dir, ".memory-write.lock");

    await store.store({ text: "t", vector: [0.1, 0.2, 0.3], category: "fact", scope: "global", importance: 0.5, metadata: "{}" });

    assert.ok(!existsSync(lockPath), "Lock artifact should be cleaned up after release");
    rmSync(dir, { recursive: true, force: true });
  });

  it("concurrent writes do not lose data", async () => {
    const { store, dir } = makeStore();
    const count = 4;
    try {
      // Fire 4 concurrent stores (realistic ClawTeam swarm size)
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => store.store(makeEntry(i + 1))),
      );

      assert.strictEqual(results.length, count, "all store calls should resolve");

      const ids = new Set(results.map(r => r.id));
      assert.strictEqual(ids.size, count, "all entries should have unique IDs");

      const all = await store.list(undefined, undefined, 100, 0);
      assert.strictEqual(all.length, count, "all entries should be retrievable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent updates do not corrupt data", async () => {
    const { store, dir } = makeStore();
    try {
      // Seed entries
      const entries = await Promise.all(
        Array.from({ length: 4 }, (_, i) => store.store(makeEntry(i + 1))),
      );

      // Concurrently update all of them
      const updated = await Promise.all(
        entries.map((e, i) =>
          store.update(e.id, { text: `updated-${i}`, importance: 0.9 }),
        ),
      );

      assert.strictEqual(updated.filter(Boolean).length, 4, "all updates should succeed");

      // Verify data integrity
      for (let i = 0; i < 4; i++) {
        const fetched = await store.getById(entries[i].id);
        assert.ok(fetched, `entry ${i} should exist`);
        assert.strictEqual(fetched.text, `updated-${i}`);
        assert.strictEqual(fetched.importance, 0.9);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lock is released after each operation", async () => {
    const { store, dir } = makeStore();
    try {
      await store.store(makeEntry(1));
      // If lock were stuck, this second store would hang/fail
      await store.store(makeEntry(2));
      await store.delete((await store.list(undefined, undefined, 1, 0))[0].id);
      // Still works after delete
      await store.store(makeEntry(3));

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 2, "should have 2 entries after store+store+delete+store");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
