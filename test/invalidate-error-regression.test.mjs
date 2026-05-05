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
  const calls = { store: [], bulkStore: [], update: [], delete: [], getById: [], vectorSearch: [] };
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

    async delete(id, _scopeFilter) {
      calls.delete.push({ id, ts: Date.now() });
      // Deletes always succeed in the mock.
    },

    get calls() { return calls; },
    getStoreCallCount() { return calls.store.length; },
    getBulkStoreCallCount() { return calls.bulkStore.length; },
    getUpdateCallCount() { return calls.update.length; },
    getDeleteCallCount() { return calls.delete.length; },
    getUpdatePatches() { return updatePatches; },
    getUpdateFailedIds() {
      return calls.update
        .filter(c => c.ts === 0) // placeholder; will use separate tracking
        .map(c => c.id);
    },
  };
}
// -------------------------------------------------------------------------
// Mock Store — per-ID update call counter (for TC-6: same ID updated twice)
// -------------------------------------------------------------------------

function makeStoreWithPerIdCallCount(existingRecords) {
  const calls = { store: [], bulkStore: [], update: [], delete: [], getById: [], vectorSearch: [] };
  const updatePatches = [];
  const db = new Map(existingRecords.map(r => [r.id, r]));
  let invalidationCallCount = {};
  const failOnSecondUpdateId = existingRecords.length === 1 ? existingRecords[0].id : null;

  return {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _opts) {
      calls.vectorSearch.push({ ts: Date.now() });
      const record = existingRecords[0];
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
      updatePatches.push({ id, patch, idx: calls.update.length });
      // Restore updates carry _origMetadata and should not count as invalidation attempts
      if (failOnSecondUpdateId && id === failOnSecondUpdateId && !patch._origMetadata) {
        const count = (invalidationCallCount[id] ?? 0) + 1;
        invalidationCallCount[id] = count;
        if (count > 1) {
          throw new Error(`store.update() rejected for id=${id} (second update — superseded_by already set)`);
        }
      }
    },

    async delete(id, _scopeFilter) {
      calls.delete.push({ id, ts: Date.now() });
    },

    get calls() { return calls; },
    getStoreCallCount() { return calls.store.length; },
    getBulkStoreCallCount() { return calls.bulkStore.length; },
    getUpdateCallCount() { return calls.update.length; },
    getDeleteCallCount() { return calls.delete.length; },
    getUpdatePatches() { return updatePatches; },
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
      text: "Old entity X",
      category: "entity",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "entity-x",
        memory_category: "entities",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    // failOnUpdateId = existing-002 → its update fails, existing-001 succeeds.
    // Rollback should only target existing-001 (the succeeded one).
    const store = makeStoreWithFailingUpdate([existing001, existing002], "existing-002");
    const embedder = makeEmbedder();
    // Custom LLM mock that returns 2 candidates from DIFFERENT categories
    // (preferences vs entities) so batchDedup doesn't collapse them.
    // Both categories are in TEMPORAL_VERSIONED_CATEGORIES so both go through handleSupersede.
    // dedup loop: candidate 0 → match_index 1 → existing-001 (vectorSearch idx 0, 1-based index)
    //             candidate 1 → match_index 2 → existing-002 (vectorSearch idx 1, 1-based index)
    let decisionIdx = 0;
    const decisions = [
      { decision: "supersede", match_index: 1 },
      { decision: "supersede", match_index: 1 },
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
                category: "entities",
                abstract: "Project Alpha is a Q2 initiative led by the engineering team",
                overview: "## Entity\n- Project Alpha defined",
                content: "Project Alpha is a Q2 initiative.",
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
    console.log(`  store delete calls after: ${store.getDeleteCallCount()}`);
    console.log(`  log entries after: ${logSpy.entries.length}`);
    console.log(`  log entries: ${logSpy.entries.join("; ")}`);

    // Verify update call count:
    // - bulkStore: 1 (for 2 new entries)
    // - invalidate existing-001: 1 update call (succeeds) → inv[0] has newEntryId set
    // - invalidate existing-002: 1 update call (fails) → inv[1] has newEntryId set
    // - rollback Phase 1 (F2 fix): delete BOTH newEntryIds (all invalidateEntries, not just succeeded)
    //   → inv[0].newEntryId deleted (succeeded) + inv[1].newEntryId deleted (failed orphan)
    // - rollback Phase 2: restore existing-001: 1 update call → uses _origMetadata
    // Total: 3 update calls + 2 delete calls (F2 fix: ALL newEntryIds are deleted)
    assert.strictEqual(store.getUpdateCallCount(), 3,
      `Expected 3 update calls (2 invalidation + 1 rollback), got ${store.getUpdateCallCount()}`);
    // F2 fix: ALL newEntryIds are deleted on rollback (not just succeeded inv's)
    // inv[0].newEntryId (succeeded) + inv[1].newEntryId (failed orphan) = 2 deletes
    assert.strictEqual(store.getDeleteCallCount(), 2,
      `F2 fix: Expected 2 delete calls (all newEntryIds), got ${store.getDeleteCallCount()}`);
    assert.strictEqual(store.calls.delete[0].id.startsWith("bulk-"), true,
      `Delete should target the new entry created by bulkStore, got id=${store.calls.delete[0].id}`);

    // Verify rollback happened (last update call should be on existing-001 with original metadata)
    const patches = store.getUpdatePatches();
    assert.strictEqual(patches.length, 3, "Should record all 3 update patches");

    const [inv001, inv002, rollback001] = patches;

    // inv001: first update = invalidation of existing-001 (succeeded)
    assert.strictEqual(inv001.id, "existing-001");
    assert.ok(inv001.patch.metadata.includes("invalidated_at"),
      "First patch should be invalidation metadata (includes invalidated_at)");
    // inv002: second update = invalidation of existing-002 (FAILED — update threw)
    assert.strictEqual(inv002.id, "existing-002",
      "Second patch should be invalidation metadata for existing-002");
    assert.ok(inv002.patch.metadata.includes("invalidated_at"),
      "Second patch should be invalidation metadata for existing-002");

    // rollback001: third update = rollback of existing-001 with ORIGINAL metadata.
    // _origMetadata had invalidated_at: null (active state before invalidation).
    // The restored metadata string contains "invalidated_at":null (key present, value null).
    assert.strictEqual(rollback001.id, "existing-001",
      "Rollback should target existing-001 (the succeeded invalidation)");
    assert.ok(rollback001.patch.metadata.includes('"invalidated_at":null'),
      "Rollback patch must use _origMetadata with invalidated_at:null (active state)");
    assert.ok(rollback001.patch.metadata.includes('"fact_key":"pref-a"'),
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


  /**
   * TC-6: MR2 — Two candidates would supersede the same existing entry.
   *
   * With MR2 fix, the second candidate is deduplicated to "create as new"
   * instead of attempting a supersede that would fail (same entry already has
   * superseded_by from first candidate's invalidation).
   *
   * Scenario (MR2 behavior):
   * 1. One existing entry X in DB (existing-001)
   * 2. Candidate A matches X → handleSupersede(X) → invalidateEntries[0] + A1 queued
   * 3. Candidate B matches X (same matchId) → MR2 dedup kicks in
   *    → "matchId existing already queued for supersession — creating as new entry instead"
   *    → B1 queued as create (NOT in invalidateEntries)
   * 4. bulkStore([A1, B1]) → bulkResults = [A1_with_id, B1_with_id]
   * 5. Second pass: inv[0].newEntryId = A1.id
   * 6. Invalidation: 1 update (inv[0], A's supersede) → succeeds (first update to X)
   * 7. Rollback Phase 1: deletes A1.id (only entry in invalidateEntries)
   * 8. Rollback Phase 2: restores X metadata (succeeded inv[0] only)
   *
   * Note: B1 is NOT deleted because B was NOT in invalidateEntries (MR2 dedup).
   * B1 remains as a valid new entry — this is correct behavior.
   */
  it("TC-6: MR2 — second candidate deduplicated to create (not supersede same entry)", async () => {
    const existing001 = {
      id: "existing-001",
      text: "User prefers oat milk",
      category: "entity",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-oat",
        memory_category: "entities",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    // makeStoreWithPerIdCallCount:
    // - vectorSearch always returns existing-001 (both candidates match same entry)
    // - First update to existing-001 succeeds, second update fails
    const store = makeStoreWithPerIdCallCount([existing001]);
    const embedder = makeEmbedder();

    let decisionIdx = 0;
    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return {
            memories: [
              {
                category: "entities",
                abstract: "User prefers oat milk over dairy milk every morning",
                overview: "## Pref\n- Oat milk preferred",
                content: "User prefers oat milk over dairy.",
              },
              {
                category: "entities",
                abstract: "User prefers oat milk to stay healthy",
                overview: "## Pref\n- Oat milk health",
                content: "User prefers oat milk for health reasons.",
              },
            ],
          };
        }
        if (mode === "dedup-decision") {
          const d = { decision: "supersede", match_index: 1 };
          decisionIdx++;
          return d;
        }
        return null;
      },
    };
    const logSpy = makeLogSpy();
    const extractor = makeExtractor(store, embedder, llm, logSpy);

    await extractor.extractAndPersist(
      "User updated preferences twice.",
      "session:test-tc6",
    );

    console.log(`\nTC-6 debug:`);
    console.log(`  bulkStore calls: ${store.getBulkStoreCallCount()}`);
    console.log(`  update calls: ${store.getUpdateCallCount()}`);
    console.log(`  delete calls: ${store.getDeleteCallCount()}`);
    console.log(`  delete ids: ${store.calls.delete.map(d => d.id).join(", ")}`);
    console.log(`  log entries: ${logSpy.entries.join("; ")}`);

    // Assertions:
    // bulkStore: 1 call with 2 entries (A1 and B1)
    assert.strictEqual(store.getBulkStoreCallCount(), 1,
      "Should call bulkStore once for 2 new entries");
    const bulkEntries = store.calls.bulkStore[0].entries;
    assert.strictEqual(bulkEntries.length, 2,
      "bulkStore should receive 2 new entries (A1 and B1)");

    // update calls: 1 invalidation only (MR2 dedup prevents B from even attempting update)
    // Since no update failed → no rollback triggered
    assert.strictEqual(store.getUpdateCallCount(), 1,
      `Expected 1 update call (A's invalidation; B deduped before attempting update), got ${store.getUpdateCallCount()}`);

    // delete calls: 0 (no rollback since no failed invalidations)
    // This is the correct MR2 behavior: dedup prevents the race condition entirely
    assert.strictEqual(store.getDeleteCallCount(), 0,
      `MR2: Rollback should not be triggered (no failed invalidations), got ${store.getDeleteCallCount()} deletes`);

    const deleteIds = store.calls.delete.map(d => d.id);
    assert.strictEqual(deleteIds.every(id => id.startsWith("bulk-")), true,
      `All deleted IDs should come from bulkStore, got: ${deleteIds.join(", ")}`);

    // Verify rollback log shows no failure
    const rollbackFailedLog = logSpy.entries.find(e => e.includes("ROLLBACK FAILED"));
    assert.ok(!rollbackFailedLog,
      "Rollback itself should succeed (no ROLLBACK FAILED log)");

    console.log(`\n📊 TC-6 MR2 verification:`);
    console.log(`   update calls: ${store.getUpdateCallCount()} (expected: 1 — A's invalidation; B deduped)`);
    console.log(`   delete calls: ${store.getDeleteCallCount()} (expected: 0 — no rollback needed)`);
    console.log(`   ✅ MR2 dedup prevents race condition; no failed invalidations, no rollback`);
  });

});
