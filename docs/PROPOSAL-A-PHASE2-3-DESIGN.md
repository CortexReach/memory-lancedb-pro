# Proposal A v3 - Phase 3 & Phase 4 完整設計稿

> **Phase 命名說明**：原本的 Phase 2/3 已重新命名為 Phase 3（可配置化）和 Phase 4（測試覆蓋）。Phase 1 和 Phase 2 已完成（見 PR #493）。



> 基於 PR #493 Phase 1 已實作內容，規劃 Phase 2（可配置化反饋幅度）與 Phase 3（測試覆蓋）

---

## Phase 2 完整設計稿

### 2.1 設計目標

Phase 2 的核心目標是將 Phase 1 中**硬編碼的反饋幅度**改為**可配置參數**，並新增 `min_recall_count` 閾值機制，來自 AliceLJY 的建議。

#### 設計動機

Phase 1 的 feedback logic 使用固定值：
- `importanceBoostOnUse = +0.05`（確認使用）
- `importanceBoostOnConfirm = +0.15`（明確確認）
- `importancePenaltyOnMiss = -0.03`（未使用 penalty）
- `importancePenaltyOnError = -0.10`（明確錯誤 penalty）

這些固定值缺乏彈性，無法適應不同使用場景（例如：高價值資訊需要更強的正向強化，噪聲記憶需要更激進的 penalty）。

#### Phase 2 預期成果

1. **所有 feedback 幅度參數化**，支援 plugin config 注入
2. **`min_recall_count` 閾值**：每個 recall 需要被提用至少 N 次才觸發 penalty
3. **重置策略**：一段時間無互動後自動重置 `bad_recall_count`

---

### 2.2 配置項詳細規格

#### 2.2.1 Feedback 幅度參數

| 參數名 | 類型 | 預設值 | 範圍 | 說明 |
|--------|------|--------|------|------|
| `importanceBoostOnUse` | `number` | `0.05` | `[0, 1]` | 確認使用時的 importance 增幅 |
| `importanceBoostOnConfirm` | `number` | `0.15` | `[0, 1]` | 明確確認時的增幅（高於 OnUse） |
| `importancePenaltyOnMiss` | `number` | `0.03` | `[0, 1]` | 未使用 penalty（應為負值） |
| `importancePenaltyOnError` | `number` | `0.10` | `[0, 1]` | 明確錯誤 penalty（應為負值） |

#### 2.2.2 min_recall_count 閾值參數

| 參數名 | 類型 | 預設值 | 範圍 | 說明 |
|--------|------|--------|------|------|
| `minRecallCountForPenalty` | `integer` | `3` | `[1, 100]` | 觸發 penalty 的最少 recall 次數門檻 |
| `minRecallCountForBoost` | `integer` | `1` | `[1, 100]` | 觸發 boost 的門檻（通常為 1） |

**設計說明**：
- `minRecallCountForPenalty=3` 表示：一個記憶必須被 recall 至少 3 次，才會在未使用時觸發 penalty
- 這防止「一次性查詢」的假 positive penalty
- `minRecallCountForBoost=1` 表示：只要 recall 一次就給予 boost（確認使用時）

#### 2.2.3 maxPenaltyCount 參數

| 參數名 | 類型 | 預設值 | 範圍 | 說明 |
|--------|------|--------|------|------|
| `maxPenaltyCount` | `integer` | `10` | `[1, 100]` | 最大 penalty 累加次數上限 |

**設計說明**：
- 避免 `bad_recall_count` 無限增長
- 達到上限後不再累加 penalty，但仍記錄
- 配合重要性 decay，防止記憶被過度惩罚而永遠無法恢復

#### 2.2.4 重置策略參數

| 參數名 | 類型 | 預設值 | 範圍 | 說明 |
|--------|------|--------|------|------|
| `badRecallResetHours` | `integer` | `168`（7天） | `[1, 8760]` | 無互動後重置 bad_recall_count（小時） |
| `badRecallResetOnAccess` | `boolean` | `true` | - | access 時是否重置（已存在） |
| `badRecallResetOnConfirm` | `boolean` | `true` | - | 明確確認時是否重置 |

**設計說明**：
- `badRecallResetHours`：session 結束後 7 天無互動才重置，適用於長期停用的 agent
- 重置為**漸進式**：每次重置時將 `bad_recall_count` 減半，而非一次性歸零
- 避免歷史 penalty 永遠影響新 session

---

### 2.3 配置 schema（parsePluginConfig）

在 `openclaw.plugin.json` 的 `configSchema.properties` 下新增 `feedbackConfig` 區塊：

```json
{
  "feedbackConfig": {
    "type": "object",
    "additionalProperties": false,
    "description": "Dynamic Importance Feedback Signals 配置（Proposal A v3 Phase 2）",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "啟用動態重要性反饋信號"
      },
      "importanceBoostOnUse": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.05,
        "description": "確認使用時的 importance 增幅"
      },
      "importanceBoostOnConfirm": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.15,
        "description": "明確確認時的增幅（高於 OnUse）"
      },
      "importancePenaltyOnMiss": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.03,
        "description": "未使用 penalty（應為正值，內部轉為負值）"
      },
      "importancePenaltyOnError": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.10,
        "description": "明確錯誤 penalty（應為正值，內部轉為負值）"
      },
      "minRecallCountForPenalty": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 3,
        "description": "觸發 penalty 的最少 recall 次數門檻"
      },
      "minRecallCountForBoost": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 1,
        "description": "觸發 boost 的最少 recall 次數門檻"
      },
      "maxPenaltyCount": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 10,
        "description": "最大 penalty 累加次數上限"
      },
      "badRecallResetHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 8760,
        "default": 168,
        "description": "無互動後重置 bad_recall_count（小時）"
      },
      "badRecallResetOnAccess": {
        "type": "boolean",
        "default": true,
        "description": "access 時重置 bad_recall_count"
      },
      "badRecallResetOnConfirm": {
        "type": "boolean",
        "default": true,
        "description": "明確確認時重置 bad_recall_count"
      }
    }
  }
}
```

**configSchema 驗證規則**：
1. `importanceBoostOnConfirm > importanceBoostOnUse`（驗證增幅層級）
2. `importancePenaltyOnError > importancePenaltyOnMiss`（驗證 penalty 層級）
3. `importancePenaltyOnMiss > 0` 和 `importancePenaltyOnError > 0`（接受正值，內部取反）

---

### 2.4 預設值策略

#### 2.4.1 預設值來源

預設值定義於 `src/config.ts` 的 `DEFAULT_FEEDBACK_CONFIG` 常數：

```typescript
export interface FeedbackConfig {
  enabled: boolean;
  importanceBoostOnUse: number;
  importanceBoostOnConfirm: number;
  importancePenaltyOnMiss: number;  //正值，內部取反
  importancePenaltyOnError: number;  //正值，內部取反
  minRecallCountForPenalty: number;
  minRecallCountForBoost: number;
  maxPenaltyCount: number;
  badRecallResetHours: number;
  badRecallResetOnAccess: boolean;
  badRecallResetOnConfirm: boolean;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  importanceBoostOnUse: 0.05,
  importanceBoostOnConfirm: 0.15,
  importancePenaltyOnMiss: 0.03,
  importancePenaltyOnError: 0.10,
  minRecallCountForPenalty: 3,
  minRecallCountForBoost: 1,
  maxPenaltyCount: 10,
  badRecallResetHours: 168,  // 7 days
  badRecallResetOnAccess: true,
  badRecallResetOnConfirm: true,
};
```

#### 2.4.2 預設值覆寫順序

```
plugin config (openclaw.plugin.json) 
  > DEFAULT_FEEDBACK_CONFIG
```

使用 `Object.assign(DEFAULT_FEEDBACK_CONFIG, parsedConfig)` 進行淺拷貝合併。

#### 2.4.3 向後相容策略

- 若 plugin config 中無 `feedbackConfig` 區塊，使用所有預設值
- Phase 1 的硬編碼值會被視為預設值（已定義於 `DEFAULT_FEEDBACK_CONFIG`）
- 無 breaking change

---

### 2.5 與 Phase 1 的銜接

#### 2.5.1 現有 Phase 1 實作位置

| 檔案 | 功能 | Phase 2 變更 |
|------|------|-------------|
| `src/retrieval-trace.ts` | 記錄 recall 事件 | 讀取 `feedbackConfig` 而非硬編碼 |
| `src/smart-metadata.ts` | `bad_recall_count` 欄位 | 新增 `last_bad_recall_at` 追蹤時間 |
| `src/reflection-slices.ts` | `isRecallUsed()` 判斷邏輯 | 保持不變（純判斷） |
| `src/tools.ts` | recall tool 回饋寫入 | 使用 `feedbackConfig` 的幅度參數 |

#### 2.5.2 關鍵實作變更

**1. 新增 `FeedbackConfigManager` 類別** (`src/feedback-config.ts`)

```typescript
export class FeedbackConfigManager {
  constructor(private config: FeedbackConfig) {}

  // 根據事件類型計算 importance 調整幅度
  computeImportanceDelta(
    event: 'use' | 'confirm' | 'miss' | 'error',
    currentRecallCount: number,
    currentBadRecallCount: number,
  ): number {
    // minRecallCountForPenalty 門檻檢查
    // maxPenaltyCount 上限檢查
    // 根據 event 類型返回調整幅度
  }

  // 檢查是否需要重置 bad_recall_count
  shouldResetBadRecall(
    lastBadRecallAt: number,
    lastAccessAt: number,
    lastConfirmAt: number,
  ): boolean {
    // badRecallResetHours 檢查
  }

  // 執行漸進式重置（減半）
  computeBadRecallReset(currentBadRecallCount: number): number {
    return Math.floor(currentBadRecallCount / 2);
  }
}
```

**2. 修改 `retrieval-trace.ts` 的 `recordRecallFeedback`**

```typescript
// 之前（Phase 1 硬編碼）
const boost = event === 'confirm' ? 0.15 : 0.05;

// Phase 2（可配置）
const boost = event === 'confirm' 
  ? this.config.importanceBoostOnConfirm 
  : this.config.importanceBoostOnUse;
```

**3. 修改 `tools.ts` 的 recall 回饋邏輯**

在 `memory_recall` tool 中，確認使用時：

```typescript
// Phase 2：使用 FeedbackConfigManager
const delta = feedbackManager.computeImportanceDelta(
  'use',  // or 'confirm', 'miss', 'error'
  meta.injected_count,  // recall count
  meta.bad_recall_count,
);

// 應用 importance 調整
const newImportance = clamp01(
  entry.importance + delta,
  entry.importance
);

// 檢查是否需要重置 bad_recall_count
if (feedbackManager.shouldResetBadRecall(...)) {
  patch.bad_recall_count = feedbackManager.computeBadRecallReset(meta.bad_recall_count);
}
```

---

### 2.6 驗證清單

#### 功能驗證

- [ ] `importanceBoostOnUse` 正確應用於確認使用場景
- [ ] `importanceBoostOnConfirm` 正確應用於明確確認場景
- [ ] `importancePenaltyOnMiss` 正確應用於未使用 penalty
- [ ] `importancePenaltyOnError` 正確應用於明確錯誤 penalty
- [ ] `minRecallCountForPenalty` 正確防止低頻 recall 的假 positive penalty
- [ ] `maxPenaltyCount` 正確限制 penalty 累加上限
- [ ] `badRecallResetHours` 正確觸發時間閾值重置
- [ ] 漸進式重置（減半）正確運作

#### 配置驗證

- [ ] `parsePluginConfig` 正確解析 `feedbackConfig` 區塊
- [ ] 缺少 `feedbackConfig` 時使用預設值（向後相容）
- [ ] schema 驗證規則正確攔截无效配置
- [ ] UI hints 正確顯示所有 feedback 參數

#### 邊界條件驗證

- [ ] `bad_recall_count` 達到 `maxPenaltyCount` 後不再增長
- [ ] `minRecallCountForPenalty > injected_count` 時不觸發 penalty
- [ ] `badRecallResetHours=0` 時禁用時間重置
- [ ] `importanceBoostOnConfirm < importanceBoostOnUse` 時報警（配置錯誤）

---

## Phase 3 完整設計稿

### 3.1 測試策略

#### 3.1.1 測試金字塔

```
        ┌─────────────┐
        │  Integration│  ← 跨模組時序 + 多 agent 場景
        │    Tests    │
        ├─────────────┤
        │   Unit      │  ← 純函數 + 配置解析 + 邊界條件
        │   Tests     │
        └─────────────┘
```

#### 3.1.2 測試框架

現有專案使用 Node.js 內建 `--test` runner + `assert` 模組，以及 `.mjs` 測試檔案（使用 `jiti` 進行 TypeScript import）。

Phase 3 測試將遵循相同模式：
- 單元測試：`test/feedback-config.test.mjs`
- 整合測試：`test/feedback-integration.test.mjs`

#### 3.1.3 測試隔離策略

- 每個測試使用獨立的 in-memory mock store
- 不依賴真實 LanceDB 連接
- 使用 `vi.useFakeTimers()` 模擬時間流逝（適用於重置策略測試）

---

### 3.2 單元測試規格

#### 3.2.1 FeedbackConfigManager 單元測試

**檔案**：`test/feedback-config.test.mjs`

```javascript
describe("FeedbackConfigManager", () => {
  describe("computeImportanceDelta", () => {
    // Test: use event with recallCount >= minRecallCountForBoost
    // Expected: returns importanceBoostOnUse

    // Test: confirm event
    // Expected: returns importanceBoostOnConfirm

    // Test: miss event with recallCount < minRecallCountForPenalty
    // Expected: returns 0 (no penalty)

    // Test: miss event with recallCount >= minRecallCountForPenalty
    // Expected: returns -importancePenaltyOnMiss

    // Test: error event
    // Expected: returns -importancePenaltyOnError

    // Test: badRecallCount >= maxPenaltyCount
    // Expected: returns 0 (max reached, no further penalty)

    // Test: importance stays within [0, 1] bounds
    // Expected: clamped correctly
  });

  describe("shouldResetBadRecall", () => {
    // Test: lastAccess within reset window
    // Expected: returns false

    // Test: lastAccess exceeds reset window
    // Expected: returns true

    // Test: lastConfirm within reset window
    // Expected: returns false

    // Test: badRecallResetHours=0 (disabled)
    // Expected: returns false
  });

  describe("computeBadRecallReset", () => {
    // Test: currentBadRecallCount = 10, reset to 5
    // Test: currentBadRecallCount = 1, reset to 0
    // Test: currentBadRecallCount = 0, stays 0
  });
});
```

#### 3.2.2 isRecallUsed() 單元測試

**檔案**：`test/recall-feedback.test.mjs`（擴展現有 `isRecallUsed` 測試）

```javascript
describe("isRecallUsed", () => {
  // 現有測試保持不變...

  // Phase 3 新增：
  describe("summary-based detection (Bug 1 fix)", () => {
    // Test: response contains verbatim summary
    // Expected: true

    // Test: response echoes summary content
    // Expected: true

    // Test: short summary (< 10 chars) ignored
    // Expected: false

    // Test: no summaries provided
    // Expected: falls back to ID-based detection
  });
});
```

#### 3.2.3 配置解析單元測試

**檔案**：`test/feedback-config-parse.test.mjs`

```javascript
describe("FeedbackConfig parsing", () => {
  // Test: valid full config
  // Expected: all values parsed correctly

  // Test: empty config (use defaults)
  // Expected: returns DEFAULT_FEEDBACK_CONFIG

  // Test: partial config (override only some fields)
  // Expected: merged correctly

  // Test: invalid importanceBoostOnConfirm < importanceBoostOnUse
  // Expected: schema validation error

  // Test: negative values
  // Expected: schema validation error

  // Test: out-of-range values
  // Expected: schema validation error
});
```

---

### 3.3 整合測試規格

#### 3.3.1 Recall Feedback 時序整合測試

**檔案**：`test/feedback-integration.test.mjs`

```javascript
describe("Recall Feedback Integration", () => {
  it("full lifecycle: recall -> miss -> penalty -> access -> reset", async () => {
    // 1. Create memory
    const memory = await store.store({ text: "test", vector: [0.1, 0.2], ... });
    
    // 2. Recall memory (injected_count = 1)
    await recallTool.execute({ query: "test" });
    
    // 3. Agent does NOT use it (isRecallUsed = false)
    // Expected: after session, bad_recall_count = 1
    
    // 4. Recall again (injected_count = 2), still not used
    // Expected: bad_recall_count = 2
    
    // 5. Recall 3rd time (injected_count = 3, reaches minRecallCountForPenalty=3)
    // Expected: penalty applied, importance decreases
    
    // 6. Agent uses it (isRecallUsed = true)
    // Expected: bad_recall_count resets to 0, importance boosts
  });

  it("maxPenaltyCount caps penalty accumulation", async () => {
    // Recall and miss 15 times (exceeds maxPenaltyCount=10)
    // Expected: bad_recall_count capped at 10
    // Expected: importance not decreased beyond max
  });

  it("badRecallResetHours triggers gradual reset", async () => {
    // Set bad_recall_count = 8
    // Advance time by 8 days (exceeds 7-day reset window)
    // Expected: after reset, bad_recall_count = 4 (halved)
  });
});
```

#### 3.3.2 多 Agent 並行場景整合測試

```javascript
describe("Multi-agent recall feedback", () => {
  it("agent A's recall doesn't affect agent B's feedback state", async () => {
    // Agent A recalls memory X but doesn't use it
    // Agent B recalls memory X and confirms use
    // Expected: memory X's bad_recall_count reflects B's confirm (reset)
    // Expected: Agent A's session doesn't see X as "used" based on B's confirm
  });

  it("parallel recalls with different outcomes", async () => {
    // Simulate 3 agents recalling the same memory simultaneously
    // 1 agent uses, 2 agents miss
    // Expected: mixed feedback logic applied correctly
  });
});
```

---

### 3.4 測試資料策略

#### 3.4.1 Mock Store 策略

```javascript
function createMockStore() {
  const entries = new Map();
  return {
    async store(entry) {
      const id = crypto.randomUUID();
      entries.set(id, { ...entry, id, metadata: entry.metadata || '{}' });
      return entries.get(id);
    },
    async getById(id) {
      return entries.get(id) || null;
    },
    async patchMetadata(id, patch) {
      const entry = entries.get(id);
      if (!entry) return false;
      const meta = JSON.parse(entry.metadata || '{}');
      entries.set(id, { ...entry, metadata: JSON.stringify({ ...meta, ...patch }) });
      return true;
    },
    async list() { return [...entries.values()]; },
  };
}
```

#### 3.4.2 時間模擬策略

```javascript
// 使用 Node.js --test runner 的 timers
test("time-based reset", { skip: process.version < 'v20.0.0' }, async (t) => {
  // 使用假的 Date.now() 或 vi.useFakeTimers()（如果可用）
});
```

---

### 3.5 驗證清單

#### 單元測試覆蓋

- [ ] `FeedbackConfigManager.computeImportanceDelta()` - 所有 event 類型
- [ ] `FeedbackConfigManager.shouldResetBadRecall()` - 所有重置條件
- [ ] `FeedbackConfigManager.computeBadRecallReset()` - 漸進式重置
- [ ] `isRecallUsed()` - summary-based detection edge cases
- [ ] `parseFeedbackConfig()` - schema 驗證
- [ ] 配置合併邏輯（partial config + defaults）

#### 整合測試覆蓋

- [ ] recall → miss → penalty 完整生命週期
- [ ] recall → confirm → boost 完整生命週期
- [ ] maxPenaltyCount 上限行為
- [ ] badRecallResetHours 時間閾值觸發
- [ ] 漸進式重置（減半）
- [ ] 多 agent 並行場景

#### 邊界條件測試

- [ ] `importance` clamped to [0, 1]
- [ ] `bad_recall_count` 不會變成負數
- [ ] `maxPenaltyCount = 0` 禁用 penalty
- [ ] `badRecallResetHours = 0` 禁用時間重置
- [ ] 空 `injectedIds` 和 `injectedSummaries` 的 fallback

#### 效能測試

- [ ] FeedbackConfigManager 不進行同步 I/O
- [ ] Mock store 模擬 1000+ entries 不超時

---

## 附錄：設計疑慮與修正

### 疑慮 1：漸進式重置是否足夠？

**問題**：使用 `bad_recall_count / 2` 的漸進式重置，如果計數為 1，會直接變成 0。這是否合理？

**修正方案**：
- 考慮使用 `max(0, floor(bad_recall_count * 0.5))`
- 或者引入 `badRecallResetFraction` 配置項（預設 0.5）控制重置比例
- 最終採納：`floor(count / 2)`，因為記憶的「未使用」是二元事件，count=1 表示只未使用過一次，歸零是合理的

### 疑慮 2：時間重置 vs Access 重置的優先順序

**問題**：`badRecallResetHours` 和 `badRecallResetOnAccess` 可能衝突。例如：設定 7 天重置，但 3 天後就 access 了。

**修正方案**：
- `badRecallResetOnAccess: true` 表示 access 時立即重置（覆蓋時間閾值）
- `badRecallResetOnAccess: false` 表示只信任時間閾值
- 兩者為 OR 關係：任一條件滿足即觸發重置

### 疑慮 3：multi-agent 場景下的 `bad_recall_count` 競爭

**問題**：多個 agent 對同一記憶有不同的 recall 歷史，bad_recall_count 的歸屬如何定義？

**修正方案**：
- Phase 2 保持 `bad_recall_count` 為記憶維度（memory-level），非 agent維度
- 每個 agent 的 recall 使用獨立的 `last_accessed_at` 和 `last_confirmed_use_at`
- 不同 agent 的 confirm 會讓 `last_confirmed_use_at` 變得更新，但 `bad_recall_count` 只有在「該 agent 自己的 session 未使用」時才增加
- 跨 agent 的 feedback 是獨立的，不會互相覆蓋

### 疑慮 4：Penalty 對 importance 的影響是否應該有下限？

**問題**：`importancePenaltyOnMiss` 可能讓 importance 降到 0，導致記憶永遠被忽略。

**修正方案**：
- Phase 2 設計：`importance` 最小值為 0.05（使用 `clamp01` 確保在 [0.05, 1] 範圍內）
- 或者引入 `minImportanceFloor` 配置項（預設 0.05）
- 最終採納：在 `clamp01` 的基礎上，額外確保 `minImportance = 0.05`

### 疑慮 5：Phase 1 的 `isRecallUsed` 是否有被正確使用？

**問題**：Phase 1 的 `isRecallUsed` 在 `reflection-slices.ts` 中，但 recall feedback 的觸發點在哪？

**澄清**：
- `isRecallUsed` 是在 **session reflection** 階段被調用，不是即時的
- 流程：recall → inject → agent response → isRecallUsed() → 寫回 feedback
- Phase 2 需要確保 `isRecallUsed` 的結果能觸發 `FeedbackConfigManager.computeImportanceDelta()`

### 修正後的配置 schema（完整版）

```json
{
  "feedbackConfig": {
    "type": "object",
    "additionalProperties": false,
    "description": "Dynamic Importance Feedback Signals 配置（Proposal A v3 Phase 2）",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true
      },
      "importanceBoostOnUse": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.05
      },
      "importanceBoostOnConfirm": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.15
      },
      "importancePenaltyOnMiss": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.03
      },
      "importancePenaltyOnError": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.10
      },
      "minRecallCountForPenalty": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 3
      },
      "minRecallCountForBoost": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 1
      },
      "maxPenaltyCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100,
        "default": 10
      },
      "badRecallResetHours": {
        "type": "integer",
        "minimum": 0,
        "maximum": 8760,
        "default": 168
      },
      "badRecallResetOnAccess": {
        "type": "boolean",
        "default": true
      },
      "badRecallResetOnConfirm": {
        "type": "boolean",
        "default": true
      },
      "minImportanceFloor": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.05,
        "description": "importance 的最小值，防止記憶被過度貶抑"
      }
    }
  }
}
```

---

## 實作優先順序

### Phase 2 實作順序

1. **第一階段**：新增 `FeedbackConfigManager` 類別 + 預設值
2. **第二階段**：修改 `openclaw.plugin.json` schema + UI hints
3. **第三階段**：修改 `retrieval-trace.ts` 使用配置化的幅度
4. **第四階段**：修改 `tools.ts` 的 recall 回饋邏輯
5. **第五階段**：新增時間重置邏輯

### Phase 3 實作順序

1. **第一階段**：撰寫 `FeedbackConfigManager` 單元測試
2. **第二階段**：擴展 `isRecallUsed` 單元測試
3. **第三階段**：撰寫配置解析測試
4. **第四階段**：撰寫整合測試（時序 + multi-agent）
