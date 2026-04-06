# CI Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the current all-in-one `cli-smoke` CI check into a fast smoke job plus explicit parallel required jobs, while preserving the current 32-test baseline and keeping `CI / cli-smoke` compatible with branch protection.

**Architecture:** Move the current hard-coded `npm test` sequence into a single manifest module that owns test grouping, command mode, and execution order. Derive both `npm test` and each `test:*` group script from that manifest through a shared runner, and add a verifier script that fails if the post-split suite no longer matches the pre-split 32-test baseline exactly once.

**Tech Stack:** Node.js, npm scripts, GitHub Actions YAML, ESM `.mjs` scripts.

**Spec:** `docs/plans/2026-04-06-ci-split-design.md`

---

## File Map

| File | Responsibility | Task |
|------|---------------|------|
| `scripts/ci-test-manifest.mjs` | Single source of truth for CI test grouping, execution order, and command metadata | Task 1 |
| `scripts/run-ci-tests.mjs` | Run all tests or one named group from the manifest with inherited stdio and fail-fast behavior | Task 1 |
| `scripts/verify-ci-test-manifest.mjs` | Assert the grouped manifest exactly matches the current 32-test baseline and has no duplicates | Task 2 |
| `package.json` | Replace inline `npm test` chain with grouped `test:*` scripts backed by the manifest runner | Task 2 |
| `.github/workflows/ci.yml` | Replace monolithic `cli-smoke` execution with parallel jobs that call grouped npm scripts | Task 3 |

---

### Task 1: Create the CI Test Manifest and Shared Runner

**Files:**
- Create: `scripts/ci-test-manifest.mjs`
- Create: `scripts/run-ci-tests.mjs`
- Test: `node scripts/run-ci-tests.mjs --group cli-smoke`

- [ ] **Step 1: Create `scripts/ci-test-manifest.mjs` with the five agreed groups**

Add a manifest module that exports the group names and a single ordered array of test entries. Each entry must include:

```javascript
export const CI_TEST_GROUPS = [
  "cli-smoke",
  "core-regression",
  "storage-and-schema",
  "llm-clients-and-auth",
  "packaging-and-workflow",
];

export const CI_TEST_MANIFEST = [
  { group: "llm-clients-and-auth", runner: "node", file: "test/embedder-error-hints.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/cjk-recursion-regression.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/migrate-legacy-schema.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/config-session-strategy-migration.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/scope-access-undefined.test.mjs", args: ["--test"] },
  // ...continue with the remaining baseline tests in the exact current order...
  { group: "packaging-and-workflow", runner: "node", file: "test/workflow-fork-guards.test.mjs", args: ["--test"] },
];

export function getEntriesForGroup(group) {
  if (!CI_TEST_GROUPS.includes(group)) {
    throw new Error(`Unknown CI test group: ${group}`);
  }
  return CI_TEST_MANIFEST.filter((entry) => entry.group === group);
}
```

Notes:
- Preserve the exact current execution order from `package.json`.
- Encode `node --test` cases via `args: ["--test"]` so the runner can reconstruct the original command.
- `cli-smoke` must only include `test/cli-smoke.mjs` and `test/functional-e2e.mjs`.

- [ ] **Step 2: Fill the manifest with the complete 32-test baseline**

Transcribe every current `npm test` entry from `package.json` into `CI_TEST_MANIFEST`, preserving:
- file path
- whether it runs as `node file` or `node --test file`
- relative order

The final manifest must include exactly these grouped memberships:
- `cli-smoke`: `test/cli-smoke.mjs`, `test/functional-e2e.mjs`
- `core-regression`: `test/recall-text-cleanup.test.mjs`, `test/strip-envelope-metadata.test.mjs`, `test/retriever-rerank-regression.mjs`, `test/smart-memory-lifecycle.mjs`, `test/smart-extractor-branches.mjs`, `test/session-summary-before-reset.test.mjs`, `test/smart-metadata-v2.mjs`, `test/context-support-e2e.mjs`, `test/temporal-facts.test.mjs`, `test/memory-update-supersede.test.mjs`, `test/preference-slots.test.mjs`
- `storage-and-schema`: `test/migrate-legacy-schema.test.mjs`, `test/config-session-strategy-migration.test.mjs`, `test/scope-access-undefined.test.mjs`, `test/reflection-bypass-hook.test.mjs`, `test/smart-extractor-scope-filter.test.mjs`, `test/store-empty-scope-filter.test.mjs`, `test/update-consistency-lancedb.test.mjs`, `test/vector-search-cosine.test.mjs`, `test/clawteam-scope.test.mjs`, `test/cross-process-lock.test.mjs`
- `llm-clients-and-auth`: `test/embedder-error-hints.test.mjs`, `test/cjk-recursion-regression.test.mjs`, `test/memory-upgrader-diagnostics.test.mjs`, `test/llm-api-key-client.test.mjs`, `test/llm-oauth-client.test.mjs`, `test/cli-oauth-login.test.mjs`
- `packaging-and-workflow`: `test/plugin-manifest-regression.mjs`, `test/sync-plugin-version.test.mjs`, `test/workflow-fork-guards.test.mjs`

- [ ] **Step 3: Create `scripts/run-ci-tests.mjs`**

Implement a simple CLI runner that accepts `--all` or `--group <name>`, loads the manifest, and executes each entry sequentially with inherited stdio:

```javascript
import { spawn } from "node:child_process";
import { CI_TEST_MANIFEST, getEntriesForGroup } from "./ci-test-manifest.mjs";

function parseArgs(argv) {
  if (argv.includes("--all")) return { mode: "all" };
  const idx = argv.indexOf("--group");
  if (idx !== -1 && argv[idx + 1]) return { mode: "group", group: argv[idx + 1] };
  throw new Error("Usage: node scripts/run-ci-tests.mjs --all | --group <name>");
}

function buildCommand(entry) {
  return [entry.runner, ...(entry.args ?? []), entry.file];
}

async function runEntry(entry) {
  const [cmd, ...args] = buildCommand(entry);
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${entry.file} exited ${code}`)));
    child.on("error", reject);
  });
}
```

The runner should:
- fail fast on the first non-zero exit
- print a short line before each test, for example `==> node --test test/foo.test.mjs`
- preserve the manifest order for `--all`

- [ ] **Step 4: Run the shared runner against the smoke subset**

Run: `node scripts/run-ci-tests.mjs --group cli-smoke`

Expected:
- `test/cli-smoke.mjs` passes
- `test/functional-e2e.mjs` passes
- no other tests run

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-test-manifest.mjs scripts/run-ci-tests.mjs
git commit -m "build: add shared CI test manifest and runner"
```

---

### Task 2: Replace Inline npm Test Chains with Grouped Scripts and Baseline Verification

**Files:**
- Create: `scripts/verify-ci-test-manifest.mjs`
- Modify: `package.json`
- Test: `node scripts/verify-ci-test-manifest.mjs`

- [ ] **Step 1: Create `scripts/verify-ci-test-manifest.mjs`**

Implement a verifier that imports the manifest and asserts:
- each manifest entry has a valid group
- each `file` appears exactly once
- each `file` exists on disk
- the flattened file list equals the current 32-test baseline, in exact order

Use an explicit expected baseline array so the migration target is locked:

```javascript
const EXPECTED_BASELINE = [
  "test/embedder-error-hints.test.mjs",
  "test/cjk-recursion-regression.test.mjs",
  "test/migrate-legacy-schema.test.mjs",
  "test/config-session-strategy-migration.test.mjs",
  "test/scope-access-undefined.test.mjs",
  "test/reflection-bypass-hook.test.mjs",
  "test/smart-extractor-scope-filter.test.mjs",
  "test/store-empty-scope-filter.test.mjs",
  "test/recall-text-cleanup.test.mjs",
  "test/update-consistency-lancedb.test.mjs",
  "test/strip-envelope-metadata.test.mjs",
  "test/cli-smoke.mjs",
  "test/functional-e2e.mjs",
  "test/retriever-rerank-regression.mjs",
  "test/smart-memory-lifecycle.mjs",
  "test/smart-extractor-branches.mjs",
  "test/plugin-manifest-regression.mjs",
  "test/session-summary-before-reset.test.mjs",
  "test/sync-plugin-version.test.mjs",
  "test/smart-metadata-v2.mjs",
  "test/vector-search-cosine.test.mjs",
  "test/context-support-e2e.mjs",
  "test/temporal-facts.test.mjs",
  "test/memory-update-supersede.test.mjs",
  "test/memory-upgrader-diagnostics.test.mjs",
  "test/llm-api-key-client.test.mjs",
  "test/llm-oauth-client.test.mjs",
  "test/cli-oauth-login.test.mjs",
  "test/workflow-fork-guards.test.mjs",
  "test/clawteam-scope.test.mjs",
  "test/cross-process-lock.test.mjs",
  "test/preference-slots.test.mjs",
];
```

The script should exit non-zero with actionable errors such as:
- `duplicate test entry: test/foo.mjs`
- `missing baseline test: test/bar.mjs`
- `unexpected manifest entry: test/baz.mjs`

- [ ] **Step 2: Replace the inline `npm test` chain in `package.json`**

Change `package.json` scripts to use the shared runner and verifier:

```json
{
  "scripts": {
    "test": "node scripts/verify-ci-test-manifest.mjs && node scripts/run-ci-tests.mjs --all",
    "test:cli-smoke": "node scripts/run-ci-tests.mjs --group cli-smoke",
    "test:core-regression": "node scripts/run-ci-tests.mjs --group core-regression",
    "test:storage-and-schema": "node scripts/run-ci-tests.mjs --group storage-and-schema",
    "test:llm-clients-and-auth": "node scripts/run-ci-tests.mjs --group llm-clients-and-auth",
    "test:packaging-and-workflow": "node scripts/verify-ci-test-manifest.mjs && node scripts/run-ci-tests.mjs --group packaging-and-workflow"
  }
}
```

Keep existing unrelated scripts such as `bench`, `test:openclaw-host`, and `version`.

- [ ] **Step 3: Verify the manifest guard before changing CI**

Run: `node scripts/verify-ci-test-manifest.mjs`

Expected:
- exits 0
- prints a short success line like `CI test manifest covers baseline exactly once (32 entries)`

- [ ] **Step 4: Verify each new npm group locally**

Run:
- `npm run test:cli-smoke`
- `npm run test:core-regression`
- `npm run test:storage-and-schema`
- `npm run test:llm-clients-and-auth`
- `npm run test:packaging-and-workflow`

Expected:
- each script passes independently
- `cli-smoke` only runs the two agreed smoke files
- `packaging-and-workflow` re-runs the manifest verifier before its own group

- [ ] **Step 5: Verify the full local baseline still passes**

Run: `npm test`

Expected:
- passes end-to-end
- still covers exactly the current 32-test baseline
- runner output makes it obvious which grouped file is currently executing

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-ci-test-manifest.mjs package.json
git commit -m "build: replace inline npm test chain with grouped CI scripts"
```

---

### Task 3: Split the GitHub Actions Workflow into Parallel Required Jobs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `npm run test:cli-smoke`
- Test: `npm run test:core-regression`
- Test: `npm run test:storage-and-schema`
- Test: `npm run test:llm-clients-and-auth`
- Test: `npm run test:packaging-and-workflow`

- [ ] **Step 1: Keep `version-sync` unchanged**

Do not fold `version-sync` into the new packaging job. It should remain the cheapest possible structural check.

- [ ] **Step 2: Rewrite `cli-smoke` to call the smoke-only npm script**

In `.github/workflows/ci.yml`, change the `cli-smoke` job step:

```yaml
- name: Test
  run: npm run test:cli-smoke
```

Keep the job name as `cli-smoke` so the check remains `CI / cli-smoke`.

- [ ] **Step 3: Add the four new parallel jobs**

Add four new jobs with the same checkout/setup/install structure as `cli-smoke`:

```yaml
core-regression:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: npm
    - run: npm ci
    - run: npm run test:core-regression
```

Repeat the same pattern for:
- `storage-and-schema` → `npm run test:storage-and-schema`
- `llm-clients-and-auth` → `npm run test:llm-clients-and-auth`
- `packaging-and-workflow` → `npm run test:packaging-and-workflow`

Keep the first version explicit. Do not switch to a matrix yet.

- [ ] **Step 4: Re-run the local grouped commands after the workflow edit**

Run:
- `npm run test:cli-smoke`
- `npm run test:core-regression`
- `npm run test:storage-and-schema`
- `npm run test:llm-clients-and-auth`
- `npm run test:packaging-and-workflow`

Expected:
- all pass locally after the workflow change
- no group depends on hidden local state from another group

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: split monolithic cli-smoke suite into parallel jobs"
```

---

### Task 4: Final Verification and Rollout Handoff

**Files:**
- Modify: none
- Manual follow-up: GitHub branch protection settings

- [ ] **Step 1: Run the full verification sequence in the worktree**

Run:
- `node scripts/verify-ci-test-manifest.mjs`
- `npm run test:cli-smoke`
- `npm run test:core-regression`
- `npm run test:storage-and-schema`
- `npm run test:llm-clients-and-auth`
- `npm run test:packaging-and-workflow`
- `npm test`

Expected:
- every command passes
- grouped scripts and full baseline remain in sync

- [ ] **Step 2: Capture the expected new PR check names**

The final workflow should expose:
- `CI / version-sync`
- `CI / cli-smoke`
- `CI / core-regression`
- `CI / storage-and-schema`
- `CI / llm-clients-and-auth`
- `CI / packaging-and-workflow`

- [ ] **Step 3: Merge workflow changes before editing branch protection**

Do not mark the new jobs as required until the updated workflow has run on the default branch and the new check names are visible in GitHub.

- [ ] **Step 4: Update branch protection after the default branch publishes the checks**

Add the four new jobs as required checks while keeping `CI / cli-smoke`.

- [ ] **Step 5: Commit or hand off**

If all implementation commits are already made:

```bash
git status
```

Expected:
- clean working tree
- ready for PR creation or further review
