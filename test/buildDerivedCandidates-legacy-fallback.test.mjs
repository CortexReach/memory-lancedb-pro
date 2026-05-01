// Regression test：combined-legacy fallback 不應讓 sub-agent 看到 main derived
// 對應 PR: https://github.com/CortexReach/memory-lancedb-pro/pull/522
// Review: https://github.com/CortexReach/memory-lancedb-pro/pull/522#pullrequestreview-4185627472
//
// 問題：buildDerivedCandidates() 在 itemCandidates 為空時，
// fallback 到 legacyRows。此時 combined-legacy row（無 itemKind，
// 但有 metadata.derived）被視為 legacy，isOwnedByAgent 接受 owner="main"，
// 導致 sub-agent 可以看到 main 的 derived 內容。
//
// 修復：在 legacy fallback 前，先過濾掉 owner="main" 且有 derived 內容的 legacy row。
//
// 環境需求：Node.js >= 22（使用內建 TypeScript 執行，不需要 tsx）
// CI: .github/workflows/ci.yml — 所有 jobs 明確使用 node-version: 22

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildDerivedCandidates } from "../src/reflection-store.ts";

// 輔助：模擬 legacy row（type="memory-reflection"，來自 buildLegacyCombinedPayload）
function makeLegacyRow(agentId, derived = []) {
  return {
    entry: { text: "dummy legacy", timestamp: Date.now() },
    metadata: { type: "memory-reflection", agentId, derived },
  };
}

// 輔助：模擬 item-derived row（type="memory-reflection-item"）
function makeItemRow(agentId, itemKind = "derived") {
  return {
    entry: { text: "dummy item", timestamp: Date.now() },
    metadata: { type: "memory-reflection-item", agentId, itemKind },
  };
}

describe("buildDerivedCandidates — combined-legacy fallback ownership (regression)", () => {
  describe("itemCandidates 為空，fallback 到 legacy rows", () => {
    it("main 的 derived legacy row → sub-agent 不可見（核心修復）", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("main", ["some derived content"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "sub-agent-A");
      assert.strictEqual(
        candidates.length,
        0,
        "sub-agent 不該看到 main 的 derived fallback"
      );
    });

    it("main 的 derived legacy row → main 自己可見", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("main", ["main's derived content"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "main");
      assert.ok(
        candidates.length > 0,
        "main 應看到自己的 derived fallback"
      );
    });

    it("agent-x 的 derived legacy row → agent-x 自己可見", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("agent-x", ["x's derived"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "agent-x");
      assert.ok(candidates.length > 0, "agent-x 應看到自己的 derived fallback");
    });

    it("agent-x 的 derived legacy row → agent-y 不可見", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("agent-x", ["x's derived"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "agent-y");
      assert.strictEqual(
        candidates.length,
        0,
        "agent-y 不該看到 agent-x 的 derived fallback"
      );
    });

    it("純 legacy invariant（無 derived）→ sub-agent 可見（不應被阻擋）", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("main", [])]; // 無 derived
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "sub-agent-A");
      assert.ok(
        candidates.length > 0,
        "sub-agent 應看到純 legacy invariant（無 derived 不應阻擋）"
      );
    });

    it("有 item-derived candidates 時，不走 legacy fallback（item path 優先）", () => {
      // item-derived row（main 寫的）會被 isOwnedByAgent 擋掉，
      // 所以傳入 buildDerivedCandidates 時 itemRows 已是過濾後的狀態（不含 main 的 derived）
      const itemRows = [makeItemRow("sub-agent-B", "derived")];
      const legacyRows = [makeLegacyRow("main", ["should be ignored"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "sub-agent-A");
      assert.ok(
        candidates.length === 0,
        "item-derived 已被隔離，sub-agent-A 不應看到任何 derived"
      );
    });

    it("有 derived 但 owner 為空字串 → 不可見（防禦性）", () => {
      const itemRows = [];
      const legacyRows = [makeLegacyRow("", ["some content"])];
      const candidates = buildDerivedCandidates(itemRows, legacyRows, "sub-agent-A");
      assert.strictEqual(
        candidates.length,
        0,
        "owner 為空的有 derived legacy row 不應對任何 agent 可見"
      );
    });
  });
});
