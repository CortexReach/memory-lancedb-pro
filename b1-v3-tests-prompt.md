# B-1 v3 測試補充任務

## 工作目錄
`C:\Users\admin\Desktop\b1-v3-fix`

## 當前任務
在 `test/b1-bm25-expansion.test.mjs` 底部現有的 describe("Edge cases") 區塊中，新增以下測試案例。

## 現有覆蓋缺口分析

現有測試覆蓋：
- D1, D2, D3, D4, D6, Issue 2 (reflection filter), Fail-safe, Edge (empty, derived > 16)

**缺口（必須全部補上）：**

### 缺口 1：derived.length === 16 → MAX_NEIGHBORS = 0 → 直接 early return
```javascript
it("should skip expansion and return first 16 derived when derived.length === 16", async () => {
  // derived.length === 16 → MAX_NEIGHBORS = 0 → early return
  // bm25Search should NOT be called
  let callCount = 0;
  const store = {
    async bm25Search() { callCount++; return []; },
  };
  const api = createMockApi();
  const derived = Array.from({ length: 16 }, (_, i) => `derived ${i}`);
  const result = await expandDerivedWithBm25(derived, ["global"], store, api);
  assert.equal(callCount, 0, "bm25Search should not be called when MAX_NEIGHBORS <= 0");
  assert.equal(result.length, 16);
});
```

### 缺口 2：bm25Search returns empty hits（所有 derived 都沒有 neighbors）
```javascript
it("should return derived unchanged when all bm25Search calls return empty", async () => {
  const store = {
    async bm25Search() { return []; },
  };
  const api = createMockApi();
  const derived = ["derived A", "derived B"];
  const result = await expandDerivedWithBm25(derived, ["global"], store, api);
  assert.deepStrictEqual(result, ["derived A", "derived B"]);
});
```

### 缺口 3：bm25Search returns < 2 hits（每個 derived 少於 2 個 neighbors）
```javascript
it("should handle bm25Search returning fewer than 2 hits per query", async () => {
  const store = {
    async bm25Search(query) {
      if (query === "derived1") {
        return [{ entry: { id: "n1", text: "neighbor one", category: "fact", scope: "global" } }];
      }
      return [];
    },
  };
  const api = createMockApi();
  const result = await expandDerivedWithBm25(["derived1", "derived2"], ["global"], store, api);
  assert.strictEqual(result[0], "neighbor one");
  assert.strictEqual(result[1], "derived1");
  assert.strictEqual(result[2], "derived2");
});
```

### 缺口 4：neighbors + derived === 16 exactly（精確邊界）
```javascript
it("should handle neighbors + derived === 16 exactly (no truncation)", async () => {
  // 14 base derived + 2 neighbors = 16 exactly
  const store = createMockStore([
    { entry: { id: "n1", text: "neighbor one", category: "fact", scope: "global" } },
    { entry: { id: "n2", text: "neighbor two", category: "fact", scope: "global" } },
  ]);
  const api = createMockApi();
  const derived = Array.from({ length: 14 }, (_, i) => `derived ${i}`);
  const result = await expandDerivedWithBm25(derived, ["global"], store, api);
  assert.equal(result.length, 16, `Expected exactly 16, got ${result.length}`);
  assert.strictEqual(result[0], "neighbor one");
  assert.strictEqual(result[1], "neighbor two");
  assert.strictEqual(result[2], "derived 0");
});
```

### 缺口 5：neighbors 達到 MAX_NEIGHBORS 後 loop 正確中斷
```javascript
it("should stop after reaching MAX_NEIGHBORS even if more derived lines exist", async () => {
  // derived.length = 10 → MAX_NEIGHBORS = 6
  // Each derived returns 2 hits, so after 3 derived lines we have 6 neighbors
  // 4th derived line should NOT contribute (loop breaks)
  let callCount = 0;
  const store = {
    async bm25Search() {
      callCount++;
      return [
        { entry: { id: `n${callCount}-a`, text: `neighbor ${callCount}a`, category: "fact", scope: "global" } },
        { entry: { id: `n${callCount}-b`, text: `neighbor ${callCount}b`, category: "fact", scope: "global" } },
      ];
    },
  };
  const api = createMockApi();
  const derived = ["d1", "d2", "d3", "d4", "d5"];
  const result = await expandDerivedWithBm25(derived, ["global"], store, api);
  // MAX_NEIGHBORS = 6, after 3 derived lines (2+2+2=6), loop breaks
  assert.equal(callCount, 3, `Expected 3 bm25Search calls, got ${callCount}`);
  assert.equal(result.length, 16); // 6 neighbors + 10 base = 16
});
```

### 缺口 6：null / undefined entry.text → 空字串（OR "" 保護）
```javascript
it("should handle null entry.text gracefully (OR '' guard)", async () => {
  const store = createMockStore([
    { entry: { id: "n1", text: null, category: "fact", scope: "global" } },
    { entry: { id: "n2", text: undefined, category: "fact", scope: "global" } },
    { entry: { id: "n3", text: "valid text", category: "fact", scope: "global" } },
  ]);
  const api = createMockApi();
  const result = await expandDerivedWithBm25(["derived1"], ["global"], store, api);
  // null/undefined text → "" after || "" → should appear as ""
  const emptyCount = result.filter(t => t === "").length;
  assert.equal(emptyCount, 2, "null/undefined texts should become empty strings");
  assert.ok(result.includes("valid text"), "valid text should be preserved");
});
```

### 缺口 7：text 去重邏輯的邊界行為（不同 entry.id 但相同 120-char snippet）
```javascript
it("should dedupe by text snippet, not by entry.id", async () => {
  // Two different entries with same first 120 chars
  const samePrefix = "a".repeat(120);
  const store = createMockStore([
    { entry: { id: "id1", text: samePrefix + " — extra detail for id1", category: "fact", scope: "global" } },
    { entry: { id: "id2", text: samePrefix + " — extra detail for id2", category: "fact", scope: "global" } },
  ]);
  const api = createMockApi();
  const result = await expandDerivedWithBm25(["derived1"], ["global"], store, api);
  // Both truncate to same 120-char prefix → deduped to 1
  const firstResult = result[0];
  assert.ok(firstResult.startsWith(samePrefix));
  // After 120-char truncation both are identical, so second should be deduped
  const count = result.filter(t => t.startsWith(samePrefix)).length;
  assert.equal(count, 1, "Two entries with same 120-char prefix should be deduped to 1");
});
```

## 執行步驟

1. 在 `test/b1-bm25-expansion.test.mjs` 的 `describe("Edge cases")` 區塊內，在現有兩個測試（empty array、derived > 16 items）**之後**，新增上述 7 個測試案例
2. 運行 `node --test test/b1-bm25-expansion.test.mjs` 驗證
3. 全部通過後 amend commit

## 重要提醒
- 只修改 `test/b1-bm25-expansion.test.mjs`，不要動其他檔案
- 不要修改 `src/bm25-expansion.ts` 的實作
- 如果發現任何測試失敗（預期外的 fail），記錄下來回報
- Amend 時 message 保持相同：`feat(B-1): Scope-aware BM25 neighbor expansion for reflection slices (v3)`
