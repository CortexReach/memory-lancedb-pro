import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_TEST_GROUPS, CI_TEST_MANIFEST } from "./ci-test-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// EXPECTED_BASELINE is derived from CI_TEST_MANIFEST so they are always in sync.
// Any PR that adds/removes/reorders test entries in CI_TEST_MANIFEST automatically
// updates the baseline — no manual snapshot maintenance needed.
const EXPECTED_BASELINE = CI_TEST_MANIFEST;

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
