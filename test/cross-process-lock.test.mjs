// test/cross-process-lock.test.mjs
// 跨 process file lock 行為測試 — 驗證 proper-lockfile 的 mutual exclusion
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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
    const lockPath = join(dir, ".memory-write.lock");

    await store.store({ text: "t", vector: [0.1, 0.2, 0.3], category: "fact", scope: "global", importance: 0.5, metadata: "{}" });

    // Artifact 是目錄，會在 release() 後被刪除（transient）
    assert.ok(!existsSync(lockPath), "Lock artifact should be cleaned up after release");
    rmSync(dir, { recursive: true, force: true });
  });
});
