import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function makeTable(rows) {
  return {
    async listIndices() {
      return [];
    },
    query() {
      const builder = {
        where() {
          return builder;
        },
        select() {
          return builder;
        },
        async toArray() {
          return rows;
        },
      };
      return builder;
    },
  };
}

describe("MemoryStore lexical metadata search", () => {
  it("matches recall terms that are only present in L2 metadata", async () => {
    const row = {
      id: "memory-search-l2",
      text: "Concise abstract without the rare token.",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.8,
      timestamp: Date.now(),
      metadata: stringifySmartMetadata(buildSmartMetadata(
        {
          text: "Concise abstract without the rare token.",
          category: "fact",
          importance: 0.8,
          timestamp: Date.now(),
          metadata: "{}",
        },
        {
          l0_abstract: "Concise abstract without the rare token.",
          l1_overview: "- Search should inspect smart metadata",
          l2_content: "Full retained content includes CalypsoTicket-786 for lexical recall.",
          memory_category: "cases",
        },
      )),
    };

    const store = new MemoryStore({ dbPath: "/unused", vectorDim: 3 });
    store.table = makeTable([row]);

    const results = await store.bm25Search("CalypsoTicket-786", 5);

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, "memory-search-l2");
    assert.equal(results[0].entry.text, row.text);
    assert.ok(results[0].score > 0);
  });
});
