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

// Light (projected) pass and heavy (unprojected) pass answer from different
// row sets, so a row can change state between the two.
function makeTwoPhaseTable({ light, heavy }) {
  const calls = { projected: 0, unprojected: 0 };

  return {
    calls,
    async listIndices() {
      return [];
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
              return light;
            },
          };
        },
        async toArray() {
          calls.unprojected += 1;
          return heavy;
        },
      };
      return builder;
    },
  };
}

describe("MemoryStore fetchForCompaction: projection fallback and between-phase invalidation", () => {
  const timestamp = Date.now() - 60_000;
  const baseRow = {
    id: "memory-1",
    text: "remember the compaction fallback",
    vector: [0.1, 0.2, 0.3],
    category: "fact",
    scope: "global",
    importance: 0.8,
    timestamp,
    metadata: "{}",
  };

  it("falls back to unprojected rows when the light pass reads empty from a populated table", async () => {
    const fakeTable = makeProjectionEmptyTable([baseRow]);
    const store = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    store.table = fakeTable;

    const rows = await store.fetchForCompaction(timestamp + 1000, undefined, 10, { excludeInactive: true });

    assert.deepEqual(rows, [{ ...baseRow }], "the row must survive an empty projected light read");
    assert.equal(fakeTable.calls.projected, 1, "exactly one projected light read");
    assert.equal(fakeTable.calls.unprojected, 2, "the light-pass fallback plus the heavy id-IN fetch");
  });

  it("drops a row invalidated between the light and heavy passes under excludeInactive, and keeps it without", async () => {
    const liveMetadata = JSON.stringify({ valid_from: timestamp });
    const invalidatedMetadata = JSON.stringify({ valid_from: timestamp, invalidated_at: Date.now() - 1000 });
    const light = [{ id: baseRow.id, timestamp, metadata: liveMetadata }];
    const heavy = [{ ...baseRow, metadata: invalidatedMetadata }];

    const liveOnly = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    liveOnly.table = makeTwoPhaseTable({ light, heavy });
    assert.deepEqual(
      await liveOnly.fetchForCompaction(timestamp + 1000, undefined, 10, { excludeInactive: true }),
      [],
      "a row invalidated after the light pass must not come back live",
    );

    const blended = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    blended.table = makeTwoPhaseTable({ light, heavy });
    const rows = await blended.fetchForCompaction(timestamp + 1000, undefined, 10);
    assert.equal(rows.length, 1, "without excludeInactive the row is returned");
    assert.equal(rows[0].metadata, invalidatedMetadata, "the heavy pass returns the fresh metadata");
  });
});
