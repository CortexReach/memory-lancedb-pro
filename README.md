<div align="center">

# 🧠 memory-lancedb-pro · OpenClaw Plugin

**Enhanced Long-Term Memory Plugin for [OpenClaw](https://github.com/openclaw/openclaw)**

Hybrid Retrieval (Vector + BM25) · Cross-Encoder Rerank · Multi-Scope Isolation · Management CLI

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [简体中文](README_CN.md)

</div>

---

## 📺 Video Tutorial

> **Watch the full walkthrough - covers installation, configuration, and how hybrid retrieval works under the hood.**

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
🔗 **https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-立即观看-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
🔗 **https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Why This Plugin?

The built-in `memory-lancedb` plugin in OpenClaw provides basic vector search. **memory-lancedb-pro** takes it much further:

| Feature | Built-in `memory-lancedb` | **memory-lancedb-pro** |
|---------|--------------------------|----------------------|
| Vector search | ✅ | ✅ |
| BM25 full-text search | ❌ | ✅ |
| Hybrid fusion (Vector + BM25) | ❌ | ✅ |
| Cross-encoder rerank (Jina / custom endpoint) | ❌ | ✅ |
| Recency boost | ❌ | ✅ |
| Time decay | ❌ | ✅ |
| Length normalization | ❌ | ✅ |
| MMR diversity | ❌ | ✅ |
| Multi-scope isolation | ❌ | ✅ |
| Noise filtering | ❌ | ✅ |
| Adaptive retrieval | ❌ | ✅ |
| Management CLI | ❌ | ✅ |
| Session memory | ❌ | ✅ |
| Task-aware embeddings | ❌ | ✅ |
| Any OpenAI-compatible embedding | Limited | ✅ (OpenAI, Gemini, Jina, Ollama, etc.) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         index.ts (Entry Point)                      │
│     Plugin registration · config parsing · lifecycle orchestration  │
└────────┬───────────────────────────────┬─────────────────────────────┘
         │                               │
         │ generic auto-recall           │ reflection / inherited-rules
         │                               │
┌────────▼────────┐              ┌───────▼───────────────────────────┐
│   retriever.ts  │              │       reflection-recall.ts        │
│ vector/BM25/RRF │              │ dynamic reflection recall ranking │
│ rerank/filters  │              └───────────────┬───────────────────┘
└────────┬────────┘                              │
         │                               ┌──────▼────────────────────┐
┌────────▼───────────────┐               │ reflection-aggregation.ts │
│ postProcessAutoRecall  │               │ strictKey-group scoring   │
│ (index.ts local step)  │               └──────┬────────────────────┘
└────────┬───────────────┘                      │
         │                               ┌──────▼───────────────────────┐
         │ mmr | setwise-v2              │ reflection-recall-final-     │
┌────────▼────────────────────┐           │ selection.ts                 │
│ auto-recall-final-          │           └──────┬───────────────────────┘
│ selection.ts                │                  │
└────────┬────────────────────┘           ┌──────▼───────────────────────┐
         └────────────────────────────────► final-topk-setwise-         │
                                          │ selection.ts                │
                                          │ shared final top-k selector │
                                          └─────────────────────────────┘

Shared infrastructure: `store.ts`, `embedder.ts`, `scopes.ts`, `tools.ts`,
`noise-filter.ts`, `adaptive-retrieval.ts`, `recall-engine.ts`, `migrate.ts`, `cli.ts`
```

### File Reference

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Registers with OpenClaw Plugin API, parses config, mounts lifecycle hooks (`before_agent_start` / `before_prompt_build` / `agent_end`), routes generic auto-recall through `mmr | setwise-v2`, and coordinates reflection injection flows |
| `openclaw.plugin.json` | Plugin metadata + full JSON Schema config declaration (with `uiHints`) |
| `package.json` | NPM package info. Depends on `@lancedb/lancedb`, `openai`, `@sinclair/typebox` |
| `cli.ts` | CLI commands: `memory list/search/stats/delete/delete-bulk/export/import/reembed/migrate` |
| `src/store.ts` | LanceDB storage layer. Table creation / FTS indexing / Vector search / BM25 search / CRUD / bulk delete / stats |
| `src/embedder.ts` | Embedding abstraction. Compatible with any OpenAI-API provider (OpenAI, Gemini, Jina, Ollama, etc.). Supports task-aware embedding (`taskQuery`/`taskPassage`) |
| `src/retriever.ts` | Hybrid retrieval engine. Vector + BM25 → RRF fusion → rerank → recency / importance / length / decay weighting → noise filter → coarse MMR diversity. |
| `src/recall-engine.ts` | Shared recall helpers: prompt gating, session repeated-injection suppression, tagged-block assembly, max-age filtering, and recent-per-key capping |
| `src/auto-recall-final-selection.ts` | Generic auto-recall adapter. Maps `RetrievalResult` rows into final-selection candidates and applies generic `mmr | setwise-v2` behavior at the final cutoff seam |
| `src/final-topk-setwise-selection.ts` | Shared final top-k selector. Owns shortlist presort, deterministic set-wise selection, lexical-overlap suppression, and optional embedding-based semantic redundancy suppression |
| `src/reflection-recall.ts` | Dynamic Reflection-Recall ranking for `<inherited-rules>`. Filters/caps reflection items, computes scores, preserves `kind + strictKey` partitioning, and maps selected groups back to recall rows |
| `src/reflection-aggregation.ts` | Reflection group aggregation. Combines scored reflection items into strict-key groups with representative selection and final group scoring |
| `src/reflection-recall-final-selection.ts` | Reflection-specific adapter into the shared final selector for dynamic Reflection-Recall final top-k ordering |
| `src/reflection-selection.ts` | Historical derived-focus diversity ordering helper retained for reflection-store / handoff-note selection flows |
| `src/scopes.ts` | Multi-scope access control. Supports `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>` |
| `src/tools.ts` | Agent tool definitions: `memory_recall`, `memory_store`, `memory_forget` (core), `self_improvement_log` (default), and governance tools `self_improvement_review` / `self_improvement_extract_skill` (management mode) |
| `src/noise-filter.ts` | Noise filter. Filters out agent refusals, meta-questions, greetings, and low-quality content |
| `src/adaptive-retrieval.ts` | Adaptive retrieval. Determines whether a query needs memory retrieval (skips greetings, slash commands, simple confirmations, emoji) |
| `src/migrate.ts` | Migration tool. Migrates data from the built-in `memory-lancedb` plugin to Pro |

---

## Core Features

### 1. Hybrid Retrieval

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Recency Boost → Importance Weight → Filter
Query → BM25 FTS ─────┘
```

- **Vector Search**: Semantic similarity via LanceDB ANN (cosine distance)
- **BM25 Full-Text Search**: Exact keyword matching via LanceDB FTS index
- **Fusion Strategy**: Vector score as base, BM25 hits get a 15% boost (tuned beyond traditional RRF)
- **Configurable Weights**: `vectorWeight`, `bm25Weight`, `minScore`

### 2. Cross-Encoder Reranking

- **Reranker API**: Jina, SiliconFlow, Pinecone, or any compatible endpoint (5s timeout protection)
- **Hybrid Scoring**: 60% cross-encoder score + 40% original fused score
- **Graceful Degradation**: Falls back to cosine similarity reranking on API failure

### 3. Multi-Stage Scoring Pipeline

| Stage | Formula | Effect |
|-------|---------|--------|
| **Recency Boost** | `exp(-ageDays / halfLife) * weight` | Newer memories score higher (default: 14-day half-life, 0.10 weight) |
| **Importance Weight** | `score *= (0.7 + 0.3 * importance)` | importance=1.0 → ×1.0, importance=0.5 → ×0.85 |
| **Length Normalization** | `score *= 1 / (1 + 0.5 * log2(len/anchor))` | Prevents long entries from dominating (anchor: 500 chars) |
| **Time Decay** | `score *= 0.5 + 0.5 * exp(-ageDays / halfLife)` | Old entries gradually lose weight, floor at 0.5× (60-day half-life) |
| **Hard Min Score** | Discard if `score < threshold` | Removes irrelevant results (default: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → demoted | Prevents near-duplicate results |

### 4. Multi-Scope Isolation

- **Built-in Scopes**: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- **Agent-Level Access Control**: Configure per-agent scope access via `scopes.agentAccess`
- **Default Behavior**: Each agent accesses `global` + its own `agent:<id>` scope

### 5. Adaptive Retrieval

- Skips queries that don't need memory (greetings, slash commands, simple confirmations, emoji)
- Forces retrieval for memory-related keywords ("remember", "previously", "last time", etc.)
- CJK-aware thresholds (Chinese: 6 chars vs English: 15 chars)

### 6. Noise Filtering

Filters out low-quality content at both auto-capture and tool-store stages:
- Agent refusal responses ("I don't have any information")
- Meta-questions ("do you remember")
- Greetings ("hi", "hello", "HEARTBEAT")

### 7. Session Strategy

Use this to choose who owns `/new` / `/reset` session behavior.

- `sessionStrategy: "systemSessionMemory"` (default)
  - use OpenClaw built-in `session-memory`
  - plugin reflection hooks stay off
- `sessionStrategy: "memoryReflection"`
  - enable plugin reflection flow
  - `memoryReflection.*` settings take effect only in this mode
- `sessionStrategy: "none"`
  - disable plugin session strategy hooks entirely

 Legacy compatibility:
- `sessionMemory.enabled=true|false` still maps to `systemSessionMemory|none`
- `sessionMemory.messageCount` still maps to `memoryReflection.messageCount`

Recommended starter config:

```json
{
  "sessionStrategy": "memoryReflection"
}
```

### 8. Self-Improvement

Use this when you want the plugin to keep a lightweight governance trail of learnings and errors.

- Main tools:
  - `self_improvement_log`: append a structured learning/error entry
  - `self_improvement_review`: summarize pending governance backlog
  - `self_improvement_extract_skill`: scaffold a reusable skill from a proven learning entry
- Main config:
  - `selfImprovement.enabled`: master switch
  - `selfImprovement.beforeResetNote`: show a reminder before `/new` or `/reset`
  - `selfImprovement.ensureLearningFiles`: auto-create `.learnings/` files
  - `selfImprovement.managementTools`: expose review/extract tools
- Main outputs:
  - `.learnings/LEARNINGS.md`
  - `.learnings/ERRORS.md`
  - extracted skill scaffold under `.learnings/skills/...`

Recommended starter config:

```json
{
  "selfImprovement": {
    "enabled": true,
    "beforeResetNote": true,
    "ensureLearningFiles": true,
    "managementTools": true
  }
}
```

### 9. memoryReflection

Use this when you want reflection-based rule inheritance and optional reflection persistence.

What to configure first:
- `memoryReflection.enabled`: turn reflection features on/off
- `memoryReflection.injectMode`:
  - `inheritance-only` = inject inherited rules only
  - `inheritance+derived` = inherited rules + derived-focus note on `/new` / `/reset`
- `memoryReflection.recall.mode`:
  - `fixed` = compatibility path
  - `dynamic` = prompt-gated `<inherited-rules>` recall
- `memoryReflection.storeToLanceDB`: store reflection event/item rows in LanceDB
- `memoryReflection.agentId` (optional): use a dedicated reflection agent

Recommended starter config:

```json
{
  "memoryReflection": {
    "enabled": true,
    "injectMode": "inheritance-only",
    "storeToLanceDB": true,
    "recall": {
      "mode": "dynamic",
      "topK": 6,
      "includeKinds": ["invariant", "derived"],
      "maxAgeDays": 14,
      "maxEntriesPerKey": 7,
      "minRepeated": 3,
      "minScore": 0.22,
      "minPromptLength": 12
    }
  }
}
```

Quick behavior guide:
- `before_prompt_build` can inject `<inherited-rules>`
- `/new` / `/reset` can build the reflection note
- `before_prompt_build` can also inject `<error-detected>` reminders
- dynamic recall keeps `kind + strictKey` separation for invariant/derived rows

### 10. Markdown Mirror (`mdMirror`)

Use this when you want a readable Markdown copy of memories in addition to LanceDB.

Main config:
- `mdMirror.enabled`: turn Markdown dual-write on/off
- `mdMirror.dir`: fallback output directory when the agent workspace path is unavailable

What it does:
- writes memory entries to readable Markdown files
- prefers `memory/YYYY-MM-DD.md` in the mapped workspace
- falls back to `mdMirror.dir` when needed
- does not replace LanceDB retrieval/storage

Recommended starter config:

```json
{
  "mdMirror": {
    "enabled": true,
    "dir": "memory-md"
  }
}
```

### 11. Long Context Chunking

Automatically handles documents that exceed embedding model context limits:

- **Smart splitting**: Chunks at sentence boundaries with configurable overlap (default: 200 chars)
- **Averaged embedding**: Each chunk is embedded separately, then averaged for semantic preservation
- **Graceful error handling**: Detects "Input length exceeds context length" errors and retries with chunking
- **Config toggle**: `embedding.chunking` - set `false` to disable (default: auto-enabled on context-length errors)
- **Adapts to model limits**: Jina (8192 tokens), OpenAI (8191), Gemini (2048), etc.

See [`docs/long-context-chunking.md`](docs/long-context-chunking.md) for implementation details.

### 12. Embedding Error Diagnostics

When embedding calls fail, the plugin provides **actionable error messages** instead of generic errors:

- **Auth errors** (401/403): hints to check API key validity and format
- **Network errors** (ECONNREFUSED, ETIMEDOUT): hints to verify `baseURL` and network connectivity
- **Rate limits** (429): suggests retry or upgrading plan
- **Model not found** (404): suggests checking model name against provider docs
- **Context length exceeded**: automatically retries with chunking (see above)

### 13. Auto-Capture & Auto-Recall

- **Auto-Capture** (`agent_end` hook): Extracts preference/fact/decision/entity from conversations, deduplicates, stores up to 3 per turn
  - Skips memory-management prompts (e.g. delete/forget/cleanup memory entries) to reduce noise
- **Auto-Recall** (`before_agent_start` hook): Injects `<relevant-memories>` context
  - Default top-k: `autoRecallTopK=3`
  - Generic final-selection mode: `autoRecallSelectionMode` (`mmr` by default; `setwise-v2` to enable set-wise final selector)
  - Default category allowlist: `preference`, `fact`, `decision`, `entity`, `other`
  - `autoRecallExcludeReflection=true` by default, so `<relevant-memories>` stays separate from `<inherited-rules>`
  - Supports age window (`autoRecallMaxAgeDays`) and recent-per-key cap (`autoRecallMaxEntriesPerKey`)
  - `mmr`: post-processed rows use direct truncation (`slice(0, topK)`); this is simpler and closer to current retriever order, usually with stronger per-item relevance/score stability, but diversity/coverage is weaker
  - `setwise-v2`: final top-k uses shared set-wise selection (base score + freshness + light category/scope coverage + lexical overlap suppression + embedding-based semantic near-duplicate suppression), so diversity/coverage in the final top-k is usually better, but average per-item score/relevance can be lower than `mmr`
  - Choose according to your preference: prioritize rank stability/relevance with `mmr`, or prioritize diversity/coverage with `setwise-v2`.
  - This mode is generic auto-recall only. Reflection-Recall mode remains `fixed | dynamic`.

### Prevent memories from showing up in replies

Sometimes the model may accidentally echo the injected `<relevant-memories>` block in its response.

**Option A (recommended): disable auto-recall**

Set `autoRecall: false` in the plugin config and restart the gateway:

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

**Option B: keep recall, but ask the agent not to reveal it**

Add a line to your agent system prompt, e.g.:

> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

---

## Installation

> **🧪 Beta available: v1.1.0-beta.6**
>
> A beta release is available with major new features: **Self-Improvement governance**, **memoryReflection session strategy**, **Markdown Mirror**, and improved embedding error diagnostics. The stable `latest` remains at v1.0.32.
>
> ```bash
> # Install beta (opt-in)
> npm install memory-lancedb-pro@beta
>
> # Install stable (default)
> npm install memory-lancedb-pro
> ```
>
> See [Release Notes](https://github.com/win4r/memory-lancedb-pro/releases/tag/v1.1.0-beta.6) for details. Feedback welcome via [GitHub Issues](https://github.com/win4r/memory-lancedb-pro/issues).
>
> The `dev` dist-tag is an experimental track intended for early testing of the smart-memory feature set and may diverge from the mainline beta.
 
### AI-safe install notes (anti-hallucination)

If you are following this README using an AI assistant, **do not assume defaults**. Always run these commands first and use the real output:

```bash
openclaw config get agents.defaults.workspace
openclaw config get plugins.load.paths
openclaw config get plugins.slots.memory
openclaw config get plugins.entries.memory-lancedb-pro
```

Recommendations:
- Prefer **absolute paths** in `plugins.load.paths` unless you have confirmed the active workspace.
- If you use `${JINA_API_KEY}` (or any `${...}` variable) in config, ensure the **Gateway service process** has that environment variable (system services often do **not** inherit your interactive shell env).
- After changing plugin config, run `openclaw gateway restart`.

### Jina API keys (embedding + rerank)

- **Embedding**: set `embedding.apiKey` to your Jina key (recommended: use an env var like `${JINA_API_KEY}`).
- **Rerank** (when `retrieval.rerankProvider: "jina"`): you can typically use the **same** Jina key for `retrieval.rerankApiKey`.
- If you use a different rerank provider (`siliconflow`, `pinecone`, etc.), `retrieval.rerankApiKey` should be that provider's key.

Key storage guidance:
- Avoid committing secrets into git.
- Using `${...}` env vars is fine, but make sure the **Gateway service process** has those env vars (system services often do not inherit your interactive shell environment).

### What is the "OpenClaw workspace"?

In OpenClaw, the **agent workspace** is the agent's working directory (default: `~/.openclaw/workspace`).
According to the docs, the workspace is the **default cwd**, and **relative paths are resolved against the workspace** (unless you use an absolute path).

> Note: OpenClaw configuration typically lives under `~/.openclaw/openclaw.json` (separate from the workspace).

**Common mistake:** cloning the plugin somewhere else, while keeping a **relative path** like `plugins.load.paths: ["plugins/memory-lancedb-pro"]`. Relative paths can be resolved against different working directories depending on how the Gateway is started.

To avoid ambiguity, use an **absolute path** (Option B) or clone into `<workspace>/plugins/` (Option A) and keep your config consistent.

### Option A (recommended): clone into `plugins/` under your workspace

```bash
# 1) Go to your OpenClaw workspace (default: ~/.openclaw/workspace)
#    (You can override it via agents.defaults.workspace.)
cd /path/to/your/openclaw/workspace

# 2) Clone the plugin into workspace/plugins/
git clone https://github.com/win4r/memory-lancedb-pro.git plugins/memory-lancedb-pro

# 3) Install dependencies
cd plugins/memory-lancedb-pro
npm install
```

Then reference it with a relative path in your OpenClaw config:

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

### Option B: clone anywhere, but use an absolute path

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/memory-lancedb-pro"]
    }
  }
}
```

### Restart

```bash
openclaw gateway restart
```

> **Note:** If you previously used the built-in `memory-lancedb`, disable it when enabling this plugin. Only one memory plugin can be active at a time.

### Verify installation (recommended)

1) Confirm the plugin is discoverable/loaded:

```bash
openclaw plugins list
openclaw plugins info memory-lancedb-pro
```

2) If anything looks wrong, run the built-in diagnostics:

```bash
openclaw plugins doctor
```

3) Confirm the memory slot points to this plugin:

```bash
# Look for: plugins.slots.memory = "memory-lancedb-pro"
openclaw config get plugins.slots.memory
```

---

## Configuration

<details>
<summary><strong>Full Configuration Example (click to expand)</strong></summary>

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
  "autoRecallTopK": 3,
  "autoRecallSelectionMode": "mmr",
  "autoRecallCategories": ["preference", "fact", "decision", "entity", "other"],
  "autoRecallExcludeReflection": true,
  "autoRecallMaxAgeDays": 30,
  "autoRecallMaxEntriesPerKey": 10,
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
    "hardMinScore": 0.55,
    "timeDecayHalfLifeDays": 60,
    "reinforcementFactor": 0.5,
    "maxHalfLifeMultiplier": 3
  },
  "enableManagementTools": false,
  "sessionStrategy": "systemSessionMemory",
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
  "selfImprovement": {
    "enabled": true,
    "beforeResetNote": true,
    "skipSubagentBootstrap": true,
    "ensureLearningFiles": true
  },
  "memoryReflection": {
    "storeToLanceDB": true,
    "injectMode": "inheritance+derived",
    "agentId": "memory-distiller",
    "messageCount": 120,
    "maxInputChars": 24000,
    "timeoutMs": 20000,
    "thinkLevel": "medium",
    "errorReminderMaxEntries": 3,
    "dedupeErrorSignals": true,
    "recall": {
      "mode": "fixed",
      "topK": 6,
      "includeKinds": ["invariant"],
      "maxAgeDays": 45,
      "maxEntriesPerKey": 10,
      "minRepeated": 2,
      "minScore": 0.18,
      "minPromptLength": 8
    }
  },
  "mdMirror": {
    "enabled": false,
    "dir": "memory-md"
  }
}
```

Note: this example keeps `sessionStrategy: "systemSessionMemory"` for compatibility with existing users. The `memoryReflection.*` block documents the opt-in reflection pipeline, but it only becomes active after you explicitly switch `sessionStrategy` to `"memoryReflection"`.

</details>

### Parameter Mapping Notes (avoid common misconfig)

`memory-lancedb-pro` does **not** support `recallTopK` / `recallThreshold`.

Use these equivalents instead:

- `recallTopK` → `retrieval.candidatePoolSize`
- `recallThreshold` → combine `retrieval.minScore` + `retrieval.hardMinScore`

A practical starting point for Chinese chat workloads:

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "autoRecallMinLength": 8,
  "autoRecallSelectionMode": "mmr",
  "autoRecallExcludeReflection": true,
  "retrieval": {
    "candidatePoolSize": 20,
    "minScore": 0.45,
    "hardMinScore": 0.55
  }
}
```

### Access Reinforcement (1.0.26)

To make frequently used memories decay more slowly, the retriever can extend the effective time-decay half-life based on **manual recall frequency** (spaced-repetition style).

Config keys (under `retrieval`):
- `reinforcementFactor` (range: 0-2, default: `0.5`) - set `0` to disable
- `maxHalfLifeMultiplier` (range: 1-10, default: `3`) - hard cap: effective half-life ≤ base × multiplier

Notes:
- Reinforcement is **whitelisted to `source: "manual"`** (i.e. user/tool initiated recall), to avoid accidental strengthening from auto-recall.

### Embedding Providers

This plugin works with **any OpenAI-compatible embedding API**:

| Provider | Model | Base URL | Dimensions |
|----------|-------|----------|------------|
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | _provider-specific_ (set `embedding.dimensions` to match your Ollama model output) |

### Rerank Providers

Cross-encoder reranking supports multiple providers via `rerankProvider`:

| Provider | `rerankProvider` | Endpoint | Example Model |
|----------|-----------------|----------|---------------|
| **Jina** (default) | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v3` |
| **SiliconFlow** (free tier available) | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3`, `Qwen/Qwen3-Reranker-8B` |
| **Voyage AI** | `voyage` | `https://api.voyageai.com/v1/rerank` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |
| **vLLM / Docker Model Runner** | `vllm` | _requires custom endpoint_ | `Qwen3-Reranker` |

Notes:
- `voyage` sends `{ model, query, documents }` without `top_n`.
- Voyage responses are parsed from `data[].relevance_score`.
- `vllm` requires a custom `rerankEndpoint` (no API key needed). Only works on x86_64 NVIDIA platforms.

<details>
<summary><strong>SiliconFlow Example</strong></summary>

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
<summary><strong>Voyage Example</strong></summary>

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
<summary><strong>Pinecone Example</strong></summary>

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

<details>
<summary><strong>vLLM / Docker Model Runner Example</strong></summary>

```json
{
  "retrieval": {
    "rerank": "cross-encoder",
    "rerankProvider": "vllm",
    "rerankEndpoint": "http://host.docker.internal:12434/engines/vllm/rerank",
    "rerankModel": "ai/qwen3-reranker:0.6B"
  }
}
```

**Note:** vLLM reranking only works on x86_64 NVIDIA platforms. For macOS Apple Silicon, use `llama.cpp` for embeddings but not vLLM for reranking.
```

</details>

---

## Optional: JSONL Session Distillation (Auto-memories from chat logs)

OpenClaw already persists **full session transcripts** as JSONL files:

- `~/.openclaw/agents/<agentId>/sessions/*.jsonl`

This plugin focuses on **high-quality long-term memory**. If you dump raw transcripts into LanceDB, retrieval quality quickly degrades.

Instead, **recommended (2026-02+)** is a **non-blocking `/new` pipeline**:

- Trigger: `command:new` (you type `/new`)
- Hook: enqueue a tiny JSON task file (fast; no LLM calls inside the hook)
- Worker: a user-level systemd service watches the inbox and runs **Gemini Map-Reduce** on the session JSONL transcript
- Store: writes **0-20** high-signal, atomic lessons into LanceDB Pro via `openclaw memory-pro import`
- Keywords: each memory includes `Keywords (zh)` with a simple taxonomy (Entity + Action + Symptom). Entity keywords must be copied verbatim from the transcript (no hallucinated project names).
- Notify: optional Telegram/Discord notification (even if 0 lessons)

See the self-contained example files in:
- `examples/new-session-distill/`

---

Legacy option: an **hourly distiller** cron that:

1) Incrementally reads only the **newly appended tail** of each session JSONL (byte-offset cursor)
2) Filters noise (tool output, injected `<relevant-memories>`, logs, boilerplate)
3) Uses a dedicated agent to **distill** reusable lessons / rules / preferences into short atomic memories
4) Stores them via `memory_store` into the right **scope** (`global` or `agent:<agentId>`)

### What you get

- ✅ Fully automatic (cron)
- ✅ Multi-agent support (main + bots)
- ✅ No re-reading: cursor ensures the next run only processes new lines
- ✅ Memory hygiene: quality gate + dedupe + per-run caps

### Script

This repo includes the extractor script:

- `scripts/jsonl_distill.py`

It produces a small **batch JSON** file under:

- `~/.openclaw/state/jsonl-distill/batches/`

and keeps a cursor here:

- `~/.openclaw/state/jsonl-distill/cursor.json`

The script is **safe**: it never modifies session logs.

By default it skips historical reset snapshots (`*.reset.*`), slash-command/control-note lines (for example `/note self-improvement ...`), and excludes the distiller agent itself (`memory-distiller`) to prevent self-ingestion loops.

### Optional: restrict distillation sources (allowlist)

By default, the extractor scans **all agents** (except `memory-distiller`).

If you want higher signal (e.g., only distill from your main assistant + coding bot), set:

```bash
export OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS="main,code-agent"
```

- Unset / empty / `*` / `all` → allow all agents (default)
- Comma-separated list → only those agents are scanned

### Recommended setup (dedicated distiller agent)

#### 1) Create a dedicated agent

```bash
openclaw agents add memory-distiller \
  --non-interactive \
  --workspace ~/.openclaw/workspace-memory-distiller \
  --model openai-codex/gpt-5.2
```

#### 2) Initialize cursor (Mode A: start from now)

This marks all existing JSONL files as "already read" by setting offsets to EOF.

```bash
# Set PLUGIN_DIR to where this plugin is installed.
# - If you cloned into your OpenClaw workspace (recommended):
#   PLUGIN_DIR="$HOME/.openclaw/workspace/plugins/memory-lancedb-pro"
# - Otherwise, check: `openclaw plugins info memory-lancedb-pro` and locate the directory.
PLUGIN_DIR="/path/to/memory-lancedb-pro"

python3 "$PLUGIN_DIR/scripts/jsonl_distill.py" init
```

#### 3) Create an hourly cron job (Asia/Shanghai)

Tip: start the message with `run ...` so `memory-lancedb-pro`'s adaptive retrieval will skip auto-recall injection (saves tokens).

```bash
# IMPORTANT: replace <PLUGIN_DIR> in the template below with your actual plugin path.
MSG=$(cat <<'EOF'
run jsonl memory distill

Goal: distill NEW chat content from OpenClaw session JSONL files into high-quality LanceDB memories using memory_store.

Hard rules:
- Incremental only: call the extractor script; do NOT scan full history.
- Store only reusable memories; skip routine chatter.
- English memory text + final line: Keywords (zh): ...
- < 500 chars, atomic.
- <= 3 memories per agent per run; <= 3 global per run.
- Scope: global for broadly reusable; otherwise agent:<agentId>.

Workflow:
1) exec: python3 <PLUGIN_DIR>/scripts/jsonl_distill.py run
2) If noop: stop.
3) Read batchFile (created/pending)
4) memory_store(...) for selected memories
5) exec: python3 <PLUGIN_DIR>/scripts/jsonl_distill.py commit --batch-file <batchFile>
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

#### 4) Debug run

```bash
openclaw cron run <jobId> --expect-final --timeout 180000
openclaw cron runs --id <jobId> --limit 5
```

### Scope strategy (recommended)

When distilling **all agents**, always set `scope` explicitly when calling `memory_store`:

- Broadly reusable → `scope=global`
- Agent-specific → `scope=agent:<agentId>`

This prevents cross-bot memory pollution.

### Rollback

- Disable/remove cron job: `openclaw cron disable <jobId>` / `openclaw cron rm <jobId>`
- Delete agent: `openclaw agents delete memory-distiller`
- Remove cursor state: `rm -rf ~/.openclaw/state/jsonl-distill/`

---

## CLI Commands

```bash
# List memories (output includes the memory id)
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]

# Search memories
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json]

# View statistics
openclaw memory-pro stats [--scope global] [--json]

# Delete a memory by ID (supports 8+ char prefix)
# Tip: copy the id shown by `memory-pro list` / `memory-pro search` (or use --json for full output)
openclaw memory-pro delete <id>

# Bulk delete with filters
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]

# Export / Import
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]

# Re-embed all entries with a new model
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]

# Migrate from built-in memory-lancedb
openclaw memory-pro migrate check [--source /path]
openclaw memory-pro migrate run [--source /path] [--dry-run] [--skip-existing]
openclaw memory-pro migrate verify [--source /path]
```

---

## Custom Commands (e.g. `/lesson`)

This plugin provides tool-level building blocks. Slash commands such as `/lesson` are **not** built into the plugin itself; they are convenience commands you define in your Agent/system prompt, and they call the registered tools below.

### Recommended command shortcuts

- `/remember <content>`
  - call `memory_store`
  - choose the most appropriate category / importance / scope
- `/lesson <content>`
  - call `memory_store` twice:
    - once as `category=fact` for the lesson itself
    - once as `category=decision` for the actionable rule
- `/learn <summary>`
  - call `self_improvement_log` with `type=learning`
  - include `category`, `area`, `priority`, `details`, `suggestedAction` when available
- `/error <summary>`
  - call `self_improvement_log` with `type=error`
  - include reproducible symptom, context, and prevention / fix
- `/learnings` or `/review-learnings`
  - call `self_improvement_review`
- `/skill <learningId> <skill-name>`
  - call `self_improvement_extract_skill`

### Example prompt snippets

Add rules like these to your `CLAUDE.md`, `AGENTS.md`, or system prompt:

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

### Built-in Tools Reference

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory (supports category, importance, scope) |
| `memory_recall` | Search memories (hybrid vector + BM25 retrieval) |
| `memory_forget` | Delete a memory by ID or search query |
| `memory_update` | Update an existing memory in-place |
| `memory_list` | List recent memories with optional filtering |
| `memory_stats` | Show scope/category statistics |
| `self_improvement_log` | Log a structured learning/error entry into `.learnings/` |
| `self_improvement_review` | Summarize governance backlog from `.learnings/` |
| `self_improvement_extract_skill` | Create a skill scaffold from a learning entry |

> **Note**: custom commands like `/lesson`, `/learn`, `/error`, `/review-learnings`, or `/skill` are prompt-level shortcuts. The actual plugin surface is the tool set above.

---

## Database Schema

LanceDB table `memories`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Primary key |
| `text` | string | Memory text (FTS indexed) |
| `vector` | float[] | Embedding vector |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Scope identifier (e.g., `global`, `agent:main`) |
| `importance` | float | Importance score 0-1 |
| `timestamp` | int64 | Creation timestamp (ms) |
| `metadata` | string (JSON) | Extended metadata |

---

## Troubleshooting

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

On LanceDB 0.26+ (via Apache Arrow), some numeric columns may be returned as `BigInt` at runtime (commonly: `timestamp`, `importance`, `_distance`, `_score`). If you see errors like:

- `TypeError: Cannot mix BigInt and other types, use explicit conversions`

upgrade to **memory-lancedb-pro >= 1.0.14**. This plugin now coerces these values using `Number(...)` before doing arithmetic (for example, when computing scores or sorting by timestamp).

## Iron Rules for AI Agents (铁律)

> **For OpenClaw users**: copy the code block below into your `AGENTS.md` so your agent enforces these rules automatically.

```markdown
## Rule 1 - 双层记忆存储（铁律）

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

## Rule 2 - LanceDB 卫生

Entries must be short and atomic (< 500 chars). Never store raw conversation summaries, large blobs, or duplicates.
Prefer structured format with keywords for retrieval.

## Rule 3 - Recall before retry

On ANY tool failure, repeated error, or unexpected behavior, ALWAYS `memory_recall` with relevant keywords
(error message, tool name, symptom) BEFORE retrying. LanceDB likely already has the fix.
Blind retries waste time and repeat known mistakes.

## Rule 4 - 编辑前确认目标代码库

When working on memory plugins, confirm you are editing the intended package
(e.g., `memory-lancedb-pro` vs built-in `memory-lancedb`) before making changes;
use `memory_recall` + filesystem search to avoid patching the wrong repo.

## Rule 5 - 插件代码变更必须清 jiti 缓存（MANDATORY）

After modifying ANY `.ts` file under `plugins/`, MUST run `rm -rf /tmp/jiti/` BEFORE `openclaw gateway restart`.
jiti caches compiled TS; restart alone loads STALE code. This has caused silent bugs multiple times.
Config-only changes do NOT need cache clearing.
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@lancedb/lancedb` ≥0.26.2 | Vector database (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI-compatible Embedding API client |
| `@sinclair/typebox` 0.34.48 | JSON Schema type definitions (tool parameters) |

---

## Contributors

Top contributors (from GitHub's contributors list, sorted by commit contributions; bots excluded):

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

- [@win4r](https://github.com/win4r) (4 commits)
- [@kctony](https://github.com/kctony) (2 commits)
- [@Akatsuki-Ryu](https://github.com/Akatsuki-Ryu) (1 commit)
- [@AliceLJY](https://github.com/AliceLJY) (1 commit)
- [@JasonSuz](https://github.com/JasonSuz) (1 commit)
- [@Minidoracat](https://github.com/Minidoracat) (1 commit)
- [@rwmjhb](https://github.com/rwmjhb) (1 commit)
- [@furedericca-lab](https://github.com/furedericca-lab) (1 commit)
- [@joe2643](https://github.com/joe2643) (1 commit)
- [@chenjiyong](https://github.com/chenjiyong) (1 commit)

Full list: https://github.com/win4r/memory-lancedb-pro/graphs/contributors

## ⭐ Star History

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

## My WeChat Group and My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/d6dcfd1a-60fa-4b6f-9d5e-1482150a7d95" width="186" height="300">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
<img src="https://github.com/win4r/AISuperDomain/assets/42172631/fefe535c-8153-4046-bfb4-e65eacbf7a33" width="207" height="281">
