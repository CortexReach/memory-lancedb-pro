import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryStore, normalizeImportance } = jiti("../src/store.ts");

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

  describe("normalizeImportance pure function", () => {
    it("maps legacy scale 3 to 0.60", () => {
      assert.equal(normalizeImportance(3), 0.60);
    });

    it("maps legacy scale 5 to 0.95", () => {
      assert.equal(normalizeImportance(5), 0.95);
    });

    it("maps legacy scale 4 to 0.80", () => {
      assert.equal(normalizeImportance(4), 0.80);
    });

    it("maps legacy scale 2 to 0.40", () => {
      assert.equal(normalizeImportance(2), 0.40);
    });

    it("maps legacy scale 1 to 0.20", () => {
      assert.equal(normalizeImportance(1), 0.20);
    });

    it("passes through v2+ 0~1 values unchanged", () => {
      assert.equal(normalizeImportance(0.7), 0.7);
      assert.equal(normalizeImportance(0.47), 0.47);
      assert.equal(normalizeImportance(0.85), 0.85);
    });

    it("clamps negative values to 0.0", () => {
      assert.equal(normalizeImportance(-1), 0.0);
      assert.equal(normalizeImportance(-999), 0.0);
    });

    it("clamps extremely large values to 1.0", () => {
      assert.equal(normalizeImportance(99), 1.0);
      assert.equal(normalizeImportance(1000), 1.0);
    });

    it("handles zero correctly (not 1-5 scale, clamps to lower bound)", () => {
      assert.equal(normalizeImportance(0), 0.0);
    });

    it("preserves v2+ importance=1.0 as legitimate max", () => {
      assert.equal(normalizeImportance(1.0), 1.0);
    });

    it("preserves v2+ importance=0.0 as legitimate min", () => {
      assert.equal(normalizeImportance(0.0), 0.0);
    });

    it("clamps decimal values above 1.0 to 1.0 (not legacy 1-scale)", () => {
      // 1.5 is a v2+ float, not legacy integer 1-5 scale
      assert.equal(normalizeImportance(1.5), 1.0);
    });

    it("returns 0.5 for NaN to prevent NaN propagation", () => {
      assert.equal(normalizeImportance(NaN), 0.5);
    });

    it("returns 0.5 for Infinity and -Infinity", () => {
      assert.equal(normalizeImportance(Infinity), 0.5);
      assert.equal(normalizeImportance(-Infinity), 0.5);
    });
  });

  describe("integration with MemoryStore.importEntry", () => {
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

    it("passes through v2+ importance 0.6 unchanged", async () => {
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
});
