import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

function createMockStore(entries = []) {
  const entriesMap = new Map(entries.map((e) => [e.id, e]));
  return {
    hasFtsSupport: true,
    async bm25Search(query, limit, scopeFilter) {
      return Array.from(entriesMap.values())
        .filter((e) => !scopeFilter || scopeFilter.includes(e.scope))
        .filter((e) => e.text.toLowerCase().includes(query.toLowerCase()))
        .map((entry, index) => ({ entry, score: 0.8 - index * 0.1 }))
        .slice(0, limit);
    },
    async vectorSearch() {
      return [];
    },
    async hasId(id) {
      return entriesMap.has(id);
    },
  };
}

describe("MemoryRetriever - PR746 signal threading + embed abort handling", () => {
  describe("signal parameter propagation", () => {
    it("should accept signal in RetrievalContext", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "architecture decision",
          scope: "global",
          category: "decision",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const retriever = new MemoryRetriever(store, {
        async embedQuery() {
          return new Array(384).fill(0.1);
        },
      }, { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const controller = new AbortController();
      const results = await retriever.retrieve({
        query: "architecture",
        limit: 5,
        source: "manual",
        signal: controller.signal,
      });
      assert.ok(Array.isArray(results));
    });

    it("should re-throw AbortError without BM25 fallback when signal is already aborted", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "test memory",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const embedder = {
        async embedQuery(_query, _signal) {
          // Simulate embed failure due to abort
          throw new DOMException("Aborted", "AbortError");
        },
      };
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        tagPrefixes: [],
      });
      const controller = new AbortController();
      // Abort before calling retrieve
      controller.abort();

      await assert.rejects(
        async () => {
          await retriever.retrieve({
            query: "test",
            limit: 5,
            source: "manual",
            signal: controller.signal,
          });
        },
        (err) => {
          // Verify it's an AbortError, not some other error
          return err.name === "AbortError" || err.message.includes("Aborted");
        },
        "Should re-throw AbortError without attempting BM25 fallback",
      );
    });

    it("should fallback to BM25 when embed fails with non-abort error and signal is NOT aborted", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "project decision memory",
          scope: "global",
          category: "decision",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "another project note",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const embedder = {
        async embedQuery() {
          // Simulate network/API error (not an AbortError)
          throw new Error("ECONNREFUSED");
        },
      };
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        tagPrefixes: [],
      });
      const controller = new AbortController();
      // Signal is NOT aborted — should use BM25 fallback

      // Should NOT throw — BM25 fallback should return results
      const results = await retriever.retrieve({
        query: "project",
        limit: 5,
        source: "manual",
        signal: controller.signal,
      });

      assert.ok(Array.isArray(results), "Should return results from BM25 fallback");
      assert.ok(results.length >= 1, "Should have at least one result from BM25");
    });
  });

  describe("hybridRetrieval signal abort handling", () => {
    it("should re-throw AbortError in hybridRetrieval without BM25 fallback", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "test memory",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const embedder = {
        async embedQuery(_query, _signal) {
          throw new DOMException("Aborted", "AbortError");
        },
      };
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "hybrid",
        tagPrefixes: [],
      });
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await retriever.retrieve({
            query: "test",
            limit: 5,
            source: "manual",
            signal: controller.signal,
          });
        },
        (err) => {
          return err.name === "AbortError" || err.message.includes("Aborted");
        },
        "Should re-throw AbortError in hybrid mode without BM25 fallback",
      );
    });

    it("should fallback to BM25 in hybridRetrieval for non-abort embed errors", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "architecture decision",
          scope: "global",
          category: "decision",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: "2",
          text: "another architecture note",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const embedder = {
        async embedQuery() {
          throw new Error("Network unavailable");
        },
      };
      const retriever = new MemoryRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "hybrid",
        tagPrefixes: [],
      });

      const results = await retriever.retrieve({
        query: "architecture",
        limit: 5,
        source: "manual",
      });

      assert.ok(Array.isArray(results), "Should return results from BM25 fallback in hybrid");
      assert.ok(results.length >= 1, "Should have at least one BM25 result");
    });
  });

  describe("retrieveWithTrace supports signal", () => {
    it("should accept signal in retrieveWithTrace", async () => {
      const store = createMockStore([
        {
          id: "1",
          text: "test trace memory",
          scope: "global",
          category: "fact",
          timestamp: Date.now(),
          vector: new Array(384).fill(0.1),
        },
      ]);
      const retriever = new MemoryRetriever(store, {
        async embedQuery() {
          return new Array(384).fill(0.1);
        },
      }, { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const controller = new AbortController();
      const { results, trace } = await retriever.retrieveWithTrace({
        query: "trace",
        limit: 5,
        source: "manual",
        signal: controller.signal,
      });
      assert.ok(Array.isArray(results));
      assert.ok(trace);
    });
  });
});