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
