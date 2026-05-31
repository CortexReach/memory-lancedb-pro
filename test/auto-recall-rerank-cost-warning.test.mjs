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
const {
  buildAutoRecallRerankCostWarning,
  parsePluginConfig,
} = jiti("../index.ts");

function makeConfig(overrides = {}) {
  return parsePluginConfig({
    embedding: { apiKey: "dummy" },
    autoRecall: true,
    autoRecallMaxItems: 3,
    maxRecallPerTurn: 10,
    retrieval: {
      rerank: "cross-encoder",
      rerankApiKey: "dummy",
      rerankProvider: "jina",
      candidatePoolSize: 20,
    },
    ...overrides,
  });
}

{
  const warning = buildAutoRecallRerankCostWarning(makeConfig());
  assert.ok(warning, "hybrid cross-encoder auto-recall should warn when rerank input exceeds injected items");
  assert.match(warning, /rerank input window/);
  assert.match(warning, /autoRecallMaxItems/);
  assert.match(warning, /12 candidates/);
  assert.match(warning, /3 memories/);
  assert.doesNotMatch(warning, /cost follows retrieval\.candidatePoolSize/);
}

{
  const warning = buildAutoRecallRerankCostWarning(makeConfig({ autoRecall: false }));
  assert.equal(warning, null, "manual-only retrieval should not warn");
}

{
  const warning = buildAutoRecallRerankCostWarning(makeConfig({
    retrieval: {
      rerank: "lightweight",
      candidatePoolSize: 20,
    },
  }));
  assert.equal(warning, null, "local lightweight rerank should not warn");
}

{
  const warning = buildAutoRecallRerankCostWarning(makeConfig({
    retrieval: {
      rerank: "cross-encoder",
      rerankApiKey: "dummy",
      candidatePoolSize: 6,
    },
  }));
  assert.match(warning, /12 candidates/, "configured candidatePoolSize below the rerank window should not hide the warning");
}

{
  const warning = buildAutoRecallRerankCostWarning(makeConfig({
    retrieval: {
      mode: "vector",
      rerank: "cross-encoder",
      rerankApiKey: "dummy",
      candidatePoolSize: 20,
    },
  }));
  assert.equal(warning, null, "vector-only retrieval should not warn because it does not call cross-encoder rerank");
}

console.log("OK: auto-recall rerank cost warning test passed");
