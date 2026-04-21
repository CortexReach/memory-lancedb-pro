/**
 * Test: handleSupersede batch mode invalidation (Issue #676 + invalidateEntries fix)
 *
 * Tests the REAL SmartExtractor.handleSupersede() method via jiti import.
 *
 * The fix adds invalidateEntries[] mechanism:
 * - extractAndPersist creates invalidateEntries[]
 * - handleSupersede batch path pushes old-entry invalidation to invalidateEntries[]
 * - After bulkStore(): iterate invalidateEntries and call store.update() for each
 *
 * Key invariants tested:
 * 1. When existing record found in batch mode: NO direct store.store() call
 * 2. New entry goes into createEntries[] for bulkStore
 * 3. Old entry gets invalidated via store.update() AFTER bulkStore
 * 4. superseded_by is intentionally OMITTED in batch mode (new ID unknown)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

// ---------------------------------------------------------------------------
// Mock Store — tracks all operations for verification
// ---------------------------------------------------------------------------

function makeStore(existingRecords = []) {
  const calls = { store: [], bulkStore: [], update: [], getById: [], vectorSearch: [] };
  const db = new Map(existingRecords.map(r => [r.id, r]));

  const store = {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _opts) {
      calls.vectorSearch.push({ ts: Date.now() });
      // Return the first existing record as a match (for supersede trigger)
      if (db.size > 0) {
        const first = existingRecords[0];
        return [{
          entry: { ...first, vector: _vector },
          score: 0.95,
        }];
      }
      return [];
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
      return entries.map(e => ({ ...e, id: "bulk-" + Math.random().toString(36).slice(2) }));
    },

    async update(id, patch, _scopeFilter) {
      calls.update.push({ id, patch, ts: Date.now() });
    },

    get calls() { return calls; },

    getStoreCallCount() { return calls.store.length; },
    getBulkStoreCallCount() { return calls.bulkStore.length; },
    getUpdateCallCount() { return calls.update.length; },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Mock Embedder
// ---------------------------------------------------------------------------

function makeEmbedder() {
  return {
    async embed(text) {
      // Return deterministic vector based on text for stable dedup
      return Array(256).fill(0).map((_, i) =>
        text.length > 0 ? (text.charCodeAt(i % text.length) / 255) : 0
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

function makeLlmForSupersede(existingRecordId) {
  return {
    async completeJson(prompt, mode) {
      if (mode === "extract-candidates") {
        // Return one preferences candidate (temporal-versioned category for supersede)
        return {
          memories: [{
            category: "preferences",
            abstract: "Updated preference about coffee",
            overview: "## Preference\n- Changed to prefer oat milk",
            content: "User now prefers oat milk in coffee instead of regular milk.",
          }],
        };
      }
      if (mode === "dedup-decision") {
        // Trigger supersede: LLM says this new preference supersedes the old one
        // match_index is 1-based, pointing to the first similar entry from vectorSearch
        return {
          decision: "supersede",
          reason: "The new preference about oat milk supersedes the old dairy preference",
          match_index: 1,
        };
      }
      return null;
    },
  };
}

function makeLlmForCreate() {
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: [{
            category: "preferences",
            abstract: "New preference about tea",
            overview: "## Preference\n- Likes green tea",
            content: "User likes green tea.",
          }],
        };
      }
      if (mode === "dedup-decision") {
        return { decision: "create", reason: "no similar memory" };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// SmartExtractor factory
// ---------------------------------------------------------------------------

function makeExtractor(store, embedder, llm) {
  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
  });
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("Issue #676: handleSupersede batch mode with real SmartExtractor", () => {

  /**
   * TC-1: SUPERSEDE decision in batch mode
   *
   * Flow: extractAndPersist → processCandidate → deduplicate → handleSupersede
   *
   * Expected:
   * - 0 × store.store() [no individual writes]
   * - 1 × bulkStore() [all new entries in one batch]
   * - 1 × store.update() [old entry invalidated after bulkStore]
   */
  it("SUPERSEDE: no direct store.store(), uses bulkStore + update", async () => {
    const existingRecord = {
      id: "existing-pref-001",
      text: "Old preference: dairy milk in coffee",
      category: "preference",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({
        fact_key: "pref-coffee-milk",
        memory_category: "preferences",
        state: "confirmed",
        invalidated_at: null,
      }),
    };

    const store = makeStore([existingRecord]);
    const embedder = makeEmbedder();
    const llm = makeLlmForSupersede(existingRecord.id);
    const extractor = makeExtractor(store, embedder, llm);

    await extractor.extractAndPersist(
      "User now prefers oat milk in coffee instead of regular milk.",
      "session:test-1",
    );

    const storeCount = store.getStoreCallCount();
    const bulkCount = store.getBulkStoreCallCount();
    const updateCount = store.getUpdateCallCount();

    console.log(`\n📊 SUPERSEDE batch mode:`);
    console.log(`   store.store() calls: ${storeCount} (expected: 0)`);
    console.log(`   bulkStore() calls: ${bulkCount} (expected: 1)`);
    console.log(`   store.update() calls: ${updateCount} (expected: 1)`);
    console.log(`   vectorSearch calls: ${store.calls.vectorSearch.length}`);

    assert.strictEqual(storeCount, 0,
      "SUPERSEDE in batch mode must NOT call store.store() individually");
    assert.strictEqual(bulkCount, 1,
      "SUPERSEDE in batch mode must call bulkStore() once for all entries");
    assert.strictEqual(updateCount, 1,
      "SUPERSEDE in batch mode must call store.update() for old entry invalidation");
  });

  /**
   * TC-2: CREATE decision in batch mode (no existing record)
   *
   * Expected:
   * - 0 × store.store()
   * - 1 × bulkStore()
   * - 0 × store.update() [no old entry to invalidate]
   */
  it("CREATE: uses bulkStore, no update needed", async () => {
    const store = makeStore([]); // no existing records
    const embedder = makeEmbedder();
    const llm = makeLlmForCreate();
    const extractor = makeExtractor(store, embedder, llm);

    await extractor.extractAndPersist(
      "User likes green tea.",
      "session:test-2",
    );

    const storeCount = store.getStoreCallCount();
    const bulkCount = store.getBulkStoreCallCount();
    const updateCount = store.getUpdateCallCount();

    console.log(`\n📊 CREATE batch mode:`);
    console.log(`   store.store() calls: ${storeCount} (expected: 0)`);
    console.log(`   bulkStore() calls: ${bulkCount} (expected: 1)`);
    console.log(`   store.update() calls: ${updateCount} (expected: 0)`);

    assert.strictEqual(storeCount, 0,
      "CREATE in batch mode must NOT call store.store() individually");
    assert.strictEqual(bulkCount, 1,
      "CREATE in batch mode must call bulkStore() once");
    assert.strictEqual(updateCount, 0,
      "CREATE has no old entry to invalidate");
  });

  /**
   * TC-3: Verify bulkStore receives all entries at once
   *
   * Multiple CREATE decisions should all be batched into one bulkStore call.
   */
  it("bulkStore receives all entries in single call", async () => {
    const store = makeStore([]);
    const embedder = makeEmbedder();
    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return {
            memories: [
              {
                category: "preferences",
                abstract: "Prefers coffee",
                overview: "## Pref\n- Coffee",
                content: "User likes coffee.",
              },
              {
                category: "entities",
                abstract: "Uses VS Code",
                overview: "## Entity\n- VS Code",
                content: "User uses VS Code as editor.",
              },
            ],
          };
        }
        if (mode === "dedup-decision") {
          return { decision: "create", reason: "no match" };
        }
        return null;
      },
    };
    const extractor = makeExtractor(store, embedder, llm);

    await extractor.extractAndPersist(
      "User likes coffee and uses VS Code.",
      "session:test-3",
    );

    const bulkCount = store.getBulkStoreCallCount();
    const firstBulk = store.calls.bulkStore[0];
    const entryCount = firstBulk?.entries?.length ?? 0;

    console.log(`\n📊 Multiple CREATE batch:`);
    console.log(`   bulkStore() calls: ${bulkCount} (expected: 1)`);
    console.log(`   Entries per bulkStore: ${entryCount} (expected: 2)`);

    assert.strictEqual(bulkCount, 1,
      "Multiple CREATE decisions must be batched into 1 bulkStore call");
    assert.strictEqual(entryCount, 2,
      "bulkStore must receive all 2 entries in one call");
  });

  /**
   * TC-4: Verify invalidated entry metadata has invalidated_at set
   *
   * After store.update() is called, the old entry should have invalidated_at set.
   * superseded_by is intentionally OMITTED in batch mode (new ID unknown).
   */
  it("store.update() receives metadata with invalidated_at", async () => {
    const existingRecord = {
      id: "existing-pref-002",
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

    const store = makeStore([existingRecord]);
    const embedder = makeEmbedder();
    const llm = makeLlmForSupersede(existingRecord.id);
    const extractor = makeExtractor(store, embedder, llm);

    await extractor.extractAndPersist(
      "User now prefers oat milk over dairy.",
      "session:test-4",
    );

    const updateCall = store.calls.update[0];
    assert.ok(updateCall, "store.update() must be called for old entry");
    assert.strictEqual(updateCall.id, "existing-pref-002",
      "store.update() must be called with correct old entry ID");

    const updatedMeta = JSON.parse(updateCall.patch.metadata);
    assert.ok(updatedMeta.invalidated_at > 0,
      "invalidated_at must be set on old entry");

    // superseded_by is null in batch mode (new ID unknown until bulkStore)
    // This is intentional - new entry's 'supersedes: matchId' provides dedup signal
    assert.strictEqual(updatedMeta.superseded_by, undefined,
      "superseded_by is undefined in batch mode (field omitted from patch — JSON drops undefined keys)");

    console.log(`\n📊 Invalidation metadata:`);
    console.log(`   invalidated_at: ${updatedMeta.invalidated_at}`);
    console.log(`   superseded_by: ${updatedMeta.superseded_by}`);
    console.log(`   fact_key preserved: ${updatedMeta.fact_key}`);
  });

  /**
   * TC-5: Non-temporal category (e.g., "cases") should NOT trigger supersede
   *
   * Categories not in TEMPORAL_VERSIONED_CATEGORIES fall through to CREATE.
   */
  it("Non-temporal category falls through to CREATE, not SUPERSEDE", async () => {
    const existingRecord = {
      id: "existing-case-001",
      text: "Case solved: bug in auth module",
      category: "fact",
      scope: "global",
      importance: 0.8,
      metadata: JSON.stringify({ fact_key: "case-auth", state: "confirmed" }),
    };

    const store = makeStore([existingRecord]);
    const embedder = makeEmbedder();
    const llm = {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return {
            memories: [{
              category: "cases",
              abstract: "New case: bug in auth module fixed",
              overview: "## Case\n- Fixed auth bug",
              content: "The auth module bug has been fixed.",
            }],
          };
        }
        if (mode === "dedup-decision") {
          return { decision: "supersede", reason: "similar", match_index: 1 };
        }
        return null;
      },
    };
    const extractor = makeExtractor(store, embedder, llm);

    await extractor.extractAndPersist(
      "Fixed the auth module bug.",
      "session:test-5",
    );

    const storeCount = store.getStoreCallCount();
    const bulkCount = store.getBulkStoreCallCount();
    const updateCount = store.getUpdateCallCount();

    console.log(`\n📊 Non-temporal category (cases):`);
    console.log(`   store.store() calls: ${storeCount}`);
    console.log(`   bulkStore() calls: ${bulkCount}`);
    console.log(`   store.update() calls: ${updateCount}`);

    // "cases" is NOT in TEMPORAL_VERSIONED_CATEGORIES, so supersede path is skipped
    // Even though LLM returns "supersede", the category check blocks it
    assert.strictEqual(bulkCount, 1,
      "Non-temporal category must fall through to CREATE via bulkStore");
    assert.strictEqual(updateCount, 0,
      "Non-temporal category should NOT call store.update()");
  });
});
