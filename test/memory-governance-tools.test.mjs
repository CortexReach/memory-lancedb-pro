import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerAllMemoryTools } = jiti("../src/tools.ts");

function createToolSet(context) {
  const creators = new Map();
  const api = {
    registerTool(factory, meta) {
      creators.set(meta.name, factory);
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerAllMemoryTools(api, context, { enableManagementTools: true });
  return {
    get(name) {
      const factory = creators.get(name);
      assert.ok(factory, `tool ${name} should be registered`);
      return factory({});
    },
  };
}

describe("memory governance tools", () => {
  it("fails soft for inaccessible read-only recall scopes", async () => {
    const recallScopeFilters = [];
    const patchCalls = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
      },
      retriever: {
        async retrieve({ scopeFilter }) {
          recallScopeFilters.push(scopeFilter);
          return [{
            entry: {
              id: "recall-memory-1",
              text: "coffee preference",
              category: "preference",
              scope: "agent:main",
              importance: 0.7,
              timestamp: Date.now(),
              metadata: "{}",
            },
            score: 0.91,
            sources: { vector: { score: 0.91, rank: 1 } },
          }];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async count() {
          return 1;
        },
        async patchMetadata(id, patch, scopeFilter) {
          patchCalls.push({ id, patch, scopeFilter });
          return null;
        },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const recall = tools.get("memory_recall");

    const res = await recall.execute(null, {
      query: "coffee",
      scope: "current_conversation",
    });

    const expectedScopes = ["global", "agent:main", "reflection:agent:main"];
    assert.deepEqual(recallScopeFilters[0], expectedScopes);
    assert.match(res.content[0].text, /Ignored inaccessible scope "current_conversation"/);
    assert.equal(res.details.ignoredScope, "current_conversation");
    assert.deepEqual(res.details.accessibleScopes, expectedScopes);
    assert.equal(res.details.count, 1);
    assert.deepEqual(patchCalls[0].scopeFilter, expectedScopes);
  });

  it("keeps inaccessible write scopes hard-denied", async () => {
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
      },
      retriever: {
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {},
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, {
      text: "remember this",
      scope: "current_conversation",
    });

    assert.equal(res.details.error, "scope_access_denied");
    assert.equal(res.details.requestedScope, "current_conversation");
  });

  it("defaults stats and list to the caller's accessible scopes", async () => {
    const statsScopeFilters = [];
    const listScopeFilters = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`],
        getScopeFilter: (agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`],
        isAccessible: (scope, agentId) => ["global", `agent:${agentId}`, `reflection:agent:${agentId}`].includes(scope),
        getDefaultScope: (agentId) => `agent:${agentId}`,
        getStats: () => ({ totalScopes: 3, agentsWithCustomAccess: 0, scopesByType: {} }),
      },
      retriever: {
        getConfig() {
          return { mode: "hybrid" };
        },
        getStatsCollector() {
          return { count: 0 };
        },
      },
      store: {
        hasFtsSupport: true,
        async stats(scopeFilter) {
          statsScopeFilters.push(scopeFilter);
          return {
            totalCount: scopeFilter.includes("agent:main") ? 1 : 0,
            scopeCounts: { "agent:main": 1 },
            categoryCounts: { fact: 1 },
          };
        },
        async list(scopeFilter) {
          listScopeFilters.push(scopeFilter);
          return scopeFilter.includes("agent:main")
            ? [{
              id: "agent-memory-1",
              text: "agent private preference",
              category: "fact",
              scope: "agent:main",
              importance: 0.7,
              timestamp: Date.now(),
              metadata: "{}",
            }]
            : [];
        },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const stats = tools.get("memory_stats");
    const list = tools.get("memory_list");

    const statsRes = await stats.execute(null, {});
    const listRes = await list.execute(null, {});

    const expectedScopes = ["global", "agent:main", "reflection:agent:main"];
    assert.deepEqual(statsScopeFilters[0], expectedScopes);
    assert.deepEqual(listScopeFilters[0], expectedScopes);
    assert.deepEqual(statsRes.details.scopes, expectedScopes);
    assert.deepEqual(listRes.details.filters.scopes, expectedScopes);
    assert.equal(statsRes.details.stats.totalCount, 1);
    assert.equal(listRes.details.count, 1);
  });

  it("promotes and archives memory entries", async () => {
    const entries = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "remember coffee preference",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: JSON.stringify({ l0_abstract: "remember coffee preference", state: "pending", source: "auto-capture", memory_layer: "working" }),
      },
    ];

    const patchCalls = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve({ query, limit }) {
          if (query.includes("coffee")) {
            return [
              {
                entry: entries[0],
                score: 0.9,
                sources: { vector: { score: 0.9, rank: 1 } },
              },
            ].slice(0, limit);
          }
          return [];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata(id, patch) {
          patchCalls.push({ id, patch });
          return entries.find((e) => e.id === id) ?? null;
        },
        async getById(id) {
          return entries.find((e) => e.id === id) ?? null;
        },
        async list() {
          return entries;
        },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const promote = tools.get("memory_promote");
    const archive = tools.get("memory_archive");

    const promoteRes = await promote.execute(null, { query: "coffee" });
    assert.match(promoteRes.content[0].text, /Promoted memory/);

    const archiveRes = await archive.execute(null, { query: "coffee", reason: "stale" });
    assert.match(archiveRes.content[0].text, /Archived memory/);

    assert.equal(patchCalls.length, 2);
    assert.equal(patchCalls[0].patch.state, "confirmed");
    assert.equal(patchCalls[0].patch.memory_layer, "durable");
    assert.equal(patchCalls[1].patch.state, "archived");
    assert.equal(patchCalls[1].patch.memory_layer, "archive");
  });

  it("provides compaction preview and rank explanation", async () => {
    const now = Date.now();
    const entries = [
      {
        id: "a1111111-1111-4111-8111-111111111111",
        text: "Use tavily first",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({ l0_abstract: "Use tavily first", memory_category: "cases", state: "confirmed", source: "manual", memory_layer: "working" }),
      },
      {
        id: "b2222222-2222-4222-8222-222222222222",
        text: "Use tavily first",
        category: "fact",
        scope: "global",
        importance: 0.6,
        timestamp: now - 1000,
        metadata: JSON.stringify({ l0_abstract: "Use tavily first", memory_category: "cases", state: "confirmed", source: "manual", memory_layer: "working" }),
      },
    ];

    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() {
          return [
            {
              entry: entries[0],
              score: 0.88,
              sources: {
                vector: { score: 0.88, rank: 1 },
                bm25: { score: 0.73, rank: 2 },
              },
            },
          ];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata() { return entries[0]; },
        async getById(id) { return entries.find((e) => e.id === id) ?? null; },
        async list() { return entries; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const compact = tools.get("memory_compact");
    const explain = tools.get("memory_explain_rank");

    const compactRes = await compact.execute(null, { dryRun: true });
    assert.match(compactRes.content[0].text, /Compaction preview/);
    assert.equal(compactRes.details.duplicates, 1);

    const explainRes = await explain.execute(null, { query: "tavily", limit: 3 });
    assert.match(explainRes.content[0].text, /state=confirmed/);
    assert.match(explainRes.content[0].text, /layer=working/);
  });

  it("previews reflection resolve query results without mutating", async () => {
    const now = Date.now();
    const entries = [
      {
        id: "c1111111-1111-4111-8111-111111111111",
        text: "Verify line numbers before reporting completion.",
        category: "reflection",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({
          type: "memory-reflection-item",
          itemKind: "derived",
          agentId: "main",
        }),
      },
      {
        id: "c2222222-2222-4222-8222-222222222222",
        text: "Verify completion comments include the exact check output.",
        category: "reflection",
        scope: "global",
        importance: 0.7,
        timestamp: now - 1,
        metadata: JSON.stringify({
          type: "memory-reflection-item",
          itemKind: "derived",
          agentId: "main",
        }),
      },
    ];
    const patchCalls = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() {
          return [
            {
              entry: entries[0],
              score: 0.91,
              sources: { vector: { score: 0.91, rank: 1 } },
            },
            {
              entry: entries[1],
              score: 0.83,
              sources: { vector: { score: 0.83, rank: 2 } },
            },
          ];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata(id, patch) {
          patchCalls.push({ id, patch });
          return entries.find((e) => e.id === id) ?? null;
        },
        async getById(id) { return entries.find((e) => e.id === id) ?? null; },
        async list() { return entries; },
        async count() { return entries.length; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const resolve = tools.get("memory_reflection_resolve");
    const res = await resolve.execute(null, { query: "line numbers" });

    assert.match(res.content[0].text, /Reflection resolve preview/);
    assert.equal(res.details.action, "preview");
    assert.equal(res.details.candidates[0].id, entries[0].id);
    assert.equal(patchCalls.length, 0);

    const applyRes = await resolve.execute(null, { query: "verify completion", dryRun: false });
    assert.match(applyRes.content[0].text, /Preview first, then resolve a specific memoryId/);
    assert.equal(applyRes.details.error, "ambiguous_query");
    assert.equal(patchCalls.length, 0);
  });

  it("resolves an explicit reflection item with audit metadata", async () => {
    const now = Date.now();
    const entries = [
      {
        id: "d2222222-2222-4222-8222-222222222222",
        text: "Retry the manifest check after packaging changes.",
        category: "reflection",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({
          type: "memory-reflection-item",
          itemKind: "invariant",
          agentId: "main",
        }),
      },
    ];
    const patchCalls = [];
    const context = {
      agentId: "main",
      workspaceDir: "/tmp",
      mdMirror: null,
      scopeManager: {
        getAccessibleScopes: () => ["global"],
        isAccessible: () => true,
        getDefaultScope: () => "global",
      },
      retriever: {
        async retrieve() { return []; },
        getConfig() {
          return { mode: "hybrid" };
        },
      },
      store: {
        async patchMetadata(id, patch) {
          patchCalls.push({ id, patch });
          const entry = entries.find((e) => e.id === id);
          if (!entry) return null;
          const metadata = JSON.parse(entry.metadata || "{}");
          entry.metadata = JSON.stringify({ ...metadata, ...patch });
          return entry;
        },
        async getById(id) { return entries.find((e) => e.id === id) ?? null; },
        async list() { return entries; },
        async count() { return entries.length; },
      },
      embedder: { async embedPassage() { return [0.1, 0.2, 0.3]; } },
    };

    const tools = createToolSet(context);
    const resolve = tools.get("memory_reflection_resolve");
    const res = await resolve.execute(
      null,
      { memoryId: "d2222222", note: "covered by packaging regression" },
      undefined,
      undefined,
      { agentId: "reviewer" },
    );

    assert.match(res.content[0].text, /Resolved reflection item/);
    assert.equal(res.details.action, "resolved");
    assert.equal(res.details.resolvedBy, "reviewer");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, entries[0].id);
    assert.equal(typeof patchCalls[0].patch.resolvedAt, "number");
    assert.equal(patchCalls[0].patch.resolvedBy, "reviewer");
    assert.equal(patchCalls[0].patch.resolutionNote, "covered by packaging regression");
    const metadata = JSON.parse(entries[0].metadata);
    assert.equal(metadata.resolvedBy, "reviewer");
  });
});
