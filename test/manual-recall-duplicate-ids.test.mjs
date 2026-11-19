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
const LEGACY_INT64_SEED_ID = "3d5a7f9b-2c4e-4a6d-8b1f-5e7c9a0d3f2b";
const LEGACY_INT64_DUP_ID = "7f9b3d5a-4e2c-4d6a-9b1f-8c5e7a9d2f3b";
const SEQ_COLLISION_ID = "9c1e5f7a-3b4d-4e8f-a2c6-7d8e9f0a1b2c";
const PARTIAL_FAILURE_ID = "a2b4c6d8-1e3f-4a5b-8c7d-9e0f1a2b3c5d";
const MERGE_SCOPE_COLLAPSE_ID = "b3d5e7f9-2a4c-4b6d-9e8f-0a1b2c3d4e6f";

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

  it("Int64 legacy table: exact raw-timestamp matching updates every same-id row", async () => {
    // Legacy tables store the timestamp column as Int64 (BigInt in JS), not
    // Float64 like the current schema — normalizeMemoryTimestamp explicitly
    // handles BigInt for them. A 2^53+1 timestamp loses precision through
    // Number() (9007199254740993 -> 9007199254740992), so the pre-fix
    // subgroup matcher built from the rounded number matched ZERO rows
    // ("updated 0 of 2") and the candidate stayed retryable forever. The fix
    // matches on the RAW value's exact decimal string instead.
    const dir = tempDir();
    try {
      const db = await lancedb.connect(dir);
      await db.createTable("memories", [{
        id: LEGACY_INT64_SEED_ID,
        text: "seed row",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.6,
        timestamp: 1_700_000_000_000n, // BigInt makes Arrow infer Int64
        metadata: JSON.stringify({ access_count: 3 }),
      }]);

      // Opening the store on the legacy layout runs the schema migration
      // (adds search_text; a migration console warning is expected here).
      const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
      await store.ensureInitialized();

      const table = await rawTable(dir);
      assert.match(
        String(await table.schema()),
        /timestamp:\s*int64/i,
        "the legacy timestamp column must stay Int64 after the migration",
      );
      await table.add([
        {
          id: LEGACY_INT64_DUP_ID,
          text: "big int64 timestamp row",
          vector: VECTOR_A,
          category: "fact",
          scope: "global",
          importance: 0.6,
          timestamp: 9007199254740993n,
          metadata: JSON.stringify({ access_count: 3 }),
        },
        {
          id: LEGACY_INT64_DUP_ID,
          text: "big int64 timestamp row",
          vector: VECTOR_B,
          category: "fact",
          scope: "global",
          importance: 0.6,
          timestamp: 9007199254740993n,
          metadata: JSON.stringify({ access_count: 3 }),
        },
      ]);

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: LEGACY_INT64_DUP_ID, accessCountDelta: 1 }),
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].error, undefined, `unexpected error: ${results[0].error}`);
      assert.ok(results[0].entry, "the result carries a non-null entry");

      // Read the rows RAW (not through canonicalRow) for the timestamp:
      // Int64 values come back as BigInt and must be compared as
      // BigInt/string — never through Number(), which is exactly the
      // rounding this case guards against.
      const afterTable = await rawTable(dir);
      const rawAfter = await afterTable.query()
        .where(`id = '${LEGACY_INT64_DUP_ID}'`)
        .toArray();
      assert.equal(rawAfter.length, 2, "still exactly two physical rows");
      assert.deepEqual(
        rawAfter.map((row) => String(row.timestamp)).sort(),
        ["9007199254740993", "9007199254740993"],
        "the persisted Int64 timestamp is untouched by the update (exact raw value, never rounded)",
      );
      const canonicalAfter = rawAfter.map(canonicalRow);
      assert.deepEqual(
        canonicalAfter.map((row) => JSON.parse(row.metadata).access_count),
        [4, 4],
        "both same-id rows incremented from their own base (old code updated 0 of 2)",
      );
      assert.deepEqual(
        canonicalAfter.map((row) => JSON.stringify(row.vector)).sort(),
        [JSON.stringify(VECTOR_A), JSON.stringify(VECTOR_B)],
        "both vectors unchanged and distinct",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sequential subgroup statements must not re-update an earlier subgroup's output", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      // FULL normalized smart-metadata: the siblings differ ONLY by
      // access_count, so subgroup A's derived output (access_count 4,
      // everything else identical) byte-equals subgroup B's OLD metadata
      // string. With statements in insertion order, B's later statement
      // re-updates A's already-written row ([3,4] -> [5,5] reported
      // success), so the fix executes subgroups in DESCENDING old
      // access_count order: any collision X.output == Y.old implies
      // Y.old.access_count > X.old.access_count, making every later
      // statement's old-metadata matcher unreachable by earlier outputs.
      const T = 1_700_050_000_000;
      const norm = (ac) => JSON.stringify({
        access_count: ac,
        last_accessed_at: T,
        last_confirmed_use_at: T,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
        l0_abstract: "shared",
        l1_overview: "- shared",
        l2_content: "shared",
        memory_category: "cases",
        tier: "working",
        confidence: 0.7,
        valid_from: 1_700_000_000_000,
        state: "confirmed",
        source: "legacy",
        memory_layer: "working",
        injected_count: 0,
        suppressed_until_ms: 0,
      });
      await importRow(store, {
        id: SEQ_COLLISION_ID,
        text: "shared",
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: norm(3),
      });
      await importRow(store, {
        id: SEQ_COLLISION_ID,
        text: "shared",
        vector: VECTOR_B,
        timestamp: TS_A,
        metadata: norm(4),
      });

      const results = await store.applyManualRecallMetadataBatch([
        recallUpdate({ id: SEQ_COLLISION_ID, accessCountDelta: 1, accessedAt: T }),
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].error, undefined, `unexpected error: ${results[0].error}`);
      assert.ok(results[0].entry, "the result carries a non-null entry");

      const rows = await rawRows(dir, SEQ_COLLISION_ID);
      assert.equal(rows.length, 2, "still exactly two physical rows");
      assert.deepEqual(
        rows.map((row) => JSON.parse(row.metadata).access_count).sort((a, b) => a - b),
        [4, 5],
        "access counts [4, 5]: each row bumped exactly once (old code produced [5, 5] and reported success)",
      );
      assert.deepEqual(
        rows.map((row) => JSON.stringify(row.vector)).sort(),
        [JSON.stringify(VECTOR_A), JSON.stringify(VECTOR_B)],
        "both vectors unchanged and distinct",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("partially applied duplicate update is not retried", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      // Plain (NOT normalized) metadata, so each subgroup's derived output
      // stays distinct and the two subgroups run as two separate UPDATE
      // statements. The second statement fails mid-application AFTER the
      // first one committed: a mixed partial state must NOT be retryable,
      // because the queue's retry would re-apply the full delta to the
      // already-updated row (old code returned retryable:true here).
      await importRow(store, {
        id: PARTIAL_FAILURE_ID,
        text: "shared partial-commit abstract",
        vector: VECTOR_A,
        timestamp: TS_A,
        metadata: JSON.stringify({ access_count: 3, tag: "A" }),
      });
      await importRow(store, {
        id: PARTIAL_FAILURE_ID,
        text: "shared partial-commit abstract",
        vector: VECTOR_B,
        timestamp: TS_A,
        metadata: JSON.stringify({ access_count: 7, tag: "B" }),
      });

      let updateCalls = 0;
      const restore = wrapTableMethod(store, "update", (original) => async (...args) => {
        updateCalls += 1;
        if (updateCalls === 2) {
          throw new Error("injected second-subgroup failure");
        }
        return original(...args);
      });
      let results;
      try {
        results = await store.applyManualRecallMetadataBatch([
          recallUpdate({ id: PARTIAL_FAILURE_ID, accessCountDelta: 1 }),
        ]);
      } finally {
        restore();
      }

      assert.equal(results.length, 1);
      assert.ok(results[0].error, "the partially applied update reports an error, not a success");
      assert.match(
        results[0].error,
        /partial/i,
        "the error names the partial application (old code reported a plain retryable failure)",
      );
      assert.equal(
        results[0].retryable,
        false,
        "a mixed partial state (one subgroup committed, one pending) must not be retried",
      );

      const rows = await rawRows(dir, PARTIAL_FAILURE_ID);
      assert.equal(rows.length, 2, "still exactly two physical rows");
      // Exactly one subgroup committed (+1) before the injected failure and
      // the failed subgroup keeps its own base. Which physical row landed
      // depends on the subgroup execution order (descending old access_count
      // after the collision fix), so accept either partial split.
      const counts = rows
        .map((row) => JSON.parse(row.metadata).access_count)
        .sort((a, b) => a - b);
      assert.ok(
        (counts[0] === 3 && counts[1] === 8) || (counts[0] === 4 && counts[1] === 7),
        `expected one committed subgroup (+1) and one left at its own base, got ${JSON.stringify(counts)}`,
      );
      assert.deepEqual(
        rows.map((row) => JSON.stringify(row.vector)).sort(),
        [JSON.stringify(VECTOR_A), JSON.stringify(VECTOR_B)],
        "vectors intact",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge-path recovery classifies by scope, not last sibling", async () => {
    const dir = tempDir();
    const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      // Duplicate id across scopes with the candidate targeting the GLOBAL
      // row. The merge-failure recovery used to re-read by id only (last
      // physical row wins) and here misread the agent:test sibling, wrongly
      // classifying the untouched targeted global row as non-retryable. The
      // fix keys the re-read rows by (id, scope) and looks them up with the
      // entry's own scope.
      await importRow(store, {
        id: MERGE_SCOPE_COLLAPSE_ID,
        text: "global row for the mixed-scope merge failure",
        vector: VECTOR_A,
        timestamp: TS_A,
        scope: "global",
        metadata: JSON.stringify({ access_count: 3 }),
      });
      await importRow(store, {
        id: MERGE_SCOPE_COLLAPSE_ID,
        text: "agent row for the mixed-scope merge failure",
        vector: VECTOR_B,
        timestamp: TS_B,
        scope: "agent:test",
        metadata: JSON.stringify({ access_count: 5 }),
      });
      const rowsBefore = await rawRows(dir, MERGE_SCOPE_COLLAPSE_ID);
      const beforeAgent = rowsBefore.find((row) => row.scope === "agent:test");
      assert.ok(beforeAgent, "fixture: one agent:test sibling row");

      let failed = false;
      // mergeInsert starts a builder chain (see the single-row merge-failure
      // case): the injection must throw synchronously at the call site, not
      // return a rejected promise that orphans the builder chain.
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
          recallUpdate({
            id: MERGE_SCOPE_COLLAPSE_ID,
            expectedScope: "global",
            accessCountDelta: 1,
          }),
        ]);
      } finally {
        restore();
      }

      assert.equal(results.length, 1);
      assert.ok(results[0].error, "the failed merge is reported as an error result, not a throw");
      assert.match(
        results[0].error,
        /Atomic recall metadata merge failed/,
        "the error keeps the retryable merge-failure wording",
      );
      assert.equal(
        results[0].retryable,
        true,
        "the untouched targeted global row is retryable (old code misread the agent:test sibling)",
      );
      assert.equal(results[0].entry, null);

      const rowsAfter = await rawRows(dir, MERGE_SCOPE_COLLAPSE_ID);
      assert.equal(rowsAfter.length, 2, "still exactly two physical rows");
      const afterGlobal = rowsAfter.find((row) => row.scope === "global");
      const afterAgent = rowsAfter.find((row) => row.scope === "agent:test");
      assert.equal(
        JSON.parse(afterGlobal.metadata).access_count,
        3,
        "the targeted global row's access_count is untouched",
      );
      assert.deepEqual(afterGlobal.vector, VECTOR_A, "the global row's vector is intact");
      assert.deepEqual(
        afterAgent,
        beforeAgent,
        "the agent:test row stays byte-identical (whole-row comparison)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
