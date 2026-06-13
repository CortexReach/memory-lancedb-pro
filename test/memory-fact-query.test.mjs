import assert from "node:assert/strict";
import { test } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  buildSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");
const { createScopeManager } = jiti("../src/scopes.ts");
const { registerMemoryFactQueryTool } = jiti("../src/tools.ts");

function makeEntry({ id, text, factKey, validFrom, invalidatedAt, validUntil }) {
  return {
    id,
    text,
    vector: [],
    category: "fact",
    scope: "global",
    importance: 0.8,
    timestamp: validFrom,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "fact", importance: 0.8, timestamp: validFrom },
        {
          l0_abstract: text,
          memory_category: "entities",
          fact_key: factKey,
          valid_from: validFrom,
          invalidated_at: invalidatedAt,
          valid_until: validUntil,
        },
      ),
    ),
  };
}

function createTool(entries) {
  const toolFactories = {};
  const api = {
    registerTool(factory, meta) {
      toolFactories[meta.name] = factory;
    },
  };
  const scopeManager = createScopeManager({
    default: "global",
    definitions: {
      global: { description: "Shared" },
    },
    agentAccess: {
      main: ["global"],
    },
  });

  registerMemoryFactQueryTool(api, {
    scopeManager,
    store: {
      async list(scopeFilter) {
        return entries.filter((entry) => !scopeFilter || scopeFilter.includes(entry.scope));
      },
    },
    retriever: {},
    embedder: {},
    agentId: "main",
  });

  return toolFactories.memory_fact_query({ agentId: "main" });
}

test("memory_fact_query returns the fact active at the requested date", async () => {
  const oldFrom = Date.parse("2026-01-01T00:00:00Z");
  const newFrom = Date.parse("2026-02-01T00:00:00Z");
  const entries = [
    makeEntry({
      id: "old-version",
      text: "MyQuant strategy version: v11.1",
      factKey: "entities:myquant strategy version",
      validFrom: oldFrom,
      invalidatedAt: newFrom,
    }),
    makeEntry({
      id: "current-version",
      text: "MyQuant strategy version: v12.0",
      factKey: "entities:myquant strategy version",
      validFrom: newFrom,
    }),
  ];
  const tool = createTool(entries);

  const historical = await tool.execute(null, {
    factKey: "entities:myquant strategy version",
    at: "2026-01-15T00:00:00Z",
  }, undefined, undefined, { agentId: "main" });

  assert.equal(historical.details.count, 1);
  assert.equal(historical.details.facts[0].id, "old-version");
  assert.equal(historical.details.facts[0].activeAt, true);

  const current = await tool.execute(null, {
    query: "myquant strategy version",
    at: "2026-03-01T00:00:00Z",
  }, undefined, undefined, { agentId: "main" });

  assert.equal(current.details.count, 1);
  assert.equal(current.details.facts[0].id, "current-version");
});

test("memory_fact_query hides expired facts unless history is requested", async () => {
  const entries = [
    makeEntry({
      id: "expired-fact",
      text: "Temporary deployment freeze until Friday",
      factKey: "entities:deployment freeze",
      validFrom: Date.parse("2026-01-01T00:00:00Z"),
      validUntil: Date.parse("2026-01-10T00:00:00Z"),
    }),
  ];
  const tool = createTool(entries);

  const current = await tool.execute(null, {
    query: "deployment freeze",
    at: "2026-01-15T00:00:00Z",
  }, undefined, undefined, { agentId: "main" });

  assert.equal(current.details.count, 0);

  const history = await tool.execute(null, {
    query: "deployment freeze",
    at: "2026-01-15T00:00:00Z",
    includeHistory: true,
  }, undefined, undefined, { agentId: "main" });

  assert.equal(history.details.count, 1);
  assert.equal(history.details.facts[0].id, "expired-fact");
  assert.equal(history.details.facts[0].activeAt, false);
});
