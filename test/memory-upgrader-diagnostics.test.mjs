import assert from "node:assert/strict";
import Module from "node:module";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryUpgrader } = jiti("../src/memory-upgrader.ts");

async function runTest() {
  await testLegacyUpgradeFallbackDiagnostic();
  await testReflectionRowsAreNotLegacy();
  await testBatchPreparationCompletesBeforeWrites();
  console.log("memory-upgrader diagnostics test passed");
}

async function testLegacyUpgradeFallbackDiagnostic() {
  const logs = [];
  const updates = [];
  const legacyEntry = {
    id: "legacy-1",
    text: "Legacy memory about an unfinished OpenClaw upgrade task.",
    category: "fact",
    scope: "test",
    importance: 0.8,
    timestamp: Date.now(),
    metadata: "{}",
  };

  const store = {
    async list() {
      return [legacyEntry];
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return true;
    },
  };

  const llm = {
    async completeJson() {
      return null;
    },
    getLastError() {
      return "memory-lancedb-pro: llm-client [generic] request failed for model mock: timeout";
    },
  };

  const upgrader = createMemoryUpgrader(store, llm, {
    log: (msg) => logs.push(msg),
  });

  const result = await upgrader.upgrade({ batchSize: 1 });

  assert.equal(result.totalLegacy, 1);
  assert.equal(result.upgraded, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(updates.length, 1);
  assert.match(
    logs.join("\n"),
    /request failed for model mock: timeout/,
  );
  assert.equal(typeof updates[0].patch.text, "string");
  assert.ok(updates[0].patch.metadata.includes("upgraded_at"));
}

async function testReflectionRowsAreNotLegacy() {
  const updates = [];
  const reflectionRows = [
    {
      id: "reflection-event-1",
      text: "reflection-event · global",
      category: "reflection",
      scope: "global",
      importance: 0.55,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        type: "memory-reflection-event",
        reflectionVersion: 4,
        eventId: "refl-1",
      }),
    },
    {
      id: "reflection-item-1",
      text: "Always verify migration banners before upgrading.",
      category: "reflection",
      scope: "global",
      importance: 0.82,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        type: "memory-reflection-item",
        reflectionVersion: 4,
        itemKind: "invariant",
      }),
    },
    {
      id: "reflection-mapped-1",
      text: "User prefers release-ready validation notes.",
      category: "reflection",
      scope: "global",
      importance: 0.75,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        type: "memory-reflection-mapped",
        reflectionVersion: 4,
        mappedKind: "user-model",
      }),
    },
  ];

  const store = {
    async list() {
      return reflectionRows;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return true;
    },
  };

  const upgrader = createMemoryUpgrader(store, null, { log: () => {} });
  const count = await upgrader.countLegacy();
  const dryRun = await upgrader.upgrade({ dryRun: true });

  assert.equal(count.total, 3);
  assert.equal(count.legacy, 0);
  assert.deepEqual(count.byCategory, {});
  assert.equal(dryRun.totalLegacy, 0);
  assert.equal(dryRun.skipped, 3);
  assert.equal(updates.length, 0);
}

async function testBatchPreparationCompletesBeforeWrites() {
  const logs = [];
  let llmCalls = 0;
  const legacyRows = [
    {
      id: "legacy-batch-1",
      text: "Legacy memory about reducing updater lock contention.",
      category: "fact",
      scope: "test",
      importance: 0.8,
      timestamp: Date.now(),
      metadata: "{}",
    },
    {
      id: "legacy-batch-2",
      text: "Legacy memory about keeping DB writes short.",
      category: "decision",
      scope: "test",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    },
  ];

  const store = {
    async list() {
      return legacyRows;
    },
    async bulkUpdateExact(updates) {
      assert.equal(llmCalls, 2, "all enrichment should finish before the batch write");
      assert.equal(updates.length, 2);
      return updates.map(({ id, updates: patch }) => ({
        id,
        entry: { ...legacyRows.find((row) => row.id === id), ...patch },
      }));
    },
    async update() {
      throw new Error("single-entry update should not be used when bulkUpdateExact exists");
    },
  };

  const llm = {
    async completeJson() {
      llmCalls += 1;
      return {
        l0_abstract: `Batch summary ${llmCalls}`,
        l1_overview: `- Batch summary ${llmCalls}`,
        l2_content: legacyRows[llmCalls - 1].text,
        resolved_category: "cases",
      };
    },
    getLastError() {
      return null;
    },
  };

  const upgrader = createMemoryUpgrader(store, llm, {
    log: (msg) => logs.push(msg),
  });

  const result = await upgrader.upgrade({ batchSize: 2 });

  assert.equal(result.totalLegacy, 2);
  assert.equal(result.upgraded, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(llmCalls, 2);
  assert.ok(logs.some((msg) => msg.includes("processing batch 1/1")));
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
