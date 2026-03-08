<div align="center">

# 🧠 memory-lancedb-pro · OpenClaw Plugin

**[OpenClaw](https://github.com/openclaw/openclaw) 增强型 LanceDB 长期记忆插件**

混合检索（Vector + BM25）· 跨编码器 Rerank · 多 Scope 隔离 · 管理 CLI

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **简体中文**

</div>

---

## 📺 视频教程

> **观看完整教程 — 涵盖安装、配置，以及混合检索的底层原理。**

[![YouTube Video](https://img.shields.io/badge/YouTube-立即观看-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
🔗 **https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-立即观看-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
🔗 **https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 为什么需要这个插件？

OpenClaw 内置的 `memory-lancedb` 插件仅提供基本的向量搜索。**memory-lancedb-pro** 在此基础上进行了全面升级：

| 功能 | 内置 `memory-lancedb` | **memory-lancedb-pro** |
|------|----------------------|----------------------|
| 向量搜索 | ✅ | ✅ |
| BM25 全文检索 | ❌ | ✅ |
| 混合融合（Vector + BM25） | ❌ | ✅ |
| 跨编码器 Rerank（Jina） | ❌ | ✅ |
| 时效性加成 | ❌ | ✅ |
| 时间衰减 | ❌ | ✅ |
| 长度归一化 | ❌ | ✅ |
| MMR 多样性去重 | ❌ | ✅ |
| 多 Scope 隔离 | ❌ | ✅ |
| 噪声过滤 | ❌ | ✅ |
| 自适应检索 | ❌ | ✅ |
| 管理 CLI | ❌ | ✅ |
| Session 记忆 | ❌ | ✅ |
| Task-aware Embedding | ❌ | ✅ |
| 任意 OpenAI 兼容 Embedding | 有限 | ✅（OpenAI、Gemini、Jina、Ollama 等） |

---

## 架构概览

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

### 文件说明

| 文件 | 用途 |
|------|------|
| `index.ts` | 插件入口。注册到 OpenClaw Plugin API，解析配置，挂载 `before_agent_start`（自动回忆）、`agent_end`（自动捕获）、集成 `self-improvement`（`agent:bootstrap`、`command:new/reset`）和集成 `memory-reflection`（`command:new/reset`）钩子 |
| `openclaw.plugin.json` | 插件元数据 + 完整 JSON Schema 配置声明（含 `uiHints`） |
| `package.json` | NPM 包信息，依赖 `@lancedb/lancedb`、`openai`、`@sinclair/typebox` |
| `cli.ts` | CLI 命令实现：`memory list/search/stats/delete/delete-bulk/export/import/reembed/migrate` |
| `src/store.ts` | LanceDB 存储层。表创建 / FTS 索引 / Vector Search / BM25 Search / CRUD / 批量删除 / 统计 |
| `src/embedder.ts` | Embedding 抽象层。兼容 OpenAI API 的任意 Provider（OpenAI、Gemini、Jina、Ollama 等），支持 task-aware embedding（`taskQuery`/`taskPassage`） |
| `src/retriever.ts` | 混合检索引擎。Vector + BM25 → RRF 融合 → Jina Cross-Encoder Rerank → Recency Boost → Importance Weight → Length Norm → Time Decay → Hard Min Score → Noise Filter → MMR Diversity |
| `src/scopes.ts` | 多 Scope 访问控制。支持 `global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>` 等 Scope 模式 |
| `src/tools.ts` | Agent 工具定义：`memory_recall`、`memory_store`、`memory_forget`（核心）、`self_improvement_log`（默认）+ `self_improvement_review`、`self_improvement_extract_skill`（管理模式） |
| `src/noise-filter.ts` | 噪声过滤器。过滤 Agent 拒绝回复、Meta 问题、寒暄等低质量记忆 |
| `src/adaptive-retrieval.ts` | 自适应检索。判断 query 是否需要触发记忆检索（跳过问候、命令、简单确认等） |
| `src/migrate.ts` | 迁移工具。从旧版 `memory-lancedb` 插件迁移数据到 Pro 版 |

---

## 核心特性

### 1. 混合检索 (Hybrid Retrieval)

```
Query → embedQuery() ─┐
                       ├─→ RRF 融合 → Rerank → 时效加成 → 重要性加权 → 过滤
Query → BM25 FTS ─────┘
```

- **向量搜索**: 语义相似度搜索（cosine distance via LanceDB ANN）
- **BM25 全文搜索**: 关键词精确匹配（LanceDB FTS 索引）
- **融合策略**: Vector score 为基础，BM25 命中给予 15% 加成（非传统 RRF，经过调优）
- **可配置权重**: `vectorWeight`、`bm25Weight`、`minScore`

### 2. 跨编码器 Rerank

- **Jina Reranker API**: `jina-reranker-v3`（5s 超时保护）
- **混合评分**: 60% cross-encoder score + 40% 原始融合分
- **降级策略**: API 失败时回退到 cosine similarity rerank

### 3. 多层评分管线

| 阶段 | 公式 | 效果 |
|------|------|------|
| **时效加成** | `exp(-ageDays / halfLife) * weight` | 新记忆分数更高（默认半衰期 14 天，权重 0.10） |
| **重要性加权** | `score *= (0.7 + 0.3 * importance)` | importance=1.0 → ×1.0，importance=0.5 → ×0.85 |
| **长度归一化** | `score *= 1 / (1 + 0.5 * log2(len/anchor))` | 防止长条目凭关键词密度霸占所有查询（锚点：500 字符） |
| **时间衰减** | `score *= 0.5 + 0.5 * exp(-ageDays / halfLife)` | 旧条目逐渐降权，下限 0.5×（60 天半衰期） |
| **硬最低分** | 低于阈值直接丢弃 | 移除不相关结果（默认 0.35） |
| **MMR 多样性** | cosine 相似度 > 0.85 → 降级 | 防止近似重复结果 |

### 4. 多 Scope 隔离

- **内置 Scope 模式**: `global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- **Agent 级访问控制**: 通过 `scopes.agentAccess` 配置每个 Agent 可访问的 Scope
- **默认行为**: Agent 可访问 `global` + 自己的 `agent:<id>` Scope

### 5. 自适应检索

- 跳过不需要记忆的 query（问候、slash 命令、简单确认、emoji）
- 强制检索含记忆相关关键词的 query（"remember"、"之前"、"上次"等）
- 支持 CJK 字符的更低阈值（中文 6 字符 vs 英文 15 字符）

### 6. 噪声过滤

在自动捕获和工具存储阶段同时生效：
- 过滤 Agent 拒绝回复（"I don't have any information"）
- 过滤 Meta 问题（"do you remember"）
- 过滤寒暄（"hi"、"hello"、"HEARTBEAT"）

### 7. Session 策略

- `sessionStrategy: "systemSessionMemory"`（默认）：不注册插件 reflection hooks，改用 OpenClaw 内置 `session-memory`。
- `sessionStrategy: "memoryReflection"`：为 `/new` / `/reset` 启用插件 reflection hooks。
- `sessionStrategy: "none"`：完全禁用本插件的会话策略 hooks。
- 兼容说明：`sessionMemory.enabled=true|false` 映射为 `systemSessionMemory|none`。
- `sessionMemory.messageCount` 也作为遗留兼容字段保留，并映射到 `memoryReflection.messageCount`。
- 实用规则：只有在 `sessionStrategy="memoryReflection"` 时，`memoryReflection.*` 配置才会真正生效。

### 8. Self-Improvement

- 触发事件：`agent:bootstrap`、`command:new`、`command:reset`。
- `agent:bootstrap`：将 `SELF_IMPROVEMENT_REMINDER.md` 注入 bootstrap 上下文。
- `command:new` / `command:reset`：在重置前追加简短 `/note self-improvement ...` 提醒。
- 文件初始化路径：确保 `.learnings/LEARNINGS.md` 和 `.learnings/ERRORS.md` 存在。
- 这条链路与 `memoryReflection` 分离：看到 self-improvement note 或 `.learnings/*` 写入，并不等于 reflection 存储已开启。
- 追加路径刻意区分为三种：
  - 显式工具写入：`self_improvement_log`
  - reflection 驱动的自动追加：来自结构化 governance candidates
  - 文件/模板确保路径：bootstrap 阶段创建缺失文件
- 工具：
  - `self_improvement_log`：写入结构化 `learning` / `error` 条目。
  - `self_improvement_review`：汇总治理 backlog（pending/high/promoted）。
  - `self_improvement_extract_skill`：通过显式工具调用，从学习条目提炼可复用 `SKILL.md` 脚手架。
- Reflection 自动追加行为：
  - 来源段落：`## Learning governance candidates (.learnings / promotion / skill extraction)`。
  - 首选格式：结构化逐条记录（`### Entry N`、`Priority`、`Status`、`Area`、`Summary`、`Details`、`Suggested Action`）。
  - 向后兼容：旧的 bullet-style governance 内容仍作为 fallback 解析路径保留。
  - 每个解析出的 governance candidate 会单独追加为一条 `.learnings/LEARNINGS.md` 记录。
  - `Logged` 时间戳和条目 id 由写入器生成，而不是由 reflection 文本提供。

### 9. memoryReflection

- 启用条件：
  - 需要 `sessionStrategy="memoryReflection"`。
  - 触发于 `command:new` / `command:reset`。
  - 若会话上下文不完整（例如缺少配置、session 文件、或可读对话内容），则跳过生成。
- 执行链：
  - 先尝试 embedded runner（`runEmbeddedPiAgent`）。
  - 若 embedded 路径失败，则回退到 `openclaw agent --local --json`。
  - 若两者都失败，则写入最小 fallback reflection artifact。
- Markdown 产物：
  - 写入 `memory/reflections/YYYY-MM-DD/`。
  - 文件名使用高精度时间戳 + agent/session token，例如 `HHMMSSmmm-agent-session[-xxxxxx].md`。
- Prompt / 输出契约：
  - 必需段落使用固定标题，并按精确 section 名解析。
  - `Invariants` = 稳定的跨会话规则。
  - `Derived` = 本轮提炼出的近期经验 / 调整 / follow-up heuristics，可能在接下来几轮继续有用，但应随时间衰减。
  - Governance candidates 使用结构化 entry 模板，以便安全追加到 `.learnings`。
  - `Logged` 时间戳和 ids 等 writer-owned metadata 由持久化层生成，而非模型输出。
- 写入 LanceDB（可选）：
  - 由 `memoryReflection.storeToLanceDB` 控制。
  - 每次反思会写入 1 条 event row（`type=memory-reflection-event`）以及多条 item row（`type=memory-reflection-item`，对应每个 `Invariants` / `Derived` bullet）。
  - event row 仅保留轻量 provenance / audit 元数据（`eventId`、`sessionKey`、`usedFallback`、`errorSignals`、source path）。
  - item row 携带逐条衰减元数据（`decayModel`、`decayMidpointDays`、`decayK`、`baseWeight`、`quality`）以及 `ordinal/groupSize`。
  - 兼容模式：`memoryReflection.writeLegacyCombined=true`（默认）时，迁移期仍会额外写入旧版 combined row（`type=memory-reflection`）。
  - reflection 行展示标签为 `reflection:<scope>`。
- Reflection 派生 durable memory 映射：
  - 插件支持的 memory categories 包括 `preference`、`fact`、`decision`、`entity`、`reflection`、`other`。
  - 但 reflection auto-map 有意只写：
    - `User model deltas` → `preference`
    - `Agent model deltas` → `preference`
    - `Lessons & pitfalls` → `fact`
    - `Decisions (durable)` → `decision`
  - `Context`、`Open loops`、`Retrieval tags`、`Invariants`、`Derived` 不会被自动映射成普通 durable memory 类别。
- 衰减算法与内置档位：
  - reflection loading / injection 阶段使用 logistic decay；这**不会**修改全局 retriever 评分链路。
  - 公式：`weight = 1 / (1 + exp(k * (ageDays - midpointDays)))`
  - reflection item 内置档位：
    - `invariant`：midpointDays=`45`，`k=0.22`，`baseWeight=1.10`，`quality=1.00`
    - `derived`：midpointDays=`7`，`k=0.65`，`baseWeight=1.00`，`quality=0.95`
  - mapped durable-memory 内置档位：
    - `decision`：midpointDays=`45`，`k=0.25`，`baseWeight=1.10`，`quality=1.00`
    - `user-model`：midpointDays=`21`，`k=0.30`，`baseWeight=1.00`，`quality=0.95`
    - `agent-model`：midpointDays=`10`，`k=0.35`，`baseWeight=0.95`，`quality=0.93`
    - `lesson`：midpointDays=`7`，`k=0.45`，`baseWeight=0.90`，`quality=0.90`
  - 这些衰减参数当前属于插件写入的实现内置 metadata，不是用户可直接配置的 `memoryReflection.*` schema 字段。
  - fallback 生成的记录会额外乘以 `0.75` 惩罚因子。
- 独立代理（可选）：
  - `memoryReflection.agentId` 可指向专门的 reflection agent（如 `memory-distiller`）。
  - 若配置的 agent id 不在 `cfg.agents.list` 中，插件会告警并回退到 runtime agent id。
- 错误闭环：
  - `after_tool_call` 捕获并去重工具错误签名，用于提醒 / reflection 上下文。

### 10. Markdown 镜像（`mdMirror`）

- 作用：
  - 在写入 LanceDB 的同时，把记忆双写到可读的 Markdown 文件。
  - 便于审计、排查和人工复核。
- 写入路径：
  - 优先：按 agent workspace 映射写入 `memory/YYYY-MM-DD.md`。
  - 回退：当 agent workspace 不可解析时，写入 `mdMirror.dir`（默认 `memory-md`）。
- 触发路径：
  - `memory_store` 工具写入。
  - `agent_end` 自动捕获写入。
- 兼容性：
  - 不替代 LanceDB 存储，不影响现有检索链路。
  - 检索仍走 vector/BM25/rerank。
- 配置项：
  - `mdMirror.enabled`：是否开启双写（默认 `false`）。
  - `mdMirror.dir`：Markdown 镜像回退目录。

### 11. 长文本分块嵌入（Long Context Chunking）

自动处理超出 Embedding 模型上下文限制的长文本：

- **智能分割**：在句子边界分块，支持可配置重叠区（默认 200 字符）
- **平均嵌入**：分别 embed 每个块，再取平均向量保留语义
- **优雅降级**：检测到 "Input length exceeds context length" 时自动重试分块
- **配置开关**：`embedding.chunking` — 设为 `false` 可关闭（默认：遇到上下文超限自动开启）
- **适配各模型限制**：Jina（8192 tokens）、OpenAI（8191）、Gemini（2048）等

详细实现参见 [`docs/long-context-chunking.md`](docs/long-context-chunking.md)。

### 12. Embedding 错误诊断

当 Embedding 调用失败时，插件提供**可操作的错误提示**，而非笼统的报错信息：

- **认证错误**（401/403）：提示检查 API key 有效性和格式
- **网络错误**（ECONNREFUSED、ETIMEDOUT）：提示检查 `baseURL` 和网络连通性
- **频率限制**（429）：建议重试或升级套餐
- **模型未找到**（404）：建议核对模型名称是否与提供商文档一致
- **上下文超长**：自动重试分块嵌入（见上文）

### 13. 自动捕获 & 自动回忆

- **Auto-Capture**（`agent_end` hook）: 从对话中提取 preference/fact/decision/entity，去重后存储（每次最多 3 条）
  - 触发词支持 **简体中文 + 繁體中文**（例如：记住/記住、偏好/喜好/喜歡、决定/決定 等）
- **Auto-Recall**（`before_agent_start` hook）: 注入 `<relevant-memories>` 上下文（最多 3 条）

### 不想在对话中“显示长期记忆”？

有时模型会把注入到上下文中的 `<relevant-memories>` 区块“原样输出”到回复里，从而出现你看到的“周期性显示长期记忆”。

**方案 A（推荐）：关闭自动召回 autoRecall**

在插件配置里设置 `autoRecall: false`，然后重启 gateway：

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "autoRecall": false
        }
      }
    }
  }
}
```

**方案 B：保留召回，但要求 Agent 不要泄漏**

在对应 Agent 的 system prompt 里加一句，例如：

> 请勿在回复中展示或引用任何 `<relevant-memories>` / 记忆注入内容，只能用作内部参考。

---

## 安装

> **🧪 Beta 版本可用：v1.1.0-beta.3**
>
> Beta 版包含多项重大新特性：**Self-Improvement 治理流**、**memoryReflection 会话策略**、**Markdown 镜像双写**、以及改进的 Embedding 错误诊断。稳定版 `latest` 仍为 v1.0.32。
>
> ```bash
> # 安装 beta（手动选择）
> npm install memory-lancedb-pro@beta
>
> # 安装稳定版（默认）
> npm install memory-lancedb-pro
> ```
>
> 详见 [Release Notes](https://github.com/win4r/memory-lancedb-pro/releases/tag/v1.1.0-beta.3)。欢迎通过 [GitHub Issues](https://github.com/win4r/memory-lancedb-pro/issues) 反馈问题。

### AI 安装指引（防幻觉版）

如果你是用 AI 按 README 操作，**不要假设任何默认值**。请先运行以下命令，并以真实输出为准：

```bash
openclaw config get agents.defaults.workspace
openclaw config get plugins.load.paths
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-lancedb-pro
```

建议：
- `plugins.load.paths` 建议优先用**绝对路径**（除非你已确认当前 workspace）。
- 如果配置里使用 `${JINA_API_KEY}`（或任何 `${...}` 变量），务必确保运行 Gateway 的**服务进程环境**里真的有这些变量（systemd/launchd/docker 通常不会继承你终端的 export）。
- 修改插件配置后，运行 `openclaw gateway restart` 使其生效。

### Jina API Key（Embedding + Rerank）如何填写

- **Embedding**：将 `embedding.apiKey` 设置为你的 Jina key（推荐用环境变量 `${JINA_API_KEY}`）。
- **Rerank**（当 `retrieval.rerankProvider: "jina"`）：通常可以直接复用同一个 Jina key，填到 `retrieval.rerankApiKey`。
- 如果你选择了其它 rerank provider（如 `siliconflow` / `pinecone`），则 `retrieval.rerankApiKey` 应填写对应提供商的 key。

Key 存储建议：
- 不要把 key 提交到 git。
- 使用 `${...}` 环境变量没问题，但务必确保运行 Gateway 的**服务进程环境**里真的有该变量（systemd/launchd/docker 往往不会继承你终端的 export）。

### 什么是 “OpenClaw workspace”？

在 OpenClaw 中，**agent workspace（工作区）** 是 Agent 的工作目录（默认：`~/.openclaw/workspace`）。
根据官方文档，workspace 是 OpenClaw 的 **默认工作目录（cwd）**，因此 **相对路径会以 workspace 为基准解析**（除非你使用绝对路径）。

> 说明：OpenClaw 的配置文件通常在 `~/.openclaw/openclaw.json`，与 workspace 是分开的。

**最常见的安装错误：** 把插件 clone 到别的目录，但在配置里仍然写类似 `"paths": ["plugins/memory-lancedb-pro"]` 的**相对路径**。相对路径的解析基准会受 Gateway 启动方式/工作目录影响，容易指向错误位置。

为避免歧义：建议用**绝对路径**（方案 B），或把插件放在 `<workspace>/plugins/`（方案 A）并保持配置一致。

### 方案 A（推荐）：克隆到 workspace 的 `plugins/` 目录下

```bash
# 1) 进入你的 OpenClaw workspace（默认：~/.openclaw/workspace）
#    （可通过 agents.defaults.workspace 改成你自己的路径）
cd /path/to/your/openclaw/workspace

# 2) 把插件克隆到 workspace/plugins/ 下
git clone https://github.com/win4r/memory-lancedb-pro.git plugins/memory-lancedb-pro

# 3) 安装依赖
cd plugins/memory-lancedb-pro
npm install
```

然后在 OpenClaw 配置（`openclaw.json`）中使用相对路径：

```json
{
  "plugins": {
    "load": {
      "paths": ["plugins/memory-lancedb-pro"]
    },
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
    "slots": {
      "memory": "memory-lancedb-pro"
    }
  }
}
```

### 方案 B：插件装在任意目录，但配置里必须写绝对路径

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/memory-lancedb-pro"]
    }
  }
}
```

### 重启

```bash
openclaw gateway restart
```

> **注意：** 如果之前使用了内置的 `memory-lancedb`，启用本插件时需同时禁用它。同一时间只能有一个 memory 插件处于活动状态。

### 验证是否安装成功（推荐）

1）确认插件已被发现/加载：

```bash
openclaw plugins list
openclaw plugins info memory-lancedb-pro
```

2）如果发现异常，运行插件诊断：

```bash
openclaw plugins doctor
```

3）确认 memory slot 已指向本插件：

```bash
# 期望看到：plugins.slots.memory = "memory-lancedb-pro"
openclaw config get plugins.slots.memory
```

---

## 配置

<details>
<summary><strong>完整配置示例（点击展开）</strong></summary>

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
  "autoRecall": false,
  "autoRecallMinLength": 8,
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.45,
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
  "sessionStrategy": "systemSessionMemory",
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
  "selfImprovement": {
    "enabled": true,
    "beforeResetNote": true,
    "skipSubagentBootstrap": true,
    "ensureLearningFiles": true
  },
  "memoryReflection": {
    "storeToLanceDB": true,
    "writeLegacyCombined": true,
    "injectMode": "inheritance+derived",
    "agentId": "memory-distiller",
    "messageCount": 120,
    "maxInputChars": 24000,
    "timeoutMs": 20000,
    "thinkLevel": "medium",
    "errorReminderMaxEntries": 3,
    "dedupeErrorSignals": true
  },
  "mdMirror": {
    "enabled": false,
    "dir": "memory-md"
  }
}
```

说明：此示例为兼容老用户，默认保留 `sessionStrategy: "systemSessionMemory"`。`memoryReflection.*` 配置块用于说明可选的 reflection 流程；只有当你显式把 `sessionStrategy` 切换为 `"memoryReflection"` 时，这部分配置才会生效。

</details>

### 参数映射提示（避免常见误配）

`memory-lancedb-pro` **不支持** `recallTopK` / `recallThreshold` 这两个字段。

如果你希望达到类似效果，请使用下列等价参数：

- `recallTopK` → `retrieval.candidatePoolSize`
- `recallThreshold` → 组合使用 `retrieval.minScore` + `retrieval.hardMinScore`

实战上，中文对话可先从以下配置起步（再按误召回情况微调）：

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "autoRecallMinLength": 8,
  "retrieval": {
    "candidatePoolSize": 20,
    "minScore": 0.45,
    "hardMinScore": 0.55
  }
}
```

### 访问强化（1.0.26）

为了让“经常被用到的记忆”衰减得更慢，检索器可以根据 **手动 recall 的频率**（类似间隔重复/记忆强化）来延长有效的 time-decay half-life。

配置项（位于 `retrieval` 下）：
- `reinforcementFactor`（范围 0–2，默认 `0.5`）— 设为 `0` 可关闭
- `maxHalfLifeMultiplier`（范围 1–10，默认 `3`）— 硬上限：有效 half-life ≤ 基础值 × multiplier

说明：
- 强化逻辑只对白名单 `source: "manual"` 生效（用户/工具主动 recall），避免 auto-recall 意外“强化”噪声。

### Embedding 提供商

本插件支持 **任意 OpenAI 兼容的 Embedding API**：

| 提供商 | 模型 | Base URL | 维度 |
|--------|------|----------|------|
| **Jina**（推荐） | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（本地） | `nomic-embed-text` | `http://localhost:11434/v1` | _与本地模型输出一致_（建议显式设置 `embedding.dimensions`） |

---

## （可选）从 Session JSONL 自动蒸馏记忆（全自动）

OpenClaw 会把每个 Agent 的完整会话自动落盘为 JSONL：

- `~/.openclaw/agents/<agentId>/sessions/*.jsonl`

但 JSONL 含大量噪声（tool 输出、系统块、重复回调等），**不建议直接把原文塞进 LanceDB**。

**推荐方案（2026-02+）**：使用 **/new 非阻塞沉淀管线**（Hooks + systemd worker），在你执行 `/new` 时异步提取高价值经验并写入 LanceDB Pro：

- 触发：`command:new`（你在聊天里发送 `/new`）
- Hook：只投递一个很小的 task.json（毫秒级，不调用 LLM，不阻塞 `/new`）
- Worker：systemd 常驻进程监听队列，读取 session `.jsonl`，用 Gemini **Map-Reduce** 抽取 0～20 条高信噪比记忆
- 写入：通过 `openclaw memory-pro import` 写入 LanceDB Pro（插件内部仍会 embedding + 查重）
- 中文关键词：每条记忆包含 `Keywords (zh)`，并遵循三要素（实体/动作/症状）。其中“实体关键词”必须从 transcript 原文逐字拷贝（禁止编造项目名）。
- 通知：可选（可做到即使 0 条也通知）

示例文件：
- `examples/new-session-distill/`

---

Legacy 方案：本插件也提供一个安全的 extractor 脚本 `scripts/jsonl_distill.py`，配合 OpenClaw 的 `cron` + 独立 distiller agent，实现“增量蒸馏 → 高质量记忆入库”：（适合不依赖 `/new` 的全自动场景）

- 只读取每个 JSONL 文件**新增尾巴**（byte offset cursor），避免重复和 token 浪费
- 生成一个小型 batch JSON
- 由 distiller agent 把 batch 蒸馏成短、原子、可复用的记忆，再用 `memory_store` 写入

### 你会得到什么

- ✅ 全自动（每小时）
- ✅ 多 Agent 支持（main + 各 bot）
- ✅ 只处理新增内容（不回读）
- ✅ 防自我吞噬：默认排除 `memory-distiller` 自己的 session

### 脚本输出位置

- Cursor：`~/.openclaw/state/jsonl-distill/cursor.json`
- Batches：`~/.openclaw/state/jsonl-distill/batches/`

> 脚本只读 session JSONL，不会修改原始日志。默认会跳过 `*.reset.*` 快照与 slash 命令/控制注记行（例如 `/note self-improvement ...`）。

### （可选）启用 Agent 来源白名单（提高信噪比）

默认情况下，extractor 会扫描 **所有 Agent**（但会排除 `memory-distiller` 自身，防止自我吞噬）。

如果你只想从某些 Agent 蒸馏（例如只蒸馏 `main` + `code-agent`），可以设置环境变量：

```bash
export OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS="main,code-agent"
```

- 不设置 / 空 / `*` / `all`：扫描全部（默认）
- 逗号分隔列表：只扫描列表内 agentId

### 推荐部署（独立 distiller agent）

#### 1）创建 distiller agent（示例用 gpt-5.2）

```bash
openclaw agents add memory-distiller \
  --non-interactive \
  --workspace ~/.openclaw/workspace-memory-distiller \
  --model openai-codex/gpt-5.2
```

#### 2）初始化 cursor（模式 A：从现在开始，不回溯历史）

先确定插件目录（PLUGIN_DIR）：

```bash
# 如果你按推荐方式 clone 到 workspace：
#   PLUGIN_DIR="$HOME/.openclaw/workspace/plugins/memory-lancedb-pro"
PLUGIN_DIR="/path/to/memory-lancedb-pro"

python3 "$PLUGIN_DIR/scripts/jsonl_distill.py" init
```

#### 3）创建每小时 Cron（Asia/Shanghai）

建议 cron message 以 `run ...` 开头，这样本插件的自适应检索会跳过自动 recall 注入（节省 token）。

```bash
MSG=$(cat <<'EOF'
run jsonl memory distill

Goal: Distill ONLY new content from OpenClaw session JSONL tails into high-quality LanceDB memories.

Hard rules:
- Incremental only: exec the extractor. Do NOT scan full history.
- If extractor returns action=noop: stop immediately.
- Store only reusable memories (rules, pitfalls, decisions, preferences, stable facts). Skip routine chatter.
- Each memory: idiomatic English + final line `Keywords (zh): ...` (3-8 short phrases).
- Keep each memory < 500 chars and atomic.
- Caps: <= 3 memories per agent per run; <= 3 global per run.
- Scope:
  - broadly reusable -> global
  - agent-specific -> agent:<agentId>

Workflow:
1) exec: python3 <PLUGIN_DIR>/scripts/jsonl_distill.py run
2) Determine batch file (created/pending)
3) memory_store(...) for selected memories
4) exec: python3 <PLUGIN_DIR>/scripts/jsonl_distill.py commit --batch-file <batchFile>
EOF
)

openclaw cron add \
  --agent memory-distiller \
  --name "jsonl-memory-distill (hourly)" \
  --cron "0 * * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --wake now \
  --timeout-seconds 420 \
  --stagger 5m \
  --no-deliver \
  --message "$MSG"
```

### scope 策略（非常重要）

当蒸馏“所有 agents”时，务必显式设置 scope：

- 跨 agent 通用规则/偏好/坑 → `scope=global`
- agent 私有 → `scope=agent:<agentId>`

否则不同 bot 的记忆会相互污染。

### 回滚

- 禁用/删除 cron：`openclaw cron disable <jobId>` / `openclaw cron rm <jobId>`
- 删除 distiller agent：`openclaw agents delete memory-distiller`
- 删除 cursor 状态：`rm -rf ~/.openclaw/state/jsonl-distill/`

---

## CLI 命令

```bash
# 列出记忆
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]

# 搜索记忆
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json]

# 查看统计
openclaw memory-pro stats [--scope global] [--json]

# 按 ID 删除记忆（支持 8+ 字符前缀）
openclaw memory-pro delete <id>

# 批量删除
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]

# 导出 / 导入
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]

# 使用新模型重新生成 Embedding
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]

# 从内置 memory-lancedb 迁移
openclaw memory-pro migrate check [--source /path]
openclaw memory-pro migrate run [--source /path] [--dry-run] [--skip-existing]
openclaw memory-pro migrate verify [--source /path]
```

---

## 自定义命令（例如 `/lesson`）

这个插件提供的是工具级能力。像 `/lesson` 这样的 slash 命令**不是插件内建命令**，而是你在 Agent / system prompt 里定义的便捷别名，底层仍然调用插件注册的工具。

### 推荐快捷命令

- `/remember <content>`
  - 调用 `memory_store`
  - 选择合适的 `category` / `importance` / `scope`
- `/lesson <content>`
  - 调用两次 `memory_store`：
    - 一次用 `category=fact` 保存 lesson 本身
    - 一次用 `category=decision` 保存可执行 takeaway
- `/learn <summary>`
  - 调用 `self_improvement_log`，并设置 `type=learning`
  - 若有信息可带上 `category`、`area`、`priority`、`details`、`suggestedAction`
- `/error <summary>`
  - 调用 `self_improvement_log`，并设置 `type=error`
  - 记录可复现 symptom、上下文和 prevention / fix
- `/learnings` / `/review-learnings`
  - 调用 `self_improvement_review`
- `/skill <learningId> <skill-name>`
  - 调用 `self_improvement_extract_skill`

### Prompt 片段示例

可将下列规则加入你的 `CLAUDE.md`、`AGENTS.md` 或 system prompt：

```markdown
## /lesson command
When the user sends `/lesson <content>`:
1. Use `memory_store` to save the raw lesson as `category=fact`
2. Use `memory_store` again to save the actionable takeaway as `category=decision`
3. Confirm both saved items briefly

## /learn command
When the user sends `/learn <summary>`:
1. Use `self_improvement_log` with `type=learning`
2. Include `details`, `suggestedAction`, `category`, `area`, and `priority` if the user provided them
3. Confirm the created learning entry id

## /error command
When the user sends `/error <summary>`:
1. Use `self_improvement_log` with `type=error`
2. Capture the reproducible failure signature, context, and suggested prevention/fix
3. Confirm the created error entry id

## /review-learnings command
When the user sends `/review-learnings`:
1. Use `self_improvement_review`
2. Return the governance snapshot

## /skill command
When the user sends `/skill <learningId> <skill-name>`:
1. Use `self_improvement_extract_skill`
2. Confirm the generated skill path
```

### 内建工具速查

| 工具 | 说明 |
|------|------|
| `memory_store` | 存储记忆（支持 category / importance / scope） |
| `memory_recall` | 搜索记忆（hybrid vector + BM25） |
| `memory_forget` | 通过 ID 或搜索条件删除记忆 |
| `memory_update` | 原地更新已有记忆 |
| `memory_list` | 按条件列出近期记忆 |
| `memory_stats` | 查看 scope/category 统计 |
| `self_improvement_log` | 将结构化 learning/error 写入 `.learnings/` |
| `self_improvement_review` | 汇总 `.learnings/` 治理积压 |
| `self_improvement_extract_skill` | 从学习条目生成 skill scaffold |

> **说明**：像 `/lesson`、`/learn`、`/error`、`/review-learnings`、`/skill` 这样的命令属于 prompt 级快捷方式；插件真正暴露的是上面这些工具。

---

## 数据库 Schema

LanceDB 表 `memories`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string (UUID) | 主键 |
| `text` | string | 记忆文本（FTS 索引） |
| `vector` | float[] | Embedding 向量 |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Scope 标识（如 `global`、`agent:main`） |
| `importance` | float | 重要性分数 0-1 |
| `timestamp` | int64 | 创建时间戳 (ms) |
| `metadata` | string (JSON) | 扩展元数据 |

---

## 常见问题 / 排错

### "Cannot mix BigInt and other types"（LanceDB / Apache Arrow）

在 LanceDB 0.26+（底层 Apache Arrow）中，部分数值列在运行时可能会以 `BigInt` 的形式返回（常见：`timestamp`、`importance`、`_distance`、`_score`）。如果你遇到类似报错：

- `TypeError: Cannot mix BigInt and other types, use explicit conversions`

请升级到 **memory-lancedb-pro >= 1.0.14**。插件已对这些字段统一做 `Number(...)` 转换后再参与运算（例如：计算分数、按时间排序）。

## AI Agent 铁律（Iron Rules）

> **OpenClaw 用户**：将下方代码块复制到你的 `AGENTS.md` 中，让 Agent 自动遵守这些规则。

```markdown
## Rule 1 — 双层记忆存储（铁律）

Every pitfall/lesson learned → IMMEDIATELY store TWO memories to LanceDB before moving on:

- **Technical layer**: Pitfall: [symptom]. Cause: [root cause]. Fix: [solution]. Prevention: [how to avoid]
  (category: fact, importance ≥ 0.8)
- **Principle layer**: Decision principle ([tag]): [behavioral rule]. Trigger: [when it applies]. Action: [what to do]
  (category: decision, importance ≥ 0.85)
- After each store, immediately `memory_recall` with anchor keywords to verify retrieval.
  If not found, rewrite and re-store.
- Missing either layer = incomplete.
  Do NOT proceed to next topic until both are stored and verified.
- Also update relevant SKILL.md files to prevent recurrence.

## Rule 2 — LanceDB 卫生

Entries must be short and atomic (< 500 chars). Never store raw conversation summaries, large blobs, or duplicates.
Prefer structured format with keywords for retrieval.

## Rule 3 — Recall before retry

On ANY tool failure, repeated error, or unexpected behavior, ALWAYS `memory_recall` with relevant keywords
(error message, tool name, symptom) BEFORE retrying. LanceDB likely already has the fix.
Blind retries waste time and repeat known mistakes.

## Rule 4 — 编辑前确认目标代码库

When working on memory plugins, confirm you are editing the intended package
(e.g., `memory-lancedb-pro` vs built-in `memory-lancedb`) before making changes;
use `memory_recall` + filesystem search to avoid patching the wrong repo.

## Rule 5 — 插件代码变更必须清 jiti 缓存（MANDATORY）

After modifying ANY `.ts` file under `plugins/`, MUST run `rm -rf /tmp/jiti/` BEFORE `openclaw gateway restart`.
jiti caches compiled TS; restart alone loads STALE code. This has caused silent bugs multiple times.
Config-only changes do NOT need cache clearing.
```

---

## 依赖

| 包 | 用途 |
|----|------|
| `@lancedb/lancedb` ≥0.26.2 | 向量数据库（ANN + FTS） |
| `openai` ≥6.21.0 | OpenAI 兼容 Embedding API 客户端 |
| `@sinclair/typebox` 0.34.48 | JSON Schema 类型定义（工具参数） |

---

## 主要贡献者

按 GitHub Contributors 列表自动生成（按 commit 贡献数排序，已排除 bot）：

<p>
<a href="https://github.com/win4r"><img src="https://avatars.githubusercontent.com/u/42172631?v=4" width="48" height="48" alt="@win4r" /></a>
<a href="https://github.com/kctony"><img src="https://avatars.githubusercontent.com/u/1731141?v=4" width="48" height="48" alt="@kctony" /></a>
<a href="https://github.com/Akatsuki-Ryu"><img src="https://avatars.githubusercontent.com/u/8062209?v=4" width="48" height="48" alt="@Akatsuki-Ryu" /></a>
<a href="https://github.com/AliceLJY"><img src="https://avatars.githubusercontent.com/u/136287420?v=4" width="48" height="48" alt="@AliceLJY" /></a>
<a href="https://github.com/JasonSuz"><img src="https://avatars.githubusercontent.com/u/612256?v=4" width="48" height="48" alt="@JasonSuz" /></a>
<a href="https://github.com/Minidoracat"><img src="https://avatars.githubusercontent.com/u/11269639?v=4" width="48" height="48" alt="@Minidoracat" /></a>
<a href="https://github.com/rwmjhb"><img src="https://avatars.githubusercontent.com/u/91475811?v=4" width="48" height="48" alt="@rwmjhb" /></a>
<a href="https://github.com/furedericca-lab"><img src="https://avatars.githubusercontent.com/u/263020793?v=4" width="48" height="48" alt="@furedericca-lab" /></a>
<a href="https://github.com/joe2643"><img src="https://avatars.githubusercontent.com/u/19421931?v=4" width="48" height="48" alt="@joe2643" /></a>
<a href="https://github.com/chenjiyong"><img src="https://avatars.githubusercontent.com/u/8199522?v=4" width="48" height="48" alt="@chenjiyong" /></a>
</p>

- [@win4r](https://github.com/win4r)（4 次提交）
- [@kctony](https://github.com/kctony)（2 次提交）
- [@Akatsuki-Ryu](https://github.com/Akatsuki-Ryu)（1 次提交）
- [@AliceLJY](https://github.com/AliceLJY)（1 次提交）
- [@JasonSuz](https://github.com/JasonSuz)（1 次提交）
- [@Minidoracat](https://github.com/Minidoracat)（1 次提交）
- [@rwmjhb](https://github.com/rwmjhb)（1 次提交）
- [@furedericca-lab](https://github.com/furedericca-lab)（1 次提交）
- [@joe2643](https://github.com/joe2643)（1 次提交）
- [@chenjiyong](https://github.com/chenjiyong)（1 次提交）

完整列表：https://github.com/win4r/memory-lancedb-pro/graphs/contributors

## ⭐ Star 趋势

<a href="https://star-history.com/#win4r/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=win4r/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=win4r/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=win4r/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## License

MIT

---

## Buy Me a Coffee

[!["Buy Me A Coffee"](https://storage.ko-fi.com/cdn/kofi2.png?v=3)](https://ko-fi.com/aila)

## 我的微信群和微信二维码

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
