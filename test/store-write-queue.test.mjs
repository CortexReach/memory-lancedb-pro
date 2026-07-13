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

function assertVectorClose(actual, expected) {
  assert.equal(actual?.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 1e-6,
      `vector[${index}] expected ${expected[index]}, got ${actual[index]}`,
    );
  }
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

  it("bulkUpdateExact updates multiple exact IDs while preserving vectors", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store(makeEntry(1));
      const b = await store.store(makeEntry(2));

      const results = await store.bulkUpdateExact([
        { id: a.id, updates: { text: "memory-1-upgraded", metadata: "{\"upgraded\":true}" } },
        { id: b.id, updates: { text: "memory-2-upgraded", importance: 0.95 } },
      ]);

      assert.strictEqual(results.length, 2);
      assert.ok(results.every((result) => result.entry), "all exact updates should succeed");

      const fetchedA = await store.getById(a.id);
      const fetchedB = await store.getById(b.id);

      assertVectorClose(fetchedA?.vector, a.vector);
      assertVectorClose(fetchedB?.vector, b.vector);
      assert.strictEqual(fetchedA?.text, "memory-1-upgraded");
      assert.strictEqual(fetchedA?.metadata, "{\"upgraded\":true}");
      assert.strictEqual(fetchedB?.text, "memory-2-upgraded");
      assert.strictEqual(fetchedB?.importance, 0.95);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges manual-recall deltas and governance resets in one locked batch", async () => {
    const { store, dir } = makeStore();
    try {
      const a = await store.store({
        ...makeEntry(1),
        metadata: JSON.stringify({
          access_count: 5,
          last_accessed_at: 500,
          last_confirmed_use_at: 400,
          bad_recall_count: 2,
          suppressed_until_turn: 9,
          suppressed_until_ms: 900,
        }),
      });
      const b = await store.store({
        ...makeEntry(2),
        metadata: JSON.stringify({
          access_count: 2,
          last_accessed_at: 800,
          last_confirmed_use_at: 700,
          bad_recall_count: 1,
          suppressed_until_turn: 4,
          suppressed_until_ms: 850,
        }),
      });
      const c = await store.store(makeEntry(3));

      const table = store.table;
      const originalDelete = table.delete.bind(table);
      const originalAdd = table.add.bind(table);
      let deleteCalls = 0;
      let addCalls = 0;
      table.delete = async (...args) => {
        deleteCalls += 1;
        return originalDelete(...args);
      };
      table.add = async (...args) => {
        addCalls += 1;
        return originalAdd(...args);
      };

      const results = await store.applyManualRecallMetadataBatch([
        { id: a.id, expectedScope: "global", accessCountDelta: 4, accessedAt: 700 },
        { id: b.id, expectedScope: "global", accessCountDelta: 3, accessedAt: 600 },
        { id: c.id, expectedScope: "tech", accessCountDelta: 1, accessedAt: 900 },
      ]);

      table.delete = originalDelete;
      table.add = originalAdd;

      assert.equal(deleteCalls, 1, "eligible rows should share one delete");
      assert.equal(addCalls, 1, "eligible rows should share one replacement add");
      assert.ok(results[0].entry);
      assert.ok(results[1].entry);
      assert.match(results[2].error, /scope changed from tech to global/);

      const metaA = JSON.parse((await store.getById(a.id)).metadata);
      const metaB = JSON.parse((await store.getById(b.id)).metadata);
      const metaC = JSON.parse((await store.getById(c.id)).metadata);

      assert.equal(metaA.access_count, 9);
      assert.equal(metaA.last_accessed_at, 700);
      assert.equal(metaA.last_confirmed_use_at, 700);
      assert.equal(metaA.bad_recall_count, 0);
      assert.equal(metaA.suppressed_until_turn, 0);
      assert.equal(metaA.suppressed_until_ms, 0);

      assert.equal(metaB.access_count, 5);
      assert.equal(metaB.last_accessed_at, 800, "stored access timestamp must not move backwards");
      assert.equal(metaB.last_confirmed_use_at, 700, "stored confirmation timestamp must not move backwards");
      assert.equal(metaB.bad_recall_count, 0);
      assert.equal(metaB.suppressed_until_turn, 0);
      assert.equal(metaB.suppressed_until_ms, 0);

      assert.equal(metaC.access_count, undefined, "scope mismatch must leave metadata untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not lose increments when recall metadata batches overlap", async () => {
    const { store, dir } = makeStore();
    try {
      const now = Date.now();
      const entry = await store.store({
        ...makeEntry(1),
        metadata: JSON.stringify({
          access_count: 7,
          last_accessed_at: now - 2_000,
          last_confirmed_use_at: now - 2_000,
        }),
      });

      const [first, second] = await Promise.all([
        store.applyManualRecallMetadataBatch([
          {
            id: entry.id,
            expectedScope: "global",
            accessCountDelta: 2,
            accessedAt: now - 1_000,
          },
        ]),
        store.applyManualRecallMetadataBatch([
          {
            id: entry.id,
            expectedScope: "global",
            accessCountDelta: 3,
            accessedAt: now,
          },
        ]),
      ]);

      assert.ok(first[0].entry);
      assert.ok(second[0].entry);
      const metadata = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(metadata.access_count, 12);
      assert.equal(metadata.last_accessed_at, now);
      assert.equal(metadata.last_confirmed_use_at, now);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
