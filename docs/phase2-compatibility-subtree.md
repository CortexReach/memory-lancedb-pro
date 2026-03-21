# Phase 2 Compatibility Subtree Freeze

## Purpose
Freeze the preferred Markdown compatibility target for `memory-lancedb-pro` so Phase 2 runtime coexistence work does not keep drifting between ad-hoc mirror directories and human-authored daily logs.

This document turns the earlier direction into a concrete target shape.

---

## Frozen target

For each agent workspace, the compatibility Markdown output should live under:

```text
memory/plugin-memory-pro/
```

That subtree is **plugin-managed compatibility state**, not the human-authored primary daily log.

### Frozen directory layout

```text
<agent-workspace>/
  MEMORY.md
  memory/
    YYYY-MM-DD.md                  # human-authored daily log
    plugin-memory-pro/
      README.md                    # required explanatory file
      daily/
        YYYY-MM-DD.md              # append-only compatibility audit log
      entries/
        agent-self/
          <memory-id>.md           # canonical durable local-scope projection
        global/
          <memory-id>.md           # canonical durable global-scope projection
```

---

## Why this layout

### 1. Keep human daily logs clean
Do **not** write plugin-generated material directly into:

```text
memory/YYYY-MM-DD.md
```

Those files remain the human-authored / agent-authored daily memory surface.

### 2. Stay inside the native memory tree
Keeping the subtree under `memory/` preserves compatibility with OpenClaw's legacy Markdown + SQLite indexing expectations.

### 3. Separate audit from canonical state
- `daily/` = chronological append-only audit trail for human inspection
- `entries/` = canonical per-memory projection suitable for precise update/delete semantics and reversible exit

### 4. Make plugin side effects explainable
`README.md` is required so a later user can tell why these files exist and what role they play after enable/disable cycles.

---

## Semantics by path

## `README.md`
Required. Must explain:
- this subtree exists because `memory-lancedb-pro` was enabled
- files here are compatibility / reversibility artifacts
- top-level `memory/YYYY-MM-DD.md` remains the human-authored daily log
- deleting this subtree may reduce legacy continuity after plugin disable/uninstall

## `daily/YYYY-MM-DD.md`
Append-only compatibility audit log.

Use this for:
- human-readable chronological trace of plugin-managed durable memory activity
- easy review during active plugin use
- operator confidence that A→B memories are not trapped only in LanceDB

Do **not** treat this as the only canonical reversible target, because append-only daily logs are weak for update/delete fidelity.

## `entries/agent-self/<memory-id>.md`
Canonical projection for durable memories whose effective compatibility target is the current workspace's agent-local scope.

Use this for:
- precise create/update/delete behavior
- clean reversibility after plugin disable
- avoiding stale historical shadows when a memory is superseded or forgotten

## `entries/global/<memory-id>.md`
Canonical projection for durable memories that the compatibility policy decides should remain visible as global/shared durable state.

Exact mirroring policy can stay implementation-defined, but the directory name is frozen now.

---

## Minimal implementation vs full target

## Minimum acceptable first implementation
A first Phase 2 runtime compatibility PR may ship with:

```text
memory/plugin-memory-pro/
  README.md
  daily/YYYY-MM-DD.md
```

if `entries/` is not ready yet.

That is acceptable only as an incremental step.

## Full preferred target
The intended end state is:

```text
memory/plugin-memory-pro/
  README.md
  daily/YYYY-MM-DD.md
  entries/agent-self/<memory-id>.md
  entries/global/<memory-id>.md
```

because reversible exit eventually needs canonical per-memory files, not only daily append logs.

---

## Required README template

```md
# plugin-memory-pro compatibility subtree

This directory was created because `memory-lancedb-pro` was enabled for this agent workspace.

## What this directory is
- A compatibility / reversibility projection of plugin-managed durable memory.
- A bridge that helps OpenClaw's original Markdown / SQLite memory systems remain usable.
- Not the primary human-authored daily log.

## What the subdirectories mean
- `daily/` contains append-only audit logs of plugin-managed durable memory activity.
- `entries/agent-self/` contains canonical per-memory Markdown projections for this workspace's local durable memories.
- `entries/global/` contains canonical per-memory Markdown projections for compatible global durable memories when present.

## Important note
The top-level file `memory/YYYY-MM-DD.md` remains the normal human-authored / agent-authored daily memory log.
Files under `memory/plugin-memory-pro/` exist so that enabling and later disabling the plugin is non-destructive and reversible.
```

---

## Guardrails

1. Do not silently mix plugin output into top-level daily logs.
2. Do not rely on `daily/` alone for long-term reversible semantics.
3. Do not require users to understand LanceDB internals to recover from plugin removal.
4. Keep the subtree per-agent workspace local so compatibility remains explainable.
5. Preserve legacy SQLite continuity alongside this subtree; the subtree does not replace the SQLite requirement.

---

## Phase 2 implementation note

This document freezes the **target directory contract**.
It does **not** force Phase 2 Wave 1 preview work to implement runtime sync immediately.
But any Wave 3 Markdown compatibility write-path should now target this subtree rather than ad-hoc mirror roots or top-level daily memory files.
