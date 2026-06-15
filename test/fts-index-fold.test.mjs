import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";
import * as lancedb from "@lancedb/lancedb";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

// Mirrors MemoryStore.INDEX_FOLD_OP_THRESHOLD (private).
const FOLD_THRESHOLD = 20;

function makeEntry(i) {
  return {
    text: `fold probe row ${i} zephyr`,
    vector: [0.1, 0.2, 0.3],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

async function ftsIndexStats(dir) {
  const db = await lancedb.connect(dir);
  const table = await db.openTable("memories");
  const indices = await table.listIndices();
  const fts = indices.find(
    (idx) => idx.indexType === "FTS" || (idx.columns ?? []).includes("text"),
  );
  if (!fts) return null;
  return await table.indexStats(fts.name ?? "text_idx");
}

async function waitFor(probe, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return last;
}

describe("FTS index fold maintenance", () => {
  it("folds the unindexed tail after the data-modification threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-fold-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      for (let i = 0; i < FOLD_THRESHOLD; i++) {
        await store.store(makeEntry(i));
      }
      const folded = await waitFor(async () => {
        const stats = await ftsIndexStats(dir);
        return stats &&
          stats.numUnindexedRows === 0 &&
          stats.numIndexedRows >= FOLD_THRESHOLD
          ? stats
          : null;
      });
      assert.ok(
        folded,
        "expected a write-threshold index fold to clear the unindexed tail",
      );
      assert.equal(folded.numUnindexedRows, 0);
      assert.ok(folded.numIndexedRows >= FOLD_THRESHOLD);
    } finally {
      await store.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schedules a catch-up fold at init when a backlog already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-catchup-"));
    // Seed one row through the store so the table and FTS index exist.
    const seed = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    await seed.store(makeEntry(0));
    await seed.destroy();

    // Grow a backlog behind the store's back (no modification counters fire).
    const db = await lancedb.connect(dir);
    const table = await db.openTable("memories");
    const rows = [];
    for (let i = 1; i <= FOLD_THRESHOLD + 5; i++) {
      rows.push({
        id: `raw-backlog-${i}`,
        text: `backlog row ${i} quartz`,
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      });
    }
    await table.add(rows);
    const before = await ftsIndexStats(dir);
    assert.ok(
      before && before.numUnindexedRows >= FOLD_THRESHOLD,
      "precondition: an unindexed backlog above the threshold exists",
    );

    // A fresh store instance should detect the backlog during init and fold it.
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      await store.list(undefined, undefined, 1, 0); // trigger lazy init
      const folded = await waitFor(async () => {
        const stats = await ftsIndexStats(dir);
        return stats && stats.numUnindexedRows === 0 ? stats : null;
      });
      assert.ok(folded, "expected the startup catch-up fold to clear the backlog");
      assert.equal(folded.numUnindexedRows, 0);
    } finally {
      await store.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
