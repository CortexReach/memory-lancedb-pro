# PR #426 import-markdown 完整分析報告

> 日期：2026-03-31
> 目標：PR #426（CortexReach/memory-lancedb-pro）
> 狀態：分析完成，待 James 決定是否實作

---

## 一、PR 重要性

**解決 Issue #344：dual-memory 架構的根本矛盾**

memory-lancedb-pro 有兩層記憶，但長期是斷裂的：
- **Markdown 層**（`MEMORY.md`、`memory/`）→ 人類可讀，agent 持續寫入
- **LanceDB 層**（向量資料庫）→ recall 只查這裡

結果：重要的記憶寫進 Markdown 了，但搜尋時根本找不到。

`import-markdown` 把兩層打通，讓所有歷史累積的 Markdown 記憶搬進 LanceDB，成為一套完整的 workflow。

---

## 二、PR 現況摘要

| 項目 | 內容 |
|------|------|
| PR 連結 | https://github.com/CortexReach/memory-lancedb-pro/pull/426 |
| 標題 | `feat: add import-markdown CLI command` |
| 狀態 | `OPEN`（等待 Codex/maintainer 審查） |
| 作者 | `jlin53882`（James 的帳號）|
| 主要實作 | `cli.ts` +125 行，`import-markdown` 子命令 |
| 觸發來源 | Issue #344（dual-memory 混淆）|

---

## 三、實測測試結果

**測試封包位置：** `C:\Users\admin\Desktop\memory-lancedb-pro-import-markdown-test`
**執行方式：** `npm test`（`tsx test-runner.ts`）

### 3.1 全部測試結果（12 項，共 30 個 assert）

| # | 測試項目 | 結果 |
|---|----------|------|
| 1 | 檔案路徑解析（MEMORY.md + daily notes） | ✅ |
| 2 | 錯誤處理（目錄不存在、無 embedder、空目錄） | ✅ |
| 3 | 重複偵測（現狀 + Strategy B 驗證） | ✅ |
| 4 | Scope 處理與 metadata.sourceScope | ✅ |
| 5 | 批次處理（500 項目、OOM 測試） | ✅ |
| 6 | Dry-run 日誌輸出 | ✅ |
| 7 | Dry-run 與實際匯入一致性 | ✅ |
| 8 | 測試覆蓋（跳過邏輯、importance/category 預設） | ✅ |
| 9 | 其他 Markdown bullet 格式（`* `、`+ `、數字列表） | ⚠️ 揭示缺口 |
| 10 | UTF-8 BOM 處理 | ⚠️ 揭示缺口 |
| 11 | 部分失敗 + continueOnError | ✅ |
| 12 | 真實記憶檔案 + dedup 效益分析 | ✅ |

---

## 四、真實檔案效益分析

**測試資料：**
- `~/.openclaw/workspace-dc-channel--1476866394556465252/`
- MEMORY.md：20 筆記錄
- memory/：30 個 daily notes，共 633 筆記錄
- **合計：653 筆記錄**

### Scenario A：無 dedup（現在的行為）

```
第一次匯入：644 筆記錄
第二次匯入：+644 筆記錄（完全重複！）
浪費比例：50%
```

### Scenario B：有 dedup（加功能後的行為）

```
第一次匯入：644 筆記錄
第二次匯入：全部 skip → 節省 644 次 embedder API 呼叫
節省比例：50% embedder API 費用
```

**結論：** 每執行 2 次 import-markdown，可節省 644 次 embedder 呼叫。若每週執行一次，每月節省約 0.13 USD（視 embedder 定價）。

---

## 五、程式碼缺口分析（3 個真的問題）

### 缺口 1：其他 Markdown bullet 格式不支援

**根因：** 只檢查 `line.startsWith("- ")`

**修法：**
```typescript
// 現在（只認 - ）
if (!line.startsWith("- ")) continue;

// 改為（支援 - * +）
if (!/^[-*+]\s/.test(line)) continue;
// 數字列表再加：/^\d+\.\s/
```

**嚴重程度：** 低（目前只處理 `- ` 是合理假設，但嚴格來說應支援 Obsidian/標準 Markdown 全格式）

---

### 缺口 2：UTF-8 BOM 破壞第一行解析

**根因：** Windows 編輯器（如記事本）產生的檔案帶 BOM (`\uFEFF`)，讀取後未清除

**修法：**
```typescript
const content = await readFile(filePath, "utf-8");
const normalized = content.replace(/^\uFEFF/, ""); // 加這行
const lines = normalized.split(/\r?\n/);
```

**嚴重程度：** 中（Windows 環境常見，會造成第一筆記錄被漏掉或誤判）

---

### 缺口 3：CRLF 行結尾 `\r` 殘留

**根因：** Windows 行結尾是 `\r\n`，`split("\n")` 後行尾留 `\r`，可能干擾 text 比對

**修法：**
```typescript
// 現在
const lines = content.split("\n");

// 改為
const lines = content.split(/\r?\n/);
// 同時支援 CRLF (\r\n) 和 LF (\n)
```

**嚴重程度：** 低（實際比對時 `\r` 在行尾，不影響內容主體，但精確比對時可能有問題）

---

## 六、建議新增的 Config 欄位（共 5 項）

> 所有預設值 = 現在的 hardcode 值，向下相容，舊用戶不受影響

| 設定 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `importMarkdown.dedup` | boolean | `false` | 開啟 scope-aware exact match 去重 |
| `importMarkdown.defaultScope` | string | `"global"` | 沒有 --scope 時的預設 scope |
| `importMarkdown.minTextLength` | number | `5` | 最短文字長度門檻 |
| `importMarkdown.importanceDefault` | number | `0.7` | 匯入記錄的預設 importance |
| `importMarkdown.workspaceFilter` | string[] | `[]`（全部掃）| 只匯入指定的工作區名稱 |

### Config 片段建議

```yaml
importMarkdown:
  dedup: false              # 預設不開，保持舊行為相容
  dedupThreshold: 1.0       # 1.0 = exact match only
  defaultScope: "global"
  minTextLength: 5
  continueOnError: true     # 預設為 true（現在已如此）
  importanceDefault: 0.7
  workspaceFilter: []       # 空 = 掃全部，非空 = 只掃指定名稱
```

---

## 七、推薦實作的 --dedup 邏輯

```typescript
// 在 importMarkdown() 內，store 前加這段
if (options.dedup) {
  const existing = await context.store.bm25Search(text, 1, [targetScope]);
  if (existing.length > 0 && existing[0].entry.text === text) {
    skipped++;
    console.log(`  [skip] already imported: ${text.slice(0, 60)}...`);
    continue; // 跳過，不 call embedder + store
  }
}
```

**代價：** 每筆多一次 BM25 查詢（~10-50ms），但節省了 embedder API 費用。

---

## 八、Dry-run 模式

目前已實作，完整對應真實匯入行為：
- imported/skipped 數量與實際匯入完全一致
- 不寫入任何 store 記錄
- 適合用來預覽即將匯入的內容

---

## 九、功能條列式說明

```
import-markdown CLI 功能規格

═══════════════════════════════════════════════

功能：import-markdown
說明：將 Markdown 記憶（MENORY.md、memory/YYYY-MM-DD.md）遷移到 LanceDB

───────────────────────────────────────
CLI 參數
───────────────────────────────────────

--dry-run
  型別：flag
  說明：預覽模式，不實際寫入

--scope <scope>
  型別：string
  說明：指定匯入的目標 scope（預設：global）

--openclaw-home <path>
  型別：string
  說明：指定 OpenClaw home 目錄（預設：~/.openclaw）

<workspace-glob>
  型別：string
  說明：只掃特定名稱的 workspace（如 "dc-channel"）

───────────────────────────────────────
建議新增的 Config 欄位（共 5 項）
───────────────────────────────────────

1. importMarkdown.dedup
   型別：boolean
   預設：false
   說明：匯入前檢查是否已有相同文字的記憶（scope-aware exact match）
         false = 不檢查，每次匯入都產生新 entry
         true  = 先查同 scope 是否有相同文字，有則 skip

2. importMarkdown.defaultScope
   型別：string
   預設：global
   說明：沒有 --scope 參數時，匯入記憶的目標 scope
         指令列參數 --scope 的優先序高於此設定

3. importMarkdown.minTextLength
   型別：number
   預設：5
   說明：跳過短於此字數的記憶項目

4. importMarkdown.importanceDefault
   型別：number
   預設：0.7
   說明：匯入記憶的預設 importance 值（0.0 ~ 1.0）

5. importMarkdown.workspaceFilter
   型別：string[]
   預設：[]（掃全部）
   說明：只匯入指定名稱的 workspace，空陣列 = 全部掃

═══════════════════════════════════════════════
```

---

## 十、相關連結

- PR #426：https://github.com/CortexReach/memory-lancedb-pro/pull/426
- Issue #344：https://github.com/CortexReach/memory-lancedb-pro/issues/344
- PR #367：https://github.com/CortexReach/memory-lancedb-pro/pull/367（已 merge，文件 + startup warning）
- 測試封包：`C:\Users\admin\Desktop\memory-lancedb-pro-import-markdown-test`
