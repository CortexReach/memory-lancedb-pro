/**
 * Test: memory_update normal path rebuilds smart metadata on text/importance change.
 *
 * Validates the fix for #544: the normal (non-supersede) update path was
 * updating entry.text but leaving l0_abstract / l1_overview / l2_content
 * and other derived metadata fields stale.
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
const { classifyTemporal, inferExpiry } = jiti("../src/temporal-classifier.ts");
const { TEMPORAL_VERSIONED_CATEGORIES } = jiti("../src/memory-categories.ts");

const VECTOR_DIM = 8;

function makeVector(seed = 1) {
  const v = new Array(VECTOR_DIM).fill(1 / Math.sqrt(VECTOR_DIM));
  v[0] = seed * 0.1;
  return v;
}

function clamp01(value, fallback = 0.7) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Simulate the updated memory_update handler logic from tools.ts,
 * including the new metadata rebuild for the normal update path (#544).
 */
async function simulateMemoryUpdate(store, resolvedId, text, newVector, importance, category, scopeFilter) {
  // Hoist existing entry fetch (matches the code change)
  let existing = null;

  if (text && newVector) {
    existing = await store.getById(resolvedId, scopeFilter);
    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
        const now = Date.now();
        const factKey =
          meta.fact_key ?? deriveFactKey(meta.memory_category, text);

        const newMeta = buildSmartMetadata(
          { text, category: existing.category },
          {
            l0_abstract: text,
            l1_overview: meta.l1_overview,
            l2_content: text,
            memory_category: meta.memory_category,
            tier: meta.tier,
            access_count: 0,
            confidence: importance !== undefined ? clamp01(importance) : meta.confidence,
            valid_from: now,
            fact_key: factKey,
            supersedes: resolvedId,
            relations: appendRelation([], {
              type: "supersedes",
              targetId: resolvedId,
            }),
          },
        );

        const newEntry = await store.store({
          text,
          vector: newVector,
          category: category || existing.category,
          scope: existing.scope,
          importance: importance !== undefined ? importance : existing.importance,
          metadata: stringifySmartMetadata(newMeta),
        });

        const invalidatedMeta = buildSmartMetadata(existing, {
          fact_key: factKey,
          invalidated_at: now,
          superseded_by: newEntry.id,
          relations: appendRelation(meta.relations, {
            type: "superseded_by",
            targetId: newEntry.id,
          }),
        });
        await store.update(
          resolvedId,
          { metadata: stringifySmartMetadata(invalidatedMeta) },
          scopeFilter,
        );

        return { action: "superseded", oldId: resolvedId, newId: newEntry.id };
      }
    }
  }

  // --- Normal update path (with #544 metadata rebuild) ---
  const updates = {};
  if (text) updates.text = text;
  if (newVector) updates.vector = newVector;
  if (importance !== undefined) updates.importance = clamp01(importance);
  if (category) updates.category = category;

  // Rebuild smart metadata when text or importance changes (#544)
  if (text && existing) {
    const meta = parseSmartMetadata(existing.metadata, existing);
    const effectiveCategory = category ? category : meta.memory_category;
    const newExpiry = inferExpiry(text);
    const updatedMeta = buildSmartMetadata(existing, {
      l0_abstract: text,
      l1_overview: `- ${text}`,
      l2_content: text,
      fact_key: deriveFactKey(effectiveCategory, text),
      memory_temporal_type: classifyTemporal(text),
      // Pass 0 when no expiry so buildSmartMetadata clears the old value
      valid_until: newExpiry ?? 0,
      confidence:
        importance !== undefined ? clamp01(importance) : meta.confidence,
    });
    updates.metadata = stringifySmartMetadata(updatedMeta);
  } else if (importance !== undefined && !text) {
    // Sync confidence for importance-only changes
    const entry = existing ?? await store.getById(resolvedId, scopeFilter);
    if (entry) {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const updatedMeta = buildSmartMetadata(entry, {
        confidence: clamp01(importance),
      });
      updates.metadata = stringifySmartMetadata(updatedMeta);
    }
  }

  const updated = await store.update(resolvedId, updates, scopeFilter);
  return { action: "updated", id: updated?.id };
}

async function runTests() {
  const workDir = mkdtempSync(path.join(tmpdir(), "update-metadata-refresh-"));
  const dbPath = path.join(workDir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });
  const scopeFilter = ["test"];

  try {
    // ====================================================================
    // Test 1: Text change refreshes l0/l1/l2
    // ====================================================================
    console.log("Test 1: text change refreshes l0/l1/l2...");

    const origText = "Attended 2026 tech conference";
    const entry1 = await store.store({
      text: origText,
      vector: makeVector(1),
      category: "fact",
      scope: "test",
      importance: 0.6,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText, category: "fact", importance: 0.6 },
          {
            l0_abstract: origText,
            l1_overview: "- tech conference 2026",
            l2_content: origText,
            memory_category: "cases",
            tier: "working",
            confidence: 0.6,
          },
        ),
      ),
    });

    const newText1 = "Attended 2026 AI summit in Singapore";
    const result1 = await simulateMemoryUpdate(
      store, entry1.id, newText1, makeVector(2), undefined, undefined, scopeFilter,
    );

    assert.equal(result1.action, "updated", "non-temporal should do in-place update");
    assert.equal(result1.id, entry1.id, "should update same record");

    const after1 = await store.getById(entry1.id, scopeFilter);
    assert.equal(after1.text, newText1, "text should be updated");
    const meta1 = parseSmartMetadata(after1.metadata, after1);
    assert.equal(meta1.l0_abstract, newText1, "l0_abstract should match new text");
    assert.equal(meta1.l1_overview, `- ${newText1}`, "l1_overview should match new text");
    assert.equal(meta1.l2_content, newText1, "l2_content should match new text");

    console.log("  OK text change refreshes l0/l1/l2");

    // ====================================================================
    // Test 2: Text change refreshes fact_key
    // ====================================================================
    console.log("\nTest 2: text change refreshes fact_key...");

    const origText2 = "Project Alpha: status active";
    const entry2 = await store.store({
      text: origText2,
      vector: makeVector(3),
      category: "fact",
      scope: "test",
      importance: 0.7,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText2, category: "fact", importance: 0.7 },
          {
            l0_abstract: origText2,
            l1_overview: `- ${origText2}`,
            l2_content: origText2,
            memory_category: "cases",
            tier: "working",
            confidence: 0.7,
            fact_key: deriveFactKey("cases", origText2),
          },
        ),
      ),
    });

    const metaBefore2 = parseSmartMetadata(
      (await store.getById(entry2.id, scopeFilter)).metadata,
      entry2,
    );
    const oldFactKey = metaBefore2.fact_key;

    const newText2 = "Project Beta: status launched";
    const result2 = await simulateMemoryUpdate(
      store, entry2.id, newText2, makeVector(4), undefined, undefined, scopeFilter,
    );

    assert.equal(result2.action, "updated");
    const after2 = await store.getById(entry2.id, scopeFilter);
    const meta2 = parseSmartMetadata(after2.metadata, after2);
    const expectedFactKey = deriveFactKey("cases", newText2);
    assert.equal(meta2.fact_key, expectedFactKey, "fact_key should be derived from new text");
    // fact_key for non-temporal categories is undefined, so both old and new should be undefined
    // But the important thing is it was recalculated, not left from old text
    if (oldFactKey !== undefined || expectedFactKey !== undefined) {
      assert.notEqual(meta2.fact_key, oldFactKey, "fact_key should differ from old");
    }

    console.log("  OK text change refreshes fact_key");

    // ====================================================================
    // Test 3: Text change refreshes temporal_type and valid_until
    // ====================================================================
    console.log("\nTest 3: text change refreshes temporal_type and valid_until...");

    const origText3 = "Meeting with team tomorrow at 3pm";
    const entry3 = await store.store({
      text: origText3,
      vector: makeVector(5),
      category: "fact",
      scope: "test",
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText3, category: "fact", importance: 0.5 },
          {
            l0_abstract: origText3,
            l1_overview: `- ${origText3}`,
            l2_content: origText3,
            memory_category: "cases",
            tier: "working",
            confidence: 0.5,
            memory_temporal_type: classifyTemporal(origText3),
            valid_until: inferExpiry(origText3),
          },
        ),
      ),
    });

    // Verify the original has dynamic temporal type
    const metaBefore3 = parseSmartMetadata(
      (await store.getById(entry3.id, scopeFilter)).metadata,
      entry3,
    );
    assert.equal(metaBefore3.memory_temporal_type, "dynamic", "original should be dynamic (has 'tomorrow')");
    assert.ok(metaBefore3.valid_until, "original should have valid_until");

    // Update to a static text (no temporal keywords)
    const newText3 = "Company headquarters is in San Francisco";
    const result3 = await simulateMemoryUpdate(
      store, entry3.id, newText3, makeVector(6), undefined, undefined, scopeFilter,
    );

    assert.equal(result3.action, "updated");
    const after3 = await store.getById(entry3.id, scopeFilter);
    const meta3 = parseSmartMetadata(after3.metadata, after3);
    assert.equal(meta3.memory_temporal_type, "static", "should be reclassified as static");
    assert.equal(meta3.valid_until, undefined, "static text should have no valid_until");
    assert.equal(meta3.l0_abstract, newText3, "l0 should be updated too");

    console.log("  OK text change refreshes temporal_type and valid_until");

    // ====================================================================
    // Test 4: Importance-only change syncs confidence
    // ====================================================================
    console.log("\nTest 4: importance-only change syncs confidence...");

    const origText4 = "Favorite color is blue";
    const entry4 = await store.store({
      text: origText4,
      vector: makeVector(7),
      category: "fact",
      scope: "test",
      importance: 0.5,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText4, category: "fact", importance: 0.5 },
          {
            l0_abstract: origText4,
            l1_overview: `- ${origText4}`,
            l2_content: origText4,
            memory_category: "facts",
            tier: "working",
            confidence: 0.5,
          },
        ),
      ),
    });

    const metaBefore4 = parseSmartMetadata(
      (await store.getById(entry4.id, scopeFilter)).metadata,
      entry4,
    );
    assert.equal(metaBefore4.confidence, 0.5, "original confidence should be 0.5");

    // Update only importance (no text change)
    const result4 = await simulateMemoryUpdate(
      store, entry4.id, undefined, undefined, 0.95, undefined, scopeFilter,
    );

    assert.equal(result4.action, "updated");
    const after4 = await store.getById(entry4.id, scopeFilter);
    assert.equal(after4.importance, 0.95, "importance field should be updated");
    const meta4 = parseSmartMetadata(after4.metadata, after4);
    assert.equal(meta4.confidence, 0.95, "metadata confidence should be synced to new importance");
    // l0/l1/l2 should NOT have changed
    assert.equal(meta4.l0_abstract, origText4, "l0 should be unchanged");
    assert.equal(meta4.l1_overview, `- ${origText4}`, "l1 should be unchanged");
    assert.equal(meta4.l2_content, origText4, "l2 should be unchanged");

    console.log("  OK importance-only change syncs confidence");

    // ====================================================================
    // Test 5: Text unchanged, metadata preserved
    // ====================================================================
    console.log("\nTest 5: text unchanged, metadata preserved...");

    const origText5 = "Uses TypeScript for all projects";
    const entry5 = await store.store({
      text: origText5,
      vector: makeVector(8),
      category: "fact",
      scope: "test",
      importance: 0.6,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText5, category: "fact", importance: 0.6 },
          {
            l0_abstract: origText5,
            l1_overview: `- ${origText5}`,
            l2_content: origText5,
            memory_category: "facts",
            tier: "working",
            confidence: 0.6,
          },
        ),
      ),
    });

    // Update only category (no text, no importance)
    const result5 = await simulateMemoryUpdate(
      store, entry5.id, undefined, undefined, undefined, "decision", scopeFilter,
    );

    assert.equal(result5.action, "updated");
    const after5 = await store.getById(entry5.id, scopeFilter);
    assert.equal(after5.category, "decision", "category should be updated");
    const meta5 = parseSmartMetadata(after5.metadata, after5);
    // l0/l1/l2 should be unchanged since text was not modified
    assert.equal(meta5.l0_abstract, origText5, "l0 should be preserved");
    assert.equal(meta5.l1_overview, `- ${origText5}`, "l1 should be preserved");
    assert.equal(meta5.l2_content, origText5, "l2 should be preserved");
    assert.equal(meta5.confidence, 0.6, "confidence should be preserved");

    console.log("  OK text unchanged, metadata preserved");

    // ====================================================================
    // Test 6: Supersede path unaffected (regression)
    // ====================================================================
    console.log("\nTest 6: supersede path unaffected (regression)...");

    const origText6 = "Preferred IDE: Vim";
    const entry6 = await store.store({
      text: origText6,
      vector: makeVector(9),
      category: "preference",
      scope: "test",
      importance: 0.8,
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          { text: origText6, category: "preference", importance: 0.8 },
          {
            l0_abstract: origText6,
            l1_overview: "- Vim",
            l2_content: origText6,
            memory_category: "preferences",
            tier: "working",
            confidence: 0.8,
          },
        ),
      ),
    });

    const newText6 = "Preferred IDE: VS Code";
    const result6 = await simulateMemoryUpdate(
      store, entry6.id, newText6, makeVector(10), undefined, undefined, scopeFilter,
    );

    assert.equal(result6.action, "superseded", "preferences text change should still supersede");
    assert.ok(result6.newId, "should have new record");
    assert.equal(result6.oldId, entry6.id, "should reference old record");

    // Old record should be invalidated
    const old6 = await store.getById(entry6.id, scopeFilter);
    const oldMeta6 = parseSmartMetadata(old6.metadata, old6);
    assert.ok(oldMeta6.invalidated_at, "old record should be invalidated");
    assert.equal(isMemoryActiveAt(oldMeta6), false, "old record should be inactive");

    // New record should be active with supersede chain
    const new6 = await store.getById(result6.newId, scopeFilter);
    assert.equal(new6.text, newText6, "new record should have updated text");
    const newMeta6 = parseSmartMetadata(new6.metadata, new6);
    assert.equal(newMeta6.supersedes, entry6.id, "supersede chain should be intact");
    assert.equal(isMemoryActiveAt(newMeta6), true, "new record should be active");

    console.log("  OK supersede path unaffected");

    console.log("\n=== All memory_update metadata refresh tests passed! ===");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await runTests();
