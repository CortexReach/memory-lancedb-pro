export const CI_TEST_GROUPS = [
  "cli-smoke",
  "core-regression",
  "storage-and-schema",
  "llm-clients-and-auth",
  "packaging-and-workflow",
];

export const CI_TEST_MANIFEST = [
  { group: "llm-clients-and-auth", runner: "node", file: "test/embedder-error-hints.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/embedder-max-input-chars.test.mjs", args: ["--test"] },
  { group: "llm-clients-and-auth", runner: "node", file: "test/cjk-recursion-regression.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/migrate-legacy-schema.test.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/config-session-strategy-migration.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/scope-access-undefined.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/reflection-bypass-hook.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/smart-extractor-scope-filter.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/store-empty-scope-filter.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/store-timestamp-normalization.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/storage-path-normalization.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/storage-maintenance.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/read-consistency-interval.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/fts-index-fold.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/store-list-stats-projection-fallback.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/recall-text-cleanup.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/category-filter-normalization.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/update-consistency-lancedb.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/strip-envelope-metadata.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/auto-recall-timeout.test.mjs", args: ["--test"] },
  { group: "cli-smoke", runner: "node", file: "test/import-markdown/import-markdown.test.mjs", args: ["--test"] },
  { group: "cli-smoke", runner: "node", file: "test/cli-smoke.mjs" },
  { group: "cli-smoke", runner: "node", file: "test/functional-e2e.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/per-agent-auto-recall.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/retriever-rerank-regression.mjs" },
  { group: "core-regression", runner: "node", file: "test/retriever-neighbor-enrichment.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/smart-memory-lifecycle.mjs" },
  { group: "core-regression", runner: "node", file: "test/smart-extractor-branches.mjs" },
  { group: "core-regression", runner: "node", file: "test/smart-extractor-batch-embed.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/smart-extractor-noise-gating.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/memory-capability-runtime.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/dreaming-engine.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/memory-governance-tools.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/corpus-indexer.test.mjs" },
  { group: "packaging-and-workflow", runner: "node", file: "test/plugin-manifest-regression.mjs" },
  { group: "packaging-and-workflow", runner: "node", file: "test/openclaw-twitter-source-recipe.test.mjs", args: ["--test"] },
  { group: "packaging-and-workflow", runner: "node", file: "test/package-runtime.test.mjs" },
  { group: "packaging-and-workflow", runner: "node", file: "test/release-readiness.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/session-summary-before-reset.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/self-improvement-reset-note.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/self-improvement.test.mjs", args: ["--test"] },
  { group: "packaging-and-workflow", runner: "node", file: "test/sync-plugin-version.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/smart-metadata-v2.mjs" },
  { group: "storage-and-schema", runner: "node", file: "test/vector-search-cosine.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/context-support-e2e.mjs" },
  { group: "core-regression", runner: "node", file: "test/temporal-facts.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/memory-fact-query.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/memory-update-supersede.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/memory-upgrader-diagnostics.test.mjs" },
  { group: "llm-clients-and-auth", runner: "node", file: "test/llm-api-key-client.test.mjs", args: ["--test"] },
  { group: "llm-clients-and-auth", runner: "node", file: "test/llm-oauth-client.test.mjs", args: ["--test"] },
  { group: "llm-clients-and-auth", runner: "node", file: "test/cli-oauth-login.test.mjs", args: ["--test"] },
  { group: "packaging-and-workflow", runner: "node", file: "test/workflow-fork-guards.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/clawteam-scope.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/cross-process-lock.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/redis-lock.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/lock-stress-test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/lock-release-on-error.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/preference-slots.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/is-latest-auto-supersede.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/temporal-awareness.test.mjs", args: ["--test"] },
  // Issue #598 regression tests
  { group: "core-regression", runner: "node", file: "test/store-serialization.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/mmr-tiny.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/access-tracker-retry.test.mjs" },
  { group: "core-regression", runner: "node", file: "test/embedder-cache.test.mjs" },
  // Issue #629 batch embedding fix
  { group: "llm-clients-and-auth", runner: "node", file: "test/embedder-ollama-batch-routing.test.mjs" },
  // Issue #665 bulkStore tests
  // Issue #690 cross-call batch accumulator tests
  { group: "storage-and-schema", runner: "node", file: "test/issue-690-cross-call-batch.test.mjs", args: ["--test"] },
  // Issue #665 bulkStore tests (from upstream)
  { group: "storage-and-schema", runner: "node", file: "test/bulk-store.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/bulk-store-edge-cases.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/smart-extractor-bulk-store.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/smart-extractor-bulk-store-edge-cases.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/store-importance-normalization.test.mjs", args: ["--test"] },
  // Issue #680 regression tests (from upstream)
  { group: "core-regression", runner: "node", file: "test/memory-reflection-issue680-tdd.test.mjs", args: ["--test"] },
  // Issue #606 SDK migration Bug 2 regression tests
  { group: "core-regression", runner: "node", file: "test/issue606_sdk-migration.test.mjs" },
  // PR #713 inference regression tests - inferProviderFromBaseURL + model fallback
  { group: "core-regression", runner: "node", file: "test/infer-provider-from-baseurl.test.mjs" },
  // Issue #736 recall governance - isRecallUsed() unit tests
  { group: "core-regression", runner: "node", file: "test/is-recall-used.test.mjs", args: ["--test"] },
  // Issue #492 agentId validation tests
  { group: "core-regression", runner: "node", file: "test/agentid-validation.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/command-reflection-guard.test.mjs", args: ["--test"] },
  // Tier 1 memory counter fix
  { group: "core-regression", runner: "node", file: "test/tier1-counters.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/memory-subsession-prompt-hooks.test.mjs", args: ["--test"] },
  // Reflection distiller sub-session must not receive auto-recall/injected blocks
  { group: "core-regression", runner: "node", file: "test/reflection-distiller-hook-skip.test.mjs", args: ["--test"] },
  // register() re-registration hardening (scope cache-miss log/handler dedup)
  { group: "core-regression", runner: "node", file: "test/register-scope-dedup.test.mjs", args: ["--test"] },
  // Reflection distiller sub-run must request raw-run semantics (skip foreign before_prompt_build hooks)
  { group: "core-regression", runner: "node", file: "test/raw-run-distiller-hooks.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/autocapture-watermark-reset.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/autocapture-internal-session-guard.test.mjs", args: ["--test"] },
  { group: "storage-and-schema", runner: "node", file: "test/memory-categories-storage-map.test.mjs", args: ["--test"] },
  // Delete/delete-bulk must synchronously invalidate in-process reflection read caches
  { group: "core-regression", runner: "node", file: "test/delete-invalidate-reflection-caches.test.mjs", args: ["--test"] },
  { group: "core-regression", runner: "node", file: "test/autocapture-reset-on-valid-empty-extraction.test.mjs", args: ["--test"] },
];

export function getEntriesForGroup(group) {
  if (!CI_TEST_GROUPS.includes(group)) {
    throw new Error(`Unknown CI test group: ${group}`);
  }

  return CI_TEST_MANIFEST.filter((entry) => entry.group === group);
}
