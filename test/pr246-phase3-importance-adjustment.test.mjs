/**
 * PR #246 Phase 3 Importance 直接調整機制 單元測試
 *
 * 測試目標：
 * - 單次使用：importance += 0.05（上限 1.0）
 * - 連續未使用（bad_recall_count 遞增）：每次 -= 0.03，達門檻後觸發
 * - 被使用後 bad_recall_count 重置為 0
 * - importance 上限 1.0 / 下限 0.1 的 clamp
 * - 不在 auto-recall 結果中的 memory 不應被調整
 *
 * 執行方式：node --test test/pr246-phase3-importance-adjustment.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ============================================================
// 待測試函式：Phase 3 Importance 直接調整邏輯
// （從 index.ts before_prompt_build hook (priority=5) 提取）
// ============================================================

/**
 * Phase 2+3 重要性反饋調整主函式
 *
 * @param {object} params
 * @param {number} params.currentImportance  - 當前 importance（預設 0.7）
 * @param {number} params.badRecallCount     - 當前 bad_recall_count
 * @param {boolean} params.isUsed            - 本輪召回是否被使用
 * @param {number} [params.boostPerUse]      - 每次使用上調幅度（預設 0.05）
 * @param {number} [params.penaltyPerMiss]    - 每次未使用下調幅度（預設 0.03）
 * @param {number} [params.minCountPenalty]   - 觸發下調的 bad_recall_count 門檻（預設 2）
 * @returns {{ newImportance: number, newBadRecallCount: number, appliedBoost: boolean, appliedPenalty: boolean }}
 */
function applyImportanceFeedback({
  currentImportance,
  badRecallCount,
  isUsed,
  boostPerUse = 0.05,
  penaltyPerMiss = 0.03,
  minCountPenalty = 2,
}) {
  let newImportance = currentImportance;
  let newBadRecallCount = badRecallCount;
  let appliedBoost = false;
  let appliedPenalty = false;

  if (isUsed) {
    // ── Phase 2：記錄確認 + 重置 bad count ──
    newBadRecallCount = 0;

    // ── Phase 3：溫和上調（+boostPerUse，上限 1.0）──
    const imp = Number.isFinite(currentImportance) ? currentImportance : 0.7;
    const boost = Number.isFinite(boostPerUse) ? boostPerUse : 0.05;
    const candidate = imp + boost;
    const newImp = Math.min(1.0, candidate);

    if (newImp !== imp) {
      newImportance = newImp;
      appliedBoost = true;
    } else {
      newImportance = imp;
    }
  } else {
    // ── Phase 2：遞增 bad count ──
    newBadRecallCount = (Number.isFinite(badRecallCount) ? badRecallCount : 0) + 1;

    // ── Phase 3：達門檻後下調（-penaltyPerMiss，下限 0.1）──
    const imp = Number.isFinite(currentImportance) ? currentImportance : 0.7;
    const penalty = Number.isFinite(penaltyPerMiss) ? penaltyPerMiss : 0.03;
    const threshold = Number.isFinite(minCountPenalty) ? minCountPenalty : 2;

    if (newBadRecallCount >= threshold) {
      const candidate = imp - penalty;
      const newImp = Math.max(0.1, candidate);
      if (newImp !== imp) {
        newImportance = newImp;
        appliedPenalty = true;
      } else {
        newImportance = imp;
      }
    } else {
      // 未達門檻：只遞增 bad_recall_count，不動 importance
      newImportance = imp;
    }
  }

  return { newImportance, newBadRecallCount, appliedBoost, appliedPenalty };
}

// ============================================================
// Mock Store（模擬 Phase 2/3 在 before_prompt_build 中的呼叫情境）
// ============================================================

/**
 * 模擬 MemoryStore 的 Phase 2/3 互動介面
 * 用於驗證 metadata 欄位流向（不實際寫入資料庫）
 */
class MockMemoryStore {
  constructor() {
    this.records = new Map(); // id → { importance, metadata }
    this.patchLog = [];       // 記錄所有 patchMetadata 呼叫
    this.updateLog = [];       // 記錄所有 update(importance) 呼叫
  }

  // 預先塞入一筆記錄
  setRecord(id, importance = 0.7, metadata = {}) {
    this.records.set(id, { importance, metadata });
  }

  // 模擬 store.get
  get(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    return {
      id,
      text: "mock text",
      importance: rec.importance,
      metadata: JSON.stringify(rec.metadata),
    };
  }

  // 模擬 store.patchMetadata
  patchMetadata(id, patch) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const updated = { ...rec.metadata, ...patch };
    this.records.set(id, { importance: rec.importance, metadata: updated });
    this.patchLog.push({ id, patch });
    return this.get(id);
  }

  // 模擬 store.update（只處理 importance 欄位）
  update(id, updates) {
    const rec = this.records.get(id);
    if (!rec) return null;
    if (typeof updates.importance === "number") {
      this.records.set(id, { importance: updates.importance, metadata: rec.metadata });
      this.updateLog.push({ id, importance: updates.importance });
    }
    return this.get(id);
  }

  clearLogs() {
    this.patchLog.length = 0;
    this.updateLog.length = 0;
  }
}

// ============================================================
// 測試案例
// ============================================================

describe("PR #246 Phase 3 — Importance 直接調整機制", () => {

  // ── TC-1：單次使用 → importance += 0.05 ──
  describe("TC-1：單次使用時上調 +0.05（上限 1.0）", () => {
    it("基本案例：0.7 → 0.75", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.7,
        badRecallCount: 0,
        isUsed: true,
      });
      assert.strictEqual(result.newImportance, 0.75);
      assert.strictEqual(result.newBadRecallCount, 0);
      assert.strictEqual(result.appliedBoost, true);
      assert.strictEqual(result.appliedPenalty, false);
    });

    it("複合場景：先未使用(壞)2次 → 再使用 → importance 0.72, badCount=0, boost applied", () => {
      // 模擬：bad_recall_count=2 的記憶被使用了
      // 之後：boost +0.05，count 重置
      const result = applyImportanceFeedback({
        currentImportance: 0.67,
        badRecallCount: 2,
        isUsed: true,
      });
      assert.ok(Math.abs(result.newImportance - 0.72) < 1e-9, `expected ~0.72, got ${result.newImportance}`);
      assert.strictEqual(result.newBadRecallCount, 0);
      assert.strictEqual(result.appliedBoost, true);
    });

    it("上限 clamp：importance 已達 1.0 時使用 → 仍是 1.0（不上調）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 1.0,
        badRecallCount: 0,
        isUsed: true,
      });
      assert.strictEqual(result.newImportance, 1.0);
      assert.strictEqual(result.appliedBoost, false); // 未實際調
    });

    it("near-ceiling：0.97 + 0.05 → 1.0（不超標）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.97,
        badRecallCount: 0,
        isUsed: true,
      });
      assert.strictEqual(result.newImportance, 1.0);
      assert.strictEqual(result.appliedBoost, true);
    });
  });

  // ── TC-2：連續未使用 → 每次遞增 bad_recall_count，達門檻後下調 ──
  describe("TC-2：連續未使用時 bad_recall_count 遞增，達門檻後 importance 下調", () => {
    it("第1次未使用（count 0→1）：importance 不變（未達門檻 2）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.7,
        badRecallCount: 0,
        isUsed: false,
        minCountPenalty: 2,
      });
      assert.strictEqual(result.newImportance, 0.7);
      assert.strictEqual(result.newBadRecallCount, 1);
      assert.strictEqual(result.appliedPenalty, false);
    });

    it("第2次未使用（count 1→2，達門檻）：importance 0.7→0.67（-0.03）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.7,
        badRecallCount: 1,
        isUsed: false,
        minCountPenalty: 2,
      });
      assert.ok(Math.abs(result.newImportance - 0.67) < 1e-9, `expected ~0.67, got ${result.newImportance}`);
      assert.strictEqual(result.newBadRecallCount, 2);
      assert.strictEqual(result.appliedPenalty, true);
    });

    it("第3次未使用（count 2→3）：importance 0.67→0.64（再-0.03）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.67,
        badRecallCount: 2,
        isUsed: false,
        minCountPenalty: 2,
      });
      assert.strictEqual(result.newImportance, 0.64);
      assert.strictEqual(result.newBadRecallCount, 3);
      assert.strictEqual(result.appliedPenalty, true);
    });

    it("使用 Proposal 指定參數（minCountPenalty=3）：第3次未使用才觸發", () => {
      // 模擬：config.minRecallCountForPenalty = 3（Proposal 設計）
      const r1 = applyImportanceFeedback({ currentImportance: 0.7, badRecallCount: 0, isUsed: false, minCountPenalty: 3 });
      assert.strictEqual(r1.newBadRecallCount, 1);
      assert.strictEqual(r1.appliedPenalty, false);

      const r2 = applyImportanceFeedback({ currentImportance: 0.7, badRecallCount: 1, isUsed: false, minCountPenalty: 3 });
      assert.strictEqual(r2.newBadRecallCount, 2);
      assert.strictEqual(r2.appliedPenalty, false);

      const r3 = applyImportanceFeedback({ currentImportance: 0.7, badRecallCount: 2, isUsed: false, minCountPenalty: 3 });
      assert.strictEqual(r3.newBadRecallCount, 3);
      assert.strictEqual(r3.appliedPenalty, true);  // count=3，觸發！
      assert.strictEqual(r3.newImportance, 0.7 - 0.03); // 0.67
    });
  });

  // ── TC-3：被使用後 bad_recall_count 重置為 0 ──
  describe("TC-3：被使用後 bad_recall_count 重置為 0", () => {
    it("count=5 的記憶被使用 → count=0", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.5,
        badRecallCount: 5,
        isUsed: true,
      });
      assert.strictEqual(result.newBadRecallCount, 0);
      assert.strictEqual(result.appliedBoost, true);
    });

    it("count=0 的記憶被使用 → count 保持 0", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.7,
        badRecallCount: 0,
        isUsed: true,
      });
      assert.strictEqual(result.newBadRecallCount, 0);
    });

    it("使用後 boost 與 count 重置同時生效", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.55,
        badRecallCount: 3,
        isUsed: true,
      });
      assert.ok(Math.abs(result.newImportance - 0.60) < 1e-9, `expected ~0.60, got ${result.newImportance}`);
      assert.strictEqual(result.newBadRecallCount, 0);
      assert.strictEqual(result.appliedBoost, true);
    });
  });

  // ── TC-4：importance 上限 1.0 / 下限 0.1 的 clamp ──
  describe("TC-4：importance 上限 1.0 / 下限 0.1 clamp", () => {
    it("上限：importance 0.98 + 0.05 → 1.0（不超標）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.98,
        badRecallCount: 0,
        isUsed: true,
      });
      assert.strictEqual(result.newImportance, 1.0);
      assert.strictEqual(result.appliedBoost, true);
    });

    it("下限：importance 0.12 - 0.03（達門檻2，count 1→2）→ clamp 到 0.1", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.12,
        badRecallCount: 1,
        isUsed: false,
        minCountPenalty: 2,
      });
      // count 1→2，達門檻 2，penalty 0.12-0.03=0.09，clamp 到 0.1
      assert.strictEqual(result.newImportance, 0.1);
      assert.strictEqual(result.newBadRecallCount, 2);
      assert.strictEqual(result.appliedPenalty, true);
    });

    it("下限：importance 0.11 - 0.03（達門檻）→ 0.1（clamp）", () => {
      const result = applyImportanceFeedback({
        currentImportance: 0.11,
        badRecallCount: 1,
        isUsed: false,
        minCountPenalty: 2,
      });
      assert.strictEqual(result.newImportance, 0.1);
      assert.strictEqual(result.appliedPenalty, true);
    });

    it("下限：importance 0.1 再次未使用（達門檻）→ 仍是 0.1（不下調）", () => {
      // 到達下限後不應繼續下調
      const result = applyImportanceFeedback({
        currentImportance: 0.1,
        badRecallCount: 2,
        isUsed: false,
        minCountPenalty: 2,
      });
      // 0.1 - 0.03 = 0.07，但 clamp 到 0.1，與原始相同 → appliedPenalty=false
      assert.strictEqual(result.newImportance, 0.1);
      // 由於 newImp === imp，實際未做更新
    });

    it("importance 為 NaN 或 undefined → 預設 0.7 處理", () => {
      const r1 = applyImportanceFeedback({ currentImportance: NaN, badRecallCount: 0, isUsed: true });
      assert.strictEqual(r1.newImportance, 0.75); // 0.7 + 0.05

      const r2 = applyImportanceFeedback({ currentImportance: undefined, badRecallCount: 0, isUsed: true });
      assert.strictEqual(r2.newImportance, 0.75);
    });
  });

  // ── TC-5：Mock Store 整合驗證 ──
  describe("TC-5：Mock Store 整合驗證（patchMetadata + update 呼叫序列）", () => {
    it("使用回顧：patchMetadata 設 last_confirmed_use_at + bad_recall_count=0，update 寫新 importance", () => {
      const store = new MockMemoryStore();
      const now = 1710000000000;

      store.setRecord("mem-1", 0.7, {
        bad_recall_count: 2,
        last_confirmed_use_at: undefined,
      });

      const entry = store.get("mem-1");
      const isUsed = true;
      const boost = 0.05;

      // Phase 2: patchMetadata
      store.patchMetadata("mem-1", {
        last_confirmed_use_at: now,
        bad_recall_count: 0,
      });

      // Phase 3: update importance
      const newImp = Math.min(1.0, entry.importance + boost);
      if (newImp !== entry.importance) {
        store.update("mem-1", { importance: newImp });
      }

      assert.strictEqual(store.patchLog.length, 1);
      assert.strictEqual(store.patchLog[0].patch.last_confirmed_use_at, now);
      assert.strictEqual(store.patchLog[0].patch.bad_recall_count, 0);

      assert.strictEqual(store.updateLog.length, 1);
      assert.strictEqual(store.updateLog[0].importance, 0.75);
    });

    it("未使用：patchMetadata 只更新 bad_recall_count（未達門檻時不 call update importance）", () => {
      const store = new MockMemoryStore();

      store.setRecord("mem-2", 0.7, { bad_recall_count: 0 });

      const entry = store.get("mem-2");
      const isUsed = false;
      const newCount = 0 + 1; // count 0→1
      const minCount = 2;

      // Phase 2: patchMetadata
      store.patchMetadata("mem-2", { bad_recall_count: newCount });

      // Phase 3: 未達門檻，不 update importance
      if (newCount >= minCount) {
        store.update("mem-2", { importance: entry.importance - 0.03 });
      }

      assert.strictEqual(store.patchLog.length, 1);
      assert.strictEqual(store.patchLog[0].patch.bad_recall_count, 1);
      assert.strictEqual(store.updateLog.length, 0); // 未呼叫 update
    });

    it("未使用（達門檻）：patchMetadata + update 都呼叫", () => {
      const store = new MockMemoryStore();

      store.setRecord("mem-3", 0.7, { bad_recall_count: 1 });
      const entry = store.get("mem-3");
      const newCount = 1 + 1; // count 1→2
      const penalty = 0.03;

      store.patchMetadata("mem-3", { bad_recall_count: newCount });

      if (newCount >= 2) {
        store.update("mem-3", { importance: Math.max(0.1, entry.importance - penalty) });
      }

      assert.strictEqual(store.patchLog.length, 1);
      assert.strictEqual(store.patchLog[0].patch.bad_recall_count, 2);
      assert.strictEqual(store.updateLog.length, 1);
      assert.ok(Math.abs(store.updateLog[0].importance - 0.67) < 1e-9, `expected ~0.67, got ${store.updateLog[0].importance}`);
    });

    it("不在 auto-recall 結果中的 memory：不在 records 裡，get 回 null，不產生任何 log", () => {
      const store = new MockMemoryStore();
      store.setRecord("mem-4", 0.7, { bad_recall_count: 0 });

      // 嘗試操作不存在的 memory
      const entry = store.get("mem-999"); // 不存在

      if (entry) {
        store.patchMetadata("mem-999", { bad_recall_count: 1 });
        store.update("mem-999", { importance: 0.5 });
      }

      assert.strictEqual(entry, null);
      assert.strictEqual(store.patchLog.length, 0);
      assert.strictEqual(store.updateLog.length, 0);
    });
  });

  // ── TC-6：完整 lifecycle 模擬 ──
  describe("TC-6：完整 lifecycle 模擬（多次未使用 → 使用 → 再未使用）", () => {
    it("完整流程：初始 0.7 → 未使用×2（0.67）→ 使用（0.72）→ 未使用×1（0.72,count=1）", () => {
      let importance = 0.7;
      let badCount = 0;

      // 第1次未使用
      let r1 = applyImportanceFeedback({ currentImportance: importance, badRecallCount: badCount, isUsed: false });
      importance = r1.newImportance;
      badCount = r1.newBadRecallCount;
      assert.strictEqual(r1.newBadRecallCount, 1);
      assert.strictEqual(r1.appliedPenalty, false);

      // 第2次未使用（達門檻）
      let r2 = applyImportanceFeedback({ currentImportance: importance, badRecallCount: badCount, isUsed: false });
      importance = r2.newImportance;
      badCount = r2.newBadRecallCount;
      assert.ok(Math.abs(r2.newImportance - 0.67) < 1e-9, `expected ~0.67, got ${r2.newImportance}`);
      assert.strictEqual(r2.newBadRecallCount, 2);
      assert.strictEqual(r2.appliedPenalty, true);

      // 第3次使用（boost + 重置）
      let r3 = applyImportanceFeedback({ currentImportance: importance, badRecallCount: badCount, isUsed: true });
      importance = r3.newImportance;
      badCount = r3.newBadRecallCount;
      assert.ok(Math.abs(r3.newImportance - 0.72) < 1e-9, `expected ~0.72, got ${r3.newImportance}`); // 0.67 + 0.05
      assert.strictEqual(r3.newBadRecallCount, 0);
      assert.strictEqual(r3.appliedBoost, true);

      // 第4次未使用（count 0→1，未達門檻）
      let r4 = applyImportanceFeedback({ currentImportance: importance, badRecallCount: badCount, isUsed: false });
      assert.strictEqual(r4.newImportance, 0.72); // 不變
      assert.strictEqual(r4.newBadRecallCount, 1);
      assert.strictEqual(r4.appliedPenalty, false);
    });
  });
});
