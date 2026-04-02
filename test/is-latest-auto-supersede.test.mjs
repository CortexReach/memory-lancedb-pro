/**
 * Test: auto-supersede on memory_store for similar-but-different memories.
 *
 * When a new memory has vector similarity 0.95-0.98 with an existing memory,
 * same storage-layer category, and the category is in the SUPERSEDE_ELIGIBLE
 * set, the old memory should be auto-superseded (invalidated_at + superseded_by)
 * and the new memory stored with a supersedes link.
 *
 * Events and decisions are NOT eligible for auto-supersede.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  isMemoryActiveAt,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

const VECTOR_DIM = 8;

/**
 * Create a vector that, when compared to another vector made with a nearby
 * seed, produces cosine similarity in the 0.95-0.98 range.
 *
 * Strategy: base vector is a uniform unit vector. We perturb one component
 * by a small amount controlled by the seed to get vectors with high but
 * not identical similarity.
 */
function makeBaseVector() {
  const v = new Array(VECTOR_DIM).fill(1 / Math.sqrt(VECTOR_DIM));
  return v;
}

function perturbVector(base, perturbIndex, perturbAmount) {
  const v = [...base];
  v[perturbIndex] += perturbAmount;
  // Re-normalize to unit vector
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Simulate the memory_store auto-supersede logic from tools.ts.
 * This mirrors the actual code path without requiring the full MCP tool SDK.
 */
async function simulateMemoryStore(store, text, vector, importance, category, targetScope) {
  const SUPERSEDE_ELIGIBLE = new Set(["preference", "fact", "entity", "other"]);

  // Check for duplicates / supersede candidates
  let existing = [];
  try {
    existing = await store.vectorSearch(vector, 3, 0.1, [targetScope], { excludeInactive: true });
  } catch {
    // fail-open
  }

  // Exact duplicate check
  if (existing.length > 0 && existing[0].score > 0.98) {
    return {
      action: "duplicate",
      existingId: existing[0].entry.id,
    };
  }

  // Auto-supersede check
  const supersedeCandidate = existing.find(
    (r) =>
      r.score > 0.95 &&
      r.score <= 0.98 &&
      r.entry.category === category &&
      SUPERSEDE_ELIGIBLE.has(r.entry.category),
  );

  if (supersedeCandidate) {
    const oldEntry = supersedeCandidate.entry;
    const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
    const now = Date.now();
    const factKey = oldMeta.fact_key ?? deriveFactKey(oldMeta.memory_category, text);

    const newMeta = buildSmartMetadata(
      { text, category, importance },
      {
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        source: "manual",
        state: "confirmed",
        memory_layer: "durable",
        last_confirmed_use_at: now,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
        valid_from: now,
        fact_key: factKey,
        supersedes: oldEntry.id,
        relations: appendRelation([], {
          type: "supersedes",
          targetId: oldEntry.id,
        }),
      },
    );

    const newEntry = await store.store({
      text,
      vector,
      importance,
      category,
      scope: targetScope,
      metadata: stringifySmartMetadata(newMeta),
    });

    // Invalidate old record via patchMetadata
    try {
      await store.patchMetadata(
        oldEntry.id,
        {
          fact_key: factKey,
          invalidated_at: now,
          superseded_by: newEntry.id,
          relations: appendRelation(oldMeta.relations, {
            type: "superseded_by",
            targetId: newEntry.id,
          }),
        },
        [targetScope],
      );
    } catch {
      // new record is source of truth; continue
    }

    return {
      action: "superseded",
      id: newEntry.id,
      supersededId: oldEntry.id,
      similarity: supersedeCandidate.score,
    };
  }

  // Normal store
  const entry = await store.store({
    text,
    vector,
    importance,
    category,
    scope: targetScope,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category, importance },
        {
          l0_abstract: text,
          l1_overview: `- ${text}`,
          l2_content: text,
          source: "manual",
          state: "confirmed",
          memory_layer: "durable",
          last_confirmed_use_at: Date.now(),
          bad_recall_count: 0,
          suppressed_until_turn: 0,
        },
      ),
    ),
  });

  return { action: "created", id: entry.id };
}

async function runTests() {
  const workDir = mkdtempSync(path.join(tmpdir(), "is-latest-auto-supersede-"));
  const dbPath = path.join(workDir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });
  const scope = "test";

  try {
    // Calibrate vectors: find a perturbation that yields similarity in (0.95, 0.98)
    const base = makeBaseVector();
    // Try perturbations to find one yielding similarity in range
    let goodPerturbAmount = null;
    for (let p = 0.01; p < 0.5; p += 0.005) {
      const v = perturbVector(base, 0, p);
      const sim = cosineSimilarity(base, v);
      if (sim > 0.95 && sim < 0.98) {
        goodPerturbAmount = p;
        break;
      }
    }
    assert.ok(goodPerturbAmount !== null, "should find a perturbation yielding similarity in (0.95, 0.98)");

    const vec1 = base;
    const vec2 = perturbVector(base, 0, goodPerturbAmount);
    const calibratedSim = cosineSimilarity(vec1, vec2);
    console.log(`  Calibrated similarity: ${calibratedSim.toFixed(4)} (target: 0.95-0.98)`);
    assert.ok(calibratedSim > 0.95 && calibratedSim < 0.98, `calibrated similarity ${calibratedSim} should be in (0.95, 0.98)`);

    // ====================================================================
    // Test 1: Similar preference memories trigger auto-supersede
    // ====================================================================
    console.log("Test 1: similar preference memories trigger auto-supersede...");

    const oldText = "My favorite language is Python";
    const oldResult = await simulateMemoryStore(store, oldText, vec1, 0.7, "preference", scope);
    assert.equal(oldResult.action, "created", "first store should create");

    const newText = "My favorite language is Rust";
    const newResult = await simulateMemoryStore(store, newText, vec2, 0.7, "preference", scope);
    assert.equal(newResult.action, "superseded", "second store should supersede");
    assert.ok(newResult.supersededId, "should have supersededId");
    assert.equal(newResult.supersededId, oldResult.id, "should reference old record");
    assert.ok(newResult.similarity > 0.95 && newResult.similarity <= 0.98, "similarity should be in range");

    console.log("  ✅ similar preference auto-superseded");

    // ====================================================================
    // Test 2: Old memory metadata has invalidated_at and superseded_by
    // ====================================================================
    console.log("\nTest 2: old memory metadata has invalidated_at and superseded_by...");

    const oldEntry = await store.getById(oldResult.id, [scope]);
    assert.ok(oldEntry, "old entry should still exist in store");
    const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
    assert.ok(oldMeta.invalidated_at, "old entry should have invalidated_at");
    assert.equal(oldMeta.superseded_by, newResult.id, "old entry superseded_by should point to new");
    assert.equal(isMemoryActiveAt(oldMeta), false, "old entry should be inactive");

    console.log("  ✅ old memory correctly invalidated");

    // ====================================================================
    // Test 3: New memory metadata has supersedes field
    // ====================================================================
    console.log("\nTest 3: new memory metadata has supersedes field...");

    const newEntry = await store.getById(newResult.id, [scope]);
    assert.ok(newEntry, "new entry should exist");
    const newMeta = parseSmartMetadata(newEntry.metadata, newEntry);
    assert.equal(newMeta.supersedes, oldResult.id, "new entry should have supersedes pointing to old");
    assert.equal(isMemoryActiveAt(newMeta), true, "new entry should be active");

    console.log("  ✅ new memory has supersedes link");

    // ====================================================================
    // Test 4: Retrieval with excludeInactive only returns the new memory
    // ====================================================================
    console.log("\nTest 4: retrieval only returns the new (active) memory...");

    const searchResults = await store.vectorSearch(vec1, 5, 0.1, [scope], { excludeInactive: true });
    const ids = searchResults.map((r) => r.entry.id);
    assert.ok(ids.includes(newResult.id), "active search should include new memory");
    assert.ok(!ids.includes(oldResult.id), "active search should exclude superseded memory");

    console.log("  ✅ retrieval filters out superseded memory");

    // ====================================================================
    // Test 5: Decision category is NOT auto-superseded even if similar
    // ====================================================================
    console.log("\nTest 5: decision category is NOT auto-superseded...");

    // Use a very different vector space for decisions to avoid interfering with preference vectors
    const decBase = makeBaseVector().map((v, i) => (i === 0 ? -v : v));
    const decNorm = Math.sqrt(decBase.reduce((s, x) => s + x * x, 0));
    const decVec1 = decBase.map((x) => x / decNorm);
    const decVec2 = perturbVector(decVec1, 1, goodPerturbAmount);
    const decSim = cosineSimilarity(decVec1, decVec2);
    // Ensure these also fall in the right range
    assert.ok(decSim > 0.94, `decision vectors similarity ${decSim} should be > 0.94`);

    const dec1 = await simulateMemoryStore(
      store, "Decided to use PostgreSQL for the project", decVec1, 0.8, "decision", scope,
    );
    assert.equal(dec1.action, "created", "first decision should create");

    const dec2 = await simulateMemoryStore(
      store, "Decided to use MySQL for the project", decVec2, 0.8, "decision", scope,
    );
    assert.equal(dec2.action, "created", "second decision should also create (not supersede)");

    // Both should be active
    const dec1Entry = await store.getById(dec1.id, [scope]);
    const dec1Meta = parseSmartMetadata(dec1Entry.metadata, dec1Entry);
    assert.equal(isMemoryActiveAt(dec1Meta), true, "first decision should remain active");
    assert.ok(!dec1Meta.invalidated_at, "first decision should NOT have invalidated_at");

    console.log("  ✅ decisions are not auto-superseded");

    // ====================================================================
    // Test 6: Reflection category is NOT auto-superseded even if similar
    // ====================================================================
    console.log("\nTest 6: reflection category is NOT auto-superseded...");

    const refBase = makeBaseVector().map((v, i) => (i === 1 ? -v : v));
    const refNorm = Math.sqrt(refBase.reduce((s, x) => s + x * x, 0));
    const refVec1 = refBase.map((x) => x / refNorm);
    const refVec2 = perturbVector(refVec1, 2, goodPerturbAmount);

    const ref1 = await simulateMemoryStore(
      store, "Reflection: code reviews improve quality significantly", refVec1, 0.6, "reflection", scope,
    );
    assert.equal(ref1.action, "created", "first reflection should create");

    const ref2 = await simulateMemoryStore(
      store, "Reflection: code reviews improve quality and team morale", refVec2, 0.6, "reflection", scope,
    );
    assert.equal(ref2.action, "created", "second reflection should also create (not supersede)");

    const ref1Entry = await store.getById(ref1.id, [scope]);
    const ref1Meta = parseSmartMetadata(ref1Entry.metadata, ref1Entry);
    assert.equal(isMemoryActiveAt(ref1Meta), true, "first reflection should remain active");

    console.log("  ✅ reflections are not auto-superseded");

    // ====================================================================
    // Test 7: Fact category eligible for auto-supersede
    // ====================================================================
    console.log("\nTest 7: fact category is eligible for auto-supersede...");

    const factBase = makeBaseVector().map((v, i) => (i === 2 ? -v : v));
    const factNorm = Math.sqrt(factBase.reduce((s, x) => s + x * x, 0));
    const factVec1 = factBase.map((x) => x / factNorm);
    const factVec2 = perturbVector(factVec1, 3, goodPerturbAmount);
    const factSim = cosineSimilarity(factVec1, factVec2);
    assert.ok(factSim > 0.95 && factSim < 0.98, `fact vectors similarity ${factSim} should be in (0.95, 0.98)`);

    const fact1 = await simulateMemoryStore(
      store, "User's timezone is UTC+8", factVec1, 0.7, "fact", scope,
    );
    assert.equal(fact1.action, "created", "first fact should create");

    const fact2 = await simulateMemoryStore(
      store, "User's timezone is UTC+9", factVec2, 0.7, "fact", scope,
    );
    assert.equal(fact2.action, "superseded", "second fact should supersede");
    assert.equal(fact2.supersededId, fact1.id, "should supersede the first fact");

    console.log("  ✅ facts are eligible for auto-supersede");

    // ====================================================================
    // Test 8: Different categories do NOT trigger cross-category supersede
    // ====================================================================
    console.log("\nTest 8: different categories do not trigger cross-category supersede...");

    const crossBase = makeBaseVector().map((v, i) => (i === 3 ? -v : v));
    const crossNorm = Math.sqrt(crossBase.reduce((s, x) => s + x * x, 0));
    const crossVec1 = crossBase.map((x) => x / crossNorm);
    const crossVec2 = perturbVector(crossVec1, 4, goodPerturbAmount);

    const cross1 = await simulateMemoryStore(
      store, "Project uses TypeScript for backend", crossVec1, 0.7, "fact", scope,
    );
    assert.equal(cross1.action, "created");

    const cross2 = await simulateMemoryStore(
      store, "Prefers TypeScript for backend development", crossVec2, 0.7, "preference", scope,
    );
    assert.equal(cross2.action, "created", "different category should create, not supersede");

    console.log("  ✅ cross-category similarities do not trigger supersede");

    console.log("\n✅ All is-latest auto-supersede tests passed!");
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
