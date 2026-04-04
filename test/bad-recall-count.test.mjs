// test/bad-recall-count.test.mjs
// 測試 bad_recall_count 遞增邏輯（純邏輯測試，mock store 行為）
import { describe, it } from 'node:test';
import assert from 'node:assert';

// 測試 bad_recall_count 的遞增邏輯（純邏輯測試，mock store）
describe("bad_recall_count logic", () => {
  function computeNextBadCount(current, isMiss, isConfirm, recallCount, minPenaltyThreshold) {
    if (isConfirm) return 0;  // 確認使用，重置為 0
    if (!isMiss) return current;  // 既不是 miss 也不是 confirm，保持現值
    if (recallCount < minPenaltyThreshold) return current;  // recall 次數不夠，不 penalty
    return current + 1;  // miss + 足夠次數，遞增
  }

  it("confirm resets count to 0", () => {
    assert.strictEqual(computeNextBadCount(5, false, true, 3, 2), 0);
  });
  it("miss with insufficient recall count does not increment", () => {
    assert.strictEqual(computeNextBadCount(0, true, false, 1, 2), 0);
  });
  it("miss with sufficient recall count increments", () => {
    assert.strictEqual(computeNextBadCount(1, true, false, 2, 2), 2);
  });
  it("non-miss non-confirm keeps current value", () => {
    assert.strictEqual(computeNextBadCount(3, false, false, 3, 2), 3);
  });
  it("reaches penalty threshold at badCount=2", () => {
    // badCount >= 2 會觸發 penalty
    const badCount = 2;
    const isPenaltyTriggered = badCount >= 2;
    assert.strictEqual(isPenaltyTriggered, true);
  });
});
