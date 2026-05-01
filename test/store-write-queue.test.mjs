// test/store-write-queue.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-write-queue-"));
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

describe("MemoryStore write queue", () => {
  it("serializes concurrent writes within the same store instance", async () => {
    const { store, dir } = makeStore();
    try {
      const results = await Promise.all([
        store.store(makeEntry(1)),
        store.store(makeEntry(2)),
        store.store(makeEntry(3)),
        store.store(makeEntry(4)),
      ]);

      assert.strictEqual(results.length, 4);

      const ids = new Set(results.map((r) => r.id));
      assert.strictEqual(ids.size, 4, "all writes should succeed with unique IDs");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 4, "all queued writes should persist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues processing queued writes after an earlier queued failure", async () => {
    const { store, dir } = makeStore();
    try {
      const created = await store.store(makeEntry(1));

      const failingWrite = store.update("00000000-0000-0000-0000-000000000000", { text: "should-fail" });
      const succeedingWrite = store.store(makeEntry(2));

      const failedResult = await failingWrite;
      assert.strictEqual(failedResult, null, "failed update should resolve to null");

      const created2 = await succeedingWrite;
      assert.ok(created2?.id, "later queued write should still succeed");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 2, "queue should continue processing after failure");

      const texts = new Set(all.map((x) => x.text));
      assert.deepStrictEqual(texts, new Set(["memory-1", "memory-2"]));
      assert.ok(created.id !== created2.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes mixed store/update/delete operations in one instance", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store(makeEntry(1));
      const b = await store.store(makeEntry(2));
      const c = await store.store(makeEntry(3));

      const [updatedA, deletedB, createdD] = await Promise.all([
        store.update(a.id, { text: "memory-1-updated", importance: 0.9 }),
        store.delete(b.id),
        store.store(makeEntry(4)),
      ]);

      assert.ok(updatedA, "update should succeed");
      assert.strictEqual(deletedB, true, "delete should succeed");
      assert.ok(createdD?.id, "new store should succeed");

      const all = await store.list(undefined, undefined, 20, 0);
      assert.strictEqual(all.length, 3, "final row count should be correct");

      const texts = new Set(all.map((x) => x.text));
      assert.deepStrictEqual(
        texts,
        new Set(["memory-1-updated", "memory-3", "memory-4"]),
      );

      const fetchedA = await store.getById(a.id);
      assert.ok(fetchedA);
      assert.strictEqual(fetchedA.text, "memory-1-updated");
      assert.strictEqual(fetchedA.importance, 0.9);

      const fetchedB = await store.getById(b.id);
      assert.strictEqual(fetchedB, null, "deleted entry should be gone");

      const fetchedC = await store.getById(c.id);
      assert.ok(fetchedC);
      assert.strictEqual(fetchedC.text, "memory-3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
