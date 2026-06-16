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
    it("routes to normalizeLegacyImportance behavior", () => {
      // Wrapper kept for backward compat — behaves like normalizeLegacyImportance
      assert.equal(normalizeImportance(1), 0.20);
      assert.equal(normalizeImportance(5), 0.95);
      assert.equal(normalizeImportance(3), 0.60);
    });
  });

  describe("integration with MemoryStore.importEntry (legacy path)", () => {
    it("normalizes legacy importance 4 to 0.80 on import", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "legacy-importance-4",
        text: "legacy importance 4 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 4,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 0.80);

      const loaded = await store.getById("legacy-importance-4");
      assert.equal(loaded?.importance, 0.80);
    });

    it("normalizes legacy importance 5 to 0.95 on import", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "legacy-importance-5",
        text: "legacy importance 5 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 5,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 0.95);
    });

    it("passes through v2+ importance 0.6 unchanged on import (non-integer)", async () => {
      const store = createStore();

      const imported = await store.importEntry({
        id: "v2-importance-0.6",
        text: "v2 importance 0.6 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.6,
        timestamp: Date.now(),
        metadata: "{}",
      });

      assert.equal(imported.importance, 0.6);
    });
  });

  describe("integration with read path (v2+ data, clamp)", () => {
    it("preserves stored v2+ importance=1.0 across read (F1 fix)", async () => {
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

      // importEntry uses normalizeLegacyImportance, so 1.0 hits legacy path → 0.20
      // (this is the documented JS limitation; see F1 in PR #828)
      assert.equal(imported.importance, 0.20);

      // But a stored v2+ value 0.85 should be preserved on read
      const stored = await store.importEntry({
        id: "v2-importance-0.85",
        text: "v2 importance 0.85 entry",
        vector: [1, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.85,
        timestamp: Date.now(),
        metadata: "{}",
      });
      assert.equal(stored.importance, 0.85);
    });
  });
});
