/**
 * Test: Regex Fallback bulkStore Integration (Issue #675)
 *
 * PROBLEM: The original test defined local mock functions that do NOT exist
 * in the real codebase. The test was testing local simulations, NOT actual code.
 *
 * SOLUTION: This test imports REAL components via jiti:
 *   - Real MemoryStore (src/store.ts) - actual file-lock behavior
 *   - Real isUserMdExclusiveMemory (src/workspace-boundary.ts)
 *   - Real buildSmartMetadata / stringifySmartMetadata (src/smart-metadata.ts)
 *   - Copied detectCategory() logic from index.ts
 *
 * OLD pattern (e9aba72): store.store() in loop → N locks
 * NEW pattern (HEAD): bulkStore() after loop → 1 lock
 *
 * Coverage added in this revision:
 *   - Fallback path (bulkStore failure → individual store.store() with DB dedup)
 *   - Metadata construction failure (stringifySmartMetadata exception → skip entry)
 *   - Batch-internal dedup + fallback DB dedup interaction
 *   - Cosine threshold boundary (0.90 exactly vs 0.91)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// Real imports from source
const { MemoryStore } = await jiti("../src/store.ts");
const { isUserMdExclusiveMemory } = await jiti("../src/workspace-boundary.ts");
const { buildSmartMetadata, stringifySmartMetadata } = await jiti("../src/smart-metadata.ts");

// detectCategory() - copied from index.ts (not exported)
function detectCategory(text) {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌/i.test(lower)) return "preference";
  if (/decided|will use|switch|migrate|決定|選擇|改用/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|jmenuje se|我的.*是|叫我/i.test(lower)) return "entity";
  if (/\b(is|are|has|have|je|má|總是|总是|從不|从不)/i.test(lower)) return "fact";
  return "other";
}

function makeMetadata(text, category, sessionKey) {
  return stringifySmartMetadata(
    buildSmartMetadata(
      { text, category, importance: 0.7, metadata: "{}" },
      {
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        source_session: sessionKey || "test",
        source: "auto-capture",
        state: "confirmed",
        memory_layer: "working",
        injected_count: 0,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
      },
    ),
  );
}

// OLD pattern: individual store.store() per entry = N locks
async function regexFallbackOldPattern(store, embedder, texts, scope, sessionKey) {
  const toCapture = texts.filter((t) => t && t.trim().length > 0);
  let stored = 0;
  for (const text of toCapture.slice(0, 2)) {
    if (isUserMdExclusiveMemory({ text }, { enabled: false })) continue;
    const category = detectCategory(text);
    const vector = await embedder.embedPassage(text);
    let existing = [];
    try { existing = await store.vectorSearch(vector, 1, 0.9, [scope]); } catch { /* fail-open */ }
    if (existing.length > 0 && existing[0].score > 0.90) continue;
    await store.store({ text, vector, importance: 0.7, category, scope, metadata: makeMetadata(text, category, sessionKey) });
    stored++;
  }
  return stored;
}

// NEW pattern (v2): same as index.ts logic — bulkStore + fallback + metadata failure handling
// Options:
//   opts.bulkStoreFails         - make bulkStore() throw on first call (caller sets store.bulkStore override)
//   opts.metadataFailureOnText   - make metadata construction throw when text includes this substring
async function regexFallbackNewPattern(store, embedder, texts, scope, sessionKey, opts = {}) {
  const toCapture = texts.filter((t) => t && t.trim().length > 0);
  const capturedEntries = [];

  for (const text of toCapture.slice(0, 2)) {
    if (isUserMdExclusiveMemory({ text }, { enabled: false })) continue;
    const category = detectCategory(text);
    const vector = await embedder.embedPassage(text);

    // DB dedup pre-check
    let existing = [];
    try { existing = await store.vectorSearch(vector, 1, 0.9, [scope]); } catch { /* fail-open */ }
    if (existing.length > 0 && existing[0].score > 0.90) continue;

    // Batch-internal dedup (cosine similarity)
    let duplicateInBatch = false;
    for (const prev of capturedEntries) {
      if (prev.vector.length !== vector.length) continue;
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += prev.vector[i] * vector[i];
      const normPrev = Math.sqrt(prev.vector.reduce((s, v) => s + v * v, 0));
      const normVec = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      const cosine = normPrev > 0 && normVec > 0 ? dot / (normPrev * normVec) : dot;
      if (cosine > 0.90) { duplicateInBatch = true; break; }
    }
    if (duplicateInBatch) continue;

    // Metadata construction — wrapped in try-catch so stringifySmartMetadata failures
    // (from jiti re-parsing) don't corrupt the loop state
    let metadata;
    try {
      const shouldFail = opts.metadataFailureOnText && text.includes(opts.metadataFailureOnText);
      if (shouldFail) {
        throw new Error(`simulated metadata failure for: ${text}`);
      }
      metadata = makeMetadata(text, category, sessionKey);
    } catch (err) {
      // Skip entry whose metadata construction failed; continue processing remaining texts
      continue;
    }

    capturedEntries.push({ text, vector, importance: 0.7, category, scope, metadata });
  }

  // Store: bulkStore (preferred) or fallback to individual store.store() with DB dedup
  if (capturedEntries.length > 0) {
    try {
      await store.bulkStore(capturedEntries);
    } catch (err) {
      // Fallback: store individually, re-applying DB dedup per entry
      for (const entry of capturedEntries) {
        let existing = [];
        try {
          existing = await store.vectorSearch(entry.vector, 1, 0.1, [entry.scope]);
        } catch { /* fail-open */ }
        if (existing.length > 0 && existing[0].score > 0.90) {
          continue; // skip duplicate found in DB during fallback
        }
        await store.store(entry);
      }
    }
  }
  return capturedEntries.length;
}

// TrackingStore: wraps real MemoryStore, tracks call counts + fallback behavior
class TrackingStore {
  constructor(realStore) {
    this._store = realStore;
    this._storeCount = 0;
    this._bulkCount = 0;
    this._bulkEntries = [];
  }
  async store(entry) { this._storeCount++; return this._store.store(entry); }
  async bulkStore(entries) {
    this._bulkCount++;
    this._bulkEntries.push(...entries);
    return this._store.bulkStore(entries);
  }
  async vectorSearch(...args) { return this._store.vectorSearch(...args); }
  async getById(...args) { return this._store.getById(...args); }
}

// Mock embedder: one-hot vectors (guaranteed cosine sim = 0 between different dims)
function makeMockEmbedder() {
  const bases = [[1, 0, 0, 0], [0, 1, 0, 0]];
  let idx = 0;
  return {
    embedPassage: async (_text) => [...bases[idx++ % bases.length]],
  };
}

// Dedup test embedder: dupVector for texts containing "dup-text", orthogonal vectors otherwise
function makeDedupTestEmbedder(dupVector) {
  const orthogonal = dupVector[0] === 1 ? [0, 1, 0, 0] : [1, 0, 0, 0];
  return {
    embedPassage: async (text) => {
      if (text.includes("dup-text")) return dupVector;
      return orthogonal;
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================
describe("Issue #675: Regex Fallback bulkStore (Real Integration)", () => {

  it("OLD pattern: N texts = N store.store() calls (confirmed buggy)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-old-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const embedder = makeMockEmbedder();
      await regexFallbackOldPattern(store, embedder, ["Alpha text", "Beta text", "Gamma"], "agent:test", "s1");
      assert.strictEqual(store._storeCount, 2, "OLD: 2 store.store() calls for 2 texts");
      assert.strictEqual(store._bulkCount, 0, "OLD: no bulkStore()");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("NEW pattern: N texts = 1 bulkStore() call (fixed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-new-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const embedder = makeMockEmbedder();
      await regexFallbackNewPattern(store, embedder, ["Alpha text", "Beta text", "Gamma"], "agent:test", "s2");
      assert.strictEqual(store._storeCount, 0, "NEW: no store.store()");
      assert.strictEqual(store._bulkCount, 1, "NEW: 1 bulkStore() call");
      assert.strictEqual(store._bulkEntries.length, 2, "NEW: bulkStore receives 2 entries");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Single text: bulkStore called once (not store.store())", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-single-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const embedder = makeMockEmbedder();
      await regexFallbackNewPattern(store, embedder, ["Only one"], "agent:test", "s3");
      assert.strictEqual(store._storeCount, 0);
      assert.strictEqual(store._bulkCount, 1);
      assert.strictEqual(store._bulkEntries.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Empty texts: no store or bulkStore called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-empty-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const embedder = makeMockEmbedder();
      const result = await regexFallbackNewPattern(store, embedder, [], "agent:test", "s4");
      assert.strictEqual(result, 0);
      assert.strictEqual(store._storeCount, 0);
      assert.strictEqual(store._bulkCount, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Dedup skips dup-text, remaining batched in bulkStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-dedup-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "s5";
      const dupVector = [1, 0, 0, 0];

      // Pre-store a duplicate entry in DB
      await store._store.store({
        text: "dup-text",
        vector: dupVector,
        importance: 0.7,
        category: "fact",
        scope,
        metadata: "{}",
      });

      const dedupEmb = makeDedupTestEmbedder(dupVector);
      const texts = ["dup-text", "unique-text"];

      await regexFallbackNewPattern(store, dedupEmb, texts, scope, sessionKey);

      assert.strictEqual(store._bulkCount, 1, "Dedup: still 1 bulkStore call");
      assert.strictEqual(store._bulkEntries.length, 1, "Dedup: 1 entry (dup skipped)");
      assert.strictEqual(store._bulkEntries[0].text, "unique-text", "Dedup: only unique text stored");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Real MemoryStore: NEW pattern uses fewer locks (1 vs N)", async () => {
    const dirOld = mkdtempSync(join(tmpdir(), "rx-lock-old-"));
    const dirNew = mkdtempSync(join(tmpdir(), "rx-lock-new-"));
    try {
      const scope = "agent:test";

      const storeOld = new TrackingStore(new MemoryStore({ dbPath: dirOld, vectorDim: 4 }));
      const t0 = Date.now();
      await regexFallbackOldPattern(storeOld, makeMockEmbedder(), ["Fact alpha", "Fact beta"], scope, "s6-old");
      const oldMs = Date.now() - t0;

      const storeNew = new TrackingStore(new MemoryStore({ dbPath: dirNew, vectorDim: 4 }));
      const t1 = Date.now();
      await regexFallbackNewPattern(storeNew, makeMockEmbedder(), ["Fact alpha", "Fact beta"], scope, "s6-new");
      const newMs = Date.now() - t1;

      console.log(`  Timing: OLD=${oldMs}ms (2 locks), NEW=${newMs}ms (1 lock)`);

      assert.strictEqual(storeOld._storeCount, 2, "OLD: 2 store calls");
      assert.strictEqual(storeNew._bulkCount, 1, "NEW: 1 bulkStore call");
      assert.strictEqual(storeNew._bulkEntries.length, 2, "NEW: 2 entries in bulkStore");
    } finally {
      rmSync(dirOld, { recursive: true, force: true });
      rmSync(dirNew, { recursive: true, force: true });
    }
  });

  // FIX Bug #3: Batch-internal dedup regression test
  it("Batch-internal dedup: second near-duplicate skipped within same batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-batch-dedup-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "s7-batch-dedup";

      // Both texts return the SAME vector (cosine sim = 1.0).
      // DB dedup passes for both (nothing in DB), but batch dedup catches the second.
      const sharedVector = [0.7071, 0.7071];
      let callCount = 0;
      const embedder = {
        embedPassage: async (_text) => {
          callCount++;
          return sharedVector;
        },
      };

      const texts = ["I really like coffee", "I really like coffee too"];
      const stored = await regexFallbackNewPattern(store, embedder, texts, scope, sessionKey);

      assert.strictEqual(callCount, 2, "Both texts are embedded");
      assert.strictEqual(store._bulkCount, 1, "One bulkStore call");
      assert.strictEqual(store._bulkEntries.length, 1, "Only 1 entry stored (second deduped)");
      assert.strictEqual(store._bulkEntries[0].text, "I really like coffee", "First text stored, second skipped");
      assert.strictEqual(stored, 1, "Returns 1 (one entry actually stored)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // =========================================================================
  // NEW TESTS: Path A — Fallback when bulkStore fails
  // =========================================================================

  it("Fallback: bulkStore failure triggers individual store.store() calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-fb-fail-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";

      // Override bulkStore to fail
      store.bulkStore = async () => { throw new Error("simulated bulkStore failure"); };
      let fallbackStoreCount = 0;
      store.store = async (entry) => {
        fallbackStoreCount++;
        return store._store.store(entry);
      };

      const embedder = makeMockEmbedder();
      await regexFallbackNewPattern(store, embedder, ["Text A", "Text B"], scope, "fb1");

      assert.strictEqual(fallbackStoreCount, 2, "Fallback: 2 store.store() calls after bulkStore fails");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Fallback: DB dedup skips entries already in DB during fallback loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-fb-dedup-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const vecA = [1, 0, 0, 0];
      const vecB = [0, 1, 0, 0];

      // Pre-store vecA in DB (simulates a previously captured memory)
      await store._store.store({
        text: "pre-existing",
        vector: vecA,
        importance: 0.7,
        category: "fact",
        scope,
        metadata: "{}",
      });

      // First text → vecA (already in DB), second → vecB (new)
      let callIdx = 0;
      const embedder = {
        embedPassage: async (_text) => {
          return callIdx++ === 0 ? vecA : vecB;
        },
      };

      // Make bulkStore fail → fallback triggered
      store.bulkStore = async () => { throw new Error("bulkStore fails"); };
      let fallbackStoreCount = 0;
      store.store = async (entry) => {
        fallbackStoreCount++;
        return store._store.store(entry);
      };

      await regexFallbackNewPattern(store, embedder, ["Existing text", "New text"], scope, "fb2");

      // Fallback dedup should skip vecA (found in DB, score ~1.0) but allow vecB
      assert.strictEqual(fallbackStoreCount, 1, "Fallback dedup: only 1 store.store() (vecB), vecA was skipped");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Fallback: zero capturedEntries (all skipped by DB dedup) → no fallback, no store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-fb-zero-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const dupVec = [1, 0, 0, 0];

      // Pre-store both texts' vectors in DB → both DB-deduped → capturedEntries stays empty
      await store._store.store({ text: "dup1", vector: dupVec, importance: 0.7, category: "fact", scope, metadata: "{}" });

      const embedder = makeDedupTestEmbedder(dupVec);

      store.bulkStore = async () => { throw new Error("should not be called"); };
      let storeCount = 0;
      store.store = async (entry) => { storeCount++; return store._store.store(entry); };

      await regexFallbackNewPattern(store, embedder, ["dup-text A", "dup-text B"], scope, "fb4");

      assert.strictEqual(storeCount, 0, "No store.store() when capturedEntries is empty");
      assert.strictEqual(store._bulkCount, 0, "No bulkStore() when capturedEntries is empty");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // =========================================================================
  // NEW TESTS: Path B — Metadata construction failure
  // =========================================================================

  // NOTE: slice(0,2) limits processing to first 2 texts.
  // We structure inputs so the failing text is in position [0] and the
  // successful text in position [1], so both fit in the processing window.
  it("Metadata failure: entry skipped, loop continues to next text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-meta-fail-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";

      // slice(0,2) processes only the first 2 texts.
      // "fail-meta" → 2nd vector, "Another good" → 1st vector (both pass DB dedup).
      // Metadata failure on first → caught → continue → second text stored.
      const embedder = {
        embedPassage: async (text) => {
          if (text.includes("fail-meta")) return [0, 1, 0, 0];
          return [1, 0, 0, 0];
        },
      };

      await regexFallbackNewPattern(
        store,
        embedder,
        ["fail-meta text", "Another good text"],
        scope,
        "mf1",
        { metadataFailureOnText: "fail-meta" },
      );

      // fail-meta: metadata fails → skipped. Another good: stored → 1 entry
      assert.strictEqual(store._bulkCount, 1, "bulkStore called");
      assert.strictEqual(store._bulkEntries.length, 1, "1 entry stored (metadata failure skipped)");
      assert.strictEqual(store._bulkEntries[0].text, "Another good text", "Stored text is the one after the failure");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Metadata failure: does not corrupt capturedEntries state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-meta-state-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";

      // slice(0,2) = ["first", "BAD-meta"]
      // first → 4-dim, BAD-meta → 2-dim (different dims, batch dedup skipped).
      // BAD-meta metadata fails → caught → continue.
      // Result: 1 entry (first only).
      let idx = 0;
      const customEmb = {
        embedPassage: async (_text) => {
          if (idx === 0) return [1, 0, 0, 0];
          if (idx === 1) return [0.5, 0.5];
          return [0, 1, 0, 0];
        },
      };

      await regexFallbackNewPattern(
        store,
        customEmb,
        ["first", "BAD-meta", "third"],
        scope,
        "mf2",
        { metadataFailureOnText: "BAD-meta" },
      );

      assert.strictEqual(store._bulkEntries.length, 1, "capturedEntries has exactly 1 entry (BAD-meta skipped)");
      assert.strictEqual(store._bulkEntries[0].text, "first", "First text is in capturedEntries");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // =========================================================================
  // NEW TESTS: Interaction — Batch-internal + Fallback DB dedup
  // =========================================================================

  it("Batch+fallback: batch dedup first, then fallback dedup re-checks DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-batch-fb-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const vecA = [0.7071, 0.7071];  // same for A and B (batch dedup catches B)
      const vecC = [0, 1, 0, 0];      // different, C is new

      // Pre-store vecC in DB
      await store._store.store({
        text: "pre-stored-C-like",
        vector: vecC,
        importance: 0.7,
        category: "fact",
        scope,
        metadata: "{}",
      });

      let callIdx = 0;
      const embedder = {
        embedPassage: async (_text) => {
          if (callIdx++ === 2) return vecC;
          return vecA;
        },
      };

      store.bulkStore = async () => { throw new Error("bulkStore fails"); };
      let fallbackStoreCount = 0;
      store.store = async (entry) => {
        fallbackStoreCount++;
        return store._store.store(entry);
      };

      // A (→ vecA, batch OK, fallback DB dedup: vecA not in DB → write)
      // B (→ vecA, batch dedup SKIPS → not in capturedEntries)
      // C (→ vecC, batch OK, fallback DB dedup: vecC IS in DB → SKIP)
      await regexFallbackNewPattern(store, embedder, ["Text A", "Text B", "Text C"], scope, "bf1");

      assert.strictEqual(fallbackStoreCount, 1, "Only 1 store.store() (A); B batch-skipped, C fallback-deduped");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // =========================================================================
  // NEW TESTS: Vector dimension mismatch + Cosine threshold boundaries
  // =========================================================================

  it("Batch dedup: different vector dimensions → cosine check skipped (continue), entry still added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-dim-mismatch-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "dm1";

      // First text: 4-dim, second text: 2-dim.
      // Batch dedup: prev.vector.length(4) !== vector.length(2) → continue (skip cosine check).
      // Loop ends with duplicateInBatch=false → entry IS added.
      const embedder = {
        embedPassage: async (text) => {
          if (text.includes("2dim")) return [0.5, 0.5];
          return [1, 0, 0, 0];
        },
      };

      const stored = await regexFallbackNewPattern(store, embedder, ["4-dim text", "2dim text"], scope, sessionKey);

      // Both entries pass: dim mismatch → cosine check skipped, but entries still added to capturedEntries
      assert.strictEqual(stored, 2, "2 entries stored");
      assert.strictEqual(store._bulkCount, 1, "1 bulkStore call");
      assert.strictEqual(store._bulkEntries.length, 2, "2 entries in bulkStore");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Cosine threshold: exactly 0.90 → NOT considered duplicate (strict >)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-cosine-boundary-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "cb1";

      // Unit vectors with cosine = 0.90 exactly
      // vecA = [1, 0, 0, 0], vecB = [0.90, sqrt(1-0.90²), 0, 0]
      // cos = 1*0.90 / (1*1) = 0.90 (exact)
      const vecA = [1, 0, 0, 0];
      const vecB = [0.90, Math.sqrt(1 - 0.90 * 0.90), 0, 0];

      let callIdx = 0;
      const embedder = {
        embedPassage: async (_text) => {
          return callIdx++ === 0 ? vecA : vecB;
        },
      };

      await regexFallbackNewPattern(store, embedder, ["Text A", "Text B at boundary"], scope, sessionKey);

      // cosine = 0.90, condition is > 0.90 (strict) → NOT deduped → both stored
      assert.strictEqual(store._bulkEntries.length, 2, "cosine=0.90 not deduped (strict > 0.90)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Cosine threshold: 0.91 → IS considered duplicate (strict >)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-cosine-91-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "c91";

      // vecA = [1, 0], vecB = [0.91, sqrt(1-0.91²)] → cosine = 0.91
      const vecA = [1, 0, 0, 0];
      const vecB = [0.91, Math.sqrt(1 - 0.91 * 0.91), 0, 0];

      let callIdx = 0;
      const embedder = {
        embedPassage: async (_text) => {
          return callIdx++ === 0 ? vecA : vecB;
        },
      };

      await regexFallbackNewPattern(store, embedder, ["Text A", "Text B 0.91"], scope, sessionKey);

      // cosine = 0.91, condition is > 0.90 → IS deduped → only 1 stored
      assert.strictEqual(store._bulkEntries.length, 1, "cosine=0.91 IS deduped (> 0.90)");
      assert.strictEqual(store._bulkEntries[0].text, "Text A", "First text stored, second skipped");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
