# Safe OpenClaw LanceDB Pro -> Hermes lancedb_pro migration

This guide covers an optional, experimental migration path from OpenClaw
`memory-lancedb-pro` data into the isolated Hermes-native `lancedb_pro` provider.
It copies rows into a separate Hermes schema without writing to the OpenClaw live
database, without changing the OpenClaw runtime, and without editing Hermes main
config.

The Hermes provider is intentionally narrower than OpenClaw's advanced retrieval
stack. Migration preserves useful memory content and metadata for Hermes
store/search flows, but it is not full feature parity with OpenClaw retrieval,
reranking, governance, or lifecycle behavior.

## Safety rules

- Treat the OpenClaw DB as read-only. The importer only reads the source table:
  it validates that the source path exists and is a directory before calling
  `lancedb.connect()`, verifies the source table is present, and opens the
  source table before creating or connecting to the target directory.
- Do not use the OpenClaw DB path as the Hermes target path.
- Do not overwrite an existing Hermes DB. Use a timestamped target path.
- Do not print API keys. Prefer `HERMES_MEMORY_JINA_API_KEY` or `JINA_API_KEY`;
  otherwise the helper can read OpenClaw config in-process and masks logs.
- Do not enable the migrated DB in Hermes until validation passes.

## Source / target paths

Default OpenClaw source:

```text
$OPENCLAW_HOME/memory/lancedb-pro, or ~/.openclaw/memory/lancedb-pro when OPENCLAW_HOME is unset
```

Recommended Hermes target pattern:

```text
$HERMES_HOME/memory/lancedb-pro-migrated-YYYYMMDD-HHMMSS, or ~/.hermes/memory/lancedb-pro-migrated-YYYYMMDD-HHMMSS when HERMES_HOME is unset
```

The importer writes Hermes provider rows to table `hermes_memories` by default.
Use `--target-table memories` if you want the migrated Hermes table to keep the
OpenClaw table name while still containing Hermes-schema rows. Compatible fields
match `integrations/hermes/lancedb_pro/provider.py`: `id`, `content`, `vector`,
`category`, `scope`, `source`, `created_at`, `updated_at`, `importance`,
`embedding_model`, `dimensions`, `metadata_json`, and `session_id`. The importer
preserves OpenClaw source values in `metadata_json` as `original_id`,
`original_timestamp`, `original_category`, `original_scope`,
`original_importance`, and `original_metadata`. OpenClaw millisecond timestamps
are converted to Hermes Unix seconds for `created_at`/`updated_at`.

## Install migration-only dependencies

Use an isolated venv; do not install into Hermes runtime unless you intend to:

```bash
cd /path/to/memory-lancedb-pro
python3 -m venv .migration-venv
.migration-venv/bin/pip install lancedb pyarrow requests
```

For local test coverage of this integration, install pytest in the same isolated
environment and run the focused Python tests from the repository root:

```bash
.migration-venv/bin/pip install pytest
.migration-venv/bin/python -m pytest test/hermes_lancedb_pro_provider_test.py \
  test/hermes_lancedb_pro_openclaw_migration_test.py
```

## Phase 0: read-only discovery

If the source path might be missing, check it before ad-hoc LanceDB discovery;
`lancedb.connect()` can create a missing directory in some LanceDB versions. The
importer performs this preflight automatically before any source connect or
target mkdir/connect.

```bash
.migration-venv/bin/python - <<'PY'
import lancedb
import os
from pathlib import Path
src=str(Path(os.getenv('OPENCLAW_HOME', '~/.openclaw')).expanduser() / 'memory' / 'lancedb-pro')
db=lancedb.connect(src)
print(db.table_names())
t=db.open_table('memories')
print(t.count_rows())
print(t.schema)
PY
```

Do not dump full memory content in logs.

## Phase 1: real-Jina sample import

```bash
TS=$(date +%Y%m%d-%H%M%S)
TARGET=/tmp/hermes-lancedb-pro-jina-sample-test-$TS
MANIFEST=$HOME/.hermes/agent-runs/openclaw_lancedb_sample_$TS.json
.migration-venv/bin/python integrations/hermes/lancedb_pro/scripts/import_openclaw_lancedb.py \
  --target "$TARGET" \
  --target-table hermes_memories \
  --limit 50 \
  --batch-size 10 \
  --progress-every 50 \
  --manifest "$MANIFEST"
```

The helper refuses to proceed without a Jina key. It uses Jina
`jina-embeddings-v5-text-small`, 1024 dimensions, `retrieval.passage` task for
stored memory vectors.

## Validate through Hermes provider

Run provider search with a temporary env only:

```bash
export HERMES_MEMORY_LANCEDB_PATH=/tmp/hermes-lancedb-pro-jina-sample-test-...
# If imported with --target-table memories, set:
# export HERMES_MEMORY_LANCEDB_TABLE=memories
export HERMES_MEMORY_JINA_API_KEY=...  # do not echo this
export HERMES_MEMORY_HASH_FALLBACK=false
export HERMES_MEMORY_EMBED_BASE_URL=https://api.jina.ai/v1/embeddings
export HERMES_MEMORY_EMBED_MODEL=jina-embeddings-v5-text-small
python - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path('integrations/hermes').resolve()))
from lancedb_pro.provider import LancedbProMemoryProvider
p=LancedbProMemoryProvider()
p.initialize('migration-validation', hermes_home='/tmp/hermes-validation-home')
print(p.handle_tool_call('lancedb_pro_status', {}))
print(p.handle_tool_call('lancedb_pro_search', {'query': 'memory governance', 'limit': 3}))
PY
```

Provider search uses Jina `retrieval.query` task.

## Phase 2: full import

```bash
TS=$(date +%Y%m%d-%H%M%S)
TARGET=${HERMES_HOME:-$HOME/.hermes}/memory/lancedb-pro-migrated-$TS
MANIFEST=$HOME/.hermes/agent-runs/openclaw_lancedb_full_$TS.json
.migration-venv/bin/python integrations/hermes/lancedb_pro/scripts/import_openclaw_lancedb.py \
  --target "$TARGET" \
  --target-table hermes_memories \
  --batch-size 32 \
  --progress-every 512 \
  --manifest "$MANIFEST"
```

## Enabling in Hermes after validation

Do not edit the main Hermes config during migration. After validation, use the
same plugin and set env/config explicitly:

```bash
export HERMES_MEMORY_LANCEDB_PATH=$HOME/.hermes/memory/lancedb-pro-migrated-YYYYMMDD-HHMMSS
# Set only if you imported with --target-table memories:
# export HERMES_MEMORY_LANCEDB_TABLE=memories
export HERMES_MEMORY_JINA_API_KEY=...  # secret; do not log
export HERMES_MEMORY_HASH_FALLBACK=false
```

Hermes config snippet:

```yaml
memory:
  provider: lancedb_pro
```

The existing plugin symlink can point to:

```text
$HERMES_HOME/plugins/lancedb_pro -> /path/to/memory-lancedb-pro/integrations/hermes/lancedb_pro
```
