import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  parseBrandItemPreference,
  inferAtomicBrandItemPreferenceSlot,
  normalizePreferenceToken,
} = jiti("../src/preference-slots.ts");

// ---------------------------------------------------------------------------
// parseBrandItemPreference
// ---------------------------------------------------------------------------

test("parseBrandItemPreference: Chinese single-item", () => {
  const result = parseBrandItemPreference("喜欢麦当劳的麦辣鸡翅");
  assert.ok(result);
  assert.equal(result.brand, "麦当劳");
  assert.deepEqual(result.items, ["麦辣鸡翅"]);
  assert.equal(result.aggregate, false);
});

test("parseBrandItemPreference: Chinese aggregate (multiple items)", () => {
  const result = parseBrandItemPreference("喜欢麦当劳的麦旋风、鸡翅和鸡腿堡");
  assert.ok(result);
  assert.equal(result.brand, "麦当劳");
  assert.ok(result.items.length > 1);
  assert.equal(result.aggregate, true);
});

test("parseBrandItemPreference: Chinese verb variants", () => {
  for (const verb of ["爱吃", "偏爱", "常吃", "想吃"]) {
    const result = parseBrandItemPreference(`${verb}麦当劳的薯条`);
    assert.ok(result, `should parse with verb "${verb}"`);
    assert.equal(result.brand, "麦当劳");
  }
});

test("parseBrandItemPreference: English pattern", () => {
  const result = parseBrandItemPreference("I love fries from McDonald's");
  assert.ok(result);
  assert.equal(result.brand, "mcdonald's");
  assert.ok(result.items.length >= 1);
});

test("parseBrandItemPreference: non-preference text returns null", () => {
  assert.equal(parseBrandItemPreference("今天天气不错"), null);
  assert.equal(parseBrandItemPreference("Hello world"), null);
  assert.equal(parseBrandItemPreference("记住我的地址是北京"), null);
});

test("parseBrandItemPreference: stops at reason clause", () => {
  const result = parseBrandItemPreference("喜欢麦当劳的薯条因为很好吃");
  assert.ok(result);
  assert.deepEqual(result.items, ["薯条"]);
  assert.equal(result.aggregate, false);
});

// ---------------------------------------------------------------------------
// inferAtomicBrandItemPreferenceSlot
// ---------------------------------------------------------------------------

test("inferAtomicBrandItemPreferenceSlot: single item returns slot", () => {
  const slot = inferAtomicBrandItemPreferenceSlot("喜欢麦当劳的麦辣鸡翅");
  assert.ok(slot);
  assert.equal(slot.type, "brand-item");
  assert.equal(slot.brand, "麦当劳");
  assert.equal(slot.item, "麦辣鸡翅");
});

test("inferAtomicBrandItemPreferenceSlot: aggregate returns null", () => {
  const slot = inferAtomicBrandItemPreferenceSlot("喜欢麦当劳的麦旋风、鸡翅和鸡腿堡");
  assert.equal(slot, null);
});

test("inferAtomicBrandItemPreferenceSlot: non-preference returns null", () => {
  assert.equal(inferAtomicBrandItemPreferenceSlot("今天天气不错"), null);
});

// ---------------------------------------------------------------------------
// normalizePreferenceToken
// ---------------------------------------------------------------------------

test("normalizePreferenceToken: strips punctuation and lowercases", () => {
  assert.equal(normalizePreferenceToken("  McDonald's!  "), "mcdonald's");
  assert.equal(normalizePreferenceToken("\u201C麦辣鸡翅\u201D"), "麦辣鸡翅");
});

// ---------------------------------------------------------------------------
// normalizePreferenceToken: English article stripping
// ---------------------------------------------------------------------------

test("normalizePreferenceToken: strips English articles (the/a/an)", () => {
  assert.equal(normalizePreferenceToken("the Big Mac"), "bigmac");
  assert.equal(normalizePreferenceToken("Big Mac"), "bigmac");
  assert.equal(normalizePreferenceToken("a Whopper"), "whopper");
  assert.equal(normalizePreferenceToken("an Egg McMuffin"), "eggmcmuffin");
});

// ---------------------------------------------------------------------------
// Dedup guard integration: SmartExtractor preference-slot guard behavior
// ---------------------------------------------------------------------------

const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeGuardExtractor({ vectorSearchResults, onDedupCalled }) {
  const stored = [];
  const store = {
    async vectorSearch() {
      return vectorSearchResults;
    },
    async store(entry) {
      stored.push(entry);
    },
  };
  const embedder = {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
  };
  const llm = {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: [
            {
              category: "preferences",
              abstract: "食品偏好：麦当劳麦辣鸡翅",
              overview: "## Preference\n- 喜欢麦当劳的麦辣鸡翅",
              content: "喜欢麦当劳的麦辣鸡翅",
            },
          ],
        };
      }
      if (mode === "dedup-decision") {
        onDedupCalled();
        return { decision: "create", reason: "LLM fallback" };
      }
      if (mode === "merge-memory") {
        return { merged: "merged text" };
      }
      throw new Error("unexpected mode: " + mode);
    },
  };
  return {
    extractor: new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
    }),
    stored,
  };
}

test("dedup guard: same brand different item -> force create, skip LLM", async () => {
  let dedupCalled = false;
  const { extractor } = makeGuardExtractor({
    vectorSearchResults: [
      {
        entry: {
          id: "existing-1",
          text: "喜欢麦当劳的薯条",
          category: "preference",
          scope: "global",
          importance: 0.8,
          timestamp: Date.now(),
          metadata: JSON.stringify({ memory_category: "preferences" }),
        },
        score: 0.85,
      },
    ],
    onDedupCalled: () => { dedupCalled = true; },
  });

  await extractor.extractAndPersist("喜欢麦当劳的麦辣鸡翅", "session-1", {
    scope: "global",
  });

  assert.equal(dedupCalled, false, "LLM dedup should NOT be called when preference-slot guard triggers");
});

test("dedup guard: same brand same item -> falls through to LLM", async () => {
  let dedupCalled = false;
  const { extractor } = makeGuardExtractor({
    vectorSearchResults: [
      {
        entry: {
          id: "existing-1",
          text: "喜欢麦当劳的麦辣鸡翅",
          category: "preference",
          scope: "global",
          importance: 0.8,
          timestamp: Date.now(),
          metadata: JSON.stringify({ memory_category: "preferences" }),
        },
        score: 0.85,
      },
    ],
    onDedupCalled: () => { dedupCalled = true; },
  });

  await extractor.extractAndPersist("喜欢麦当劳的麦辣鸡翅", "session-2", {
    scope: "global",
  });

  assert.equal(dedupCalled, true, "LLM dedup SHOULD be called when same brand same item");
});

test("dedup guard: non-preference category -> skips guard, goes to LLM", async () => {
  let dedupCalled = false;
  const store = {
    async vectorSearch() {
      return [{
        entry: {
          id: "existing-1",
          text: "用户住在北京",
          category: "fact",
          scope: "global",
          importance: 0.8,
          timestamp: Date.now(),
          metadata: JSON.stringify({ memory_category: "entities" }),
        },
        score: 0.85,
      }];
    },
    async store() {},
  };
  const embedder = {
    async embed() { return [0.1, 0.2, 0.3]; },
  };
  const llm = {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: [{
            category: "entities",
            abstract: "用户喜欢北京烤鸭",
            overview: "## Entity\n- 住在上海",
            content: "用户喜欢北京烤鸭",
          }],
        };
      }
      if (mode === "dedup-decision") {
        dedupCalled = true;
        return { decision: "create", reason: "different location" };
      }
      if (mode === "merge-memory") {
        return { merged: "merged" };
      }
      throw new Error("unexpected mode: " + mode);
    },
  };

  const extractor = new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
  });

  await extractor.extractAndPersist("用户住在上海", "session-3", {
    scope: "global",
  });

  assert.equal(dedupCalled, true, "LLM dedup should be called for non-preference categories");
});
