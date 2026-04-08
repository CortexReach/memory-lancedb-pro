import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_TEST_GROUPS, CI_TEST_MANIFEST } from "./ci-test-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const EXPECTED_BASELINE = [
  { group: "llm-clients-and-auth", runner: "node", file: "test/embedder-error-hints.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/cjk-recursion-regression.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/migrate-legacy-schema.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/config-session-strategy-migration.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/scope-access-undefined.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/reflection-bypass-hook.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/smart-extractor-scope-filter.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/store-empty-scope-filter.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/recall-text-cleanup.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/update-consistency-lancedb.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/strip-envelope-metadata.test.mjs", args: ["--test"] },
  { group: "cli-smoke", runner: "node", file: "test/cli-smoke.mjs" },
  { group: "cli-smoke", runner: "node", file: "test/functional-e2e.mjs" },
  { group: "core-regression", runner: "node", file: "test/retriever-rerank-regression.mjs" },
  { group: "core-regression", runner: "node", file: "test/smart-memory-lifecycle.mjs" },
  { group: "core-regression", runner: "node", file: "test/smart-extractor-branches.mjs" },
  { group: "packaging-and-workflow", runner: "node", file: "test/plugin-manifest-regression.mjs" },
  { group: "core-regression", runner: "node", file: "test/session-summary-before-reset.test.mjs", args: ["--test"] },
  { group: "packaging-and-workflow", runner: "node", file: "test/sync-plugin-version.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/smart-metadata-v2.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/vector-search-cosine.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/context-support-e2e.mjs" },
  { group: "core-regression", runner: "node", file: "test/temporal-facts.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/memory-update-supersede.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/memory-upgrader-diagnostics.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/llm-api-key-client.test.mjs", args: ["--test"] },
  { group: "llm-clients-and-auth", runner: "node", file: "test/llm-oauth-client.test.mjs", args: ["--test"] },
  { group: "llm-clients-and-auth", runner: "node", file: "test/cli-oauth-login.test.mjs", args: ["--test"] },
  { group: "packaging-and-workflow", runner: "node", file: "test/workflow-fork-guards.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/clawteam-scope.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/cross-process-lock.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/preference-slots.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/is-latest-auto-supersede.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/temporal-awareness.test.mjs", args: ["--test"] },
];

function fail(message) {
  throw new Error(message);
}

function normalizeArgs(args = []) {
  return args;
}

function formatCommand(entry) {
  return [entry.runner, ...normalizeArgs(entry.args), entry.file].join(" ");
}

function verifyGroups() {
  for (const entry of CI_TEST_MANIFEST) {
    if (!CI_TEST_GROUPS.includes(entry.group)) {
      fail(`invalid CI test group: ${entry.group} for ${entry.file}`);
    }
  }
}

function verifyFilesExist() {
  for (const entry of CI_TEST_MANIFEST) {
    const absolutePath = path.resolve(repoRoot, entry.file);
    if (!fs.existsSync(absolutePath)) {
      fail(`missing test file on disk: ${entry.file}`);
    }
  }
}

function verifyExactOnceCoverage() {
  const counts = new Map();
  for (const entry of CI_TEST_MANIFEST) {
    counts.set(entry.file, (counts.get(entry.file) ?? 0) + 1);
  }

  for (const expectedEntry of EXPECTED_BASELINE) {
    const file = expectedEntry.file;
    const count = counts.get(file) ?? 0;
    if (count === 0) {
      fail(`missing baseline test: ${file}`);
    }
    if (count > 1) {
      fail(`duplicate test entry: ${file}`);
    }
  }

  for (const [file, count] of counts) {
    if (!EXPECTED_BASELINE.some((entry) => entry.file === file)) {
      fail(`unexpected manifest entry: ${file}`);
    }
    if (count > 1) {
      fail(`duplicate test entry: ${file}`);
    }
  }
}

function verifyExactBaseline() {
  if (CI_TEST_MANIFEST.length !== EXPECTED_BASELINE.length) {
    fail(`expected ${EXPECTED_BASELINE.length} baseline entries, found ${CI_TEST_MANIFEST.length}`);
  }

  for (let index = 0; index < EXPECTED_BASELINE.length; index += 1) {
    const expected = EXPECTED_BASELINE[index];
    const actual = CI_TEST_MANIFEST[index];

    if (expected.file !== actual.file) {
      fail(`baseline order mismatch at position ${index + 1}: expected ${expected.file}, found ${actual.file}`);
    }

    if (expected.group !== actual.group) {
      fail(`group mismatch for ${actual.file}: expected ${expected.group}, found ${actual.group}`);
    }

    if (expected.runner !== actual.runner) {
      fail(`runner mismatch for ${actual.file}: expected ${expected.runner}, found ${actual.runner}`);
    }

    const expectedArgs = normalizeArgs(expected.args);
    const actualArgs = normalizeArgs(actual.args);
    if (expectedArgs.length !== actualArgs.length || expectedArgs.some((arg, argIndex) => arg !== actualArgs[argIndex])) {
      fail(`command mismatch for ${actual.file}: expected "${formatCommand(expected)}", found "${formatCommand(actual)}"`);
    }
  }
}

function main() {
  verifyGroups();
  verifyFilesExist();
  verifyExactOnceCoverage();
  verifyExactBaseline();
  console.log(`CI test manifest covers baseline exactly once (${EXPECTED_BASELINE.length} entries)`);
}

main();
