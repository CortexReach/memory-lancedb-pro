/**
 * Test: Extraction Write Validation (Issue #693)
 *
 * Tests the countBefore/countAfter validation logic in extractAndPersist().
 *
 * Key challenge: SmartExtractor's `batchDedup` uses cosine similarity (threshold 0.85)
 * on embedded candidate abstracts to filter near-duplicates BEFORE the dedup pipeline.
 * Simple charCodeAt-based vectors all score >0.85 similarity (common English letters).
 *
 * Solution: `DeterministicRandomEmbedder` generates 256-dim vectors using a
 * seeded RNG (Mulberry32) keyed on the text content. Each distinct text produces
 * a unique vector with cosine similarity < 0.85, ensuring candidates survive batchDedup.
 *
 * Validates:
 *   T1. Normal extraction: expected === actual, mismatch = 0, callback NOT triggered
 *   T2. Empty extraction: skipped, mismatch undefined (validation skipped)
 *   T3. Partial bulkStore failure: actual < expected → mismatch > 0, callback triggered
 *   T4. Post-write deletion (compactor race): actual < expected → mismatch > 0
 *   T5. Callback is optional — no error if omitted even on mismatch
 *   T6. Multiple extractions each get independent validation state
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

// ============================================================================
// Helpers
// ============================================================================

/**
 * Mulberry32 seeded PRNG — fast, deterministic, good distribution.
 * Returns a new RNG function seeded from an integer.
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic random embedder.
 *
 * Produces 256-dimensional vectors using a seeded RNG keyed on the text.
 * Different texts → different seeds → vectors with cosine similarity < 0.85,
 * ensuring candidates survive SmartExtractor's internal batchDedup filter.
 *
 * This lets us test with 2+ candidates without fighting the dedup logic.
 */
function makeDeterministicEmbedder() {
  return {
    async embed(text) {
      const seed = [...text].reduce((acc, c) => acc + c.charCodeAt(0), 0) >>> 0;
      const rng = makeRng(seed === 0 ? 1 : seed);
      return Array.from({ length: 256 }, () => rng());
    },
    async embedBatch(texts) {
      return texts.map((t) => {
        const seed = [...t].reduce((acc, c) => acc + c.charCodeAt(0), 0) >>> 0;
        const rng = makeRng(seed === 0 ? 1 : seed);
        return Array.from({ length: 256 }, () => rng());
      });
    },
  };
}

/**
 * Mock LLM — returns configurable candidates and "create" for all dedup decisions.
 * The "create" decision ensures candidates progress through the dedup pipeline
 * and reach bulkStore without special handling (no handleSupersede, handleMerge, etc.).
 */
function makeLlm(candidates = []) {
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") return { memories: candidates };
      if (mode === "dedup-decision") return { decision: "create", reason: "no match" };
      if (mode === "merge-memory") return candidates[0] ?? null;
      return null;
    },
  };
}

/**
 * Mock store with configurable write behavior.
 *
 * Config:
 *   initialCount    — starting row count (default 0)
 *   dropLastN       — silently drop last N entries on bulkStore (partial write failure)
 *   bulkStoreThrows — throw on bulkStore (total write failure)
 */
function makeStore(config = {}) {
  const { initialCount = 0, dropLastN = 0, bulkStoreThrows = false } = config;
  let rowCount = initialCount;
  const entries = [];

  const store = {
    _config: config,

    async count() { return rowCount; },

    async vectorSearch() { return []; },

    async store(entry) {
      rowCount++;
      entries.push({ action: "store", id: entry.id ?? "?" });
      return { ...entry, id: "direct-id-" + entries.length };
    },

    async bulkStore(batchEntries) {
      if (bulkStoreThrows) throw new Error("bulkStore simulated failure");
      const stored = dropLastN > 0
        ? batchEntries.slice(0, batchEntries.length - dropLastN)
        : batchEntries;
      for (let i = 0; i < stored.length; i++) {
        rowCount++;
        entries.push({ action: "bulkStore", id: stored[i].id ?? "bulk-" + i });
      }
      if (dropLastN > 0) entries.push({ action: "bulkStore_dropped", count: dropLastN });
      return stored.map((e, i) => ({ ...e, id: "bulk-id-" + i }));
    },

    async update(_id, _patch, _scopeFilter) {
      entries.push({ action: "update", id: _id });
    },

    async getById() { return null; },

    async delete(_id) {
      rowCount = Math.max(0, rowCount - 1);
      entries.push({ action: "delete", id: _id });
    },

    get entries() { return [...entries]; },
    get rowCount() { return rowCount; },
    reset() { rowCount = initialCount; entries.length = 0; },
  };
  return store;
}

function makeExtractor(embedder, llm, store, config = {}) {
  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
    ...config,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Issue #693: Extraction write validation", () => {

  // --------------------------------------------------------------------------
  // T1: Normal extraction — expected === actual, mismatch = 0, no callback
  // --------------------------------------------------------------------------
  it("T1: normal extraction passes validation with mismatch=0", async () => {
    const embedder = makeDeterministicEmbedder();
    // Two semantically different abstracts → low cosine similarity → both survive batchDedup
    const llm = makeLlm([
      {
        category: "preferences",
        abstract: "User prefers dark mode interface settings for eye comfort during coding",
        overview: "Display preference",
        content: "The user prefers dark mode interface settings on their workstation for reduced eye strain during extended coding sessions.",
      },
      {
        category: "entities",
        abstract: "User works at Acme Corporation headquarters in the R&D division",
        overview: "Employment information",
        content: "The user is employed as a senior software engineer at Acme Corporation's research and development headquarters facility.",
      },
    ]);
    const store = makeStore({ initialCount: 0 });
    const extractor = makeExtractor(embedder, llm, store);

    let callbackInvoked = false;
    let receivedValidation = null;

    const stats = await extractor.extractAndPersist(
      "I use dark mode at work and work at Acme Corp",
      "session-t1",
      {
        onExtractionValidationFailed(validation) {
          callbackInvoked = true;
          receivedValidation = validation;
        },
      }
    );

    assert.strictEqual(stats.created, 2, "both candidates should be created");
    assert.strictEqual(
      stats.validationMismatch,
      undefined,
      "validationMismatch should be undefined (not in public ExtractionStats)"
    );
    assert.strictEqual(callbackInvoked, false, "callback should NOT be triggered");
    assert.strictEqual(store.rowCount, 2, "both entries should be written");
    assert.strictEqual(receivedValidation, null, "no validation object received");
  });

  // --------------------------------------------------------------------------
  // T2: Empty extraction — no bulkStore, validation skipped
  // --------------------------------------------------------------------------
  it("T2: empty extraction skips validation", async () => {
    const embedder = makeDeterministicEmbedder();
    const llm = makeLlm([]);
    const store = makeStore({ initialCount: 5 });
    const extractor = makeExtractor(embedder, llm, store);

    let callbackInvoked = false;

    const stats = await extractor.extractAndPersist(
      "nothing to extract here",
      "session-t2",
      { onExtractionValidationFailed() { callbackInvoked = true; } }
    );

    assert.strictEqual(stats.created, 0, "no entries created");
    assert.strictEqual(
      stats.validationMismatch,
      undefined,
      "validationMismatch should be undefined for empty extraction (validation skipped)"
    );
    assert.strictEqual(callbackInvoked, false, "callback should NOT fire");
    assert.strictEqual(store.rowCount, 5, "pre-existing count unchanged");
  });

  // --------------------------------------------------------------------------
  // T3: Partial bulkStore failure — actual < expected → mismatch > 0
  // --------------------------------------------------------------------------
  it("T3: partial bulkStore failure triggers mismatch > 0", async () => {
    const embedder = makeDeterministicEmbedder();
    // 3 candidates → dropLastN=1 → actual=2, mismatch=1
    const llm = makeLlm([
      {
        category: "preferences",
        abstract: "User prefers dark mode interface settings for eye comfort during coding",
        overview: "Display preference",
        content: "The user prefers dark mode interface settings on their workstation for reduced eye strain during extended coding sessions.",
      },
      {
        category: "preferences",
        abstract: "User prefers light theme when editing documents and writing emails",
        overview: "Display preference",
        content: "In contrast to dark mode, the user prefers light theme when editing documents and writing emails in their daily productivity workflow.",
      },
      {
        category: "entities",
        abstract: "User works at Acme Corporation headquarters in the R&D division",
        overview: "Employment information",
        content: "The user is employed as a senior software engineer at Acme Corporation's research and development headquarters facility.",
      },
    ]);
    const store = makeStore({ initialCount: 0, dropLastN: 1 });
    const extractor = makeExtractor(embedder, llm, store);

    let callbackInvoked = false;
    let receivedValidation = null;

    const stats = await extractor.extractAndPersist(
      "I use dark mode for coding but light theme for writing emails at Acme Corp",
      "session-t3",
      {
        onExtractionValidationFailed(validation) {
          callbackInvoked = true;
          receivedValidation = validation;
        },
      }
    );

    // Expected = 3, Actual = 2 (dropLastN=1), Mismatch = 1
    // Note: validationMismatch is NOT written to stats (removed from public API)
    // Only the callback receives the mismatch information
    assert.strictEqual(callbackInvoked, true, "callback SHOULD be triggered");
    assert.ok(receivedValidation);
    assert.strictEqual(receivedValidation.expected, 3);
    assert.strictEqual(receivedValidation.actual, 2);
    assert.strictEqual(receivedValidation.mismatch, 1);
    assert.strictEqual(receivedValidation.sessionKey, "session-t3");
    assert.strictEqual(store.rowCount, 2, "only 2 rows written");
  });

  // --------------------------------------------------------------------------
  // T4: Post-write deletion (compactor race) — actual < expected
  // --------------------------------------------------------------------------
  it("T4: post-write deletion triggers mismatch > 0 (compactor race)", async () => {
    const embedder = makeDeterministicEmbedder();
    // 2 candidates → compactor deletes 1 after bulkStore → actual=1, mismatch=1
    const llm = makeLlm([
      {
        category: "cases",
        abstract: "User completed initial setup wizard on first launch of the application",
        overview: "Setup wizard completion",
        content: "The user has successfully completed the initial setup wizard and application onboarding process during their first launch of the software application on their primary workstation.",
      },
      {
        category: "cases",
        abstract: "User configured notification preferences including email and push alerts",
        overview: "Notification settings configuration",
        content: "Following the initial setup, the user proceeded to configure various notification preferences including email alerts, desktop push notifications, and mobile synchronization settings.",
      },
    ]);
    const store = makeStore({ initialCount: 0 });
    const extractor = makeExtractor(embedder, llm, store);

    // Simulate compactor deleting 1 entry after bulkStore succeeds
    const originalBulkStore = store.bulkStore.bind(store);
    store.bulkStore = async (entries) => {
      const result = await originalBulkStore(entries);
      await store.delete("bulk-id-0"); // compactor race: delete first entry
      return result;
    };

    let callbackInvoked = false;
    let receivedValidation = null;

    const stats = await extractor.extractAndPersist(
      "I completed setup and configured notification preferences",
      "session-t4",
      {
        onExtractionValidationFailed(validation) {
          callbackInvoked = true;
          receivedValidation = validation;
        },
      }
    );

    // Expected = 2, Actual = 1 (compactor deleted 1), Mismatch = 1
    // Note: validationMismatch is NOT written to stats (removed from public API)
    assert.strictEqual(callbackInvoked, true, "callback SHOULD be triggered");
    assert.ok(receivedValidation);
    assert.strictEqual(receivedValidation.expected, 2);
    assert.strictEqual(receivedValidation.actual, 1);
    assert.strictEqual(receivedValidation.mismatch, 1);
    assert.strictEqual(receivedValidation.sessionKey, "session-t4");
    assert.strictEqual(store.rowCount, 1, "1 row remaining after deletion");
  });

  // --------------------------------------------------------------------------
  // T5: Callback is optional — no error if omitted
  // --------------------------------------------------------------------------
  it("T5: callback is optional — no error if omitted even on mismatch", async () => {
    const embedder = makeDeterministicEmbedder();
    // 2 candidates that survive batchDedup, with dropLastN=1
    const llm = makeLlm([
      {
        category: "events",
        abstract: "User attended quarterly business review meeting with the team lead",
        overview: "Meeting attendance",
        content: "The quarterly business review meeting was attended by the user along with their direct team members to discuss ongoing project status and future planning initiatives.",
      },
      {
        category: "events",
        abstract: "User participated in a formal code review session with constructive feedback",
        overview: "Code review participation",
        content: "The user actively participated in a formal code review session where they provided constructive feedback on pull request implementations and discussed architectural decision implications.",
      },
    ]);
    const store = makeStore({ initialCount: 0, dropLastN: 1 });
    const extractor = makeExtractor(embedder, llm, store);

    // Should NOT throw even though mismatch occurs and callback is absent
    // Note: validationMismatch is NOT written to stats (exposed only via callback)
    await extractor.extractAndPersist(
      "User said: I attended the quarterly business review and participated in a code review",
      "session-t5",
      {}  // no callback
    );
    assert.strictEqual(store.rowCount, 1, "1 row written despite mismatch (dropLastN=1)");
  });

  // --------------------------------------------------------------------------
  // T6: Multiple extractions — independent validation state
  // --------------------------------------------------------------------------
  it("T6: multiple extractions each get independent validation", async () => {
    const embedder = makeDeterministicEmbedder();

    // First extraction: normal (no mismatch)
    const llm1 = makeLlm([{
      category: "events",
      abstract: "User attended quarterly business review meeting with the team lead",
      overview: "Meeting",
      content: "The quarterly business review meeting was attended by the user along with their direct team members to discuss ongoing project status and future planning initiatives.",
    }]);
    const store1 = makeStore({ initialCount: 0 });
    const extractor1 = makeExtractor(embedder, llm1, store1);
    store1.reset();

    const validations = [];

    const stats1 = await extractor1.extractAndPersist(
      "User said: I attended the quarterly business review",
      "session-multi-1",
      { onExtractionValidationFailed(v) { validations.push(v); } }
    );

    assert.strictEqual(stats1.validationMismatch, undefined, "first: validationMismatch undefined");
    assert.strictEqual(validations.length, 0, "first: no callback fired");

    // Second extraction: partial write failure (dropLastN=1) → mismatch=1
    const llm2 = makeLlm([
      {
        category: "events",
        abstract: "User attended quarterly business review meeting with the team lead",
        overview: "Meeting",
        content: "The quarterly business review meeting was attended by the user along with their direct team members to discuss ongoing project status and future planning initiatives.",
      },
      {
        category: "events",
        abstract: "User participated in a formal code review session with constructive feedback",
        overview: "Code review",
        content: "The user actively participated in a formal code review session where they provided constructive feedback on pull request implementations and discussed architectural decision implications.",
      },
    ]);
    const store2 = makeStore({ initialCount: 0, dropLastN: 1 });
    const extractor2 = makeExtractor(embedder, llm2, store2);

    const stats2 = await extractor2.extractAndPersist(
      "User said: I attended a quarterly meeting and participated in a code review",
      "session-multi-2",
      { onExtractionValidationFailed(v) { validations.push(v); } }
    );

    // Second extraction: 2 candidates, dropLastN=1 → actual=1, expected=2, mismatch=1
    // Note: validationMismatch is NOT written to stats (removed from public API)
    // Only the callback receives the mismatch
    assert.strictEqual(validations.length, 1, "second: callback fired once");
    assert.strictEqual(validations[0].sessionKey, "session-multi-2");
    assert.strictEqual(validations[0].mismatch, 1);
  });

});
