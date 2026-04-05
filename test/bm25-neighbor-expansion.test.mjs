/**
 * BM25 Neighbor Expansion Tests (Option B, Issue #513)
 *
 * 測試 expandDerivedWithBm25BeforeRank 函式的各種場景。
 * 此為單元測試（而非整合測試），不依賴實際的 LanceDB store。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

// 載入待測試的 expandDerivedWithBm25BeforeRank 函式
const {
  expandDerivedWithBm25BeforeRank,
} = jiti("../src/reflection-store.ts");

// ---------------------------------------------------------------------------
// Helper: 建立假的 BM25 search 函式（每次呼叫都重新創建 hits 陣列）
// ---------------------------------------------------------------------------

/**
 * 建立一個可控的 mock bm25Search 函式。
 * 每次呼叫都返回獨立的 hits 陣列拷貝，避免多個測試之間的狀態污染。
 *
 * @param {Array<{text: string, category: string, score: number}>} hitsTemplate
 * 每次呼叫時，會複製此陣列並為每個 entry 生成隨機 id
 */
function createMockBm25Search(hitsTemplate) {
  return async (query, limit = 5, scopeFilter, options) => {
    // 每次呼叫都返回獨立的拷貝（避免 shared state 問題）
    return hitsTemplate.map((h, idx) => ({
      entry: {
        id: `mock-${Math.random().toString(36).slice(2, 8)}-${idx}`,
        text: h.text,
        vector: [],
        category: h.category,
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      },
      score: h.score,
    }));
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("expandDerivedWithBm25BeforeRank", () => {

  // -------------------------------------------------------------------------
  // D1: derived 為空陣列 → 直接回傳空陣列（early return）
  // -------------------------------------------------------------------------
  it("D1: derived 為空陣列時直接回傳空陣列（early return）", async () => {
    const mockBm25 = createMockBm25Search([
      { text: "Related memory about verification", category: "fact", score: 0.8 },
    ]);
    const result = await expandDerivedWithBm25BeforeRank([], mockBm25, ["global"], {});
    assert.deepStrictEqual(result, []);
  });

  it("D1: derived 為 null/undefined 時直接回傳空陣列", async () => {
    const mockBm25 = createMockBm25Search([]);
    // @ts-ignore - 傳入 null 測試防御
    const result = await expandDerivedWithBm25BeforeRank(null, mockBm25, ["global"], {});
    assert.deepStrictEqual(result, []);
  });

  // -------------------------------------------------------------------------
  // Phase 1 bypass: bm25Search 未提供時直接回傳原始 derived
  // -------------------------------------------------------------------------
  it("bm25Search 未提供（fresh session bypass）時直接回傳原始 derived", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];
    const result = await expandDerivedWithBm25BeforeRank(derived, undefined, ["global"], {});
    assert.deepStrictEqual(result, derived);
  });

  // -------------------------------------------------------------------------
  // D2: scopeFilter 為 undefined 時不做 expansion
  // -------------------------------------------------------------------------
  it("D2: scopeFilter 為 undefined 時不做 expansion，直接回傳原始 derived", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];
    const mockBm25 = createMockBm25Search([
      { text: "Related memory", category: "fact", score: 0.9 },
    ]);
    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, undefined, {});
    // Should return original without expansion
    assert.deepStrictEqual(result, derived);
  });

  // -------------------------------------------------------------------------
  // derived 有多個 candidates → 只對 top-N expansion（預設5個）
  // -------------------------------------------------------------------------
  it("只對 top-N（預設5個）candidates 做 expansion，其餘略過", async () => {
    // 建立 7 個 candidates（超過預設 maxCandidates=5）
    const derived = Array.from({ length: 7 }, (_, idx) => ({
      line: `Derived line ${idx + 1}: keep things short and focused`,
      timestamp: Date.now(),
      midpointDays: 3,
      k: 1.2,
      baseWeight: 0.5,
      quality: 0.2,
      usedFallback: false,
    }));

    let callCount = 0;
    const countingBm25 = async (query) => {
      callCount++;
      return [
        {
          entry: {
            id: `hit-${callCount}`,
            text: `BM25 neighbor for query: ${query.slice(0, 20)}`,
            vector: [],
            category: "fact",
            scope: "global",
            importance: 0.7,
            timestamp: Date.now(),
            metadata: "{}",
          },
          score: 0.8,
        },
      ];
    };

    const result = await expandDerivedWithBm25BeforeRank(derived, countingBm25, ["global"], {});

    // 只應該對 top 5 做 expansion（前5個 candidates）
    assert.strictEqual(callCount, 5, "bm25Search 應只被呼叫 5 次（top 5 candidates）");

    // 結果應包含 neighbors（前綴）+ 原始 7 個 derived
    assert.ok(result.length >= 7, `結果長度應 >= 7，實際為 ${result.length}`);
  });

  // -------------------------------------------------------------------------
  // bm25Search 返回 hits → neighbors 被正確加成（乘法加成 quality）
  // -------------------------------------------------------------------------
  it("bm25Search 返回 hits 時，neighbors 被正確加成（quality = 0.2 + 0.6 * bm25Score）", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Short answers are preferred", category: "fact", score: 0.9 },  // high BM25
      { text: "Be brief and clear", category: "preference", score: 0.6 },       // medium BM25
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    // 結果應該有 neighbors（前綴）+ 原始 derived
    assert.ok(result.length > 1, "結果應包含 neighbors 和原始 derived");

    // 前兩個應該是 neighbors（prepended，按 BM25 score 順序）
    const [neighbor1, neighbor2, ...rest] = result;

    // Neighbors 的 quality 應反映 BM25 score
    // bm25Score=0.9 → quality=0.2+0.6*0.9=0.74
    assert.strictEqual(neighbor1.quality, 0.2 + 0.6 * 0.9, "高 BM25 score 的 neighbor quality 應為 0.74");
    // bm25Score=0.6 → quality=0.2+0.6*0.6=0.56
    assert.strictEqual(neighbor2.quality, 0.2 + 0.6 * 0.6, "中 BM25 score 的 neighbor quality 應為 0.56");

    // 最後一個應該是原始 derived
    const last = result[result.length - 1];
    assert.strictEqual(last.line, "Keep responses concise");
    assert.strictEqual(last.quality, 0.2); // 原始 quality
  });

  // -------------------------------------------------------------------------
  // bm25Search 包含 reflection category → 被正確過濾
  // -------------------------------------------------------------------------
  it("bm25Search 回傳 reflection category 的 row 時被正確過濾（跳過）", async () => {
    const derived = [
      { line: "Always verify output", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Self-reflection note", category: "reflection", score: 0.95 }, // 應被過濾
      { text: "Real memory about verification", category: "fact", score: 0.7 },  // 應被保留
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    // 結果應只包含 fact category 的 neighbor，不包含 reflection category
    const lines = result.map((c) => c.line);
    assert.ok(!lines.includes("Self-reflection note"), "reflection category 的 row 應被過濾");
    assert.ok(lines.includes("Real memory about verification"), "fact category 的 row 應被保留");
  });

  // -------------------------------------------------------------------------
  // maxNeighborsPerCandidate 限制 → 正確截斷
  // -------------------------------------------------------------------------
  it("maxNeighborsPerCandidate 限制每個 candidate 的 neighbors 數量", async () => {
    const derived = [
      { line: "Test query for neighbors", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    // BM25 返回 10 個 hits（超過 maxNeighborsPerCandidate=3）
    const mockBm25 = createMockBm25Search(
      Array.from({ length: 10 }, (_, idx) => ({
        text: `Neighbor ${idx + 1} text`,
        category: "fact",
        score: 0.9 - idx * 0.05,
      }))
    );

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      mockBm25,
      ["global"],
      { maxNeighborsPerCandidate: 3 }
    );

    // 結果應只包含最多 3 個 neighbors（+ 原始 derived = 4 total）
    // 由於 maxNeighborsPerCandidate=3，BM25 hits 有 10 個，但我們內部只取前 3 個
    const neighborsCount = result.length - 1; // -1 是原始 derived
    assert.strictEqual(neighborsCount, 3, `neighbors 數量應為 3，實際為 ${neighborsCount}`);
  });

  // -------------------------------------------------------------------------
  // D3: Cap at 16 total → 正確截斷
  // -------------------------------------------------------------------------
  it("D3: 總 neighbors 數量上限為 16（Cap at 16）", async () => {
    const derived = Array.from({ length: 5 }, (_, idx) => ({
      line: `Query ${idx}`,
      timestamp: Date.now(),
      midpointDays: 3,
      k: 1.2,
      baseWeight: 0.5,
      quality: 0.2,
      usedFallback: false,
    }));

    // 每個 BM25 hit 都會返回 5 個 neighbors
    const mockBm25 = createMockBm25Search(
      Array.from({ length: 5 }, (_, idx) => ({
        text: `Neighbor text number ${idx}`,
        category: "fact",
        score: 0.9,
      }))
    );

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      mockBm25,
      ["global"],
      { maxCandidates: 5, maxNeighborsPerCandidate: 10 }
    );

    // 理論上 5 candidates × 5 neighbors = 25，但 D3 cap at 16
    // 所以結果應為 min(25, 16) + 5 derived = 21 total
    // 實際上 neighbors 最多 16 個
    const neighborsCount = result.length - derived.length;
    assert.ok(neighborsCount <= 16, `neighbors 總數應 <= 16，實際為 ${neighborsCount}`);
  });

  // -------------------------------------------------------------------------
  // D4: Truncate to first line, 120 chars
  // -------------------------------------------------------------------------
  it("D4: neighbor text 截斷為第一行，最多 120 字元", async () => {
    const derived = [
      { line: "Test line", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const longText = "First line of text\nSecond line of text that should be truncated\nThird line also truncated";

    const mockBm25 = createMockBm25Search([
      { text: longText, category: "fact", score: 0.8 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    const neighbor = result[0];
    assert.strictEqual(neighbor.line, "First line of text", "應只取第一行");
    assert.ok(neighbor.line.length <= 120, `長度應 <= 120，實際為 ${neighbor.line.length}`);
  });

  // -------------------------------------------------------------------------
  // D6: Neighbors before base derived（prepend 而非 append）
  // -------------------------------------------------------------------------
  it("D6: neighbors 在 base derived 之前（前綴加入，非 append）", async () => {
    const derived = [
      { line: "Base derived entry", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "BM25 neighbor entry", category: "fact", score: 0.8 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    // 第一個應該是 neighbor（prepended）
    assert.strictEqual(result[0].line, "BM25 neighbor entry", "第一個應為 neighbor（前綴）");
    // 最後一個應該是原始 derived
    assert.strictEqual(result[result.length - 1].line, "Base derived entry", "最後一個應為原始 derived");
  });

  // -------------------------------------------------------------------------
  // bm25Search throws → fail-safe 不阻斷（catch + log，不 throw）
  // -------------------------------------------------------------------------
  it("bm25Search throws 時 fail-safe 不阻斷流程，回傳原始 derived", async () => {
    const derived = [
      { line: "Test entry", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const throwingBm25 = async () => {
      throw new Error("BM25 search failed: network error");
    };

    // 不應 throw，即使 bm25Search 失敗
    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      // @ts-ignore
      throwingBm25,
      ["global"],
      {}
    );

    // 應回傳原始 derived（expansion 失敗但流程繼續）
    assert.deepStrictEqual(result, derived);
  });

  // -------------------------------------------------------------------------
  // 自我匹配過濾（seen set）
  // -------------------------------------------------------------------------
  it("BM25 回傳與 candidate 相同文字時被正確去重（seen set）", async () => {
    const derived = [
      { line: "Exact same text as candidate", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Exact same text as candidate", category: "fact", score: 0.9 }, // 完全相同 → 應被跳過
      { text: "Different neighbor text", category: "fact", score: 0.7 },         // 不同 → 應被保留
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    // "Exact same text as candidate" 應被跳過（seen set 去重）
    // 只應保留 "Different neighbor text"
    const lines = result.map((c) => c.line);
    const duplicates = lines.filter((l) => l === "Exact same text as candidate");
    assert.strictEqual(duplicates.length, 1, "自我匹配應只出現一次（在原始 derived 中）");
    assert.ok(lines.includes("Different neighbor text"), "不同文字的 neighbor 應被保留");
  });

  // -------------------------------------------------------------------------
  // config.enabled = false 時不做 expansion
  // -------------------------------------------------------------------------
  it("config.enabled = false 時不做 expansion", async () => {
    const derived = [
      { line: "Test entry", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Should not appear", category: "fact", score: 0.9 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      mockBm25,
      ["global"],
      { enabled: false }
    );

    // enabled: false 時，bm25Search 不應被呼叫，結果應為原始 derived
    assert.deepStrictEqual(result, derived);
  });

  // -------------------------------------------------------------------------
  // quality 邊界測試（bm25Score 為 0 或 1）
  // -------------------------------------------------------------------------
  it("bm25Score 為 0 時 quality = 0.2（最小值）", async () => {
    const derived = [
      { line: "Test query", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Low relevance text", category: "fact", score: 0.0 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});
    assert.strictEqual(result[0].quality, 0.2, "bm25Score=0 時 quality 應為 0.2");
  });

  it("bm25Score 為 1 時 quality = 0.8（最大值）", async () => {
    const derived = [
      { line: "Test query", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "High relevance text", category: "fact", score: 1.0 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});
    assert.strictEqual(result[0].quality, 0.8, "bm25Score=1 時 quality 應為 0.8");
  });

  // -------------------------------------------------------------------------
  // 自訂 maxCandidates 和 maxNeighborsPerCandidate
  // -------------------------------------------------------------------------
  it("自訂 maxCandidates=2 只對 top 2 candidates 做 expansion", async () => {
    const derived = [
      { line: "First candidate query", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
      { line: "Second candidate query", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
      { line: "Third candidate query", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    let callCount = 0;
    const countingBm25 = async (query) => {
      callCount++;
      return [
        {
          entry: {
            id: `hit-${callCount}`,
            text: `Neighbor for ${query.slice(0, 15)}`,
            vector: [],
            category: "fact",
            scope: "global",
            importance: 0.7,
            timestamp: Date.now(),
            metadata: "{}",
          },
          score: 0.8,
        },
      ];
    };

    await expandDerivedWithBm25BeforeRank(
      derived,
      countingBm25,
      ["global"],
      { maxCandidates: 2 }
    );

    assert.strictEqual(callCount, 2, "maxCandidates=2 時 bm25Search 應只被呼叫 2 次");
  });

});
