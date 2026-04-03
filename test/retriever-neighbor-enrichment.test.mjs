/**
 * PR #461 — Proposal B Phase 2: Neighbor Enrichment for Auto-Recall
 * 測試目標：enrichWithNeighbors() 邏輯驗證
 *
 * 執行方式：node --test test/retriever-neighbor-enrichment.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": new URL("test/helpers/openclaw-plugin-sdk-stub.mjs", import.meta.url).pathname,
  },
});

const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

// ============================================================================
// Helper：建立 MemoryEntry
// ============================================================================

function makeEntry(id, text, scope = "global", importance = 0.5) {
  return {
    id,
    text,
    vector: [0, 0],
    category: "fact",
    scope,
    importance,
    timestamp: Date.now(),
    metadata: "{}",
  };
}

function makeResult(entry, score = 0.5) {
  return {
    entry,
    score,
    sources: {
      vector: { score, rank: 1 },
    },
  };
}

// ============================================================================
// Helper：建立 mock MemoryRetriever
// ============================================================================

/**
 * @param {object} opts
 * @param {Array} opts.vectorSearchResults - 每次 vectorSearch 的回傳（依呼叫順序）
 * @param {Array} opts.embedQueryResults - 每次 embedQuery 的回傳（依呼叫順序）
 * @param {object} opts.config - 覆寫 config
 * @param {boolean} opts.forceVectorOnly - true = hasFtsSupport=false（走 vector-only path，BM25 不干擾）
 */
function createMockRetriever({
  vectorSearchResults = [],
  embedQueryResults = [],
  config = {},
  forceVectorOnly = false,
} = {}) {
  let vsCallIdx = 0;
  let eqCallIdx = 0;

  const defaultEntries = [
    { ...makeEntry("mem-1", "測試內文一"), text: "測試內文一" },
    { ...makeEntry("mem-2", "相似內文二"), text: "相似內文二" },
    { ...makeEntry("mem-shared", "共享內容"), text: "共享內容" },
  ];
  const entriesMap = new Map(defaultEntries.map(e => [e.id, e]));

  const mockStore = {
    hasFtsSupport: !forceVectorOnly,
    async vectorSearch(..._args) {
      const result = vectorSearchResults[vsCallIdx] ?? [];
      vsCallIdx++;
      return result;
    },
    async bm25Search(query, limit, _scopeFilter) {
      const q = (query || "").toLowerCase();
      const results = Array.from(entriesMap.values())
        .filter(e => e.text.toLowerCase().includes(q))
        .slice(0, limit)
        .map((entry, index) => ({ entry, score: 0.8 - index * 0.1 }));
      return results;
    },
    async hasId(id) {
      return entriesMap.has(id);
    },
  };

  const mockEmbedder = {
    async embedQuery(_query, _signal) {
      const result = embedQueryResults[eqCallIdx] ?? [0, 0];
      eqCallIdx++;
      if (result instanceof Error) throw result;
      return result;
    },
  };

  const retrieverConfig = { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, ...config };
  const retriever = new MemoryRetriever(mockStore, mockEmbedder, retrieverConfig);

  return {
    retriever,
    getVsCallCount: () => vsCallIdx,
    getEqCallCount: () => eqCallIdx,
  };
}

// ============================================================================
// 測試案例
// ============================================================================

describe("PR #461 — Neighbor Enrichment (enrichWithNeighbors)", () => {

  describe("基本行為", () => {

    // TC-1: auto-recall + enableNeighborEnrichment=true → 執行 enrichment
    it("auto-recall + enableNeighborEnrichment=true：結果包含鄰居", async () => {
      const entry1 = makeEntry("mem-1", "測試內文一");
      const neighborEntry = makeEntry("mem-2", "相似內文二");

      const { retriever } = createMockRetriever({
        // hybrid: bm25Search 回傳結果 + vectorSearch 回傳結果 → RRF
        // enrichment: vectorSearch 回傳 neighborEntry
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          [makeResult(neighborEntry, 0.55)],
        ],
        embedQueryResults: [
          [0.1, 0.9],  // query embedding
          [0.1, 0.9],  // neighbor lookup for entry1
        ],
        config: { enableNeighborEnrichment: true },
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "auto-recall",
      });

      assert.ok(results.length >= 1, "至少要有原本的結果");
    });

    // TC-2: manual retrieval → 不執行 enrichment
    it("manual retrieval：跳過 enrichment，回傳原始結果", async () => {
      const entry1 = makeEntry("mem-1", "測試內文一");

      const { retriever, getEqCallCount } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
        ],
        embedQueryResults: [[0.1, 0.9]],
        config: { enableNeighborEnrichment: true },
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "manual",
      });

      // query embed 會呼叫 1 次；enrichment 不應呼叫
      assert.ok(results.length >= 1);
    });

    // TC-3: enableNeighborEnrichment=false → 跳過 enrichment
    it("enableNeighborEnrichment=false：跳過 enrichment（不呼叫額外 embedQuery）", async () => {
      const entry1 = makeEntry("mem-1", "測試內文一");

      const { retriever, getEqCallCount } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
        ],
        embedQueryResults: [[0.1, 0.9]],
        config: { enableNeighborEnrichment: false },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "auto-recall",
      });

      // 只有 query embed（1 次），無 enrichment embed
      assert.strictEqual(getEqCallCount(), 1, "只有 query embed，無 enrichment");
      assert.ok(results.length >= 1);
    });

    // TC-4: 沒有 neighbors（vectorSearch 回傳空）→ 回傳原本結果
    it("沒有 neighbors：回傳原本結果，不 crash", async () => {
      const entry1 = makeEntry("mem-1", "測試內文一");

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          [], // 無 neighbors
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // entry1 的 neighbor lookup → 空
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "auto-recall",
      });

      assert.ok(results.length >= 1);
      assert.strictEqual(results.find(r => r.entry.id === "mem-1")?.entry.id, "mem-1");
    });
  });

  describe("去重邏輯", () => {

    // TC-5: neighbor 與原本結果相同 id → 跳過
    it("neighbor 與原本結果相同 id → 跳過（不重複）", async () => {
      const entry1 = makeEntry("mem-1", "測試內文一");

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          [makeResult(entry1, 0.55)], // 自己當 neighbor
        ],
        embedQueryResults: [
          [0.1, 0.9],
          [0.1, 0.9],
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "auto-recall",
      });

      const mem1Count = results.filter(r => r.entry.id === "mem-1").length;
      assert.strictEqual(mem1Count, 1, "mem-1 只出現一次");
    });

    // TC-6: 多個原本結果有相同 neighbor → 只加入一次
    it("多個原本結果共享同一個 neighbor → 只加入一次", async () => {
      const entry1 = makeEntry("entry1", "共享內容文本");
      const entry2 = makeEntry("entry2", "另一個共享文本");
      const sharedNeighbor = makeEntry("shared-nb", "共享鄰居內容", "global", 0.6);

      // 自訂 entriesMap，讓 bm25Search 對任何 query 都回傳這兩個 entries
      const entriesMap = new Map([
        [entry1.id, { ...entry1, text: entry1.text }],
        [entry2.id, { ...entry2, text: entry2.text }],
      ]);

      const customStore = {
        hasFtsSupport: true,
        async vectorSearch(..._args) {
          return [makeResult(entry1, 0.6), makeResult(entry2, 0.5)];
        },
        async bm25Search() {
          // 回傳所有 entries（無視 query）
          return Array.from(entriesMap.values()).map((e, i) => ({
            entry: e, score: 0.8 - i * 0.1,
          }));
        },
        async hasId(id) { return entriesMap.has(id); },
      };
      const customEmbedder = {
        async embedQuery() { return [0.1, 0.9]; },
      };
      // 第二次 vectorSearch 回傳 shared neighbor（用闭包變數追蹤）
      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          ...customStore,
          async vectorSearch(..._args) {
            vsCall++;
            if (vsCall === 1) return [makeResult(entry1, 0.6), makeResult(entry2, 0.5)];
            return [makeResult(sharedNeighbor, 0.45)]; // enrichment → shared neighbor
          },
        },
        customEmbedder,
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true }
      );

      const results = await retriever.retrieve({
        query: "共享",
        limit: 20,
        source: "auto-recall",
      });

      const sharedCount = results.filter(r => r.entry.id === "shared-nb").length;
      assert.strictEqual(sharedCount, 1, "共享 neighbor 只出現一次");
    });
  });

  describe("重新排序", () => {

    // TC-7: neighbor 的 effectiveScore 影響排序
    it("neighbor 重要性高 → 排在前面", async () => {
      const lowEntry = makeEntry("mem-low", "低分內容", "global", 0.1);
      const highNeighbor = makeEntry("mem-high", "高分鄰居", "global", 1.0);

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(lowEntry, 0.4)],
          [makeResult(highNeighbor, 0.7)],
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // lowEntry enrichment
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 20,
        source: "auto-recall",
      });

      // effectiveScore: highNeighbor=0.7*1.0=0.7, lowEntry=0.4*0.73=0.292
      assert.strictEqual(results[0]?.entry?.id, "mem-high", "高重要性 neighbor 應排第一");
    });

    // TC-8: 原本結果 importance=0 時 effectiveScore 最低
    it("importance=0：effectiveScore = similarity * 0.7，排列取決於相似度", async () => {
      const zeroEntry = makeEntry("mem-zero", "零重要性內容", "global", 0.0);
      const midNeighbor = makeEntry("mem-mid", "中等重要性", "global", 0.5);

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(zeroEntry, 0.5)],
          [makeResult(midNeighbor, 0.3)],
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // zeroEntry enrichment
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "零",
        limit: 20,
        source: "auto-recall",
      });

      // effectiveScore: zeroEntry=0.5*0.7=0.35, midNeighbor=0.3*0.85=0.255
      // → zeroEntry 排第一
      assert.strictEqual(results[0]?.entry?.id, "mem-zero", "高相似度的零重要性內容應排第一");
    });
  });

  describe("limit 邊界", () => {

    // TC-9: limit=1 → 只回傳 1 筆
    it("limit=1：只回傳 1 筆結果", async () => {
      const entry1 = makeEntry("mem-1", "內文一");
      const neighbor = makeEntry("mem-2", "鄰居");

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          [makeResult(neighbor, 0.5)],
        ],
        embedQueryResults: [
          [0.1, 0.9],
          [0.1, 0.9],
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 1,
        source: "auto-recall",
      });

      assert.ok(results.length <= 1, "結果不應超過 limit");
    });

    // TC-10: neighbors 數量超過 limit → 截斷
    it("neighbors 數量超過 limit → 截斷", async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeEntry(`mem-${i}`, `內文 ${i}`)
      );
      const neighbors = Array.from({ length: 4 }, (_, i) =>
        makeEntry(`nb-${i}`, `鄰居 ${i}`)
      );

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          entries.map((e, i) => makeResult(e, 0.5 - i * 0.05)),
          ...neighbors.map(n => [makeResult(n, 0.4)]),
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          ...entries.map(() => [0.1, 0.9]), // each entry enrichment
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "測試",
        limit: 3,
        source: "auto-recall",
      });

      assert.ok(results.length <= 3, "結果應被截斷在 limit 內");
    });
  });

  describe("錯誤處理", () => {

    // TC-11: embedQuery 失敗 → 跳過該 neighbor，不 crash
    it("embedQuery 拋錯：跳過該 neighbor，回傳其餘結果", async () => {
      const entry1 = makeEntry("mem-1", "內文一");
      const entry2 = makeEntry("mem-2", "內文二");

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          [makeResult(entry2, 0.5)],
        ],
        // query 成功，entry1 enrichment 成功，entry2 enrichment 失敗
        embedQueryResults: [
          [0.1, 0.9],         // query
          [0.1, 0.9],         // entry1 enrichment → 成功
          new Error("embed fail"), // entry2 enrichment → 失敗
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "auto-recall",
      });

      assert.ok(results.length >= 1, "至少有原本的結果");
    });

    // TC-12: vectorSearch 拋錯 → 跳過該 iteration，不 crash
    it("vectorSearch 拋錯：跳過該 iteration，回傳其餘結果", async () => {
      const entry1 = makeEntry("mem-1", "內文一");
      const entry2 = makeEntry("mem-2", "內文二");

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [makeResult(entry1, 0.6)],
          new Error("store error"), // entry1 neighbor lookup → 失敗
          [makeResult(entry2, 0.5)],
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // entry1
          [0.2, 0.8], // entry2
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "auto-recall",
      });

      assert.ok(results.length >= 1);
    });
  });

  describe("scope 正確性", () => {

    // TC-13: neighbor 需使用與原本結果相同的 scope
    it("neighbor 查詢使用與原本結果相同的 scope", async () => {
      const entry1 = makeEntry("mem-1", "agent 內文", "agent:abc", 0.5);
      const neighborEntry = makeEntry("nb-1", "agent 鄰居", "agent:abc", 0.6);

      let capturedScope;
      const customStore = {
        hasFtsSupport: false,
        async vectorSearch(vector, topK, minScore, scope) {
          capturedScope = scope;
          // enrichment call: 4 args，scope = [entry.scope]
          if (scope?.length === 1 && scope[0] === "agent:abc") {
            return [makeResult(neighborEntry, 0.55)];
          }
          return [makeResult(entry1, 0.6)];
        },
        async bm25Search() { return []; },
        async hasId() { return false; },
      };
      const customEmbedder = {
        async embedQuery() { return [0.1, 0.9]; },
      };
      const retriever = new MemoryRetriever(customStore, customEmbedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        enableNeighborEnrichment: true,
      });

      await retriever.retrieve({
        query: "agent",
        limit: 20,
        source: "auto-recall",
      });

      assert.deepStrictEqual(capturedScope, ["agent:abc"], "neighbor 查詢使用相同 scope");
    });
  });

  describe("effectiveScore 計算", () => {

    // TC-14: effectiveScore = similarity * (0.7 + 0.3 * importance)
    it("effectiveScore 計算正確", async () => {
      // effectiveScore 只在有 neighbors 時才會被計算（neighbors.length > 0）
      const entry = makeEntry("target-entry", "目標內容文本", "global", 0.9);
      const neighbor = makeEntry("nb-1", "鄰居文本", "global", 0.6);
      const entriesMap = new Map([[entry.id, entry], [neighbor.id, neighbor]]);

      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          hasFtsSupport: false,
          async vectorSearch() {
            vsCall++;
            if (vsCall === 1) return [makeResult(entry, 0.8)];
            return [makeResult(neighbor, 0.5)]; // enrichment: 回傳 neighbor
          },
          async bm25Search() { return []; },
          async hasId(id) { return entriesMap.has(id); },
        },
        {
          async embedQuery() { return [0.1, 0.9]; },
        },
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true }
      );

      const results = await retriever.retrieve({
        query: "目標",
        limit: 20,
        source: "auto-recall",
      });

      // effectiveScore: entry=0.8*(0.7+0.3*0.9)=0.776, neighbor=0.5*(0.7+0.3*0.6)=0.44
      // → entry 排第一
      const first = results.find(r => r.entry.id === "target-entry");
      assert.ok(first, "target-entry 應在結果中");
      assert.strictEqual(first.effectiveScore, 0.776, "effectiveScore 計算正確");
    });

    // TC-15: 缺少 sources.vector 時 fallback 到 score
    it("無 sources.vector：fallback 到 entry.score", async () => {
      const entry1 = makeEntry("fallback-entry", "fallback內容文本", "global", 0.5);
      const neighbor = makeEntry("nb-2", "鄰居文本2", "global", 0.3);
      const entriesMap = new Map([[entry1.id, entry1], [neighbor.id, neighbor]]);

      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          hasFtsSupport: false,
          async vectorSearch() {
            vsCall++;
            if (vsCall === 1) {
              // 無 sources.vector
              return [{ entry: entry1, score: 0.6, sources: {} }];
            }
            return [makeResult(neighbor, 0.4)]; // 有 neighbor，觸發 effectiveScore 計算
          },
          async bm25Search() { return []; },
          async hasId(id) { return entriesMap.has(id); },
        },
        {
          async embedQuery() { return [0.1, 0.9]; },
        },
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true }
      );

      const results = await retriever.retrieve({
        query: "fallback",
        limit: 20,
        source: "auto-recall",
      });

      // fallback: baseSimilarity = 0.6 (entry.score，無 sources.vector)
      // effectiveScore = 0.6 * (0.7 + 0.3 * 0.5) = 0.6 * 0.85 = 0.51
      const first = results.find(r => r.entry.id === "fallback-entry");
      assert.ok(first, "fallback-entry 應在結果中");
      assert.strictEqual(first.effectiveScore, 0.51, "fallback 計算正確");
    });

    // TC-16: importance 為 NaN 或 undefined → fallback 0.5
    it("importance 無效：fallback 0.5", async () => {
      const badEntry = { ...makeEntry("mem-bad", "內容"), importance: "not-a-number" };
      const neighborEntry = makeEntry("nb-1", "鄰居", "global", 0.5);

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          [{ entry: badEntry, score: 0.5, sources: { vector: { score: 0.5, rank: 1 } } }],
          [makeResult(neighborEntry, 0.4)],
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // badEntry enrichment
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "內容",
        limit: 20,
        source: "auto-recall",
      });

      // fallback importance = 0.5
      // badEntry effectiveScore = 0.5 * (0.7 + 0.3 * 0.5) = 0.5 * 0.85 = 0.425
      const badResult = results.find(r => r.entry.id === "mem-bad");
      assert.ok(badResult, "badEntry 應在結果中");
      assert.strictEqual(badResult.effectiveScore, 0.425);
    });
  });

  describe("category 過濾", () => {

    // TC-17: neighbor 不同 category → 應被排除
    it("neighbor category 不同 → 排除該 neighbor", async () => {
      const entry1 = makeEntry("mem-1", "事實內文", "global", 0.5);
      entry1.category = "fact";
      const neighborFact = makeEntry("nb-fact", "事實鄰居", "global", 0.6);
      neighborFact.category = "fact";
      const neighborPref = makeEntry("nb-pref", "偏好鄰居", "global", 0.7);
      neighborPref.category = "preference";

      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          hasFtsSupport: false,
          async vectorSearch() {
            vsCall++;
            if (vsCall === 1) return [makeResult(entry1, 0.6)];
            // enrichment: 回傳 fact + preference 兩種 neighbor
            return [makeResult(neighborFact, 0.55), makeResult(neighborPref, 0.65)];
          },
          async bm25Search() { return []; },
          async hasId() { return false; },
        },
        {
          async embedQuery() { return [0.1, 0.9]; },
        },
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true },
      );

      // category = "fact"
      const results = await retriever.retrieve({
        query: "事實",
        limit: 20,
        source: "auto-recall",
        category: "fact",
      });

      const factNeighbor = results.find(r => r.entry.id === "nb-fact");
      const prefNeighbor = results.find(r => r.entry.id === "nb-pref");
      assert.ok(factNeighbor, "fact neighbor 應存在");
      assert.strictEqual(prefNeighbor, undefined, "preference neighbor 應被排除");
    });

    // TC-18: 無 category 限制 → 允許所有 category 的 neighbor
    it("無 category 限制：所有 category 的 neighbor 都可進入", async () => {
      const entry1 = makeEntry("mem-1", "內文", "global", 0.5);
      entry1.category = "fact";
      const neighborFact = makeEntry("nb-fact", "事實鄰居", "global", 0.6);
      neighborFact.category = "fact";
      const neighborPref = makeEntry("nb-pref", "偏好鄰居", "global", 0.7);
      neighborPref.category = "preference";

      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          hasFtsSupport: false,
          async vectorSearch() {
            vsCall++;
            if (vsCall === 1) return [makeResult(entry1, 0.6)];
            return [makeResult(neighborFact, 0.55), makeResult(neighborPref, 0.65)];
          },
          async bm25Search() { return []; },
          async hasId() { return false; },
        },
        {
          async embedQuery() { return [0.1, 0.9]; },
        },
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true },
      );

      // 無 category
      const results = await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "auto-recall",
      });

      const factNeighbor = results.find(r => r.entry.id === "nb-fact");
      const prefNeighbor = results.find(r => r.entry.id === "nb-pref");
      assert.ok(factNeighbor, "fact neighbor 應存在");
      assert.ok(prefNeighbor, "preference neighbor 也應存在（無 category 限制）");
    });
  });

  describe("inactive 過濾", () => {

    // TC-19: inactive neighbor → 應被排除
    it("inactive neighbor → 排除該 neighbor（excludeInactive: true）", async () => {
      const entry1 = makeEntry("mem-1", "內文一", "global", 0.5);
      const activeNb = makeEntry("nb-active", "活躍鄰居", "global", 0.6);
      // inactive neighbor：設置 valid_from（與 timestamp 同時賦值）並設置 past invalidated_at
      // parseSmartMetadata: validFrom = entry.timestamp, invalidatedAt 需 >= validFrom 才保留
      // → 設 entry.timestamp 為 2 天前，invalidated_at 為 1 天前 → 過去式 → isMemoryActiveAt=false
      const inactiveNb = makeEntry("nb-inactive", "已停用鄰居", "global", 0.7);
      const twoDaysAgo = Date.now() - 2 * 86400000;
      inactiveNb.timestamp = twoDaysAgo;
      inactiveNb.metadata = JSON.stringify({ valid_from: twoDaysAgo, invalidated_at: Date.now() - 86400000 });

      let vsCall = 0;
      const retriever = new MemoryRetriever(
        {
          hasFtsSupport: false,
          async vectorSearch() {
            vsCall++;
            if (vsCall === 1) return [makeResult(entry1, 0.6)];
            return [makeResult(activeNb, 0.55), makeResult(inactiveNb, 0.65)];
          },
          async bm25Search() { return []; },
          async hasId() { return false; },
        },
        {
          async embedQuery() { return [0.1, 0.9]; },
        },
        { ...DEFAULT_RETRIEVAL_CONFIG, filterNoise: false, enableNeighborEnrichment: true },
      );

      const results = await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "auto-recall",
      });

      const activeResult = results.find(r => r.entry.id === "nb-active");
      const inactiveResult = results.find(r => r.entry.id === "nb-inactive");
      assert.ok(activeResult, "active neighbor 應存在");
      assert.strictEqual(inactiveResult, undefined, "inactive neighbor 應被排除");
    });
  });

  describe("整合：完整 enrichment 流程", () => {

    // E2E-1: 3 個結果 → 每個找鄰居 → 合併並重新排序
    it("3 個結果各找鄰居 → 合併並重新排序、去重", async () => {
      const entries = [
        makeEntry("mem-0", "內文 0", "global", 0.3),
        makeEntry("mem-1", "內文 1", "global", 0.5),
        makeEntry("mem-2", "內文 2", "global", 0.7),
      ];
      const neighbors = [
        makeEntry("nb-0", "鄰居 0", "global", 0.4),
        makeEntry("nb-1", "鄰居 1", "global", 0.6),
      ];

      const { retriever } = createMockRetriever({
        vectorSearchResults: [
          entries.map((e, i) => makeResult(e, 0.6 - i * 0.05)),
          [makeResult(neighbors[0], 0.55)],
          [makeResult(neighbors[1], 0.45)],
        ],
        embedQueryResults: [
          [0.1, 0.9], // query
          [0.1, 0.9], // mem-0
          [0.2, 0.8], // mem-1
          [0.3, 0.7], // mem-2
        ],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      const results = await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "auto-recall",
      });

      assert.ok(results.length >= 3, "至少要有原本的 3 筆結果");

      // 去重驗證
      const ids = results.map(r => r.entry.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(ids.length, uniqueIds.size, "所有 id 應唯一");

      // 排序驗證
      for (let i = 0; i < results.length - 1; i++) {
        assert.ok(
          results[i].effectiveScore >= results[i + 1].effectiveScore,
          `第 ${i} 筆 effectiveScore (${results[i].effectiveScore}) >= 第 ${i + 1} 筆 (${results[i + 1].effectiveScore})`
        );
      }
    });

    // E2E-2: cli source → 不執行 enrichment
    it("cli source：跳過 enrichment", async () => {
      const entry1 = makeEntry("mem-1", "內文一");

      const { retriever, getEqCallCount } = createMockRetriever({
        vectorSearchResults: [[makeResult(entry1, 0.6)]],
        embedQueryResults: [[0.1, 0.9]],
        config: { enableNeighborEnrichment: true },
        forceVectorOnly: true,
      });

      await retriever.retrieve({
        query: "內文",
        limit: 20,
        source: "cli",
      });

      assert.strictEqual(getEqCallCount(), 1, "cli source 只有 query embed，無 enrichment");
    });
  });
});

console.log("PR #461 Neighbor Enrichment 測試檔案已載入");
