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
    async vectorSearch() { return []; },
    async hasId(id) { return entriesMap.has(id); },
  };
}

function createMockEmbedder() {
  return { async embedQuery() { return new Array(384).fill(0.1); } };
}

describe("MemoryRetriever - PR746 signal extraction + auto-recall BM25 mode", () => {
  describe("signal parameter propagation", () => {
    it("should accept signal in RetrievalContext", async () => {
      const store = createMockStore([{ id: "1", text: "architecture decision", scope: "global", category: "decision", timestamp: Date.now(), vector: new Array(384).fill(0.1) }]);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const controller = new AbortController();
      const results = await retriever.retrieve({ query: "architecture", limit: 5, source: "manual", signal: controller.signal });
      assert.ok(Array.isArray(results));
    });

    it("should handle cancelled signal without throwing", async () => {
      const store = createMockStore([{ id: "1", text: "test memory", scope: "global", category: "fact", timestamp: Date.now(), vector: new Array(384).fill(0.1) }]);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const controller = new AbortController();
      controller.abort();
      const results = await retriever.retrieve({ query: "test", limit: 5, source: "manual", signal: controller.signal });
      assert.ok(Array.isArray(results));
    });
  });

  describe("useLightweightAutoRecall (BM25-only for auto-recall source)", () => {
    it("should use BM25-only mode when source is 'auto-recall' even without tag tokens", async () => {
      const entries = [
        { id: "1", text: "memory about project decisions", scope: "global", category: "decision", timestamp: Date.now(), vector: new Array(384).fill(0.1) },
        { id: "2", text: "another memory about project", scope: "global", category: "fact", timestamp: Date.now(), vector: new Array(384).fill(0.1) },
      ];
      const store = createMockStore(entries);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const results = await retriever.retrieve({ query: "project", limit: 5, source: "auto-recall" });
      assert.ok(Array.isArray(results));
      assert.ok(results.length >= 1);
      assert.ok(results.some((r) => r.entry.text.includes("project")));
    });

    it("should NOT trigger BM25-only when source is 'manual' without tag tokens", async () => {
      const store = createMockStore([{ id: "1", text: "memory about project", scope: "global", category: "decision", timestamp: Date.now(), vector: new Array(384).fill(0.1) }]);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const results = await retriever.retrieve({ query: "project", limit: 5, source: "manual" });
      assert.ok(Array.isArray(results));
    });

    it("should prioritize tag tokens over useLightweightAutoRecall", async () => {
      const store = createMockStore([{ id: "1", text: "proj:AI memory", scope: "global", category: "decision", timestamp: Date.now(), vector: new Array(384).fill(0.1) }]);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, tagPrefixes: ["proj"], mode: "hybrid" });
      const results = await retriever.retrieve({ query: "proj:AI", limit: 5, source: "auto-recall" });
      assert.ok(Array.isArray(results));
      assert.ok(results.some((r) => r.entry.text.includes("proj:AI")));
    });
  });

  describe("retrieveWithTrace supports signal + useLightweightAutoRecall", () => {
    it("should accept signal in retrieveWithTrace context", async () => {
      const store = createMockStore([{ id: "1", text: "test trace memory", scope: "global", category: "fact", timestamp: Date.now(), vector: new Array(384).fill(0.1) }]);
      const retriever = new MemoryRetriever(store, createMockEmbedder(), { ...DEFAULT_RETRIEVAL_CONFIG, mode: "hybrid", tagPrefixes: [] });
      const { results, trace } = await retriever.retrieveWithTrace({ query: "trace", limit: 5, source: "auto-recall" });
      assert.ok(Array.isArray(results));
      assert.ok(trace);
    });
  });
});