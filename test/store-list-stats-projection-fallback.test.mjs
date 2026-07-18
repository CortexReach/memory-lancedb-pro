import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeProjectionEmptyTable(rows, getIndices = () => []) {
  const calls = { projected: 0, unprojected: 0 };

  return {
    calls,
    async listIndices() {
      return getIndices();
    },
    query() {
      const builder = {
        where() {
          return builder;
        },
        select() {
          return {
            async toArray() {
              calls.projected += 1;
              return [];
            },
          };
        },
        async toArray() {
          calls.unprojected += 1;
          return rows;
        },
      };
      return builder;
    },
  };
}

describe("MemoryStore list/stats projection fallback", () => {
  it("falls back to unprojected LanceDB rows when projected metadata reads are empty", async () => {
    const timestamp = Date.now();
    const row = {
      id: "memory-1",
      text: "remember projection fallback",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp,
      metadata: "{}",
    };
    const fakeTable = makeProjectionEmptyTable([row]);
    const store = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    store.table = fakeTable;

    assert.deepEqual(await store.list(undefined, undefined, 10, 0), [
      {
        id: "memory-1",
        text: "remember projection fallback",
        vector: [],
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp,
        metadata: "{}",
      },
    ]);

    assert.deepEqual(await store.stats(), {
      totalCount: 1,
      liveCount: 1,
      scopeCounts: { global: 1 },
      categoryCounts: { fact: 1 },
    });

    assert.equal(fakeTable.calls.projected, 2);
    assert.equal(fakeTable.calls.unprojected, 2);
  });

  it("refreshes cached FTS support during stats", async () => {
    let indices = [];
    const fakeTable = makeProjectionEmptyTable([], () => indices);
    const store = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    store.table = fakeTable;
    store.ftsIndexCreated = false;

    assert.equal(store.hasFtsSupport, false);

    indices = [{ indexType: "FTS", columns: ["text"] }];

    assert.deepEqual(await store.stats(), {
      totalCount: 0,
      liveCount: 0,
      scopeCounts: {},
      categoryCounts: {},
    });
    assert.equal(store.hasFtsSupport, true);
  });
});
