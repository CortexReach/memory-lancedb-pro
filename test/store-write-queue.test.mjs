// test/store-write-queue.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, __setLockfileModuleForTests } = jiti("../src/store.ts");
const {
  enqueueManualRecallMetadata,
  ManualRecallMetadataQueue,
} = jiti("../src/manual-recall-metadata-queue.ts");
const realLockfile = await import("proper-lockfile");
const EMPTY_GOVERNANCE_SNAPSHOT = {
  badRecallCount: 0,
  suppressedUntilTurn: 0,
};

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
      const originalMergeInsert = table.mergeInsert.bind(table);
      let deleteCalls = 0;
      let addCalls = 0;
      let mergeCalls = 0;
      table.delete = async (...args) => {
        deleteCalls += 1;
        return originalDelete(...args);
      };
      table.add = async (...args) => {
        addCalls += 1;
        return originalAdd(...args);
      };
      table.mergeInsert = (...args) => {
        mergeCalls += 1;
        return originalMergeInsert(...args);
      };

      const results = await store.applyManualRecallMetadataBatch([
        {
          id: a.id,
          expectedScope: "global",
          accessCountDelta: 4,
          accessedAt: 700,
          governanceSnapshot: {
            badRecallCount: 2,
            suppressedUntilTurn: 9,
            suppressedUntilMs: 900,
          },
        },
        {
          id: b.id,
          expectedScope: "global",
          accessCountDelta: 3,
          accessedAt: 600,
          governanceSnapshot: {
            badRecallCount: 1,
            suppressedUntilTurn: 4,
            suppressedUntilMs: 850,
          },
        },
        {
          id: c.id,
          expectedScope: "tech",
          accessCountDelta: 1,
          accessedAt: 900,
          governanceSnapshot: {
            badRecallCount: 0,
            suppressedUntilTurn: 0,
          },
        },
      ]);

      table.delete = originalDelete;
      table.add = originalAdd;
      table.mergeInsert = originalMergeInsert;

      assert.equal(deleteCalls, 0, "recall metadata updates must not delete full rows");
      assert.equal(addCalls, 0, "recall metadata updates must not use replacement add");
      assert.equal(mergeCalls, 1, "eligible rows should share one atomic merge");
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
            governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
          },
        ]),
        store.applyManualRecallMetadataBatch([
          {
            id: entry.id,
            expectedScope: "global",
            accessCountDelta: 3,
            accessedAt: now,
            governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
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

  it("refreshes the table under the write lock before merging recall metadata", async () => {
    const { store: writer, dir } = makeStore();
    let reader;
    try {
      const now = Date.now();
      const entry = await writer.store({
        ...makeEntry(1),
        metadata: JSON.stringify({
          access_count: 0,
          last_accessed_at: now - 2_000,
          last_confirmed_use_at: now - 2_000,
        }),
      });

      reader = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      assert.equal(JSON.parse((await reader.getById(entry.id)).metadata).access_count, 0);

      const [first] = await writer.applyManualRecallMetadataBatch([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: now - 1_000,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);
      assert.ok(first.entry);

      const [second] = await reader.applyManualRecallMetadataBatch([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: now,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);
      assert.ok(second.entry);

      const consistentReader = new MemoryStore({
        dbPath: dir,
        vectorDim: 3,
        readConsistencyInterval: 0,
      });
      try {
        const metadata = JSON.parse((await consistentReader.getById(entry.id)).metadata);
        assert.equal(metadata.access_count, 2);
        assert.equal(metadata.last_accessed_at, now);
      } finally {
        await consistentReader.destroy();
      }
    } finally {
      await reader?.destroy().catch(() => {});
      await writer.destroy().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves governance fields changed after the queued manual recall", async () => {
    const { store, dir } = makeStore();
    let queue;
    try {
      const entry = await store.store({
        ...makeEntry(1),
        metadata: JSON.stringify({
          access_count: 2,
          last_accessed_at: 900,
          last_confirmed_use_at: 800,
          last_injected_at: 1_000,
          bad_recall_count: 3,
          suppressed_until_turn: 7,
          suppressed_until_ms: 5_000,
        }),
      });

      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        warn: () => {},
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 1_100,
        governanceSnapshot: {
          badRecallCount: 3,
          suppressedUntilTurn: 7,
          suppressedUntilMs: 5_000,
        },
      }]);

      await store.patchMetadata(entry.id, {
        bad_recall_count: 4,
        suppressed_until_ms: 9_000,
      }, ["global"]);
      await queue.flush();

      const afterStaleRecall = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(afterStaleRecall.access_count, 3);
      assert.equal(afterStaleRecall.last_accessed_at, 1_100);
      assert.equal(afterStaleRecall.bad_recall_count, 4);
      assert.equal(afterStaleRecall.suppressed_until_turn, 7);
      assert.equal(afterStaleRecall.suppressed_until_ms, 9_000);

      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 1_200,
        governanceSnapshot: {
          badRecallCount: 4,
          suppressedUntilTurn: 7,
          suppressedUntilMs: 9_000,
        },
      }]);
      await queue.flush();

      const afterNewerRecall = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(afterNewerRecall.access_count, 4);
      assert.equal(afterNewerRecall.bad_recall_count, 0);
      assert.equal(afterNewerRecall.suppressed_until_turn, 0);
      assert.equal(afterNewerRecall.suppressed_until_ms, 0);
    } finally {
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resets suppression when only last_injected_at changed after recall", async () => {
    const { store, dir } = makeStore();
    let queue;
    try {
      const entry = await store.store({
        ...makeEntry(1),
        metadata: JSON.stringify({
          last_injected_at: 1_000,
          bad_recall_count: 3,
          suppressed_until_turn: 7,
          suppressed_until_ms: 5_000,
        }),
      });
      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        warn: () => {},
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 1_100,
        governanceSnapshot: {
          badRecallCount: 3,
          suppressedUntilTurn: 7,
          suppressedUntilMs: 5_000,
        },
      }]);

      await store.patchMetadata(entry.id, { last_injected_at: 1_050 }, ["global"]);
      await queue.flush();

      const metadata = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(metadata.last_injected_at, 1_050);
      assert.equal(metadata.bad_recall_count, 0);
      assert.equal(metadata.suppressed_until_turn, 0);
      assert.equal(metadata.suppressed_until_ms, 0);
    } finally {
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the current-scope recall when an older queued recall has a stale scope", async () => {
    const { store, dir } = makeStore();
    let queue;
    try {
      const entry = await store.store(makeEntry(1));
      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        maxRetries: 0,
        warn: () => {},
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 100,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);

      await store.upsert({ ...entry, scope: "agent:main" });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "agent:main",
        accessCountDelta: 1,
        accessedAt: 200,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);
      await queue.flush();

      const current = await store.getById(entry.id);
      assert.equal(current.scope, "agent:main");
      assert.equal(JSON.parse(current.metadata).access_count, 1);
      assert.deepEqual(queue.getPendingUpdates(), []);
    } finally {
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a committed recall after the file lock release fails", async () => {
    const { store, dir } = makeStore();
    const warnings = [];
    let queue;
    try {
      const entry = await store.store(makeEntry(1));
      __setLockfileModuleForTests({
        async lock() {
          return async () => {
            const error = new Error("simulated post-commit release failure");
            error.code = "EIO";
            throw error;
          };
        },
      });
      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        retryDelayMs: () => 60_000,
        maxRetries: 1,
        warn: (message) => warnings.push(message),
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: Date.now(),
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);

      await queue.flush();

      const metadata = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(metadata.access_count, 1);
      assert.deepEqual(queue.getPendingUpdates(), []);
      assert.ok(warnings.some((message) => /lock failed after the batch settled/.test(message)));
    } finally {
      __setLockfileModuleForTests(realLockfile);
      if (queue) await queue.drain();
      await store.destroy().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries only the uncommitted chunk after a later chunk query fails", async () => {
    const { store, dir } = makeStore();
    const originalMaxBatchSize = MemoryStore.MAX_BATCH_SIZE;
    let queue;
    let table;
    let originalQuery;
    try {
      const first = await store.store(makeEntry(1));
      const second = await store.store(makeEntry(2));
      MemoryStore.MAX_BATCH_SIZE = 1;

      table = store.table;
      originalQuery = table.query.bind(table);
      let queryCalls = 0;
      table.query = (...args) => {
        queryCalls += 1;
        if (queryCalls === 2) {
          return {
            where() {
              return {
                async toArray() {
                  throw new Error("simulated later chunk query failure");
                },
              };
            },
          };
        }
        return originalQuery(...args);
      };

      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        retryDelayMs: () => 60_000,
        warn: () => {},
      });
      queue.enqueue([
        { id: first.id, expectedScope: "global", accessCountDelta: 1, accessedAt: 100, governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT },
        { id: second.id, expectedScope: "global", accessCountDelta: 1, accessedAt: 100, governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT },
      ]);
      await queue.flush();

      assert.deepEqual(
        queue.getPendingUpdates().map(({ id }) => id),
        [second.id],
        "the committed first chunk must not be requeued",
      );

      table.query = originalQuery;
      await queue.flush();

      const firstMetadata = JSON.parse((await store.getById(first.id)).metadata);
      const secondMetadata = JSON.parse((await store.getById(second.id)).metadata);
      assert.equal(firstMetadata.access_count, 1);
      assert.equal(secondMetadata.access_count, 1);
    } finally {
      MemoryStore.MAX_BATCH_SIZE = originalMaxBatchSize;
      if (table && originalQuery) table.query = originalQuery;
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves original rows when atomic merge, add, and recovery paths fail", async () => {
    const { store, dir } = makeStore();
    let queue;
    let table;
    let originalDelete;
    let originalAdd;
    let originalQuery;
    let originalMergeInsert;
    try {
      const first = await store.store(makeEntry(1));
      const second = await store.store(makeEntry(2));
      const firstBefore = await store.getById(first.id);
      const secondBefore = await store.getById(second.id);
      table = store.table;
      originalDelete = table.delete.bind(table);
      originalAdd = table.add.bind(table);
      originalQuery = table.query.bind(table);
      originalMergeInsert = table.mergeInsert.bind(table);
      let deleteCalls = 0;
      let addCalls = 0;
      let queryCalls = 0;
      table.delete = async () => {
        deleteCalls += 1;
        throw new Error("legacy delete path must not run");
      };
      table.add = async () => {
        addCalls += 1;
        throw new Error("simulated replacement and rollback add failure");
      };
      table.query = (...args) => {
        queryCalls += 1;
        if (queryCalls > 1) {
          return {
            where() {
              return {
                async toArray() {
                  throw new Error("simulated recovery read failure");
                },
              };
            },
          };
        }
        return originalQuery(...args);
      };
      table.mergeInsert = () => ({
        whenMatchedUpdateAll() {
          return this;
        },
        async execute() {
          throw new Error("simulated atomic merge failure");
        },
      });

      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        retryDelayMs: () => 60_000,
        warn: () => {},
      });
      queue.enqueue([
        { id: first.id, expectedScope: "global", accessCountDelta: 1, accessedAt: 100, governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT },
        { id: second.id, expectedScope: "global", accessCountDelta: 1, accessedAt: 100, governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT },
      ]);
      await queue.flush();

      assert.equal(deleteCalls, 0);
      assert.equal(addCalls, 0);
      assert.equal(queryCalls, 2, "an uncertain merge should attempt one recovery read");
      assert.deepEqual(queue.getPendingUpdates(), [], "unverifiable merge state must not retry");

      table.delete = originalDelete;
      table.add = originalAdd;
      table.query = originalQuery;
      table.mergeInsert = originalMergeInsert;

      assert.deepEqual(await store.getById(first.id), firstBefore);
      assert.deepEqual(await store.getById(second.id), secondBefore);

    } finally {
      if (table && originalDelete) table.delete = originalDelete;
      if (table && originalAdd) table.add = originalAdd;
      if (table && originalQuery) table.query = originalQuery;
      if (table && originalMergeInsert) table.mergeInsert = originalMergeInsert;
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries an atomic merge only when recovery confirms it did not commit", async () => {
    const { store, dir } = makeStore();
    let queue;
    let table;
    let originalMergeInsert;
    try {
      const entry = await store.store(makeEntry(1));
      table = store.table;
      originalMergeInsert = table.mergeInsert.bind(table);
      table.mergeInsert = () => ({
        whenMatchedUpdateAll() {
          return this;
        },
        async execute() {
          throw new Error("simulated pre-commit atomic merge failure");
        },
      });
      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        retryDelayMs: () => 60_000,
        warn: () => {},
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 100,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);

      await queue.flush();
      assert.deepEqual(queue.getPendingUpdates().map(({ id }) => id), [entry.id]);

      table.mergeInsert = originalMergeInsert;
      await queue.flush();
      const metadata = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(metadata.access_count, 1);
    } finally {
      if (table && originalMergeInsert) table.mergeInsert = originalMergeInsert;
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry an atomic merge that committed before throwing", async () => {
    const { store, dir } = makeStore();
    let queue;
    let table;
    let originalMergeInsert;
    try {
      const entry = await store.store(makeEntry(1));
      table = store.table;
      originalMergeInsert = table.mergeInsert.bind(table);
      table.mergeInsert = (...args) => {
        const builder = originalMergeInsert(...args);
        return {
          whenMatchedUpdateAll(options) {
            const matchedBuilder = builder.whenMatchedUpdateAll(options);
            return {
              async execute(entries) {
                await matchedBuilder.execute(entries);
                throw new Error("simulated post-commit atomic merge failure");
              },
            };
          },
        };
      };
      queue = new ManualRecallMetadataQueue(store, {
        debounceMs: 60_000,
        retryDelayMs: () => 0,
        warn: () => {},
      });
      queue.enqueue([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 100,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);

      await queue.flush();
      assert.deepEqual(queue.getPendingUpdates(), []);

      table.mergeInsert = originalMergeInsert;
      await queue.flush();
      const metadata = JSON.parse((await store.getById(entry.id)).metadata);
      assert.equal(metadata.access_count, 1);
    } finally {
      if (table && originalMergeInsert) table.mergeInsert = originalMergeInsert;
      if (queue) await queue.drain();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates legacy null-scope rows as global without inserting a duplicate", async () => {
    const { store, dir } = makeStore();
    try {
      const entry = await store.store(makeEntry(1));
      await store.table.update({
        where: `id = ${JSON.stringify(entry.id)}`,
        valuesSql: { scope: "NULL" },
      });

      const [result] = await store.applyManualRecallMetadataBatch([{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 100,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);

      assert.ok(result.entry);
      const rows = await store.table.query()
        .where(`id = ${JSON.stringify(entry.id)}`)
        .toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].scope, "global");
      assert.equal(JSON.parse(rows[0].metadata).access_count, 1);
    } finally {
      await store.destroy().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains a retrying production metadata queue before store shutdown", async () => {
    const { store, dir } = makeStore();
    const keepAlive = setInterval(() => {}, 1_000);
    let destroyed = false;
    try {
      const entry = await store.store(makeEntry(1));
      const originalApply = store.applyManualRecallMetadataBatch.bind(store);
      let attempts = 0;
      let resolveFirstAttempt;
      const firstAttempt = new Promise((resolve) => {
        resolveFirstAttempt = resolve;
      });
      store.applyManualRecallMetadataBatch = async (updates) => {
        attempts += 1;
        if (attempts === 1) {
          resolveFirstAttempt();
          return updates.map((update) => ({
            id: update.id,
            entry: null,
            error: "simulated retry window",
          }));
        }
        return originalApply(updates);
      };

      enqueueManualRecallMetadata(store, [{
        id: entry.id,
        expectedScope: "global",
        accessCountDelta: 1,
        accessedAt: 100,
        governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
      }]);
      await firstAttempt;
      await new Promise((resolve) => setImmediate(resolve));

      await store.destroy();
      destroyed = true;
      assert.equal(attempts, 2, "shutdown should immediately drain the scheduled retry");

      const reopened = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      try {
        const metadata = JSON.parse((await reopened.getById(entry.id)).metadata);
        assert.equal(metadata.access_count, 1);
      } finally {
        await reopened.destroy();
      }
    } finally {
      clearInterval(keepAlive);
      if (!destroyed) await store.destroy().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
