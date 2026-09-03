/**
 * Regression test for the auto-capture watermark after a successful smart
 * extraction, in history-carrying sessions.
 *
 * Two auto-capture flows share the autoCaptureSeenTextCount counter:
 *
 * - Ingress flow (message_received feeds pendingIngressTexts; each agent_end
 *   carries only the newest message): the counter is a pure accumulator of
 *   new texts toward extractMinMessages. Resetting it to 0 after a
 *   successful extraction is the intended windowing behavior (issue #417
 *   Fix #9), pinned by the counter-reset scenario in
 *   test/smart-extractor-branches.mjs.
 *
 * - History flow (agent_end delivers the WHOLE session message history each
 *   turn, no ingress feed): the counter doubles as the slice cursor into
 *   that history. Resetting it to 0 after a successful extraction made the
 *   NEXT turn re-read and re-extract the entire history: repeated LLM cost
 *   and repeated admission/dedup rolls over already-extracted content.
 *
 * This suite covers the history flow: after a successful extraction, the
 * next capture must see only the delta.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
// The embedding mock below returns one-hot vectors, which can land arbitrary
// texts near noise prototypes; force the bank off for determinism.
const { NoisePrototypeBank } = jiti("../src/noise-prototypes.ts");
NoisePrototypeBank.prototype.isNoise = () => false;

const EMBEDDING_DIMENSIONS = 64;

function hashToIndex(text, dims) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h % dims;
}

function oneHot(text) {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[hashToIndex(text || "", EMBEDDING_DIMENSIONS)] = 1;
  return v;
}

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((input, index) => ({ object: "embedding", index, embedding: oneHot(String(input)) })),
      model: payload.model || "mock-embedding-model",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
}

/**
 * LLM mock: records every extract-candidates prompt, answers each with one
 * distinct memory (distinct abstracts embed to distinct one-hot vectors, so
 * dedup never matches and every extraction creates).
 */
function createLlmServer(extractionPrompts) {
  let calls = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");
    if (prompt.includes("## Recent Conversation")) {
      extractionPrompts.push(prompt);
      extractionPrompts.messages = payload.messages;
    }
    calls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "mock-memory-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            memories: [{
              category: "preferences",
              abstract: `Synthetic preference marker number ${calls}`,
              overview: `## Preference\n- Marker ${calls}`,
              content: `User stated synthetic preference marker number ${calls}.`,
            }],
          }),
        },
      }],
    }));
  });
}

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = { info: [], warn: [], debug: [] };
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.info.push(String(message)); },
      warn(message) { logs.warn.push(String(message)); },
      debug(message) { logs.debug.push(String(message)); },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(eventName, handler, opts) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta: opts });
      eventHandlers.set(eventName, list);
    },
  };
  return { api, eventHandlers, logs };
}

function getAutoCaptureHook(eventHandlers) {
  const hooks = eventHandlers.get("agent_end") || [];
  assert.ok(hooks.length >= 1, "expected at least one agent_end handler");
  return hooks[0].handler;
}

async function fireAgentEnd(hook, messages, ctx) {
  hook({ success: true, messages }, ctx);
  const run = hook.__lastRun;
  assert.ok(run && typeof run.then === "function", "expected a background capture run");
  await run;
}

function userMessages(...texts) {
  return texts.map((text) => ({ role: "user", content: text }));
}

const TURN_1_TEXTS = [
  "I keep my synthetic dotfiles in a bare repository named quartz.",
  "My preferred terminal font is a synthetic monospace called Duckspace.",
];
const TURN_2_TEXTS = [
  "For synthetic backups I rotate three encrypted drives weekly.",
  "My synthetic editor theme of choice is called Marmalade Night.",
];

describe("auto-capture watermark after successful extraction (history flow)", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-watermark-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("the capture after a successful extraction sees only the new texts, not the whole history", async () => {
    const embeddingPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 2,
        extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
        sessionCompression: { enabled: false },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        embedding: {
          apiKey: "test-api-key",
          model: "mock-embedding-model",
          baseURL: `http://127.0.0.1:${embeddingPort}/v1`,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        llm: {
          apiKey: "test-api-key",
          model: "mock-memory-model",
          baseURL: `http://127.0.0.1:${llmPort}`,
        },
      },
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:dave:main", agentId: "dave" };

    // Turn 1: agent_end carries the full history so far (2 texts).
    // cumulative=2 >= minMessages=2 -> extraction runs and succeeds.
    await fireAgentEnd(hook, userMessages(...TURN_1_TEXTS), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");
    assert.ok(
      extractionPrompts[0].includes(TURN_1_TEXTS[0]),
      "turn 1 extraction must see the turn 1 texts",
    );

    // Turn 2: agent_end again carries the FULL history (turn 1 + turn 2 texts).
    await fireAgentEnd(hook, userMessages(...TURN_1_TEXTS, ...TURN_2_TEXTS), ctx);
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract the delta");
    const secondPrompt = extractionPrompts[1];
    assert.ok(
      secondPrompt.includes(TURN_2_TEXTS[0]) && secondPrompt.includes(TURN_2_TEXTS[1]),
      "turn 2 extraction must see the new texts",
    );
    for (const alreadyExtracted of TURN_1_TEXTS) {
      assert.ok(
        !secondPrompt.includes(alreadyExtracted),
        `turn 2 extraction must not re-read already-extracted history: ${alreadyExtracted.slice(0, 40)}`,
      );
    }
  });
});

describe("tagged extraction transcript mirrors the final text sequence", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "tagged-transcript-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function buildHarness(extraConfig = {}) {
    const embeddingPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    return createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 1,
        extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
        sessionCompression: { enabled: false },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        embedding: {
          apiKey: "test-api-key",
          model: "mock-embedding-model",
          baseURL: `http://127.0.0.1:${embeddingPort}/v1`,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        llm: {
          apiKey: "test-api-key",
          model: "mock-memory-model",
          baseURL: `http://127.0.0.1:${llmPort}`,
        },
        ...extraConfig,
      },
    });
  }

  const FACT_TEXT = "my synthetic locker combination for the gym is 4491, in case it comes up.";

  it("the remember-this flow delivers BOTH the prior fact and the command to the real extraction prompt, inside tagged turns", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract the fact");

    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract the remember command");

    const prompt = extractionPrompts[1];
    assert.ok(
      prompt.includes(FACT_TEXT),
      "the referenced prior fact must reach the extraction prompt, not just the remember command",
    );
    assert.ok(prompt.includes("remember this"), "the command itself must be present");
    assert.match(
      prompt,
      /<user_message>[^<]*locker combination[^<]*<\/user_message>/,
      "the prior fact must appear as a properly tagged user turn",
    );
  });

  it("does not sweep a distinct earlier user message into a remember referent", async () => {
    // With captureAssistant off, assistant turns never enter the recents
    // window, so two separate user messages sit adjacent there. Adjacency
    // alone must not read as "blocks of one message": the walk may extend
    // only across turns sharing the source message's identity, otherwise an
    // old unrelated message gets its first extraction smuggled in by a later
    // unrelated "remember this".
    const OLD_PREFERENCE = "I prefer synthetic almond milk in my coffee.";
    const OLD_REMARK = "My synthetic kneeling chair is set to level five.";
    const harness = buildHarness({ extractMinMessages: 4 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(OLD_PREFERENCE), ctx);
    await fireAgentEnd(hook, userMessages(OLD_PREFERENCE, OLD_REMARK), ctx);
    await fireAgentEnd(hook, userMessages(OLD_PREFERENCE, OLD_REMARK, FACT_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "the three prior turns stay below the threshold");

    await fireAgentEnd(
      hook,
      userMessages(OLD_PREFERENCE, OLD_REMARK, FACT_TEXT, "remember this"),
      ctx,
    );
    assert.equal(extractionPrompts.length, 1, "the remember command meets the threshold and extracts");
    const prompt = extractionPrompts[0];
    assert.ok(prompt.includes(FACT_TEXT), "the immediately referenced fact must be prepended");
    assert.ok(
      !prompt.includes(OLD_PREFERENCE) && !prompt.includes(OLD_REMARK),
      "distinct earlier user messages must never enter extraction on a later remember command",
    );
  });

  it("still extends the referent across the blocks of ONE multi-block user message", async () => {
    const BLOCK_A = "My synthetic project codename is Duckbridge.";
    const BLOCK_B = "Its synthetic launch window is the third week of the month.";
    const multiBlockMessage = {
      role: "user",
      content: [
        { type: "text", text: BLOCK_A },
        { type: "text", text: BLOCK_B },
      ],
    };
    const harness = buildHarness({ extractMinMessages: 3 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, [multiBlockMessage], ctx);
    assert.equal(extractionPrompts.length, 0, "the blocks alone stay below the threshold");

    await fireAgentEnd(hook, [multiBlockMessage, { role: "user", content: "remember this" }], ctx);
    assert.equal(extractionPrompts.length, 1, "the remember command must extract on its turn");
    const prompt = extractionPrompts[0];
    assert.ok(prompt.includes(BLOCK_A), "the first block of the referenced message must be prepended");
    assert.ok(prompt.includes(BLOCK_B), "the second block of the referenced message must be prepended");
  });

  it("session compression governs the tagged transcript: dropped texts stay out of the tagged turns", async () => {
    const filler = ("today we walked through the deployment steps in exhaustive detail and then " +
      "revisited every one of them again for completeness. ").repeat(30);
    const keeperFirst = "my synthetic workshop shelf label is Brasswing, that is the one to quote.";
    const keeperLast = "and the synthetic loading dock gate code is 7734, noting it for the record.";

    const harness = buildHarness({
      sessionCompression: { enabled: true },
      extractMaxChars: 400,
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(keeperFirst, filler, keeperLast), ctx);
    assert.equal(extractionPrompts.length, 1, "the turn must extract");

    const prompt = extractionPrompts[0];
    assert.ok(prompt.includes("Brasswing"), "the kept first text must be present");
    assert.ok(prompt.includes("7734"), "the kept last text must be present");
    assert.ok(
      !prompt.includes("exhaustive detail"),
      "a compression-dropped text must not reach the prompt through the tagged transcript",
    );
  });

  it("captureAssistant: the remembered fact keeps its assistant role in the prepended turn, and the ack in the delta does not mask the command", async () => {
    const ASSISTANT_FACT =
      "the synthetic staging endpoint lives at port 8443 behind the demo proxy.";
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(
      hook,
      [
        { role: "user", content: "where does the synthetic staging endpoint live again?" },
        { role: "assistant", content: ASSISTANT_FACT },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [
        { role: "user", content: "where does the synthetic staging endpoint live again?" },
        { role: "assistant", content: ASSISTANT_FACT },
        { role: "user", content: "remember this" },
        { role: "assistant", content: "Saved it for you." },
      ],
      ctx,
    );
    assert.equal(
      extractionPrompts.length,
      2,
      "turn 2 must extract even though the delta carries an assistant ack alongside the command",
    );

    const prompt = extractionPrompts[1];
    assert.match(
      prompt,
      /<assistant_message>\n[^<]*port 8443[^<]*\n<\/assistant_message>[\s\S]*<user_message>\nremember this\n<\/user_message>/,
      "the prepended prior fact must keep its original assistant role and precede the command",
    );
  });

  it("captureAssistant: remember-this walks past the assistant ack to include the user's fact", async () => {
    const USER_FACT = "my synthetic greenhouse door code is 6172, writing it here once.";
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(
      hook,
      [
        { role: "user", content: USER_FACT },
        { role: "assistant", content: "Got it, noted." },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [
        { role: "user", content: USER_FACT },
        { role: "assistant", content: "Got it, noted." },
        { role: "user", content: "remember this" },
        { role: "assistant", content: "Saved." },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");

    const prompt = extractionPrompts[1];
    assert.match(
      prompt,
      /<user_message>\n[^<]*greenhouse door code[^<]*\n<\/user_message>/,
      "the walk must reach the user's fact, not stop at the assistant ack",
    );
    assert.match(
      prompt,
      /<assistant_message>\n[^<]*Got it[^<]*\n<\/assistant_message>/,
      "the intervening ack keeps its own role",
    );
  });

  it("remember-this survives a fact longer than extractMaxChars: the referenced fact's tail reaches the prompt", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const longFact =
      "the synthetic archive locker manifest begins here. " +
      "filler sentence about the synthetic archive contents follows now. ".repeat(130) +
      "and the final synthetic archive gate code is 9944.";
    assert.ok(longFact.length > 8000, "fixture must exceed the default extractMaxChars");

    await fireAgentEnd(hook, userMessages(longFact), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(hook, userMessages(longFact, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");

    const prompt = extractionPrompts[1];
    assert.ok(
      prompt.includes("gate code is 9944"),
      "the tail of the long referenced fact must survive trimming into the prompt",
    );
    assert.ok(prompt.includes("remember this"), "the command itself must be present");
  });

  it("turns whose rendered blocks fit extractMaxChars arrive whole", async () => {
    const harness = buildHarness({ extractMaxChars: 400 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const notes = [
      "synthetic pantry note one is rice.",
      "synthetic pantry note two is beans.",
      "synthetic pantry note three is oats.",
      "synthetic pantry note four is flour.",
    ];

    await fireAgentEnd(hook, userMessages(...notes), ctx);
    assert.equal(extractionPrompts.length, 1, "the turn must extract");

    const prompt = extractionPrompts[0];
    assert.ok(
      prompt.includes(notes[0]),
      "the first note's rendered block fits the cap and must be present",
    );
    assert.ok(prompt.includes(notes[notes.length - 1]), "the last note must be present");
  });

  it("a long history is bounded by extractMaxChars in the prompt (restart shape)", async () => {
    const harness = buildHarness({ extractMaxChars: 600 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const notes = [];
    for (let i = 0; i < 80; i++) {
      notes.push(`synthetic ledger row number ${i} holds value ${1000 + i}.`);
    }
    await fireAgentEnd(hook, userMessages(...notes), ctx);
    assert.equal(extractionPrompts.length, 1, "the turn must extract");

    const prompt = extractionPrompts[0];
    const sectionStart = prompt.indexOf("## Recent Conversation");
    assert.ok(sectionStart >= 0, "the prompt must carry the conversation section");
    const transcript = prompt
      .slice(sectionStart)
      .match(/<(?:user|assistant)_message>[\s\S]*<\/(?:user|assistant)_message>/);
    assert.ok(transcript, "the conversation section must carry a tagged transcript");
    assert.ok(
      transcript[0].length <= 600,
      `the transcript must respect extractMaxChars, got ${transcript[0].length}`,
    );
    assert.ok(prompt.includes("holds value 1079."), "the newest content must be present");
  });

  it("captureAssistant: the walk reaches the user's fact through a multi-block assistant reply", async () => {
    const USER_FACT = "my synthetic cellar keypad code is 3358, noting it once.";
    const turnOneMessages = [
      { role: "user", content: USER_FACT },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me note that down properly." },
          { type: "text", text: "I have written it in the log." },
          { type: "text", text: "Anything else you want stored?" },
        ],
      },
    ];
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, turnOneMessages, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [
        ...turnOneMessages,
        { role: "user", content: "remember this" },
        { role: "assistant", content: "Saved." },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");

    assert.match(
      extractionPrompts[1],
      /<user_message>\n[^<]*cellar keypad code[^<]*\n<\/user_message>/,
      "the walk must reach the user fact past three assistant blocks",
    );
  });

  it("session_end clears the remember window: a post-reset remember finds no referent", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    assert.ok(sessionEndHooks.length > 0, "a session_end teardown hook must be registered");
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "new" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-reset turn must still extract");
    assert.ok(
      !extractionPrompts[1].includes(FACT_TEXT),
      "the pre-reset fact must not be prepended after session_end teardown",
    );
  });

  it("a compaction session_end preserves the remember window: the conversation continues", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "compaction", nextSessionId: "rolled" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-compaction turn must extract");
    assert.ok(
      extractionPrompts[1].includes(FACT_TEXT),
      "compaction rolls the sessionId but the conversation continues: the referent must survive",
    );
  });

  it("an idle session_end preserves the remember window: the conversation continues", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "idle", nextSessionId: "rolled" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-rollover turn must extract");
    assert.ok(
      extractionPrompts[1].includes(FACT_TEXT),
      "an idle rollover keeps the sessionKey and the conversation: the referent must survive",
    );
  });

  it("a daily session_end preserves the remember window: the conversation continues", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "daily", nextSessionId: "rolled" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-rollover turn must extract");
    assert.ok(
      extractionPrompts[1].includes(FACT_TEXT),
      "a daily rollover keeps the sessionKey and the conversation: the referent must survive",
    );
  });

  it("captureAssistant: a deferred below-threshold exchange keeps its roles through the terminal flush", async () => {
    // Deferred-flush state used to be flat strings: on session_end the flush
    // rebuilt turns through the no-correlation fallback and re-tagged the
    // assistant's answer as a user turn, so assistant-authored content
    // reached the extraction prompt inside user_message tags.
    const harness = buildHarness({ captureAssistant: true, extractMinMessages: 4 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const assistantReply = [
      "The synthetic irrigation controller lives on breaker seven.",
      "Its synthetic maintenance override phrase is daffodil-vector-nine.",
    ].join("\n\n");
    await fireAgentEnd(
      hook,
      [
        { role: "user", content: "where does the synthetic irrigation controller live?" },
        { role: "assistant", content: assistantReply },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 0, "a below-threshold exchange must defer, not extract");

    const flushRuns = [];
    for (const handler of sessionEndHooks) {
      const result = handler({ reason: "new" }, ctx);
      if (result && typeof result.then === "function") flushRuns.push(result);
    }
    await Promise.allSettled(flushRuns);

    assert.equal(extractionPrompts.length, 1, "the terminal flush must extract the deferred exchange");
    const flushPrompt = extractionPrompts[0];
    assert.match(
      flushPrompt,
      /<assistant_message>\n[^<]*breaker seven[\s\S]*?<\/assistant_message>/,
      "the deferred assistant answer must stay inside assistant tags",
    );
    assert.doesNotMatch(
      flushPrompt,
      /<user_message>[^<]*breaker seven[\s\S]*?<\/user_message>/,
      "assistant-authored content must not be re-tagged as a user turn",
    );
    assert.match(
      flushPrompt,
      /<user_message>\n[^<]*irrigation controller live[\s\S]*?<\/user_message>/,
      "the user question keeps its user tag",
    );
  });

  it("a rollover session_end with queued ingress flushes the ingress but keeps the remember window", async () => {
    // The rollover-triggering inbound is already queued when an idle
    // session_end fires, so the terminal flush has work to do and runs to
    // completion. The flush may consume that queued text, but the boundary is
    // a continuation: the recent-turn window must survive it, or the
    // successor's first remember command has no referent.
    const QUEUED_TEXT = "synthetic courier note about parcel 7731 arriving friday.";
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const messageHooks = (harness.eventHandlers.get("message_received") || []).map(
      (entry) => entry.handler,
    );
    assert.ok(messageHooks.length > 0, "a message_received handler must be registered");
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = {
      sessionKey: "agent:agent-two:telegram:99002",
      agentId: "agent-two",
      channelId: "telegram",
      conversationId: "99002",
    };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of messageHooks) {
      handler({ content: QUEUED_TEXT }, ctx);
    }
    const promptsBeforeFlush = extractionPrompts.length;
    const flushRuns = [];
    for (const handler of sessionEndHooks) {
      const result = handler({ reason: "idle", nextSessionId: "rolled" }, ctx);
      if (result && typeof result.then === "function") flushRuns.push(result);
    }
    await Promise.allSettled(flushRuns);
    assert.equal(
      extractionPrompts.length,
      promptsBeforeFlush + 1,
      "the rollover flush must consume the queued ingress",
    );
    assert.ok(
      extractionPrompts[extractionPrompts.length - 1].includes("parcel 7731"),
      "the flushed extraction carries the queued text",
    );

    const promptsBeforeRemember = extractionPrompts.length;
    await fireAgentEnd(hook, userMessages("remember this"), ctx);
    assert.ok(
      extractionPrompts.length > promptsBeforeRemember,
      "the remember turn must extract",
    );
    assert.ok(
      extractionPrompts[extractionPrompts.length - 1].includes("parcel 7731"),
      "a continuation rollover may flush queued ingress but must keep the remember window: the flushed inbound is the newest referent and must reach the remember prompt",
    );
  });

  it("a reason-less session_end that announces a successor preserves the remember window", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ nextSessionId: "rolled" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-rollover turn must extract");
    assert.ok(
      extractionPrompts[1].includes(FACT_TEXT),
      "a successor session under the same key continues the conversation: the referent must survive",
    );
  });

  it("a reset session_end wipes the remember window even though it announces a successor", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "reset", nextSessionId: "fresh" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-reset turn must still extract");
    assert.ok(
      !extractionPrompts[1].includes(FACT_TEXT),
      "reset is a true boundary regardless of the successor id: the referent must not survive",
    );
  });

  it("an unknown-reason session_end with no successor wipes the remember window", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    for (const handler of sessionEndHooks) {
      handler({ reason: "unknown" }, ctx);
    }
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 2, "the post-boundary turn must still extract");
    assert.ok(
      !extractionPrompts[1].includes(FACT_TEXT),
      "an unrecognized boundary with no successor must fail toward wiping the window",
    );
  });

  it("captureAssistant: a six-block assistant reply must not evict the remembered fact from the window", async () => {
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const turnOneMessages = [
      { role: "user", content: FACT_TEXT },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Understood, noting that." },
          { type: "text", text: "I keep a careful log of these." },
          { type: "text", text: "The log now has a fresh entry." },
          { type: "text", text: "It is stored under personal items." },
          { type: "text", text: "I double-checked the entry." },
          { type: "text", text: "All set on my side." },
        ],
      },
    ];
    await fireAgentEnd(hook, turnOneMessages, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [
        ...turnOneMessages,
        { role: "user", content: "remember this" },
        { role: "assistant", content: "Saved." },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");
    assert.match(
      extractionPrompts[1],
      /<user_message>\n[^<]*locker combination[^<]*\n<\/user_message>/,
      "the user's fact must survive a window-filling assistant reply and reach the prompt as a user turn",
    );
  });

  it("captureAssistant: the prepended referent survives transcript bounding, it is not the first block sacrificed", async () => {
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // A verbose multi-block reply after the fact. The prepend window runs from
    // the fact forward, so the fact is the OLDEST prepended block and a
    // newest-first budget walk drops it first.
    const filler = (label) => `${label}: ` + "synthetic elaboration sentence about the topic. ".repeat(62);
    const turnOneMessages = [
      { role: "user", content: FACT_TEXT },
      {
        role: "assistant",
        content: [
          { type: "text", text: filler("block one") },
          { type: "text", text: filler("block two") },
          { type: "text", text: filler("block three") },
          { type: "text", text: filler("block four") },
        ],
      },
    ];
    await fireAgentEnd(hook, turnOneMessages, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [...turnOneMessages, { role: "user", content: "remember this" }],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");
    assert.ok(
      extractionPrompts[1].includes("remember this"),
      "the command itself must reach the prompt",
    );
    assert.match(
      extractionPrompts[1],
      /<user_message>\n[^<]*locker combination[^<]*\n<\/user_message>/,
      "the prepended referent must survive bounding, otherwise the command is prompted with no fact",
    );
  });

  it("the extraction request is split into a system half and a user half carrying the transcript", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);

    assert.equal(extractionPrompts.length, 1, "the turn must extract");
    const messages = extractionPrompts.messages;
    assert.ok(Array.isArray(messages) && messages.length >= 2, "extraction must send at least two messages");
    assert.equal(messages[0].role, "system", "the first message must be the system half");
    assert.equal(messages[messages.length - 1].role, "user", "the transcript must ride the user half");
    assert.ok(
      String(messages[messages.length - 1].content).includes("## Recent Conversation"),
      "the conversation header belongs to the user half",
    );
    assert.ok(
      !String(messages[0].content).includes("## Recent Conversation"),
      "the system half must not carry the transcript",
    );
    assert.ok(
      String(messages[0].content).includes("<user_message>"),
      "the system half teaches the speaker-tag format",
    );
  });

  it("an envelope-only delta does not consume the hourly extraction quota", async () => {
    const harness = buildHarness({
      extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 1 },
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const envelopeOnly = '```json\n{"message_id": "m-4400", "sender_id": "s-9900"}\n```';
    await fireAgentEnd(hook, userMessages(envelopeOnly), ctx);
    assert.equal(extractionPrompts.length, 0, "the envelope-only delta reaches no LLM");

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    assert.equal(
      extractionPrompts.length,
      1,
      "the skipped delta must leave the hourly quota intact for the next real extraction",
    );
  });

  it("captureAssistant: a two-block user fact survives eviction whole, not just its trailer block", async () => {
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const turnOneMessages = [
      {
        role: "user",
        content: [
          { type: "text", text: FACT_TEXT },
          { type: "text", text: "anyway, that is all for now." },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Understood, noting that." },
          { type: "text", text: "I keep a careful log of these." },
          { type: "text", text: "The log now has a fresh entry." },
          { type: "text", text: "It is stored under personal items." },
          { type: "text", text: "I double-checked the entry." },
          { type: "text", text: "All set on my side." },
        ],
      },
    ];
    await fireAgentEnd(hook, turnOneMessages, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [
        ...turnOneMessages,
        { role: "user", content: "remember this" },
        { role: "assistant", content: "Saved." },
      ],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");
    assert.match(
      extractionPrompts[1],
      /<user_message>\n[^<]*locker combination[^<]*\n<\/user_message>/,
      "the fact block of a multi-block user message must survive the window, not only its trailer block",
    );
  });

  it("session_end leaves the shared conversation ingress queue intact for co-resident agents", async () => {
    const QUEUED_TEXT = "synthetic courier note about parcel 5520 arriving tomorrow.";
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const messageHooks = (harness.eventHandlers.get("message_received") || []).map(
      (entry) => entry.handler,
    );
    assert.ok(messageHooks.length > 0, "a message_received handler must be registered");
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );
    const ctx = {
      sessionKey: "agent:agent-two:telegram:99001",
      agentId: "agent-two",
      channelId: "telegram",
      conversationId: "99001",
    };

    for (const handler of messageHooks) {
      handler({ content: QUEUED_TEXT }, ctx);
    }
    for (const handler of sessionEndHooks) {
      handler({ reason: "new" }, ctx);
    }
    await fireAgentEnd(
      hook,
      userMessages("synthetic unrelated shelf label reads Copperfield."),
      ctx,
    );
    assert.equal(extractionPrompts.length, 1, "the next turn must extract");
    assert.ok(
      extractionPrompts[0].includes("parcel 5520"),
      "the conversation-scoped ingress queue is shared across agents and must survive one agent's session boundary",
    );
  });

  it("a repeated remember command anchors on the fact, not the earlier command", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this"), ctx);
    await fireAgentEnd(hook, userMessages(FACT_TEXT, "remember this", "remember this"), ctx);
    assert.equal(extractionPrompts.length, 3, "all three turns must extract");
    assert.ok(
      extractionPrompts[2].includes(FACT_TEXT),
      "the repeated command must reach back to the fact, not anchor on the prior command",
    );
  });

  it("an unattributable session key never receives another session's remember window", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    const HINT = "agent one synthetic vault hint is 7181, keep it handy.";
    await fireAgentEnd(hook, userMessages(HINT), { agentId: "agent-one" });
    await fireAgentEnd(hook, userMessages("remember this"), { agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 2, "both turns must extract");
    assert.ok(
      !extractionPrompts[1].includes("vault hint"),
      "content from one unattributable session must not be prepended into another",
    );
  });

  it("a shared literal session key stays agent-scoped: one agent's remember window never feeds another's extraction", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    const HINT = "agent one synthetic vault hint is 7181, keep it handy.";
    await fireAgentEnd(hook, userMessages(HINT), { sessionKey: "global", agentId: "agent-one" });
    await fireAgentEnd(hook, userMessages("remember this"), { sessionKey: "global", agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 2, "both turns must extract");
    assert.ok(
      !extractionPrompts[1].includes("vault hint"),
      "agent-two's remember command must not pull agent-one's turns out of the shared global window",
    );
  });

  it("a terminal on a shared session key clears the writer's window even though the host names the default agent", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionEndHooks = (harness.eventHandlers.get("session_end") || []).map(
      (entry) => entry.handler,
    );

    // On a key with no agent segment the host rebuilds session_end's agentId
    // from the key and falls back to the DEFAULT agent, never the writer.
    const HINT = "agent two synthetic parcel code is 6633, worth keeping.";
    await fireAgentEnd(hook, userMessages(HINT), { sessionKey: "global", agentId: "agent-two" });
    for (const handler of sessionEndHooks) {
      handler({ reason: "reset" }, { sessionKey: "global", agentId: "main" });
    }
    await fireAgentEnd(hook, userMessages("remember this"), { sessionKey: "global", agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 2, "both turns must extract");
    assert.ok(
      !extractionPrompts[1].includes("parcel code"),
      "a terminal boundary ends the shared session for every agent riding the key; the writer's window must not survive it",
    );
  });

  it("a turn that strips to pure envelope metadata is not rendered as an empty tagged block", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const envelopeOnly = '```json\n{"message_id": "m-3301", "sender_id": "s-8802"}\n```';
    await fireAgentEnd(hook, userMessages(envelopeOnly, FACT_TEXT), ctx);

    assert.equal(extractionPrompts.length, 1, "the turn must extract");
    assert.ok(
      !/<user_message>\s*<\/user_message>/.test(extractionPrompts[0]),
      "an envelope-only turn must not render as an empty user block",
    );
    assert.ok(
      extractionPrompts[0].includes("locker combination"),
      "the substantive fact still reaches the prompt",
    );
  });

  it("a delta that strips entirely to envelope metadata skips the extraction call", async () => {
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const envelopeOnly = '```json\n{"message_id": "m-3302", "sender_id": "s-8803"}\n```';
    await fireAgentEnd(hook, userMessages(envelopeOnly), ctx);

    assert.equal(
      extractionPrompts.length,
      0,
      "an envelope-only delta must not reach the extraction LLM",
    );
  });

  it("captureAssistant: remember-this anchors past an envelope-only user turn to the real fact", async () => {
    const harness = buildHarness({ captureAssistant: true });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const envelopeOnly = '```json\n{"message_id": "m-9911", "sender_id": "s-2244"}\n```';
    const turnOneMessages = [
      { role: "user", content: FACT_TEXT },
      { role: "assistant", content: "Noted." },
      { role: "user", content: envelopeOnly },
    ];
    await fireAgentEnd(hook, turnOneMessages, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract");

    await fireAgentEnd(
      hook,
      [...turnOneMessages, { role: "user", content: "remember this" }],
      ctx,
    );
    assert.equal(extractionPrompts.length, 2, "turn 2 must extract");
    assert.ok(
      extractionPrompts[1].includes("locker combination"),
      "the anchor must skip the contentless envelope turn and reach the fact",
    );
  });

  it("an extractMaxChars below the tag envelope skips extraction instead of prompting on nothing", async () => {
    const harness = buildHarness({ extractMaxChars: 20 });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(FACT_TEXT), ctx);

    assert.equal(
      extractionPrompts.length,
      0,
      "a transcript emptied by bounding must not reach the extraction LLM",
    );
  });
});
