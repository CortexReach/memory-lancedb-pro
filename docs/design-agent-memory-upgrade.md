# Design Notes — Minimal-Change Memory Upgrade Path

## Design principles
1. Extend current architecture; do not replace it.
2. Backward compatibility first.
3. Explicit user confirmation for historical memory upgrade.
4. Per-agent isolation should be opt-in via config, then become the recommended mode.
5. Markdown remains a human-readable layer; LanceDB remains the recall/runtime layer.

## Phase 1 scope
### 1. Automatic agent-scoped defaults
Add a lightweight config switch, e.g. `autoAgentScope` (default `false`).

When enabled:
- writes default to `agent:<agentId>` when an agentId exists
- readable scopes default to `global + agent:<agentId>`
- keep explicit `scopes.agentAccess` overrides authoritative
- keep `global` accessible unless explicitly narrowed in future work

### 2. First-run initialization / upgrade prompt scaffolding
Add a non-blocking first-run marker and summary logging.

Expected behavior:
- plugin detects first initialization of a db/config combination
- plugin logs a clear summary of active memory mode
- plugin checks whether candidate historical memory files/workspaces exist
- plugin records that an upgrade is available, but does not auto-import
- this scaffolds a later user-confirmed migration flow

## Phase 2 scope
### A. Legacy memory upgrade path
Add additive import logic, likely as a new module (e.g. `src/md-import.ts` plus later SQLite import helpers) and CLI command(s):
- `memory-pro import-md <path> --dry-run`
- `memory-pro import-md <path> --scope <scope>`
- future preview/report command for agent workspaces
- future SQLite-aware upgrade/import entry points for per-agent `~/.openclaw/memory/*.sqlite`

Legacy input classes:
1. machine-friendly mdMirror logs
2. human-authored `MEMORY.md` / `memory/YYYY-MM-DD.md`
3. existing per-agent SQLite-backed OpenClaw memory stores

### B. Non-destructive runtime coexistence
During the period when `memory-lancedb-pro` is enabled, the old Markdown / SQLite memory systems should remain usable and compatible.

Target direction:
- avoid a hard cut-over where enabling the plugin makes old memory effectively disappear
- make the plugin the **preferred management layer** without making the legacy layers invalid
- keep the old systems viable as compatibility, rollback, and migration sources

### C. Reversible sync / dual-write design goal
The preferred Phase 2 direction is to keep the original memory systems and the LanceDB plugin from drifting apart during active use.

Desired property:
- when a user enables the plugin at time **A** and disables/uninstalls it at time **B**, important memories created during **A → B** should not exist only inside LanceDB with no path back to the original OpenClaw memory systems

This suggests one of these compatible strategies:
- continuous dual-write / mirroring of newly accepted memories
- reversible export/backfill from LanceDB to legacy memory layers on disable/uninstall
- another compatibility-preserving sync strategy that avoids permanent lock-in

### D. Retrieval preference at the skill / agent layer
Even if runtime compatibility is preserved, agent guidance should prefer `memory-lancedb-pro` for recall/search once enabled.

Target behavior:
- update the skill/docs so agents are told to prefer `memory-lancedb-pro` retrieval
- treat Markdown / SQLite as compatibility / fallback / upgrade sources rather than the first-choice retrieval path

## Per-agent memory model
### Recommended read/write defaults
- write scope: `agent:<agentId>`
- recall scopes: `global + agent:<agentId>`
- shared durable knowledge can still be intentionally stored in `global`

### Why this fits current plugin design
- aligns with existing scope manager
- preserves current retrieval code paths
- avoids schema redesign
- keeps tools API stable

## User-facing upgrade model (future)
1. install/enable plugin
2. detect old Markdown memory files per workspace
3. agent tells user an upgrade path is available
4. user confirms preview/import
5. imported entries become available to auto-recall

## Testing expectations
- scope selection tests for autoAgentScope on/off
- access tests ensuring `global + agent:<id>` default behavior
- initialization marker / first-run tests
- later: import parser tests for mdMirror and freeform markdown
