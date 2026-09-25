/**
 * fts-search-text-column.test.mjs
 *
 * The BM25 index used to sit on the `text` column, which holds only the L0
 * abstract, so a token that survived only in the overview or the content was
 * invisible to indexed keyword search. The index now sits on `search_text`
 * (abstract + summary layers), recomputed at every write, seeded and backfilled
 * by the schema migration on tables from before the column existed, and rebuilt
 * by reindex-fts. Fixtures are synthetic.
 *
 * Run: node --test test/fts-search-text-column.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";
import * as lancedb from "@lancedb/lancedb";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { buildSearchText, SEARCH_TEXT_COLUMN } = jiti("../src/search-text.ts");

const VECTOR = [0.1, 0.2, 0.3];

function layered({ abstract, overview, content }) {
  return {
    text: abstract,
    vector: VECTOR,
    category: "fact",
    scope: "global",
    importance: 0.6,
    metadata: JSON.stringify({ l0_abstract: abstract, l1_overview: overview, l2_content: content }),
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-search-text-"));
}

async function rawTable(dir) {
  const db = await lancedb.connect(dir);
  return db.openTable("memories");
}

async function ftsIndexColumns(dir) {
  const table = await rawTable(dir);
  return (await table.listIndices()).filter((idx) => idx.indexType === "FTS").map((idx) => idx.columns);
}

async function rawRow(dir, id) {
  const table = await rawTable(dir);
  const rows = await table.query().where(`id = '${id}'`).select(["id", "text", "metadata", SEARCH_TEXT_COLUMN]).toArray();
  return rows[0];
}

async function hasSearchTextColumn(dir) {
  const table = await rawTable(dir);
  return (await table.schema()).fields.some((field) => field.name === SEARCH_TEXT_COLUMN);
}

function forbidLexicalFallback(store) {
  store.lexicalFallbackSearch = async () => {
    throw new Error("lexical fallback ran; the indexed FTS path must answer");
  };
}

describe("buildSearchText", () => {
  it("joins the abstract with every summary layer and folds identical layers once", () => {
    const metadata = JSON.stringify({
      l0_abstract: "Keeps a pewter compass",
      l1_overview: "Keeps a pewter compass",
      l2_content: "The compass sits on the windowsill, serial quokkaledger-4471.",
    });
    assert.equal(
      buildSearchText("Keeps a pewter compass", metadata),
      "Keeps a pewter compass\nThe compass sits on the windowsill, serial quokkaledger-4471.",
    );
  });

  it("tolerates missing, empty and broken metadata", () => {
    assert.equal(buildSearchText("abstract only"), "abstract only");
    assert.equal(buildSearchText("abstract only", "{}"), "abstract only");
    assert.equal(buildSearchText("abstract only", "not json"), "abstract only");
    assert.equal(buildSearchText(null, JSON.stringify({ l2_content: "content only" })), "content only");
    assert.equal(buildSearchText("", ""), "");
  });
});

describe("search_text column", () => {
  it("indexes search_text on a fresh store and finds a content-only token through the index", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const stored = await store.store(layered({
        abstract: "Keeps a pewter compass on the windowsill",
        overview: "## Preference\n- pewter compass on the windowsill",
        content: "The compass case is engraved with the serial quokkaledger-4471.",
      }));
      assert.deepEqual(await ftsIndexColumns(dir), [[SEARCH_TEXT_COLUMN]]);
      const row = await rawRow(dir, stored.id);
      assert.equal(row[SEARCH_TEXT_COLUMN], buildSearchText(stored.text, stored.metadata));

      forbidLexicalFallback(store);
      const hits = await store.bm25Search("quokkaledger-4471", 5);
      assert.equal(hits.length, 1, "the content-only token must be reachable through indexed BM25");
      assert.equal(hits[0].entry.id, stored.id);
      assert.equal(hits[0].entry.text, stored.text, "results still surface the abstract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomputes search_text on every rewrite path (update, upsert)", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const stored = await store.store(layered({
        abstract: "Row with a changing content layer",
        overview: "## Fact\n- content changes",
        content: "First content layer carries alphaledger1101.",
      }));

      const updated = await store.update(stored.id, {
        metadata: JSON.stringify({
          l0_abstract: stored.text,
          l1_overview: "## Fact\n- content changes",
          l2_content: "Second content layer carries betaledger2202.",
        }),
      });
      assert.ok(updated, "update must return the entry");
      let row = await rawRow(dir, stored.id);
      assert.ok(row[SEARCH_TEXT_COLUMN].includes("betaledger2202"), row[SEARCH_TEXT_COLUMN]);
      assert.ok(!row[SEARCH_TEXT_COLUMN].includes("alphaledger1101"), row[SEARCH_TEXT_COLUMN]);

      await store.upsert({
        ...stored,
        metadata: JSON.stringify({
          l0_abstract: stored.text,
          l1_overview: "## Fact\n- content changes",
          l2_content: "Third content layer carries gammaledger3303.",
        }),
      });
      row = await rawRow(dir, stored.id);
      assert.ok(row[SEARCH_TEXT_COLUMN].includes("gammaledger3303"), row[SEARCH_TEXT_COLUMN]);
      assert.ok(!row[SEARCH_TEXT_COLUMN].includes("betaledger2202"), row[SEARCH_TEXT_COLUMN]);

      forbidLexicalFallback(store);
      const hits = await store.bm25Search("gammaledger3303", 5);
      assert.equal(hits[0]?.entry.id, stored.id);
      // A zero-hit FTS query legitimately falls through to the lexical scan,
      // which only sees live rows: the superseded layer must be gone there too.
      delete store.lexicalFallbackSearch;
      const stale = await store.bm25Search("alphaledger1101", 5);
      assert.equal(stale.length, 0, "the superseded content layer is no longer searchable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a table from before the column existed: adds, backfills and moves the index", async () => {
    const dir = tempDir();
    const first = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const a = await first.store(layered({
        abstract: "Row one abstract",
        overview: "## One",
        content: "First content carries deltaledger4404.",
      }));
      const b = await first.store(layered({
        abstract: "Row two abstract",
        overview: "## Two",
        content: "Second content carries epsilonledger5505.",
      }));

      // Rebuild the pre-upgrade layout: no search_text column, FTS on the abstract.
      const table = await rawTable(dir);
      for (const idx of (await table.listIndices()).filter((entry) => entry.indexType === "FTS")) {
        await table.dropIndex(idx.name);
      }
      await table.dropColumns([SEARCH_TEXT_COLUMN]);
      await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: true }) });
      assert.equal(await hasSearchTextColumn(dir), false);
      assert.deepEqual(await ftsIndexColumns(dir), [["text"]]);

      const reopened = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      await reopened.ensureInitialized();
      assert.equal(await hasSearchTextColumn(dir), true, "the migration adds the column");
      assert.deepEqual(await ftsIndexColumns(dir), [[SEARCH_TEXT_COLUMN]], "the FTS index moves off the abstract");
      for (const entry of [a, b]) {
        const row = await rawRow(dir, entry.id);
        assert.equal(row[SEARCH_TEXT_COLUMN], buildSearchText(entry.text, entry.metadata), `row ${entry.id} backfilled from its layers`);
      }
      assert.deepEqual(
        await reopened.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 0, updated: 0 },
        "the migration-time backfill leaves nothing stale",
      );

      forbidLexicalFallback(reopened);
      const hits = await reopened.bm25Search("epsilonledger5505", 5);
      assert.equal(hits[0]?.entry.id, b.id, "content-only tokens of pre-upgrade rows are searchable after the migration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfillSearchText reports and repairs stale rows", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const stored = await store.store(layered({
        abstract: "Row whose column goes stale",
        overview: "## Stale",
        content: "Content carries zetaledger6606.",
      }));
      const table = await rawTable(dir);
      await table.update({ where: `id = '${stored.id}'`, values: { [SEARCH_TEXT_COLUMN]: "stale value" } });
      assert.equal((await rawRow(dir, stored.id))[SEARCH_TEXT_COLUMN], "stale value");

      assert.deepEqual(await store.backfillSearchText({ dryRun: true }), { scanned: 1, stale: 1, updated: 0 });
      assert.equal((await rawRow(dir, stored.id))[SEARCH_TEXT_COLUMN], "stale value", "dryRun writes nothing");
      assert.deepEqual(await store.backfillSearchText(), { scanned: 1, stale: 1, updated: 1 });
      assert.equal((await rawRow(dir, stored.id))[SEARCH_TEXT_COLUMN], buildSearchText(stored.text, stored.metadata));
      assert.deepEqual(await store.backfillSearchText({ dryRun: true }), { scanned: 1, stale: 0, updated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reindex-fts rebuilds a single index on search_text even when a legacy index is left behind", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const stored = await store.store(layered({
        abstract: "Row for the rebuild",
        overview: "## Rebuild",
        content: "Content carries etaledger7707.",
      }));
      const table = await rawTable(dir);
      await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: true }) });
      assert.equal((await ftsIndexColumns(dir)).length, 2, "fixture: two FTS indices before the rebuild");

      const result = await store.rebuildFtsIndex();
      assert.deepEqual(result, { success: true });
      assert.deepEqual(await ftsIndexColumns(dir), [[SEARCH_TEXT_COLUMN]]);

      forbidLexicalFallback(store);
      const hits = await store.bm25Search("etaledger7707", 5);
      assert.equal(hits[0]?.entry.id, stored.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
