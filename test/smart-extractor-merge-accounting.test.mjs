/**
 * Rider 1: processCandidate's merge-path stats accounting must be truthful.
 *
 * handleMerge has three real outcomes: a genuine merge (store.update
 * succeeds), a read-failure fallback (existing row unreadable, candidate
 * stored as a new entry instead), and an LLM failure (the merge-memory
 * completion comes back null/unparseable, nothing persisted, the existing
 * row is left untouched). Only the first should count as `stats.merged`.
 *
 * NOTE: SmartExtractor uses INTERNAL categories (profile/preferences/entities/
 * events/cases/patterns), NOT store categories. "preferences" is one of
 * MERGE_SUPPORTED_CATEGORIES (src/memory-categories.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function makeEmbedder() {
  return {
    async embed(text) {
      return Array(8).fill(0).map((_, i) => (text.length > 0 ? (text.charCodeAt(i % text.length) / 255) : 0));
    },
    async embedBatch(texts) {
      return (texts || []).map((t) =>
        Array(8).fill(0).map((_, i) => (t.length > 0 ? (t.charCodeAt(i % t.length) / 255) : 0)),
      );
    },
  };
}

const EXISTING_ENTRY = {
  id: "existing-preference-1",
  text: "User likes tea",
  category: "preferences",
  metadata: JSON.stringify({
    l0_abstract: "User likes tea",
    l1_overview: "## Preference\n- tea",
    l2_content: "User mentioned liking tea",
    memory_category: "preferences",
  }),
  vector: [0.1, 0.2, 0.3],
  timestamp: Date.now(),
};

function makeStore({ getByIdThrows = false } = {}) {
  const updates = [];
  return {
    async vectorSearch() {
      return [{ entry: EXISTING_ENTRY, score: 0.95 }];
    },
    async store(entry) {
      return entry;
    },
    async bulkStore(batchEntries) {
      return batchEntries;
    },
    async update(id, patch, scopeFilter) {
      updates.push({ id, patch, scopeFilter });
    },
    async getById() {
      if (getByIdThrows) throw new Error("mock getById failure");
      return EXISTING_ENTRY;
    },
    get updates() {
      return [...updates];
    },
  };
}

function makeLlm({ dedupDecision = "merge", mergeSucceeds = true }) {
  return {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return {
          memories: [
            {
              category: "preferences",
              abstract: "User now also likes jasmine tea",
              overview: "## Preference\n- tea\n- jasmine tea",
              content: "User said they also like jasmine tea now",
            },
          ],
        };
      }
      if (mode === "dedup-decision" || mode === "dedup-decision-batch") {
        const verdict = { decision: dedupDecision, match_index: 1, reason: "extends existing tea preference" };
        return mode === "dedup-decision-batch" ? { results: [{ index: 1, ...verdict }] } : verdict;
      }
      if (mode === "merge-memory-batch") {
        if (!mergeSucceeds) return null;
        return {
          results: [
            {
              index: 1,
              abstract: "User likes tea, including jasmine tea",
              overview: "## Preference\n- tea\n- jasmine tea",
              content: "User likes tea generally and jasmine tea specifically",
            },
          ],
        };
      }
      if (mode === "merge-memory") {
        if (!mergeSucceeds) return null;
        return {
          abstract: "User likes tea, including jasmine tea",
          overview: "## Preference\n- tea\n- jasmine tea",
          content: "User likes tea generally and jasmine tea specifically",
        };
      }
      return null;
    },
  };
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

describe("SmartExtractor merge-path stats accounting", () => {
  it("counts a genuinely persisted merge in stats.merged", async () => {
    const store = makeStore();
    const llm = makeLlm({ mergeSucceeds: true });
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("user likes jasmine tea too", "s-merge-ok");

    assert.equal(stats.merged, 1, "a real merge (store.update called) should count as merged");
    // handleMerge issues two store.update calls on a full success: the merge
    // content itself, then a best-effort support-stats update on the same row.
    assert.equal(store.updates.length, 2);
  });

  it("does not count a merge-LLM failure as merged: nothing was persisted", async () => {
    const store = makeStore();
    const llm = makeLlm({ mergeSucceeds: false });
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("user likes jasmine tea too", "s-merge-llm-failed");

    assert.equal(stats.merged, 0, "merge LLM returning null must not be counted as a persisted merge");
    assert.equal(store.updates.length, 0, "no store.update should have been issued");
  });

  it("does not count a getById-read failure (fallback create) as merged", async () => {
    const store = makeStore({ getByIdThrows: true });
    const llm = makeLlm({ mergeSucceeds: true });
    const extractor = makeExtractor(makeEmbedder(), llm, store);

    const stats = await extractor.extractAndPersist("user likes jasmine tea too", "s-merge-read-failed");

    assert.equal(stats.merged, 0, "a read failure that falls back to create must not be counted as merged");
    assert.equal(stats.created, 1, "the fallback path stores a new entry, so it should count as created");
  });
});
