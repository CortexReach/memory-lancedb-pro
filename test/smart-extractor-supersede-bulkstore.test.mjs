import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

function makeVector(seed) {
  return Array.from({ length: 8 }, (_, index) => seed + index / 100);
}

function makeExistingPreference() {
  const text = "Preferred drink is oolong tea";
  return {
    id: "old-pref-1",
    text,
    vector: makeVector(0.1),
    category: "preference",
    scope: "agent:test",
    importance: 0.8,
    timestamp: 1,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "preference", importance: 0.8 },
        {
          l0_abstract: text,
          l1_overview: "The user prefers oolong tea.",
          l2_content: text,
          memory_category: "preferences",
          tier: "working",
          confidence: 0.8,
          fact_key: "preferences:drink",
        },
      ),
    ),
  };
}

function makeExtractor(store) {
  const candidate = {
    category: "preferences",
    abstract: "Preferred drink is coffee",
    overview: "The user prefers coffee.",
    content: "The user now prefers coffee as their daily drink.",
  };

  const embedder = {
    async embed() {
      return makeVector(0.2);
    },
    async embedBatch(texts) {
      return texts.map(() => makeVector(0.2));
    },
  };

  const llm = {
    async completeJson(_prompt, mode) {
      if (mode === "extract-candidates") {
        return { memories: [candidate] };
      }
      if (mode === "dedup-decision") {
        return {
          decision: "supersede",
          reason: "newer preference replaces older preference",
          match_index: 1,
        };
      }
      if (mode === "dedup-decision-batch") {
        return {
          results: [
            {
              index: 1,
              decision: "supersede",
              reason: "newer preference replaces older preference",
              match_index: 1,
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
    defaultScope: "agent:test",
    log() {},
    debugLog() {},
  });
}

describe("SmartExtractor SUPERSEDE batch create path", () => {
  it("queues the superseding entry for bulkStore and invalidates the old record after creation", async () => {
    const existing = makeExistingPreference();
    const calls = [];

    const store = {
      async vectorSearch(_vector, _limit, _minScore, scopeFilter, options) {
        calls.push({ method: "vectorSearch", scopeFilter, options });
        return [{ entry: existing, score: 0.98 }];
      },
      async getById(id, scopeFilter) {
        calls.push({ method: "getById", id, scopeFilter });
        return id === existing.id ? existing : null;
      },
      async store() {
        calls.push({ method: "store" });
        throw new Error("store.store() should not be called in batch context");
      },
      async bulkStore(entries) {
        calls.push({ method: "bulkStore", entries });
        return entries.map((entry, index) => ({
          ...entry,
          id: `new-pref-${index + 1}`,
          timestamp: 2 + index,
        }));
      },
      async update(id, patch, scopeFilter) {
        calls.push({ method: "update", id, patch, scopeFilter });
        if (id === existing.id && patch.metadata) {
          existing.metadata = patch.metadata;
        }
        return existing;
      },
    };

    const extractor = makeExtractor(store);
    const stats = await extractor.extractAndPersist(
      "The user says their preferred drink is now coffee.",
      "session-676",
      { scope: "agent:test" },
    );

    const storeCalls = calls.filter((call) => call.method === "store");
    const bulkCalls = calls.filter((call) => call.method === "bulkStore");
    const updateCalls = calls.filter((call) => call.method === "update");

    assert.equal(storeCalls.length, 0, "SUPERSEDE existing-found must not call store.store() when batching");
    assert.equal(bulkCalls.length, 1, "superseding entry should be written through the batch bulkStore path");
    assert.equal(bulkCalls[0].entries.length, 1, "batch should contain the new superseding entry");
    assert.equal(updateCalls.length, 1, "old record should still be invalidated");
    assert.deepEqual(updateCalls[0].scopeFilter, ["agent:test"]);

    const newMeta = parseSmartMetadata(bulkCalls[0].entries[0].metadata, bulkCalls[0].entries[0]);
    assert.equal(newMeta.supersedes, existing.id);
    assert.equal(newMeta.fact_key, "preferences:drink");

    const oldMeta = parseSmartMetadata(existing.metadata, existing);
    assert.equal(oldMeta.superseded_by, "new-pref-1");
    assert.ok(oldMeta.invalidated_at, "old record should be marked invalidated");
    assert.equal(oldMeta.fact_key, "preferences:drink");

    assert.equal(stats.created, 1);
    assert.equal(stats.superseded, 1);
  });
});
