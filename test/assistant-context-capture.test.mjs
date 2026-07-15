/**
 * Regression tests for the assistant-context-capture middle mode.
 *
 * `captureAssistant` gains a third value, "context": assistant turns are
 * included in the extraction prompt as clearly marked, non-extractable
 * context (disambiguation only) without becoming capture-eligible — they
 * must never count toward extractMinMessages eligibility or the auto-capture
 * watermark (autoCaptureSeenTextCount). `true` and `false` keep byte-identical
 * semantics.
 *
 * Fixtures are entirely synthetic — no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");
const { parsePluginConfig } = jiti("../index.ts");

// ============================================================================
// Helpers (same pattern as extraction-grounding-register.test.mjs)
// ============================================================================

function hashToIndex(text, dims) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h % dims;
}

function makeEmbedder(dims = 97) {
  const embed = async (text) => {
    const v = new Array(dims).fill(0);
    v[hashToIndex(text || "", dims)] = 1;
    return v;
  };
  return {
    embed,
    async embedBatch(texts) {
      return Promise.all((texts || []).map((t) => embed(t)));
    },
  };
}

function makeStore() {
  return {
    async vectorSearch() { return []; },
    async bulkStore(entries) { return entries; },
    async update() {},
    async getById() { return null; },
  };
}

/** Mock LLM that records every prompt+system pair it receives, keyed by label. */
function makeRecordingLlm() {
  const calls = [];
  return {
    calls,
    async completeJson(prompt, label, systemPrompt) {
      calls.push({ prompt, label, systemPrompt });
      if (label === "extract-candidates") {
        return { memories: [] };
      }
      return null;
    },
  };
}

function makeExtractor(llm, config = {}) {
  return new SmartExtractor(makeStore(), makeEmbedder(), llm, {
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
// SmartExtractor: assistant-context lines in the assembled prompt
// ============================================================================

describe("SmartExtractor assistant-context marking", () => {
  it("includes assistant context lines, plainly labeled, inside the single conversation transcript when assistantContextTexts is provided", async () => {
    const llm = makeRecordingLlm();
    const extractor = makeExtractor(llm);

    await extractor.extractAndPersist(
      "yes exactly, that one",
      "s1",
      { assistantContextTexts: ["I found two options: the blue mug and the red mug."] },
    );

    const extractCall = llm.calls.find((c) => c.label === "extract-candidates");
    assert.ok(extractCall, "extract-candidates call should have happened");
    assert.match(extractCall.prompt, /## Recent conversation turns/);
    assert.match(extractCall.prompt, /Assistant: I found two options: the blue mug and the red mug\./);
    assert.match(extractCall.prompt, /blue mug and the red mug/);
  });

  it("has no Assistant: line in the transcript when assistantContextTexts is absent", async () => {
    const llm = makeRecordingLlm();
    const extractor = makeExtractor(llm);

    await extractor.extractAndPersist("some ordinary message", "s1");

    const extractCall = llm.calls.find((c) => c.label === "extract-candidates");
    assert.ok(extractCall);
    assert.doesNotMatch(extractCall.prompt, /\nAssistant: /);
  });

  it("has no Assistant: line in the transcript when assistantContextTexts is an empty array", async () => {
    const llm = makeRecordingLlm();
    const extractor = makeExtractor(llm);

    await extractor.extractAndPersist("some ordinary message", "s1", { assistantContextTexts: [] });

    const extractCall = llm.calls.find((c) => c.label === "extract-candidates");
    assert.doesNotMatch(extractCall.prompt, /\nAssistant: /);
  });

  it("buildExtractionPrompt documents the assistant-context rule (structural check)", () => {
    const prompt = buildExtractionPrompt("some conversation", "test-user");
    assert.match(prompt, /"Assistant:" lines/);
    assert.match(prompt, /grounded in a user-authored line/i);
  });

  it("renders the conversation transcript under a single header with a description, exactly once", async () => {
    const llm = makeRecordingLlm();
    const extractor = makeExtractor(llm);

    await extractor.extractAndPersist(
      "some message",
      "s1",
      { assistantContextTexts: ["some context"] },
    );

    const extractCall = llm.calls.find((c) => c.label === "extract-candidates");
    const headerMatches = extractCall.prompt.match(/## Recent conversation turns/g) || [];
    assert.equal(headerMatches.length, 1, "the header must appear exactly once");
    assert.match(
      extractCall.prompt,
      /## Recent conversation turns\nContext for extraction\. Extract memory candidates ONLY from user turns\. Assistant turns are included so you can resolve references and understand what the user meant; never treat assistant statements as the user's facts, preferences, or decisions\.\n/,
    );
  });

  it("interleaves explicit conversationTurns oldest-first, using the configured user label", async () => {
    const llm = makeRecordingLlm();
    const extractor = makeExtractor(llm, { user: "Alex" });

    await extractor.extractAndPersist(
      "unused-fallback-text",
      "s1",
      {
        conversationTurns: [
          { role: "user", text: "my name is Alex" },
          { role: "assistant", text: "nice to meet you, Alex" },
          { role: "user", text: "yes exactly, that one" },
        ],
      },
    );

    const extractCall = llm.calls.find((c) => c.label === "extract-candidates");
    assert.match(
      extractCall.prompt,
      /Alex: my name is Alex\nAssistant: nice to meet you, Alex\nAlex: yes exactly, that one/,
    );
  });
});

// ============================================================================
// index.ts: parsePluginConfig captureAssistant normalization (config back-compat)
// ============================================================================

const BASE_EMBEDDING_CONFIG = { embedding: { apiKey: "test-key", model: "nomic-embed-text" } };

describe("parsePluginConfig captureAssistant normalization", () => {
  it("normalizes true to true (unchanged)", () => {
    const cfg = parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: true });
    assert.equal(cfg.captureAssistant, true);
  });

  it("normalizes false to false (unchanged)", () => {
    const cfg = parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: false });
    assert.equal(cfg.captureAssistant, false);
  });

  it("normalizes an omitted value to false (unchanged default)", () => {
    const cfg = parsePluginConfig({ ...BASE_EMBEDDING_CONFIG });
    assert.equal(cfg.captureAssistant, false);
  });

  it("normalizes 'context' to the literal 'context'", () => {
    const cfg = parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: "context" });
    assert.equal(cfg.captureAssistant, "context");
  });

  it("normalizes any other unrecognized value to false (fail safe, matching legacy boolean coercion)", () => {
    assert.equal(parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: "yes" }).captureAssistant, false);
    assert.equal(parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: 1 }).captureAssistant, false);
    assert.equal(parsePluginConfig({ ...BASE_EMBEDDING_CONFIG, captureAssistant: null }).captureAssistant, false);
  });
});
