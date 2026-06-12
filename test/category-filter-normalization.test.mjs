import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  matchesMemoryCategoryFilter,
  normalizeCategory,
  resolveCategoryFilterCandidates,
} = jiti("../src/memory-categories.ts");
const { createRetriever } = jiti("../src/retriever.ts");
const { MemoryStore } = jiti("../src/store.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");
const {
  registerMemoryStoreTool,
  registerMemoryUpdateTool,
} = jiti("../src/tools.ts");

const VECTOR_DIM = 3;

function buildResult(id, category, metadata = "{}") {
  return {
    entry: {
      id,
      text: `${category} memory about coffee`,
      vector: [0.1, 0.2, 0.3],
      category,
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata,
    },
    score: 0.9,
  };
}

function makeVector(text) {
  if (/profile|name|alice/i.test(text)) return [1, 0, 0];
  if (/case|outage|postgres/i.test(text)) return [0, 1, 0];
  if (/event|conference|incident/i.test(text)) return [0, 0, 1];
  return [0.5, 0.25, 0.25];
}

function createTool(registerFn, context) {
  let captured = null;
  const api = {
    registerTool(factory) {
      captured = factory;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerFn(api, context);
  assert.equal(typeof captured, "function");
  return captured({});
}

function makeToolContext(store) {
  return {
    agentId: "test-agent",
    workspaceDir: "/tmp",
    mdMirror: null,
    store,
    retriever: {
      async retrieve() {
        return [];
      },
      getConfig() {
        return { mode: "hybrid" };
      },
      getStatsCollector() {
        return { count: 0 };
      },
    },
    embedder: {
      async embedPassage(text) {
        return makeVector(text);
      },
    },
    scopeManager: {
      getAccessibleScopes: () => ["global"],
      getScopeFilter: () => ["global"],
      getDefaultScope: () => "global",
      isAccessible: (scope) => scope === "global",
    },
  };
}

function makeSmartExtractor(store) {
  return new SmartExtractor(
    store,
    {
      async embed(text) {
        return makeVector(text);
      },
      async embedBatch(texts) {
        return texts.map(makeVector);
      },
    },
    {
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          return {
            memories: [
              {
                category: "profile",
                abstract: "Profile: Alice is the release owner",
                overview: "- Alice owns releases",
                content: "Alice is the release owner.",
              },
              {
                category: "cases",
                abstract: "Case: postgres outage runbook",
                overview: "- Postgres outage runbook",
                content: "Use the postgres outage runbook for recovery.",
              },
            ],
          };
        }
        if (mode === "dedup-memory") {
          return { decision: "create", reason: "new memory" };
        }
        throw new Error(`unexpected mode: ${mode}`);
      },
    },
    {
      extractMinMessages: 1,
      defaultScope: "global",
      log() {},
      debugLog() {},
    },
  );
}

describe("category filter normalization", () => {
  it("maps legacy singular category filters to smart-extractor categories", () => {
    assert.equal(normalizeCategory("preference"), "preferences");
    assert.equal(normalizeCategory("entity"), "entities");
    assert.equal(matchesMemoryCategoryFilter("preferences", "preference"), true);
    assert.equal(matchesMemoryCategoryFilter("preference", "preferences"), true);
    assert.equal(matchesMemoryCategoryFilter("other", "preferences"), false);
    assert.deepEqual(
      resolveCategoryFilterCandidates("preference"),
      ["preference", "preferences"],
    );
  });

  it("applies normalized category filters during retrieval", async () => {
    const retriever = createRetriever(
      {
        hasFtsSupport: true,
        async refreshFtsSupport() {
          return true;
        },
        async vectorSearch() {
          return [];
        },
        async bm25Search() {
          return [
            buildResult("smart-preference", "preferences"),
            buildResult("event", "events"),
          ];
        },
        async hasId() {
          return true;
        },
      },
      {
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
      },
      { rerank: "none", hardMinScore: 0, filterNoise: false },
    );

    const results = await retriever.retrieve({
      query: "coffee",
      limit: 5,
      category: "preference",
      source: "manual",
    });

    assert.deepEqual(results.map((result) => result.entry.id), ["smart-preference"]);
  });

  it("applies metadata-aware smart category filters during retrieval", async () => {
    const profileMeta = JSON.stringify({ memory_category: "profile" });
    const casesMeta = JSON.stringify({ memory_category: "cases" });
    const retriever = createRetriever(
      {
        hasFtsSupport: true,
        async refreshFtsSupport() {
          return true;
        },
        async vectorSearch() {
          return [];
        },
        async bm25Search() {
          return [
            buildResult("profile-fact", "fact", profileMeta),
            buildResult("case-fact", "fact", casesMeta),
          ];
        },
        async hasId() {
          return true;
        },
      },
      {
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
      },
      { rerank: "none", hardMinScore: 0, filterNoise: false },
    );

    const results = await retriever.retrieve({
      query: "coffee",
      limit: 5,
      category: "profile",
      source: "manual",
    });

    assert.deepEqual(results.map((result) => result.entry.id), ["profile-fact"]);
  });

  it("filters real smart-extractor rows by metadata category through store.list", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "category-filter-"));
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: VECTOR_DIM,
    });

    try {
      const extractor = makeSmartExtractor(store);
      const stats = await extractor.extractAndPersist(
        "Alice owns releases. Use the postgres outage runbook.",
        "session-1",
        { scope: "global" },
      );

      assert.equal(stats.created, 2);

      const profile = await store.list(["global"], "profile", 10, 0);
      const cases = await store.list(["global"], "cases", 10, 0);

      assert.deepEqual(profile.map((entry) => entry.text), [
        "Profile: Alice is the release owner",
      ]);
      assert.equal(profile[0].category, "fact");
      assert.equal(parseSmartMetadata(profile[0].metadata, profile[0]).memory_category, "profile");

      assert.deepEqual(cases.map((entry) => entry.text), [
        "Case: postgres outage runbook",
      ]);
      assert.equal(cases[0].category, "fact");
      assert.equal(parseSmartMetadata(cases[0].metadata, cases[0]).memory_category, "cases");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps SQL list category filtering equivalent to the metadata predicate", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "category-list-"));
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: VECTOR_DIM,
    });

    try {
      const profileText = "Profile: Alice prefers short release notes";
      const caseText = "Case: postgres outage recovery";
      await store.store({
        text: profileText,
        vector: makeVector(profileText),
        category: "fact",
        scope: "global",
        importance: 0.9,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: profileText, category: "fact", importance: 0.9 },
            { memory_category: "profile", l0_abstract: profileText },
          ),
        ),
      });
      await store.store({
        text: caseText,
        vector: makeVector(caseText),
        category: "fact",
        scope: "global",
        importance: 0.7,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: caseText, category: "fact", importance: 0.7 },
            { memory_category: "cases", l0_abstract: caseText },
          ),
        ),
      });

      const profile = await store.list(["global"], "profile", 10, 0);
      const cases = await store.list(["global"], "cases", 10, 0);

      assert.deepEqual(profile.map((entry) => entry.text), [profileText]);
      assert.deepEqual(cases.map((entry) => entry.text), [caseText]);
      for (const entry of [...profile, ...cases]) {
        assert.equal(
          matchesMemoryCategoryFilter(entry.category, parseSmartMetadata(entry.metadata, entry).memory_category, entry.metadata),
          true,
        );
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes smart categories in manual memory_store writes", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "category-store-tool-"));
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: VECTOR_DIM,
    });

    try {
      const tool = createTool(registerMemoryStoreTool, makeToolContext(store));
      const result = await tool.execute(null, {
        text: "Event: attended the 2026 release conference",
        category: "events",
        scope: "global",
        force: true,
      });

      assert.equal(result.details.category, "events");
      assert.equal(result.details.rawCategory, "decision");

      const entries = await store.list(["global"], "events", 10, 0);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].category, "decision");
      assert.equal(parseSmartMetadata(entries[0].metadata, entries[0]).memory_category, "events");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes smart categories in manual memory_update writes", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "category-update-tool-"));
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: VECTOR_DIM,
    });

    try {
      const text = "Case: postgres outage recovery";
      const entry = await store.store({
        text,
        vector: makeVector(text),
        category: "fact",
        scope: "global",
        importance: 0.7,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text, category: "fact", importance: 0.7 },
            { memory_category: "cases", l0_abstract: text },
          ),
        ),
      });

      const tool = createTool(registerMemoryUpdateTool, makeToolContext(store));
      const result = await tool.execute(null, {
        memoryId: entry.id,
        category: "events",
      });

      assert.equal(result.details.action, "updated");
      const updated = await store.getById(entry.id, ["global"]);
      assert.equal(updated.category, "decision");
      assert.equal(parseSmartMetadata(updated.metadata, updated).memory_category, "events");
      assert.deepEqual((await store.list(["global"], "events", 10, 0)).map((e) => e.id), [entry.id]);
      assert.deepEqual(await store.list(["global"], "cases", 10, 0), []);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
