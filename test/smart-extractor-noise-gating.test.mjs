/**
 * Regression tests for the noise-bank learning gate.
 *
 * extractCandidates() can come back with zero candidates for four different
 * reasons: the LLM/gateway call failed outright, the response had an
 * unexpected shape, the LLM genuinely returned an empty memories list, or
 * every parsed candidate was dropped/demoted by local validation. ONLY the
 * genuinely-empty list is a real "nothing to remember" signal. Failures must
 * not train the bank (gateway outages would poison it), and a
 * validation-emptied batch must not either: the model DID find candidates
 * there, so teaching the bank "this conversation is noise" would pre-filter
 * similar real content away from future extractions.
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
      if (behavior && typeof behavior === "object" && behavior.raw) return behavior.raw;
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

    assert.deepEqual(stats, { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 });
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

  it("does NOT learn noise when validation drops every parsed candidate (policy verdict, not a noise signal)", async () => {
    const noiseBank = makeNoiseBank();
    const logs = [];
    // "hi" is a valid category but fails the length>=5 abstract check, so the
    // parsed response is well-formed yet every candidate is filtered out. The
    // model DID emit a candidate, so the conversation must not train the bank.
    const llm = makeLlm([{ category: "preferences", abstract: "hi", overview: "", content: "" }]);
    const extractor = makeExtractor(makeEmbedder(), llm, makeStore(), { noiseBank, log: (msg) => logs.push(msg) });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 0, "a validation-emptied batch must not train the noise bank");
    assert.ok(
      logs.some((msg) => msg.includes("skipping noise-bank learning (validation emptied the batch")),
      "the skip must be visible at the standard log level",
    );
  });

  it("does NOT learn noise when the batch contradiction check demotes every candidate", async () => {
    const noiseBank = makeNoiseBank();
    // Mixed-register batch with a constructed sibling: the real-tagged durable
    // is demoted by the batch contradiction check, the constructed one is
    // dropped by grounding enforcement. Raw output had 2 candidates, so the
    // conversation (which contains real facts the policy demoted) must not be
    // fed to the noise bank as a noise exemplar.
    const llm = makeLlm({
      raw: {
        conversation_register: "mixed",
        memories: [
          { category: "preferences", abstract: "User loves space operas", overview: "- pref", content: "", grounding: "real" },
          { category: "events", abstract: "The captain hid the artifact", overview: "- event", content: "", grounding: "constructed" },
        ],
      },
    });
    const extractor = makeExtractor(makeEmbedder(), llm, makeStore(), { noiseBank });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    assert.equal(noiseBank.learnCalls.length, 0, "a demotion-emptied batch must not train the noise bank");
  });

  it("logs the batch contradiction demotion at the standard log level, with count and register", async () => {
    const noiseBank = makeNoiseBank();
    const logs = [];
    const llm = makeLlm({
      raw: {
        conversation_register: "mixed",
        memories: [
          { category: "preferences", abstract: "User loves space operas", overview: "- pref", content: "", grounding: "real" },
          { category: "events", abstract: "The captain hid the artifact", overview: "- event", content: "", grounding: "constructed" },
        ],
      },
    });
    const extractor = makeExtractor(makeEmbedder(), llm, makeStore(), { noiseBank, log: (msg) => logs.push(msg) });

    await extractor.extractAndPersist("some conversation text", "s1");
    await flushMicrotasks();

    const demotionLine = logs.find((msg) => msg.includes("batch contradiction demoted"));
    assert.ok(demotionLine, "a fully-demoted batch must be distinguishable from 'model found nothing' without debug logging");
    assert.ok(demotionLine.includes("1"), "the demotion line must carry the demoted count");
    assert.ok(demotionLine.includes("mixed"), "the demotion line must carry the batch register");
  });
});
