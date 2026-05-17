import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
