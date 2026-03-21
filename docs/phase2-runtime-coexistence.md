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
## Hybrid coexistence with Markdown + SQLite continuity

### Runtime principle
- **LanceDB** is the preferred runtime retrieval / management layer
- **Markdown-compatible output** remains part of the compatibility/reversibility layer
- **SQLite continuity must also be preserved** so the legacy OpenClaw memory path remains live during plugin-enabled use

This means:
- we cannot treat legacy SQLite as a dead read-only residue
- we still prefer Markdown as the human-readable compatibility substrate
- but we must also ensure durable memories continue to reach the SQLite-backed legacy system while the plugin is enabled

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
Memories are written to LanceDB during runtime; compatibility layers are produced later by explicit export/backfill.

### Pros
- cleaner runtime
- less duplication pressure

### Cons
- reversibility depends on a later explicit step
- more risk that users disable the plugin before backfill/export is done
- unacceptable if SQLite continuity is expected during active plugin use

---

## Option C — Hybrid durable-memory sync (**preferred, revised**)
### Behavior
- not every transient memory is mirrored immediately
- memories accepted as durable/high-value are written to LanceDB
- the same durable/high-value memories are also propagated to legacy-compatible layers during runtime
- that propagation must include both:
  - Markdown-compatible continuity
  - SQLite-backed continuity
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
2. Markdown-compatible artifacts should remain part of the reversibility target.
3. The preferred Markdown target should be a **separate subtree inside each agent workspace memory directory** (for example `memory/plugin-memory-pro/`), not the human-authored top-level `memory/YYYY-MM-DD.md` files.
4. That subtree should include a small `README.md` or `STATEMENT.md` explaining that the files exist because the plugin was enabled and are intended as compatibility / reversibility artifacts.
5. SQLite continuity must also be maintained during active plugin use so the old OpenClaw memory path does not silently go stale.
6. Users should be able to disable/uninstall the plugin without losing the practical ability to continue from legacy-compatible memory artifacts and legacy SQLite-backed retrieval.

---

## 5. Disable / uninstall behavior

## Required properties
1. **No hard dependency after removal**
   - old systems must still be usable on their own
2. **No hidden trapping of durable A→B memories**
   - important memories created while plugin was active should already exist in legacy-compatible systems or be backfilled before exit
3. **No silent destructive cleanup**
   - disabling/uninstalling should not erase old systems or require irreversible migration
4. **SQLite continuity remains real**
   - the old SQLite-backed path should not have gone stale during plugin-enabled use

## Preferred future commands
- `memory-pro export-legacy --since <time>`
- `memory-pro backfill-markdown --since <time>`
- future SQLite continuity / rebuild / sync helper commands as needed
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

Current frozen direction:
- create a dedicated compatibility subtree per agent workspace under `memory/plugin-memory-pro/`
- keep plugin-generated files out of the human-authored top-level `memory/YYYY-MM-DD.md` daily logs
- require a `README.md` / `STATEMENT.md` in that subtree so later users can understand why the files exist
- freeze the target layout as a hybrid:
  - `daily/` for append-only audit logs
  - `entries/agent-self/` for canonical local durable-memory projections
  - `entries/global/` for canonical global durable-memory projections
- allow early implementation to ship `README.md` + `daily/` first, but treat `entries/` as the intended end state

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
