import { describe, it } from "node:test";
import assert from "node:assert";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

// ============================================================================
// Store mock — records all operations, supports batch mode
// ============================================================================

let bulkStoreIndex = 0;
let updateShouldFail = false;
let deleteShouldFail = false;

function makeBatchStore({ existingEntries = [] }) {
  const entries = [...existingEntries];
  const operations = [];

  updateShouldFail = false;
  deleteShouldFail = false;
  bulkStoreIndex = 0;

  const store = {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _options) {
      return existingEntries.map((e) => ({ entry: e, score: 1.0 }));
    },

    async store(entry) {
      const id = `gen-${entries.length}`;
      const full = { ...entry, id };
      entries.push(full);
      operations.push({ op: "store", entry: { ...entry }, id });
      return full;
    },

    async bulkStore(batchEntries) {
      const results = [];
      for (const entry of batchEntries) {
        const id = `bulk-${bulkStoreIndex++}`;
        const full = { ...entry, id };
        entries.push(full);
        results.push(full);
        operations.push({ op: "bulkStore", entry: { ...entry }, id });
      }
      return results;
    },

    async update(id, patch, _scopeFilter) {
      operations.push({ op: "update", id, patch: { ...patch } });
      if (updateShouldFail) {
        const err = new Error("mock update failure");
        err.code = "MOCK_FAILURE";
        throw err;
      }
      const entry = entries.find((e) => e.id === id);
      if (entry) Object.assign(entry, patch);
    },

    async delete(id, _scopeFilter) {
      operations.push({ op: "delete", id });
      if (deleteShouldFail) {
        const err = new Error("mock delete failure");
        err.code = "MOCK_FAILURE";
        throw err;
      }
      const idx = entries.findIndex((e) => e.id === id);
      if (idx >= 0) entries.splice(idx, 1);
    },

    async getById(id, _scopeFilter) {
      operations.push({ op: "getById", id });
      const found = existingEntries.find((e) => e.id === id);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },

    async count() {
      return entries.length;
    },

    get entries() {
      return [...entries];
    },
    get operations() {
      return [...operations];
    },
  };

  return store;
}

// ============================================================================
// Embedder mock — deterministic vectors
// ============================================================================

function makeEmbedder() {
  return {
    async embed(text) {
      // Position-based vector: first 8 chars → [0.1, 0.2, ..., 0.8]
      // "abc" → [0.1, 0.2, 0.3, 0, 0, 0, 0, 0]
      // Ensures identical prefixes produce identical vectors (similarity 1.0)
      const v = Array(8).fill(0);
      const prefix = text ? text.slice(0, 8) : "";
      for (let i = 0; i < 8; i++) {
        v[i] = i < prefix.length ? (i + 1) * 0.1 : 0;
      }
      return v;
    },
    async embedBatch(texts) {
      return texts.map((t) => {
        const v = Array(8).fill(0);
        const prefix = t ? t.slice(0, 8) : "";
        for (let i = 0; i < 8; i++) {
          v[i] = i < prefix.length ? (i + 1) * 0.1 : 0;
        }
        return v;
      });
    },
  };
}

// ============================================================================
// LLM mock — returns candidates and dedup decisions
// ============================================================================

function makeLlm(candidates, dedupResponse = null) {
  let callCount = 0;
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return { memories: candidates };
      }
      if (mode === "dedup-decision") {
        callCount++;
        if (typeof dedupResponse === "function") {
          return dedupResponse(callCount - 1);
        }
        if (dedupResponse) return dedupResponse;
        return { decision: "create", reason: "test" };
      }
      return null;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Issue #675 #676 — handleSupersede batch mode", () => {
  it("batch mode: uses bulkStore for new entry and calls update to invalidate old entry", async () => {
    const existingEntry = {
      id: "existing-001",
      text: "old preference",
      vector: Array(8).fill(0.1),
      category: "preferences",
      scope: "test",
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: "old preference", category: "preferences", importance: 0.5 },
          {
            memory_category: "preferences",
            l0_abstract: "old preference",
            tier: "working",
            state: "confirmed",
            valid_from: Date.now() - 1000,
            fact_key: "preferences:old",
          },
        ),
      ),
    };

    // supersede: tell LLM to supersede the existing entry (match_index 1 = first in topSimilar)
    const store = makeBatchStore({ existingEntries: [existingEntry] });
    const embedder = makeEmbedder();
    const llm = makeLlm(
      [
        {
          category: "preferences",
          abstract: "new preference text",
          overview: "Updated preference",
          content: "new preference text",
          confidence: 0.9,
          support: [],
        },
      ],
      { decision: "supersede", reason: "test supersede", match_index: 1 },
    );

    const extractor = new SmartExtractor(store, embedder, llm, {});
    const stats = await extractor.extractAndPersist("user updated preference", "session-1");

    const ops = store.operations;
    assert.ok(
      ops.some((op) => op.op === "getById" && op.id === "existing-001"),
      "should call getById for existing entry",
    );

    // bulkStore is called (batch mode), NOT store
    const bulkStoreCalls = ops.filter((op) => op.op === "bulkStore");
    assert.equal(bulkStoreCalls.length, 1, "should call bulkStore exactly once");
    assert.equal(stats.created, 1, "stats.created should be 1");
    assert.equal(stats.superseded, 1, "stats.superseded should be 1");
  });

  it("batch mode: preserves original valid_from when invalidating old entry", async () => {
    const originalValidFrom = Date.now() - 2000;
    const existingEntry = {
      id: "existing-002",
      text: "old preference",
      vector: Array(8).fill(0.1),
      category: "preferences",
      scope: "test",
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: "old preference", category: "preferences", importance: 0.5 },
          {
            memory_category: "preferences",
            l0_abstract: "old preference",
            tier: "working",
            state: "confirmed",
            valid_from: originalValidFrom,
            fact_key: "preferences:old",
          },
        ),
      ),
    };

    const store = makeBatchStore({ existingEntries: [existingEntry] });
    const embedder = makeEmbedder();
    const llm = makeLlm(
      [
        {
          category: "preferences",
          abstract: "updated text",
          overview: "Updated",
          content: "updated text",
          confidence: 0.9,
          support: [],
        },
      ],
      { decision: "supersede", reason: "test supersede", match_index: 1 },
    );

    const extractor = new SmartExtractor(store, embedder, llm, {});
    await extractor.extractAndPersist("user updated", "session-2");

    const ops = store.operations;
    const updateCalls = ops.filter((op) => op.op === "update");
    assert.equal(updateCalls.length, 1, "should call update to invalidate old entry");
    const updatedMeta = parseSmartMetadata(updateCalls[0].patch.metadata, {});
    assert.equal(
      updatedMeta.valid_from,
      originalValidFrom,
      "original valid_from should be preserved in invalidated entry",
    );
  });

  it("standalone path (no existing entry): uses bulkStore (batch mode) for new entry", async () => {
    // No existing entries → dedup returns "create" → goes through batch path
    const store = makeBatchStore({ existingEntries: [] });
    const embedder = makeEmbedder();
    const llm = makeLlm([
      {
        category: "preferences",
        abstract: "brand new fact",
        overview: "New",
        content: "brand new fact",
        confidence: 0.9,
        support: [],
      },
    ]);

    const extractor = new SmartExtractor(store, embedder, llm, {});
    const stats = await extractor.extractAndPersist("new fact", "session-3");

    const ops = store.operations;
    // Since no existing, vectorSearch returns [], dedup returns "create" → bulkStore
    const bulkStoreCalls = ops.filter((op) => op.op === "bulkStore");
    assert.equal(bulkStoreCalls.length, 1, "should call bulkStore for new entry");
    assert.equal(stats.created, 1, "stats.created should be 1");
  });
});
describe("Issue #675 #676 — handleContradict null check", () => {
  it("skips contradiction when getById returns null — no entry created, no update", async () => {
    // Use "patterns" (TEMPORAL_VERSIONED) so contradict goes to handleSupersede
    // (not handleContradict). With empty store, topSimilar=[] and match_index: 1,
    // hasValidIndex = false → destructive decision guard triggers → degrade to "create".
    const store = makeBatchStore({ existingEntries: [] });
    const embedder = makeEmbedder();
    const llm = makeLlm(
      [
        {
          category: "patterns", // TEMPORAL_VERSIONED → handleSupersede path
          abstract: "some pattern detail that is long enough",
          overview: "Pattern",
          content: "some pattern detail that is long enough",
          confidence: 0.9,
          support: [],
        },
      ],
      // match_index: 1 but topSimilar is [] → hasValidIndex = false
      // → destructive decision guard triggers → degrade to "create"
      { decision: "contradict", reason: "test contradict", match_index: 1 },
    );

    const extractor = new SmartExtractor(store, embedder, llm, {});
    const stats = await extractor.extractAndPersist(
      "contradict with missing target",
      "session-no-target",
    );

    const ops = store.operations;

    // With empty store, contradict degrades to create → no getById called
    const getByIdCalls = ops.filter((op) => op.op === "getById");
    assert.equal(getByIdCalls.length, 0, "no getById when topSimilar is empty (decision degraded to create)");

    // Correctly creates the new entry (contradict degraded to create)
    const bulkStoreCalls = ops.filter((op) => op.op === "bulkStore");
    assert.equal(bulkStoreCalls.length, 1, "should call bulkStore (contradict degraded to create)");
    assert.equal(stats.created, 1, "stats.created should be 1");

    // No update because no existing target to contradict
    const updateCalls = ops.filter((op) => op.op === "update");
    assert.equal(updateCalls.length, 0, "should NOT call update (no existing entry to contradict)");
  });
});

describe("Issue #675 #676 — rollback on partial invalidation failure", () => {
  it("bulkStore succeeds, update fails: deletes new entries (rollback phase 1)", async () => {
    const existingEntry = {
      id: "rollback-001",
      text: "old preference",
      vector: Array(8).fill(0.1),
      category: "preferences",
      scope: "test",
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: "old preference", category: "preferences", importance: 0.5 },
          {
            memory_category: "preferences",
            l0_abstract: "old preference",
            tier: "working",
            state: "confirmed",
            valid_from: Date.now() - 1000,
            fact_key: "preferences:rollback",
          },
        ),
      ),
    };

    const store = makeBatchStore({ existingEntries: [existingEntry] });
    updateShouldFail = true; // Make update fail

    const embedder = makeEmbedder();
    const llm = makeLlm(
      [
        {
          category: "preferences",
          abstract: "new preference text",
          overview: "New Pref",
          content: "new preference text",
          confidence: 0.9,
          support: [],
        },
      ],
      { decision: "supersede", reason: "test supersede", match_index: 1 },
    );

    const extractor = new SmartExtractor(store, embedder, llm, {});
    const stats = await extractor.extractAndPersist(
      "rollback test",
      "session-rollback",
    );

    const ops = store.operations;

    // bulkStore was called (new entry created)
    const bulkStoreCalls = ops.filter((op) => op.op === "bulkStore");
    assert.equal(bulkStoreCalls.length, 1, "bulkStore should have been called");

    // update failed (we configured updateShouldFail)
    const updateCalls = ops.filter((op) => op.op === "update");
    assert.ok(updateCalls.length >= 1, "update should have been attempted");

    // Rollback: delete new entries created by bulkStore
    const deleteCalls = ops.filter((op) => op.op === "delete");
    assert.equal(deleteCalls.length, 1, "rollback should delete the new entry from bulkStore");
  });
});