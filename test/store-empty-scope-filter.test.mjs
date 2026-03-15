import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-empty-scope-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

describe("MemoryStore empty scopeFilter semantics", () => {
  it("treats [] as deny-all for scoped read APIs", async () => {
    const { store, dir } = makeStore();
    try {
      const entry = await store.store({
        text: "test memory",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      assert.deepStrictEqual(await store.list([], undefined, 20, 0), []);
      assert.deepStrictEqual(await store.vectorSearch([0.1, 0.2, 0.3], 5, 0.0, []), []);
      assert.deepStrictEqual(await store.bm25Search("test", 5, []), []);
      assert.deepStrictEqual(await store.stats([]), {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
      });
      assert.strictEqual(await store.getById(entry.id, []), null);
      await assert.rejects(() => store.delete(entry.id, []), /outside accessible scopes/);
      await assert.rejects(() => store.update(entry.id, { text: "changed" }, []), /outside accessible scopes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
