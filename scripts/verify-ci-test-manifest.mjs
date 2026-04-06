import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_TEST_GROUPS, CI_TEST_MANIFEST } from "./ci-test-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

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

function fail(message) {
  throw new Error(message);
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

  for (const file of EXPECTED_BASELINE) {
    const count = counts.get(file) ?? 0;
    if (count === 0) {
      fail(`missing baseline test: ${file}`);
    }
    if (count > 1) {
      fail(`duplicate test entry: ${file}`);
    }
  }

  for (const [file, count] of counts) {
    if (!EXPECTED_BASELINE.includes(file)) {
      fail(`unexpected manifest entry: ${file}`);
    }
    if (count > 1) {
      fail(`duplicate test entry: ${file}`);
    }
  }
}

function verifyExactOrder() {
  const actual = CI_TEST_MANIFEST.map((entry) => entry.file);

  if (actual.length !== EXPECTED_BASELINE.length) {
    fail(`expected ${EXPECTED_BASELINE.length} baseline entries, found ${actual.length}`);
  }

  for (let index = 0; index < EXPECTED_BASELINE.length; index += 1) {
    const expected = EXPECTED_BASELINE[index];
    const got = actual[index];
    if (expected !== got) {
      fail(`baseline order mismatch at position ${index + 1}: expected ${expected}, found ${got}`);
    }
  }
}

function main() {
  verifyGroups();
  verifyFilesExist();
  verifyExactOnceCoverage();
  verifyExactOrder();
  console.log(`CI test manifest covers baseline exactly once (${EXPECTED_BASELINE.length} entries)`);
}

main();
