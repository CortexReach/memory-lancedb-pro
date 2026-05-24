# OpenClaw Dream Retrofit Final Report

Date: 2026-05-23
Repository: `memory-lancedb-pro`
Artifact path: `docs/openclaw-dream-retrofit-report.md`

No explicit output artifact path was present in the environment or repository metadata, so this report is written as a versioned repo artifact under `docs/`.

## Phase Status

| Phase | Status | Notes |
|---|---|---|
| Phase 0: memory capability bootstrap | Complete | Registered `api.registerMemoryCapability` with `runtime`, `promptBuilder`, `flushPlanResolver`, and `publicArtifacts`; retained legacy runtime fallback. |
| Phase 1: runtime contract parity | Complete | Added `MemorySearchManager`-compatible runtime returning grounded `path/startLine/endLine/snippet/source/citation` results and scoped retrieval. |
| Phase 2: canonical corpus + indexer foundation | Complete | Added canonical file/session/dream corpus discovery and LanceDB upsert indexing while keeping files as source of truth. |
| Phase 3: dreaming compatibility glue | Complete | Exposed dream reports and `memory/.dreams/events.jsonl` public artifacts; expanded dreaming schema to match memory-core execution/source config. |
| Phase 4/5: hardening and docs | Complete for this pass | Added focused tests, CI manifest coverage, README/playbook updates, and ran the core regression group. |

## Implemented Outcomes

1. `memory-lancedb-pro` now registers `api.registerMemoryCapability` with:
   - `runtime`
   - `promptBuilder`
   - `flushPlanResolver`
   - `publicArtifacts`
2. Plugin config schema now supports:
   - `canonicalCorpus`
   - `dreaming.enabled/frequency/model/timezone/storage/execution/phases`
   - memory-core-compatible execution knobs: `speed`, `thinking`, `budget`, `maxOutputTokens`, `temperature`, `timeoutMs`
   - phase source enums for light/deep/rem dreaming.
3. Runtime search now returns grounded results with:
   - `path`
   - `startLine`
   - `endLine`
   - `snippet`
   - `source`
   - `citation`
4. Canonical corpus indexing now covers:
   - `MEMORY.md`
   - `memory/**/*.md`
   - `memory/dreaming/**/*.md`
   - recent `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
5. LanceDB is used as the semantic index; canonical files remain source of truth.
6. Dream/public artifact compatibility includes:
   - dream reports as `dream-report`
   - `memory/.dreams/events.jsonl` as `event-log`
   - public artifacts for `MEMORY.md` and `memory/**/*.md`
7. Tests were added/updated for:
   - capability registration
   - runtime grounded results and source filtering
   - canonical corpus discovery/indexing/read fallback
   - dreaming schema compatibility
   - public artifact discovery
8. Docs were updated:
   - `README.md`
   - `docs/openclaw-integration-playbook.md`

## Changed Files

- `README.md`
- `docs/openclaw-integration-playbook.md`
- `index.ts`
- `openclaw.plugin.json`
- `package.json`
- `scripts/ci-test-manifest.mjs`
- `src/corpus-indexer.ts`
- `src/openclaw-memory-capability.ts`
- `src/store.ts`
- `test/corpus-indexer.test.mjs`
- `test/memory-capability-runtime.test.mjs`
- `test/plugin-manifest-regression.mjs`
- `docs/openclaw-dream-retrofit-report.md`

## Commits Created

- `25f3522 feat: bootstrap OpenClaw memory capability`
- `8259e9a feat: add OpenClaw memory runtime adapter`
- `9f010a4 feat: index canonical OpenClaw memory corpus`
- `304ac34 feat: expose dreaming compatibility artifacts`
- `7cefffd docs: document OpenClaw memory capability mode`
- `cdbf643 fix: harden canonical corpus indexing`
- `9e76b0c build: sync dist for OpenClaw runtime smoke`

## Backup Paths

Phase 0:

- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/index.ts.bak.20260523-105050`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw.plugin.json.bak.20260523-105050`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/plugin-manifest-regression.mjs.bak.20260523-105050`

Phase 1:

- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw-memory-capability.ts.bak.20260523-105543`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/index.ts.bak.20260523-105543`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/package.json.bak.20260523-105749`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/ci-test-manifest.mjs.bak.20260523-105749`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/plugin-manifest-regression.mjs.bak.20260523-105849`

Phase 2:

- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/store.ts.bak.20260523-110018`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw-memory-capability.ts.bak.20260523-110018`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/index.ts.bak.20260523-110018`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/package.json.bak.20260523-110018`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/ci-test-manifest.mjs.bak.20260523-110018`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw.plugin.json.bak.20260523-110119`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/plugin-manifest-regression.mjs.bak.20260523-110119`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/memory-capability-runtime.test.mjs.bak.20260523-110717`

Phase 3:

- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw-memory-capability.ts.bak.20260523-111545`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/memory-capability-runtime.test.mjs.bak.20260523-111545`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw.plugin.json.bak.20260523-111706`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/plugin-manifest-regression.mjs.bak.20260523-111706`

Phase 4/5:

- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/README.md.bak.20260523-111933`
- `/Users/choucheyu/.openclaw/workspace/memory/backups/2026-05-23/openclaw-integration-playbook.md.bak.20260523-111933`

## Checks Run

Baseline:

- `npm install` - completed.
- `npx tsc --noEmit` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.

Phase 0:

- `npx tsc --noEmit` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.

Phase 1:

- `npx tsc --noEmit` - passed.
- `node test/memory-capability-runtime.test.mjs` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.
- `node scripts/verify-ci-test-manifest.mjs` - passed.

Phase 2:

- `npx tsc --noEmit` - passed.
- `node test/corpus-indexer.test.mjs` - passed.
- `node test/memory-capability-runtime.test.mjs` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.
- `node scripts/verify-ci-test-manifest.mjs` - passed.
- `git diff --check` - passed.

Phase 3:

- `node -e "JSON.parse(require('node:fs').readFileSync('openclaw.plugin.json','utf8')); console.log('OK manifest JSON')"` - passed.
- `npx tsc --noEmit` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.
- `node test/memory-capability-runtime.test.mjs` - passed.
- `git diff --check` - passed.

Phase 4/5:

- `npx tsc --noEmit` - passed.
- `node test/corpus-indexer.test.mjs` - passed.
- `node test/memory-capability-runtime.test.mjs` - passed.
- `node test/plugin-manifest-regression.mjs` - passed.
- `node scripts/verify-ci-test-manifest.mjs` - passed.
- `npm run test:core-regression` - passed.
- `git diff --check` - passed.

Live OpenClaw smoke:

- Isolated no-channel config validation - passed.
- Production gateway health check after smoke - passed.
- Production Telegram accounts health check after smoke - passed.
- Embedded OpenClaw agent memory tool registration - passed.
- `memory_store` + `memory_recall` smoke - passed.
- CRUD smoke (`memory_store`, `memory_recall`, `memory_update`, `memory_forget`) - passed.
- Public artifacts provider live listing against isolated workspace - passed.
- `/dreaming` plugin command registration in isolated runtime inventory - passed.
- `/dreaming status` handler smoke - passed.
- Real Telegram inbound `/dreaming status` dispatch - passed.
- `node --test test/recall-text-cleanup.test.mjs test/auto-recall-query-length.test.mjs test/auto-recall-timeout.test.mjs test/per-agent-auto-recall.test.mjs test/auto-capture-cleanup.test.mjs test/governance-metadata.test.mjs test/plugin-manifest-regression.mjs` - passed.

## Live Integration Smoke Matrix

| Surface | Status | Evidence |
|---|---|---|
| Isolated OpenClaw config | Pass | `openclaw.nochannels.dreaming.test.json` and `openclaw.nochannels.autohooks.test.json` validated with `valid: true`. |
| Production safety | Pass | Only production gateway on `18789` remained after smoke; no `19889`, `smoke-dreaming`, or `openclaw agent` leftovers. |
| Production health | Pass | Gateway health returned `ok: true`; Telegram accounts were `running: true`, `connected: true`, `lastError: null`. |
| Tool registration | Pass | Embedded agent prompt report exposed `memory_recall`, `memory_store`, `memory_forget`, `memory_update`. |
| Store/recall | Pass | Agent smoke returned `stored: true`, `recalled: true`. |
| Update/forget | Pass | CRUD smoke returned `stored/recalledOriginal/updated/recalledUpdated/forgotten/absentAfterForget: true`. |
| Public artifacts | Pass | Isolated workspace listed `MEMORY.md` as `memory-root` and `memory/2026-05-23.md` as `daily-note`. |
| `/dreaming` registration | Pass | Isolated runtime registered `/dreaming` from `memory-core` and created the managed dreaming cron sidecar. |
| `/dreaming status` handler | Pass | Handler returned enabled status, `0 3 * * *` cadence, and promotion policy. |
| Auto-recall logic | Pass | Targeted regression tests passed, including cleanup, governance, timeout, query length, per-agent policy, and before-prompt hook behavior. |
| Auto-capture cleanup/schema | Pass | Targeted auto-capture cleanup and plugin-manifest tests passed. |
| Real inbound slash dispatch | Pass | Telegram inbound `/dreaming status` produced bot reply message `36015`: enabled on, cadence `0 3 * * *`, promotion policy `score>=0.8, recalls>=3, uniqueQueries>=3`; Gateway log also recorded `telegram sendMessage ok ... message=36015`. |
| Embedded CLI prompt injection | Not proven | `openclaw agent --local` exposes memory tools, but did not demonstrate `before_prompt_build` auto-recall injection in the live smoke path. |

## Reviewer Notes

- The runtime adapter keeps existing `memory_recall`/tool behavior intact and adds OpenClaw memory-host runtime compatibility.
- Canonical corpus entries are stored with `openclaw_corpus` metadata and deterministic `corpus:<hash>` ids, so repeated syncs update the semantic index entry for the same canonical artifact.
- `MemoryStore.upsert()` was added as a serialized delete/add path because LanceDB is used as an index over canonical artifacts, not the canonical source.
- Session transcript parsing is deliberately conservative and best-effort: JSONL role/content blocks are rendered into searchable text and exposed as `source: "sessions"`.
- Public artifact behavior now matches memory-core's important surfaces: `MEMORY.md`, markdown memory files, dream reports, and the dreaming event log.

## Remaining Risks And Edge Cases

- A full real inbound `/dreaming status` dispatch was later executed through Telegram and passed. OpenClaw 2026.5.18 still exposes only command inventory through `commands.list` over CLI/RPC, not a direct CLI/RPC command execution method; therefore the verified path is real provider inbound dispatch, not a synthetic Gateway RPC call.
- `openclaw agent --local --message "/dreaming status"` is not a valid slash-command smoke because plugin slash commands are Gateway command-dispatch features, not ordinary agent prompt text.
- Embedded `openclaw agent --local` successfully exposes and runs memory tools, but did not prove live `before_prompt_build` auto-recall prompt injection. Auto-recall behavior remains covered by targeted regression tests.
- Canonical corpus sync is opportunistic through runtime search/sync, not a filesystem watcher.
- Session transcript classification does not yet reuse OpenClaw's internal dreaming/cron transcript classifier; users can disable transcript indexing with `canonicalCorpus.includeSessionTranscripts: false` if needed.
- Full `npm test` was not run because the relevant broader gate is `npm run test:core-regression`; focused gates and core regressions passed.
