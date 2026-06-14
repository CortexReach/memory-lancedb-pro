import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
} = jiti("../src/retriever.ts");
const { parsePluginConfig } = jiti("../index.ts");

const now = Date.now();

function entry(id, text, scope = "team-a", category = "fact") {
  return {
    id,
    text,
    scope,
    category,
    timestamp: now,
    importance: 0.8,
    vector: [1, 0, 0],
    metadata: "{}",
  };
}

const primary = entry("primary", "primary plan mentions alpha module");
const sameScopeNeighbor = entry("neighbor-a", "alpha module follow-up detail");
const otherScopeNeighbor = entry("neighbor-b", "alpha module other scope detail", "team-b");
const otherCategoryNeighbor = entry("neighbor-c", "alpha module decision detail", "team-a", "decision");

function createStore(options = {}) {
  const bm25Calls = [];
  return {
    bm25Calls,
    hasFtsSupport: true,
    async vectorSearch(_vector, _limit, _minScore, scopeFilter) {
      assert.deepEqual(scopeFilter, ["team-a", "team-b"]);
      return [{ entry: primary, score: 0.9 }];
    },
    async bm25Search(query, limit, scopeFilter, searchOptions) {
      bm25Calls.push({ query, limit, scopeFilter, options: searchOptions });
      if (query === "primary query") {
        assert.deepEqual(scopeFilter, ["team-a", "team-b"]);
        return [{ entry: primary, score: 0.8 }];
      }
      if (query === primary.text) {
        if (options.throwOnNeighborLookup) {
          throw new Error("neighbor fts unavailable");
        }
        assert.deepEqual(scopeFilter, ["team-a"]);
        return [
          { entry: primary, score: 0.99 },
          { entry: sameScopeNeighbor, score: 0.82 },
          { entry: otherScopeNeighbor, score: 0.81 },
          { entry: otherCategoryNeighbor, score: 0.8 },
        ].slice(0, limit);
      }
      return [];
    },
    async hasId(id) {
      return [primary, sameScopeNeighbor, otherScopeNeighbor, otherCategoryNeighbor]
        .some((candidate) => candidate.id === id);
    },
  };
}

const embedder = {
  async embedQuery() {
    return [1, 0, 0];
  },
};

function createConfig(overrides = {}) {
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: "hybrid",
    rerank: "none",
    filterNoise: false,
    minScore: 0,
    hardMinScore: 0,
    queryExpansion: false,
    ...overrides,
  };
}

describe("retrieval neighbor enrichment", () => {
  it("keeps hybrid retrieval unchanged when neighbor enrichment is disabled", async () => {
    const store = createStore();
    const retriever = createRetriever(store, embedder, createConfig());

    const results = await retriever.retrieve({
      query: "primary query",
      limit: 3,
      scopeFilter: ["team-a", "team-b"],
      category: "fact",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, "primary");
    assert.equal(results[0].neighbors, undefined);
    assert.equal(store.bm25Calls.length, 1, "disabled mode should not issue neighbor BM25 lookups");
  });

  it("attaches same-scope BM25 neighbors after MMR in hybrid retrieval", async () => {
    const store = createStore();
    const retriever = createRetriever(store, embedder, createConfig({
      neighborEnrichment: {
        enabled: true,
        maxPerResult: 2,
      },
    }));

    const results = await retriever.retrieve({
      query: "primary query",
      limit: 3,
      scopeFilter: ["team-a", "team-b"],
      category: "fact",
    });

    assert.equal(results.length, 1, "neighbors should not increase top-level result count");
    assert.deepEqual(
      results[0].neighbors?.map((neighbor) => neighbor.entry.id),
      ["neighbor-a"],
      "neighbors should exclude the primary result and stay within active scope/category boundaries",
    );
    assert.equal(results[0].neighbors?.[0].sources.bm25.rank, 1);
    assert.equal(store.bm25Calls.length, 2, "enabled mode should issue a supplemental BM25 lookup");
    assert.equal(store.bm25Calls[1].limit, 13, "supplemental lookup should reserve slack after primary-id exclusion");
  });

  it("returns primary hybrid results when supplemental neighbor lookup fails", async () => {
    const store = createStore({ throwOnNeighborLookup: true });
    const retriever = createRetriever(store, embedder, createConfig({
      neighborEnrichment: {
        enabled: true,
        maxPerResult: 2,
      },
    }));
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(String(message));

    try {
      const results = await retriever.retrieve({
        query: "primary query",
        limit: 3,
        scopeFilter: ["team-a", "team-b"],
        category: "fact",
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].entry.id, "primary");
      assert.equal(results[0].neighbors, undefined);
      assert.equal(store.bm25Calls.length, 2, "primary BM25 succeeds and supplemental lookup is attempted");
      assert.match(warnings.join("\n"), /neighbor enrichment BM25 lookup failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("parses partial nested neighbor enrichment config with safe defaults", () => {
    const parsed = parsePluginConfig({
      embedding: {
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "text-embedding-3-small",
      },
      retrieval: {
        neighborEnrichment: {
          enabled: true,
        },
      },
    });

    const retriever = createRetriever(createStore(), embedder, parsed.retrieval);
    const config = retriever.getConfig();
    assert.deepEqual(config.neighborEnrichment, {
      enabled: true,
      maxPerResult: 2,
    });
  });

  it("normalizes neighbor enrichment bounds in returned retriever config", () => {
    const retriever = createRetriever(createStore(), embedder, createConfig({
      neighborEnrichment: {
        enabled: true,
        maxPerResult: 99,
      },
    }));

    assert.deepEqual(retriever.getConfig().neighborEnrichment, {
      enabled: true,
      maxPerResult: 5,
    });

    retriever.updateConfig({
      neighborEnrichment: {
        maxPerResult: 0,
      },
    });

    assert.deepEqual(retriever.getConfig().neighborEnrichment, {
      enabled: true,
      maxPerResult: 1,
    });
  });
});
