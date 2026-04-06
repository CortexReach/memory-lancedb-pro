# CI Split Design

Date: 2026-04-06

## Context

The current CI workflow has only two jobs: `version-sync` and `cli-smoke`. In practice, `cli-smoke` runs `npm test`, which executes 32 scripts spanning CLI flows, core smart-memory regressions, LanceDB and schema checks, OAuth and LLM client coverage, and packaging and workflow guards. This makes the check name misleading and weakens signal quality in pull requests. A failure in a deep core regression currently appears as `CI / cli-smoke`, even when the CLI itself is healthy.

The immediate goal is not to reduce coverage. The goal is to make pull request feedback faster and more truthful while preserving required deep regression coverage.

## Goals

- Keep `CI / cli-smoke` for branch-protection compatibility.
- Make `cli-smoke` a true fast signal for the main user-facing CLI path.
- Split the remaining tests into explicit parallel required jobs.
- Keep `npm test` as the local full-suite baseline.
- Avoid changing test semantics during the split.

## Recommended Workflow Topology

Keep a single `CI` workflow and retain `version-sync` as a standalone job. Keep the job name `cli-smoke`, but reduce its scope so it becomes the first fast PR verdict.

Add four more parallel required jobs:

- `core-regression`
- `storage-and-schema`
- `llm-clients-and-auth`
- `packaging-and-workflow`

This keeps GitHub Checks readable, avoids branch-protection breakage, and gives clear failure ownership. For example, a `strip-envelope-metadata` regression should fail `core-regression`, not `cli-smoke`.

## Script Grouping

### cli-smoke

Purpose: fast confidence that the CLI and its main end-to-end path still work.

- `test/cli-smoke.mjs`
- `test/functional-e2e.mjs`
- Optional: `test/plugin-manifest-regression.mjs`

`test/cli-oauth-login.test.mjs` is intentionally excluded from this group because it is better treated as auth integration coverage than as first-pass smoke.

### core-regression

Purpose: protect the main smart-memory and retrieval behavior.

- `test/recall-text-cleanup.test.mjs`
- `test/strip-envelope-metadata.test.mjs`
- `test/retriever-rerank-regression.mjs`
- `test/smart-memory-lifecycle.mjs`
- `test/smart-extractor-branches.mjs`
- `test/session-summary-before-reset.test.mjs`
- `test/smart-metadata-v2.mjs`
- `test/context-support-e2e.mjs`
- `test/temporal-facts.test.mjs`
- `test/memory-update-supersede.test.mjs`
- `test/preference-slots.test.mjs`

### storage-and-schema

Purpose: protect persistence, migrations, scope semantics, and write safety.

- `test/migrate-legacy-schema.test.mjs`
- `test/config-session-strategy-migration.test.mjs`
- `test/scope-access-undefined.test.mjs`
- `test/reflection-bypass-hook.test.mjs`
- `test/smart-extractor-scope-filter.test.mjs`
- `test/store-empty-scope-filter.test.mjs`
- `test/update-consistency-lancedb.test.mjs`
- `test/vector-search-cosine.test.mjs`
- `test/clawteam-scope.test.mjs`
- `test/cross-process-lock.test.mjs`

### llm-clients-and-auth

Purpose: protect embedding, provider, and auth-client behavior.

- `test/embedder-error-hints.test.mjs`
- `test/cjk-recursion-regression.test.mjs`
- `test/memory-upgrader-diagnostics.test.mjs`
- `test/llm-api-key-client.test.mjs`
- `test/llm-oauth-client.test.mjs`
- `test/cli-oauth-login.test.mjs`

### packaging-and-workflow

Purpose: protect packaging integrity and repository automation guards.

- `test/plugin-manifest-regression.mjs`
- `test/sync-plugin-version.test.mjs`
- `test/workflow-fork-guards.test.mjs`

## Implementation Shape

Make the split in two layers.

First, add grouped scripts in `package.json`:

- `test:cli-smoke`
- `test:core-regression`
- `test:storage-and-schema`
- `test:llm-clients-and-auth`
- `test:packaging-and-workflow`

Then rewrite `npm test` to call those grouped scripts sequentially. This preserves a single local full-suite command while making CI reuse the same stable entry points.

Second, update `.github/workflows/ci.yml` so each CI job runs:

1. `actions/checkout`
2. `actions/setup-node`
3. `npm ci`
4. its matching `npm run test:*`

Do not use a matrix for the first version of this split. Explicit jobs are clearer in the Checks UI and easier to maintain.

## Migration and Verification

The split must not change test semantics. Every grouped job should only reorganize the current test list.

Migration order:

1. Add grouped `test:*` scripts.
2. Keep `npm test` as the sequential full-suite baseline.
3. Update the CI workflow to run grouped scripts in parallel jobs.
4. Add the new jobs to branch protection while keeping `CI / cli-smoke`.

Verification requirements:

- Each `npm run test:*` command passes independently.
- `npm test` still passes as the local full-suite baseline.
- PR checks show `cli-smoke`, `core-regression`, `storage-and-schema`, `llm-clients-and-auth`, and `packaging-and-workflow`.
- A failure in one subsystem is reported under the correct job name.

## Follow-up Recommendations

After the split lands, consider a second pass to reduce debugging cost in oversized scripts, especially:

- `test/smart-extractor-branches.mjs`
- `test/recall-text-cleanup.test.mjs`
- `test/cli-oauth-login.test.mjs`

Those tests appear valuable, but their current size makes failures slower to localize.
