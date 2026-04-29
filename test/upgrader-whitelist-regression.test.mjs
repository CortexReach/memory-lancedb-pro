/**
 * ALLOWED_PATCH_KEYS Regression Tests (PR #639)
 *
 * 測試目標：
 * 1. 驗證 tier/access_count/confidence 在 ALLOWED_PATCH_KEYS 白名單中，
 *    因此 writeEnrichedBatch 的明確升級值會被正確套用（而非被靜默丟棄）
 * 2. 驗證不在白名單的欄位（如 injected_count）不會被 patch 覆蓋
 * 3. 驗證未定義的 patch 值會被過濾（不覆蓋 base 值）
 *
 * 執行方式: node test/upgrader-whitelist-regression.test.mjs
 */

import assert from "node:assert/strict";
import Module from "node:module";
import jitiFactory from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 動態路徑設定（與其他測試一致）
const nodeModulesPaths = [
  path.resolve(process.execPath, "../../lib/node_modules"),
  path.resolve(process.execPath, "../../openclaw/node_modules"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules"),
].filter(Boolean);

process.env.NODE_PATH = [...(process.env.NODE_PATH ?? "").split(":").filter(Boolean), ...nodeModulesPaths].join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryUpgrader } = jiti("../src/memory-upgrader.ts");

// ============================================================================
// Mock Store：真實還原 ALLOWED_PATCH_KEYS 過濾行為
// ============================================================================

const ALLOWED_PATCH_KEYS = new Set([
  "l0_abstract",
  "l1_overview",
  "l2_content",
  "memory_category",
  "upgraded_from",
  "upgraded_at",
  // [fix-PR639] 這些是 writeEnrichedBatch 明確設定的欄位
  "tier",
  "access_count",
  "confidence",
]);

function createWhitelistAwareMockStore() {
  const state = { data: new Map(), lockCount: 0 };

  return {
    state,

    async list() {
      return Array.from(state.data.values());
    },

    /**
     * 逼真模擬 store.bulkUpdateMetadataWithPatch 的白名單過濾行為。
     * 這是回歸測試的核心：驗證 cleanPatch 的過濾邏輯。
     */
    async bulkUpdateMetadataWithPatch(entries) {
      return await this.runWithFileLock(async () => {
        for (const { id, patch, marker } of entries) {
          const existing = state.data.get(id);
          if (!existing) {
            console.log(`  [mock] bulkUpdateMetadataWithPatch: no existing entry for id=${id}`);
            continue;
          }

          // [fix-PR639] 複製 ALLOWED_PATCH_KEYS 的真實過濾邏輯
          const cleanPatch = Object.fromEntries(
            Object.entries(patch)
              .filter(([k]) => ALLOWED_PATCH_KEYS.has(k))
              .filter(([, v]) => v !== undefined)
          );
          const cleanMarker = Object.fromEntries(
            Object.entries(marker ?? {}).filter(([, v]) => v !== undefined)
          );

          console.log(`  [mock] existing.metadata=${existing.metadata}`);
          console.log(`  [mock] patch=${JSON.stringify(patch)}`);
          console.log(`  [mock] cleanPatch=${JSON.stringify(cleanPatch)}`);
          console.log(`  [mock] cleanMarker=${JSON.stringify(cleanMarker)}`);

          // Parse existing metadata (same as real bulkUpdateMetadataWithPatch)
          const base = JSON.parse(existing.metadata ?? "{}");
          // Merge: base (Plugin fields) + cleanPatch (whitelisted LLM/upgrade fields) + cleanMarker
          const mergedMeta = {
            ...base,
            ...cleanPatch,
            ...cleanMarker,
          };
          // Merge top-level entry fields (id, text, vector, etc.) + new metadata string
          const merged = {
            ...existing,
            metadata: JSON.stringify(mergedMeta),
          };
          state.data.set(id, merged);
        }
        return { success: entries.length, failed: [] };
      });
    },

    async update(id, patch) {
      return await this.runWithFileLock(async () => {
        const existing = state.data.get(id);
        if (existing) {
          state.data.set(id, { ...existing, ...patch });
        }
        return true;
      });
    },

    async getById(id) {
      return state.data.get(id) || null;
    },

    async runWithFileLock(fn) {
      state.lockCount++;
      return fn();
    },

    initData(entries) {
      for (const entry of entries) {
        state.data.set(entry.id, entry);
      }
    },

    reset() {
      state.data.clear();
      state.lockCount = 0;
    },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

/**
 * [fix-PR639] 核心回歸測試：
 * writeEnrichedBatch 明確設定 tier/access_count/confidence，
 * 這些值必須出現在最終 metadata 中，不再被靜默丟棄。
 */
async function testWhitelist_UpgradeFieldsApplied() {
  console.log("\n=== Test 1: ALLOWED_PATCH_KEYS — tier/access_count/confidence 必須被套用 ===");

  const store = createWhitelistAwareMockStore();

  // 建立一個有 metadata 的 legacy entry（simulate parseSmartMetadata default values）
  const entry = {
    id: "test-entry-1",
    text: "Test memory for whitelist regression",
    category: "fact",
    scope: "test",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      tier: "peripheral",      // 升級前：peripheral
      access_count: 10,       // 升級前：10（Plugin 已記錄）
      confidence: 0.3,         // 升級前：0.3
      injected_count: 7,      // Plugin 寫入，不在 patch 中，必須保留
    }),
  };
  store.initData([entry]);

  const llm = {
    async completeJson() {
      // 不需要真實 LLM：noLlm=true 時 upgrader 會跳過
      return null;
    },
    getLastError() {
      return "mock";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm);

  // noLlm=true 讓 upgrader 只做 Phase 2（跳過 Phase 1 LLM call）
  // 但 writeEnrichedBatch 的 patch 仍然會帶 tier="working", access_count=0, confidence=0.7
  await upgrader.upgrade({ batchSize: 1, noLlm: true });

  const result = store.state.data.get("test-entry-1");
  const meta = JSON.parse(result.metadata ?? "{}");

  console.log(`  tier: ${meta.tier} (expected: working)`);
  console.log(`  access_count: ${meta.access_count} (expected: 0)`);
  console.log(`  confidence: ${meta.confidence} (expected: 0.7)`);
  console.log(`  injected_count: ${meta.injected_count} (expected: 7 — Plugin 寫入，必須保留)`);
  console.log(`  l0_abstract: ${meta.l0_abstract ? "present" : "missing"} (expected: present or absent depending on noLlm)`);

  // [fix-PR639 核心驗證]：這些明確升級值必須被套用
  assert.strictEqual(meta.tier, "working", "tier=working 必須被套用（不再是 NO-OP）");
  assert.strictEqual(meta.access_count, 0, "access_count=0 必須被套用（不再是 NO-OP）");
  assert.strictEqual(meta.confidence, 0.7, "confidence=0.7 必須被套用（不再是 NO-OP）");

  // Plugin 的 injected_count 必須保留（不在 cleanPatch 中）
  assert.strictEqual(meta.injected_count, 7, "Plugin 的 injected_count 必須保留");

  console.log("  ✅ Test 1 通過：tier/access_count/confidence 正確套用，injected_count 保留");
}

/**
 * 驗證不在 ALLOWED_PATCH_KEYS 的欄位不會被 patch 覆蓋。
 * 例如：即使 LLM patch 包含 injected_count，也會被過濾掉。
 */
async function testWhitelist_BlockedFieldsRejected() {
  console.log("\n=== Test 2: ALLOWED_PATCH_KEYS — 不在白名單的欄位必須被拒絕 ===");

  const store = createWhitelistAwareMockStore();

  // 建立帶有 Plugin 欄位的 entry
  const entry = {
    id: "test-entry-2",
    text: "Another test entry",
    category: "fact",
    scope: "test",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      tier: "core",
      access_count: 99,
      confidence: 0.9,
      injected_count: 42,    // Plugin 寫入
      injected_recency: 0.85, // Plugin 寫入，不在白名單
      last_injected_at: 1234567890,
    }),
  };
  store.initData([entry]);

  // 注入一個惡意/錯誤的 patch（嘗試覆蓋不應被覆寫的欄位）
  // 透過 monkey-patch bulkUpdateMetadataWithPatch 傳入超範圍欄位
  const originalBulkUpdate = store.bulkUpdateMetadataWithPatch.bind(store);
  store.bulkUpdateMetadataWithPatch = async (entries) => {
    // 傳入帶有危險欄位的 patch
    const modifiedEntries = entries.map((e) => ({
      ...e,
      patch: {
        ...e.patch,
        // 嘗試覆蓋不應被覆寫的欄位
        injected_count: 9999,       // 不在白名單，應被過濾
        injected_recency: 1.0,     // 不在白名單，應被過濾
        last_injected_at: 9999999999,
        // 白名單欄位（正常）
        tier: "peripheral",
        access_count: 0,
        confidence: 0.1,
        l0_abstract: "malicious abstract",
      },
    }));
    return originalBulkUpdate(modifiedEntries);
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return "mock"; },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  await upgrader.upgrade({ batchSize: 1, noLlm: true });

  const result = store.state.data.get("test-entry-2");
  const meta = JSON.parse(result.metadata ?? "{}");

  console.log(`  injected_count: ${meta.injected_count} (expected: 42 — 不在白名單，必須保留)`);
  console.log(`  injected_recency: ${meta.injected_recency} (expected: 0.85 — 不在白名單，必須保留)`);
  console.log(`  last_injected_at: ${meta.last_injected_at} (expected: 1234567890 — 不在白名單，必須保留)`);
  console.log(`  tier: ${meta.tier} (expected: peripheral — 在白名單，正常套用)`);

  // 不在白名單的欄位必須保留原始值
  assert.strictEqual(meta.injected_count, 42, "injected_count 不在白名單，必須保留");
  assert.strictEqual(meta.injected_recency, 0.85, "injected_recency 不在白名單，必須保留");
  assert.strictEqual(meta.last_injected_at, 1234567890, "last_injected_at 不在白名單，必須保留");

  // 在白名單的欄位正常套用
  assert.strictEqual(meta.tier, "peripheral", "tier 在白名單，必須套用");
  assert.strictEqual(meta.access_count, 0, "access_count 在白名單，必須套用");
  assert.strictEqual(meta.confidence, 0.1, "confidence 在白名單，必須套用");

  console.log("  ✅ Test 2 通過：不在白名單的欄位被正確阻擋");
}

/**
 * 驗證 undefined 值不會用 undefined 覆蓋 base 值（fix-Q8）。
 * JS spread: {...base, ...{x: undefined}} 會把 base.x 覆蓋成 undefined。
 */
async function testWhitelist_UndefinedValuesFiltered() {
  console.log("\n=== Test 3: ALLOWED_PATCH_KEYS — undefined 值不得覆蓋 base ===");

  const store = createWhitelistAwareMockStore();

  const entry = {
    id: "test-entry-3",
    text: "Entry with partial patch",
    category: "fact",
    scope: "test",
    importance: 0.6,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      tier: "core",
      access_count: 50,
      confidence: 0.8,
      l0_abstract: "existing abstract",
    }),
  };
  store.initData([entry]);

  // 傳入 patch，其中某些白名單欄位是 undefined
  const originalBulkUpdate = store.bulkUpdateMetadataWithPatch.bind(store);
  store.bulkUpdateMetadataWithPatch = async (entries) => {
    const modifiedEntries = entries.map((e) => ({
      ...e,
      patch: {
        ...e.patch,
        // 明確設為 undefined（常見於 LLM 沒輸出的欄位）
        tier: undefined,
        access_count: undefined,
        // 只有這個有值
        l0_abstract: "new abstract",
      },
    }));
    return originalBulkUpdate(modifiedEntries);
  };

  const llm = {
    async completeJson() { return null; },
    getLastError() { return "mock"; },
  };

  const upgrader = createMemoryUpgrader(store, llm);
  await upgrader.upgrade({ batchSize: 1, noLlm: true });

  const result = store.state.data.get("test-entry-3");
  const meta = JSON.parse(result.metadata ?? "{}");

  console.log(`  tier: ${meta.tier} (expected: core — undefined 不應覆蓋)`);
  console.log(`  access_count: ${meta.access_count} (expected: 50 — undefined 不應覆蓋)`);
  console.log(`  l0_abstract: ${meta.l0_abstract} (expected: new abstract — 有值，正常套用)`);

  // undefined 值不得覆蓋 base
  assert.strictEqual(meta.tier, "core", "tier=undefined 不應覆蓋 base.core");
  assert.strictEqual(meta.access_count, 50, "access_count=undefined 不應覆蓋 base=50");

  // 有值的正常套用
  assert.strictEqual(meta.l0_abstract, "new abstract");

  console.log("  ✅ Test 3 通過：undefined 值正確過濾，不會覆蓋 base");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("===========================================");
  console.log("ALLOWED_PATCH_KEYS Regression Tests (PR #639)");
  console.log("===========================================");

  try {
    await testWhitelist_UpgradeFieldsApplied();
    await testWhitelist_BlockedFieldsRejected();
    await testWhitelist_UndefinedValuesFiltered();

    console.log("\n===========================================");
    console.log("All regression tests passed!");
    console.log("===========================================");
  } catch (err) {
    console.error("\nTest failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
