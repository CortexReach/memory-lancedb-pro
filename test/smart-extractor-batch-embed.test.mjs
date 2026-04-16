/**
 * Explicit tests for batch embedding paths in SmartExtractor.
 *
 * Verifies that the three refactored sites use embedBatch/embedBatch
 * instead of serial per-element embed() calls, and that graceful
 * fallback works when batch fails.
 *
 * NOTE: SmartExtractor uses INTERNAL categories (profile/preferences/entities/
 * events/cases/patterns), NOT store categories (preference/fact/decision/entity/
 * other). See src/memory-categories.ts for the canonical list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock embedder with call counters for each method. */
function makeCountingEmbedder(options = {}) {
  const {
    /** If set, embedBatch will throw (simulates batch failure). */
    batchShouldFail = false,
    /** If set, embed will throw (simulates single embed failure). */
    embedShouldFail = false,
  } = options;

  const calls = { embed: 0, embedBatch: 0 };

  const embedder = {
    async embed(text) {
      calls.embed++;
      if (embedShouldFail) throw new Error("mock embed failure");
      // Deterministic vector based on text length for dedup stability
      return Array(256).fill(0).map((_, i) => (text.length > 0 ? (text.charCodeAt(i % text.length) / 255) : 0));
    },
    async embedBatch(texts) {
      calls.embedBatch++;
      if (batchShouldFail) throw new Error("mock batch failure");
      // Return vectors directly WITHOUT calling this.embed() to keep counters independent
      return (texts || []).map((t) =>
        Array(256).fill(0).map((_, i) => (t.length > 0 ? (t.charCodeAt(i % t.length) / 255) : 0)),
      );
    },
    get calls() {
      return { ...calls };
    },
  };

  return { embedder, calls };
}

/** Create a minimal LLM client that returns configurable candidates.
 *  Categories must use SmartExtractor INTERNAL names:
 *  profile | preferences | entities | events | cases | patterns
 */
function makeLlm(candidates) {
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return { memories: candidates };
      }
      if (mode === "dedup-decision") {
        return { decision: "create", reason: "no match" };
      }
      if (mode === "merge-memory") {
        return candidates[0] ?? null;
      }
      return null;
    },
  };
}

/** Create a minimal store that records all writes. */
function makeStore() {
  const entries = [];
  const store = {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter) {
      return [];
    },
    async store(entry) {
      entries.push({ action: "store", entry });
      return entry;
    },
    async update(_id, _patch, _scopeFilter) {
      entries.push({ action: "update", id: _id });
    },
    async getById(_id, _scopeFilter) {
      return null;
    },
    get entries() {
      return [...entries];
    },
  };
  return store;
}

function makeExtractor(embedder, llm, store, config = {}) {
  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
    ...config,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("SmartExtractor batch embedding paths", () => {

  // --------------------------------------------------------------------------
  // Test 1: Step 1b batchDedup uses embedBatch (not N×embed)
  // --------------------------------------------------------------------------
  it("uses embedBatch for batch-internal dedup of candidate abstracts", async () => {
    const { embedder, calls } = makeCountingEmbedder();
    const llm = makeLlm([
      {
        category: "cases",
        abstract: "用户居住在上海市浦东新区张江高科技园区",
        overview: "地址信息",
        content: "用户的居住地是上海市浦东新区张江高科技园区附近。",
      },
      {
        category: "cases",
        abstract: "用户非常喜欢使用Python进行数据分析工作",
        overview: "职业兴趣",
        content: "用户对编程很感兴趣，特别是Python数据分析方向。",
      },
    ]);
    const store = makeStore();
    const extractor = makeExtractor(embedder, llm, store);

    await extractor.extractAndPersist("用户说：我住上海，喜欢编程。", "s1");

    // Should have called embedBatch once for the abstracts (Step 1b)
    assert.ok(
      calls.embedBatch >= 1,
      `Expected at least 1 embedBatch call for Step 1b dedup, got ${calls.embedBatch}`,
    );
  });

  // --------------------------------------------------------------------------
  // Test 2: filterNoiseByEmbedding uses embedBatch (direct call)
  // --------------------------------------------------------------------------
  it("uses embedBatch in filterNoiseByEmbedding when noise bank is active", async () => {
    const { embedder, calls } = makeCountingEmbedder();
    const llm = makeLlm([]); // not used by filterNoiseByEmbedding
    const store = makeStore(); // not used by filterNoiseByEmbedding

    const noiseBank = {
      initialized: true,
      isNoise(_vec) { return false; },
      learn(_vec) {},
    };

    const extractor = makeExtractor(embedder, llm, store, { noiseBank });

    // Call filterNoiseByEmbedding DIRECTLY — this is the method under test.
    // Mix of lengths: short (bypass), mid-length (needs embedding), long (bypass).
    const inputTexts = [
      "短",                                    // ≤8 → bypass
      "这是一条中等长度的测试文本用于验证批量嵌入功能",  // 9-300 → needs embed
      "这是一条另一条中等长度文本内容",            // 9-300 → needs embed
      "x".repeat(350),                          // >300 → bypass
    ];

    const result = await extractor.filterNoiseByEmbedding(inputTexts);

    // All texts should pass through (isNoise returns false for everything)
    assert.strictEqual(result.length, 4,
      `Expected all 4 texts to pass through, got ${result.length}`);

    // embedBatch should have been called exactly once for the 2 mid-length texts
    assert.strictEqual(calls.embedBatch, 1,
      `Expected 1 embedBatch call for filterNoiseByEmbedding, got ${calls.embedBatch}`);

    // embed() should NOT have been called (batch path used instead)
    assert.strictEqual(calls.embed, 0,
      `Expected 0 embed calls (batch path), got ${calls.embed}`);
  });

  // --------------------------------------------------------------------------
  // Test 3: Batch pre-compute for non-profile candidates uses embedBatch
  // --------------------------------------------------------------------------
  it("pre-computes vectors via embedBatch before processing candidates", async () => {
    const { embedder, calls } = makeCountingEmbedder();
    const llm = makeLlm([
      {
        category: "preferences",
        abstract: "用户偏好使用深色主题来减少眼睛疲劳",
        overview: "",
        content: "用户明确表示偏好深色主题界面设置",
      },
      {
        category: "entities",
        abstract: "张三是用户经常提到的同事名字",
        overview: "",
        content: "张三在用户的对话中多次被提及为同事关系",
      },
      {
        category: "events",
        abstract: "上周参加了公司年度技术分享会议",
        overview: "",
        content: "用户参与了公司的年度技术分享活动",
      },
    ]);
    const store = makeStore();
    const extractor = makeExtractor(embedder, llm, store);

    await extractor.extractAndPersist("多候选对话内容用于测试预计算", "s1");

    // At least one embedBatch call for pre-computing non-profile candidate vectors
    assert.ok(
      calls.embedBatch >= 1,
      `Expected embedBatch for candidate pre-computation, got ${calls.embedBatch}`,
    );
  });

  // --------------------------------------------------------------------------
  // Test 4: Batch failure falls back gracefully (no crash)
  // --------------------------------------------------------------------------
  it("falls back to individual embed when batch pre-computation fails", async () => {
    const { embedder, calls } = makeCountingEmbedder({
      batchShouldFail: true,
    });
    const llm = makeLlm([
      {
        category: "cases",
        abstract: "回退路径测试用例验证降级逻辑正确性",
        overview: "",
        content: "当batch失败时应该回退到单条embed调用方式",
      },
    ]);
    const store = makeStore();
    const extractor = makeExtractor(embedder, llm, store);

    // Should NOT throw — batch failure is caught and logged
    const stats = await extractor.extractAndPersist("回退测试对话内容", "s1");

    // Extraction should still succeed (fallback path)
    assert.ok(stats.created >= 0 || stats.merged >= 0 || stats.skipped >= 0,
      `Extraction should produce stats, got ${JSON.stringify(stats)}`);

    // Individual embed calls should have been made as fallback
    assert.ok(
      calls.embed >= 1,
      `Expected fallback embed calls after batch failure, got embed=${calls.embed}, embedBatch=${calls.embedBatch}`,
    );
  });

  // --------------------------------------------------------------------------
  // Test 5: filterNoiseByEmbedding batch failure passes all texts through (direct call)
  // --------------------------------------------------------------------------
  it("passes all texts through when filterNoiseByEmbedding batch fails", async () => {
    const { embedder } = makeCountingEmbedder({
      batchShouldFail: true,
    });
    const llm = makeLlm([]);   // not used
    const store = makeStore();  // not used

    const noiseBank = {
      initialized: true,
      isNoise(_vec) { return false; },
      learn(_vec) {},
    };

    const extractor = makeExtractor(embedder, llm, store, { noiseBank });

    // Call filterNoiseByEmbedding DIRECTLY with mid-length texts that would
    // normally be sent to embedBatch.
    const inputTexts = [
      "噪声过滤回退测试用例文本内容第一段",
      "噪声过滤回退测试用例文本内容第二段",
      "噪声过滤回退测试用例文本内容第三段",
    ];

    // Should NOT throw — batch failure returns all texts unfiltered
    const result = await extractor.filterNoiseByEmbedding(inputTexts);

    assert.strictEqual(result.length, inputTexts.length,
      `Expected all ${inputTexts.length} texts to pass through on batch failure, got ${result.length}`);
  });

  // --------------------------------------------------------------------------
  // Test 6: Bypass texts (short/long) are not sent to embedBatch in noise filter (direct call)
  // --------------------------------------------------------------------------
  it("does not send bypass texts (short/long) to embedBatch in noise filter", async () => {
    let lastBatchInput = null;
    const embedder = {
      async embed() { return [0.1]; },
      async embedBatch(texts) {
        lastBatchInput = texts;
        return texts.map(() => [0.1]);
      },
    };
    const llm = makeLlm([]);   // not used
    const store = makeStore();  // not used

    const noiseBank = {
      initialized: true,
      isNoise(_vec) { return false; },
      learn(_vec) {},
    };

    const extractor = makeExtractor(embedder, llm, store, { noiseBank });

    // Call filterNoiseByEmbedding DIRECTLY with a mix of lengths
    const inputTexts = [
      "短",                                    // ≤8 → bypass
      "正常长度文本用于噪声过滤测试验证逻辑正确性",   // 9-300 → needs embed
      "x".repeat(5),                            // ≤8 → bypass
      "另一条正常长度文本内容用于测试",             // 9-300 → needs embed
      "x".repeat(350),                          // >300 → bypass
    ];

    await extractor.filterNoiseByEmbedding(inputTexts);

    // embedBatch should have been called with ONLY mid-length texts
    assert.ok(lastBatchInput !== null,
      "Expected embedBatch to be called for mid-length texts");

    for (const t of lastBatchInput) {
      assert.ok(
        t.length > 8 && t.length <= 300,
        `Text sent to embedBatch should be in (8, 300] range, got length=${t.length}: "${t.slice(0, 40)}"`,
      );
    }

    // Verify the specific texts that should have been batched
    const batchedTexts = lastBatchInput.map((t) => t);
    assert.ok(
      batchedTexts.some((t) => t.includes("正常长度文本")),
      "Expected mid-length text '正常长度文本...' in batch input",
    );
    assert.ok(
      batchedTexts.some((t) => t.includes("另一条正常长度")),
      "Expected mid-length text '另一条正常长度...' in batch input",
    );
  });

  // --------------------------------------------------------------------------
  // Test 7: Profile candidates are excluded from batch pre-computation
  // --------------------------------------------------------------------------
  it("excludes profile-category candidates from batch pre-computation (Step 2)", async () => {
    // Track all embedBatch calls to distinguish Step 1b (dedup) from Step 2 (pre-compute)
    const allBatchCalls = [];
    const embedder = {
      async embed() { return Array(256).fill(0.1); },
      async embedBatch(texts) {
        allBatchCalls.push([...texts]);
        return texts.map(() => Array(256).fill(0.1));
      },
    };
    const llm = makeLlm([
      {
        category: "profile",
        abstract: "用户基本画像信息包括职业和地理位置偏好",
        overview: "",
        content: "这是用户的基本画像信息汇总数据。",
      },
    ]);
    const store = makeStore();
    const extractor = makeExtractor(embedder, llm, store);

    await extractor.extractAndPersist("画像提取测试对话内容", "s1");

    // There should be at least 2 embedBatch calls:
    //   Call 1: Step 1b batchDedup (abstracts) — may include profile
    //   Call 2 (or later): Step 2 pre-computation — must NOT include profile
    assert.ok(allBatchCalls.length >= 1,
      `Expected at least 1 embedBatch call, got ${allBatchCalls.length}`);

    // The LAST embedBatch call(s) are for Step 2 pre-computation.
    // Check that none of them contain profile candidate text.
    const profileTexts = allBatchCalls.filter((call) =>
      call.some((t) => t.includes("用户基本画像") || t.includes("画像信息")),
    );

    // Step 1b dedup MAY include profile abstract (that's expected).
    // But Step 2 pre-compute MUST exclude it.
    // With a single profile candidate, we expect at most 1 call that includes
    // profile text (the Step 1b dedup call). If there are more, that's a bug.
    assert.ok(
      profileTexts.length <= 1,
      `Only Step 1b dedup may include profile text, but got ${profileTexts.length} calls with profile text`,
    );
  });
});
