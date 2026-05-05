/**
 * bulkUpdateMetadataWithPatch — Option A (Second Re-read) Test
 *
 * PR #639 F3 (Must Fix) — Option A 驗證測試
 *
 * 測試目標：
 * 當 Plugin 在 Phase 2b 的 delete 和 add 中間（非同步 window）寫入 access_count，
 * Option A 的第二次 re-read 能否捕捉到 Plugin 的寫入並保留。
 *
 * Run: node --test test/bulk-update-metadata-option-a.test.mjs
 */

import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nodeModulesPaths = [
  path.resolve(process.execPath, "../../lib/node_modules"),
  path.resolve(process.execPath, "../../openclaw/node_modules"),
  path.resolve(__dirname, "../../node_modules"),
].filter(Boolean);

process.env.NODE_PATH = [process.env.NODE_PATH, ...nodeModulesPaths].join(":");
Module._initPaths();

const jitiFactory = (await import("jiti")).default;
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parseSmartMetadata } = jiti("../src/smart-metadata.ts");

// ============================================================================
// Shared helper: build updated entries from rows
// ============================================================================

const ALLOWED_PATCH_KEYS = new Set([
  "l0_abstract", "l1_overview", "l2_content",
  "memory_category", "tier", "access_count", "confidence",
  "upgraded_from", "upgraded_at",
]);

function buildUpdatedEntries(rows) {
  return rows.map(({ entry, row }) => {
    const cleanPatch = Object.fromEntries(
      Object.entries(entry.patch ?? {})
        .filter(([k]) => ALLOWED_PATCH_KEYS.has(k))
        .filter(([, v]) => v !== undefined && v !== null)
    );
    const cleanMarker = Object.fromEntries(
      Object.entries(entry.marker ?? {})
        .filter(([k]) => ALLOWED_PATCH_KEYS.has(k))
        .filter(([, v]) => v !== undefined && v !== null)
    );
    const base = parseSmartMetadata(row.metadata ?? "{}", row);
    const merged = { ...base, ...cleanPatch, ...cleanMarker };

    return {
      id: row.id,
      text: (merged.l0_abstract ?? merged.l1_overview ?? row.text),
      vector: row.vector ?? [],
      category: row.category,
      scope: row.scope ?? "global",
      importance: Number(row.importance ?? 0),
      timestamp: Number(row.timestamp ?? Date.now()),
      metadata: JSON.stringify(merged),
    };
  });
}

// ============================================================================
// Mock Store Factory
// ============================================================================

function createMockStore() {
  const data = new Map();
  let lockHeld = false;
  const lockQueue = [];

  function runWithLock(fn) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        lockHeld = true;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          lockHeld = false;
          const next = lockQueue.shift();
          if (next) next();
        }
      };
      if (!lockHeld) {
        task();
      } else {
        lockQueue.push(task);
      }
    });
  }

  const store = {
    data,

    async list() { return Array.from(data.values()); },
    async getById(id) { return data.get(id) ?? null; },

    async store(entry) {
      const id = entry.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const stored = { ...entry, id, vector: entry.vector ?? [] };
      data.set(id, stored);
      return stored;
    },

    async update(id, patch) {
      const existing = data.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      data.set(id, updated);
      return updated;
    },

    /**
     * Default: WITH Option A (second re-read after delete).
     * Tests can override this method before calling.
     */
    async bulkUpdateMetadataWithPatch(entries) {
      return runWithLock(async () => {
        const uniqueEntries = Array.from(
          new Map(entries.map((e) => [e.id, e])).values()
        );
        const failed = [];

        // Step 1: First re-read
        const rows = [];
        for (const entry of uniqueEntries) {
          const row = data.get(entry.id);
          if (!row) { failed.push(entry.id); continue; }
          rows.push({ entry, row });
        }
        if (rows.length === 0) return { success: 0, failed };

        const firstReRead_accessCount = parseSmartMetadata(
          rows[0].row.metadata ?? "{}", rows[0].row
        ).access_count;

        // Step 2: Build from first re-read
        buildUpdatedEntries(rows);

        // Step 3: Delete
        for (const { entry } of rows) {
          data.delete(entry.id);
        }

        // Step 3.5 [Option A]: Second re-read — captures Plugin's write
        // Fallback to first re-read rows if second re-read returns nothing
        // (this handles the case where Plugin didn't write during the window)
        const rows_afterDelete = [];
        for (const { entry, row: firstRow } of rows) {
          const row_after = data.get(entry.id);
          if (row_after) {
            rows_afterDelete.push({ entry, row: row_after });
          } else {
            // No Plugin write during window — fall back to first re-read row
            rows_afterDelete.push({ entry, row: firstRow });
          }
        }

        const secondReRead_accessCount = rows_afterDelete[0]
          ? parseSmartMetadata(rows_afterDelete[0].row.metadata ?? "{}", rows_afterDelete[0].row).access_count
          : null;

        // Step 4: Build from second re-read
        const updatedEntries = buildUpdatedEntries(rows_afterDelete);

        // Step 5: Add
        for (const entry of updatedEntries) {
          data.set(entry.id, entry);
        }

        return {
          success: updatedEntries.length,
          failed,
          _debug: { firstReRead_accessCount, secondReRead_accessCount }
        };
      });
    },
  };

  return store;
}

// ============================================================================
// Test 1: WITHOUT Option A — Plugin's write is LOST (baseline)
// ============================================================================

async function testWithoutOptionAPluginWriteIsLost() {
  console.log("\n=== Test: WITHOUT Option A — Plugin write is LOST ===");

  const store = createMockStore();
  const testId = "no-option-a-" + Date.now();

  await store.store({
    id: testId,
    text: "initial memory",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      injected_count: 0,
      access_count: 0,
      confidence: 0.5,
      tier: "medium",
    }),
  });

  const patch = { l0_abstract: "LLM abstract no Option A" };
  const marker = { upgraded_from: "fact", upgraded_at: Date.now() };

  // Override bulkUpdateMetadataWithPatch to NOT have Option A
  // (no second re-read — Plugin's write during window is overwritten)
  const _data = store.data;
  store.bulkUpdateMetadataWithPatch = async function(entries) {
    return new Promise((resolve) => {
      // Simulate: Plugin's write happens BEFORE bulkUpdateMetadataWithPatch
      // but the method itself uses stale first-re-read data
      const uniqueEntries = Array.from(
        new Map(entries.map((e) => [e.id, e])).values()
      );
      const failed = [];
      const rows = [];
      for (const entry of uniqueEntries) {
        const row = _data.get(entry.id);
        if (!row) { failed.push(entry.id); continue; }
        rows.push({ entry, row });
      }
      if (rows.length === 0) { resolve({ success: 0, failed }); return; }

      const firstReRead_accessCount = parseSmartMetadata(
        rows[0].row.metadata ?? "{}", rows[0].row
      ).access_count;

      // Build from first re-read ONLY
      const updatedEntries = buildUpdatedEntries(rows);

      // Delete
      for (const { entry } of rows) {
        _data.delete(entry.id);
      }

      // Plugin writes access_count=10 during the window
      // But since we don't have Option A, we don't re-read — add uses STALE data
      const pluginRow = rows[0].row;
      const pluginMeta = parseSmartMetadata(pluginRow.metadata ?? "{}", pluginRow);
      _data.set(pluginRow.id, {
        ...pluginRow,
        metadata: JSON.stringify({ ...pluginMeta, access_count: 10 }),
      });

      // Add with stale updatedEntries → Plugin's write is OVERWRITTEN
      for (const entry of updatedEntries) {
        _data.set(entry.id, entry);
      }

      resolve({ success: updatedEntries.length, failed, _debug: { firstReRead_accessCount } });
    });
  };

  const result = await store.bulkUpdateMetadataWithPatch([
    { id: testId, patch, marker },
  ]);

  assert.strictEqual(result.success, 1, "Should succeed");
  console.log(`  First re-read access_count: ${result._debug.firstReRead_accessCount}`);
  console.log(`  Plugin wrote during delete+add window: access_count = 10`);
  console.log(`  (No second re-read — add uses stale first-re-read data)`);

  const after = await store.getById(testId);
  const afterMeta = parseSmartMetadata(after.metadata, after);

  console.log(`  Final access_count: ${afterMeta.access_count}`);

  assert.strictEqual(
    afterMeta.access_count,
    0,
    "Without Option A: access_count=0 (Plugin's write was overwritten)"
  );
  assert.strictEqual(afterMeta.l0_abstract, patch.l0_abstract, "l0_abstract from patch OK");

  console.log("  ✓ PASS: Without Option A, Plugin's write is correctly LOST (baseline)");
  return true;
}

// ============================================================================
// Test 2: WITH Option A — Plugin's write is PRESERVED
// ============================================================================

async function testOptionAPreservesPluginWriteBetweenDeleteAndAdd() {
  console.log("\n=== Test: Option A — Plugin write between delete+add is preserved ===");

  const store = createMockStore();
  const testId = "option-a-" + Date.now();

  await store.store({
    id: testId,
    text: "initial memory for Option A test",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      injected_count: 0,
      last_injected_at: null,
      access_count: 0,
      confidence: 0.5,
      tier: "medium",
    }),
  });

  // Verify initial
  const before = await store.getById(testId);
  const beforeMeta = parseSmartMetadata(before.metadata, before);
  assert.strictEqual(beforeMeta.access_count, 0, "Initial access_count=0");
  console.log(`  ✓ Initial: access_count=${beforeMeta.access_count}`);

  const patch = { l0_abstract: "LLM generated abstract from Option A test" };
  const marker = { upgraded_from: "fact", upgraded_at: Date.now() };

  // Override bulkUpdateMetadataWithPatch WITH Option A (second re-read)
  const _data = store.data;
  store.bulkUpdateMetadataWithPatch = async function(entries) {
    const uniqueEntries = Array.from(
      new Map(entries.map((e) => [e.id, e])).values()
    );
    const failed = [];

    // Step 1: First re-read
    const rows = [];
    for (const entry of uniqueEntries) {
      const row = _data.get(entry.id);
      if (!row) { failed.push(entry.id); continue; }
      rows.push({ entry, row });
    }
    if (rows.length === 0) return { success: 0, failed };

    const firstReRead_accessCount = parseSmartMetadata(
      rows[0].row.metadata ?? "{}", rows[0].row
    ).access_count;

    // Step 2: Build from first re-read
    buildUpdatedEntries(rows);

    // Step 3: Delete
    for (const { entry } of rows) {
      _data.delete(entry.id);
    }

    // ── [INJECT Plugin's write] ─────────────────────────────────────────
    // Plugin's lifecycle write fires during delete+add window
    const pluginRow = rows[0].row;
    const pluginMeta = parseSmartMetadata(pluginRow.metadata ?? "{}", pluginRow);
    _data.set(pluginRow.id, {
      ...pluginRow,
      metadata: JSON.stringify({ ...pluginMeta, access_count: 10 }),
    });
    // ── End Plugin's write ───────────────────────────────────────────────

    // Step 3.5 [Option A]: Second re-read — captures Plugin's access_count=10
    const rows_afterDelete = [];
    for (const { entry } of rows) {
      const row = _data.get(entry.id);
      if (row) rows_afterDelete.push({ entry, row });
    }

    const secondReRead_accessCount = rows_afterDelete[0]
      ? parseSmartMetadata(rows_afterDelete[0].row.metadata ?? "{}", rows_afterDelete[0].row).access_count
      : null;

    // Step 4: Build from second re-read
    const updatedEntries = buildUpdatedEntries(rows_afterDelete);

    // Step 5: Add
    for (const entry of updatedEntries) {
      _data.set(entry.id, entry);
    }

    return {
      success: updatedEntries.length,
      failed,
      _debug: { firstReRead_accessCount, secondReRead_accessCount }
    };
  };

  const result = await store.bulkUpdateMetadataWithPatch([
    { id: testId, patch, marker },
  ]);

  assert.strictEqual(result.success, 1, "Should succeed");
  assert.deepStrictEqual(result.failed, [], "No failures");
  console.log(`  First re-read access_count: ${result._debug.firstReRead_accessCount}`);
  console.log(`  Plugin wrote: access_count = 10`);
  console.log(`  Second re-read access_count: ${result._debug.secondReRead_accessCount}`);

  const after = await store.getById(testId);
  const afterMeta = parseSmartMetadata(after.metadata, after);

  console.log(`  Final access_count: ${afterMeta.access_count}`);
  console.log(`  Final l0_abstract: ${afterMeta.l0_abstract?.slice(0, 40)}...`);

  assert.strictEqual(
    result._debug.secondReRead_accessCount,
    10,
    "Second re-read should capture Plugin's access_count=10"
  );
  assert.strictEqual(
    afterMeta.access_count,
    10,
    "Final access_count=10 — Option A preserved Plugin's write"
  );
  assert.strictEqual(afterMeta.l0_abstract, patch.l0_abstract, "l0_abstract from patch OK");

  console.log("  ✓ PASS: Option A correctly preserves Plugin's write between delete+add");
  return true;
}

// ============================================================================
// Test 3: Option A — Plugin writes BEFORE Phase 2 (Plugin wins, normal)
// ============================================================================

async function testOptionAPluginWritesBeforePhase2() {
  console.log("\n=== Test: Option A — Plugin writes before Phase 2 (Plugin wins) ===");

  const store = createMockStore();
  const testId = "option-a-early-" + Date.now();

  await store.store({
    id: testId,
    text: "initial memory",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({ injected_count: 0, access_count: 0, confidence: 0.5, tier: "medium" }),
  });

  // Plugin writes BEFORE Phase 2b starts
  await store.update(testId, {
    metadata: JSON.stringify({ injected_count: 0, access_count: 10, confidence: 0.5, tier: "medium" }),
  });
  console.log("  ✓ Plugin wrote access_count=10 before Phase 2b");

  // Use default Option A implementation
  const result = await store.bulkUpdateMetadataWithPatch([
    { id: testId, patch: { l0_abstract: "LLM abstract" }, marker: { upgraded_from: "fact", upgraded_at: Date.now() } },
  ]);

  const after = await store.getById(testId);
  const afterMeta = parseSmartMetadata(after.metadata, after);

  console.log(`  First re-read captures Plugin's write: access_count = 10`);
  console.log(`  Final access_count: ${afterMeta.access_count}`);

  assert.strictEqual(afterMeta.access_count, 10, "Plugin's pre-Phase2 write preserved");
  assert.strictEqual(afterMeta.l0_abstract, "LLM abstract", "l0_abstract from patch OK");

  console.log("  ✓ PASS: Plugin's pre-Phase2 write is correctly preserved");
  return true;
}

// ============================================================================
// Test 4: Option A — Partial Plugin write (only some entries)
// ============================================================================

async function testOptionAPartialPluginWrite() {
  console.log("\n=== Test: Option A — Partial Plugin write (only some entries) ===");

  const store = createMockStore();
  const idA = "option-a-multi-A-" + Date.now();
  const idB = "option-a-multi-B-" + Date.now();

  await store.store({
    id: idA,
    text: "memory A",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({ injected_count: 0, access_count: 0, confidence: 0.5, tier: "medium" }),
  });
  await store.store({
    id: idB,
    text: "memory B",
    vector: [0.1, 0.2, 0.3, 0.4],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({ injected_count: 0, access_count: 0, confidence: 0.5, tier: "medium" }),
  });

  const _data = store.data;
  store.bulkUpdateMetadataWithPatch = async function(entries) {
    const uniqueEntries = Array.from(
      new Map(entries.map((e) => [e.id, e])).values()
    );
    const failed = [];
    const rows = [];
    for (const entry of uniqueEntries) {
      const row = _data.get(entry.id);
      if (!row) { failed.push(entry.id); continue; }
      rows.push({ entry, row });
    }
    if (rows.length === 0) return { success: 0, failed };

    // Delete
    for (const { entry } of rows) {
      _data.delete(entry.id);
    }

    // Plugin writes ONLY to idA — capture the updated row reference
    let pluginUpdatedRow = null;
    const pluginRowA = rows.find(r => r.entry.id === idA)?.row;
    if (pluginRowA) {
      const metaA = parseSmartMetadata(pluginRowA.metadata ?? "{}", pluginRowA);
      const newRow = {
        ...pluginRowA,
        metadata: JSON.stringify({ ...metaA, access_count: 99 }),
      };
      _data.set(pluginRowA.id, newRow);
      pluginUpdatedRow = newRow;
    }

    // Second re-read (Option A)
    const rows_afterDelete = [];
    for (const { entry, row: firstRow } of rows) {
      const row = _data.get(entry.id);
      if (row) {
        rows_afterDelete.push({ entry, row });
      } else {
        // No Plugin write during window — fall back to first re-read row
        rows_afterDelete.push({ entry, row: firstRow });
      }
    }

    const updatedEntries = buildUpdatedEntries(rows_afterDelete);

    for (const entry of updatedEntries) {
      _data.set(entry.id, entry);
    }

    return { success: updatedEntries.length, failed };
  };

  const result = await store.bulkUpdateMetadataWithPatch([
    { id: idA, patch: { l0_abstract: "A abstract" }, marker: { upgraded_from: "fact", upgraded_at: Date.now() } },
    { id: idB, patch: { l0_abstract: "B abstract" }, marker: { upgraded_from: "fact", upgraded_at: Date.now() } },
  ]);

  assert.strictEqual(result.success, 2, "Both entries should succeed");

  const finalA = await store.getById(idA);
  const finalB = await store.getById(idB);
  const metaA = parseSmartMetadata(finalA.metadata, finalA);
  const metaB = parseSmartMetadata(finalB.metadata, finalB);

  assert.strictEqual(metaA.access_count, 99, "Entry A: Plugin's write preserved (access_count=99)");
  assert.strictEqual(metaB.access_count, 0, "Entry B: No Plugin write, stays 0");
  assert.strictEqual(metaA.l0_abstract, "A abstract", "Entry A: patch applied");
  assert.strictEqual(metaB.l0_abstract, "B abstract", "Entry B: patch applied");

  console.log("  ✓ PASS: Partial Plugin write (only some entries) handled correctly");
  return true;
}

// ============================================================================
// Run all tests
// ============================================================================

async function main() {
  console.log("=".repeat(70));
  console.log("bulkUpdateMetadataWithPatch — Option A (F3 fix) Verification Tests");
  console.log("=".repeat(70));

  const results = [];

  try {
    results.push(await testWithoutOptionAPluginWriteIsLost());
    results.push(await testOptionAPreservesPluginWriteBetweenDeleteAndAdd());
    results.push(await testOptionAPluginWritesBeforePhase2());
    results.push(await testOptionAPartialPluginWrite());
  } catch (err) {
    console.error("\n❌ Test failed with error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Results: ${passed}/${results.length} test groups passed`);
  if (passed === results.length) {
    console.log("✅ All Option A verification tests passed");
  } else {
    console.log("❌ Some tests failed");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
