# 2026-05-15 每日記憶蒸餾

## PR #747 Review Response — Extraction Validation (Issue #693)

### 什麼做的
回應 GitHub PR #747 (Extraction write validation, Issue #693) 的 7 輪對抗審查，修复所有 Must Fix 和 Nice to Have 項目，並留言到 GitHub。

### 修復的項目

| 項目 | 檔案 | 修復內容 |
|------|------|---------|
| **F1** | `smart-extractor.ts` | bulkStore 錯誤隔離：單獨 try/catch，失敗立即拋出，不會被 count 失敗吸收 |
| **F3** | `smart-extractor.ts` | 支援 async callback：`Promise.resolve().then().catch()` 同時處理 sync/async |
| **F4** (T8) | `extraction-validation.test.mjs` | Negative mismatch mock 修正：`callCount === 1 ? raw : raw + 2`，真正產生 mismatch = -1 |
| **T9** (new) | `extraction-validation.test.mjs` | 測試 sync callback throwing 不會 abort extraction |
| **T10** (new) | `extraction-validation.test.mjs` | 測試 async callback 完成不 abort extraction |
| **F2** | `smart-extractor.ts` | SIGKILL/OOM 無法偵測明確標注為 Phase 2 限制 |
| **F5** | `ci-test-manifest.mjs` | Manifest 變更是 rebase repair（重新排序），非 scope expansion |
| **F6/MR1** | `memory-categories.ts` | mismatch direction 說明：negative over-write = concurrent session INSERT（不是 compactor DELETE） |
| **MR2** | `smart-extractor.ts` | `onExtractionValidationFailed` callback 使用 `ExtractionValidation` typed interface |
| **MR3** | `dedup-false-alarm.test.mjs` | `makeNearDuplicateVector` 移除 `Math.random()` 改固定 pattern，同時修復 `const` 重新賦值 bug |

### 重要教訓

**[學習] PR scope drift 診斷**
- 當 `git diff master..branch --stat` 顯示多檔案變更時，不能直接認定是 scope expansion
- 正確做法：找到 PR 的第一個 commit（feature commit），用 `git diff <feature-commit>..HEAD --stat` 對比
- 本次 PR：feature commit 是 `2965364`，所有修復只涉及 5 個檔案
- `index.ts`、`openclaw.plugin.json`、多個測試檔是 rebase artifact（base branch 和 master 差異），並非 PR 修改

**[學習] GitHub PR comment 留言的 `gh` 指令注意**
- 在 WSL 環境，gh CLI 需要 `HOME=/home/jlin53882` 才能正確找到 keyring
- `gh pr comment ... --body` 中的 markdown 含 backtick（`` ` ``）會被 bash 解釋
- 解決：用 `--body-file` 配合 `write_file` 寫入 temp file，避免 bash 解釋問題

**[學習] Negative mismatch mock 的正確寫法**
- 錯誤寫法：`raw + 2` 對 countBefore 和 countAfter 都加相同 offset → `actual = (3+2)-(3+2) = 0`，mismatch = 1（變成 positive）
- 正確寫法：`callCount === 1 ? raw : raw + 2` → countBefore=3，countAfter=5，`actual = 5-3 = 2`，`mismatch = 1-2 = -1`（negative）

**[學習] `const` 陣列重新賦值 bug**
- `const orth = [...]; orth = orth.map(...)` → TypeError: Assignment to constant variable
- 必須用 in-place mutation：`for (let i=0; i<dim; i++) orth[i] /= orthNorm;`

### PR 留言策略
- 主留言：表格對照所有 Must Fix / Nice to Have 項目
- 依檔案分開留言（F1/F3 在 `smart-extractor.ts`、MR1 在 `memory-categories.ts` 等）
- 最後加 scope verification comment 證明無 scope expansion

### 測試結果
```
extraction-validation.test.mjs: 10/10 PASS
dedup-false-alarm.test.mjs: 2/2 PASS
Total: 12/12 PASS
```

### Branch 狀態
- `issue/693-validation` (追蹤 `jlinfork/issue/693-validation`)
- 最新 commit: `7637a63` — "fix(extract): F2/F3/F5/F6/Nice-to-have review fixes"
- 已推送到 remote

### Commits（由新到舊）
| Commit | 說明 |
|--------|------|
| `7637a63` | F2/F3/F5/F6/Nice-to-have review fixes |
| `c8e1709` | MR1/MR2/MR3 review fixes |
| `79a49fc` | F1 bulkStore error isolation + T8 negative mismatch test fix |

### CI 登記確認
- `scripts/ci-test-manifest.mjs` 第 78-79 行
- `extraction-validation.test.mjs` (10 tests, `core-regression` group)
- `dedup-false-alarm.test.mjs` (2 tests, `core-regression` group)

### GitHub PR 留言（共 7 條）
1. 主留言 — 完整修復清單對照表 + 測試結果
2. `src/smart-extractor.ts` — F1 + F3
3. `src/memory-categories.ts` — MR1/MR6
4. `test/extraction-validation.test.mjs` — T8 + T10
5. `test/dedup-false-alarm.test.mjs` — MR3
6. `scripts/ci-test-manifest.mjs` — F5 scope drift 說明
7. Scope verification — 確認所有改動與 PR #747 直接相關

### 重要學習（已寫入 Hindsight）
- PR scope drift 正確診斷方法
- WSL gh CLI HOME 變數需求
- Negative mismatch mock 正確寫法
- bash heredoc 含 backtick 的陷阱
