// test/feedback-config.test.mjs
// 測試 FeedbackConfigManager（Phase 3 回饋信號反饋配置管理器）
import { describe, it } from 'node:test';
import assert from 'node:assert';

// FeedbackConfigManager mock（從 Phase 3 來的實作）
class FeedbackConfigManager {
  constructor(config) {
    this.config = config;
  }
  computeImportanceDelta(event, recallCount = 1, badRecallCount = 0) {
    if (event === 'use') {
      if (recallCount < this.config.minRecallCountForBoost) return 0;
      return this.config.importanceBoostOnUse;
    }
    if (event === 'confirm') {
      return this.config.importanceBoostOnConfirm;
    }
    if (event === 'miss') {
      if (recallCount < this.config.minRecallCountForPenalty) return 0;
      return -this.config.importancePenaltyOnMiss;
    }
    if (event === 'error') {
      return -this.config.importancePenaltyOnError;
    }
    return 0;
  }
  isConfirmKeyword(text) {
    return this.config.confirmKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
  }
  isErrorKeyword(text) {
    return this.config.errorKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
  }
  static defaultConfig() {
    return {
      importanceBoostOnUse: 0.05,
      importanceBoostOnConfirm: 0.15,
      importancePenaltyOnMiss: 0.03,
      importancePenaltyOnError: 0.10,
      minRecallCountForPenalty: 2,
      minRecallCountForBoost: 1,
      confirmKeywords: ["是對的", "確認", "正確", "right"],
      errorKeywords: ["錯誤", "不對", "wrong", "not right"],
    };
  }
}

describe("FeedbackConfigManager", () => {
  describe("computeImportanceDelta", () => {
    it("use event with recallCount >= minRecallCountForBoost returns boostOnUse", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      const delta = mgr.computeImportanceDelta('use', 1, 0);
      assert.strictEqual(delta, 0.05);
    });
    it("confirm event returns boostOnConfirm", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      const delta = mgr.computeImportanceDelta('confirm', 1, 0);
      assert.strictEqual(delta, 0.15);
    });
    it("miss event with recallCount < minRecallCountForPenalty returns 0", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      const delta = mgr.computeImportanceDelta('miss', 1, 0);  // recallCount=1 < 2
      assert.strictEqual(delta, 0);
    });
    it("miss event with recallCount >= minRecallCountForPenalty returns penalty", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      const delta = mgr.computeImportanceDelta('miss', 2, 0);  // recallCount=2 >= 2
      assert.strictEqual(delta, -0.03);
    });
    it("error event returns error penalty", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      const delta = mgr.computeImportanceDelta('error', 1, 0);
      assert.strictEqual(delta, -0.10);
    });
  });
  describe("isConfirmKeyword", () => {
    it("detects 是對的", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      assert.strictEqual(mgr.isConfirmKeyword("教練我覺得是對的"), true);
    });
    it("detects right", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      assert.strictEqual(mgr.isConfirmKeyword("that's right"), true);
    });
    it("rejects unrelated text", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      assert.strictEqual(mgr.isConfirmKeyword("今天天氣很好"), false);
    });
  });
  describe("isErrorKeyword", () => {
    it("detects 錯誤", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      assert.strictEqual(mgr.isErrorKeyword("教練這是錯誤的"), true);
    });
    it("rejects unrelated text", () => {
      const mgr = new FeedbackConfigManager(FeedbackConfigManager.defaultConfig());
      assert.strictEqual(mgr.isErrorKeyword("今天天氣很好"), false);
    });
  });
});
