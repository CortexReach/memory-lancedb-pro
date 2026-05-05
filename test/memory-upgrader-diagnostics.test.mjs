import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jitiFactory from "jiti";

// [FIX nice-to-have] 使用動態路徑，支援 Linux/macOS/Windows，不再 hardcoded /opt/homebrew/
const nodeModulesPaths = [
  path.resolve(process.execPath, "../../lib/node_modules"),
  path.resolve(process.execPath, "../../openclaw/node_modules"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules"),
].filter(Boolean);

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  ...nodeModulesPaths,
].join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryUpgrader } = jiti("../src/memory-upgrader.ts");

async function runTest() {
  const logs = [];
  const bulkUpdates = [];
  const legacyEntry = {
    id: "legacy-1",
    text: "Legacy memory about an unfinished OpenClaw upgrade task.",
    category: "fact",
    scope: "test",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: "{}",
  };

  // [FIX] Phase 2 API: upgrader 呼叫 bulkUpdateMetadataWithPatch() 而非 update()
  // 需同步更新 mock，否則升級失敗（PR 作者漏改了這個測試）
  const store = {
    async list() {
      return [legacyEntry];
    },
    async getById(id) {
      return id === legacyEntry.id ? legacyEntry : null;
    },
    /**
     * Phase 2 bulk write API (replaces Phase 1 的 update() 呼叫).
     * 每個 entry 攜帶 LLM-enrichment patch + upgrade marker.
     * 測試驗證: (1) 呼叫成功 (2) upgraded_at 在 metadata 中 (3) text 不被覆蓋.
     */
    async bulkUpdateMetadataWithPatch(entries) {
      bulkUpdates.push(...entries);
      return { success: entries.length, failed: [] };
    },
    /** 模擬 runWithFileLock（追蹤 lock 行為） */
    async runWithFileLock(fn) {
      return fn();
    },
  };

  const llm = {
    async completeJson() {
      return null; // 觸發 simpleEnrich fallback
    },
    getLastError() {
      return "memory-lancedb-pro: llm-client [generic] request failed for model mock: timeout";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm, {
    log: (msg) => logs.push(msg),
  });

  const result = await upgrader.upgrade({ batchSize: 1 });

  assert.equal(result.totalLegacy, 1);
  assert.equal(result.upgraded, 1, "Phase 2 bulkUpdateMetadataWithPatch 應成功");
  assert.equal(result.errors.length, 0);
  assert.equal(bulkUpdates.length, 1, "Phase 2 應呼叫 1 次 bulkUpdateMetadataWithPatch");
  assert.match(
    logs.join("\n"),
    /request failed for model mock: timeout/,
    "LLM fallback 錯誤應記錄到 log",
  );
  // [FIX] Phase 2: patch.marker.upgraded_at 存在（而非 Phase 1 的 patch.metadata）
  const entry = bulkUpdates[0];
  assert.ok(entry.marker?.upgraded_at, "upgraded_at marker 應存在於 Phase 2 輸出");
  assert.ok(entry.patch?.l0_abstract, "simpleEnrich fallback 應產生 l0_abstract");
  // Phase 2 關鍵保證: text 不在 patch 中，永不被覆蓋
  assert.ok(!("text" in entry.patch), "Phase 2 patch 不應包含 text 欄位");

  console.log("memory-upgrader diagnostics test passed");
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
