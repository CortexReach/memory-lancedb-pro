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
      const retriever = new MemoryRetriever(store, embedder);

      const results = await retriever.retrieve({
        query: "proj:AIF",
        limit: 10,
      });

      assert.equal(results.length, 2, "Should return exactly 2 results");
      assert.ok(
        results.every((r) => r.entry.text.includes("proj:AIF")),
        "All results should contain proj:AIF"
      );
      assert.ok(
        !results.some((r) => r.entry.id === "3"),
        "Should not include unrelated entry"
      );
    });

    it("should have vector: undefined in BM25-only results", async () => {
      const entries = [
        {
          id: "1",
          text: "proj:TEST memory",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder);

      const results = await retriever.retrieve({
        query: "proj:TEST",
        limit: 5,
      });

      if (results.length > 0) {
        assert.ok("sources" in results[0], "Result should have sources");
        assert.ok("vector" in results[0].sources, "sources should have vector key");
        assert.equal(
          results[0].sources.vector,
          undefined,
          "sources.vector should be undefined for BM25-only"
        );
        assert.ok(results[0].sources.bm25, "sources.bm25 should exist");
        assert.ok(results[0].sources.fused, "sources.fused should exist");
      }
    });
  });

  describe("Configurable tag prefixes", () => {
    it("should support custom tag prefixes", async () => {
      const entries = [
        {
          id: "1",
          text: "custom:TAG1 some content",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "other content without tag",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ];

      const store = createMockStore(entries);
      const embedder = createMockEmbedder();
      const config = {
        ...DEFAULT_RETRIEVAL_CONFIG,
        tagPrefixes: ["custom", "another"],
      };
      const retriever = new MemoryRetriever(store, embedder, config);

      const results = await retriever.retrieve({
        query: "custom:TAG1",
        limit: 10,
      });

      if (results.length > 0) {
        assert.ok(
          results.every((r) => r.entry.text.includes("custom:TAG1")),
          "Should only return entries with custom:TAG1"
        );
      }
    });

    it("should update tag regex when config changes", async () => {
      const store = createMockStore();
      const embedder = createMockEmbedder();
      const retriever = new MemoryRetriever(store, embedder);

      retriever.updateConfig({
        tagPrefixes: ["newprefix"],
      });

      const config = retriever.getConfig();
      assert.deepEqual(
        config.tagPrefixes,
        ["newprefix"],
        "Config should be updated"
      );
    });
  });
});
