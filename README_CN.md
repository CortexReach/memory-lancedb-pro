<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) 智能体的 AI 记忆助理**

*让你的 AI 智能体拥有真正的记忆力——跨会话、跨智能体、跨时间。*

基于 LanceDB 的 OpenClaw 长期记忆插件，自动存储偏好、决策和项目上下文，在后续会话中自动回忆。

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md) | [日本語](README_JA.md) | [한국어](README_KO.md) | [Français](README_FR.md) | [Español](README_ES.md) | [Deutsch](README_DE.md) | [Italiano](README_IT.md) | [Русский](README_RU.md) | [Português (Brasil)](README_PT-BR.md)

</div>

---

## 为什么选 memory-lancedb-pro？

大多数 AI 智能体都有"失忆症"——每次新对话，之前聊过的全部清零。

**memory-lancedb-pro** 是 OpenClaw 的生产级长期记忆插件，把你的智能体变成一个真正的 **AI 记忆助理**——自动捕捉重要信息，让噪音自然衰减，在恰当的时候回忆起恰当的内容。无需手动标记，无需复杂配置。

### AI 记忆助理实际效果

**没有记忆——每次都从零开始：**

> **你：** "缩进用 tab，所有函数都要加错误处理。"
> *（下一次会话）*
> **你：** "我都说了用 tab 不是空格！" 😤
> *（再下一次会话）*
> **你：** "……我真的说了第三遍了，tab，还有错误处理。"

**有了 memory-lancedb-pro——你的智能体学会了、记住了：**

> **你：** "缩进用 tab，所有函数都要加错误处理。"
> *（下一次会话——智能体自动回忆你的偏好）*
> **智能体：** *（默默改成 tab 缩进，并补上错误处理）* ✅
> **你：** "上个月我们为什么选了 PostgreSQL 而不是 MongoDB？"
> **智能体：** "根据我们 2 月 12 日的讨论，主要原因是……" ✅

这就是 **AI 记忆助理** 的价值——学习你的风格，回忆过去的决策，提供个性化的回应，不再让你重复自己。

### 还能做什么？

| | 你能得到的 |
|---|---|
| **自动捕捉** | 智能体从每次对话中学习——不需要手动调用 `memory_store` |
| **智能提取** | LLM 驱动的 6 类分类：用户画像、偏好、实体、事件、案例、模式 |
| **智能遗忘** | Weibull 衰减模型——重要记忆留存，噪音自然消退 |
| **混合检索** | 向量 + BM25 全文搜索，融合交叉编码器重排序 |
| **上下文注入** | 相关记忆在每次回复前自动浮现 |
| **多作用域隔离** | 按智能体、按用户、按项目隔离记忆边界 |
| **任意 Provider** | OpenAI、Jina、Gemini、Ollama 或任意 OpenAI 兼容 API |
| **完整工具链** | CLI、备份、迁移、升级、导入导出——生产可用 |

---

## 快速开始

> **CPU 要求：** 你的 CPU 必须支持 **AVX/AVX2** 指令集（Intel Sandy Bridge 2011 年后 / AMD Bulldozer 2011 年后）。LanceDB 的原生向量引擎依赖这些指令——不支持的 CPU 会导致插件崩溃（`SIGILL` 非法指令错误）。检查方法：`grep -o 'avx[^ ]*' /proc/cpuinfo | head -1`（无输出 = 不支持）。详见 [#419](https://github.com/CortexReach/memory-lancedb-pro/issues/419)。

### 方式 A：一键安装脚本（推荐）

社区维护的 **[安装脚本](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** 一条命令搞定安装、升级和修复：

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> 脚本覆盖的完整场景和其他社区工具，详见下方 [生态工具](#生态工具)。

### 方式 B：手动安装

**通过 OpenClaw CLI（推荐）：**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**或通过 npm：**
```bash
npm i memory-lancedb-pro@beta
```
> 如果用 npm 安装，你还需要在 `openclaw.json` 的 `plugins.load.paths` 中添加插件安装目录的 **绝对路径**。这是最常见的安装问题。

在 `openclaw.json` 中添加配置：

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

**为什么用这些默认值？**
- `autoCapture` + `smartExtraction` → 智能体自动从每次对话中学习
- `autoRecall` → 相关记忆在每次回复前自动注入
- `extractMinMessages: 2` → 正常两轮对话即触发提取
- `sessionMemory.enabled: false` → 避免会话摘要在初期污染检索结果

验证并重启：

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

你应该能看到：
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

完成！你的智能体现在拥有长期记忆了。

<details>
<summary><strong>更多安装路径（已有用户、升级）</strong></summary>

**已在使用 OpenClaw？**

1. 在 `plugins.load.paths` 中添加插件的 **绝对路径**
2. 绑定记忆插槽：`plugins.slots.memory = "memory-lancedb-pro"`
3. 验证：`openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**从 v1.1.0 之前的版本升级？**

```bash
# 1) 备份
openclaw memory-pro export --scope global --output memories-backup.json
# 2) 试运行
openclaw memory-pro upgrade --dry-run
# 3) 执行升级
openclaw memory-pro upgrade
# 4) 验证
openclaw memory-pro stats
```

详见 `CHANGELOG-v1.1.0.md` 了解行为变更和升级说明。

</details>

<details>
<summary><strong>Telegram Bot 快捷导入（点击展开）</strong></summary>

如果你在使用 OpenClaw 的 Telegram 集成，最简单的方式是直接给主 Bot 发消息，而不是手动编辑配置文件。

以下为英文原文，方便直接复制发送给 Bot：

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

## 生态工具

memory-lancedb-pro 是核心插件。社区围绕它构建了配套工具，让安装和日常使用更加顺畅：

### 安装脚本——一键安装、升级和修复

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

不只是简单的安装器——脚本能智能处理各种常见场景：

| 你的情况 | 脚本会做什么 |
|---|---|
| 从未安装 | 全新下载 → 安装依赖 → 选择配置 → 写入 openclaw.json → 重启 |
| 通过 `git clone` 安装，卡在旧版本 | 自动 `git fetch` + `checkout` 到最新 → 重装依赖 → 验证 |
| 配置中有无效字段 | 自动检测并通过 schema 过滤移除不支持的字段 |
| 通过 `npm` 安装 | 跳过 git 更新，提醒你自行运行 `npm update` |
| `openclaw` CLI 因无效配置崩溃 | 降级方案：直接从 `openclaw.json` 文件读取工作目录路径 |
| `extensions/` 而非 `plugins/` | 从配置或文件系统自动检测插件位置 |
| 已是最新版 | 仅执行健康检查，不做改动 |

```bash
bash setup-memory.sh                    # 安装或升级
bash setup-memory.sh --dry-run          # 仅预览
bash setup-memory.sh --beta             # 包含预发布版本
bash setup-memory.sh --uninstall        # 还原配置并移除插件
```

内置 Provider 预设：**Jina / DashScope / SiliconFlow / OpenAI / Ollama**，或自带任意 OpenAI 兼容 API。完整用法（含 `--ref`、`--selfcheck-only` 等）详见 [安装脚本 README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)。

### Claude Code / OpenClaw Skill——AI 引导式配置

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

安装这个 Skill，你的 AI 智能体（Claude Code 或 OpenClaw）就能深度掌握 memory-lancedb-pro 的所有功能。只需说 **"help me enable the best config"** 即可获得：

- **7 步引导式配置流程**，提供 4 套部署方案：
  - 满血版（Jina + OpenAI）/ 省钱版（免费 SiliconFlow 重排序）/ 简约版（仅 OpenAI）/ 全本地版（Ollama，零 API 成本）
- **全部 9 个 MCP 工具** 的正确用法：`memory_recall`、`memory_store`、`memory_forget`、`memory_update`、`memory_stats`、`memory_list`、`self_improvement_log`、`self_improvement_extract_skill`、`self_improvement_review` *（完整工具集需要设置 `enableManagementTools: true`——默认快速配置仅暴露 4 个核心工具）*
- **常见坑规避**：workspace 插件启用、`autoRecall` 默认 false、jiti 缓存、环境变量、作用域隔离等

**Claude Code 安装：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**OpenClaw 安装：**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## 视频教程

> 完整演示：安装、配置、混合检索内部原理。

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (入口)                        │
│  插件注册 · 配置解析 · 生命周期钩子                        │
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
    │ (智能体 API)│   │ (CLI)    │
    └─────────────┘   └──────────┘
```

> 完整架构解析见 [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md)。

<details>
<summary><strong>文件说明（点击展开）</strong></summary>

| 文件 | 用途 |
| --- | --- |
| `index.ts` | 插件入口，注册 OpenClaw 插件 API、解析配置、挂载生命周期钩子 |
| `openclaw.plugin.json` | 插件元数据 + 完整 JSON Schema 配置声明 |
| `cli.ts` | CLI 命令：`memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB 存储层：建表 / 全文索引 / 向量搜索 / BM25 搜索 / CRUD |
| `src/embedder.ts` | Embedding 抽象层，兼容任意 OpenAI 兼容 API |
| `src/retriever.ts` | 混合检索引擎：向量 + BM25 → 混合融合 → 重排序 → 生命周期衰减 → 过滤 |
| `src/scopes.ts` | 多作用域访问控制 |
| `src/tools.ts` | 智能体工具定义：`memory_recall`、`memory_store`、`memory_forget`、`memory_update` + 管理工具 |
| `src/noise-filter.ts` | 过滤智能体拒绝回复、元问题、打招呼等低质量内容 |
| `src/adaptive-retrieval.ts` | 判断查询是否需要记忆检索 |
| `src/migrate.ts` | 从内置 `memory-lancedb` 迁移到 Pro |
| `src/smart-extractor.ts` | LLM 驱动的 6 类提取，支持 L0/L1/L2 分层存储和两阶段去重 |
| `src/decay-engine.ts` | Weibull 拉伸指数衰减模型 |
| `src/tier-manager.ts` | 三级晋升/降级：外围 ↔ 工作 ↔ 核心 |

</details>

---

## 核心功能

### 混合检索

```
查询 → embedQuery() ─┐
                      ├─→ 混合融合 → 重排序 → 生命周期衰减加权 → 长度归一化 → 过滤
查询 → BM25 全文 ─────┘
```

- **向量搜索** — 基于 LanceDB ANN 的语义相似度（余弦距离）
- **BM25 全文搜索** — 通过 LanceDB FTS 索引进行精确关键词匹配
- **混合融合** — 以向量分数为基础，BM25 命中结果获得加权提升（非标准 RRF——针对实际召回质量调优）
- **可配置权重** — `vectorWeight`、`bm25Weight`、`minScore`

### 交叉编码器重排序

- 内置 **Jina**、**SiliconFlow**、**Voyage AI** 和 **Pinecone** 适配器
- 兼容任意 Jina 兼容端点（如 Hugging Face TEI、DashScope）
- 混合打分：60% 交叉编码器 + 40% 原始融合分数
- 优雅降级：API 失败时回退到余弦相似度

### 多阶段评分管线

| 阶段 | 效果 |
| --- | --- |
| **混合融合** | 结合语义召回和精确匹配召回 |
| **交叉编码器重排序** | 提升语义精确命中的排名 |
| **生命周期衰减加权** | Weibull 时效性 + 访问频率 + 重要性 × 置信度 |
| **长度归一化** | 防止长条目主导结果（锚点：500 字符） |
| **硬最低分** | 移除无关结果（默认：0.35） |
| **MMR 多样性** | 余弦相似度 > 0.85 → 降权 |

### 智能记忆提取（v1.1.0）

- **LLM 驱动的 6 类提取**：用户画像、偏好、实体、事件、案例、模式
- **L0/L1/L2 分层存储**：L0（一句话索引）→ L1（结构化摘要）→ L2（完整叙述）
- **两阶段去重**：向量相似度预过滤（≥0.7）→ LLM 语义决策（CREATE/MERGE/SKIP）
- **类别感知合并**：`profile` 始终合并，`events`/`cases` 仅追加

### 记忆生命周期管理（v1.1.0）

- **Weibull 衰减引擎**：综合分数 = 时效性 + 频率 + 内在价值
- **三级晋升**：`外围 ↔ 工作 ↔ 核心`，阈值可配置
- **访问强化**：频繁被召回的记忆衰减更慢（类似间隔重复机制）
- **重要性调制半衰期**：重要记忆衰减更慢

### 多作用域隔离

- 内置作用域：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- 通过 `scopes.agentAccess` 实现智能体级别的访问控制
- 默认：每个智能体访问 `global` + 自己的 `agent:<id>` 作用域

### 自动捕捉与自动回忆

- **自动捕捉**（`agent_end`）：从对话中提取偏好/事实/决策/实体，去重后每轮最多存储 3 条
- **自动回忆**（`before_agent_start`）：注入 `<relevant-memories>` 上下文（最多 3 条）

### 噪音过滤与自适应检索

- 过滤低质量内容：智能体拒绝回复、元问题、打招呼
- 跳过检索：打招呼、斜杠命令、简单确认、表情符号
- 强制检索：记忆关键词（"记得"、"之前"、"上次"）
- 中文感知阈值（中文：6 字符 vs 英文：15 字符）

---

<details>
<summary><strong>与内置 <code>memory-lancedb</code> 的对比（点击展开）</strong></summary>

| 功能 | 内置 `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| 向量搜索 | 有 | 有 |
| BM25 全文搜索 | - | 有 |
| 混合融合（向量 + BM25） | - | 有 |
| 交叉编码器重排序（多 Provider） | - | 有 |
| 时效性提升和时间衰减 | - | 有 |
| 长度归一化 | - | 有 |
| MMR 多样性 | - | 有 |
| 多作用域隔离 | - | 有 |
| 噪音过滤 | - | 有 |
| 自适应检索 | - | 有 |
| 管理 CLI | - | 有 |
| 会话记忆 | - | 有 |
| 任务感知 Embedding | - | 有 |
| **LLM 智能提取（6 类）** | - | 有（v1.1.0） |
| **Weibull 衰减 + 层级晋升** | - | 有（v1.1.0） |
| 任意 OpenAI 兼容 Embedding | 有限 | 有 |

</details>

---

## 配置

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
<summary><strong>Embedding 服务商</strong></summary>

兼容 **任意 OpenAI 兼容 Embedding API**：

| 服务商 | 模型 | Base URL | 维度 |
| --- | --- | --- | --- |
| **Jina**（推荐） | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（本地） | `nomic-embed-text` | `http://localhost:11434/v1` | 取决于模型 |

</details>

<details>
<summary><strong>重排序服务商</strong></summary>

交叉编码器重排序通过 `rerankProvider` 支持多个服务商：

| 服务商 | `rerankProvider` | 示例模型 |
| --- | --- | --- |
| **Jina**（默认） | `jina` | `jina-reranker-v3` |
| **SiliconFlow**（有免费额度） | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |

任何 Jina 兼容的重排序端点也可以使用——设置 `rerankProvider: "jina"` 并将 `rerankEndpoint` 指向你的服务（如 Hugging Face TEI、DashScope `qwen3-rerank`）。

</details>

<details>
<summary><strong>智能提取（LLM）— v1.1.0</strong></summary>

当 `smartExtraction` 启用（默认 `true`）时，插件使用 LLM 智能提取和分类记忆，替代基于正则的触发方式。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `smartExtraction` | boolean | `true` | 是否启用 LLM 智能 6 类别提取 |
| `llm.auth` | string | `api-key` | `api-key` 使用 `llm.apiKey` / `embedding.apiKey`；`oauth` 默认使用 plugin 级 OAuth token 文件 |
| `llm.apiKey` | string | *（复用 `embedding.apiKey`）* | LLM 提供商 API Key |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM 模型名称 |
| `llm.baseURL` | string | *（复用 `embedding.baseURL`）* | LLM API 端点 |
| `llm.oauthProvider` | string | `openai-codex` | `llm.auth` 为 `oauth` 时使用的 OAuth provider id |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | `llm.auth` 为 `oauth` 时使用的 OAuth token 文件 |
| `llm.timeoutMs` | number | `30000` | LLM 请求超时（毫秒） |
| `extractMinMessages` | number | `2` | 触发提取的最小消息数 |
| `extractMaxChars` | number | `8000` | 发送给 LLM 的最大字符数 |


OAuth `llm` 配置（使用现有 Codex / ChatGPT 登录缓存来发送 LLM 请求）：
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

`llm.auth: "oauth"` 说明：

- `llm.oauthProvider` 当前仅支持 `openai-codex`。
- OAuth token 默认存放在 `~/.openclaw/.memory-lancedb-pro/oauth.json`。
- 如需自定义路径，可设置 `llm.oauthPath`。
- `auth login` 会在 OAuth 文件旁边快照原来的 `api-key` 模式 `llm` 配置；`auth logout` 在可用时会恢复这份快照。
- 从 `api-key` 切到 `oauth` 时不会自动沿用 `llm.baseURL`；只有在你明确需要自定义 ChatGPT/Codex 兼容后端时，才应在 `oauth` 模式下手动设置。

</details>

<details>
<summary><strong>生命周期配置（衰减 + 层级）</strong></summary>

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `decay.recencyHalfLifeDays` | `30` | Weibull 时效性衰减的基础半衰期 |
| `decay.frequencyWeight` | `0.3` | 访问频率在综合分数中的权重 |
| `decay.intrinsicWeight` | `0.3` | `重要性 × 置信度` 的权重 |
| `decay.betaCore` | `0.8` | `核心` 记忆的 Weibull beta |
| `decay.betaWorking` | `1.0` | `工作` 记忆的 Weibull beta |
| `decay.betaPeripheral` | `1.3` | `外围` 记忆的 Weibull beta |
| `tier.coreAccessThreshold` | `10` | 晋升到 `核心` 所需的最小召回次数 |
| `tier.peripheralAgeDays` | `60` | 降级过期记忆的天数阈值 |

</details>

<details>
<summary><strong>访问强化</strong></summary>

频繁被召回的记忆衰减更慢（类似间隔重复机制）。

配置项（在 `retrieval` 下）：
- `reinforcementFactor`（0-2，默认 `0.5`）— 设为 `0` 可禁用
- `maxHalfLifeMultiplier`（1-10，默认 `3`）— 有效半衰期的硬上限

</details>

---

## CLI 命令

```bash
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "查询" [--scope global] [--limit 10] [--json]
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

OAuth 登录流程：

1. 运行 `openclaw memory-pro auth login`
2. 如果省略 `--provider` 且当前终端可交互，CLI 会先显示 OAuth provider 选择器
3. 命令会打印授权 URL，并在未指定 `--no-browser` 时自动打开浏览器
4. 回调成功后，命令会保存 plugin OAuth 文件（默认：`~/.openclaw/.memory-lancedb-pro/oauth.json`）、为 logout 快照原来的 `api-key` 模式 `llm` 配置，并把插件 `llm` 配置切换为 OAuth 字段（`auth`、`oauthProvider`、`model`、`oauthPath`）
5. `openclaw memory-pro auth logout` 会删除这份 OAuth 文件，并在存在快照时恢复之前的 `api-key` 模式 `llm` 配置

---

## 进阶主题

<details>
<summary><strong>注入的记忆出现在回复中</strong></summary>

有时模型可能会将注入的 `<relevant-memories>` 块原文输出。

**方案 A（最安全）：** 暂时关闭自动回忆：
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**方案 B（推荐）：** 保留回忆，在智能体系统提示词中添加：
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>会话记忆</strong></summary>

- 通过 `/new` 命令触发——将上一段会话摘要保存到 LanceDB
- 默认关闭（OpenClaw 已有原生 `.jsonl` 会话持久化）
- 可配置消息数量（默认 15）

部署模式和 `/new` 验证详见 [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md)。

</details>

<details>
<summary><strong>自定义斜杠命令（如 /lesson）</strong></summary>

在你的 `CLAUDE.md`、`AGENTS.md` 或系统提示词中添加：

```markdown
## /lesson 命令
当用户发送 `/lesson <内容>` 时：
1. 用 memory_store 保存为 category=fact（原始知识）
2. 用 memory_store 保存为 category=decision（可执行的结论）
3. 确认已保存的内容

## /remember 命令
当用户发送 `/remember <内容>` 时：
1. 用 memory_store 以合适的 category 和 importance 保存
2. 返回已存储的记忆 ID 确认
```

</details>

<details>
<summary><strong>AI 智能体铁律</strong></summary>

> 将以下内容复制到你的 `AGENTS.md`，让智能体自动遵守这些规则。

```markdown
## 规则 1 — 双层记忆存储
每个踩坑/经验教训 → 立即存储两条记忆：
- 技术层：踩坑：[现象]。原因：[根因]。修复：[方案]。预防：[如何避免]
  (category: fact, importance >= 0.8)
- 原则层：决策原则 ([标签])：[行为规则]。触发：[何时]。动作：[做什么]
  (category: decision, importance >= 0.85)

## 规则 2 — LanceDB 数据质量
条目必须简短且原子化（< 500 字符）。不存储原始对话摘要或重复内容。

## 规则 3 — 重试前先回忆
任何工具调用失败时，必须先用 memory_recall 搜索相关关键词，再重试。

## 规则 4 — 确认目标代码库
修改前确认你操作的是 memory-lancedb-pro 还是内置 memory-lancedb。

## 规则 5 — 修改插件代码后清除 jiti 缓存
修改 plugins/ 下的 .ts 文件后，必须先执行 rm -rf /tmp/jiti/ 再重启 openclaw gateway。
```

</details>

<details>
<summary><strong>数据库 Schema</strong></summary>

LanceDB 表 `memories`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string (UUID) | 主键 |
| `text` | string | 记忆文本（全文索引） |
| `vector` | float[] | Embedding 向量 |
| `category` | string | 存储类别：`preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | 作用域标识（如 `global`、`agent:main`） |
| `importance` | float | 重要性分数 0-1 |
| `timestamp` | int64 | 创建时间戳（毫秒） |
| `metadata` | string (JSON) | 扩展元数据 |

v1.1.0 常用 `metadata` 字段：`l0_abstract`、`l1_overview`、`l2_content`、`memory_category`、`tier`、`access_count`、`confidence`、`last_accessed_at`

> **关于分类的说明：** 顶层 `category` 字段使用 6 个存储类别。智能提取的 6 类语义标签（`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`）存储在 `metadata.memory_category` 中。

</details>

<details>
<summary><strong>故障排除</strong></summary>

### "Cannot mix BigInt and other types"（LanceDB / Apache Arrow）

在 LanceDB 0.26+ 上，某些数值列可能以 `BigInt` 形式返回。升级到 **memory-lancedb-pro >= 1.0.14**——插件现在会在运算前使用 `Number(...)` 进行类型转换。

</details>

---

## 文档

| 文档 | 说明 |
| --- | --- |
| [OpenClaw 集成手册](docs/openclaw-integration-playbook.md) | 部署模式、验证、回归矩阵 |
| [记忆架构分析](docs/memory_architecture_analysis.md) | 完整架构深度解析 |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 行为变更和升级说明 |
| [长上下文分块](docs/long-context-chunking.md) | 长文档分块策略 |

---

## Beta：智能记忆 v1.1.0

> 状态：Beta——通过 `npm i memory-lancedb-pro@beta` 安装。使用 `latest` 的稳定版用户不受影响。

| 功能 | 说明 |
|------|------|
| **智能提取** | LLM 驱动的 6 类提取，支持 L0/L1/L2 元数据。禁用时回退到正则模式。 |
| **生命周期评分** | Weibull 衰减集成到检索中——高频和高重要性记忆排名更高。 |
| **层级管理** | 三级系统（核心 → 工作 → 外围），自动晋升/降级。 |

反馈：[GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · 回退：`npm i memory-lancedb-pro@latest`

---

## 依赖

| 包 | 用途 |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | 向量数据库（ANN + FTS） |
| `openai` ≥6.21.0 | OpenAI 兼容 Embedding API 客户端 |
| `@sinclair/typebox` 0.34.48 | JSON Schema 类型定义 |

---

## 贡献者

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

## Star 趋势

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## 许可证

MIT

---

## 我的微信

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
