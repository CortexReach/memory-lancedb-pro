# Hermes provider: `lancedb_pro`

This directory contains an optional, experimental Hermes-native memory provider
for the upstream `memory-lancedb-pro` repository. It is intentionally isolated:
it does **not** modify Hermes core, does **not** change the OpenClaw TypeScript
runtime, and does **not** interact with any OpenClaw live database.

This is not full feature parity with the OpenClaw advanced retrieval stack. The
Hermes provider currently focuses on a small, explicit surface: status, manual
store/search/delete, minimal prefetch recall, optional turn capture, and safe
one-way import from OpenClaw LanceDB rows into a separate Hermes schema.

## Install locally in Hermes

```bash
mkdir -p "$HERMES_HOME/plugins"
ln -s /absolute/path/to/memory-lancedb-pro/integrations/hermes/lancedb_pro "$HERMES_HOME/plugins/lancedb_pro"
```

Then set the active provider in Hermes config:

```yaml
memory:
  provider: lancedb_pro
```

## Optional dependencies

For real LanceDB storage:

```bash
python -m pip install lancedb pyarrow
```

For tests and migration helper development, use an isolated Python environment
and install only the Python dependencies you need, for example:

```bash
python -m venv .hermes-lancedb-venv
. .hermes-lancedb-venv/bin/activate
python -m pip install pytest lancedb pyarrow requests
```

The focused Python tests can run without Node/npm installation:

```bash
python -m pytest test/hermes_lancedb_pro_provider_test.py \
  test/hermes_lancedb_pro_openclaw_migration_test.py
```

If Python `lancedb` is not installed, the provider remains importable and falls
back to a small JSONL store for local smoke tests. The status tool reports the
active backend and any LanceDB import/open error class.

## Embeddings

Preferred production path is Jina/OpenAI-compatible embeddings:

```bash
export HERMES_MEMORY_JINA_API_KEY=...
# optional overrides
export HERMES_MEMORY_EMBED_BASE_URL=https://api.jina.ai/v1/embeddings
export HERMES_MEMORY_EMBED_MODEL=jina-embeddings-v5-text-small
# defaults for Jina v5; override only if your provider requires different names
export HERMES_MEMORY_EMBED_QUERY_TASK=retrieval.query
export HERMES_MEMORY_EMBED_PASSAGE_TASK=retrieval.passage
```

If no `HERMES_MEMORY_JINA_API_KEY` is present, the provider uses deterministic
hash embeddings with 1024 dimensions by default. This is only a dev/test fallback
so manual `store`/`search` can be validated without secrets or network calls; it
is not a production semantic embedding model.

## Storage

Default path:

```text
$HERMES_HOME/memory/lancedb-pro
```

Override with:

```bash
export HERMES_MEMORY_LANCEDB_PATH=/path/to/lancedb-dir
```

Default table is `hermes_memories`. You may override the table name, including to
`memories` for continuity with an OpenClaw deployment, but the provider always
writes Hermes-schema rows. When LanceDB is unavailable or
`HERMES_MEMORY_LANCEDB_FORCE_JSON=true`, the JSON fallback stores rows in a
per-table file named `<safe-table-name>.jsonl`; `memories` remains
`memories.jsonl`, while `custom_table` uses `custom_table.jsonl`.

```bash
export HERMES_MEMORY_LANCEDB_TABLE=memories
```

Stored fields include:

- `id`
- `content`
- `category`
- `scope`
- `source`
- `created_at`
- `updated_at`
- `importance`
- `embedding_model`
- `dimensions`
- `metadata_json`
- `session_id`
- `vector`

## Exposed Hermes tools

- `lancedb_pro_status()`
- `lancedb_pro_store(content, category?, scope?, source?, importance?, metadata?)`
- `lancedb_pro_search(query, limit?)`
- `lancedb_pro_forget(id)` — deletes one exact id only.

## Lifecycle behavior

- `prefetch(query, session_id='')` performs minimal auto-recall by default.
- `sync_turn()` is off by default to avoid surprise writes; enable with
  `HERMES_MEMORY_LANCEDB_SYNC_TURN=true` or `HERMES_MEMORY_LANCEDB_AUTO_CAPTURE=true`.
- `on_memory_write()` mirrors Hermes built-in memory writes into this provider.

## Safe OpenClaw migration

Migration support is optional and one-way. It copies OpenClaw rows into a new
Hermes LanceDB path/table; it does not retrofit Hermes with OpenClaw's full
retrieval/reranking/governance behavior and it must not be pointed at the live
OpenClaw table as a writable target.

OpenClaw legacy LanceDB rows use fields like `id`, `text`, `vector`,
`category`, `scope`, `importance`, `timestamp`, and `metadata`. Do not point the
Hermes provider at that legacy table directly. Instead, run the importer to copy
rows into a separate Hermes LanceDB path and convert them to the Hermes provider
schema (`content`, `metadata_json`, `created_at`, `updated_at`, etc.). The
importer preflights source safety before writes: it rejects missing/non-directory
source paths before `lancedb.connect()`, refuses target paths equal to or inside
the source, and verifies the source table before creating/connecting the target.
The original OpenClaw id/timestamp/scope/category/importance/metadata are preserved
inside `metadata_json` as `original_*` keys.

The target table can be overridden. This lets you use table name `memories` while
keeping Hermes-schema row contents:

```bash
python integrations/hermes/lancedb_pro/scripts/import_openclaw_lancedb.py \
  --source "$OPENCLAW_HOME/memory/lancedb-pro" \
  --source-table memories \
  --target "$HERMES_HOME/memory/lancedb-pro-migrated-$(date +%Y%m%d-%H%M%S)" \
  --target-table memories \
  --manifest "$HERMES_HOME/agent-runs/openclaw_lancedb_migration.json"
```

A migration helper and detailed runbook are available for copying OpenClaw
`memory-lancedb-pro` rows into a separate Hermes `lancedb_pro` DB using real Jina
embeddings, without writing to the OpenClaw live DB and without editing Hermes
main config:

- `integrations/hermes/lancedb_pro/scripts/import_openclaw_lancedb.py`
- `integrations/hermes/lancedb_pro/OPENCLAW_MIGRATION.md`

The helper requires a real Jina key and refuses hash-fallback migration.

## Smoke test without touching live Hermes/OpenClaw state

```bash
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/plugins"
ln -s "$PWD/integrations/hermes/lancedb_pro" "$TMP_HOME/plugins/lancedb_pro"
PYTHONPATH=/path/to/hermes-agent HERMES_HOME="$TMP_HOME" \
  HERMES_MEMORY_LANCEDB_PATH="$TMP_HOME/memory/lancedb-pro" \
  HERMES_MEMORY_LANCEDB_FORCE_JSON=true \
  HERMES_MEMORY_EMBED_PROVIDER=hash python - <<'PY'
from plugins.memory import load_memory_provider
p = load_memory_provider('lancedb_pro')
assert p is not None
p.initialize('smoke', hermes_home=__import__('os').environ['HERMES_HOME'], platform='cli')
print(p.handle_tool_call('lancedb_pro_status', {}))
print(p.handle_tool_call('lancedb_pro_store', {'content': 'Hermes likes LanceDB memory'}))
print(p.handle_tool_call('lancedb_pro_search', {'query': 'LanceDB memory', 'limit': 1}))
PY
```
