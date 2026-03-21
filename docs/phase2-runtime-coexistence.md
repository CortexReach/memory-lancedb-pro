# Phase 2 — Runtime Coexistence and Reversible Exit Strategy

## Purpose
Define how `memory-lancedb-pro` should coexist with legacy OpenClaw memory systems during active use and how users can later disable/uninstall it without irreversible memory lock-in.

This document focuses on runtime coexistence, sync direction, and reversibility.

---

## 1. Product goal
When a user enables the plugin at time **A** and disables/uninstalls it at time **B**:
- old Markdown / SQLite memory systems should still remain valid,
- memories created during **A → B** should not be trapped only inside LanceDB,
- the plugin should still be the preferred management/retrieval layer while enabled.

---

## 2. Chosen coexistence model
## Hybrid coexistence with Markdown-compatible reversibility

### Runtime principle
- **LanceDB** is the preferred runtime retrieval / management layer
- **Markdown-compatible output** is the preferred reversibility / compatibility layer
- **SQLite** remains legacy retrieval/index infrastructure, not the preferred write target

This means:
- we should not try to directly mutate legacy SQLite as the main compatibility strategy
- we should prefer durable Markdown-compatible mirror/backfill behavior for important memories

---

## 3. Write-path design options

## Option A — Full dual-write to Markdown-compatible layer
### Behavior
Every durable memory accepted into LanceDB also writes to a compatibility Markdown layer.

### Pros
- strong reversibility
- simple disable/uninstall story
- old system has continuous written trace

### Cons
- risk of duplication/noise
- may over-write transient/low-value memories into user-readable files

---

## Option B — Export/backfill on demand or on disable
### Behavior
Memories are written to LanceDB during runtime; compatibility Markdown is produced later by explicit export/backfill.

### Pros
- cleaner runtime
- less duplication pressure

### Cons
- reversibility depends on a later explicit step
- more risk that users disable the plugin before backfill/export is done

---

## Option C — Hybrid durable-memory sync (**preferred**)
### Behavior
- not every transient memory is mirrored immediately
- memories accepted as durable/high-value are mirrored/backfilled to a Markdown-compatible layer
- lower-value/transient runtime material may remain LanceDB-only unless later promoted

### Why this is preferred
It balances:
- reversibility
- lower noise
- reduced duplication
- protection against total A→B lock-in

---

## 4. Recommended Phase 2 direction
### Decision
Use **Option C: Hybrid durable-memory sync**.

### Recommended policy
1. If a memory is durable enough to materially affect future recall, it should have a compatibility path outside LanceDB.
2. Markdown-compatible artifacts should be the main reversibility target.
3. SQLite should not be the primary sync target.
4. Users should be able to disable/uninstall the plugin without losing the practical ability to continue from legacy-compatible memory artifacts.

---

## 5. Disable / uninstall behavior

## Required properties
1. **No hard dependency after removal**
   - old systems must still be usable on their own
2. **No hidden trapping of durable A→B memories**
   - important memories created while plugin was active should be exportable/backfillable
3. **No silent destructive cleanup**
   - disabling/uninstalling should not erase old systems or require irreversible migration

## Preferred future commands
- `memory-pro export-legacy --since <time>`
- `memory-pro backfill-markdown --since <time>`
- possibly a report command showing what would remain LanceDB-only if the plugin were disabled now

---

## 6. Runtime retrieval preference
Even with coexistence preserved:
- agents should prefer `memory-lancedb-pro` recall/search when the plugin is enabled
- old Markdown / SQLite should serve as compatibility, rollback, and upgrade sources

This allows a clear top layer without destructive replacement.

---

## 7. Guardrails for Phase 2 implementation
1. Do not create the illusion of full reversibility unless a real backfill/export path exists.
2. Do not silently write large volumes of noisy transient memory into legacy-visible Markdown.
3. Do not make direct SQLite writes the default compatibility mechanism.
4. Keep user-visible control points: preview, confirm, export/backfill.

---

## 8. Main-agent implementation order for D2/D3
### Step 1
Define what counts as a “durable accepted memory” eligible for compatibility sync.

### Step 2
Define the Markdown-compatible mirror/backfill target format.

### Step 3
Implement preview/reporting for reversible export/backfill.

### Step 4
Implement the chosen hybrid sync for durable memories.

### Step 5
Implement disable/uninstall helper flow or documented process.

---

## 9. Main-agent note for later worker decomposition
Future worker splits should likely be:
- Worker A: preview/reporting for legacy export/backfill
- Worker B: Markdown-compatible sync/backfill implementation
- Worker C: docs/skill preference updates

The main agent should keep ownership of the acceptance logic for what counts as durable enough to require reversibility support.
