import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, loadLanceDB } = jiti("../src/store.ts");

function makeDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-rci-"));
}

function makeEntry(i) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i, 0.4 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

// A writer's own writes are always immediately consistent on its own handle
// (per the LanceDB docs), so these tests use two independent MemoryStore
// instances against the same dbPath: a writer that deletes a row, and a
// reader whose handle was opened before the delete, to reproduce the
// cross-process staleness gap in-process.
describe("readConsistencyInterval staleness behavior", () => {
  it("reader with readConsistencyInterval unset does not see another connection's delete (negative control)", async () => {
    const dir = makeDir();
    try {
      const writer = new MemoryStore({ dbPath: dir, vectorDim: 4 });
      const e1 = await writer.store(makeEntry(1));
      await writer.store(makeEntry(2));

      const reader = new MemoryStore({ dbPath: dir, vectorDim: 4 });
      const before = await reader.list(undefined, undefined, 20, 0);
      assert.strictEqual(before.length, 2);

      await writer.delete(e1.id);

      const afterUnset = await reader.list(undefined, undefined, 20, 0);
      assert.strictEqual(
        afterUnset.length,
        2,
        "reader's pinned handle should still report the pre-delete row count",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reader with readConsistencyInterval 0 sees another connection's delete", async () => {
    const dir = makeDir();
    try {
      const writer = new MemoryStore({ dbPath: dir, vectorDim: 4 });
      const e1 = await writer.store(makeEntry(1));
      await writer.store(makeEntry(2));

      const reader = new MemoryStore({ dbPath: dir, vectorDim: 4, readConsistencyInterval: 0 });
      const before = await reader.list(undefined, undefined, 20, 0);
      assert.strictEqual(before.length, 2);

      await writer.delete(e1.id);

      const afterStrong = await reader.list(undefined, undefined, 20, 0);
      assert.strictEqual(
        afterStrong.length,
        1,
        "strong-consistency reader should observe the delete on its next read",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readConsistencyInterval config plumbing", () => {
  it("exposes the configured value via the readConsistencyInterval getter", () => {
    const dir = makeDir();
    try {
      const store = new MemoryStore({ dbPath: dir, vectorDim: 4, readConsistencyInterval: 12 });
      assert.strictEqual(store.readConsistencyInterval, 12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined by default", () => {
    const dir = makeDir();
    try {
      const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
      assert.strictEqual(store.readConsistencyInterval, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes readConsistencyInterval through to lancedb.connect()", async () => {
    const dir = makeDir();
    const lancedb = await loadLanceDB();
    const originalConnect = lancedb.connect;
    let capturedOptions;
    lancedb.connect = async (path, options) => {
      capturedOptions = options;
      return originalConnect(path, options);
    };
    try {
      const store = new MemoryStore({ dbPath: dir, vectorDim: 4, readConsistencyInterval: 7 });
      await store.ensureInitialized();
      assert.strictEqual(capturedOptions?.readConsistencyInterval, 7);
    } finally {
      lancedb.connect = originalConnect;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
