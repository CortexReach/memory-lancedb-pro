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

export function getEntriesForGroup(group) {
  if (!CI_TEST_GROUPS.includes(group)) {
    throw new Error(`Unknown CI test group: ${group}`);
  }

  return CI_TEST_MANIFEST.filter((entry) => entry.group === group);
}
