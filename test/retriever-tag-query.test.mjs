import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

// ============================================================================
// Test helpers
// ============================================================================

function createMockStore(entries = []) {
  const entriesMap = new Map(entries.map((e) => [e.id, e]));
  return {
    hasFtsSupport: true,
    async bm25Search(query, limit, scopeFilter) {
      const results = Array.from(entriesMap.values())
        .filter((e) => {
          if (scopeFilter && !scopeFilter.includes(e.scope)) return false;
          return e.text.toLowerCase().includes(query.toLowerCase());
        })
        .map((entry, index) => ({
          entry,
          score: 0.8 - index * 0.1,
        }));
      return results.slice(0, limit);
    },
    async vectorSearch() {
      return [];
    },
    async hasId(id) {
      return entriesMap.has(id);
    },
  };
}

function createMockEmbedder() {
  return {
    async embedQuery() {
      return new Array(384).fill(0.1);
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MemoryRetriever - Tag Query", () => {
  it("should expose tuned retrieval defaults from DGG-2684", () => {
    assert.equal(DEFAULT_RETRIEVAL_CONFIG.vectorWeight, 0.55);
    assert.equal(DEFAULT_RETRIEVAL_CONFIG.bm25Weight, 0.45);
    assert.equal(DEFAULT_RETRIEVAL_CONFIG.recencyHalfLifeDays, 10);
    assert.equal(DEFAULT_RETRIEVAL_CONFIG.recencyWeight, 0.18);
    assert.equal(DEFAULT_RETRIEVAL_CONFIG.hardMinScore, 0.32);
  });

  describe("BM25-only retrieval with mustContain", () => {
    it("should only return entries literally containing proj:AIF", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:AIF decision about forge naming",
          scope: "global",
          category: "decision",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "proj:AIF architecture for image processing",
          scope: "global",
          category: "decision",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "3",
          text: "Some unrelated memory about projects",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["proj", "env"],
      });

      const results = await retriever.retrieve({
        query: "proj:AIF",
        limit: 5,
      });

      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.entry.text.includes("proj:AIF")));
      assert.ok(!results.some((r) => r.entry.id === "3"));
    });

    it("should be case-insensitive for mustContain", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:aif lowercase tag",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "proj:AIF uppercase tag",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["proj"],
      });

      const results = await retriever.retrieve({
        query: "proj:AIF",
        limit: 5,
      });

      assert.equal(results.length, 2);
    });

    it("should fall back to normal retrieval when tagPrefixes is empty", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:AIF some content",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: [],
        mode: "hybrid",
      });

      const results = await retriever.retrieve({
        query: "proj:AIF",
        limit: 5,
      });

      // Should fall back to hybrid retrieval (BM25 returns the entry)
      assert.equal(results.length, 1);
      // Should NOT have used tag query path (would have bm25 source only)
      assert.ok(results[0].sources.bm25 || results[0].sources.fused);
    });

    it("should work with multiple tag prefixes", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:AIF env:prod deployment",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "team:backend discussion",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["proj", "env", "team"],
      });

      const results1 = await retriever.retrieve({
        query: "proj:AIF",
        limit: 5,
      });
      assert.equal(results1.length, 1);
      assert.equal(results1[0].entry.id, "1");

      const results2 = await retriever.retrieve({
        query: "team:backend",
        limit: 5,
      });
      assert.equal(results2.length, 1);
      assert.equal(results2[0].entry.id, "2");
    });

    it("should extract multiple tags from query", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:AIF env:prod deployment notes",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "proj:AIF env:dev testing",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "3",
          text: "proj:AIF only",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["proj", "env"],
      });

      const results = await retriever.retrieve({
        query: "proj:AIF env:prod",
        limit: 5,
      });

      // Should only return entry that contains BOTH tags
      assert.equal(results.length, 1);
      assert.equal(results[0].entry.id, "1");
      assert.ok(results[0].entry.text.includes("proj:AIF"));
      assert.ok(results[0].entry.text.includes("env:prod"));
    });

    it("should filter BM25 false positives with mustContain", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:AIF exact tag match",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "This proj is about AIF but not tagged",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["proj"],
      });

      const results = await retriever.retrieve({
        query: "proj:AIF",
        limit: 5,
      });

      // Should only return entry with exact tag, not the one with separate words
      assert.equal(results.length, 1);
      assert.equal(results[0].entry.id, "1");
      assert.ok(!results.some((r) => r.entry.id === "2"));
    });

    it("should respect scope tags using entry.scope even without literal tag text", async () => {
      const entries = [
        {
          id: "1",
          text: "최근 작업 정리",
          scope: "agent:badtz-dev",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "최근 작업 정리",
          scope: "dggd:ops",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["agent", "dggd", "scope"],
      });

      const results = await retriever.retrieve({
        query: "agent:badtz-dev 최근 작업",
        limit: 5,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].entry.id, "1");
    });

    it("should allow nested dggd scope tags (dggd:ops)", async () => {
      const entries = [
        {
          id: "1",
          text: "최근 작업 정리",
          scope: "dggd:ops",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "최근 작업 정리",
          scope: "dggd:projects",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["dggd", "scope"],
      });

      const results = await retriever.retrieve({
        query: "dggd:ops 최근 작업",
        limit: 5,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].entry.id, "1");
    });
  });
});
