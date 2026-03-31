<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) 智慧體的 AI 記憶助理**

*讓你的 AI 智慧體擁有真正的記憶力——跨工作階段、跨智慧體、跨時間。*

基於 LanceDB 的 OpenClaw 長期記憶外掛，自動儲存偏好、決策和專案上下文，在後續工作階段中自動回憶。

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## 為什麼選 memory-lancedb-pro？

大多數 AI 智慧體都有「失憶症」——每次新對話，之前聊過的全部清零。

**memory-lancedb-pro** 是 OpenClaw 的生產級長期記憶外掛，把你的智慧體變成一個真正的 **AI 記憶助理**——自動擷取重要資訊，讓雜訊自然衰減，在恰當的時候回憶起恰當的內容。無需手動標記，無需複雜設定。

### AI 記憶助理實際效果

**沒有記憶——每次都從零開始：**

> **你：** 「縮排用 tab，所有函式都要加錯誤處理。」
> *（下一次工作階段）*
> **你：** 「我都說了用 tab 不是空格！」 😤
> *（再下一次工作階段）*
> **你：** 「……我真的說了第三遍了，tab，還有錯誤處理。」

**有了 memory-lancedb-pro——你的智慧體學會了、記住了：**

> **你：** 「縮排用 tab，所有函式都要加錯誤處理。」
> *（下一次工作階段——智慧體自動回憶你的偏好）*
> **智慧體：** *（默默改成 tab 縮排，並補上錯誤處理）* ✅
> **你：** 「上個月我們為什麼選了 PostgreSQL 而不是 MongoDB？」
> **智慧體：** 「根據我們 2 月 12 日的討論，主要原因是……」 ✅

這就是 **AI 記憶助理** 的價值——學習你的風格，回憶過去的決策，提供個人化的回應，不再讓你重複自己。

### 還能做什麼？

| | 你能得到的 |
|---|---|
| **自動擷取** | 智慧體從每次對話中學習——不需要手動呼叫 `memory_store` |
| **智慧擷取** | LLM 驅動的 6 類分類：使用者輪廓、偏好、實體、事件、案例、模式 |
| **智慧遺忘** | Weibull 衰減模型——重要記憶留存，雜訊自然消退 |
| **混合檢索** | 向量 + BM25 全文搜尋，融合交叉編碼器重排序 |
| **上下文注入** | 相關記憶在每次回覆前自動浮現 |
| **多作用域隔離** | 按智慧體、按使用者、按專案隔離記憶邊界 |
| **任意服務商** | OpenAI、Jina、Gemini、Ollama 或任意 OpenAI 相容 API |
| **完整工具鏈** | CLI、備份、遷移、升級、匯入匯出——生產可用 |

---

## 快速開始

### 方式 A：一鍵安裝指令碼（推薦）

社群維護的 **[安裝指令碼](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** 一條指令搞定安裝、升級和修復：

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> 指令碼涵蓋的完整場景和其他社群工具，詳見下方 [生態工具](#生態工具)。

### 方式 B：手動安裝

**透過 OpenClaw CLI（推薦）：**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**或透過 npm：**
```bash
npm i memory-lancedb-pro@beta
```
> 如果用 npm 安裝，你還需要在 `openclaw.json` 的 `plugins.load.paths` 中新增外掛安裝目錄的 **絕對路徑**。這是最常見的安裝問題。

在 `openclaw.json` 中新增設定：

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 2,
          "extractMaxChars": 8000,
          "sessionMemory": { "enabled": false }
        }
      }
    }
  }
}
```

**為什麼用這些預設值？**
- `autoCapture` + `smartExtraction` → 智慧體自動從每次對話中學習
- `autoRecall` → 相關記憶在每次回覆前自動注入
- `extractMinMessages: 2` → 正常兩輪對話即觸發擷取
- `sessionMemory.enabled: false` → 避免工作階段摘要在初期汙染檢索結果

驗證並重啟：

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

你應該能看到：
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

完成！你的智慧體現在擁有長期記憶了。

<details>
<summary><strong>更多安裝路徑（現有使用者、升級）</strong></summary>

**已在使用 OpenClaw？**

1. 在 `plugins.load.paths` 中新增外掛的 **絕對路徑**
2. 繫結記憶插槽：`plugins.slots.memory = "memory-lancedb-pro"`
3. 驗證：`openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**從 v1.1.0 之前的版本升級？**

```bash
# 1) 備份
openclaw memory-pro export --scope global --output memories-backup.json
# 2) 試執行
openclaw memory-pro upgrade --dry-run
# 3) 執行升級
openclaw memory-pro upgrade
# 4) 驗證
openclaw memory-pro stats
```

詳見 [`CHANGELOG-v1.1.0.md`](docs/CHANGELOG-v1.1.0.md) 了解行為變更和升級說明。

</details>

<details>
<summary><strong>Telegram Bot 快速匯入（點選展開）</strong></summary>

如果你在使用 OpenClaw 的 Telegram 整合，最簡單的方式是直接給主 Bot 發訊息，而不是手動編輯設定檔。

以下為英文原文，方便直接複製傳送給 Bot：

```text
Help me connect this memory plugin with the most user-friendly configuration: https://github.com/CortexReach/memory-lancedb-pro

Requirements:
1. Set it as the only active memory plugin
2. Use Jina for embedding
3. Use Jina for reranker
4. Use gpt-4o-mini for the smart-extraction LLM
5. Enable autoCapture, autoRecall, smartExtraction
6. extractMinMessages=2
7. sessionMemory.enabled=false
8. captureAssistant=false
9. retrieval mode=hybrid, vectorWeight=0.7, bm25Weight=0.3
10. rerank=cross-encoder, candidatePoolSize=12, minScore=0.6, hardMinScore=0.62
11. Generate the final openclaw.json config directly, not just an explanation
```

</details>

---

## 生態工具

memory-lancedb-pro 是核心外掛。社群圍繞它建構了配套工具，讓安裝和日常使用更加順暢：

### 安裝指令碼——一鍵安裝、升級和修復

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

不只是簡單的安裝器——指令碼能智慧處理各種常見場景：

| 你的情況 | 指令碼會做什麼 |
|---|---|
| 從未安裝 | 全新下載 → 安裝依賴 → 選擇設定 → 寫入 openclaw.json → 重啟 |
| 透過 `git clone` 安裝，卡在舊版本 | 自動 `git fetch` + `checkout` 到最新 → 重裝依賴 → 驗證 |
| 設定中有無效欄位 | 自動偵測並透過 schema 過濾移除不支援的欄位 |
| 透過 `npm` 安裝 | 跳過 git 更新，提醒你自行執行 `npm update` |
| `openclaw` CLI 因無效設定崩潰 | 降級方案：直接從 `openclaw.json` 檔案讀取工作目錄路徑 |
| `extensions/` 而非 `plugins/` | 從設定或檔案系統自動偵測外掛位置 |
| 已是最新版 | 僅執行健康檢查，不做變動 |

```bash
bash setup-memory.sh                    # 安裝或升級
bash setup-memory.sh --dry-run          # 僅預覽
bash setup-memory.sh --beta             # 包含預發布版本
bash setup-memory.sh --uninstall        # 還原設定並移除外掛
```

內建服務商預設：**Jina / DashScope / SiliconFlow / OpenAI / Ollama**，或自帶任意 OpenAI 相容 API。完整用法（含 `--ref`、`--selfcheck-only` 等）詳見[安裝指令碼 README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)。

### Claude Code / OpenClaw Skill——AI 引導式設定

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

安裝這個 Skill，你的 AI 智慧體（Claude Code 或 OpenClaw）就能深度掌握 memory-lancedb-pro 的所有功能。只需說 **「help me enable the best config」** 即可獲得：

- **7 步引導式設定流程**，提供 4 套部署方案：
  - 滿血版（Jina + OpenAI）/ 省錢版（免費 SiliconFlow 重排序）/ 簡約版（僅 OpenAI）/ 全本機版（Ollama，零 API 成本）
- **全部 9 個 MCP 工具** 的正確用法：`memory_recall`、`memory_store`、`memory_forget`、`memory_update`、`memory_stats`、`memory_list`、`self_improvement_log`、`self_improvement_extract_skill`、`self_improvement_review` *（完整工具集需要設定 `enableManagementTools: true`——預設快速設定僅公開 4 個核心工具）*
- **避開常見陷阱**：workspace 外掛啟用、`autoRecall` 預設 false、jiti 快取、環境變數、作用域隔離等

**Claude Code 安裝：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**OpenClaw 安裝：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## 影片教學

> 完整演示：安裝、設定、混合檢索內部原理。

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 架構

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (入口)                        │
│  外掛註冊 · 設定解析 · 生命週期鉤子                        │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼───┐           ┌─────▼──────────┐
    │migrate │           │noise-filter.ts │
    │ .ts    │           │adaptive-       │
    └────────┘           │retrieval.ts    │
                         └────────────────┘
    ┌─────────────┐   ┌──────────┐
    │  tools.ts   │   │  cli.ts  │
    │ (智慧體 API)│   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> 完整架構解析見 [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md)。

<details>
<summary><strong>檔案說明（點選展開）</strong></summary>

| 檔案 | 用途 |
| --- | --- |
| `index.ts` | 外掛入口，註冊 OpenClaw Plugin API、解析設定、掛載生命週期鉤子 |
| `openclaw.plugin.json` | 外掛中繼資料 + 完整 JSON Schema 設定宣告 |
| `cli.ts` | CLI 指令：`memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB 儲存層：建表 / 全文索引 / 向量搜尋 / BM25 搜尋 / CRUD |
| `src/embedder.ts` | Embedding 抽象層，相容任意 OpenAI 相容 API |
| `src/retriever.ts` | 混合檢索引擎：向量 + BM25 → 混合融合 → 重排序 → 生命週期衰減 → 過濾 |
| `src/scopes.ts` | 多作用域存取控制 |
| `src/tools.ts` | 智慧體工具定義：`memory_recall`、`memory_store`、`memory_forget`、`memory_update` + 管理工具 |
| `src/noise-filter.ts` | 過濾智慧體拒絕回覆、元問題、打招呼等低品質內容 |
| `src/adaptive-retrieval.ts` | 判斷查詢是否需要記憶檢索 |
| `src/migrate.ts` | 從內建 `memory-lancedb` 遷移到 Pro |
| `src/smart-extractor.ts` | LLM 驅動的 6 類擷取，支援 L0/L1/L2 分層儲存和兩階段去重 |
| `src/decay-engine.ts` | Weibull 拉伸指數衰減模型 |
| `src/tier-manager.ts` | 三級晉升/降級：外圍 ↔ 工作 ↔ 核心 |

</details>

---

## 核心功能

### 混合檢索

```
查詢 → embedQuery() ─┐
                      ├─→ 混合融合 → 重排序 → 生命週期衰減加權 → 長度正規化 → 過濾
查詢 → BM25 全文 ─────┘
```

- **向量搜尋** — 基於 LanceDB ANN 的語意相似度（餘弦距離）
- **BM25 全文搜尋** — 透過 LanceDB FTS 索引進行精確關鍵字比對
- **混合融合** — 以向量分數為基礎，BM25 命中結果獲得加權提升（非標準 RRF——針對實際召回品質調優）
- **可設定權重** — `vectorWeight`、`bm25Weight`、`minScore`

### 交叉編碼器重排序

- 內建 **Jina**、**SiliconFlow**、**Voyage AI** 和 **Pinecone** 適配器
- 相容任意 Jina 相容端點（如 Hugging Face TEI、DashScope）
- 混合打分：60% 交叉編碼器 + 40% 原始融合分數
- 優雅降級：API 失敗時回退到餘弦相似度

### 多階段評分管線

| 階段 | 效果 |
| --- | --- |
| **混合融合** | 結合語意召回和精確比對召回 |
| **交叉編碼器重排序** | 提升語意精確命中的排名 |
| **生命週期衰減加權** | Weibull 時效性 + 存取頻率 + 重要性 × 置信度 |
| **長度正規化** | 防止長條目主導結果（錨點：500 字元） |
| **硬最低分** | 移除無關結果（預設：0.35） |
| **MMR 多樣性** | 餘弦相似度 > 0.85 → 降權 |

### 智慧記憶擷取（v1.1.0）

- **LLM 驅動的 6 類擷取**：使用者輪廓、偏好、實體、事件、案例、模式
- **L0/L1/L2 分層儲存**：L0（一句話索引）→ L1（結構化摘要）→ L2（完整敘述）
- **兩階段去重**：向量相似度預過濾（≥0.7）→ LLM 語意決策（CREATE/MERGE/SKIP）
- **類別感知合併**：`profile` 始終合併，`events`/`cases` 僅追加

### 記憶生命週期管理（v1.1.0）

- **Weibull 衰減引擎**：綜合分數 = 時效性 + 頻率 + 內在價值
- **三級晉升**：`外圍 ↔ 工作 ↔ 核心`，閾值可設定
- **存取強化**：頻繁被召回的記憶衰減更慢（類似間隔重複機制）
- **重要性調制半衰期**：重要記憶衰減更慢

### 多作用域隔離

- 內建作用域：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- 透過 `scopes.agentAccess` 實現智慧體級別的存取控制
- 預設：每個智慧體存取 `global` + 自己的 `agent:<id>` 作用域

### 自動擷取與自動回憶

- **自動擷取**（`agent_end`）：從對話中擷取偏好/事實/決策/實體，去重後每輪最多儲存 3 條
- **自動回憶**（`before_agent_start`）：注入 `<relevant-memories>` 上下文（最多 3 條）

### 雜訊過濾與自適應檢索

- 過濾低品質內容：智慧體拒絕回覆、元問題、打招呼
- 跳過檢索：打招呼、斜線指令、簡單確認、表情符號
- 強制檢索：記憶關鍵字（「記得」、「之前」、「上次」）
- CJK 感知閾值（中文：6 字元 vs 英文：15 字元）

---

<details>
<summary><strong>與內建 <code>memory-lancedb</code> 的對比（點選展開）</strong></summary>

| 功能 | 內建 `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| 向量搜尋 | 有 | 有 |
| BM25 全文搜尋 | - | 有 |
| 混合融合（向量 + BM25） | - | 有 |
| 交叉編碼器重排序（多服務商） | - | 有 |
| 時效性提升和時間衰減 | - | 有 |
| 長度正規化 | - | 有 |
| MMR 多樣性 | - | 有 |
| 多作用域隔離 | - | 有 |
| 雜訊過濾 | - | 有 |
| 自適應檢索 | - | 有 |
| 管理 CLI | - | 有 |
| 工作階段記憶 | - | 有 |
| 任務感知 Embedding | - | 有 |
| **LLM 智慧擷取（6 類）** | - | 有（v1.1.0） |
| **Weibull 衰減 + 層級晉升** | - | 有（v1.1.0） |
| 任意 OpenAI 相容 Embedding | 有限 | 有 |

</details>

---

## 設定

<details>
<summary><strong>完整設定範例</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true,
  "autoRecall": true,
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "${JINA_API_KEY}",
    "rerankModel": "jina-reranker-v3",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "recencyHalfLifeDays": 14,
    "recencyWeight": 0.1,
    "filterNoise": true,
    "lengthNormAnchor": 500,
    "hardMinScore": 0.35,
    "timeDecayHalfLifeDays": 60,
    "reinforcementFactor": 0.5,
    "maxHalfLifeMultiplier": 3
  },
  "enableManagementTools": false,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:discord-bot": { "description": "Discord bot private" }
    },
    "agentAccess": {
      "discord-bot": ["global", "agent:discord-bot"]
    }
  },
  "sessionMemory": {
    "enabled": false,
    "messageCount": 15
  },
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

</details>

<details>
<summary><strong>Embedding 服務商</strong></summary>

相容 **任意 OpenAI 相容 Embedding API**：

| 服務商 | 模型 | Base URL | 維度 |
| --- | --- | --- | --- |
| **Jina**（推薦） | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（本地） | `nomic-embed-text` | `http://localhost:11434/v1` | 取決於模型 |

</details>

<details>
<summary><strong>重排序服務商</strong></summary>

交叉編碼器重排序透過 `rerankProvider` 支援多個服務商：

| 服務商 | `rerankProvider` | 範例模型 |
| --- | --- | --- |
| **Jina**（預設） | `jina` | `jina-reranker-v3` |
| **SiliconFlow**（有免費額度） | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

任何 Jina 相容的重排序端點也可以使用——設定 `rerankProvider: "jina"` 並將 `rerankEndpoint` 指向你的服務（如 Hugging Face TEI、DashScope `qwen3-rerank`）。

</details>

<details>
<summary><strong>智慧擷取（LLM）— v1.1.0</strong></summary>

當 `smartExtraction` 啟用（預設 `true`）時，外掛使用 LLM 智慧擷取和分類記憶，取代基於正則的觸發方式。

| 欄位 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `smartExtraction` | boolean | `true` | 是否啟用 LLM 智慧 6 類別擷取 |
| `llm.auth` | string | `api-key` | `api-key` 使用 `llm.apiKey` / `embedding.apiKey`；`oauth` 預設使用外掛級 OAuth token 檔案 |
| `llm.apiKey` | string | *（複用 `embedding.apiKey`）* | LLM 服務商 API Key |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM 模型名稱 |
| `llm.baseURL` | string | *（複用 `embedding.baseURL`）* | LLM API 端點 |
| `llm.oauthProvider` | string | `openai-codex` | `llm.auth` 為 `oauth` 時使用的 OAuth provider id |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | `llm.auth` 為 `oauth` 時使用的 OAuth token 檔案 |
| `llm.timeoutMs` | number | `30000` | LLM 請求逾時（毫秒） |
| `extractMinMessages` | number | `2` | 觸發擷取的最小訊息數 |
| `extractMaxChars` | number | `8000` | 傳送給 LLM 的最大字元數 |


OAuth `llm` 設定（使用現有 Codex / ChatGPT 登入快取來發送 LLM 請求）：
```json
{
  "llm": {
    "auth": "oauth",
    "oauthProvider": "openai-codex",
    "model": "gpt-5.4",
    "oauthPath": "${HOME}/.openclaw/.memory-lancedb-pro/oauth.json",
    "timeoutMs": 30000
  }
}
```

`llm.auth: "oauth"` 說明：

- `llm.oauthProvider` 目前僅支援 `openai-codex`。
- OAuth token 預設存放在 `~/.openclaw/.memory-lancedb-pro/oauth.json`。
- 如需自訂路徑，可設定 `llm.oauthPath`。
- `auth login` 會在 OAuth 檔案旁邊快照原來的 `api-key` 模式 `llm` 設定；`auth logout` 在可用時會恢復這份快照。
- 從 `api-key` 切到 `oauth` 時不會自動沿用 `llm.baseURL`；只有在你明確需要自訂 ChatGPT/Codex 相容後端時，才應在 `oauth` 模式下手動設定。

</details>

<details>
<summary><strong>生命週期設定（衰減 + 層級）</strong></summary>

| 欄位 | 預設值 | 說明 |
|------|--------|------|
| `decay.recencyHalfLifeDays` | `30` | Weibull 時效性衰減的基礎半衰期 |
| `decay.frequencyWeight` | `0.3` | 存取頻率在綜合分數中的權重 |
| `decay.intrinsicWeight` | `0.3` | `重要性 × 置信度` 的權重 |
| `decay.betaCore` | `0.8` | `核心` 記憶的 Weibull beta |
| `decay.betaWorking` | `1.0` | `工作` 記憶的 Weibull beta |
| `decay.betaPeripheral` | `1.3` | `外圍` 記憶的 Weibull beta |
| `tier.coreAccessThreshold` | `10` | 晉升到 `核心` 所需的最小召回次數 |
| `tier.peripheralAgeDays` | `60` | 降級過期記憶的天數閾值 |

</details>

<details>
<summary><strong>存取強化</strong></summary>

頻繁被召回的記憶衰減更慢（類似間隔重複機制）。

設定項（在 `retrieval` 下）：
- `reinforcementFactor`（0-2，預設 `0.5`）— 設為 `0` 可停用
- `maxHalfLifeMultiplier`（1-10，預設 `3`）— 有效半衰期的硬上限

</details>

---

## CLI 指令

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "查詢" [--scope global] [--limit 10] [--json]
openclaw memory-pro stats [--scope global] [--json]
openclaw memory-pro auth login [--provider openai-codex] [--model gpt-5.4] [--oauth-path /abs/path/oauth.json]
openclaw memory-pro auth status
openclaw memory-pro auth logout
openclaw memory-pro delete <id>
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]
openclaw memory-pro upgrade [--dry-run] [--batch-size 10] [--no-llm] [--limit N] [--scope SCOPE]
openclaw memory-pro migrate check|run|verify [--source /path]
```

OAuth 登入流程：

1. 執行 `openclaw memory-pro auth login`
2. 如果省略 `--provider` 且目前終端可互動，CLI 會先顯示 OAuth 服務商選擇器
3. 指令會列印授權 URL，並在未指定 `--no-browser` 時自動開啟瀏覽器
4. 回呼成功後，指令會儲存外掛 OAuth 檔案（預設：`~/.openclaw/.memory-lancedb-pro/oauth.json`）、為 logout 快照原來的 `api-key` 模式 `llm` 設定，並把外掛 `llm` 設定切換為 OAuth 欄位（`auth`、`oauthProvider`、`model`、`oauthPath`）
5. `openclaw memory-pro auth logout` 會刪除這份 OAuth 檔案，並在存在快照時恢復之前的 `api-key` 模式 `llm` 設定

---

## 進階主題

<details>
<summary><strong>注入的記憶出現在回覆中</strong></summary>

有時模型可能會將注入的 `<relevant-memories>` 區塊原文輸出。

**方案 A（最安全）：** 暫時關閉自動回憶：
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**方案 B（推薦）：** 保留回憶，在智慧體系統提示詞中新增：
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>工作階段記憶</strong></summary>

- 透過 `/new` 指令觸發——將上一段工作階段摘要儲存到 LanceDB
- 預設關閉（OpenClaw 已有原生 `.jsonl` 工作階段持久化）
- 可設定訊息數量（預設 15）

部署模式和 `/new` 驗證詳見 [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md)。

</details>

<details>
<summary><strong>自訂斜線指令（如 /lesson）</strong></summary>

在你的 `CLAUDE.md`、`AGENTS.md` 或系統提示詞中新增：

```markdown
## /lesson 指令
當使用者傳送 `/lesson <內容>` 時：
1. 用 memory_store 儲存為 category=fact（原始知識）
2. 用 memory_store 儲存為 category=decision（可執行的結論）
3. 確認已儲存的內容

## /remember 指令
當使用者傳送 `/remember <內容>` 時：
1. 用 memory_store 以合適的 category 和 importance 儲存
2. 回傳已儲存的記憶 ID 確認
```

</details>

<details>
<summary><strong>AI 智慧體鐵律</strong></summary>

> 將以下內容複製到你的 `AGENTS.md`，讓智慧體自動遵守這些規則。

```markdown
## 規則 1 — 雙層記憶儲存
每個踩坑/經驗教訓 → 立即儲存兩條記憶：
- 技術層：踩坑：[現象]。原因：[根因]。修復：[方案]。預防：[如何避免]
  (category: fact, importance >= 0.8)
- 原則層：決策原則 ([標籤])：[行為規則]。觸發：[何時]。動作：[做什麼]
  (category: decision, importance >= 0.85)

## 規則 2 — LanceDB 資料品質
條目必須簡短且原子化（< 500 字元）。不儲存原始對話摘要或重複內容。

## 規則 3 — 重試前先回憶
任何工具呼叫失敗時，必須先用 memory_recall 搜尋相關關鍵字，再重試。

## 規則 4 — 確認目標程式碼庫
修改前確認你操作的是 memory-lancedb-pro 還是內建 memory-lancedb。

## 規則 5 — 修改外掛程式碼後清除 jiti 快取
修改 plugins/ 下的 .ts 檔案後，必須先清除 /tmp/jiti/ 目錄再重啟 openclaw gateway。
```

</details>

<details>
<summary><strong>資料庫 Schema</strong></summary>

LanceDB 表 `memories`：

| 欄位 | 類型 | 說明 |
| --- | --- | --- |
| `id` | string (UUID) | 主鍵 |
| `text` | string | 記憶文字（全文索引） |
| `vector` | float[] | Embedding 向量 |
| `category` | string | 儲存類別：`preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | 作用域識別碼（如 `global`、`agent:main`） |
| `importance` | float | 重要性分數 0-1 |
| `timestamp` | int64 | 建立時間戳記（毫秒） |
| `metadata` | string (JSON) | 擴充中繼資料 |

v1.1.0 常用 `metadata` 欄位：`l0_abstract`、`l1_overview`、`l2_content`、`memory_category`、`tier`、`access_count`、`confidence`、`last_accessed_at`

> **關於分類的說明：** 頂層 `category` 欄位使用 6 個儲存類別。智慧擷取的 6 類語意標籤（`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`）儲存在 `metadata.memory_category` 中。

</details>

<details>
<summary><strong>故障排除</strong></summary>

### "Cannot mix BigInt and other types"（LanceDB / Apache Arrow）

在 LanceDB 0.26+ 上，某些數值欄位可能以 `BigInt` 形式回傳。升級到 **memory-lancedb-pro >= 1.0.14**——外掛現在會在運算前使用 `Number(...)` 進行類型轉換。

</details>

---

## 文件

| 文件 | 說明 |
| --- | --- |
| [OpenClaw 整合手冊](docs/openclaw-integration-playbook.md) | 部署模式、驗證、迴歸矩陣 |
| [記憶架構分析](docs/memory_architecture_analysis.md) | 完整架構深度解析 |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 行為變更和升級說明 |
| [長上下文分塊](docs/long-context-chunking.md) | 長文件分塊策略 |

---

## 測試版：智慧記憶 v1.1.0

> 狀態：Beta（測試版）——透過 `npm i memory-lancedb-pro@beta` 安裝。使用 `latest` 的穩定版使用者不受影響。

| 功能 | 說明 |
|------|------|
| **智慧擷取** | LLM 驅動的 6 類擷取，支援 L0/L1/L2 中繼資料。停用時回退到正則模式。 |
| **生命週期評分** | Weibull 衰減整合到檢索中——高頻和高重要性記憶排名更高。 |
| **層級管理** | 三級系統（核心 → 工作 → 外圍），自動晉升/降級。 |

回饋：[GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · 回退：`npm i memory-lancedb-pro@latest`

---

## 依賴

| 套件 | 用途 |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | 向量資料庫（ANN + FTS） |
| `openai` ≥6.21.0 | OpenAI 相容 Embedding API 客戶端 |
| `@sinclair/typebox` 0.34.48 | JSON Schema 類型定義 |

---

## Contributors

<p>
<a href="https://github.com/win4r"><img src="https://avatars.githubusercontent.com/u/42172631?v=4" width="48" height="48" alt="@win4r" /></a>
<a href="https://github.com/kctony"><img src="https://avatars.githubusercontent.com/u/1731141?v=4" width="48" height="48" alt="@kctony" /></a>
<a href="https://github.com/Akatsuki-Ryu"><img src="https://avatars.githubusercontent.com/u/8062209?v=4" width="48" height="48" alt="@Akatsuki-Ryu" /></a>
<a href="https://github.com/JasonSuz"><img src="https://avatars.githubusercontent.com/u/612256?v=4" width="48" height="48" alt="@JasonSuz" /></a>
<a href="https://github.com/Minidoracat"><img src="https://avatars.githubusercontent.com/u/11269639?v=4" width="48" height="48" alt="@Minidoracat" /></a>
<a href="https://github.com/furedericca-lab"><img src="https://avatars.githubusercontent.com/u/263020793?v=4" width="48" height="48" alt="@furedericca-lab" /></a>
<a href="https://github.com/joe2643"><img src="https://avatars.githubusercontent.com/u/19421931?v=4" width="48" height="48" alt="@joe2643" /></a>
<a href="https://github.com/AliceLJY"><img src="https://avatars.githubusercontent.com/u/136287420?v=4" width="48" height="48" alt="@AliceLJY" /></a>
<a href="https://github.com/chenjiyong"><img src="https://avatars.githubusercontent.com/u/8199522?v=4" width="48" height="48" alt="@chenjiyong" /></a>
</p>

Full list: [Contributors](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## Star History

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## 授權條款

MIT

---

## 我的微信 QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
