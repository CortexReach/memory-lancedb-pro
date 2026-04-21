import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeExtractor(scopeFilters) {
  const store = {
    async vectorSearch(_vector, _limit, _minScore, scopeFilter) {
      scopeFilters.push(scopeFilter);
      return [];
    },
    async store() {},
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
              abstract: "饮品偏好：乌龙茶",
              overview: "## Preference\n- 喜欢乌龙茶",
              content: "用户喜欢乌龙茶。",
            },
          ],
        };
      }
      throw new Error(`unexpected mode: ${mode}`);
    },
  };

  return new SmartExtractor(store, embedder, llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
  });
}

describe("SmartExtractor scopeFilter semantics", () => {
  it("defaults to the target scope when scopeFilter is omitted", async () => {
    const seen = [];
    const extractor = makeExtractor(seen);

    await extractor.extractAndPersist("用户喜欢乌龙茶。", "session-1", {
      scope: "agent:test",
    });

    assert.deepStrictEqual(seen, [["agent:test"]]);
  });

  it("preserves an explicit undefined scopeFilter for bypass callers", async () => {
    const seen = [];
    const extractor = makeExtractor(seen);

    await extractor.extractAndPersist("用户喜欢乌龙茶。", "session-2", {
      scope: "agent:test",
      scopeFilter: undefined,
    });

    assert.deepStrictEqual(seen, [undefined]);
  });

  it("preserves an explicit empty scopeFilter array as deny-all", async () => {
    const seen = [];
    const extractor = makeExtractor(seen);

    await extractor.extractAndPersist("用户喜欢乌龙茶。", "session-3", {
      scope: "agent:test",
      scopeFilter: [],
    });

    assert.deepStrictEqual(seen, [[]]);
  });

  it("passes through an explicit non-empty scopeFilter array", async () => {
    const seen = [];
    const extractor = makeExtractor(seen);

    await extractor.extractAndPersist("用户喜欢乌龙茶。", "session-4", {
      scope: "agent:test",
      scopeFilter: ["custom:foo"],
    });

    assert.deepStrictEqual(seen, [["custom:foo"]]);
  });
});
