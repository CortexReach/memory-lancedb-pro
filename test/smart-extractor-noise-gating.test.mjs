/**
 * Regression tests for the noise-bank learning gate.
 *
 * extractCandidates() can come back with zero candidates for four different
 * reasons: the LLM/gateway call failed outright, the response had an
 * unexpected shape, the LLM genuinely returned an empty memories list, or
 * every parsed candidate was dropped by local validation. Only the latter
 * two are a real "nothing to remember" signal — the first two are failures
 * that must NOT be fed into the noise-prototype bank, or gateway outages
 * silently poison future extraction/recall.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

// ============================================================================
// Helpers
// ============================================================================

function makeEmbedder() {
  return {
    async embed(text) {
      return Array(8).fill(0).map((_, i) => (text.length > 0 ? (text.charCodeAt(i % text.length) / 255) : 0));
    },
    async embedBatch(texts) {
      return (texts || []).map(() => Array(8).fill(0.1));
    },
  };
}

/** `behavior` controls what the mocked "extract-candidates" LLM call returns. */
function makeLlm(behavior) {
  return {
    async completeJson(_prompt, mode) {
      if (mode !== "extract-candidates") return null;
      if (behavior === "llm_failure") return null;
      if (behavior === "malformed_missing") return { notMemories: "oops" };
      if (behavior === "malformed_non_array") return { memories: "not-an-array" };
      if (behavior === "empty") return { memories: [] };
      if (Array.isArray(behavior)) return { memories: behavior };
      throw new Error(`unsupported test behavior: ${behavior}`);
    },
  };
}

function makeStore() {
  return {
    async vectorSearch() { return []; },
    async store(entry) { return entry; },
    async bulkStore(entries) { return entries; },
    async update() {},
    async getById() { return null; },
  };
}

function makeNoiseBank() {
  const learnCalls = [];
  return {
    initialized: true,
    isNoise() { return false; },
    learn(vec) { learnCalls.push(vec); },
    get learnCalls() { return learnCalls; },
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

/** learnAsNoise() is fire-and-forget from extractAndPersist(); flush pending microtasks. */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// Tests
// ============================================================================

describe("SmartExtractor noise-bank learning gate", () => {
  it("does not learn noise when the LLM/gateway call fails outright (null response)", async () => {
    const noiseBank = makeNoiseBank();
    const extractor = makeExtractor(makeEmbedder(), makeLlm("llm_failure"), makeStore(), { noiseBank });

    const stats = await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.deepEqual(stats, { created: 0, merged: 0, skipped: 0, boundarySkipped: 0, extractionFailed: true });
    assert.equal(noiseBank.learnCalls.length, 0, "gateway/model failure must not train the noise bank");
  });

  it("does not learn noise when the response is missing the memories array", async () => {
    const noiseBank = makeNoiseBank();
    const extractor = makeExtractor(makeEmbedder(), makeLlm("malformed_missing"), makeStore(), { noiseBank });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 0, "malformed shape must not train the noise bank");
  });

  it("does not learn noise when memories is present but not an array", async () => {
    const noiseBank = makeNoiseBank();
    const extractor = makeExtractor(makeEmbedder(), makeLlm("malformed_non_array"), makeStore(), { noiseBank });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 0, "malformed shape must not train the noise bank");
  });

  it("learns noise when the LLM genuinely returns an empty memories list", async () => {
    const noiseBank = makeNoiseBank();
    const extractor = makeExtractor(makeEmbedder(), makeLlm("empty"), makeStore(), { noiseBank });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 1, "a genuine empty list is a real noise signal");
  });

  it("learns noise when every parsed candidate is dropped by local validation", async () => {
    const noiseBank = makeNoiseBank();
    // "hi" is a valid category but fails the length>=5 abstract check, so the
    // parsed response is well-formed yet every candidate is filtered out.
    const llm = makeLlm([{ category: "preferences", abstract: "hi", overview: "", content: "" }]);
    const extractor = makeExtractor(makeEmbedder(), llm, makeStore(), { noiseBank });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 1, "a validly-parsed-but-empty-after-filtering result is still a real noise signal");
  });
});
