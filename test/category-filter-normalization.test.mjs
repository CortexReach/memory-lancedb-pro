import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  matchesMemoryCategoryFilter,
  normalizeCategory,
  resolveCategoryFilterCandidates,
} = jiti("../src/memory-categories.ts");
const { createRetriever } = jiti("../src/retriever.ts");

function buildResult(id, category) {
  return {
    entry: {
      id,
      text: `${category} memory about coffee`,
      vector: [0.1, 0.2, 0.3],
      category,
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    },
    score: 0.9,
  };
}

describe("category filter normalization", () => {
  it("maps legacy singular category filters to smart-extractor categories", () => {
    assert.equal(normalizeCategory("preference"), "preferences");
    assert.equal(normalizeCategory("entity"), "entities");
    assert.equal(matchesMemoryCategoryFilter("preferences", "preference"), true);
    assert.equal(matchesMemoryCategoryFilter("preference", "preferences"), true);
    assert.equal(matchesMemoryCategoryFilter("other", "preferences"), false);
    assert.deepEqual(
      resolveCategoryFilterCandidates("preference"),
      ["preference", "preferences"],
    );
  });

  it("applies normalized category filters during retrieval", async () => {
    const retriever = createRetriever(
      {
        hasFtsSupport: true,
        async refreshFtsSupport() {
          return true;
        },
        async vectorSearch() {
          return [];
        },
        async bm25Search() {
          return [
            buildResult("smart-preference", "preferences"),
            buildResult("event", "events"),
          ];
        },
        async hasId() {
          return true;
        },
      },
      {
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
      },
      { rerank: "none", hardMinScore: 0, filterNoise: false },
    );

    const results = await retriever.retrieve({
      query: "coffee",
      limit: 5,
      category: "preference",
      source: "manual",
    });

    assert.deepEqual(results.map((result) => result.entry.id), ["smart-preference"]);
  });
});
