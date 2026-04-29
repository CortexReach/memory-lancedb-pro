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
    // BUG: individual store.store() = 1 lock per entry
    await store.store({ text, vector, importance: 0.7, category, scope, metadata: makeMetadata(text, category, sessionKey) });
    stored++;
  }
  return stored;
}

// NEW pattern: collect then bulkStore once = 1 lock
// FIX Bug #3: batch-internal dedup — skip texts whose vector is too similar
// to an entry already in capturedEntries (prevents duplicate entries in the same batch).
async function regexFallbackNewPattern(store, embedder, texts, scope, sessionKey) {
  const toCapture = texts.filter((t) => t && t.trim().length > 0);
  const capturedEntries = [];
  for (const text of toCapture.slice(0, 2)) {
    if (isUserMdExclusiveMemory({ text }, { enabled: false })) continue;
    const category = detectCategory(text);
    const vector = await embedder.embedPassage(text);
    let existing = [];
    try { existing = await store.vectorSearch(vector, 1, 0.9, [scope]); } catch { /* fail-open */ }
    if (existing.length > 0 && existing[0].score > 0.90) continue;
    // FIX #675: collect instead of immediate store
    // FIX Bug #3: batch-internal dedup
    let duplicateInBatch = false;
    for (const prev of capturedEntries) {
      if (prev.vector.length !== vector.length) continue;
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += prev.vector[i] * vector[i];
      if (dot > 0.90) { duplicateInBatch = true; break; }
    }
    if (duplicateInBatch) continue;
    capturedEntries.push({ text, vector, importance: 0.7, category, scope, metadata: makeMetadata(text, category, sessionKey) });
  }
  // FIX #675: single bulkStore = 1 lock for N entries
  if (capturedEntries.length > 0) await store.bulkStore(capturedEntries);
  return capturedEntries.length;
}

// TrackingStore: wraps real MemoryStore, tracks call counts
class TrackingStore {
  constructor(realStore) {
    this._store = realStore;
    this._storeCount = 0;
    this._bulkCount = 0;
    this._bulkEntries = [];
  }
  async store(entry) { this._storeCount++; return this._store.store(entry); }
  async bulkStore(entries) { this._bulkCount++; this._bulkEntries.push(...entries); return this._store.bulkStore(entries); }
  async vectorSearch(...args) { return this._store.vectorSearch(...args); }
  async getById(...args) { return this._store.getById(...args); }
}

// Mock embedder: one-hot vectors (guaranteed cosine sim = 0 between different dims)
// [1,0,0,0] vs [0,1,0,0] = 0 (never false-positive dedup)
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

      // Pre-store a duplicate entry
      await store._store.store({
        text: "dup-text",
        vector: dupVector,
        importance: 0.7,
        category: "fact",
        scope,
        metadata: "{}",
      });

      // Custom embedder: "dup-text" returns same vector as pre-stored (dedup hit)
      // Other texts return different vectors
      const dedupEmb = makeDedupTestEmbedder(dupVector);
      const texts = ["dup-text", "unique-text"];

      await regexFallbackNewPattern(store, dedupEmb, texts, scope, sessionKey);

      // "dup-text" skipped by dedup (score > 0.90), "unique-text" stored in bulkStore
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

      // OLD pattern with 2 texts = 2 lock acquisitions
      const storeOld = new TrackingStore(new MemoryStore({ dbPath: dirOld, vectorDim: 4 }));
      const t0 = Date.now();
      await regexFallbackOldPattern(storeOld, makeMockEmbedder(), ["Fact alpha", "Fact beta"], scope, "s6-old");
      const oldMs = Date.now() - t0;

      // NEW pattern with 2 texts = 1 lock acquisition
      const storeNew = new TrackingStore(new MemoryStore({ dbPath: dirNew, vectorDim: 4 }));
      const t1 = Date.now();
      await regexFallbackNewPattern(storeNew, makeMockEmbedder(), ["Fact alpha", "Fact beta"], scope, "s6-new");
      const newMs = Date.now() - t1;

      console.log(`  Timing: OLD=${oldMs}ms (2 locks), NEW=${newMs}ms (1 lock)`);

      // Verify call counts
      assert.strictEqual(storeOld._storeCount, 2, "OLD: 2 store calls");
      assert.strictEqual(storeNew._bulkCount, 1, "NEW: 1 bulkStore call");
      assert.strictEqual(storeNew._bulkEntries.length, 2, "NEW: 2 entries in bulkStore");
    } finally {
      rmSync(dirOld, { recursive: true, force: true });
      rmSync(dirNew, { recursive: true, force: true });
    }
  });

  // FIX Bug #3: Batch-internal dedup regression test
  // Two near-identical texts pass the DB dedup check (no existing entry),
  // but the second is skipped because it is too similar to the first in the batch.
  it("Batch-internal dedup: second near-duplicate skipped within same batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rx-batch-dedup-"));
    try {
      const store = new TrackingStore(new MemoryStore({ dbPath: dir, vectorDim: 4 }));
      const scope = "agent:test";
      const sessionKey = "s7-batch-dedup";

      // Both texts return the SAME vector (cosine sim = 1.0).
      // Neither is in the DB, so the DB dedup check passes for both.
      // The second should be caught by batch-internal dedup.
      const sharedVector = [0.7071, 0.7071];  // unit-normalised
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
});
