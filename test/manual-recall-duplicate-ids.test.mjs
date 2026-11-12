/**
 * manual-recall-duplicate-ids.test.mjs
 *
 * Issue #1031: applyManualRecallMetadataBatch deduped its read by id keeping
 * the LAST physical row only, then merge-inserted one updated row per candidate
 * with whenMatchedUpdateAll — LanceDB overwrote every same-id target row with
 * that single source row, silently collapsing the duplicate group's distinct
 * vectors to one (verified by the reporter). The fix keeps the single-row merge
 * path byte-identical and adds a duplicate update path that rewrites each
 * matching row's own metadata snapshot in place, re-deriving search_text and
 * never touching vectors. This is the first test to drive the real API against
 * a real LanceDB table; failure injection reuses the update-consistency
 * monkey-patch pattern. All fixtures are synthetic.
 *
 * Run: node --test test/manual-recall-duplicate-ids.test.mjs
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

// Candidate ids must satisfy applyManualRecallMetadataBatch's validation
// (UUID-shaped or legacy stable id), so all fixtures use fixed UUIDs.
const DUP_ID_SAME_SCOPE = "3f2a9c1e-5b4d-4c8a-9e7f-1a2b3c4d5e6f";
const DUP_ID_MIXED_SCOPE = "5c4d3e2f-6a7b-4c9d-8e1f-2b3c4d5e6f7a";
const DUP_ID_SINGLE = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DUP_ID_UPDATE_FAIL = "9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e";
const DUP_ID_TWO_CANDIDATES = "1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const DUP_ID_DERIVED_FIELDS = "2b3c4d5e-6f7a-4b8c-9d0e-3f4a5b6c7d8e";

const RECALL_LAYERS = {
  l1_overview: "## Recall\n- shared overview layer",
  l2_content: "Shared recall content carries recallmarker9001.",
};

function recallMetadata(baseAccessCount) {
  return JSON.stringify({ ...RECALL_LAYERS, access_count: baseAccessCount });
}

// Plain import metadata with NO smart fields: valid_from, last_accessed_at,
// memory_category and fact_key must derive from each row's own fields instead
// of being read out of the stored JSON.
function plainImportMetadata() {
  return JSON.stringify({ note: "plain import metadata, no smart fields" });
}

function recallUpdate({ id, expectedScope = "global", accessCountDelta = 1, accessedAt = Date.now() }) {
  return {
    id,
    expectedScope,
    accessCountDelta,
    accessedAt,
    governanceSnapshot: { badRecallCount: 0, suppressedUntilTurn: 0 },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-recall-dup-"));
}

async function rawTable(dir) {
  const db = await lancedb.connect(dir);
  return db.openTable("memories");
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

function rowAtTimestamp(rows, timestamp) {
  const row = rows.find((candidate) => candidate.timestamp === timestamp);
  assert.ok(row, `expected a physical row with timestamp ${timestamp}`);
  return row;
}

// Failure-injection pattern from test/update-consistency-lancedb.test.mjs.
function wrapTableMethod(store, methodName, wrapper) {
  const table = store.table;
  assert.ok(table, `expected initialized table for ${methodName}`);
  const original = table[methodName].bind(table);
  table[methodName] = wrapper(original);
  return () => {
    table[methodName] = original;
  };
}

describe("applyManualRecallMetadataBatch duplicate-ID write path (real LanceDB)", () => {
  it("one candidate on a same-scope duplicate group: each row keeps its vector and increments from its own access_count base", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for the same-scope duplicate group";
      // Same id, same text+layers, DIFFERENT base access_count so each row's
      // metadata snapshot merge can be verified per row.
      await importRow(store, {
        id: DUP_ID_SAME_SCOPE,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: recallMetadata(3),
      });
      await importRow(store, {
        id: DUP_ID_SAME_SCOPE,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        metadata: recallMetadata(7),
      });

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: DUP_ID_SAME_SCOPE, accessCountDelta: 1 }),
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, DUP_ID_SAME_SCOPE);
      assert.equal(results[0].error, undefined, `unexpected error: ${results[0].error}`);
      assert.ok(results[0].entry, "the result carries a non-null entry");
      const entryAccessCount = JSON.parse(results[0].entry.metadata).access_count;
      assert.ok(
        entryAccessCount === 4 || entryAccessCount === 8,
        `entry access_count ${entryAccessCount} matches one of the updated rows`,
      );

      const rows = await rawRows(dir, DUP_ID_SAME_SCOPE);
      assert.equal(rows.length, 2, "still exactly two physical rows");
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.deepEqual(rowA.vector, VECTOR_A, "row A vector preserved");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B vector preserved (not collapsed)");
      assert.equal(JSON.parse(rowA.metadata).access_count, 4, "row A incremented from its own base");
      assert.equal(JSON.parse(rowB.metadata).access_count, 8, "row B incremented from its own base");
      for (const row of [rowA, rowB]) {
        assert.equal(row.text, text);
        assert.equal(row.scope, "global");
        assert.equal(
          row[SEARCH_TEXT_COLUMN],
          buildSearchText(row.text, row.metadata),
          "search_text re-derived from the row's new metadata",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mixed-scope group: only the expectedScope-matching row is updated, the sibling stays byte-identical", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for the mixed-scope duplicate group";
      await importRow(store, {
        id: DUP_ID_MIXED_SCOPE,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        scope: "global",
        metadata: recallMetadata(3),
      });
      await importRow(store, {
        id: DUP_ID_MIXED_SCOPE,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        scope: "agent:test",
        metadata: recallMetadata(5),
      });
      const rowsBefore = await rawRows(dir, DUP_ID_MIXED_SCOPE);
      const beforeB = rowAtTimestamp(rowsBefore, TS_B);

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: DUP_ID_MIXED_SCOPE, expectedScope: "global", accessCountDelta: 1 }),
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].error, undefined, `unexpected error: ${results[0].error}`);
      assert.ok(results[0].entry, "the result carries a non-null entry");

      const rowsAfter = await rawRows(dir, DUP_ID_MIXED_SCOPE);
      assert.equal(rowsAfter.length, 2);
      const afterA = rowAtTimestamp(rowsAfter, TS_A);
      const afterB = rowAtTimestamp(rowsAfter, TS_B);
      assert.equal(JSON.parse(afterA.metadata).access_count, 4, "row A access_count bumped");
      assert.deepEqual(afterA.vector, VECTOR_A, "row A vector unchanged");
      assert.equal(
        afterA[SEARCH_TEXT_COLUMN],
        buildSearchText(afterA.text, afterA.metadata),
        "row A search_text re-derived",
      );
      assert.deepEqual(afterB, beforeB, "row B is byte-identical (whole-row comparison)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("candidate whose expectedScope matches no row: non-retryable scope-changed error and no row touched", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for the scope-mismatch check";
      await importRow(store, {
        id: DUP_ID_MIXED_SCOPE,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        scope: "global",
        metadata: recallMetadata(3),
      });
      await importRow(store, {
        id: DUP_ID_MIXED_SCOPE,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        scope: "agent:test",
        metadata: recallMetadata(5),
      });
      const rowsBefore = await rawRows(dir, DUP_ID_MIXED_SCOPE);

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: DUP_ID_MIXED_SCOPE, expectedScope: "agent:missing", accessCountDelta: 1 }),
      ]);
      assert.equal(results.length, 1);
      assert.ok(results[0].error, "the candidate reports an error");
      assert.match(results[0].error, /scope changed/);
      assert.equal(results[0].retryable, false, "scope changes are not retryable");
      assert.equal(results[0].entry, null);

      const rowsAfter = await rawRows(dir, DUP_ID_MIXED_SCOPE);
      assert.deepEqual(rowsAfter, rowsBefore, "no physical row was touched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mergeInsert failure on a single-row candidate: uncertain-merge recovery classifies retryable without corrupting data", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      await importRow(store, {
        id: DUP_ID_SINGLE,
        text: "Single-row abstract for the merge failure",
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: recallMetadata(3),
      });
      const rowsBefore = await rawRows(dir, DUP_ID_SINGLE);

      let failed = false;
      // mergeInsert starts a builder chain (mergeInsert(...).whenMatchedUpdateAll().execute()),
      // so the injection throws synchronously like a real failure at the call site.
      // An async wrapper would return a rejected promise, and the subsequent
      // .whenMatchedUpdateAll() on that promise would break the chain with a
      // TypeError while orphaning the rejection.
      const restore = wrapTableMethod(store, "mergeInsert", (original) => (...args) => {
        if (!failed) {
          failed = true;
          throw new Error("injected merge failure");
        }
        return original(...args);
      });
      let results;
      try {
        results = await store.applyManualRecallMetadataBatch([
          recallUpdate({ id: DUP_ID_SINGLE, accessCountDelta: 1 }),
        ]);
      } finally {
        restore();
      }

      assert.equal(results.length, 1);
      assert.ok(results[0].error, "the failed merge is reported as an error result, not a throw");
      assert.equal(results[0].retryable, true, "recovery classifies the untouched row as retryable");
      assert.equal(results[0].entry, null);
      const rowsAfter = await rawRows(dir, DUP_ID_SINGLE);
      assert.deepEqual(rowsAfter, rowsBefore, "no data corruption after the recovery re-read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("update failure on the duplicate path: retryable error with vectors and metadata intact", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for the update-failure injection";
      // Same text+metadata on both rows so the group is ONE update statement:
      // the injected throw fails the whole candidate, leaving every row pending.
      await importRow(store, {
        id: DUP_ID_UPDATE_FAIL,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: recallMetadata(4),
      });
      await importRow(store, {
        id: DUP_ID_UPDATE_FAIL,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        metadata: recallMetadata(4),
      });
      const rowsBefore = await rawRows(dir, DUP_ID_UPDATE_FAIL);

      let failed = false;
      const restore = wrapTableMethod(store, "update", (original) => async (...args) => {
        if (!failed) {
          failed = true;
          throw new Error("injected update failure");
        }
        return original(...args);
      });
      let results;
      try {
        results = await store.applyManualRecallMetadataBatch([
          recallUpdate({ id: DUP_ID_UPDATE_FAIL, accessCountDelta: 1 }),
        ]);
      } finally {
        restore();
      }

      assert.equal(results.length, 1);
      assert.ok(results[0].error, "the failed duplicate-path update is reported as an error result");
      assert.equal(results[0].retryable, true, "an entirely-untouched duplicate group stays retryable");
      assert.equal(results[0].entry, null);

      const rowsAfter = await rawRows(dir, DUP_ID_UPDATE_FAIL);
      assert.equal(rowsAfter.length, 2);
      const afterA = rowAtTimestamp(rowsAfter, TS_A);
      const afterB = rowAtTimestamp(rowsAfter, TS_B);
      assert.deepEqual(afterA.vector, VECTOR_A, "row A vector intact");
      assert.deepEqual(afterB.vector, VECTOR_B, "row B vector intact");
      assert.deepEqual(rowsAfter, rowsBefore, "metadata (and everything else) unchanged after re-read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same id under two candidates with different scopes: each scope's rows update without an ambiguous merge", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract for the two-candidate call";
      await importRow(store, {
        id: DUP_ID_TWO_CANDIDATES,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        scope: "global",
        metadata: recallMetadata(3),
      });
      await importRow(store, {
        id: DUP_ID_TWO_CANDIDATES,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        scope: "agent:test",
        metadata: recallMetadata(5),
      });

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: DUP_ID_TWO_CANDIDATES, expectedScope: "global", accessCountDelta: 1 }),
        recallUpdate({ id: DUP_ID_TWO_CANDIDATES, expectedScope: "agent:test", accessCountDelta: 2 }),
      ]);
      assert.equal(results.length, 2);
      assert.equal(results[0].error, undefined, `candidate 1 error: ${results[0].error}`);
      assert.ok(results[0].entry, "candidate 1 resolves to a non-null entry");
      assert.equal(results[1].error, undefined, `candidate 2 error: ${results[1].error}`);
      assert.ok(results[1].entry, "candidate 2 resolves to a non-null entry");
      assert.doesNotMatch(
        `${results[0].error ?? ""}${results[1].error ?? ""}`,
        /Ambiguous merge insert/,
        "same-id candidates under different scopes must never reach one mergeInsert",
      );

      const rows = await rawRows(dir, DUP_ID_TWO_CANDIDATES);
      assert.equal(rows.length, 2);
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.equal(JSON.parse(rowA.metadata).access_count, 4, "global row incremented by candidate 1's delta");
      assert.equal(JSON.parse(rowB.metadata).access_count, 7, "agent:test row incremented by candidate 2's delta");
      assert.deepEqual(rowA.vector, VECTOR_A, "row A vector unchanged");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B vector unchanged");
      for (const row of [rowA, rowB]) {
        assert.equal(
          row[SEARCH_TEXT_COLUMN],
          buildSearchText(row.text, row.metadata),
          "search_text re-derived on both rows",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same text+metadata but different timestamps: each row keeps its own derived metadata", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const text = "Shared abstract with identical metadata but different row timestamps";
      // Rows sharing id + text + old metadata do NOT share their derived new
      // metadata: parseSmartMetadata derives valid_from (and last_accessed_at)
      // from each row's own timestamp and memory_category/fact_key from its own
      // category. The plain JSON carries no smart fields, so every derived value
      // must come from the row itself — grouping such siblings into one statement
      // would stamp one row's snapshot onto the other.
      const sharedMetadata = plainImportMetadata();
      const sharedBaseAccessCount = JSON.parse(sharedMetadata).access_count ?? 0;
      await importRow(store, {
        id: DUP_ID_DERIVED_FIELDS,
        text,
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: sharedMetadata,
      });
      await importRow(store, {
        id: DUP_ID_DERIVED_FIELDS,
        text,
        vector: VECTOR_B,
        timestamp: TS_B,
        metadata: sharedMetadata,
      });

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: DUP_ID_DERIVED_FIELDS, accessCountDelta: 1 }),
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].error, undefined, `unexpected error: ${results[0].error}`);
      assert.ok(results[0].entry, "the result carries a non-null entry");

      const rows = await rawRows(dir, DUP_ID_DERIVED_FIELDS);
      assert.equal(rows.length, 2, "still exactly two physical rows");
      const rowA = rowAtTimestamp(rows, TS_A);
      const rowB = rowAtTimestamp(rows, TS_B);
      assert.deepEqual(rowA.vector, VECTOR_A, "row A vector preserved");
      assert.deepEqual(rowB.vector, VECTOR_B, "row B vector preserved (not collapsed)");

      const metadataA = JSON.parse(rowA.metadata);
      const metadataB = JSON.parse(rowB.metadata);
      assert.equal(metadataA.valid_from, TS_A, "row A valid_from derives from row A's own timestamp");
      assert.equal(metadataB.valid_from, TS_B, "row B valid_from derives from row B's own timestamp");
      assert.ok(
        metadataA.last_accessed_at >= TS_A,
        "row A last_accessed_at is max(previous, accessedAt), at least its own timestamp",
      );
      assert.ok(
        metadataB.last_accessed_at >= TS_B,
        "row B last_accessed_at is max(previous, accessedAt), at least its own timestamp",
      );
      assert.equal(metadataA.access_count, sharedBaseAccessCount + 1, "row A incremented from the shared base");
      assert.equal(metadataB.access_count, sharedBaseAccessCount + 1, "row B incremented from the shared base");
      assert.notEqual(
        rowA.metadata,
        rowB.metadata,
        "the siblings derive different metadata JSON (different valid_from), not one stamped snapshot",
      );

      assert.equal(
        rowA[SEARCH_TEXT_COLUMN],
        buildSearchText(rowA.text, rowA.metadata),
        "row A search_text matches its own new metadata",
      );
      assert.equal(
        rowB[SEARCH_TEXT_COLUMN],
        buildSearchText(rowB.text, rowB.metadata),
        "row B search_text matches its own new metadata",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
