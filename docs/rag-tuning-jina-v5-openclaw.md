# RAG Tuning with jina-embeddings-v5-text-small: Lessons from Production OpenClaw Deployments

This document records embedding and LLM tuning decisions made during real `memory-lancedb-pro` deployments in OpenClaw agent pipelines. The goal is to give operators actionable data rather than general advice.

Environment: OpenClaw 2026.3.8 (Linux server) and 2026.3.13 (macOS), plugin `memory-lancedb-pro` v1.1.0-beta.9, Jina AI embeddings API, OpenRouter LLM API.

---

## Why embedding model choice matters in a RAG plugin

`memory-lancedb-pro` runs two distinct embedding calls per turn:

- **Recall path** (`before_agent_start` hook): embeds the current user message with `task: retrieval.query`, searches LanceDB with hybrid fusion (vector + BM25), then cross-encoder reranks. This runs under a configurable timeout.
- **Capture path** (`after_tool_call` / `agent_end` hook): embeds extracted memory text with `task: retrieval.passage` and upserts into LanceDB.

Both calls share the same configured model. A model switch requires a full re-embed of the existing memory store because vector spaces are not comparable across model versions—even when the output dimension is identical.

---

## Model comparison: jina-embeddings-v3 vs jina-embeddings-v5-text-small

### What changed in v5-text-small

`jina-embeddings-v5-text-small` (released February 18, 2026) is built on `Qwen3-0.6B-Base` with 677M parameters. Key differences from v3:

| Property | v3 | v5-text-small |
|---|---|---|
| Base model | proprietary | Qwen/Qwen3-0.6B-Base |
| Parameters | ~570M | 677M |
| Max sequence length | 8192 | **32768** |
| Embedding dimension | 1024 | 1024 |
| Matryoshka support | ✓ | ✓ (32–1024) |
| MTEB English v2 | — | **71.7 avg** |
| MMTEB multilingual | — | **67.7 avg** (highest under 1B params) |
| Supported languages | 100+ | **119+** |
| Training method | contrastive | distillation from Qwen3-Embedding-4B + contrastive |

The 32K context window is meaningful for memory extraction: long conversation turns that previously required chunking can now be embedded as a single passage.

### Recall benchmark results

Test corpus: 4 Chinese-language domain memories (project entity, technical stack, data source, decision record). Queries measured with pure vector similarity (cosine) before hybrid fusion and reranking are applied. Production recall using the full hybrid pipeline will score higher on keyword-rich queries.

| Query | v3 score | v5-text-small score | Δ |
|---|---|---|---|
| 胖冬瓜项目是什么 (entity name) | 74.7% | **77.8%** | +3.1% |
| 农产品期货定价策略 (domain concept) | −2.8% | **2.3%** | +5.1% |
| 芝加哥商品交易所CME数据集 (keyword phrase) | 11.8% | **26.6%** | +14.8% |

The largest gain is on the keyword-phrase query. v5-text-small's distillation from a 4B-parameter teacher model produces richer representations for technical terminology.

### API usage: task-specific calls

The plugin uses task-differentiated calls. Verify these match the API documentation:

```json
{
  "embedding": {
    "model": "jina-embeddings-v5-text-small",
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  }
}
```

Do not send `dimensions: 1024` when it is the default—some Jina API edge versions reject it.

---

## Migration procedure when switching embedding models

Different embedding models produce incompatible vector spaces. Even if the output dimension is identical (both v3 and v5-text-small produce 1024-dim vectors), stored vectors must be regenerated.

### Step 1: Export existing memories

```bash
openclaw memory-pro export --output /tmp/memories_backup.json
```

Verify the count:
```bash
python3 -c "import json; d=json.load(open('/tmp/memories_backup.json')); print(len(d.get('memories', d)))"
```

### Step 2: Clear the LanceDB store

```bash
rm -rf ~/.openclaw/memory/lancedb-pro/
```

The plugin will recreate the directory and schema on next startup or import.

### Step 3: Update the config

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "config": {
          "embedding": {
            "model": "jina-embeddings-v5-text-small"
          }
        }
      }
    }
  }
}
```

Validate before restarting:
```bash
openclaw config validate
```

### Step 4: Re-import and verify embeddings

```bash
openclaw memory-pro import /tmp/memories_backup.json
```

For OpenClaw 2026.3.13+, run the upgrade after import:
```bash
openclaw memory-pro upgrade
```

For OpenClaw 2026.3.8, use `reembed` instead:
```bash
openclaw memory-pro reembed \
  --source-db ~/.openclaw/memory/lancedb-pro \
  --force \
  --batch-size 4
```

> ⚠️ **`reembed --force` adds rows, it does not replace them.** After running it once, you will have N original rows plus N new rows (total 2N). Clear the table first, then import, and skip the redundant reembed step. The `import` command alone generates embeddings.

### Step 5: Confirm embedding dimensions in LanceDB

```javascript
const lancedb = require('/path/to/memory-lancedb-pro/node_modules/@lancedb/lancedb');
async function check() {
  const db = await lancedb.connect('/path/to/lancedb-pro');
  const tbl = await db.openTable('memories');
  const count = await tbl.countRows();
  const rows = await tbl.query().limit(1).toArray();
  const dim = (rows[0].embedding || rows[0].vector || []).length;
  console.log(`rows=${count}, embedding_dim=${dim}`);
}
check();
```

Expected output: `rows=N, embedding_dim=1024`

---

## SmartExtraction LLM: sizing and selection

SmartExtraction uses a configurable LLM to parse conversation turns into structured memory records. It does not need a frontier-class model. The requirements are:

- OpenAI-compatible chat completions API
- reliable structured JSON output
- Chinese language support (if conversations are in Chinese)
- fast time-to-first-token (TTFT), since extraction runs at end of session

### Model comparison tested via OpenRouter

| Model | Completion tokens | Cost / call | Chinese fidelity | Notes |
|---|---|---|---|---|
| `qwen/qwen-2.5-7b-instruct` | ~150 | $0.000015 | ✓ Chinese | Previous config, stable |
| `qwen/qwen3-14b` | ~456 | $0.000115 | ✓ Chinese | Covert CoT uses 483 reasoning tokens even with `thinking: disabled`; expensive for extraction |
| `qwen/qwen3-vl-8b-instruct` | **35** | **$0.0000211** | ✓ Chinese (verbatim) | Fast, 5× cheaper, preserves source text |

`qwen3-vl-8b-instruct` is a vision-language model used here for text-only extraction. The vision capability is unused, but the model handles pure-text structured output efficiently.

The `qwen3-14b` benchmark illustrates a recurring pattern: newer "thinking" models spend completion budget on internal reasoning even when instructed otherwise. For extraction tasks with well-structured prompts, a smaller non-thinking model wins on both cost and latency.

### Recommended config

```json
{
  "llm": {
    "apiKey": "YOUR_OPENROUTER_KEY",
    "model": "qwen/qwen3-vl-8b-instruct",
    "baseURL": "https://openrouter.ai/api/v1"
  },
  "smartExtraction": true,
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

> **Config schema note for v1.1.0-beta.9:** The `llm` block only accepts `apiKey`, `model`, `baseURL`. Do not include `auth` or `timeoutMs`—the JSON Schema validator will reject them with `must NOT have additional properties`.

---

## Recall timeout: a required code patch

The auto-recall pipeline runs synchronously on the `before_agent_start` hook. In v1.1.0-beta.9, the timeout is hardcoded:

```typescript
// index.ts, line ~2079
const AUTO_RECALL_TIMEOUT_MS = 3_000;
```

With Jina AI's embeddings API, a typical round-trip is 0.8–1.5 seconds for embedding plus 0.8–1.5 seconds for cross-encoder reranking. Under normal API latency this consistently exceeds the 3-second limit, producing:

```
memory-lancedb-pro: auto-recall timed out after 3000ms; skipping memory injection
```

### Patch

Two changes are required.

**`index.ts`** — add to the config interface:
```typescript
autoRecallMinRepeated?: number;
autoRecallTimeoutMs?: number;  // add this line
```

**`index.ts`** — make the constant configurable:
```typescript
// before
const AUTO_RECALL_TIMEOUT_MS = 3_000;
// after
const AUTO_RECALL_TIMEOUT_MS = config.autoRecallTimeoutMs ?? 3_000;
```

**`openclaw.plugin.json`** — add schema entry after `autoRecallMinRepeated`:
```json
"autoRecallTimeoutMs": {
  "type": "integer",
  "minimum": 1000,
  "maximum": 60000,
  "default": 3000,
  "description": "Timeout in milliseconds for the auto-recall pipeline."
}
```

**`openclaw.json`** — set the value:
```json
"autoRecallTimeoutMs": 15000
```

Quick patch via sed (Linux):
```bash
PLUGIN_DIR=~/.openclaw/extensions/memory-lancedb-pro

sed -i 's/autoRecallMinRepeated?: number;/autoRecallMinRepeated?: number;\n  autoRecallTimeoutMs?: number;/' \
    "$PLUGIN_DIR/index.ts"

sed -i 's/const AUTO_RECALL_TIMEOUT_MS = 3_000;/const AUTO_RECALL_TIMEOUT_MS = config.autoRecallTimeoutMs ?? 3_000;/' \
    "$PLUGIN_DIR/index.ts"
```

---

## Default LLM fallback bug

When `llm.model` is not configured, the plugin defaults to `openai/gpt-oss-120b` and inherits the embedding `baseURL`. Since `https://api.jina.ai/v1` does not host this model, extraction silently produces no output:

```
memory-pro: smart-extractor: no memories extracted
memory-lancedb-pro: smart extraction produced no persisted memories (created=0, merged=0, skipped=0)
```

The absence of an error message makes this hard to diagnose. Always explicitly configure `llm.model` with a known-good OpenAI-compatible endpoint.

---

## Deployment checklist

Run in order after any embedding model or LLM change.

```bash
# 1. Validate config
openclaw config validate

# 2. Verify gateway picks up the new embedding model
openclaw gateway restart
# check logs for: memory-lancedb-pro@1.1.0-beta.9: plugin registered (..., model: jina-embeddings-v5-text-small, ...)

# 3. Confirm row count and embedding dimension
openclaw memory-pro list
# node check above

# 4. Smoke test extraction (send a factual message via chat, then check)
openclaw memory-pro list --scope global

# 5. For OpenClaw 2026.3.13+: test recall quality
openclaw memory-pro recall "your test query"
```

---

## Cross-version compatibility notes

| OpenClaw version | `recall` CLI | `upgrade` CLI | `autoRecallTimeoutMs` (after patch) |
|---|---|---|---|
| 2026.3.8 | ❌ | ❌ | ✓ |
| 2026.3.13 | ✓ | ✓ | ✓ |

On 2026.3.8, use direct LanceDB Node.js queries for recall quality testing (see Step 5 above). Use `reembed` instead of `upgrade` for embedding regeneration, and skip the double-import trap described in the migration procedure.

---

## Summary

The main takeaways from this tuning cycle:

1. **Switch to `jina-embeddings-v5-text-small`**: +3–15% vector similarity improvements, especially on technical keyword phrases. Same 1024-dim output, drop-in config replacement.

2. **`qwen3-vl-8b-instruct` for SmartExtraction**: 35 completion tokens vs 150+ for comparable models, 5× cost reduction, Chinese text fidelity preserved.

3. **Always patch `autoRecallTimeoutMs`**: The 3-second hardcoded timeout is too tight for cloud embedding APIs. 15 seconds is a safe default for Jina AI.

4. **Always configure `llm.model` explicitly**: The default `openai/gpt-oss-120b` silently fails against non-OpenAI base URLs.

5. **Model migration = full re-embed**: Clear the LanceDB directory, re-import, do not reembed over an existing import. Vector spaces are not portable across model versions.
