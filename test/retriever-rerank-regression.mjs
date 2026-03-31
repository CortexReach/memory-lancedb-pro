import assert from "node:assert/strict";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

const entry = {
  id: "rerank-regression-1",
  text: "OpenClaw 记忆插件集成测试 token: TESTMEM-20260306-092541，仅用于验证 import/search/delete 闭环。",
  vector: [0, 1],
  category: "decision",
  scope: "global",
  importance: 0.91,
  timestamp: Date.now(),
  metadata: "{}",
};

const fakeStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry, score: 0.5438692121765099 }];
  },
  async bm25Search() {
    return [{ entry, score: 0.7833663291840794 }];
  },
  async hasId(id) {
    return id === entry.id;
  },
};

const fakeEmbedder = {
  async embedQuery() {
    return [1, 0];
  },
};

const retrieverConfig = {
  ...DEFAULT_RETRIEVAL_CONFIG,
  filterNoise: false,
  rerank: "cross-encoder",
  rerankApiKey: "test-key",
  rerankProvider: "jina",
  rerankEndpoint: "http://127.0.0.1:9/v1/rerank",
  rerankModel: "test-reranker",
  candidatePoolSize: 12,
  minScore: 0.6,
  hardMinScore: 0.62,
};

async function runScenario(name, responsePayload) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return responsePayload;
    },
  });

  try {
    const retriever = createRetriever(fakeStore, fakeEmbedder, retrieverConfig);
    const results = await retriever.retrieve({
      query: "TESTMEM-20260306-092541",
      limit: 5,
      scopeFilter: ["global"],
    });

    assert.equal(
      results.length,
      1,
      `${name}: strong BM25 exact-match result should survive rerank`,
    );
    assert.equal(results[0].entry.id, entry.id, `${name}: wrong memory returned`);
    assert.ok(results[0].score >= retrieverConfig.hardMinScore, `${name}: score dropped below hardMinScore`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await runScenario("low-score rerank result", {
  results: [{ index: 0, relevance_score: 0 }],
});

await runScenario("reranker omitted candidate", {
  results: [{ index: 1, relevance_score: 0.9 }],
});

async function runTeiScenario() {
  const originalFetch = globalThis.fetch;
  let capturedBody;

  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return [{ index: 0, score: 0.99 }];
      },
    };
  };

  try {
    const retriever = createRetriever(fakeStore, fakeEmbedder, {
      ...retrieverConfig,
      rerankProvider: "tei",
      rerankEndpoint: "http://127.0.0.1:8081/rerank",
      rerankModel: "BAAI/bge-reranker-v2-m3",
    });
    const results = await retriever.retrieve({
      query: "TESTMEM-20260306-092541",
      limit: 5,
      scopeFilter: ["global"],
    });

    assert.deepEqual(capturedBody, {
      query: "TESTMEM-20260306-092541",
      texts: [entry.text],
    });
    assert.equal(results.length, 1, "TEI rerank should return the expected result");
    assert.equal(results[0].sources.reranked?.score, 0.99, "TEI rerank score should be preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await runTeiScenario();

console.log("OK: rerank regression test passed");

const lexicalEntry = {
  id: "lexical-regression-1",
  text: "用户测试饮料偏好是乌龙茶，不喜欢美式咖啡。",
  vector: [0, 1],
  category: "preference",
  scope: "global",
  importance: 0.95,
  timestamp: Date.now(),
  metadata: "{}",
};

const lexicalStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: lexicalEntry, score: 0.5006586036313858 }];
  },
  async bm25Search() {
    return [{ entry: lexicalEntry, score: 0.78 }];
  },
  async hasId(id) {
    return id === lexicalEntry.id;
  },
};

const lexicalRetriever = createRetriever(lexicalStore, fakeEmbedder, {
  ...DEFAULT_RETRIEVAL_CONFIG,
  filterNoise: false,
  rerank: "none",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.6,
  hardMinScore: 0.62,
});

const lexicalResults = await lexicalRetriever.retrieve({
  query: "乌龙茶",
  limit: 5,
  scopeFilter: ["global"],
});

assert.equal(lexicalResults.length, 1, "strong lexical hit should survive hybrid fusion thresholds");
assert.equal(lexicalResults[0].entry.id, lexicalEntry.id);

// ============================================================================
// Weight effectiveness tests (Issue #130 Layer 3)
// ============================================================================

const weightTestEntry = {
  id: "weight-test-1",
  text: "User prefers dark mode for all applications.",
  vector: [0.6, 0.8],
  category: "preference",
  scope: "global",
  importance: 0.8,
  timestamp: Date.now(),
  metadata: "{}",
};

const weightTestStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: weightTestEntry, score: 0.6 }];
  },
  async bm25Search() {
    return [{ entry: weightTestEntry, score: 0.5 }];
  },
  async hasId(id) {
    return id === weightTestEntry.id;
  },
};

const weightTestEmbedder = {
  async embedQuery() {
    return [0.6, 0.8];
  },
};

// Test: vectorWeight=0.9, bm25Weight=0.1
const vectorHeavyRetriever = createRetriever(weightTestStore, weightTestEmbedder, {
  ...DEFAULT_RETRIEVAL_CONFIG,
  filterNoise: false,
  rerank: "none",
  vectorWeight: 0.9,
  bm25Weight: 0.1,
  minScore: 0.0,
  hardMinScore: 0.0,
});

// Test: vectorWeight=0.1, bm25Weight=0.9
const bm25HeavyRetriever = createRetriever(weightTestStore, weightTestEmbedder, {
  ...DEFAULT_RETRIEVAL_CONFIG,
  filterNoise: false,
  rerank: "none",
  vectorWeight: 0.1,
  bm25Weight: 0.9,
  minScore: 0.0,
  hardMinScore: 0.0,
});

const vectorHeavyResults = await vectorHeavyRetriever.retrieve({
  query: "dark mode",
  limit: 5,
});

const bm25HeavyResults = await bm25HeavyRetriever.retrieve({
  query: "dark mode",
  limit: 5,
});

assert.equal(vectorHeavyResults.length, 1, "vectorHeavy: should return 1 result");
assert.equal(bm25HeavyResults.length, 1, "bm25Heavy: should return 1 result");

// Core assertion: different weights must produce different fused scores
const vectorHeavyFused = vectorHeavyResults[0].sources.fused?.score;
const bm25HeavyFused = bm25HeavyResults[0].sources.fused?.score;

assert.ok(vectorHeavyFused !== undefined, "vectorHeavy: fused score must exist");
assert.ok(bm25HeavyFused !== undefined, "bm25Heavy: fused score must exist");
assert.notEqual(
  vectorHeavyFused,
  bm25HeavyFused,
  "different weight configs must produce different fused scores",
);

// vectorScore(0.6) > bm25Score(0.5), so vector-heavy config should score higher
// vectorHeavy: 0.6*0.9 + 0.5*0.1 = 0.59
// bm25Heavy:   0.6*0.1 + 0.5*0.9 = 0.51
assert.ok(
  vectorHeavyFused > bm25HeavyFused,
  `vector-heavy config (${vectorHeavyFused}) should score higher than bm25-heavy (${bm25HeavyFused}) when vectorScore > bm25Score`,
);

console.log("OK: weight effectiveness test passed");

// Test: BM25 high-score floor (>= 0.75) must hold regardless of weight config
const floorTestEntry = {
  id: "floor-test-1",
  text: "JINA_API_KEY=sk-test-12345",
  vector: [0.1, 0.9],
  category: "credential",
  scope: "global",
  importance: 1.0,
  timestamp: Date.now(),
  metadata: "{}",
};

const floorTestStore = {
  hasFtsSupport: true,
  async vectorSearch() {
    return [{ entry: floorTestEntry, score: 0.3 }];
  },
  async bm25Search() {
    return [{ entry: floorTestEntry, score: 0.85 }];
  },
  async hasId(id) {
    return id === floorTestEntry.id;
  },
};

const floorTestRetriever = createRetriever(floorTestStore, weightTestEmbedder, {
  ...DEFAULT_RETRIEVAL_CONFIG,
  filterNoise: false,
  rerank: "none",
  vectorWeight: 0.9,
  bm25Weight: 0.1,
  minScore: 0.0,
  hardMinScore: 0.0,
});

const floorResults = await floorTestRetriever.retrieve({
  query: "JINA_API_KEY",
  limit: 5,
});

assert.equal(floorResults.length, 1, "floor test: should return 1 result");

const floorFused = floorResults[0].sources.fused?.score;
assert.ok(floorFused !== undefined, "floor test: fused score must exist");

// BM25 floor: 0.85 * 0.92 = 0.782
// Weighted: 0.3 * 0.9 + 0.85 * 0.1 = 0.355
// Math.max(0.355, 0.782) = 0.782 — floor should win
assert.ok(
  floorFused >= 0.85 * 0.92 - 0.001,
  `BM25 high-score floor must hold: got ${floorFused}, expected >= ${0.85 * 0.92}`,
);

console.log("OK: BM25 high-score floor test passed");
