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
});
