import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

async function withTempStore(fn) {
  const { MemoryStore } = jiti("../src/store.ts");
  const dir = mkdtempSync(join(tmpdir(), "typed-array-vector-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 8 });
  try {
    await fn(store);
  } finally {
    await store.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("typed-array vectors surviving a real LanceDB round-trip", () => {
  it("fetchForCompaction returns the stored vector, not an empty array", async () => {
    await withTempStore(async (store) => {
      await store.store({
        text: "vector round-trip check",
        vector: new Array(8).fill(0.5),
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      const rows = await store.fetchForCompaction(Date.now() + 10_000, undefined, 100);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].vector.length, 8, "vector must round-trip with its real dimensionality, not collapse to []");
      assert.ok(Array.isArray(rows[0].vector), "vector must be a real Array, not a typed array");
      assert.deepEqual(rows[0].vector, new Array(8).fill(0.5));
    });
  });

  it("bm25Search returns a real Array for entry.vector, not a typed array", async () => {
    await withTempStore(async (store) => {
      await store.store({
        text: "searchable unique keyword xyzzy",
        vector: new Array(8).fill(0.25),
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      const results = await store.bm25Search("xyzzy", 5);
      assert.equal(results.length, 1);
      assert.ok(Array.isArray(results[0].entry.vector), "vector must be a real Array, not a typed array");
      assert.equal(results[0].entry.vector.length, 8);
      assert.deepEqual(results[0].entry.vector, new Array(8).fill(0.25));
    });
  });

  it("lexicalFallbackSearch returns a real Array for entry.vector, not a typed array", async () => {
    await withTempStore(async (store) => {
      await store.store({
        text: "searchable unique keyword zyzzx",
        vector: new Array(8).fill(0.75),
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      const results = await store.lexicalFallbackSearch("zyzzx", 5);
      assert.equal(results.length, 1);
      assert.ok(Array.isArray(results[0].entry.vector), "vector must be a real Array, not a typed array");
      assert.equal(results[0].entry.vector.length, 8);
      assert.deepEqual(results[0].entry.vector, new Array(8).fill(0.75));
    });
  });
});
