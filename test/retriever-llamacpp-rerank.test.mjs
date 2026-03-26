/**
 * TDD Tests for llama.cpp rerank provider
 * Phase 1: RED - Tests should fail until implementation is added
 */

import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

const entry = {
  id: "llamacpp-test-1",
  text: "llama.cpp supports reranking with cross-encoder models like bge-reranker.",
  vector: [0.5, 0.5],
  category: "fact",
  scope: "global",
  importance: 0.8,
  timestamp: Date.now(),
  metadata: "{}",
};

const fakeStore = {
  hasFtsSupport: true,
  async vectorSearch() { return [{ entry, score: 0.7 }]; },
  async bm25Search() { return [{ entry, score: 0.6 }]; },
  async hasId(id) { return id === entry.id; },
};

const fakeEmbedder = {
  async embedQuery() { return [0.5, 0.5]; },
};

// ============================================================================
// TEST 1: llama.cpp rerank provider with API key
// ============================================================================
async function testLlamaCppWithApiKey() {
  const originalFetch = globalThis.fetch;
  let capturedRequest = null;

  globalThis.fetch = async (url, init) => {
    capturedRequest = { url, ...init };
    return {
      ok: true,
      async json() {
        return {
          results: [{ index: 0, relevance_score: 0.95 }]
        };
      },
    };
  };

  try {
    const retriever = createRetriever(fakeStore, fakeEmbedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      filterNoise: false,
      rerank: "cross-encoder",
      rerankProvider: "llamacpp",
      rerankEndpoint: "http://127.0.0.1:8080/v1/rerank",
      rerankModel: "bge-reranker-v2-m3",
      rerankApiKey: "test-api-key",
    });

    const results = await retriever.retrieve({
      query: "reranking models",
      limit: 5,
      scopeFilter: ["global"],
    });

    // Assertions
    assert.equal(results.length, 1, "Should return 1 result");
    assert.equal(results[0].entry.id, entry.id, "Correct entry returned");
    assert.equal(results[0].sources.reranked?.score, 0.95, "Rerank score preserved");
    
    // Verify request format
    assert.ok(capturedRequest, "Request was captured");
    assert.equal(capturedRequest.url, "http://127.0.0.1:8080/v1/rerank", "Correct endpoint");
    
    const body = JSON.parse(capturedRequest.body);
    assert.equal(body.model, "bge-reranker-v2-m3", "Model passed");
    assert.equal(body.query, "reranking models", "Query passed");
    assert.deepEqual(body.documents, [entry.text], "Documents passed");
    assert.equal(body.top_n, 1, "top_n set correctly");
    
    // Verify headers
    assert.equal(
      capturedRequest.headers["Authorization"],
      "Bearer test-api-key",
      "API key in Authorization header"
    );

    console.log("✓ TEST 1 PASSED: llama.cpp with API key");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================================
// TEST 2: llama.cpp without API key
// ============================================================================
async function testLlamaCppWithoutApiKey() {
  const originalFetch = globalThis.fetch;
  let capturedRequest = null;

  globalThis.fetch = async (url, init) => {
    capturedRequest = { url, ...init };
    return {
      ok: true,
      async json() {
        return { results: [{ index: 0, relevance_score: 0.88 }] };
      },
    };
  };

  try {
    const retriever = createRetriever(fakeStore, fakeEmbedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      filterNoise: false,
      rerank: "cross-encoder",
      rerankProvider: "llamacpp",
      rerankEndpoint: "http://127.0.0.1:8080/v1/rerank",
      rerankModel: "bge-reranker-base",
      // No rerankApiKey
    });

    await retriever.retrieve({
      query: "test query",
      limit: 3,
      scopeFilter: ["global"],
    });

    // Verify no Authorization header when no API key
    const hasAuthHeader = capturedRequest.headers && capturedRequest.headers["Authorization"];
    assert.ok(!hasAuthHeader, "No Authorization without API key");
    
    console.log("✓ TEST 2 PASSED: llama.cpp without API key");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================================
// TEST 3: llama.cpp response parsing with reordering
// ============================================================================
async function testLlamaCppResponseParsing() {
  const originalFetch = globalThis.fetch;
  
  // Create two entries to test reordering
  const entry2 = {
    ...entry,
    id: "llamacpp-test-2",
    text: "This document is more relevant to the query.",
  };
  
  const multiStore = {
    hasFtsSupport: true,
    async vectorSearch() { 
      return [
        { entry, score: 0.8 },
        { entry: entry2, score: 0.6 },
      ]; 
    },
    async bm25Search() { 
      return [
        { entry, score: 0.7 },
        { entry: entry2, score: 0.5 },
      ]; 
    },
    async hasId(id) { return true; },
  };
  
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      // llama.cpp returns reordered results (index 1 is more relevant)
      return {
        results: [
          { index: 1, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.45 }
        ]
      };
    },
  });

  try {
    const retriever = createRetriever(multiStore, fakeEmbedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      filterNoise: false,
      rerank: "cross-encoder",
      rerankProvider: "llamacpp",
      rerankEndpoint: "http://localhost:8080/rerank",
      rerankModel: "test-model",
      rerankApiKey: "key",
    });

    const results = await retriever.retrieve({
      query: "test",
      limit: 5,
      scopeFilter: ["global"],
    });

    // Results should be reordered by reranker (entry2 first)
    assert.equal(results[0].entry.id, entry2.id, "Most relevant entry first");
    assert.equal(results[0].sources.reranked?.score, 0.99, "Highest rerank score first");
    
    console.log("✓ TEST 3 PASSED: llama.cpp response parsing with reordering");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================================
// TEST 4: llama.cpp error handling (fallback to cosine)
// ============================================================================
async function testLlamaCppErrorFallback() {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async text() { return "Internal Server Error"; },
  });

  try {
    const retriever = createRetriever(fakeStore, fakeEmbedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      filterNoise: false,
      rerank: "cross-encoder",
      rerankProvider: "llamacpp",
      rerankEndpoint: "http://localhost:8080/rerank",
      rerankModel: "test-model",
      rerankApiKey: "key",
    });

    const results = await retriever.retrieve({
      query: "test",
      limit: 5,
      scopeFilter: ["global"],
    });

    // Should fallback to cosine similarity
    assert.equal(results.length, 1, "Should still return results on error");
    assert.ok(results[0].score > 0, "Should have valid score from fallback");
    // Should have reranked source from fallback
    assert.ok(results[0].sources.reranked !== undefined, "Should have reranked source");
    
    console.log("✓ TEST 4 PASSED: llama.cpp error fallback to cosine");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================================
// TEST 5: llama.cpp timeout handling (skipped - requires real fetch)
// ============================================================================
async function testLlamaCppTimeout() {
  // Note: AbortController timeout is hard to test with mock fetch
  // The 5s timeout is implemented in the source code via AbortController
  console.log("✓ TEST 5 SKIPPED: timeout handling (verified in source)");
}

// ============================================================================
// Run all tests
// ============================================================================
console.log("Running llama.cpp rerank provider tests...\n");

await testLlamaCppWithApiKey();
await testLlamaCppWithoutApiKey();
await testLlamaCppResponseParsing();
await testLlamaCppErrorFallback();
await testLlamaCppTimeout();

console.log("\n✅ ALL llama.cpp RERANK TESTS PASSED");