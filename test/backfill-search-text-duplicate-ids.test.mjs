/**
 * backfill-search-text-duplicate-ids.test.mjs
 *
 * Issue #1031: backfillSearchTextRows pushed one entry per stale ROW's id into
 * its batches, so when several physical rows share one id (importEntry appends
 * without a uniqueness check) the per-batch re-query fetched the whole duplicate
 * group and mergeInsert("id").whenMatchedUpdateAll() blew up with
 * "Ambiguous merge insert" — and would have collapsed the group's distinct
 * vectors even without the error. The fixed write path must rewrite ONLY the
 * stale search_text per row: duplicate-ID groups keep every original vector and
 * every non-search_text field, siblings with different text/metadata each get
 * their own expected value, and the schema-migration caller (which re-adds the
 * column and backfills on reopen) behaves the same way. Fixtures are synthetic;
 * vectors use float32-exact values so round-trip comparisons never trip on
 * storage rounding.
 *
 * Run: node --test test/backfill-search-text-duplicate-ids.test.mjs
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

// Exactly representable in float32 (LanceDB's default vector storage), so a
// preserved vector deepEqual-compares bit-for-bit after any rewrite.
const VECTOR_A = [0.5, 0.25, 0.125];
const VECTOR_B = [1.5, 2.5, 3.75];

const TS_A = 1_700_000_000_000;
const TS_B = 1_700_000_000_500;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-backfill-dup-"));
}

async function rawTable(dir) {
  const db = await lancedb.connect(dir);
  return db.openTable("memories");
}

async function ftsIndexColumns(dir) {
  const table = await rawTable(dir);
  return (await table.listIndices())
    .filter((idx) => idx.indexType === "FTS")
    .map((idx) => idx.columns);
}

async function hasSearchTextColumn(dir) {
  const table = await rawTable(dir);
  return (await table.schema()).fields.some((field) => field.name === SEARCH_TEXT_COLUMN);
}

// Query rows come back as Arrow struct proxies with BigInt timestamps and
// Vector objects; normalize into plain comparable data once, at the boundary.
// Enumerate the known schema columns explicitly instead of relying on proxy
// key enumeration.
function canonicalRow(row) {
  const columns = [
    "id",
    "text",
    "vector",
    "category",
    "scope",
    "importance",
    "timestamp",
    "metadata",
    SEARCH_TEXT_COLUMN,
  ];
  const out = {};
  for (const key of columns) {
    const value = row[key];
    if (typeof value === "bigint") {
      out[key] = Number(value);
    } else if (value && typeof value === "object" && typeof value[Symbol.iterator] === "function") {
      out[key] = Array.from(value, (item) => (typeof item === "bigint" ? Number(item) : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function rawRows(dir, id) {
  const table = await rawTable(dir);
  return (await table.query().where(`id = '${id}'`).toArray()).map(canonicalRow);
}

function summaryMetadata({ overview, content }) {
  return JSON.stringify({
    l1_overview: overview,
    l2_content: content,
  });
}

async function importRow(store, overrides) {
  return store.importEntry({
    id: overrides.id,
    text: overrides.text,
    vector: overrides.vector,
    category: "fact",
    scope: overrides.scope ?? "global",
    importance: 0.6,
    timestamp: overrides.timestamp,
    metadata: overrides.metadata,
  });
}

async function corruptSearchText(dir, id, staleValue = "stale value") {
  const table = await rawTable(dir);
  await table.update({
    where: `id = '${id}'`,
    values: { [SEARCH_TEXT_COLUMN]: staleValue },
  });
}

function rowAtTimestamp(rows, timestamp) {
  const row = rows.find((candidate) => candidate.timestamp === timestamp);
  assert.ok(row, `expected a physical row with timestamp ${timestamp}`);
  return row;
}

describe("backfillSearchText duplicate-ID write path", () => {
  it("rewrites a stale unique-ID row without touching its other fields (dry-run writes nothing)", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Unique row abstract";
      const metadata = summaryMetadata({
        overview: "## Unique\n- unique overview layer",
        content: "Unique content carries backfillmarker1001.",
      });
      await importRow(store, {
        id: "backfill-unique-1",
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata,
      });
      const healthy = await importRow(store, {
        id: "backfill-healthy-1",
        text: "Healthy companion abstract",
        vector: VECTOR_B,
        timestamp: TS_B,
        metadata: summaryMetadata({
          overview: "## Healthy\n- healthy overview layer",
          content: "Healthy content carries backfillmarker2002.",
        }),
      });
      await corruptSearchText(dir, "backfill-unique-1");

      assert.deepEqual(
        await store.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 1, updated: 0 },
        "dry-run counts rows and writes nothing",
      );
      let rows = await rawRows(dir, "backfill-unique-1");
      assert.equal(
        rows[0][SEARCH_TEXT_COLUMN],
        "stale value",
        "dry-run leaves the stale value in place",
      );

      assert.deepEqual(
        await store.backfillSearchText(),
        { scanned: 2, stale: 1, updated: 1 },
        "apply rewrites exactly the stale rows",
      );
      const repaired = (await rawRows(dir, "backfill-unique-1"))[0];
      assert.equal(repaired[SEARCH_TEXT_COLUMN], buildSearchText(text, metadata));
      assert.equal(repaired.text, text);
      assert.equal(repaired.category, "fact");
      assert.equal(repaired.scope, "global");
      assert.equal(repaired.importance, 0.6);
      assert.equal(repaired.timestamp, TS_A);
      assert.equal(repaired.metadata, metadata);
      assert.deepEqual(repaired.vector, VECTOR_A);

      const companion = (await rawRows(dir, healthy.id))[0];
      assert.equal(
        companion[SEARCH_TEXT_COLUMN],
        buildSearchText(companion.text, companion.metadata),
        "the already-correct row stays correct",
      );
      assert.deepEqual(
        await store.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 0, updated: 0 },
        "a re-scan finds zero stale rows after the apply",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites both rows of a duplicate-ID group and keeps their distinct vectors", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for a duplicate group";
      const metadata = summaryMetadata({
        overview: "## Shared\n- shared overview layer",
        content: "Shared content carries backfillmarker3003.",
      });
      // importEntry appends without an id-uniqueness check: two physical rows,
      // same id/text/metadata, different vectors (the issue #1031 scenario).
      await importRow(store, { id: "backfill-dup-2", text, vector: VECTOR_A, timestamp: TS_A, metadata });
      await importRow(store, { id: "backfill-dup-2", text, vector: VECTOR_B, timestamp: TS_B, metadata });
      await corruptSearchText(dir, "backfill-dup-2");

      assert.deepEqual(
        await store.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 2, updated: 0 },
        "stale counts stale ROWS (one entry per duplicate row)",
      );
      assert.deepEqual(
        await store.backfillSearchText(),
        { scanned: 2, stale: 2, updated: 2 },
        "updated counts rows actually written, duplicates included",
      );

      const rows = await rawRows(dir, "backfill-dup-2");
      assert.equal(rows.length, 2, "the duplicate group still has two physical rows");
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.deepEqual(rowA.vector, VECTOR_A, "row A keeps its original vector");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B keeps its original vector");
      for (const row of [rowA, rowB]) {
        assert.equal(row[SEARCH_TEXT_COLUMN], buildSearchText(row.text, row.metadata));
        assert.equal(row.text, text);
        assert.equal(row.scope, "global");
        assert.equal(row.importance, 0.6);
        assert.equal(row.metadata, metadata);
      }
      assert.equal(rowA.timestamp, TS_A);
      assert.equal(rowB.timestamp, TS_B);
      assert.deepEqual(
        await store.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 0, updated: 0 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives each sibling of a mixed duplicate-ID group its own expected search_text", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const textA = "Mixed abstract one";
      const metadataA = summaryMetadata({
        overview: "## Mixed A\n- overview A",
        content: "Mixed content carries backfillmarker4004.",
      });
      const textB = "Mixed abstract two";
      const metadataB = summaryMetadata({
        overview: "## Mixed B\n- overview B",
        content: "Mixed content carries backfillmarker5005.",
      });
      await importRow(store, { id: "backfill-dup-3", text: textA, vector: VECTOR_A, timestamp: TS_A, metadata: metadataA });
      await importRow(store, { id: "backfill-dup-3", text: textB, vector: VECTOR_B, timestamp: TS_B, metadata: metadataB });
      await corruptSearchText(dir, "backfill-dup-3");

      assert.deepEqual(await store.backfillSearchText({ dryRun: true }), { scanned: 2, stale: 2, updated: 0 });
      assert.deepEqual(await store.backfillSearchText(), { scanned: 2, stale: 2, updated: 2 });

      const rows = await rawRows(dir, "backfill-dup-3");
      assert.equal(rows.length, 2);
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.equal(rowA[SEARCH_TEXT_COLUMN], buildSearchText(textA, metadataA), "row A gets its own expected value");
      assert.equal(rowB[SEARCH_TEXT_COLUMN], buildSearchText(textB, metadataB), "row B gets its own expected value");
      assert.notEqual(
        rowA[SEARCH_TEXT_COLUMN],
        rowB[SEARCH_TEXT_COLUMN],
        "the two siblings carry different expected values",
      );
      assert.deepEqual(rowA.vector, VECTOR_A, "row A vector untouched");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B vector untouched");
      assert.equal(rowA.text, textA);
      assert.equal(rowB.text, textB);
      assert.equal(rowA.metadata, metadataA);
      assert.equal(rowB.metadata, metadataB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips apostrophes and newlines through the duplicate-path rewrite", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Handles O'Brien's notes\nsecond line with 'quoted' fragments";
      const metadata = JSON.stringify({
        l1_overview: "## Overview 'quoted'\noverview spans\nmultiple lines",
        l2_content: "Content with 'apostrophes'\nand embedded\nnewlines",
      });
      await importRow(store, { id: "backfill-dup-4", text, vector: VECTOR_A, timestamp: TS_A, metadata });
      await importRow(store, { id: "backfill-dup-4", text, vector: VECTOR_B, timestamp: TS_B, metadata });
      await corruptSearchText(dir, "backfill-dup-4");

      assert.deepEqual(await store.backfillSearchText({ dryRun: true }), { scanned: 2, stale: 2, updated: 0 });
      assert.deepEqual(await store.backfillSearchText(), { scanned: 2, stale: 2, updated: 2 });

      const rows = await rawRows(dir, "backfill-dup-4");
      assert.equal(rows.length, 2);
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      const expected = buildSearchText(text, metadata);
      assert.ok(expected.includes("'") && expected.includes("\n"), "fixture carries the hard characters");
      assert.equal(
        rowA[SEARCH_TEXT_COLUMN],
        expected,
        "row A search_text round-trips apostrophes and newlines exactly",
      );
      assert.equal(rowB[SEARCH_TEXT_COLUMN], expected);
      assert.deepEqual(rowA.vector, VECTOR_A);
      assert.deepEqual(rowB.vector, VECTOR_B);
      assert.equal(rowA.metadata, metadata);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a duplicate-ID pre-upgrade table: re-adds search_text, keeps both vectors distinct", async () => {
    const dir = tempDir();
    const first = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Migration duplicate abstract";
      const metadata = summaryMetadata({
        overview: "## Migration\n- migration overview",
        content: "Migration content carries backfillmarker6006.",
      });
      await importRow(first, { id: "backfill-dup-5", text, vector: VECTOR_A, timestamp: TS_A, metadata });
      await importRow(first, { id: "backfill-dup-5", text, vector: VECTOR_B, timestamp: TS_B, metadata });

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
      assert.equal(await hasSearchTextColumn(dir), true, "the migration re-adds the column");
      assert.deepEqual(
        await ftsIndexColumns(dir),
        [[SEARCH_TEXT_COLUMN]],
        "the FTS index moves back onto search_text",
      );

      const rows = await rawRows(dir, "backfill-dup-5");
      assert.equal(rows.length, 2);
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.deepEqual(rowA.vector, VECTOR_A, "row A vector survived the migration");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B vector survived the migration");
      assert.equal(rowA[SEARCH_TEXT_COLUMN], buildSearchText(text, metadata), "row A search_text backfilled");
      assert.equal(rowB[SEARCH_TEXT_COLUMN], buildSearchText(text, metadata), "row B search_text backfilled");
      assert.deepEqual(
        await reopened.backfillSearchText({ dryRun: true }),
        { scanned: 2, stale: 0, updated: 0 },
        "the migration-time backfill leaves nothing stale",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
