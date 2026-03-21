# Phase 2 Design Freeze — Legacy Source Matrix, Sync Strategy, and Preview-First CLI Plan

## Purpose
This document records the main-agent design freeze for Phase 2.

It answers three questions before new implementation workers are spawned:
1. What legacy sources should be treated as upgrade inputs?
2. What sync / coexistence strategy best satisfies the non-destructive + reversible requirements?
3. What preview-first CLI surface should exist before any destructive import/write path is introduced?

---

## A. Legacy source matrix

| Source class | Examples | Role in current OpenClaw | Source-of-truth status | Import priority | Recommended Phase 2 treatment | Main risks |
|---|---|---|---|---|---|---|
| Long-term Markdown memory | `MEMORY.md` | Human-curated durable memory | **High** | **Highest** | Treat as primary legacy import source | Over-importing prose verbatim; duplicate facts |
| Daily Markdown memory | `memory/YYYY-MM-DD.md` | Daily log / event stream / temporary context | Medium | High | Treat as primary event-oriented import source, but require filtering/distillation | Too much low-value noise, repeated transient content |
| mdMirror-style Markdown | future generated mirrors | Machine-readable compatibility mirror | Medium-High | High | Treat as structured import/export format when available | Duplicate content if mixed with human-authored markdown |
| Per-agent SQLite stores | `~/.openclaw/memory/*.sqlite` | OpenClaw legacy per-agent retrieval/index layer | Medium | Medium | Treat as compatibility and candidate source; do not assume it is the first source of truth when paired Markdown exists | Importing opaque/derived rows can duplicate Markdown-derived memory |
| Current LanceDB memory | `memory-lancedb-pro` DB | Preferred plugin memory layer | New primary runtime layer | N/A | Treat as current management layer, not a legacy source | Lock-in if no reversible sync/backfill exists |

---

## B. Source-of-truth policy

### B1. Markdown-first legacy import policy
For historical/legacy upgrade, prefer **Markdown** as the human-authored source of truth whenever both Markdown and SQLite appear to represent the same legacy memory space.

Why:
- Markdown is user-readable and user-editable
- SQLite in OpenClaw is often closer to a retrieval/index substrate than the canonical authored memory layer
- importing from Markdown first reduces the risk of opaque duplicate rows

### B2. SQLite as a compatibility source, not default canonical source
Per-agent SQLite should still be detected and reported because:
- it signals the presence of legacy agent memory/search state
- it may carry useful recoverable structure in some environments
- it helps map legacy stores to specific agents

But the default assumption should be:
- **SQLite is a compatibility/upgrade source**
- **not the first canonical source** when corresponding Markdown exists

### B3. Scope mapping rule
Imported or mirrored memory should map like this by default:
- workspace-specific historical memory → `agent:<agentId>` when agent can be resolved
- unresolved workspace memory → candidate for user confirmation before import
- intentionally shared durable memory → `global`

---

## C. Preferred Phase 2 sync strategy

## Decision: use a hybrid strategy
### Chosen direction
Adopt a **hybrid coexistence strategy**:
1. `memory-lancedb-pro` becomes the preferred runtime retrieval/management layer
2. durable accepted memories should have a compatibility path back to legacy systems
3. compatibility should be achieved primarily through **Markdown-compatible mirroring/backfill**, not direct SQLite mutation

### Why this is the preferred strategy
It best satisfies all three acceptance criteria:
- halfway-adoption non-destructive
- post-uninstall non-residual
- enter/exit anytime while original OpenClaw memory systems remain usable

### Why not “LanceDB only”
Because it would trap A→B-period memories inside the plugin and violate reversibility.

### Why not “direct SQLite dual-write”
Because SQLite is a poor canonical write target here:
- schema/semantics are more derived and implementation-shaped
- direct mutation is more brittle
- Markdown is the user-facing authored layer and the more stable compatibility substrate

### Recommended runtime behavior
#### During plugin-enabled runtime
- prefer LanceDB for recall/search
- when a new memory is accepted as durable, write it to LanceDB
- for compatibility/reversibility, also maintain a Markdown-compatible mirror/backfill path for durable memories

#### During disable/uninstall
- ensure durable A→B-period memories can be exported/backfilled into legacy-compatible Markdown artifacts if they are not already mirrored
- legacy SQLite can continue serving as the old retrieval/index layer via the legacy system’s own behavior

### Resulting architecture principle
**LanceDB is the preferred management layer; Markdown is the preferred compatibility layer; SQLite remains a legacy retrieval/index layer rather than a primary write target.**

---

## D. Preview-first CLI plan

Before destructive import/sync logic is implemented, Phase 2 should expose read-only / preview-oriented commands first.

## D1. Scan
### Command
`memory-pro upgrade-scan`

### Purpose
- enumerate detected legacy sources
- classify them by type
- map them to agent/global candidates
- explain discovery mode (`config` vs `filesystem-fallback`)

### Output shape
- workspace memory sources
- sqlite stores
- inferred agent mapping
- warnings about unresolved or ambiguous sources

---

## D2. Preview
### Commands
- `memory-pro upgrade-preview --source <path-or-id>`
- `memory-pro import-md <path> --dry-run`
- future: `memory-pro import-sqlite <path> --dry-run`

### Purpose
- show what would be imported
- show scope assignment
- show which entries look high-value vs low-value/noisy
- show dedupe/supersede decisions before any write

---

## D3. Apply
### Commands (later)
- `memory-pro import-md <path> --scope <scope>`
- `memory-pro import-sqlite <path> --scope <scope>`
- future grouped upgrade command after preview is trusted

### Guardrails
- preview-first by default
- user confirmation before broad import
- report generated artifacts and counts

---

## D4. Reversible export/backfill
### Commands (later)
- `memory-pro export-legacy --since <time>`
- `memory-pro backfill-markdown ...`

### Purpose
- prevent A→B-period memories from being trapped inside LanceDB only
- support disable/uninstall workflows

---

## E. Implementation preference order for Phase 2

### Step 1
Implement `upgrade-scan` + reporting only

### Step 2
Implement Markdown preview / dry-run import

### Step 3
Implement SQLite preview / dry-run import semantics

### Step 4
Implement controlled real import with dedupe/filtering

### Step 5
Implement reversible Markdown-compatible sync/backfill for durable memories

### Step 6
Update skill/docs so agents prefer `memory-lancedb-pro` retrieval while treating Markdown/SQLite as compatibility/fallback/upgrade sources

---

## F. Explicit non-goals for early Phase 2
- direct wholesale replacement of Markdown/SQLite memory systems
- silent auto-import of all historical memory on plugin enable
- per-agent plugin instance proliferation
- direct SQLite mutation as the primary compatibility path

---

## G. Summary decisions
1. **Markdown-first** for historical import when Markdown and SQLite overlap
2. **SQLite detected and previewed**, but not assumed to be the canonical write target
3. **Hybrid sync strategy** preferred: LanceDB primary runtime layer + Markdown-compatible reversibility path
4. **Preview-first CLI** before any broad destructive import
5. **Skill/docs should prefer LanceDB retrieval** once enabled, while preserving legacy compatibility layers
