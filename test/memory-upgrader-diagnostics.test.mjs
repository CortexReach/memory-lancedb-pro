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

  console.log("memory-upgrader diagnostics test passed");
}

runTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
