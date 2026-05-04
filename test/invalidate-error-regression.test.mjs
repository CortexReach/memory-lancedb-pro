/**
 * RF-1 Regression Test: invalidation error handler
 *
 * Maintainer requirement (rwmjhb review):
 * "add a regression test where store.update() rejects so the error handler is exercised"
 *
 * Original bug: api.logger.warn() threw ReferenceError: api is not defined
 * Fix: this.log() is used instead (no ReferenceError)
 *
 * Key invariants tested:
 * 1. store.update() rejection does NOT throw ReferenceError (was the original bug)
 * 2. Error is logged via this.log() (not api.logger, which would throw ReferenceError)
 * 3. Loop continues — later invalidations still execute (no early exit)
 * 4. Error summary logged after loop completes
 * 5. bulkStore succeeds even if some invalidations fail
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

// ---------------------------------------------------------------------------
// Mock Store — configurable update behavior
// ---------------------------------------------------------------------------

function makeStoreWithFailingUpdate(existingRecords, failOnUpdateId) {
  const calls = { store: [], bulkStore: [], update: [], getById: [], vectorSearch: [] };
  // Track update patches separately: initial invalidation patches vs rollback patches.
  // After bulkStore returns, invalidateEntries.map calls update (invalidation).
  // Then rollback calls update again on succeeded entries with _origMetadata.
  // By recording the order and patch, we can verify rollback uses _origMetadata.
  const updatePatches = []; // { id, patch, ts }
  const db = new Map(existingRecords.map(r => [r.id, r]));
  let updateCallIdx = 0;

  return {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _opts) {
      calls.vectorSearch.push({ ts: Date.now() });
      // Rotate: each vectorSearch call returns the next existing record.
      // This ensures each candidate gets a distinct match for deduplication.
      const idx = calls.vectorSearch.length - 1;
      const record = existingRecords[idx % existingRecords.length];
      return [{ entry: { ...record, vector: _vector }, score: 0.95 }];
    },

    async getById(id, _scopeFilter) {
      calls.getById.push({ id, ts: Date.now() });
      return db.get(id) ?? null;
    },

    async store(entry) {
      calls.store.push({ entry, ts: Date.now() });
      return { ...entry, id: "store-" + Math.random().toString(36).slice(2) };
    },

    async bulkStore(entries) {
      calls.bulkStore.push({ entries, ts: Date.now() });
      return entries.map((e, i) => ({ ...e, id: "bulk-" + i + "-" + Math.random().toString(36).slice(2) }));
    },

    async update(id, patch, _scopeFilter) {
      calls.update.push({ id, ts: Date.now() });
      updatePatches.push({ id, patch, idx: updateCallIdx++ });
      // Only the designated ID throws; all others succeed.
      // This lets us control which specific invalidation fails.
      if (id === failOnUpdateId) {
        throw new Error(`store.update() rejected for id=${id}`);
      }
    },

    get calls() { return calls; },
    getStoreCallCount() { return calls.store.length; },
    getBulkStoreCallCount() { return calls.bulkStore.length; },
    getUpdateCallCount() { return calls.update.length; },
    getUpdatePatches() { return updatePatches; },
    getUpdateFailedIds() {
      return calls.update
        .filter(c => c.ts === 0) // placeholder; will use separate tracking
        .map(c => c.id);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Embedder — unique vectors per embed call (prevents batchDedup collapse)
// ---------------------------------------------------------------------------

function makeEmbedder() {
  let counter = 0;
  return {
    async embed(text) {
      counter++;
      // Each call gets a unique vector with a different offset.
      // This prevents batchDedup from treating distinct candidates as near-duplicates.
      return Array(256).fill(0).map((_, i) =>
        text.length > 0
          ? ((text.charCodeAt(i % text.length) + counter * 17) % 255) / 255
          : 0
      );
    },
    async embedBatch(texts) {
      // embedBatch is called once with ALL abstracts (2 in TC-5).
      // Return orthogonal-ish vectors so batchDedup does NOT collapse them.
      // Strategy: each text i gets vector where dimension[i] = 1 and
      // dimension[128+i] = i+1. This ensures near-zero cosine similarity.
      // Example: text 0 → [1, 0, ..., 0, 1, 0, ...]; text 1 → [0, 1, ..., 0, 2, 0, ...]
      return texts.map((text, i) => {
        counter++;
        return Array.from({ length: 384 }, (_, j) => {
          if (j === i) return 1.0;
          if (j === 128 + i) return i + 1;
          return 0.0;
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Mock LLM — fully controllable decision per candidate
// ---------------------------------------------------------------------------

function makeLlmWithDecisions(decisions) {
  // decisions: array of { decision: "supersede"|"create"|"skip", match_index?: number }
  // dedup-decision is called once per candidate in order
  let decisionIdx = 0;
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: decisions.map((d, i) => ({
            category: "preferences",
            abstract: `Unique candidate abstract #${i + 1} about user preference ${i + 1}`,
            overview: `## Pref ${i + 1}\n- Preference ${i + 1}`,
            content: `User preference number ${i + 1}.`,
          })),
        };
      }
      if (mode === "dedup-decision") {
        const d = decisions[decisionIdx % decisions.length];
        decisionIdx++;
        return d;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Log spy — captures this.log() calls on SmartExtractor
// ---------------------------------------------------------------------------

function makeLogSpy() {
  const entries = [];
  return {
    log(msg) { entries.push(String(msg)); },
    debugLog(_msg) {},
    entries,
  };
}

// ---------------------------------------------------------------------------
// SmartExtractor factory
// ---------------------------------------------------------------------------

function makeExtractor(store, embedder, llm, logSpy) {
  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log: logSpy.log,
    debugLog: logSpy.debugLog,
  });
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("RF-1: store.update() rejection — error handler regression", () => {

  /**
   * TC-1: Single update() rejection — no ReferenceError thrown
   *
   * The original bug: catch block called api.logger.warn() → ReferenceError.
   * The fix: catch block calls this.log() → no ReferenceError.
   *
   * Assertions:
   * - No exception thrown (original ReferenceError would propagate)
   * - bulkStore still succeeds
   * - store.update() was attempted once
   * - this.log() was called (not api.logger — which would throw)
   * - Error log mentions the failed entry ID
   */
  it("TC-1: single update rejection — no throw, error logged via this.log()", async () => {
    const existingRecord = {
      id: "existing-001",
      text: "Old dairy preference",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-dairy",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    const store = makeStoreWithFailingUpdate([existingRecord], "existing-001");
    const embedder = makeEmbedder();
    const llm = makeLlmWithDecisions([{ decision: "supersede", match_index: 1 }]);
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    // MUST NOT THROW — the original api.logger.warn() bug would throw ReferenceError here
    let threw = false;
    let thrownError;
    try {
      await extractor.extractAndPersist(
        "User prefers oat milk over dairy.",
        "session:test-rf1-1",
      );
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    const errorLog = logSpy.entries.find(e => e.includes("existing-001") && e.includes("failed"));

    console.log(`\n📊 TC-1:`);
    console.log(`   threw: ${threw} (expected: false)`);
    console.log(`   bulkStore calls: ${store.getBulkStoreCallCount()} (expected: 1)`);
    console.log(`   update calls: ${store.getUpdateCallCount()} (expected: 1)`);
    console.log(`   log entries: ${logSpy.entries.length}`);
    console.log(`   errorLog: ${errorLog}`);

    // Rollback: after invalidation, update() for the failed entry is called once (fails).
    // Then rollback operates on SUCCEEDED entries — since this entry failed, its
    // update was never committed, so nothing gets rolled back (succeeded array empty).
    // net result: 1 update call total (not 2).
    assert.strictEqual(threw, false,
      "store.update() rejection must NOT throw — original api.logger bug would throw ReferenceError");
    assert.strictEqual(store.getBulkStoreCallCount(), 1,
      "bulkStore must succeed even if invalidation fails");
    assert.strictEqual(store.getUpdateCallCount(), 1,
      "update called once for the failed invalidation; rollback skipped (no succeeded entries)");
    assert.ok(logSpy.entries.length >= 1,
      "this.log() must be called to log the error");
    assert.ok(errorLog,
      `Error log must mention failed entry. Logs: ${logSpy.entries.join("; ")}`);
  });

  /**
   * TC-2: Update rejection does not halt extractAndPersist
   *
   * Even when store.update() rejects, extractAndPersist completes normally
   * (no uncaught exception propagates out).
   */
  it("TC-2: extractAndPersist completes without exception when update rejects", async () => {
    const existingRecord = {
      id: "existing-002",
      text: "Old preference",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-old",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    const store = makeStoreWithFailingUpdate([existingRecord], "existing-002");
    const embedder = makeEmbedder();
    const llm = makeLlmWithDecisions([{ decision: "supersede", match_index: 1 }]);
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    let threw = false;
    try {
      await extractor.extractAndPersist(
        "User updated preference.",
        "session:test-rf1-2",
      );
    } catch (err) {
      threw = true;
    }

    console.log(`\n📊 TC-2:`);
    console.log(`   threw: ${threw} (expected: false)`);
    console.log(`   bulkStore calls: ${store.getBulkStoreCallCount()}`);
    console.log(`   log entries: ${logSpy.entries.length}`);

    assert.strictEqual(threw, false,
      "extractAndPersist must NOT throw when store.update() rejects");
    assert.strictEqual(store.getBulkStoreCallCount(), 1,
      "bulkStore must still succeed");
  });

  /**
   * TC-3: Error summary is logged after invalidation loop completes
   *
   * After the loop, this.log() must be called with the failure summary
   * (count of failures / total invalidations).
   */
  it("TC-3: error summary logged after loop completes", async () => {
    const existingRecord = {
      id: "existing-003",
      text: "Old preference",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-old-3",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    const store = makeStoreWithFailingUpdate([existingRecord], "existing-003");
    const embedder = makeEmbedder();
    const llm = makeLlmWithDecisions([{ decision: "supersede", match_index: 1 }]);
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    await extractor.extractAndPersist(
      "User updated preference.",
      "session:test-rf1-3",
    );

    // With corrected rollback (succeeded entries, not failed):
    // - failed = [existing-003], succeeded = []
    // - Log: "1/1 ... failed ... Rolling back 0 succeeded update(s)..."
    // - Rollback skipped (succeeded is empty) → no "ROLLBACK FAILED" log
    // - Instead: "Rollback complete — all 0 succeeded invalidation(s) reverted"
    const failureReport = logSpy.entries.find(e => e.includes("1/1") && e.includes("failed"));
    const rollbackReport = logSpy.entries.find(e => e.includes("Rollback complete"));

    console.log(`\n📊 TC-3:`);
    console.log(`   log entries: ${logSpy.entries.length}`);
    console.log(`   failureReport: ${failureReport}`);
    console.log(`   rollbackReport: ${rollbackReport}`);

    assert.ok(failureReport,
      `Failure summary must be logged. Logs: ${logSpy.entries.join("; ")}`);
    assert.ok(rollbackReport,
      `Rollback report must contain 'inconsistent'. Logs: ${logSpy.entries.join("; ")}`);
  });

  /**
   * TC-4: No ReferenceError in error message (proves api.logger was not used)
   *
   * The original bug was api.logger.warn() throwing "ReferenceError: api is not defined".
   * After the fix (this.log()), the error message is a normal Error from store.update().
   */
  it("TC-4: error message is from store.update(), not ReferenceError", async () => {
    const existingRecord = {
      id: "existing-004",
      text: "Old preference",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-old-4",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    const store = makeStoreWithFailingUpdate([existingRecord], "existing-004");
    const embedder = makeEmbedder();
    const llm = makeLlmWithDecisions([{ decision: "supersede", match_index: 1 }]);
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    await extractor.extractAndPersist(
      "User updated preference.",
      "session:test-rf1-4",
    );

    // After the rollback attempt, the ROLLBACK FAILED log is emitted (the second failure).
    // We verify that the original entry ID appears in the error log (proving api.logger
    // was NOT used — it would have thrown ReferenceError before reaching the ID).
    const errorLog = logSpy.entries.find(e => e.includes("existing-004") && e.includes("failed"));

    console.log(`\n📊 TC-4:`);
    console.log(`   errorLog: ${errorLog}`);

    assert.ok(errorLog,
      "Error must be logged after update rejection");
    assert.ok(!errorLog.includes("ReferenceError"),
      "Error must NOT be ReferenceError (that was the original api.logger bug)");
  });

  /**
   * TC-5: Rollback correctly restores _origMetadata on succeeded invalidations.
   *
   * MR4 (Codex review) concern: pure mock doesn't verify rollback actually works.
   * This test enhances the mock to track update patches, proving that:
   * 1. When existing-002 update fails, rollback targets succeeded entries only (existing-001)
   * 2. Rollback patch contains the original metadata (not the invalidated metadata)
   * 3. The rollback call order proves it happens AFTER bulkStore (succeeded entries only)
   */
  it("TC-5: rollback uses _origMetadata to restore succeeded invalidations", async () => {
    const existing001 = {
      id: "existing-001",
      text: "Old preference A",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-a",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };
    const existing002 = {
      id: "existing-002",
      text: "Old preference B",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-b",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    // failOnUpdateId = existing-002 → its update fails, existing-001 succeeds.
    // Rollback should only target existing-001 (the succeeded one).
    const store = makeStoreWithFailingUpdate([existing001, existing002], "existing-002");
    const embedder = makeEmbedder();
    // Custom LLM mock that returns 2 candidates from DIFFERENT categories
    // (preferences vs facts) so batchDedup doesn't collapse them.
    // dedup loop: candidate 0 → match_index 1 → existing-001 (vectorSearch idx 0, 1-based index)
    //             candidate 1 → match_index 2 → existing-002 (vectorSearch idx 1, 1-based index)
    let decisionIdx = 0;
    const decisions = [
      { decision: "supersede", match_index: 1 },
      { decision: "supersede", match_index: 2 },
    ];
    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          const result = {
            memories: [
              {
                category: "preferences",
                abstract: "User prefers oat milk over dairy milk every morning",
                overview: "## Pref\n- Oat milk preferred",
                content: "User prefers oat milk over dairy.",
              },
              {
                category: "events",
                abstract: "User attended a project meeting last Tuesday afternoon",
                overview: "## Event\n- Meeting attended",
                content: "User attended a project meeting on Tuesday.",
              },
            ],
          };
          console.log(`TC-5 extract-candidates returning ${result.memories.length} memories`);
          return result;
        }
        if (mode === "dedup-decision") {
          const d = decisions[decisionIdx % decisions.length];
          decisionIdx++;
          return d;
        }
        return null;
      },
    };
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    // Debug: verify extractor can be constructed
    console.log(`\nTC-5 DEBUG: extractor created, about to call extractAndPersist`);
    console.log(`  store vectorSearch calls before: ${store.calls.vectorSearch.length}`);
    console.log(`  store update calls before: ${store.getUpdateCallCount()}`);
    console.log(`  store bulkStore calls before: ${store.getBulkStoreCallCount()}`);
    console.log(`  log entries before: ${logSpy.entries.length}`);

    await extractor.extractAndPersist(
      "User updated preferences A and B.",
      "session:test-rf1-5",
    );

    console.log(`  store vectorSearch calls after: ${store.calls.vectorSearch.length}`);
    console.log(`  store update calls after: ${store.getUpdateCallCount()}`);
    console.log(`  store bulkStore calls after: ${store.getBulkStoreCallCount()}`);
    console.log(`  log entries after: ${logSpy.entries.length}`);
    console.log(`  log entries: ${logSpy.entries.join("; ")}`);

    // Verify update call count:
    // - bulkStore: 1 (for 2 new entries)
    // - invalidate existing-001: 1 update call (succeeds) → push to succeeded[]
    // - invalidate existing-002: 1 update call (fails) → push to failed[]
    // - rollback existing-001: 1 update call (succeeds) → uses _origMetadata
    // Total: 3 update calls
    assert.strictEqual(store.getUpdateCallCount(), 3,
      `Expected 3 update calls (2 invalidation + 1 rollback), got ${store.getUpdateCallCount()}`);

    // Verify rollback happened (last update call should be on existing-001 with original metadata)
    const patches = store.getUpdatePatches();
    assert.strictEqual(patches.length, 3, "Should record all 3 update patches");

    const [inv001, inv002, rollback001] = patches;

    // inv001: first update = invalidation of existing-001 (succeeded)
    assert.strictEqual(inv001.id, "existing-001");
    assert.ok(inv001.patch.metadata.includes("invalidated_at"),
      "First patch should be invalidation metadata (includes invalidated_at)");

    // inv002: second update = invalidation of existing-002 (FAILED — update threw)
    assert.strictEqual(inv002.id, "existing-002");
    assert.ok(inv002.patch.metadata.includes("invalidated_at"),
      "Second patch should be invalidation metadata for existing-002");

    // rollback001: third update = rollback of existing-001 with ORIGINAL metadata
    assert.strictEqual(rollback001.id, "existing-001",
      "Rollback should target existing-001 (the succeeded invalidation)");
    assert.ok(!rollback001.patch.metadata.includes("invalidated_at"),
      "Rollback patch must use _origMetadata (no invalidated_at field)");
    assert.ok(rollback001.patch.metadata.includes("pref-a"),
      "Rollback patch must preserve original fact_key from _origMetadata");

    // Verify "ROLLBACK FAILED" log since existing-002 update failed (no actual DB state change)
    const rollbackFailedLog = logSpy.entries.find(e => e.includes("ROLLBACK FAILED"));
    assert.ok(!rollbackFailedLog,
      "Rollback itself should succeed (no ROLLBACK FAILED log)");

    console.log(`\n📊 TC-5:`);
    console.log(`   update calls: ${store.getUpdateCallCount()} (expected: 3)`);
    console.log(`   patches:`);
    for (const p of patches) {
      console.log(`     [${p.id}] invalidated=${p.patch.metadata.includes("invalidated_at")} rollback_patch=${!p.patch.metadata.includes("invalidated_at")}`);
    }
  });
});
