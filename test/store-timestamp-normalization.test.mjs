import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryStore, normalizeMemoryTimestamp } = jiti("../src/store.ts");

describe("memory timestamp normalization", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-timestamp-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function createStore() {
    return new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });
  }

  function wrapTableMethod(store, methodName, wrapper) {
    const table = store.table;
    assert.ok(table, `expected initialized table for ${methodName}`);
    const original = table[methodName].bind(table);
    table[methodName] = wrapper(original);
    return () => {
      table[methodName] = original;
    };
  }

  it("converts epoch seconds to epoch milliseconds", () => {
    assert.equal(normalizeMemoryTimestamp(1_234_567_890), 1_234_567_890_000);
    assert.equal(normalizeMemoryTimestamp("1234567890"), 1_234_567_890_000);
    assert.equal(normalizeMemoryTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(normalizeMemoryTimestamp(Number.NaN, 42), 42);
  });

  it("normalizes imported timestamps and second-based retention thresholds", async () => {
    const store = createStore();

    const imported = await store.importEntry({
      id: "legacy-seconds",
      text: "legacy import used epoch seconds",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_234_567_890,
      metadata: "{}",
    });

    assert.equal(imported.timestamp, 1_234_567_890_000);

    const loaded = await store.getById("legacy-seconds");
    assert.equal(loaded?.timestamp, 1_234_567_890_000);

    const deleted = await store.bulkDelete([], 1_234_567_891);
    assert.equal(deleted, 1);
    assert.equal(await store.count(), 0);
  });

  it("does not over-delete raw legacy second rows with millisecond cutoffs", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "raw-legacy-seconds",
      text: "raw legacy seconds row",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: "{}",
    }]);

    const deleted = await store.bulkDelete([], 1_600_000_000_000);
    assert.equal(deleted, 0);

    const loaded = await store.getById("raw-legacy-seconds");
    assert.equal(loaded?.timestamp, 1_700_000_000_000);
  });

  it("deletes legacy second rows before millisecond cutoffs inside the same second", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "raw-legacy-same-second",
      text: "raw legacy same second row",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: "{}",
    }]);

    const deleted = await store.bulkDelete([], 1_700_000_000_001);
    assert.equal(deleted, 1);
    assert.equal(await store.getById("raw-legacy-same-second"), null);
  });

  it("backfills persisted legacy second timestamps during initialization", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "persisted-legacy-seconds",
      text: "persisted legacy seconds row",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: "{}",
    }]);

    const reopened = createStore();
    const loaded = await reopened.getById("persisted-legacy-seconds");
    assert.equal(loaded?.timestamp, 1_700_000_000_000);

    const rawRows = await reopened.table.query()
      .where("id = 'persisted-legacy-seconds'")
      .toArray();
    assert.equal(rawRows[0].timestamp, 1_700_000_000_000);
  });

  it("keeps legacy rows if timestamp backfill replacement writes fail", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "legacy-backfill-write-failure",
      text: "legacy row survives failed backfill",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: "{}",
    }]);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    let failed = false;
    const restoreAdd = wrapTableMethod(store, "add", (original) => async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("injected backfill add failure");
      }
      return original(...args);
    });

    try {
      await store.backfillLegacySecondTimestamps(store.table);
    } finally {
      restoreAdd();
      console.warn = originalWarn;
    }

    assert.ok(warnings.some((message) => message.includes("could not normalize legacy second timestamps")));

    const rawRows = await store.table.query()
      .where("id = 'legacy-backfill-write-failure'")
      .toArray();
    assert.equal(rawRows.length, 1);
    assert.equal(rawRows[0].timestamp, 1_700_000_000);
    assert.equal((await store.getById("legacy-backfill-write-failure"))?.timestamp, 1_700_000_000_000);
  });

  it("writes a durable backup if timestamp backfill replacement and rollback both fail", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "legacy-backfill-double-write-failure",
      text: "legacy row survives in backup",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: "{}",
    }]);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    let failedAdds = 0;
    const restoreAdd = wrapTableMethod(store, "add", (original) => async (...args) => {
      if (failedAdds < 2) {
        failedAdds += 1;
        throw new Error("injected persistent add failure");
      }
      return original(...args);
    });

    try {
      await assert.rejects(
        store.backfillLegacySecondTimestamps(store.table),
        /Durable backup saved at/,
      );
    } finally {
      restoreAdd();
      console.warn = originalWarn;
    }

    assert.ok(warnings.some((message) => message.includes("Durable backup saved at")));

    const backupPath = path.join(
      store.dbPath,
      ".legacy-timestamp-backfill-backups",
      "legacy-backfill-double-write-failure.json",
    );
    assert.equal(existsSync(backupPath), true);

    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.equal(backup.row.id, "legacy-backfill-double-write-failure");
    assert.equal(backup.row.text, "legacy row survives in backup");
    assert.equal(backup.row.timestamp, 1_700_000_000);
  });

  it("backfills legacy last-access metadata during initialization", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "persisted-legacy-last-access",
      text: "persisted legacy last access row",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000,
      metadata: JSON.stringify({ last_accessed_at: 1_700_000_001 }),
    }]);

    const reopened = createStore();
    const loaded = await reopened.getById("persisted-legacy-last-access");
    const metadata = JSON.parse(loaded?.metadata ?? "{}");
    assert.equal(metadata.last_accessed_at, 1_700_000_001_000);
  });

  it("backfills legacy last-access metadata when the main timestamp is already milliseconds", async () => {
    const store = createStore();
    await store.count();

    await store.table.add([{
      id: "persisted-ms-with-legacy-last-access",
      text: "persisted millisecond timestamp with legacy last access",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000_000,
      metadata: JSON.stringify({ last_accessed_at: 1_700_000_001 }),
    }]);

    const reopened = createStore();
    const loaded = await reopened.getById("persisted-ms-with-legacy-last-access");
    const metadata = JSON.parse(loaded?.metadata ?? "{}");
    assert.equal(loaded?.timestamp, 1_700_000_000_000);
    assert.equal(metadata.last_accessed_at, 1_700_000_001_000);

    const rawRows = await reopened.table
      .query()
      .where("id = 'persisted-ms-with-legacy-last-access'")
      .limit(1)
      .toArray();
    assert.equal(Number(rawRows[0].timestamp), 1_700_000_000_000);
    assert.equal(JSON.parse(rawRows[0].metadata).last_accessed_at, 1_700_000_001_000);
  });

  it("does not treat nonpositive retention cutoffs as before-now predicates", async () => {
    const store = createStore();

    await store.importEntry({
      id: "recent-memory",
      text: "recent memory",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000_000,
      metadata: "{}",
    });

    assert.equal(await store.bulkDelete([], -1), 0);
    assert.equal(await store.bulkDelete([], Number.NaN), 0);
    assert.equal(await store.count(), 1);

    const compactionRows = await store.fetchForCompaction(0);
    assert.equal(compactionRows.length, 0);
  });
});
