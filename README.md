<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**The production-grade long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

*Give your AI agent a brain that actually remembers — across sessions, across agents, across time.*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [简体中文](README_CN.md)

</div>

---

## ✨ Why memory-lancedb-pro?

Most AI agents have amnesia. They forget everything the moment you start a new chat. This plugin fixes that. It gives your OpenClaw agent **persistent, intelligent long-term memory** — without you managing any of it.

| | What you get |
|---|---|
| 🔍 **Hybrid Retrieval** | Vector + BM25 full-text search, fused with cross-encoder reranking |
| 🧠 **Smart Extraction** | LLM-powered 6-category memory extraction — no manual `memory_store` needed |
| ⏳ **Memory Lifecycle** | Weibull decay + 3-tier promotion — important memories surface, stale ones fade |
| 🔒 **Multi-Scope Isolation** | Per-agent, per-user, per-project memory boundaries |
| 🔌 **Any Embedding Provider** | OpenAI, Jina, Gemini, Ollama, or any OpenAI-compatible API |
| 🛠️ **Full Operations Toolkit** | CLI, backup, migration, upgrade, export/import — not a toy |

---

## 🆚 Compared to Built-in `memory-lancedb`

| Feature | Built-in `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Vector search | ✅ | ✅ |
| BM25 full-text search | ❌ | ✅ |
| Hybrid fusion (Vector + BM25) | ❌ | ✅ |
| Cross-encoder rerank (multi-provider) | ❌ | ✅ |
| Recency boost & time decay | ❌ | ✅ |
| Length normalization | ❌ | ✅ |
| MMR diversity | ❌ | ✅ |
| Multi-scope isolation | ❌ | ✅ |
| Noise filtering | ❌ | ✅ |
| Adaptive retrieval | ❌ | ✅ |
| Management CLI | ❌ | ✅ |
| Session memory | ❌ | ✅ |
| Task-aware embeddings | ❌ | ✅ |
| **LLM Smart Extraction (6-category)** | ❌ | ✅ (v1.1.0) |
| **Weibull Decay + Tier Promotion** | ❌ | ✅ (v1.1.0) |
| **Legacy Memory Upgrade** | ❌ | ✅ (v1.1.0) |
| Any OpenAI-compatible embedding | Limited | ✅ |

---

## 📺 Video Tutorial

> Full walkthrough: installation, configuration, and hybrid retrieval internals.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
🔗 **https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
🔗 **https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## 🚀 Quick Start (30 seconds)

### 1. Install

```bash
npm i memory-lancedb-pro@beta
```

### 2. Configure

Add to your `openclaw.json`:

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

**Why these defaults?**
- `autoCapture` + `smartExtraction` → your agent learns from every conversation automatically
- `autoRecall` → relevant memories are injected before each reply
- `extractMinMessages: 2` → extraction triggers in normal two-turn chats
- `sessionMemory: false` → avoids polluting retrieval with session summaries on day one

### 3. Validate & restart

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | rg "memory-lancedb-pro"
```

You should see:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

🎉 **Done!** Your agent now has long-term memory.

<details>
<summary><strong>💬 OpenClaw Quick Import via Telegram Bot (click to expand)</strong></summary>

If you are using OpenClaw's Telegram integration, the easiest way is to send an import command directly to the main Bot instead of manually editing config.

Send this message:

```text
Help me connect this memory plugin with the best user-experience config: https://github.com/CortexReach/memory-lancedb-pro

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

If you already have your own OpenAI-compatible services, just replace the relevant block:

- `embedding`: change `apiKey` / `model` / `baseURL` / `dimensions`
- `retrieval`: change `rerankProvider` / `rerankEndpoint` / `rerankModel` / `rerankApiKey`
- `llm`: change `apiKey` / `model` / `baseURL` / `timeoutMs`

For example, to replace only the LLM:

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

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Entry Point)                │
│  Plugin Registration · Config Parsing · Lifecycle Hooks │
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

> 📖 For a deep-dive into the full architecture (data flow, lifecycle, storage internals), see [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>📄 File Reference (click to expand)</strong></summary>

| File | Purpose |
| --- | --- |
| `index.ts` | Plugin entry point. Registers with OpenClaw Plugin API, parses config, mounts `before_agent_start` (auto-recall), `agent_end` (auto-capture), and `command:new` (session memory) hooks |
| `openclaw.plugin.json` | Plugin metadata + full JSON Schema config declaration (with `uiHints`) |
| `package.json` | NPM package info. Depends on `@lancedb/lancedb`, `openai`, `@sinclair/typebox` |
| `cli.ts` | CLI commands: `memory list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB storage layer. Table creation / FTS indexing / Vector search / BM25 search / CRUD / bulk delete / stats |
| `src/embedder.ts` | Embedding abstraction. Compatible with any OpenAI-API provider. Supports task-aware embedding (`taskQuery`/`taskPassage`) |
| `src/retriever.ts` | Hybrid retrieval engine. Vector + BM25 → RRF fusion → Rerank → Lifecycle Decay → Length Norm → Hard Min Score → Noise Filter → MMR |
| `src/scopes.ts` | Multi-scope access control: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>` |
| `src/tools.ts` | Agent tool definitions: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + management tools |
| `src/noise-filter.ts` | Filters out agent refusals, meta-questions, greetings, and low-quality content |
| `src/adaptive-retrieval.ts` | Determines whether a query needs memory retrieval |
| `src/migrate.ts` | Migration from built-in `memory-lancedb` to Pro |
| `src/smart-extractor.ts` | **(v1.1.0)** LLM-powered 6-category extraction with L0/L1/L2 layered storage and two-stage dedup |
| `src/memory-categories.ts` | **(v1.1.0)** 6-category system: profile, preferences, entities, events, cases, patterns |
| `src/decay-engine.ts` | **(v1.1.0)** Weibull stretched-exponential decay model |
| `src/tier-manager.ts` | **(v1.1.0)** Three-tier promotion/demotion: Peripheral ⟷ Working ⟷ Core |
| `src/memory-upgrader.ts` | **(v1.1.0)** Batch upgrade legacy memories to new smart format |
| `src/llm-client.ts` | **(v1.1.0)** LLM client for structured JSON output |
| `src/extraction-prompts.ts` | **(v1.1.0)** LLM prompt templates for extraction, dedup, and merge |
| `src/smart-metadata.ts` | **(v1.1.0)** Metadata normalization for L0/L1/L2, tier, confidence, access counters, and lifecycle fields |

</details>

---

## 📦 Core Features

### Hybrid Retrieval

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **Vector Search** — semantic similarity via LanceDB ANN (cosine distance)
- **BM25 Full-Text Search** — exact keyword matching via LanceDB FTS index
- **Fusion** — vector score as base, BM25 hits get a 15% boost (tuned beyond traditional RRF)
- **Configurable Weights** — `vectorWeight`, `bm25Weight`, `minScore`

### Cross-Encoder Reranking

- Supports **Jina-compatible endpoints** plus dedicated adapters for **TEI**, **SiliconFlow**, **Voyage AI**, **Pinecone**, and **DashScope**
- Hybrid scoring: 60% cross-encoder + 40% original fused score
- Graceful degradation: falls back to cosine similarity on API failure

### Multi-Stage Scoring Pipeline

| Stage | Effect |
| --- | --- |
| **RRF Fusion** | Combines semantic and exact-match recall |
| **Cross-Encoder Rerank** | Promotes semantically precise hits |
| **Lifecycle Decay Boost** | Weibull freshness + access frequency + importance × confidence |
| **Length Normalization** | Prevents long entries from dominating (anchor: 500 chars) |
| **Hard Min Score** | Removes irrelevant results (default: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → demoted |

### Smart Memory Extraction (v1.1.0)

- **LLM-Powered 6-Category Extraction**: profile, preferences, entities, events, cases, patterns
- **L0/L1/L2 Layered Storage**: L0 (one-sentence index) → L1 (structured summary) → L2 (full narrative)
- **Two-Stage Dedup**: vector similarity pre-filter (≥0.7) → LLM semantic decision (CREATE/MERGE/SKIP)
- **Category-Aware Merge**: `profile` always merges, `events`/`cases` are append-only

### Memory Lifecycle Management (v1.1.0)

- **Weibull Decay Engine**: composite score = recency + frequency + intrinsic value
- **Decay-Aware Retrieval**: results re-ranked by lifecycle decay
- **Three-Tier Promotion**: `Peripheral ⟷ Working ⟷ Core` with configurable thresholds
- **Importance-Modulated Half-Life**: important memories decay slower

### Multi-Scope Isolation

- Built-in scopes: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Agent-level access control via `scopes.agentAccess`
- Default: each agent accesses `global` + its own `agent:<id>` scope

### Auto-Capture & Auto-Recall

- **Auto-Capture** (`agent_end`): extracts preference/fact/decision/entity from conversations, deduplicates, stores up to 3 per turn
- **Auto-Recall** (`before_agent_start`): injects `<relevant-memories>` context (up to 3 entries)

### Noise Filtering & Adaptive Retrieval

- Filters low-quality content: agent refusals, meta-questions, greetings
- Skips retrieval for greetings, slash commands, simple confirmations, emoji
- Forces retrieval for memory keywords ("remember", "previously", "last time")
- CJK-aware thresholds (Chinese: 6 chars vs English: 15 chars)

### Legacy Memory Upgrade (v1.1.0)

- One-command upgrade: `openclaw memory-pro upgrade`
- LLM or no-LLM mode for offline use
- Automatic detection at startup with upgrade suggestion

---

## ⚙️ Configuration

<details>
<summary><strong>Full Configuration Example</strong></summary>

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

OpenClaw-specific defaults:

- `autoCapture`: enabled by default
- `autoRecall`: disabled by default in the plugin schema, but for most new users this README recommends turning it on
- `embedding.chunking`: enabled by default
- `sessionMemory.enabled`: disabled by default; set to `true` explicitly if you want the `/new` session-summary hook

</details>

<details>
<summary><strong>Embedding Providers</strong></summary>

This plugin works with **any OpenAI-compatible embedding API**:

| Provider | Model | Base URL | Dimensions |
| --- | --- | --- | --- |
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | _provider-specific_ |

</details>

<details>
<summary><strong>Rerank Providers</strong></summary>

Cross-encoder reranking supports multiple providers via `rerankProvider`:

| Provider | `rerankProvider` | Endpoint | Example Model |
| --- | --- | --- | --- |
| **Jina** (default) | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v3` |
| **Hugging Face TEI** | `tei` | `http://host:8081/rerank` | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow** (free tier available) | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `https://api.voyageai.com/v1/rerank` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |

<details>
<summary>TEI config example</summary>

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

Notes:
- `tei` sends `{ query, texts }` and parses the top-level `[{ index, score }]` response used by Hugging Face Text Embeddings Inference.
- `rerankModel` is ignored by the TEI adapter, so you do not need to set it for TEI container endpoints.
- If your local TEI endpoint does not require auth, a placeholder `rerankApiKey` still enables the cross-encoder rerank path.

</details>

<details>
<summary>SiliconFlow config example</summary>

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
<summary>Voyage config example</summary>

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
<summary>Pinecone config example</summary>

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

Notes:
- TEI request/response shape is documented in the TEI config example above.
- `voyage` sends `{ model, query, documents }` without `top_n`. Responses are parsed from `data[].relevance_score`.

</details>

<details>
<summary><strong>Smart Extraction (LLM) — v1.1.0</strong></summary>

When `smartExtraction` is enabled (default: `true`), the plugin uses an LLM to intelligently extract and classify memories instead of regex-based triggers.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | Enable/disable LLM-powered 6-category extraction |
| `llm.apiKey` | string | *(falls back to `embedding.apiKey`)* | API key for the LLM provider |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM model name |
| `llm.baseURL` | string | *(falls back to `embedding.baseURL`)* | LLM API endpoint |
| `llm.timeoutMs` | number | `30000` | LLM request timeout in milliseconds |
| `extractMinMessages` | number | `2` | Minimum messages before extraction triggers |
| `extractMaxChars` | number | `8000` | Maximum characters sent to the LLM |

Minimal config (reuses embedding API key):
```json
{
  "embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" },
  "smartExtraction": true
}
```

Full config (separate LLM endpoint):
```json
{
  "embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-small" },
  "smartExtraction": true,
  "llm": { "apiKey": "${OPENAI_API_KEY}", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1", "timeoutMs": 30000 },
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

Disable: `{ "smartExtraction": false }`

</details>

<details>
<summary><strong>Lifecycle Configuration (Decay + Tier)</strong></summary>

These settings control freshness ranking and automatic tier transitions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `decay.recencyHalfLifeDays` | number | `30` | Base half-life for Weibull recency decay |
| `decay.frequencyWeight` | number | `0.3` | Weight of access frequency in composite score |
| `decay.intrinsicWeight` | number | `0.3` | Weight of `importance × confidence` |
| `decay.betaCore` | number | `0.8` | Weibull beta for `core` memories |
| `decay.betaWorking` | number | `1.0` | Weibull beta for `working` memories |
| `decay.betaPeripheral` | number | `1.3` | Weibull beta for `peripheral` memories |
| `tier.coreAccessThreshold` | number | `10` | Min recall count before promoting to `core` |
| `tier.coreCompositeThreshold` | number | `0.7` | Min lifecycle score before promoting to `core` |
| `tier.peripheralCompositeThreshold` | number | `0.15` | Below this score, `working` may demote |
| `tier.peripheralAgeDays` | number | `60` | Age threshold for demoting stale memories |

```json
{
  "decay": { "recencyHalfLifeDays": 21, "betaCore": 0.7, "betaPeripheral": 1.5 },
  "tier": { "coreAccessThreshold": 8, "peripheralAgeDays": 45 }
}
```

</details>

<details>
<summary><strong>Access Reinforcement (1.0.26)</strong></summary>

Frequently recalled memories decay more slowly (spaced-repetition style).

Config keys (under `retrieval`):
- `reinforcementFactor` (0–2, default: `0.5`) — set `0` to disable
- `maxHalfLifeMultiplier` (1–10, default: `3`) — hard cap on effective half-life

Note: reinforcement is whitelisted to `source: "manual"` only, to avoid auto-recall accidentally strengthening noise.

</details>

---

## 📥 Installation

<details>
<summary><strong>Path A — New to OpenClaw (recommended)</strong></summary>

1. Clone into your workspace:

```bash
cd /path/to/your/openclaw/workspace
git clone https://github.com/CortexReach/memory-lancedb-pro.git plugins/memory-lancedb-pro
cd plugins/memory-lancedb-pro
npm install
```

2. Add to `openclaw.json` (relative path):

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

3. Restart and verify:

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
openclaw memory-pro stats
```

4. Smoke test: store one memory → search by keyword → search by natural language.

</details>

<details>
<summary><strong>Path B — Already using OpenClaw, adding this plugin</strong></summary>

1. Keep your existing agents, channels, and models unchanged
2. Add the plugin with an **absolute** `plugins.load.paths` entry:

```json
{ "plugins": { "load": { "paths": ["/absolute/path/to/memory-lancedb-pro"] } } }
```

3. Bind the memory slot: `plugins.slots.memory = "memory-lancedb-pro"`
4. Verify: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

</details>

<details>
<summary><strong>Path C — Upgrading from older memory-lancedb-pro (pre-v1.1.0)</strong></summary>

Command boundaries:
- `upgrade` — for **older `memory-lancedb-pro` data**
- `migrate` — only from built-in **`memory-lancedb`**
- `reembed` — only when rebuilding embeddings after model change

Safe upgrade sequence:

```bash
# 1) Backup
openclaw memory-pro export --scope global --output memories-backup.json

# 2) Dry run
openclaw memory-pro upgrade --dry-run

# 3) Run upgrade
openclaw memory-pro upgrade

# 4) Verify
openclaw memory-pro stats
openclaw memory-pro search "your known keyword" --scope global --limit 5
```

See `CHANGELOG-v1.1.0.md` for behavior changes and upgrade rationale.

</details>

<details>
<summary><strong>Post-install verification checklist</strong></summary>

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
openclaw hooks list --json
openclaw memory-pro stats
openclaw memory-pro list --scope global --limit 5
```

Then validate:
- ✅ one exact-id search hit
- ✅ one natural-language search hit
- ✅ one `memory_store` → `memory_recall` round trip
- ✅ if session memory is enabled, one real `/new` test

</details>

<details>
<summary><strong>AI-safe install notes (anti-hallucination)</strong></summary>

If you are following this README with an AI assistant, **do not assume defaults**. Always run:

```bash
openclaw config get agents.defaults.workspace
openclaw config get plugins.load.paths
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-lancedb-pro
```

Tips:
- Prefer **absolute paths** in `plugins.load.paths`
- If you use `${JINA_API_KEY}` in config, ensure the **Gateway service process** has that env var
- After changing plugin config, run `openclaw gateway restart`

</details>

<details>
<summary><strong>Jina API keys (embedding + rerank)</strong></summary>

- **Embedding**: set `embedding.apiKey` to your Jina key (use env var `${JINA_API_KEY}` recommended)
- **Rerank** (when `rerankProvider: "jina"`): you can use the **same** Jina key for `retrieval.rerankApiKey`
- Different rerank provider? Use that provider's key for `retrieval.rerankApiKey`

Key storage: avoid committing secrets into git. When using `${...}` env vars, ensure the Gateway service process has them.

</details>

<details>
<summary><strong>What is the "OpenClaw workspace"?</strong></summary>

The **agent workspace** is the agent's working directory (default: `~/.openclaw/workspace`). Relative paths are resolved against the workspace.

> Note: OpenClaw config typically lives at `~/.openclaw/openclaw.json` (separate from the workspace).

**Common mistake:** cloning the plugin elsewhere while keeping a relative path in config. Use an absolute path (Path B) or clone into `<workspace>/plugins/` (Path A).

</details>

---

## 🔧 CLI Commands

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

## 📚 Advanced Topics

<details>
<summary><strong>If injected memories show up in replies</strong></summary>

Sometimes the model may echo the injected `<relevant-memories>` block.

**Option A (lowest-risk):** temporarily disable auto-recall:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Option B (preferred):** keep recall, add to agent system prompt:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

</details>

<details>
<summary><strong>Session Memory</strong></summary>

- Triggered on `/new` command — saves previous session summary to LanceDB
- Disabled by default (OpenClaw already has native `.jsonl` session persistence)
- Configurable message count (default: 15)

See [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) for deployment modes and `/new` verification.

</details>

<details>
<summary><strong>JSONL Session Distillation (auto-memories from chat logs)</strong></summary>

OpenClaw persists full session transcripts as JSONL: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`

**Recommended (2026-02+)**: non-blocking `/new` pipeline:
- Trigger: `command:new` → enqueue tiny JSON task (no LLM calls in hook)
- Worker: systemd service runs Gemini Map-Reduce on session JSONL
- Store: writes 0–20 high-signal lessons via `openclaw memory-pro import`
- Keywords: each memory includes `Keywords (zh)` with entity keywords copied verbatim from transcript

Example files: `examples/new-session-distill/`

**Legacy option**: hourly distiller cron using `scripts/jsonl_distill.py`:
- Incremental reads (byte-offset cursor), filters noise, uses a dedicated agent to distill
- Stores via `memory_store` into the right scope
- Safe: never modifies session logs

Setup:
1. Create agent: `openclaw agents add memory-distiller --non-interactive --workspace ~/.openclaw/workspace-memory-distiller --model openai-codex/gpt-5.2`
2. Init cursor: `python3 "$PLUGIN_DIR/scripts/jsonl_distill.py" init`
3. Add cron: see full command in the [legacy distillation docs](docs/openclaw-integration-playbook.md)

Rollback: `openclaw cron disable <jobId>` → `openclaw agents delete memory-distiller` → `rm -rf ~/.openclaw/state/jsonl-distill/`

</details>

<details>
<summary><strong>Custom Slash Commands (e.g. /lesson)</strong></summary>

Add to your `CLAUDE.md`, `AGENTS.md`, or system prompt:

```markdown
## /lesson command
When the user sends `/lesson <content>`:
1. Use memory_store to save as category=fact (raw knowledge)
2. Use memory_store to save as category=decision (actionable takeaway)
3. Confirm what was saved

## /remember command
When the user sends `/remember <content>`:
1. Use memory_store to save with appropriate category and importance
2. Confirm with the stored memory ID
```

Built-in tools: `memory_store`, `memory_recall`, `memory_forget`, `memory_update` — registered automatically when the plugin loads.

</details>

<details>
<summary><strong>Iron Rules for AI Agents (铁律)</strong></summary>

> Copy the block below into your `AGENTS.md` so your agent enforces these rules automatically.

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
<summary><strong>Database Schema</strong></summary>

LanceDB table `memories`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (UUID) | Primary key |
| `text` | string | Memory text (FTS indexed) |
| `vector` | float[] | Embedding vector |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `other` |
| `scope` | string | Scope identifier (e.g., `global`, `agent:main`) |
| `importance` | float | Importance score 0–1 |
| `timestamp` | int64 | Creation timestamp (ms) |
| `metadata` | string (JSON) | Extended metadata |

Common `metadata` keys in v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

On LanceDB 0.26+, some numeric columns may be returned as `BigInt`. Upgrade to **memory-lancedb-pro >= 1.0.14** — this plugin now coerces values using `Number(...)` before arithmetic.

</details>

---

## 🧪 Beta: Smart Memory v1.1.0

> Status: Beta — available via `npm i memory-lancedb-pro@beta`. Stable users on `latest` are not affected.

| Feature | Description |
|---------|-------------|
| **Smart Extraction** | LLM-powered 6-category extraction with L0/L1/L2 metadata. Falls back to regex when disabled. |
| **Lifecycle Scoring** | Weibull decay integrated into retrieval — high-frequency and high-importance memories rank higher. |
| **Tier Management** | Three-tier system (Core → Working → Peripheral) with automatic promotion/demotion. |

Feedback: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Revert: `npm i memory-lancedb-pro@latest`

---

## 📖 Documentation

| Document | Description |
| --- | --- |
| [OpenClaw Integration Playbook](docs/openclaw-integration-playbook.md) | Deployment modes, `/new` verification, regression matrix |
| [Memory Architecture Analysis](docs/memory_architecture_analysis.md) | Full architecture deep-dive |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 behavior changes and upgrade rationale |
| [Long-Context Chunking](docs/long-context-chunking.md) | Chunking strategy for long documents |

---

## Dependencies

| Package | Purpose |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Vector database (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI-compatible Embedding API client |
| `@sinclair/typebox` 0.34.48 | JSON Schema type definitions |

---

## 🤝 Contributors

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

## ⭐ Star History

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


## My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
