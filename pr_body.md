## 問題背景

**PR #430**（已關閉）嘗試解決 Hook handler 累積問題，但 scope 太大（+207/-372 行）被關閉。現有 WeakSet guard（`index.ts:1855`）只能阻擋相同 API 實例，無法防止新 API 實例重複註冊。

**Issue #610** 是基於 PR #430 設計稿的接續追蹤 issue。

---

## 本 PR 處理的內容（基於 PR #603）

本 PR 從官方 `CortexReach/memory-lancedb-pro` 的 PR #603 cherry-pick 而來，實作了以下 5 個 memory leak 修復：

### 1. Store.ts：Promise Chain 無限增長（CRITICAL）
- **問題**：`updateQueue` promise chain 無限增長，寫入速度快於完成時 heap 飆升
- **修復**：廢除 promise chain，改用 `_updating` boolean flag + FIFO `_waitQueue`
- **效果**：Tail-reset semaphore，記憶體恆定

### 2. AccessTracker：Failed ID 累積（HIGH）
- **問題**：寫入失敗的 ID 每次 flush 都累積 delta，map 無限增長
- **修復**：分離 `_retryCount` map，設 `_maxRetries=5` 上限，超過後 drop
- **效果**：失敗 ID 不會無限重試

### 3. Embedder.ts：TTL 只在 access 清理（MEDIUM）
- **問題**：過期 entry 只在 access 時時刪除，閒置 entry 佔用記憶體
- **修復**：每次 `set()` 時若 near capacity 就呼叫 `_evictExpired()` 清理過期 entry
- **效果**：快取容量有上限

### 4. RetrievalStats.ts：O(n) shift（MEDIUM）
- **問題**：`Array.shift()` 是 O(n)，1000 筆資料時每次搬遷造成 GC 壓力
- **修復**：改用 Ring Buffer，O(1) 寫入
- **效果**：無 GC 壓力

### 5. NoisePrototypeBank：DEDUP_THRESHOLD 0.95→0.90（MEDIUM）
- **問題**：0.95 threshold 太寬鬆，near-duplicate noise 持續累積
- **修復**：降低至 0.90，更接近實際 `isNoise()` threshold 0.82
- **效果**：noise bank 不會被 near-duplicate 填滿

---

## 驗證

- `test/issue598_smoke.mjs` 煙霧測試已加入
- 原始 PR #603 的所有 commit 已 cherry-pick：`cd695ba` → `30c6dc9` → `810adf9`

---

## 相關連結

- Issue #598（原始）：https://github.com/CortexReach/memory-lancedb-pro/issues/598
- Issue #610（新設計追蹤）：https://github.com/CortexReach/memory-lancedb-pro/issues/610
- PR #430（已關閉）：https://github.com/CortexReach/memory-lancedb-pro/pull/430
- PR #603（官方）：https://github.com/CortexReach/memory-lancedb-pro/pull/603