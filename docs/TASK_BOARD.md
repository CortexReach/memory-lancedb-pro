# Central Task Board — memory-lancedb-pro

## Status legend
- TODO
- IN_PROGRESS
- BLOCKED
- DONE

## Project goal
Implement an incremental, architecture-compatible upgrade path for agent-scoped memory management and later historical-memory upgrade support.

## Track A — Project review & architecture control
- [DONE] Establish git-managed development clone under workspace
- [DONE] Create feature branch `feat/agent-scoped-memory-upgrade-flow`
- [DONE] Record project review and minimal-change design notes
- [TODO] Confirm exact phase boundaries before parallel coding

## Track B — Engineering safety rails
- [DONE] Add local verification script `scripts/verify-before-submit.sh`
- [DONE] Add git hook entrypoint under `.githooks/pre-commit`
- [TODO] Enable repo-local `core.hooksPath=.githooks`
- [TODO] Smoke test hook behavior with a real commit in this dev repo

## Track C — Phase 1 feature work
### C1. Per-agent default isolation
- [DONE] Add config switch for automatic agent-scoped defaults
- [DONE] Implement runtime default scope behavior with backward compatibility
- [DONE] Add/extend tests for scope resolution and accessible scopes

### C2. Initialization / upgrade scaffolding
- [DONE] Add first-run marker / initialization summary behavior
- [DONE] Detect presence of candidate historical memory files/workspaces
- [DONE] Extend candidate detection to include per-agent SQLite stores and future agents on later startups
- [DONE] Add tests for first-run behavior and non-blocking logging

## Track D — Phase 2 goals
### D0. Main-agent design freeze
- [DONE] Record Phase 2 coexistence / reversibility goals
- [DONE] Create a main-agent Phase 2 decomposition document
- [DONE] Define the legacy source matrix (Markdown vs SQLite, importability, scope mapping, risks)
- [DONE] Choose the preferred Phase 2 sync strategy (dual-write vs export/backfill vs hybrid)
- [DONE] Define the preview-first CLI plan before spawning implementation workers

### D1. Legacy memory upgrade/import
- [TODO] Define Markdown import command surface
- [TODO] Define SQLite memory upgrade/import boundary
- [TODO] Define mdMirror-log parser boundary
- [TODO] Define freeform Markdown extraction boundary
- [TODO] Define value-filtering / dedupe strategy before writing imported memories into LanceDB

### D2. Non-destructive coexistence during active use
- [TODO] Define how legacy Markdown / SQLite systems remain usable while memory-lancedb-pro is enabled
- [TODO] Define how users can enable the plugin mid-stream without effectively losing old memory continuity
- [TODO] Define how newly created agents after plugin enablement inherit compatible memory management

### D3. Reversible / non-residual exit path
- [TODO] Define how A→B period memories avoid being trapped only inside LanceDB
- [TODO] Evaluate dual-write, mirror, export-backfill, or other reversible sync strategies
- [TODO] Define disable/uninstall behavior so users are not permanently bound to the plugin layer

### D4. Retrieval preference & skill guidance
- [TODO] Update skill/docs so agents prefer memory-lancedb-pro retrieval when enabled
- [TODO] Keep Markdown / SQLite described as compatibility, fallback, and upgrade sources rather than the preferred retrieval layer

## Multi-agent execution rules
1. Main agent owns architecture understanding and task decomposition.
2. Each coding worker must use an isolated git worktree or isolated non-overlapping working directory.
3. Do not assign overlapping mutable paths to concurrent workers.
4. Require stage reports: understanding -> tests -> implementation -> verification.
5. No code is presented upward until tests pass locally.

## Proposed parallel execution plan
### Worker 1
- Scope: `src/scopes.ts` + related tests
- Goal: auto agent-scoped default behavior

### Worker 2
- Scope: `index.ts` first-run scaffolding + related tests
- Goal: initialization summary + upgrade detection scaffolding

### Main agent
- Owns: architecture guardrails, task board, integration review, final merge, verification
