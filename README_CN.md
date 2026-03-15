<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) 生产级长期记忆插件**

*让你的 AI Agent 真正拥有"记忆"——跨会话、跨 Agent、跨时间。*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **简体中文**

</div>

---

## ✨ 为什么选择 memory-lancedb-pro？

大多数 AI Agent 都有"失忆症"——每次新对话都从零开始。这个插件解决了这个问题。它给你的 OpenClaw Agent 提供**持久化、智能化的长期记忆**——完全自动，无需手动管理。

| | 你能得到什么 |
|---|---|
| 🔍 **混合检索** | 向量 + BM25 全文搜索，搭配跨编码器 Rerank |
| 🧠 **智能提取** | LLM 驱动的 6 类别记忆提取——不用手动调 `memory_store` |
| ⏳ **记忆生命周期** | Weibull 衰减 + 三层晋升——重要记忆浮上来，过时记忆沉下去 |
| 🔒 **多 Scope 隔离** | 按 Agent、用户、项目维度隔离记忆 |
| 🔌 **任意 Embedding 提供商** | OpenAI、Jina、Gemini、Ollama 或任何 OpenAI 兼容 API |
| 🛠️ **完整运维工具链** | CLI、备份、迁移、升级、导入导出——不是玩具 |

---

## 🆚 对比内置 `memory-lancedb`

| 功能 | 内置 `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| 向量搜索 | ✅ | ✅ |
| BM25 全文检索 | ❌ | ✅ |
| 混合融合（Vector + BM25） | ❌ | ✅ |
| 跨编码器 Rerank（多 Provider） | ❌ | ✅ |
| 时效性加成 & 时间衰减 | ❌ | ✅ |
| 长度归一化 | ❌ | ✅ |
| MMR 多样性去重 | ❌ | ✅ |
| 多 Scope 隔离 | ❌ | ✅ |
| 噪声过滤 | ❌ | ✅ |
| 自适应检索 | ❌ | ✅ |
| 管理 CLI | ❌ | ✅ |
| Session 记忆 | ❌ | ✅ |
| Task-aware Embedding | ❌ | ✅ |
| **LLM 智能提取（6 类别）** | ❌ | ✅（v1.1.0） |
| **Weibull 衰减 + 三层晋升** | ❌ | ✅（v1.1.0） |
| **旧记忆一键升级** | ❌ | ✅（v1.1.0） |
| 任意 OpenAI 兼容 Embedding | 有限 | ✅ |

---

## 📺 视频教程

> 完整演示：安装、配置，以及混合检索的底层原理。

[![YouTube Video](https://img.shields.io/badge/YouTube-立即观看-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
🔗 **https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-立即观看-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
🔗 **https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 🚀 30 秒快速接入

### 1. 安装

```bash
npm i memory-lancedb-pro@beta
```

### 2. 配置

添加到 `openclaw.json`：

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb-pro"
    },
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
          "sessionMemory": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

**为什么这样配？**
- `autoCapture` + `smartExtraction` → Agent 自动从每次对话中学习
- `autoRecall` → 回复前自动注入最相关的历史记忆
- `extractMinMessages: 2` → 两轮对话就能触发智能提取
- `sessionMemory: false` → 避免一开始就让 session summary 污染检索

### 3. 校验并重启

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | rg "memory-lancedb-pro"
```

你应该看到：
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

🎉 **搞定！** 你的 Agent 现在有长期记忆了。

<details>
<summary><strong>💬 通过 OpenClaw 的 Telegram Bot 一键导入配置（点击展开）</strong></summary>

如果你在用 OpenClaw 的 Telegram 集成，最便捷的方式不是手动改配置，而是直接对主 Bot 发送一段接入指令。

可直接发送：

```text
帮我接入该记忆库, 用体验最好的配置：https://github.com/CortexReach/memory-lancedb-pro

要求：
1. 直接接成当前唯一启用的 memory 插件
2. embedding 用 Jina
3. reranker 用 Jina
4. 智能提取的 llm 用 gpt-4o-mini
5. 开启 autoCapture、autoRecall、smartExtraction
6. extractMinMessages=2
7. sessionMemory.enabled=false
8. captureAssistant=false
9. retrieval 用 hybrid，vectorWeight=0.7，bm25Weight=0.3
10. rerank=cross-encoder，candidatePoolSize=12，minScore=0.6，hardMinScore=0.62
11. 生成可直接落到 openclaw.json 的最终配置，不要只给解释

{
  "embedding": {
    "provider": "openai-compatible",
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
  "captureAssistant": false,
  "smartExtraction": true,
  "extractMinMessages": 2,
  "extractMaxChars": 8000,
  "sessionMemory": {
    "enabled": false
  },
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "rerank": "cross-encoder",
    "rerankProvider": "jina",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankModel": "jina-reranker-v3",
    "candidatePoolSize": 12,
    "minScore": 0.6,
    "hardMinScore": 0.62,
    "rerankApiKey": "${JINA_API_KEY}"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  }
}
```

如果你已经有自己的 OpenAI-compatible 服务，只需替换对应区块：

- `embedding`：改 `apiKey` / `model` / `baseURL` / `dimensions`
- `retrieval`：改 `rerankProvider` / `rerankEndpoint` / `rerankModel` / `rerankApiKey`
- `llm`：改 `apiKey` / `model` / `baseURL` / `timeoutMs`

例如只替换 LLM：

```json
{
  "llm": {
    "apiKey": "${GROQ_API_KEY}",
    "model": "openai/gpt-oss-120b",
    "baseURL": "https://api.groq.com/openai/v1"
  }
}
```

</details>

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (入口)                        │
│  插件注册 · 配置解析 · 生命周期钩子 · 自动捕获/回忆       │
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
    │ (Agent API) │   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> 📖 完整架构深度解析请看 [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md)

<details>
<summary><strong>📄 文件说明（点击展开）</strong></summary>

| 文件 | 用途 |
| --- | --- |
| `index.ts` | 插件入口。注册到 OpenClaw Plugin API，解析配置，挂载 `before_agent_start`（自动回忆）、`agent_end`（自动捕获）、`command:new`（Session 记忆）等钩子 |
| `openclaw.plugin.json` | 插件元数据 + 完整 JSON Schema 配置声明（含 `uiHints`） |
| `package.json` | NPM 包信息，依赖 `@lancedb/lancedb`、`openai`、`@sinclair/typebox` |
| `cli.ts` | CLI 命令：`memory list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB 存储层。表创建 / FTS 索引 / Vector Search / BM25 / CRUD / 批量删除 / 统计 |
| `src/embedder.ts` | Embedding 抽象层。兼容任意 OpenAI API Provider，支持 task-aware embedding |
| `src/retriever.ts` | 混合检索引擎。Vector + BM25 → RRF 融合 → Rerank → 生命周期衰减 → Length Norm → Noise Filter → MMR |
| `src/scopes.ts` | 多 Scope 访问控制：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>` |
| `src/tools.ts` | Agent 工具：`memory_recall`、`memory_store`、`memory_forget`、`memory_update` + 管理工具 |
| `src/noise-filter.ts` | 过滤 Agent 拒绝回复、Meta 问题、寒暄等低质量记忆 |
| `src/adaptive-retrieval.ts` | 判断 query 是否需要触发记忆检索 |
| `src/migrate.ts` | 从内置 `memory-lancedb` 迁移到 Pro |
| `src/smart-extractor.ts` | **（v1.1.0）** LLM 6 类别提取管线，含 L0/L1/L2 分层存储和两阶段去重 |
| `src/memory-categories.ts` | **（v1.1.0）** 6 类别分类系统：profile、preferences、entities、events、cases、patterns |
| `src/decay-engine.ts` | **（v1.1.0）** Weibull 拉伸指数衰减模型 |
| `src/tier-manager.ts` | **（v1.1.0）** 三层晋升/降级系统：Peripheral ⟷ Working ⟷ Core |
| `src/memory-upgrader.ts` | **（v1.1.0）** 旧记忆批量升级为新智能格式 |
| `src/llm-client.ts` | **（v1.1.0）** LLM 客户端，结构化 JSON 输出 |
| `src/extraction-prompts.ts` | **（v1.1.0）** 记忆提取、去重、合并的 LLM 提示模板 |
| `src/smart-metadata.ts` | **（v1.1.0）** Metadata 归一化，统一 L0/L1/L2、tier、confidence、access 计数 |

</details>

---

## 📦 核心特性

### 混合检索

```
Query → embedQuery() ─┐
                       ├─→ RRF 融合 → Rerank → 生命周期衰减加权 → 长度归一化 → 过滤
Query → BM25 FTS ─────┘
```

- **向量搜索** — 语义相似度搜索（cosine distance via LanceDB ANN）
- **BM25 全文搜索** — 关键词精确匹配（LanceDB FTS 索引）
- **融合策略** — 向量分数为主，BM25 命中给予 15% 加成（非传统 RRF，经调优）
- **可配置权重** — `vectorWeight`、`bm25Weight`、`minScore`

### 跨编码器 Rerank

- 支持 **Jina 兼容端点**，以及 **TEI**、**SiliconFlow**、**Voyage AI**、**Pinecone**、**DashScope** 的专用适配
- 混合评分：60% cross-encoder + 40% 原始融合分
- 降级策略：API 失败时回退到 cosine similarity rerank

### 多层评分管线

| 阶段 | 效果 |
| --- | --- |
| **RRF 融合** | 同时结合语义召回和关键词召回 |
| **跨编码器重排** | 提升语义更准确的结果 |
| **生命周期衰减加权** | Weibull 新鲜度 + 访问频率 + importance × confidence |
| **长度归一化** | 防止长条目霸占查询结果（锚点 500 字符） |
| **硬最低分** | 低于阈值直接丢弃（默认 0.35） |
| **MMR 多样性** | cosine 相似度 > 0.85 → 降级 |

### 智能记忆提取（v1.1.0）

- **LLM 驱动 6 类别提取**：profile、preferences、entities、events、cases、patterns
- **L0/L1/L2 分层存储**：L0（一句话索引）→ L1（结构化摘要）→ L2（完整叙述）
- **两阶段去重**：向量相似度预过滤（≥0.7）→ LLM 语义决策（CREATE/MERGE/SKIP）
- **类别感知合并**：`profile` 始终合并，`events`/`cases` 仅新增

### 记忆生命周期管理（v1.1.0）

- **Weibull 衰减引擎**：复合分数 = 时效 + 频率 + 内在价值
- **衰减感知检索**：召回结果按生命周期衰减重排
- **三层晋升系统**：`Peripheral ⟷ Working ⟷ Core`，可配置阈值
- **重要性调制半衰期**：重要记忆衰减更慢

### 多 Scope 隔离

- 内置 Scope：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- 通过 `scopes.agentAccess` 配置 Agent 级访问控制
- 默认：Agent 可访问 `global` + 自己的 `agent:<id>` Scope

### 自动捕获 & 自动回忆

- **Auto-Capture**（`agent_end`）：从对话中提取 preference/fact/decision/entity，去重后存储（每次最多 3 条）
- **Auto-Recall**（`before_agent_start`）：注入 `<relevant-memories>` 上下文（最多 3 条）

### 噪声过滤 & 自适应检索

- 过滤低质量内容：Agent 拒绝回复、Meta 问题、寒暄
- 跳过问候、slash 命令、简单确认、emoji 的记忆检索
- 强制检索含记忆关键词的 query（"remember"、"之前"、"上次"等）
- CJK 字符更低阈值（中文 6 字符 vs 英文 15 字符）

### 旧记忆一键升级（v1.1.0）

- 一条命令升级：`openclaw memory-pro upgrade`
- LLM 或无 LLM 模式（离线可用）
- 启动自动检测并提示升级

---

## ⚙️ 配置

<details>
<summary><strong>完整配置示例</strong></summary>

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
      "global": { "description": "共享知识库" },
      "agent:discord-bot": { "description": "Discord 机器人私有" }
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

OpenClaw 默认行为：

- `autoCapture`：默认开启
- `autoRecall`：插件 schema 默认关闭，但本 README 建议大多数新用户显式开启
- `embedding.chunking`：默认开启
- `sessionMemory.enabled`：默认关闭；需要显式设为 `true` 才注册 `/new` Hook

</details>

<details>
<summary><strong>Embedding 提供商</strong></summary>

本插件支持 **任意 OpenAI 兼容的 Embedding API**：

| 提供商 | 模型 | Base URL | 维度 |
| --- | --- | --- | --- |
| **Jina**（推荐） | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（本地） | `nomic-embed-text` | `http://localhost:11434/v1` | _与本地模型一致_ |

</details>

<details>
<summary><strong>Rerank 提供商</strong></summary>

通过 `rerankProvider` 配置跨编码器 Rerank：

| 提供商 | `rerankProvider` | Endpoint | 示例模型 |
| --- | --- | --- | --- |
| **Jina**（默认） | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v3` |
| **Hugging Face TEI** | `tei` | `http://host:8081/rerank` | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow**（有免费额度） | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `https://api.voyageai.com/v1/rerank` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |

<details>
<summary>TEI 配置示例</summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "tei",
    "rerankEndpoint": "http://host:8081/rerank",
    "rerankApiKey": "tei-local"
  }
}
```

说明：
- `tei` 发送 `{ query, texts }`，并解析 Hugging Face Text Embeddings Inference 使用的顶层 `[{ index, score }]` 响应。
- TEI 适配器会忽略 `rerankModel`，所以对 TEI 容器端点无需单独配置该字段。
- 如果你的本地 TEI 端点不需要鉴权，仍建议填一个占位 `rerankApiKey`，这样插件才会启用 cross-encoder rerank 路径。

</details>

<details>
<summary>SiliconFlow 配置示例</summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "siliconflow",
    "rerankEndpoint": "https://api.siliconflow.com/v1/rerank",
    "rerankApiKey": "sk-xxx",
    "rerankModel": "BAAI/bge-reranker-v2-m3"
  }
}
```

</details>

<details>
<summary>Voyage 配置示例</summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "voyage",
    "rerankEndpoint": "https://api.voyageai.com/v1/rerank",
    "rerankApiKey": "${VOYAGE_API_KEY}",
    "rerankModel": "rerank-2.5"
  }
}
```

</details>

<details>
<summary>Pinecone 配置示例</summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "pinecone",
    "rerankEndpoint": "https://api.pinecone.io/rerank",
    "rerankApiKey": "pcsk_xxx",
    "rerankModel": "bge-reranker-v2-m3"
  }
}
```

</details>

说明：
- TEI 的请求/响应格式见上方 TEI 配置示例。
- `voyage` 发送 `{ model, query, documents }` 格式（不含 `top_n`），响应从 `data[].relevance_score` 解析。

</details>

<details>
<summary><strong>智能提取配置（LLM）— v1.1.0</strong></summary>

启用 `smartExtraction`（默认 `true`）后，插件用 LLM 智能提取和分类记忆，替代正则触发。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `smartExtraction` | boolean | `true` | 是否启用 LLM 智能 6 类别提取 |
| `llm.apiKey` | string | *（复用 `embedding.apiKey`）* | LLM 提供商 API Key |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM 模型名称 |
| `llm.baseURL` | string | *（复用 `embedding.baseURL`）* | LLM API 端点 |
| `llm.timeoutMs` | number | `30000` | LLM 请求超时（毫秒） |
| `extractMinMessages` | number | `2` | 触发提取所需最少消息数 |
| `extractMaxChars` | number | `8000` | 发送给 LLM 的最大字符数 |

最简配置（复用 embedding API Key）：
```json
{
  "embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" },
  "smartExtraction": true
}
```

完整配置（独立 LLM 端点）：
```json
{
  "embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" },
  "smartExtraction": true,
  "llm": { "apiKey": "${OPENAI_API_KEY}", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1", "timeoutMs": 30000 },
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

禁用：`{ "smartExtraction": false }`

</details>

<details>
<summary><strong>生命周期配置（Decay + Tier）</strong></summary>

控制记忆新鲜度排序与自动层级迁移。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `decay.recencyHalfLifeDays` | number | `30` | Weibull 时效衰减基础半衰期 |
| `decay.frequencyWeight` | number | `0.3` | 访问频率在复合分数中的权重 |
| `decay.intrinsicWeight` | number | `0.3` | `importance × confidence` 的权重 |
| `decay.betaCore` | number | `0.8` | `core` 记忆的 Weibull beta |
| `decay.betaWorking` | number | `1.0` | `working` 记忆的 Weibull beta |
| `decay.betaPeripheral` | number | `1.3` | `peripheral` 记忆的 Weibull beta |
| `tier.coreAccessThreshold` | number | `10` | 晋升到 `core` 所需最小 recall 次数 |
| `tier.coreCompositeThreshold` | number | `0.7` | 晋升到 `core` 所需最小生命周期分数 |
| `tier.peripheralCompositeThreshold` | number | `0.15` | 低于此分数的 `working` 可能降级 |
| `tier.peripheralAgeDays` | number | `60` | 陈旧低访问记忆降级年龄阈值 |

```json
{
  "decay": { "recencyHalfLifeDays": 21, "betaCore": 0.7, "betaPeripheral": 1.5 },
  "tier": { "coreAccessThreshold": 8, "peripheralAgeDays": 45 }
}
```

</details>

<details>
<summary><strong>访问强化（1.0.26）</strong></summary>

经常被用到的记忆衰减更慢（类似间隔重复）。

配置项（位于 `retrieval` 下）：
- `reinforcementFactor`（0–2，默认 `0.5`）— 设为 `0` 可关闭
- `maxHalfLifeMultiplier`（1–10，默认 `3`）— 有效 half-life 硬上限

说明：强化逻辑只对 `source: "manual"` 生效，避免 auto-recall 意外"强化"噪声。

</details>

---

## 📥 安装

<details>
<summary><strong>路径 A：第一次用 OpenClaw（推荐）</strong></summary>

1. 克隆到 workspace：

```bash
cd /path/to/your/openclaw/workspace
git clone https://github.com/CortexReach/memory-lancedb-pro.git plugins/memory-lancedb-pro
cd plugins/memory-lancedb-pro
npm install
```

2. 添加到 `openclaw.json`（相对路径）：

```json
{
  "plugins": {
    "load": { "paths": ["plugins/memory-lancedb-pro"] },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${JINA_API_KEY}",
            "model": "jina-embeddings-v5-text-small",
            "baseURL": "https://api.jina.ai/v1",
            "dimensions": 1024,
            "taskQuery": "retrieval.query",
            "taskPassage": "retrieval.passage",
            "normalized": true
          }
        }
      }
    },
    "slots": { "memory": "memory-lancedb-pro" }
  }
}
```

3. 重启并验证：

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
openclaw memory-pro stats
```

4. 烟测：写入 1 条记忆 → 关键词搜索 → 自然语言搜索。

</details>

<details>
<summary><strong>路径 B：已在用 OpenClaw，现在加入插件</strong></summary>

1. 保持现有 agents、channels、models 不变
2. 用**绝对路径**把插件加到 `plugins.load.paths`：

```json
{ "plugins": { "load": { "paths": ["/absolute/path/to/memory-lancedb-pro"] } } }
```

3. 绑定 memory slot：`plugins.slots.memory = "memory-lancedb-pro"`
4. 验证：`openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

</details>

<details>
<summary><strong>路径 C：从旧版 memory-lancedb-pro 升级（v1.1.0 之前）</strong></summary>

命令边界：
- `upgrade` — 用于**旧版 `memory-lancedb-pro` 数据升级**
- `migrate` — 只用于从内置 **`memory-lancedb`** 迁移
- `reembed` — 只在更换 embedding 模型后重建向量时使用

推荐安全顺序：

```bash
# 1) 备份
openclaw memory-pro export --scope global --output memories-backup.json

# 2) 先检查
openclaw memory-pro upgrade --dry-run

# 3) 正式升级
openclaw memory-pro upgrade

# 4) 验证
openclaw memory-pro stats
openclaw memory-pro search "your known keyword" --scope global --limit 5
```

详见 `docs/CHANGELOG-v1.1.0.md`。

</details>

<details>
<summary><strong>安装后验证清单</strong></summary>

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
openclaw memory-pro stats
openclaw memory-pro list --scope global --limit 5
```

然后验证：
- ✅ 1 个唯一标识符搜索命中
- ✅ 1 个自然语言搜索命中
- ✅ 1 轮 `memory_store` → `memory_recall`
- ✅ 如启用 session memory，补 1 轮真实 `/new`

</details>

<details>
<summary><strong>AI 安装指引（防幻觉版）</strong></summary>

如果你是用 AI 按 README 操作，**不要假设任何默认值**。先运行：

```bash
openclaw config get agents.defaults.workspace
openclaw config get plugins.load.paths
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-lancedb-pro
```

建议：
- `plugins.load.paths` 优先用**绝对路径**
- 如果配置里用 `${JINA_API_KEY}`，务必确保 Gateway **服务进程环境**里有该变量
- 修改插件配置后运行 `openclaw gateway restart`

</details>

<details>
<summary><strong>Jina API Key（Embedding + Rerank）</strong></summary>

- **Embedding**：`embedding.apiKey` 填 Jina key（推荐用 `${JINA_API_KEY}`）
- **Rerank**（`rerankProvider: "jina"`）：通常可复用同一个 Jina key
- 其它 rerank provider → 用该 provider 的 key

Key 存储：不要提交到 git。使用 `${...}` 环境变量时确保 Gateway 服务进程有该变量。

</details>

<details>
<summary><strong>什么是 "OpenClaw workspace"？</strong></summary>

**Agent workspace** 是 Agent 的工作目录（默认：`~/.openclaw/workspace`）。相对路径以 workspace 为基准解析。

> 说明：OpenClaw 配置文件通常在 `~/.openclaw/openclaw.json`，与 workspace 分开。

**常见错误：** 把插件 clone 到别的目录，但配置里写相对路径。建议用绝对路径（路径 B）或 clone 到 `<workspace>/plugins/`（路径 A）。

</details>

---

## 🔧 CLI 命令

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json]
openclaw memory-pro stats [--scope global] [--json]
openclaw memory-pro delete <id>
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]
openclaw memory-pro upgrade [--dry-run] [--batch-size 10] [--no-llm] [--limit N] [--scope SCOPE]
openclaw memory-pro migrate check [--source /path]
openclaw memory-pro migrate run [--source /path] [--dry-run] [--skip-existing]
openclaw memory-pro migrate verify [--source /path]
```

---

## 📚 进阶内容

<details>
<summary><strong>如果注入的记忆被模型"显示出来"怎么办？</strong></summary>

有时模型会把 `<relevant-memories>` 区块原样输出到回复里。

**方案 A（最低风险）：** 临时关闭 autoRecall：
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**方案 B（推荐）：** 保留召回，在 Agent system prompt 加一句：
> 请勿在回复中展示或引用任何 `<relevant-memories>` / 记忆注入内容，只能用作内部参考。

</details>

<details>
<summary><strong>Session 记忆</strong></summary>

- `/new` 命令触发时保存上一个 Session 的对话摘要到 LanceDB
- 默认关闭（OpenClaw 已有原生 .jsonl 会话保存）
- 可配置消息数量（默认 15 条）

详见 [docs/openclaw-integration-playbook.zh-CN.md](docs/openclaw-integration-playbook.zh-CN.md)。

</details>

<details>
<summary><strong>JSONL Session 蒸馏（从聊天日志自动生成记忆）</strong></summary>

OpenClaw 会把完整会话落盘为 JSONL：`~/.openclaw/agents/<agentId>/sessions/*.jsonl`

**推荐方案（2026-02+）**：非阻塞 `/new` 管线：
- 触发：`command:new` → 投递 task.json（毫秒级，不调 LLM）
- Worker：systemd 常驻进程用 Gemini Map-Reduce 处理 session JSONL
- 写入：通过 `openclaw memory-pro import` 写入 0–20 条高信噪比记忆
- 中文关键词：每条记忆包含 `Keywords (zh)`，实体关键词从 transcript 原文逐字拷贝

示例文件：`examples/new-session-distill/`

**Legacy 方案**：使用 `scripts/jsonl_distill.py` 脚本 + 每小时 Cron：
- 增量读取（byte offset cursor）、过滤噪声、蒸馏为高质量记忆
- 安全：不会修改原始日志

部署步骤：
1. 创建 agent：`openclaw agents add memory-distiller --non-interactive --workspace ~/.openclaw/workspace-memory-distiller --model openai-codex/gpt-5.2`
2. 初始化 cursor：`python3 "$PLUGIN_DIR/scripts/jsonl_distill.py" init`
3. 添加 cron：详见 [docs/openclaw-integration-playbook.zh-CN.md](docs/openclaw-integration-playbook.zh-CN.md)

回滚：`openclaw cron disable <jobId>` → `openclaw agents delete memory-distiller` → `rm -rf ~/.openclaw/state/jsonl-distill/`

</details>

<details>
<summary><strong>自定义 Slash 命令（如 /lesson）</strong></summary>

添加到你的 `CLAUDE.md`、`AGENTS.md` 或 system prompt：

```markdown
## /lesson 命令
当用户发送 `/lesson <内容>` 时：
1. 用 memory_store 存为 category=fact（原始知识）
2. 用 memory_store 存为 category=decision（可操作的结论）
3. 确认已保存的内容

## /remember 命令
当用户发送 `/remember <内容>` 时：
1. 用 memory_store 存储，自动选择合适的 category 和 importance
2. 返回存储的 memory ID
```

内置工具：`memory_store`、`memory_recall`、`memory_forget`、`memory_update` — 插件加载时自动注册。

</details>

<details>
<summary><strong>AI Agent 铁律（Iron Rules）</strong></summary>

> 将下方代码块复制到你的 `AGENTS.md` 中，让 Agent 自动遵守。

```markdown
## Rule 1 — 双层记忆存储（铁律）
Every pitfall/lesson learned → IMMEDIATELY store TWO memories:
- **Technical layer**: Pitfall: [symptom]. Cause: [root cause]. Fix: [solution]. Prevention: [how to avoid]
  (category: fact, importance ≥ 0.8)
- **Principle layer**: Decision principle ([tag]): [behavioral rule]. Trigger: [when]. Action: [what to do]
  (category: decision, importance ≥ 0.85)
- After each store, immediately `memory_recall` to verify retrieval.

## Rule 2 — LanceDB 卫生
Entries must be short and atomic (< 500 chars). No raw conversation summaries or duplicates.

## Rule 3 — Recall before retry
On ANY tool failure, ALWAYS `memory_recall` with relevant keywords BEFORE retrying.

## Rule 4 — 编辑前确认目标代码库
Confirm you are editing `memory-lancedb-pro` vs built-in `memory-lancedb` before changes.

## Rule 5 — 插件代码变更必须清 jiti 缓存
After modifying `.ts` files under `plugins/`, MUST run `rm -rf /tmp/jiti/` BEFORE `openclaw gateway restart`.
```

</details>

<details>
<summary><strong>数据库 Schema</strong></summary>

LanceDB 表 `memories`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string (UUID) | 主键 |
| `text` | string | 记忆文本（FTS 索引） |
| `vector` | float[] | Embedding 向量 |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `other` |
| `scope` | string | Scope 标识（如 `global`、`agent:main`） |
| `importance` | float | 重要性分数 0–1 |
| `timestamp` | int64 | 创建时间戳 (ms) |
| `metadata` | string (JSON) | 扩展元数据 |

v1.1.0 常见 `metadata` 字段：`l0_abstract`、`l1_overview`、`l2_content`、`memory_category`、`tier`、`access_count`、`confidence`、`last_accessed_at`

</details>

<details>
<summary><strong>常见问题 / 排错</strong></summary>

### "Cannot mix BigInt and other types"（LanceDB / Apache Arrow）

在 LanceDB 0.26+ 中，部分数值列可能以 `BigInt` 返回。请升级到 **memory-lancedb-pro >= 1.0.14** — 插件已统一做 `Number(...)` 转换。

</details>

---

## 🧪 Beta：智能记忆 v1.1.0

> 状态：Beta 版 — 通过 `npm i memory-lancedb-pro@beta` 安装。`latest` 稳定通道不受影响。

| 功能 | 说明 |
|------|------|
| **智能提取** | LLM 驱动的 6 类别提取，含 L0/L1/L2 metadata。禁用时回退到正则。 |
| **生命周期评分** | Weibull 衰减集成到检索中——高频、高重要性的记忆排名更靠前。 |
| **分层管理** | 三层系统（Core → Working → Peripheral），根据访问频率和分数自动晋升/降级。 |

反馈：[GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · 回退：`npm i memory-lancedb-pro@latest`

---

## 📖 文档

| 文档 | 说明 |
| --- | --- |
| [OpenClaw 集成操作手册](docs/openclaw-integration-playbook.zh-CN.md) | 部署模式、`/new` 验证、回归矩阵 |
| [记忆架构分析](docs/memory_architecture_analysis.md) | 完整架构深度解析 |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 行为变化和升级背景 |
| [长上下文分块](docs/long-context-chunking.md) | 长文档分块策略 |

---

## 依赖

| 包 | 用途 |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | 向量数据库（ANN + FTS） |
| `openai` ≥6.21.0 | OpenAI 兼容 Embedding API 客户端 |
| `@sinclair/typebox` 0.34.48 | JSON Schema 类型定义 |

---

## 🤝 主要贡献者

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

完整列表：[Contributors](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## ⭐ Star 趋势

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## License

MIT

---


## 微信二维码

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
