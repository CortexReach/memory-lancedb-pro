import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  MEMORY_CATEGORIES,
  getStorageCategoryForMemoryCategory,
  resolveToolMemoryCategory,
} = jiti("../src/memory-categories.ts");

// This pins the single source of truth src/memory-categories.ts's
// SMART_TO_STORAGE_CATEGORY map is meant to protect: every SmartExtractor write
// (via mapToStoreCategory -> getStorageCategoryForMemoryCategory) and every CLI/tool
// write (via resolveToolMemoryCategory) must agree on the same 6-category mapping, so
// a future edit to one consumer can't silently drift from the other.
describe("getStorageCategoryForMemoryCategory (smart-to-storage category map)", () => {
  it("maps every one of the 6 memory categories to its documented legacy storage category", () => {
    const expected = {
      profile: "fact",
      preferences: "preference",
      entities: "entity",
      events: "decision",
      cases: "fact",
      patterns: "other",
    };
    for (const category of MEMORY_CATEGORIES) {
      assert.equal(
        getStorageCategoryForMemoryCategory(category),
        expected[category],
        `unexpected storage category for "${category}"`,
      );
    }
  });

  it("never returns the extractor-only \"reflection\" storage category", () => {
    // SmartStorageCategory deliberately excludes "reflection" (minted only by the
    // reflection writer) - a category map that included it would let SmartExtractor
    // writes be misclassified as if the reflection subsystem produced them.
    for (const category of MEMORY_CATEGORIES) {
      assert.notEqual(getStorageCategoryForMemoryCategory(category), "reflection");
    }
  });

  it("agrees with resolveToolMemoryCategory's storageCategory for every memory category", () => {
    // resolveToolMemoryCategory is the CLI/tool-facing consumer of the same mapping;
    // it must stay in lockstep with getStorageCategoryForMemoryCategory (the
    // extractor-facing consumer) for every category, which is this PR's whole point.
    for (const category of MEMORY_CATEGORIES) {
      const { storageCategory } = resolveToolMemoryCategory(category);
      assert.equal(storageCategory, getStorageCategoryForMemoryCategory(category));
    }
  });
});
