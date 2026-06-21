import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  MemoryStore,
  normalizeImportance,
  normalizeLegacyImportance,
  clampImportance,
} = jiti("../src/store.ts");

describe("importance normalization", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-importance-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function createStore() {
    return new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });
  }

  describe("normalizeLegacyImportance (legacy v1.x 1-5 integer scale)", () => {
    it("maps legacy scale 1 to 0.20", () => {
      assert.equal(normalizeLegacyImportance(1), 0.20);
    });

    it("maps legacy scale 2 to 0.40", () => {
      assert.equal(normalizeLegacyImportance(2), 0.40);
    });

    it("maps legacy scale 3 to 0.60", () => {
      assert.equal(normalizeLegacyImportance(3), 0.60);
    });

    it("maps legacy scale 4 to 0.80", () => {
      assert.equal(normalizeLegacyImportance(4), 0.80);
    });

    it("maps legacy scale 5 to 0.95", () => {
      assert.equal(normalizeLegacyImportance(5), 0.95);
    });

    it("1.0 hits legacy path (JS limitation: Number.isInteger(1.0) === true)", () => {
      // In JavaScript, 1.0 === 1, so legacy-v1 callers must be aware
      // that legitimate 1.0 will map to 0.20. This trade-off is only safe
      // in legacy import contexts; v2+ data flows through clampImportance.
      assert.equal(normalizeLegacyImportance(1.0), 0.20);
    });

    it("returns 0.7 for NaN (consistent default with import fallback)", () => {
      assert.equal(normalizeLegacyImportance(NaN), 0.7);
    });

    it("returns 0.7 for Infinity and -Infinity", () => {
      assert.equal(normalizeLegacyImportance(Infinity), 0.7);
      assert.equal(normalizeLegacyImportance(-Infinity), 0.7);
    });
  });

  describe("clampImportance (v2+ 0~1 read path)", () => {
    it("preserves v2+ importance=1.0 as legitimate max", () => {
      assert.equal(clampImportance(1.0), 1.0);
    });

    it("preserves v2+ importance=0.0 as legitimate min", () => {
      assert.equal(clampImportance(0.0), 0.0);
    });

    it("preserves decimal v2+ values unchanged", () => {
      assert.equal(clampImportance(0.7), 0.7);
      assert.equal(clampImportance(0.47), 0.47);
      assert.equal(clampImportance(0.85), 0.85);
    });

    it("clamps negative values to 0.0", () => {
      assert.equal(clampImportance(-1), 0.0);
      assert.equal(clampImportance(-999), 0.0);
    });

    it("clamps extremely large values to 1.0", () => {
      assert.equal(clampImportance(99), 1.0);
      assert.equal(clampImportance(1000), 1.0);
    });

    it("returns 0.7 for NaN (consistent default with import fallback, MR2)", () => {
      assert.equal(clampImportance(NaN), 0.7);
    });

    it("returns 0.7 for Infinity and -Infinity (MR2)", () => {
      assert.equal(clampImportance(Infinity), 0.7);
      assert.equal(clampImportance(-Infinity), 0.7);
    });

    it("is idempotent (MR1: prevents 99 -> 1.0 -> 0.20 corruption)", () => {
      assert.equal(clampImportance(99), 1.0);
      assert.equal(clampImportance(clampImportance(99)), 1.0);
      assert.equal(clampImportance(0.7), 0.7);
      assert.equal(clampImportance(clampImportance(0.7)), 0.7);
      assert.equal(clampImportance(0.0), 0.0);
      assert.equal(clampImportance(clampImportance(0.0)), 0.0);
    });
  });

  describe("normalizeImportance (deprecated wrapper, backward compat)", () => {
    it("routes to clampImportance (v2+ 0~1) behavior", () => {
      // Wrapper kept for backward compat — now routes to clampImportance
      // (v2+ 0~1 semantics), which is what most generic callers expect.
      // The previous routing to normalizeLegacyImportance was a footgun
      // (see PR #828 review).
      assert.equal(normalizeImportance(1.0), 1.0);
      assert.equal(normalizeImportance(0.7), 0.7);
      assert.equal(normalizeImportance(0), 0.0);
      assert.equal(normalizeImportance(99), 1.0);
      assert.equal(normalizeImportance(-1), 0.0);
    });
  });

  describe("integration with MemoryStore.importEntry (generic v2+ path, default)", () => {
    // Default importEntry is a generic v2+ import surface. It must preserve
    // legitimate v2 values (0, 1, decimals) without legacy 1-5 mapping.
    // See PR #828 must-fix: importEntry previously legacy-normalized, which
    // silently downgraded v2 max (1.0) to 0.20.

    it("preserves v2+ importance=1.0 on generic import (F1 fix)", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "v2-importance-1.0",
        text: "v2 importance 1.0 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 1.0,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 1.0);

      const loaded = await store.getById("v2-importance-1.0");
      assert.equal(loaded?.importance, 1.0);
    });

    it("preserves v2+ importance=0.0 on generic import", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "v2-importance-0.0",
        text: "v2 importance 0.0 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 0);
    });

    it("preserves decimal v2+ values on generic import", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "v2-importance-0.85",
        text: "v2 importance 0.85 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.85,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 0.85);
    });

    it("clamps out-of-range values defensively on generic import", async () => {
      const store = createStore();

      const clampedHigh = await store.importEntry({
        id: "v2-importance-99",
        text: "v2 importance 99 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 99,
        timestamp: Date.now(),
        metadata: "{}",
      });
      assert.equal(clampedHigh.importance, 1.0);

      const clampedLow = await store.importEntry({
        id: "v2-importance-neg",
        text: "v2 importance -1 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: -1,
        timestamp: Date.now(),
        metadata: "{}",
      });
      assert.equal(clampedLow.importance, 0.0);
    });
  });

  describe("integration with MemoryStore.importEntry (legacy boundary, { legacy: true })", () => {
    // Legacy normalization is ONLY applied at explicit legacy-provenance
    // boundaries via { legacy: true }. This keeps migration one-shot and
    // prevents generic imports from silently being downgraded.

    it("normalizes legacy 4 to 0.80 on importEntry(legacy)", async () => {
      const store = createStore();

      const imported = await store.importEntry(
        {
          id: "legacy-importance-4",
          text: "legacy importance 4 entry",
          vector: [1, 0, 0, 0],
          category: "fact",
          scope: "global",
          importance: 4,
          timestamp: Date.now(),
          metadata: "{}",
        },
        { legacy: true },
      );

      assert.equal(imported.importance, 0.80);

      const loaded = await store.getById("legacy-importance-4");
      assert.equal(loaded?.importance, 0.80);
    });

    it("normalizes legacy 5 to 0.95 on importEntry(legacy)", async () => {
      const store = createStore();

      const imported = await store.importEntry(
        {
          id: "legacy-importance-5",
          text: "legacy importance 5 entry",
          vector: [1, 0, 0, 0],
          category: "fact",
          scope: "global",
          importance: 5,
          timestamp: Date.now(),
          metadata: "{}",
        },
        { legacy: true },
      );

      assert.equal(imported.importance, 0.95);
    });

    it("passes through v2+ importance 0.6 on importEntry(legacy) (non-integer)", async () => {
      const store = createStore();

      const imported = await store.importEntry(
        {
          id: "v2-importance-0.6-legacy",
          text: "v2 importance 0.6 entry",
          vector: [1, 0, 0, 0],
          category: "fact",
          scope: "global",
          importance: 0.6,
          timestamp: Date.now(),
          metadata: "{}",
        },
        { legacy: true },
      );

      assert.equal(imported.importance, 0.6);
    });
  });

  describe("integration with read path (v2+ data, clamp)", () => {
    it("preserves stored v2+ importance=1.0 across read (F1 fix)", async () => {
      const store = createStore();

      const stored = await store.importEntry({
        id: "v2-importance-1.0-read",
        text: "v2 importance 1.0 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 1.0,
        timestamp: Date.now(),
        metadata: "{}",
      });
      assert.equal(stored.importance, 1.0);

      const loaded = await store.getById("v2-importance-1.0-read");
      assert.equal(loaded?.importance, 1.0);
    });
  // ========================================================================
  // P0 coverage: legacy path idempotency (F2 hardening)
  // PR #828 review (rwmjhb F2): "Repeated normalization can invert clamped
  // high values". While normalizeLegacyImportance is intentionally
  // non-idempotent (1.0 -> 0.20 is a one-shot mapping), we must guarantee:
  //   - it never produces out-of-range output
  //   - it never returns NaN/Infinity
  //   - applying it twice does not silently flip a stored v2+ value
  //     (the migration boundary must not re-fire on already-normalized data)
  // ========================================================================
  describe("normalizeLegacyImportance (P0: idempotency & boundary safety)", () => {
    it("never returns NaN for any finite input (boundary safety)", () => {
      for (const v of [0, 0.5, 1, 1.5, 2, 3, 4, 5, 99, -1, 0.0001, 0.9999]) {
        const out = normalizeLegacyImportance(v);
        assert.ok(Number.isFinite(out), `out=${out} for v=${v}`);
        assert.ok(out >= 0 && out <= 1, `out=${out} out of [0,1] for v=${v}`);
      }
    });

    it("returns 0.7 for NaN and Infinity (corrupt-data fallback, consistent with clamp)", () => {
      // MR2 fix: normalizeLegacyImportance and clampImportance both return 0.7
      // for non-finite input, so corrupt legacy data does not produce
      // inconsistent defaults at the migration vs read boundaries.
      assert.equal(normalizeLegacyImportance(NaN), 0.7);
      assert.equal(normalizeLegacyImportance(Infinity), 0.7);
      assert.equal(normalizeLegacyImportance(-Infinity), 0.7);
    });

    it("clampImportance(legacy) is stable: legacy-then-clamp equals single clamp", () => {
      // After a single legacy mapping (e.g. 1.0 -> 0.20 in JS due to IEEE 754),
      // the value is already a v2+ float, so re-running clamp should be a
      // no-op. This locks down the "double-normalization corruption" class
      // of bugs (PR #828 F2) for the migration boundary.
      for (const v of [0, 1, 1.5, 2, 3, 4, 5, 99, -1]) {
        const once = normalizeLegacyImportance(v);
        const twice = clampImportance(once);
        assert.equal(twice, once, `clamp(legacy(${v})) != legacy(${v})`);
        // Both should be in [0, 1] and finite
        assert.ok(Number.isFinite(once));
        assert.ok(once >= 0 && once <= 1);
      }
    });
  });

  // ========================================================================
  // P0 coverage: read-path round-trip for all 4 read APIs
  // PR #828 review (rwmjhb MR1): "Read-path normalization diverges from
  // persisted value, risking permanent corruption via read-modify-write".
  // Only getById had a round-trip test. The other 3 read paths
  // (vectorSearch, bm25Search, list, fetchForCompaction) must all
  // preserve the stored v2+ importance=1.0 (F1 fix must hold end-to-end).
  // ========================================================================
  describe("read-path round-trip (P0: all 4 read APIs preserve v2+ 1.0)", () => {
    async function seedV2Max(store) {
      // Seed three entries with v2+ importance 1.0, 0.0, 0.5 so we can
      // verify each read API returns them with the original values intact.
      await store.importEntry({
        id: "rt-v2-1.0",
        text: "v2 max importance",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 1.0,
        timestamp: Date.now(),
        metadata: "{}",
      });
      await store.importEntry({
        id: "rt-v2-0.0",
        text: "v2 min importance",
        vector: [0, 1, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.0,
        timestamp: Date.now(),
        metadata: "{}",
      });
      await store.importEntry({
        id: "rt-v2-0.5",
        text: "v2 mid importance",
        vector: [0, 0, 1, 0],
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      });
    }

    function expectV2Intact(rows) {
      // Each read API returns rows with importance preserved as stored.
      // We don't assert a specific row count (APIs differ in limit/filters)
      // but every returned row's importance must equal the value we wrote.
      for (const row of rows) {
        if (row.id === "rt-v2-1.0") assert.equal(row.importance, 1.0, `1.0 corrupted in ${row.id}`);
        else if (row.id === "rt-v2-0.0") assert.equal(row.importance, 0.0, `0.0 corrupted in ${row.id}`);
        else if (row.id === "rt-v2-0.5") assert.equal(row.importance, 0.5, `0.5 corrupted in ${row.id}`);
      }
    }

    it("vectorSearch preserves v2+ importance=1.0 (F1 fix holds end-to-end)", async () => {
      const store = createStore();
      await seedV2Max(store);

      const results = await store.vectorSearch([1, 0, 0, 0], 10, 0.0);
      expectV2Intact(results.map((r) => r.entry ?? r));
    });

    it("bm25Search preserves v2+ importance=1.0 (F1 fix holds end-to-end)", async () => {
      const store = createStore();
      await seedV2Max(store);

      const results = await store.bm25Search("v2", 10);
      expectV2Intact(results.map((r) => r.entry ?? r));
    });

    it("list() preserves v2+ importance=1.0 (F1 fix holds end-to-end)", async () => {
      const store = createStore();
      await seedV2Max(store);

      const results = await store.list();
      expectV2Intact(results);
    });

    it("fetchForCompaction preserves v2+ importance=1.0 (F1 fix holds end-to-end)", async () => {
      const store = createStore();
      await seedV2Max(store);

      const results = await store.fetchForCompaction(Date.now() + 1000, undefined, 50);
      expectV2Intact(results);
    });
  });

  // ========================================================================
  // F3 coverage: raw write path must clamp out-of-range importance
  // PR #828 follow-up (rwmjhb): "CLI JSON imports without ids still pass
  // finite raw importance values through the direct store() branch, so
  // importance: 4 or 99 can persist out-of-range raw data unless store()/
  // bulkStore() or that no-id import path clamps at write time."
  //
  // store(), upsert(), update(), and bulkUpdateExact() are the direct
  // (non-importEntry) write surfaces. They must clamp raw out-of-range
  // values so a v2+ read never sees 4 or 99.
  // ========================================================================
  describe("raw write path (F3: store/upsert/update/bulkUpdateExact clamp out-of-range)", () => {
    it("store() clamps importance=4 to 1.0 at write time", async () => {
      const store = createStore();
      const written = await store.store({
        text: "raw store 4",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 4,
        metadata: "{}",
      });
      assert.equal(written.importance, 1.0);
      const loaded = await store.getById(written.id);
      assert.equal(loaded?.importance, 1.0);
    });

    it("store() clamps importance=99 to 1.0 at write time", async () => {
      const store = createStore();
      const written = await store.store({
        text: "raw store 99",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 99,
        metadata: "{}",
      });
      assert.equal(written.importance, 1.0);
      const loaded = await store.getById(written.id);
      assert.equal(loaded?.importance, 1.0);
    });

    it("store() clamps negative importance to 0.0 at write time", async () => {
      const store = createStore();
      const written = await store.store({
        text: "raw store negative",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: -2.5,
        metadata: "{}",
      });
      assert.equal(written.importance, 0.0);
      const loaded = await store.getById(written.id);
      assert.equal(loaded?.importance, 0.0);
    });

    it("store() preserves legitimate v2+ 0.7 unchanged", async () => {
      const store = createStore();
      const written = await store.store({
        text: "raw store 0.7",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.7,
        metadata: "{}",
      });
      assert.equal(written.importance, 0.7);
    });

    it("bulkStore() clamps a batch with mixed out-of-range values", async () => {
      const store = createStore();
      const results = await store.bulkStore([
        { text: "raw bulk 4",   vector: [1, 0, 0, 0], category: "fact", scope: "global", importance: 4,   metadata: "{}" },
        { text: "raw bulk 99",  vector: [0, 1, 0, 0], category: "fact", scope: "global", importance: 99,  metadata: "{}" },
        { text: "raw bulk 0.7", vector: [0, 0, 1, 0], category: "fact", scope: "global", importance: 0.7, metadata: "{}" },
        { text: "raw bulk -1",  vector: [0, 0, 0, 1], category: "fact", scope: "global", importance: -1,  metadata: "{}" },
      ]);
      assert.equal(results[0].importance, 1.0);
      assert.equal(results[1].importance, 1.0);
      assert.equal(results[2].importance, 0.7);
      assert.equal(results[3].importance, 0.0);
    });

    it("upsert() clamps out-of-range importance at write time", async () => {
      const store = createStore();
      const written = await store.upsert({
        id: "upsert-99",
        text: "upsert 99",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 99,
        timestamp: Date.now(),
        metadata: "{}",
      });
      assert.equal(written.importance, 1.0);
      const loaded = await store.getById("upsert-99");
      assert.equal(loaded?.importance, 1.0);
    });

    it("update() clamps out-of-range importance passed via updates.importance", async () => {
      const store = createStore();
      await store.upsert({
        id: "update-99",
        text: "update 99",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      });
      const updated = await store.update("update-99", { importance: 99 });
      assert.equal(updated?.importance, 1.0);
      const loaded = await store.getById("update-99");
      assert.equal(loaded?.importance, 1.0);
    });

    it("bulkUpdateExact() clamps out-of-range importance", async () => {
      const store = createStore();
      await store.upsert({
        id: "bulk-update-99",
        text: "bulk update 99",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      });
      const results = await store.bulkUpdateExact([
        { id: "bulk-update-99", updates: { importance: 99 } },
      ]);
      assert.equal(results[0].entry?.importance, 1.0);
      const loaded = await store.getById("bulk-update-99");
      assert.equal(loaded?.importance, 1.0);
    });

    it("store() is a no-op clamp for already-clamped values (idempotent)", async () => {
      // If a caller (e.g. CLI with a future pre-clamp) already clamped to 0.5,
      // store() must not alter it.
      const store = createStore();
      const written = await store.store({
        text: "already clamped",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: clampImportance(0.5),
        metadata: "{}",
      });
      assert.equal(written.importance, 0.5);
    });
  });

  });
});
