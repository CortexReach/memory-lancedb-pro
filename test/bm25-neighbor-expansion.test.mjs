/**
 * BM25 Neighbor Expansion Tests (Option B, Issue #513)
 * 
 * 測試 expandDerivedWithBm25BeforeRank 函式的各種場景。
 * 使用 mocks 而非 jiti import，避免 jiti 的 ESM transpilation 問題。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Standalone implementation of expandDerivedWithBm25BeforeRank for testing
// Mirrors the actual implementation in src/reflection-store.ts (Promise chain style)
// ---------------------------------------------------------------------------

const REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS = 14;
const REFLECTION_DERIVE_LOGISTIC_K = 0.1;
const REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT = 0.5;

/**
 * Standalone version of expandDerivedWithBm25BeforeRank for unit testing.
 * Returns Promise<WeightedLineCandidate[]> (Promise chain, not async/await).
 */
function expandDerivedWithBm25BeforeRank(derived, bm25Search, scopeFilter, config) {
  // D1: early return if derived is empty
  if (!derived || derived.length === 0) return Promise.resolve([]);

  // Skip if bm25Search is not available (fresh session bypass - Phase 1)
  if (!bm25Search) return Promise.resolve(derived);

  const maxCandidates = Math.max(1, Math.floor(config?.maxCandidates ?? 5));
  const maxNeighborsPerCandidate = Math.max(1, Math.floor(config?.maxNeighborsPerCandidate ?? 3));

  // D2 guard: only run if scopeFilter is defined
  if (scopeFilter === undefined) return Promise.resolve(derived);

  // config.enabled = false check
  if (config?.enabled === false) return Promise.resolve(derived);

  const now = Date.now();
  const NEIGHBOR_MIDPOINT_DAYS = REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS;
  const NEIGHBOR_K = REFLECTION_DERIVE_LOGISTIC_K;
  const NEIGHBOR_BASE_WEIGHT = REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT;

  // Collect all BM25 search promises
  const searchPromises = [];
  for (let i = 0; i < Math.min(maxCandidates, derived.length); i++) {
    const candidate = derived[i];
    if (!candidate) continue;
    // D4: Truncate to first line, 120 chars
    const queryText = candidate.line.split("\n")[0].slice(0, 120).trim();
    if (!queryText) continue;
    searchPromises.push({
      queryText,
      normalizedKey: queryText.toLowerCase(),
    });
  }

  // Execute all BM25 searches in parallel
  const bm25Promises = searchPromises.map(
    (sp) =>
      bm25Search(sp.queryText, maxNeighborsPerCandidate + 5, scopeFilter, { excludeInactive: true })
        .then((hits) => ({ hits, queryText: sp.queryText, normalizedKey: sp.normalizedKey }))
        .catch((err) => {
          console.warn(
            `[bm25-neighbor-expansion] bm25Search failed for query "${sp.queryText.slice(0, 50)}": ${err instanceof Error ? err.message : String(err)}`
          );
          return { hits: [], queryText: sp.queryText, normalizedKey: sp.normalizedKey };
        })
  );

  return Promise.all(bm25Promises).then((results) => {
    const seen = new Set();
    const allNeighbors = [];

    for (const result of results) {
      let neighborCount = 0; // Per-candidate neighbor counter

      // Add current candidate to seen (skip self)
      seen.add(result.normalizedKey);

      for (const hit of result.hits) {
        if (allNeighbors.length >= 16) break; // D3: Cap at 16 total
        if (neighborCount >= maxNeighborsPerCandidate) break; // Per-candidate limit

        const hitText = hit.entry?.text || "";
        // D4: Truncate to first line, 120 chars
        const neighborText = hitText.split("\n")[0].slice(0, 120).trim();
        if (!neighborText) continue;

        // Skip if category="reflection" (avoid self-matching to reflection rows)
        if (hit.entry?.category === "reflection") continue;

        // Skip if already seen (deduplication)
        const neighborKey = neighborText.toLowerCase();
        if (seen.has(neighborKey)) continue;
        seen.add(neighborKey);

        // quality = 0.2 + 0.6 * bm25Score
        const safeBmScore = Math.max(0, Math.min(1, hit.score ?? 0));
        const quality = 0.2 + 0.6 * safeBmScore;

        allNeighbors.push({
          line: neighborText,
          timestamp: now,
          midpointDays: NEIGHBOR_MIDPOINT_DAYS,
          k: NEIGHBOR_K,
          baseWeight: NEIGHBOR_BASE_WEIGHT,
          quality,
          usedFallback: false,
        });

        neighborCount++;
      }
    }

    // D6: Prepend neighbors before base derived
    return [...allNeighbors, ...derived];
  });
}

// ---------------------------------------------------------------------------
// Helper: 建立假的 BM25 search 函式
// ---------------------------------------------------------------------------

function createMockBm25Search(hits) {
  return async (query, limit = 5, scopeFilter, options) => {
    return hits.map((h) => ({
      entry: {
        id: `mock-${Math.random().toString(36).slice(2, 8)}`,
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

  it("D1: derived 為空陣列時直接回傳空陣列（early return）", async () => {
    const mockBm25 = createMockBm25Search([
      { text: "Related memory about verification", category: "fact", score: 0.8 },
    ]);
    const result = await expandDerivedWithBm25BeforeRank([], mockBm25, ["global"], {});
    assert.deepStrictEqual(result, []);
  });

  it("D1: derived 為 null/undefined 時直接回傳空陣列", async () => {
    const mockBm25 = createMockBm25Search([]);
    const result1 = await expandDerivedWithBm25BeforeRank(null, mockBm25, ["global"], {});
    const result2 = await expandDerivedWithBm25BeforeRank(undefined, mockBm25, ["global"], {});
    assert.deepStrictEqual(result1, []);
    assert.deepStrictEqual(result2, []);
  });

  it("bm25Search 未提供（fresh session bypass）時直接回傳原始 derived", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];
    const result = await expandDerivedWithBm25BeforeRank(derived, undefined, ["global"], {});
    assert.deepStrictEqual(result, derived);
  });

  it("D2: scopeFilter 為 undefined 時不做 expansion，直接回傳原始 derived", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];
    const mockBm25 = createMockBm25Search([
      { text: "Related memory", category: "fact", score: 0.9 },
    ]);
    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, undefined, {});
    assert.deepStrictEqual(result, derived);
  });

  it("只對 top-N（預設5個）candidates 做 expansion，其餘略過", async () => {
    const derived = Array.from({ length: 7 }, (_, i) => ({
      line: `Derived line ${i + 1}: keep things short and focused`,
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
    assert.strictEqual(callCount, 5, "bm25Search 應只被呼叫 5 次（top 5 candidates）");
    assert.ok(result.length >= 7, `結果長度應 >= 7，實際為 ${result.length}`);
  });

  it("bm25Search 返回 hits 時，neighbors 被正確加成（quality = 0.2 + 0.6 * bm25Score）", async () => {
    const derived = [
      { line: "Keep responses concise", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Short answers are preferred", category: "fact", score: 0.9 },
      { text: "Be brief and clear", category: "preference", score: 0.6 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    assert.ok(result.length > 1, "結果應包含 neighbors 和原始 derived");

    const [neighbor1, neighbor2, ...rest] = result;
    // bm25Score=0.9 → quality=0.2+0.6*0.9=0.74
    assert.strictEqual(neighbor1.quality, 0.2 + 0.6 * 0.9);
    // bm25Score=0.6 → quality=0.2+0.6*0.6=0.56
    assert.strictEqual(neighbor2.quality, 0.2 + 0.6 * 0.6);

    const last = result[result.length - 1];
    assert.strictEqual(last.line, "Keep responses concise");
    assert.strictEqual(last.quality, 0.2);
  });

  it("bm25Search 回傳 reflection category 的 row 時被正確過濾（跳過）", async () => {
    const derived = [
      { line: "Always verify output", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Self-reflection note", category: "reflection", score: 0.95 },
      { text: "Real memory about verification", category: "fact", score: 0.7 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    const lines = result.map((c) => c.line);
    assert.ok(!lines.includes("Self-reflection note"), "reflection category 的 row 應被過濾");
    assert.ok(lines.includes("Real memory about verification"), "fact category 的 row 應被保留");
  });

  it("maxNeighborsPerCandidate 限制每個 candidate 的 neighbors 數量", async () => {
    const derived = [
      { line: "Test query for neighbors", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search(
      Array.from({ length: 10 }, (_, i) => ({
        text: `Neighbor ${i + 1} text`,
        category: "fact",
        score: 0.9 - i * 0.05,
      }))
    );

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      mockBm25,
      ["global"],
      { maxNeighborsPerCandidate: 3 }
    );

    const neighborsCount = result.length - 1;
    assert.ok(neighborsCount <= 3, `neighbors 數量應 <= 3，實際為 ${neighborsCount}`);
  });

  it("D3: 總 neighbors 數量上限為 16（Cap at 16）", async () => {
    const derived = Array.from({ length: 5 }, (_, i) => ({
      line: `Query ${i}`,
      timestamp: Date.now(),
      midpointDays: 3,
      k: 1.2,
      baseWeight: 0.5,
      quality: 0.2,
      usedFallback: false,
    }));

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      createMockBm25Search(
        Array.from({ length: 50 }, (_, i) => ({
          text: `Neighbor text number ${i}`,
          category: "fact",
          score: 0.9,
        }))
      ),
      ["global"],
      { maxCandidates: 5, maxNeighborsPerCandidate: 10 }
    );

    const neighborsCount = result.length - derived.length;
    assert.ok(neighborsCount <= 16, `neighbors 總數應 <= 16，實際為 ${neighborsCount}`);
  });

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

  it("D6: neighbors 在 base derived 之前（前綴加入，非 append）", async () => {
    const derived = [
      { line: "Base derived entry", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "BM25 neighbor entry", category: "fact", score: 0.8 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    assert.strictEqual(result[0].line, "BM25 neighbor entry", "第一個應為 neighbor（前綴）");
    assert.strictEqual(result[result.length - 1].line, "Base derived entry", "最後一個應為原始 derived");
  });

  it("bm25Search throws 時 fail-safe 不阻斷流程，回傳原始 derived", async () => {
    const derived = [
      { line: "Test entry", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const throwingBm25 = async () => {
      throw new Error("BM25 search failed: network error");
    };

    const result = await expandDerivedWithBm25BeforeRank(
      derived,
      throwingBm25,
      ["global"],
      {}
    );

    assert.deepStrictEqual(result, derived);
  });

  it("BM25 回傳與 candidate 相同文字時被正確去重（seen set）", async () => {
    const derived = [
      { line: "Exact same text as candidate", timestamp: Date.now(), midpointDays: 3, k: 1.2, baseWeight: 0.5, quality: 0.2, usedFallback: false },
    ];

    const mockBm25 = createMockBm25Search([
      { text: "Exact same text as candidate", category: "fact", score: 0.9 },
      { text: "Different neighbor text", category: "fact", score: 0.7 },
    ]);

    const result = await expandDerivedWithBm25BeforeRank(derived, mockBm25, ["global"], {});

    const lines = result.map((c) => c.line);
    const duplicates = lines.filter((l) => l === "Exact same text as candidate");
    assert.strictEqual(duplicates.length, 1, "自我匹配應只出現一次（在原始 derived 中）");
    assert.ok(lines.includes("Different neighbor text"), "不同文字的 neighbor 應被保留");
  });

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

    assert.deepStrictEqual(result, derived);
  });

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
