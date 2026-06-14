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

function makeEntry({
  id,
  text,
  factKey,
  validFrom,
  invalidatedAt,
  validUntil,
  timestamp = validFrom,
  memoryCategory = "entities",
}) {
  return {
    id,
    text,
    vector: [],
    category: "fact",
    scope: "global",
    importance: 0.8,
    timestamp,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "fact", importance: 0.8, timestamp },
        {
          l0_abstract: text,
          memory_category: memoryCategory,
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
      async list(scopeFilter, _category, limit = 20, offset = 0) {
        return entries
          .filter((entry) => !scopeFilter || scopeFilter.includes(entry.scope))
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(offset, offset + limit);
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

test("memory_fact_query scans paginated store results before applying the result limit", async () => {
  const targetFrom = Date.parse("2026-01-01T00:00:00Z");
  const entries = [
    makeEntry({
      id: "historical-target",
      text: "Workspace canonical branch: trunk",
      factKey: "entities:workspace canonical branch",
      validFrom: targetFrom,
    }),
  ];

  for (let i = 0; i < 525; i += 1) {
    entries.push(makeEntry({
      id: `newer-${i}`,
      text: `Unrelated deployment note ${i}`,
      factKey: `entities:unrelated ${i}`,
      validFrom: Date.parse("2026-02-01T00:00:00Z") + i,
    }));
  }

  const tool = createTool(entries);
  const result = await tool.execute(null, {
    factKey: "entities:workspace canonical branch",
    at: "2026-03-01T00:00:00Z",
    limit: 1,
  }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 1);
  assert.equal(result.details.facts[0].id, "historical-target");
});

test("memory_fact_query includeHistory excludes facts that are not valid yet", async () => {
  const entries = [
    makeEntry({
      id: "expired-fact",
      text: "Launch window: January",
      factKey: "entities:launch window",
      validFrom: Date.parse("2026-01-01T00:00:00Z"),
      validUntil: Date.parse("2026-01-10T00:00:00Z"),
    }),
    makeEntry({
      id: "future-fact",
      text: "Launch window: February",
      factKey: "entities:launch window",
      validFrom: Date.parse("2026-02-01T00:00:00Z"),
    }),
  ];
  const tool = createTool(entries);

  const result = await tool.execute(null, {
    factKey: "entities:launch window",
    at: "2026-01-15T00:00:00Z",
    includeHistory: true,
  }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 1);
  assert.equal(result.details.facts[0].id, "expired-fact");
});

test("memory_fact_query treats explicit valid_from metadata as temporal without a fact key", async () => {
  const entries = [
    makeEntry({
      id: "valid-from-only",
      text: "The workspace runs nightly cleanup at 02:00",
      validFrom: Date.parse("2026-01-01T00:00:00Z"),
      memoryCategory: "patterns",
    }),
  ];
  const tool = createTool(entries);

  const result = await tool.execute(null, {
    query: "nightly cleanup",
    at: "2026-01-15T00:00:00Z",
  }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 1);
  assert.equal(result.details.facts[0].id, "valid-from-only");
});

test("memory_fact_query orders as-of matches by valid_from before entry timestamp", async () => {
  const entries = [
    makeEntry({
      id: "older-valid-from",
      text: "Retention policy: 30 days",
      factKey: "entities:retention policy",
      validFrom: Date.parse("2026-01-01T00:00:00Z"),
      timestamp: Date.parse("2026-03-01T00:00:00Z"),
    }),
    makeEntry({
      id: "newer-valid-from",
      text: "Retention policy: 60 days",
      factKey: "entities:retention policy",
      validFrom: Date.parse("2026-02-01T00:00:00Z"),
      timestamp: Date.parse("2026-02-01T00:00:00Z"),
    }),
  ];
  const tool = createTool(entries);

  const result = await tool.execute(null, {
    factKey: "entities:retention policy",
    at: "2026-03-15T00:00:00Z",
    includeHistory: true,
    limit: 2,
  }, undefined, undefined, { agentId: "main" });

  assert.equal(result.details.count, 2);
  assert.equal(result.details.facts[0].id, "newer-valid-from");
  assert.equal(result.details.facts[1].id, "older-valid-from");
});
