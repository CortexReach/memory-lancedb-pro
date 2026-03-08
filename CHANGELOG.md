# Changelog

## 1.1.0-beta.6

- Refactor: build reset/new reflection handoff note in `runMemoryReflection`.
- Refactor: `<open-loops>` now comes from the fresh reflection run, while `<derived-focus>` comes from historical scored itemized derived rows.
- Refactor: upgrade historical `<derived-focus>` ranking to Derived-Focus V2 (conservative strict/soft normalization, non-linear group scoring, diversity-aware shortlist up to 36 before final note injection capped at 13, with no hard `score > 0.3` gate).
- Refactor: introduce a shared final set-wise top-k selector for generic Auto-Recall and dynamic Reflection-Recall, with deterministic output order and preserved reflection `kind + strictKey` partitioning.
- Refactor: add a shared set-wise final selector implementation that can provide lexical-overlap suppression, embedding-based semantic near-duplicate suppression, deterministic ordering, and lexical-only fallback when vectors are missing/invalid.
- Compatibility: generic Auto-Recall now exposes `autoRecallSelectionMode` (`legacy` default, `setwise-v2` opt-in); the enhanced lexical/semantic final-selection behavior is enabled only in `setwise-v2`. Reflection-Recall `fixed | dynamic` semantics remain unchanged.
- Breaking: stop writing and stop reading legacy combined reflection rows (`type=memory-reflection`).
- Docs: refresh README / README_CN for the new handoff-note behavior and remove old legacy combined guidance.

---

## 1.1.0

- Feat: add integrated self-improvement governance flow (`agent:bootstrap`, `command:new/reset`, governance tools, and `.learnings` file bootstrap).
- Feat: add `memoryReflection` session strategy with inheritance/derived injection, reflection persistence, and dedicated reflection-agent support.
- Fix: keep session-strategy compatibility by mapping legacy `sessionMemory.enabled` to `systemSessionMemory` / `none` and trimming reflection input toward recent conversation tail.
- Fix: retry early transient upstream reflection failures once and broaden session recovery search paths to real OpenClaw agent session directories.
- Docs: update README / README_CN for session strategy, self-improvement, memoryReflection, mdMirror, and reflection fallback behavior.
- Tests: add targeted coverage for reflection retry classification and session recovery path resolution.

PRs: #43, #2

---

## 1.0.32

- Fix: strip OpenClaw `Conversation info` / `Sender` metadata noise before auto-capture matching and adaptive retrieval normalization, reducing false captures and noisy retrieval triggers.
- Fix: parse `autoRecallMinRepeated` from plugin config so repeated-memory suppression works when configured.

PR: #50

---


## 1.0.31

- Fix: `memory-pro import` now preserves provided IDs and is idempotent (skips if ID already exists).

## 1.0.26

**Access Reinforcement for Time Decay**

- **Feat**: Access reinforcement — frequently *manually recalled* memories decay more slowly (spaced-repetition style)
- **New**: `AccessTracker` with debounced metadata write-back (records accessCount / lastAccessedAt)
- **New**: Config options under `retrieval`: `reinforcementFactor` (default: 0.5) and `maxHalfLifeMultiplier` (default: 3)
- **New**: `MemoryStore.getById()` pure-read helper for efficient metadata lookup

PR: #37

Breaking changes: None. Backward compatible (set `reinforcementFactor: 0` to disable).

---


## 1.0.22

**Storage Path Validation & Better Error Messages**

- **Fix**: Validate `dbPath` at startup — resolve symlinks, auto-create missing directories, check write permissions (#26, #27)
- **Fix**: Write/connection failures now include `errno`, resolved path, and actionable fix suggestions instead of generic errors (#28)
- **New**: Exported `validateStoragePath()` utility for external tooling and diagnostics

Breaking changes: None. Backward compatible.

---

## 1.0.21

**Long Context Chunking**

- **Feats**: Added automatic chunking for documents exceeding embedding context limits
- **Feats**: Smart semantic-aware chunking at sentence boundaries with configurable overlap
- **Feats**: Chunking adapts to different embedding model context limits (Jina, OpenAI, Gemini, etc.)
- **Feats**: Parallel chunk embedding with averaged result for better semantic preservation
- **Fixes**: Handles "Input length exceeds context length" errors gracefully
- **Docs**: Added comprehensive documentation in docs/long-context-chunking.md

Breaking changes: None. Backward compatible with existing configurations.

---

## 1.0.20

- Fix: reduce auto-capture noise by skipping memory-management prompts (delete/forget/cleanup memory entries).
- Improve: broaden English decision triggers so statements like "we decided / going forward we will use" are captured as decisions.

## 1.0.19

- UX: show memory IDs in `memory-pro list` and `memory-pro search` output, so users can delete entries without switching to JSON.
- UX: include IDs in agent tool outputs (`memory_recall`, `memory_list`) for easier debugging and `memory_forget` follow-ups.

## 1.0.18

- Fix: sync `openclaw.plugin.json` version with `package.json`, so the OpenClaw plugin info shows the correct version.

## 1.0.17

- Fix: adaptive-retrieval now strips OpenClaw-injected timestamp prefixes like `[Mon YYYY-MM-DD HH:MM ...] ...` to avoid skewing length-based heuristics.
- Improve: expanded SKIP/FORCE keyword patterns with Traditional Chinese variants.

## 1.0.16

- Feat: expand memory capture triggers to support Traditional Chinese (繁體中文) in addition to Simplified Chinese, and improve category detection keywords.

## 1.0.15

- Docs: add troubleshooting note for LanceDB/Arrow returning `BigInt` numeric columns, and confirm the plugin coerces numeric fields via `Number(...)` for compatibility.

## 1.0.14

- Fix: coerce LanceDB/Arrow numeric columns that may arrive as `BigInt` (`timestamp`, `importance`, `_distance`, `_score`) into `Number(...)` to avoid runtime errors like "Cannot mix BigInt and other types" on LanceDB 0.26+.

## 1.0.13

- Fix: Force `encoding_format: "float"` for OpenAI-compatible embedding requests to avoid base64/float ambiguity and dimension mismatch issues with some providers/gateways.
- Feat: Add Voyage AI (`voyage`) as a supported rerank provider, using `top_k` and `Authorization: Bearer` header.
- Refactor: Harden rerank response parser to accept both `results[]`/`data[]` payload shapes and `relevance_score`/`score` field names across all providers.

## 1.0.12

- Fix: ghost memories stuck in autoRecall after deletion (#15). BM25-only results from stale FTS index are now validated via `store.hasId()` before inclusion in fused results. Removed the BM25-only floor score of 0.5 that allowed deleted entries to survive `hardMinScore` filtering.
- Fix: HEARTBEAT pattern now matches anywhere in the prompt (not just at start), preventing autoRecall from triggering on prefixed HEARTBEAT messages.
- Add: `autoRecallMinLength` config option to set a custom minimum prompt length for autoRecall (default: 15 chars English, 6 CJK). Prompts shorter than this threshold are skipped.
- Add: `ping`, `pong`, `test`, `debug` added to skip patterns in adaptive retrieval.

## 1.0.11

- Change: set `autoRecall` default to `false` to avoid the model echoing injected `<relevant-memories>` blocks.

## 1.0.10

- Fix: avoid blocking OpenClaw gateway startup on external network calls by running startup self-checks in the background with timeouts.

## 1.0.9

- Change: update default `retrieval.rerankModel` to `jina-reranker-v3` (still fully configurable).

## 1.0.8

- Add: JSONL distill extractor supports optional agent allowlist via env var `OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS` (default off / compatible).

## 1.0.7

- Fix: resolve `agentId` from hook context (`ctx?.agentId`) for `before_agent_start` and `agent_end`, restoring per-agent scope isolation when using multi-agent setups.

## 1.0.6

- Fix: auto-recall injection now correctly skips cron prompts wrapped as `[cron:...] run ...` (reduces token usage for cron jobs).
- Fix: JSONL distill extractor filters more transcript/system noise (BOOT.md, HEARTBEAT, CLAUDE_CODE_DONE, queued blocks) to avoid polluting distillation batches.

## 1.0.5

- Add: optional JSONL session distillation workflow (incremental cursor + batch format) via `scripts/jsonl_distill.py`.
- Docs: document the JSONL distiller setup in README (EN) and README_CN (ZH).

## 1.0.4

- Fix: `embedding.dimensions` is now parsed robustly (number / numeric string / env-var string), so it properly overrides hardcoded model dims (fixes Ollama `nomic-embed-text` dimension mismatch).

## 1.0.3

- Fix: `memory-pro reembed` no longer crashes (missing `clampInt` helper).

## 1.0.2

- Fix: pass through `embedding.dimensions` to the OpenAI-compatible `/embeddings` request payload when explicitly configured.
- Chore: unify plugin version fields (`openclaw.plugin.json` now matches `package.json`).

## 1.0.1

- Fix: CLI command namespace updated to `memory-pro`.

## 1.0.0

- Initial npm release.
