# memory-lancedb-pro SDK 內部使用稽核

## 總覽

| 匯入位置 | 匯入類型 | 匯入內容 | 需遷移 |
|---------|---------|---------|--------|
| `index.ts:6` | `import type` | `OpenClawPluginApi` from `"openclaw/plugin-sdk"` | ❌ 不需要 |
| `src/tools.ts:7` | `import type` | `OpenClawPluginApi` from `"openclaw/plugin-sdk"` | ❌ 不需要 |
| `index.ts:500` | `await import()` | `openclaw/dist/extensionAPI.js` → `runEmbeddedPiAgent` | ✅ 需要（Bug 2） |
| 其他 hook API | `api.on()` / `api.registerHook()` | 標準 plugin API | ❌ 不需要 |

---

## 詳細分析

### 1. `import type { OpenClawPluginApi } from "openclaw/plugin-sdk"` — ❌ 不需要遷移

**為什麼不需要遷移：**

- `index.ts:6` 和 `src/tools.ts:7` 都是 **`import type`**（編譯期 only，無 runtime 成本）
- 根據 SDK Migration 文件，**被廢棄的是 runtime 匯入 subpaths**（`compat`、`infra-runtime`、`config-runtime`、`extension-api`）
- `"openclaw/plugin-sdk"` barrel 路徑本身作為 type import **不是廢棄目標**

**驗證：**
```typescript
// index.ts:6
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// src/tools.ts:7
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
```

兩者都是純 type 匯入，無 runtime import 鏈問題。

---

### 2. `await import("openclaw/dist/extensionAPI.js")` — ✅ 需要遷移（Bug 2）

**位置：** `index.ts:494-518` — `loadEmbeddedPiRunner()`

**現況：**
```typescript
// 動態匯入已廢棄的 extension-api
const mod = await import(specifier);  // specifier = "openclaw/dist/extensionAPI.js"
const runner = mod.runEmbeddedPiAgent;

// 用這個 runner 做 reflection
result = await runner({ sessionId, sessionKey, agentId, ... });
```

**遷移目標：**
```typescript
// 改用 api.runtime.agent.runEmbeddedPiAgent()
result = await api.runtime.agent.runEmbeddedPiAgent({ sessionId, sessionKey, agentId, ... });
```

**驗證狀態：**
- ✅ `api.runtime.agent.runEmbeddedPiAgent` 存在於所有 SDK 版本（4.22+）
- ✅ 參數完全對齊（11/11 參數型別一致）
- ✅ 回傳型別一致（早已用 `payloads[...].text` 處理）
- ✅ 舊 `extensionAPI.js` 在 4.26 SDK 仍保留（Layer 2 fallback 可用）
- ✅ SDK 內部 `llm-task` plugin 已遷移至此 API

---

### 3. Hook API 使用 — ❌ 不需要遷移

**使用的 Hooks：**

| Hook 名稱 | 用途 | 狀態 |
|-----------|------|------|
| `agent:bootstrap` | 確保 SELF_IMPROVEMENT_REMINDER.md 存在 | ✅ 有效 |
| `agent_end` | 自動擷取 agent 結束後的對話 | ✅ 有效 |
| `session_end` | Session 結束時處理待處理 injection | ✅ 有效 |
| `before_prompt_build` | Prompt 建構前注入記憶 context | ✅ 有效 |
| `after_tool_call` | Tool 呼叫後處理 injection | ✅ 有效 |
| `before_message_write` | 訊息寫入前稽核 | ✅ 有效 |
| `before_reset` | Reset 前建立 session summary | ✅ 有效 |
| `command:new` | 觸發 reflection（self-improvement） | ✅ 有效 |
| `command:reset` | 觸發 reflection（memory） | ✅ 有效 |
| `gateway_start` | Plugin 初始化 | ✅ 有效 |

**驗證方式：**
- SDK Hooks 文件（`hooks.md`）確認所有名稱都是有效 hooks
- `api.on(...)` 和 `api.registerHook(...)` 都是 `OpenClawPluginApi` 的標準方法

---

## 總結：memory-lancedb-pro 內部需要遷移的只有一件事

```
index.ts:500 — loadEmbeddedPiRunner() 動態 import
```

**其他所有 SDK 使用都是 type-only import 或標準 plugin API，不需要遷移。**

---

## 驗證方式（可在本地測試）

```bash
# 確認只有一個 dynamic import 是 openclaw 來的
grep -rn "await import\|import(" index.ts | grep openclaw
# 預期只有一個：loadEmbeddedPiRunner() 裡的 extensionAPI.js

# 確認只有兩個 type import 是 openclaw/plugin-sdk
grep -rn "import type.*openclaw" index.ts src/
# 預期兩個：index.ts:6 和 src/tools.ts:7
```
