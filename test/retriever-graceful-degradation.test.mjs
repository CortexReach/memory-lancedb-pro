import assert from "node:assert";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
});

const { createRetriever } = jiti("../src/retriever.ts");

function buildResult(id = "memory-1", text = "test result") {
  return {
    entry: {
      id,
      text,
      vector: [0.1, 0.2, 0.3],
      category: "other",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    },
    score: 0.9,
  };
}

function createRetrieverHarness(
  config = {},
  storeOverrides = {},
  embedderOverrides = {},
) {
  const bm25Queries = [];
  const embeddedQueries = [];

  const retriever = createRetriever(
    {
      hasFtsSupport: true,
      async vectorSearch() {
        return [];
      },
      async bm25Search(query) {
        bm25Queries.push(query);
        return [buildResult()];
      },
      async hasId() {
        return true;
      },
      async get() {
        return null;
      },
      async upsert() {
        return [];
      },
      async delete() {
        return;
      },
      ...storeOverrides,
    },
    {
      async embedQuery(query) {
        embeddedQueries.push(query);
        return [0.1, 0.2, 0.3];
      },
      ...embedderOverrides,
    },
    config,
  );

  return { retriever, bm25Queries, embeddedQueries };
}

describe("Retriever Graceful Degradation (Promise.allSettled)", () => {
  it("throws when both vector and BM25 search reject", async () => {
    const { retriever } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          throw new Error("vector failed");
        },
        async bm25Search() {
          throw new Error("bm25 failed");
        },
      },
    );

    await assert.rejects(
      retriever.retrieve({ query: "test", limit: 1, source: "manual" }),
      /both vector and BM25 search failed.*vector failed.*bm25 failed/,
    );

    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      "hybrid.parallelSearch",
    );
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
  });

  it("refreshes FTS support before choosing the retrieval mode", async () => {
    let refreshCalls = 0;
    const { retriever, bm25Queries } = createRetrieverHarness(
      { rerank: "none", hardMinScore: 0, filterNoise: false },
      {
        hasFtsSupport: false,
        async refreshFtsSupport() {
          refreshCalls += 1;
          return true;
        },
        async vectorSearch() {
          return [];
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          return [buildResult("memory-fts", "literal token recovered through BM25")];
        },
      },
    );

    const results = await retriever.retrieve({
      query: "literal token",
      limit: 1,
      source: "manual",
    });

    assert.equal(refreshCalls, 1);
    assert.equal(bm25Queries.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, "memory-fts");
    assert.equal(results[0].sources.bm25?.rank, 1);
  });

  it("uses vector-only results when BM25 fails", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          return [buildResult()];
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          throw new Error("bm25 failed");
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test",
      limit: 1,
      source: "manual",
    });

    assert.equal(results.length, 1);
    assert.equal(bm25Queries.length, 1); // BM25 was attempted and failed
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      1,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null, // No overall failure
    );
  });

  it("uses bm25-only results when vector fails", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          throw new Error("vector failed");
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          return [buildResult()];
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test",
      limit: 1,
      source: "manual",
    });

    assert.equal(results.length, 1);
    assert.equal(bm25Queries.length, 1);
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      1,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null, // No overall failure
    );
  });

  it("returns empty results when both backends succeed with no matches", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          return []; // ✅ Success, but empty
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          return []; // ✅ Success, but empty
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test",
      limit: 1,
      source: "manual",
    });

    // Empty result set is valid — should not throw
    assert.equal(results.length, 0);
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null, // No failure
    );
  });

  it("uses vector-only results when BM25 fails and vector returns empty", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          return []; // ✅ Success, but empty
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          throw new Error("bm25 failed");
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test",
      limit: 1,
      source: "manual",
    });

    // Empty result from successful vector search is valid
    assert.equal(results.length, 0);
    assert.equal(bm25Queries.length, 1);
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null, // No failure
    );
  });

  it("uses bm25-only results when vector fails and bm25 returns empty", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          throw new Error("vector failed");
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          return []; // ✅ Success, but empty
        },
      },
    );

    const results = await retriever.retrieve({
      query: "test",
      limit: 1,
      source: "manual",
    });

    // Empty result from successful BM25 search is valid
    assert.equal(results.length, 0);
    assert.equal(bm25Queries.length, 1);
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null, // No failure
    );
  });

  it("normalizes empty results as distinct from both-fail errors", async () => {
    const { retriever } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          return []; // ✅ Success, empty results
        },
        async bm25Search(query) {
          return []; // ✅ Success, empty results
        },
      },
    );

    const results = await retriever.retrieve({
      query: "nonexistent",
      limit: 10,
      source: "manual",
    });

    // This was the bug: empty results were treated as both-fail
    // Now empty results should succeed (valid search outcome)
    assert.equal(results.length, 0);
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      null,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
  });
});
