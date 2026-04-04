// test/isRecallUsed.test.mjs
// 測試 isRecallUsed() 函式 - 判斷回應是否實際使用了注入的記憶 ID 或摘要
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isRecallUsed } from '../src/reflection-slices.ts';

describe("isRecallUsed", () => {
  it("returns false for short response (<=24 chars)", () => {
    assert.strictEqual(isRecallUsed("hi", ["id1"], []), false);
  });
  it("returns false when both injectedIds and injectedSummaries are empty", () => {
    assert.strictEqual(isRecallUsed("這是一個很長的回應內容這是", [], []), false);
  });
  it("returns true when injected ID is present AND usage marker is present", () => {
    const response = "教練我記得這件事 memory id-abc123";
    const injectedIds = ["id-abc123"];
    assert.strictEqual(isRecallUsed(response, injectedIds, []), true);
  });
  it("returns false when only ID is present but no usage marker", () => {
    const response = "我提到了id-abc123這個項目";
    const injectedIds = ["id-abc123"];
    assert.strictEqual(isRecallUsed(response, injectedIds, []), false);
  });
  it("returns false when only usage marker is present but no ID", () => {
    const response = "教練我記得這件事但沒有提到任何ID";
    const injectedIds = ["id-abc123"];
    assert.strictEqual(isRecallUsed(response, injectedIds, []), false);
  });
  it("returns true for verbatim summary match (>=10 chars)", () => {
    // 回應長度 > 24，且包含已注入摘要（摘要為回應的子字串，且 >= 10 字元）
    const response = "教練xx這是關於Python的import機制的詳細說明";
    const injectedIds = [];
    const injectedSummaries = ["這是關於Python的import機制的詳細說明"];
    assert.strictEqual(isRecallUsed(response, injectedIds, injectedSummaries), true);
  });
  it("returns false for short summary (<10 chars)", () => {
    const response = "教練提到了test這個詞";
    const injectedIds = [];
    const injectedSummaries = ["test"];
    assert.strictEqual(isRecallUsed(response, injectedIds, injectedSummaries), false);
  });
});
