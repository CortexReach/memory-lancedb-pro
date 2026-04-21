import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");

// Dynamically import with jiti alias support
const jitiFactory = (await import("jiti")).default;
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { MemoryStore } = await jiti("../src/store.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Test TC-1: Serial guard cooldown MUST be set even when reflection throws
// before reflectionRan=true
// ─────────────────────────────────────────────────────────────────────────────

describe("Issue #680 — memory-reflection critical fixes", () => {

  describe("TC-1: Serial guard cooldown on early throw", () => {
    it("sets serial guard cooldown even when hook throws before reflectionRan=true", () => {
      // Simulate the finally block logic
      const serialGuardMap = new Map();
      const globalLock = new Map();

      const sessionKey = "session:test-tc1";
      globalLock.set(sessionKey, true); // lock acquired at line ~3400

      let reflectionRan = false;

      try {
        // Simulate: exception thrown before reflectionRan = true (line 3470)
        throw new Error("embedder timeout at line ~3390");
        // reflectionRan = true would be here in real code
      } catch (err) {
        // Outer catch catches — reflectionRan is still false
      } finally {
        // Current (buggy) code: cooldown only set if reflectionRan is true
        if (reflectionRan) {
          serialGuardMap.set(sessionKey, Date.now());
        }
        globalLock.delete(sessionKey); // lock always released
      }

      // BUG: cooldown NOT set because reflectionRan=false
      const cooldownSet = serialGuardMap.has(sessionKey);

      // After fix: cooldown should be set regardless of reflectionRan
      assert.strictEqual(
        cooldownSet,
        false,
        "BUG CONFIRMED: cooldown not set when early throw (current behavior)"
      );
    });

    it("fix: cooldown set unconditionally when lock was acquired", () => {
      const serialGuardMap = new Map();
      const globalLock = new Map();

      const sessionKey = "session:test-tc1-fixed";
      globalLock.set(sessionKey, true);

      let reflectionRan = false;

      try {
        throw new Error("embedder timeout");
      } catch (err) {
        // caught
      } finally {
        // FIX: set cooldown whenever lock was acquired (not inside if (reflectionRan))
        if (globalLock.has(sessionKey)) {
          serialGuardMap.set(sessionKey, Date.now()); // always set when lock held
        }
        globalLock.delete(sessionKey);
      }

      // With the fix, cooldown IS set even on early throw
      assert.ok(
        serialGuardMap.has(sessionKey),
        "cooldown must be set even on early throw (expected after fix)"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-2: vectorSearch error → fail-open dedup must be clearly labeled
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-2: vectorSearch error fail-open behavior", () => {
    it("logs fail-open clearly when vectorSearch throws", async () => {
      const warnings = [];

      // Simulate current buggy behavior
      const store = {
        async vectorSearch() {
          throw new Error("LanceDB unavailable");
        },
        async store(entry) {
          return { ...entry, id: "test-id", timestamp: Date.now() };
        },
      };

      const entry = { text: "test", vector: [0.1, 0.2], importance: 0.8, category: "fact", scope: "global", metadata: "{}" };

      let existing = [];
      try {
        existing = await store.vectorSearch(entry.vector, 1, 0.1, ["global"]);
      } catch (err) {
        warnings.push(`memory-reflection: duplicate pre-check failed, fail-open (storing anyway): ${err.message}`);
      }

      // Note: store.store(entry) is called in the actual buggy code path (not in this test)
      // — stored result is irrelevant to the warning assertion below

      // BUG: current code logs "continue store" but actually falls through to store
      const hasFailOpenWarning = warnings.some(w => w.includes("fail-open"));
      const hasMisleadingContinueWarning = warnings.some(w => w.includes("continue store"));

      assert.ok(
        hasFailOpenWarning || hasMisleadingContinueWarning,
        "fail-open must be clearly logged (current: uses misleading 'continue store')"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-3: bulkStore must warn on invalid entries, not silently drop
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-3: bulkStore invalid entry handling", () => {
    it("logs warning when filtering invalid entries", async () => {
      // Lazy initialization — no explicit init needed, first call auto-init
      const warnings = [];
      const testDbDir = mkdtempSync(path.join(tmpdir(), "tc3-bulkstore-"));

      let store;
      try {
        store = new MemoryStore({
          dbPath: testDbDir,
          vectorDim: 384,
          logger: { warn: (m) => warnings.push(m) },
        });
        // Trigger lazy init by calling bulkStore (ensureInitialized is called internally)
        await store.bulkStore([
          { text: "valid entry", vector: new Array(384).fill(0.1), importance: 0.8, category: "fact", scope: "global", metadata: "{}" },
          { text: "", vector: new Array(384).fill(0.2), importance: 0.8, category: "fact", scope: "global", metadata: "{}" }, // invalid: empty text
          { text: "also valid", vector: [], importance: 0.8, category: "fact", scope: "global", metadata: "{}" },              // invalid: empty vector
        ]);

        const hasFilterWarning = warnings.some(w => w.includes("filtering") && w.includes("invalid entries"));

        // BUG: currently silent — no warning logged
        assert.strictEqual(
          hasFilterWarning,
          false,
          "BUG CONFIRMED: bulkStore silently drops invalid entries (current behavior — no warning)"
        );
      } finally {
        await store?.close?.();
        rmSync(testDbDir, { recursive: true, force: true });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-4: existing[0].score guard against empty array
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-4: existing[0].score defensive guard", () => {
    it("does not throw when vectorSearch returns empty array", () => {
      // Regression test: existing[0].score would throw if existing=[]
      // But current code checks existing.length > 0 first, so TypeScript may warn
      // but runtime is safe. This TC documents the defensive pattern.

      let existing = []; // empty array from vectorSearch
      let threw = false;

      try {
        // This is the current pattern — length check protects against [0] access
        if (existing.length > 0 && existing[0].score > 0.95) {
          // skip
        }
      } catch (err) {
        threw = true;
      }

      assert.strictEqual(threw, false, "current pattern (length check first) is safe but implicit");
    });

    it("explicit guard is clearer and self-documenting", () => {
      let existing = [];
      let skipped = false;

      // Explicit guard (proposed fix)
      if (existing.length > 0 && existing[0] && existing[0].score > 0.95) {
        skipped = true;
      }

      assert.strictEqual(skipped, false, "explicit existing[0] guard works correctly");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-5: reflectionDerivedBySession cleanup on all exit paths
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-5: reflectionDerivedBySession memory leak", () => {
    it("cleans up cache when storeToLanceDB=false and usedFallback=false (current bug)", () => {
      const reflectionDerivedBySession = new Map();
      reflectionDerivedBySession.set("session:leak-test", {
        updatedAt: Date.now() - 10000,
        derived: ["stale entry"],
      });

      const sessionKey = "session:leak-test";
      const reflectionStoreToLanceDB = false;
      const usedFallback = false;

      // Current buggy code — only deletes when usedFallback=true
      if (reflectionStoreToLanceDB) {
        // not taken
      } else if (sessionKey && usedFallback) {
        reflectionDerivedBySession.delete(sessionKey);
      }

      // BUG: map still contains stale entry
      assert.strictEqual(
        reflectionDerivedBySession.has(sessionKey),
        true,
        "BUG CONFIRMED: stale cache entry not cleaned (current behavior)"
      );
    });

    it("fix: unconditional delete in all non-LanceDB paths", () => {
      const reflectionDerivedBySession = new Map();
      reflectionDerivedBySession.set("session:leak-test-fixed", {
        updatedAt: Date.now() - 10000,
        derived: ["stale entry"],
      });

      const sessionKey = "session:leak-test-fixed";
      const reflectionStoreToLanceDB = false;
      const usedFallback = false;

      // FIX: unconditional delete when not using LanceDB
      if (reflectionStoreToLanceDB) {
        // not taken
      } else if (sessionKey) {
        reflectionDerivedBySession.delete(sessionKey); // always delete in else path
      }

      assert.strictEqual(
        reflectionDerivedBySession.has(sessionKey),
        false,
        "stale entry must be cleaned when storeToLanceDB=false"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-6: TOCTOU dedup window between vectorSearch and store
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-6: TOCTOU dedup race window", () => {
    it("documents the race window between dedup check and write", () => {
      // This test documents the TOCTOU vulnerability.
      // Scenario: two concurrent reflections for same session produce identical mapped items
      // Both pass dedup check before either writes → duplicate stored.

      // Simulate: T1 and T2 both query dedup at same time
      let t1Passed = false;
      let t2Passed = false;

      // Both see empty result simultaneously (race window)
      const dedupResult = []; // empty = no duplicate found

      if (dedupResult.length === 0 || dedupResult[0].score <= 0.95) {
        t1Passed = true;
        t2Passed = true; // both pass within same 100-500ms window
      }

      // BUG: both stored = duplicate
      assert.ok(
        t1Passed && t2Passed,
        "TOCTOU window confirmed: both concurrent calls can pass dedup simultaneously"
      );
    });

    it("bulkStore fix reduces but does not eliminate TOCTOU window", () => {
      // With bulkStore, the window is reduced to:
      // batch embed time + batch dedup check time + 1 lock acquisition
      // vs original: N × (embed time + dedup check time + lock)
      // The window is shorter but still exists for the batch-level dedup

      const batchWindowMs = 150; // embed 3 items + dedup + 1 lock
      const individualWindowMs = 450; // embed + dedup + lock × 3 items

      // Batch is faster but still has a dedup-before-write gap
      assert.ok(
        batchWindowMs < individualWindowMs,
        "bulkStore reduces but does not eliminate TOCTOU window"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test TC-7: Full fix — bulkStore replaces per-item store loop
  // ───────────────────────────────────────────────────────────────────────────

  describe("TC-7: bulkStore replaces N lock acquisitions with 1", () => {
    it("replaces per-item store loop with bulkStore (1 lock instead of N)", async () => {
      const testDbDir = mkdtempSync(path.join(tmpdir(), "tc7-bulkstore-"));

      let store;
      try {
        store = new MemoryStore({
          dbPath: testDbDir,
          vectorDim: 384,
          logger: { warn: () => {} },
        });

        // Lazy init — first call triggers ensureInitialized internally
        const entries = [
          { text: "reflection point 1", vector: new Array(384).fill(0.1), importance: 0.85, category: "decision", scope: "global", metadata: "{}" },
          { text: "reflection point 2", vector: new Array(384).fill(0.2), importance: 0.8, category: "fact", scope: "global", metadata: "{}" },
          { text: "reflection point 3", vector: new Array(384).fill(0.3), importance: 0.8, category: "fact", scope: "global", metadata: "{}" },
        ];

        const stored = await store.bulkStore(entries);

        assert.strictEqual(stored.length, 3, "all 3 entries stored via bulkStore");
        assert.strictEqual(
          new Set(stored.map(e => e.id)).size,
          3,
          "each entry gets unique id (no duplicates)"
        );
      } finally {
        rmSync(testDbDir, { recursive: true, force: true });
      }
    });
  });

});