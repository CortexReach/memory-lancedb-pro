# Phase Status Snapshot — 2026-03-22

## Purpose
Point-in-time readiness review after reconnecting the `memory-lancedb-pro` parallel worktrees.

---

## Summary

### Ready / close to ready
- **Phase 1 — first-run init scaffolding**
  - branch: `feat/first-run-init-scaffold`
  - code present: `src/init-check.ts`
  - tests present: `test/first-run-init.test.mjs`
  - targeted test result: **PASS**
  - assessment: functionally strong; needs normal review / merge hygiene only

- **Phase 1 — agent-scoped defaults**
  - branch: `feat/agent-scoped-defaults`
  - code present: `src/scopes.ts`
  - tests present: `test/agent-scoped-defaults.test.mjs`
  - targeted test result: **PASS**
  - assessment: functionally strong; likely the cleanest Phase 1 integration candidate

- **Phase 2 Wave 1 — upgrade scan**
  - branch: `feat/p2-upgrade-scan`
  - code present: `src/upgrade-planner.ts`, `cli.ts`
  - tests present: `test/upgrade-planner.test.mjs`, `test/upgrade-scan-cli.test.mjs`
  - targeted test result: **PASS**
  - assessment: implementation is real and test-backed; clean up stray `node_modules` and review CLI surface before merge

- **Phase 2 Wave 1 — Markdown preview parser**
  - branch: `feat/p2-md-preview`
  - code present: `src/md-import.ts`
  - tests present: `test/md-import.test.mjs`
  - targeted test result: **PASS**
  - assessment: parser layer appears solid; biggest issue is worktree hygiene / untracked-file state rather than failing logic

### Not ready yet
- **Phase 2 Wave 1 — SQLite preview reader**
  - branch: `feat/p2-sqlite-preview`
  - code present: `src/sqlite-import.ts`
  - tests present: `test/sqlite-import.test.mjs`
  - targeted test result: **FAIL**
  - current failures:
    - missing `basename` field on preview entries
    - `formatSqlitePreviewReport` not exported/implemented as expected by tests
    - cascading formatter/report output assertions therefore fail
  - assessment: not integration-ready; this branch still needs direct implementation work

---

## Hygiene notes
- `feat/p2-upgrade-scan` currently has a stray `node_modules/` in the worktree.
- multiple worktrees still have untracked source/test files that should be staged or intentionally ignored before integration review.
- some `package.json` / `package-lock.json` drift exists across worktrees and should be attributed before merge.

---

## Recommended integration order
1. `feat/agent-scoped-defaults`
2. `feat/first-run-init-scaffold`
3. `feat/p2-upgrade-scan`
4. `feat/p2-md-preview`
5. `feat/p2-sqlite-preview` (only after failing tests are fixed)

---

## Architecture note
The compatibility Markdown target is now frozen separately in:
- `docs/phase2-compatibility-subtree.md`

That freeze should guide later runtime coexistence work so Phase 2 does not drift back toward mixing plugin output into top-level human-authored daily logs.
