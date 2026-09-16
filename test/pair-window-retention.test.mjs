/**
 * Rolling pair-window retention across extractions, sized by
 * autoCaptureContextTurns.
 *
 * Without retention, history-carrying sessions that extract every turn see
 * only the current pair in each transcript, so the extractor never has the
 * conversational context to resolve references ("yes exactly, that one").
 * The rolling window (autoCaptureRecentPairTurns, trimmed by
 * trimTurnsToUserCap, repaired by dedupePairWindow) keeps the last N user
 * turns with their interleaved assistant replies in the transcript across
 * extractions. N = autoCaptureContextTurns: 0 (the default) disables
 * retention entirely and preserves stock behavior; 1-10 sets the window
 * size, decoupled from the extractMinMessages warm-up gate.
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

function createLlmServer(extractionPrompts) {
  let calls = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");
    if (prompt.includes("## Recent Conversation")) {
      extractionPrompts.push(prompt);
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
              abstract: `Synthetic retention marker number ${calls}`,
              overview: `## Preference\n- Marker ${calls}`,
              content: `User stated synthetic retention marker number ${calls}.`,
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

const U1 = "synthetic retention fact alpha about the quartz drawer";
const A1 = "noted, quartz drawer it is";
const U2 = "synthetic retention fact beta about the basalt shelf";
const A2 = "got it, basalt shelf recorded";
const U3 = "synthetic retention fact gamma about the marble crate";
const A3 = "marble crate, understood";
const U4 = "synthetic retention fact delta about the granite bin";

function turnMessages(count) {
  const all = [
    { role: "user", content: U1 },
    { role: "assistant", content: A1 },
    { role: "user", content: U2 },
    { role: "assistant", content: A2 },
    { role: "user", content: U3 },
    { role: "assistant", content: A3 },
    { role: "user", content: U4 },
  ];
  return all.slice(0, count);
}

describe("pair-window retention across successful extractions", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;
  let hook;
  let basePluginConfig;

  beforeEach(async () => {
    resetRegistration();
    workspaceDir = mkdtempSync(path.join(tmpdir(), "pair-window-retention-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    basePluginConfig = {
      dbPath: path.join(workspaceDir, "memory-db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 2,
      autoCaptureContextTurns: 2,
      extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
      sessionCompression: { enabled: false },
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      embedding: {
        apiKey: "test-key",
        model: "mock-embedding-model",
        baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        apiKey: "test-key",
        model: "mock-memory-model",
        baseURL: `http://127.0.0.1:${llmServer.address().port}`,
      },
    };
    const harness = createPluginApiHarness({ pluginConfig: basePluginConfig, resolveRoot: workspaceDir });
    memoryLanceDBProPlugin.register(harness.api);
    hook = getAutoCaptureHook(harness.eventHandlers);
  });

  function registerFresh(overrides) {
    resetRegistration();
    const harness = createPluginApiHarness({
      pluginConfig: { ...basePluginConfig, ...overrides },
      resolveRoot: workspaceDir,
    });
    memoryLanceDBProPlugin.register(harness.api);
    return getAutoCaptureHook(harness.eventHandlers);
  }

  afterEach(async () => {
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("carries the previous pair into the next extraction after a SUCCESSFUL extraction", async () => {
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 should extract (cumulative=2 >= min=2)");
    assert.ok(extractionPrompts[0].includes(U1) && extractionPrompts[0].includes(U2));

    await fireAgentEnd(hook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2, "turn 2 should extract (delta past warm-up)");
    assert.ok(extractionPrompts[1].includes(U3), "turn 2 must carry its own new user turn");
    assert.ok(
      extractionPrompts[1].includes(U2),
      "turn 2 must retain the previous pair as context — a successful extraction may not wipe the rolling window",
    );
    assert.ok(
      !extractionPrompts[1].includes(U1),
      "the window stays trimmed to the configured cap (2 user turns), so the oldest pair drops",
    );
  });

  it("keeps the window bounded across repeated successful extractions", async () => {
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    await fireAgentEnd(hook, turnMessages(6), ctx);
    await fireAgentEnd(hook, turnMessages(7), ctx);

    assert.equal(extractionPrompts.length, 3, "all three turns should extract");
    const third = extractionPrompts[2];
    assert.ok(third.includes(U4), "turn 3 carries its new user turn");
    assert.ok(third.includes(U3), "turn 3 retains the immediately previous user turn");
    assert.ok(!third.includes(U2), "the cap keeps the window at 2 user turns");
    assert.ok(!third.includes(U1), "long-dropped pairs never resurface");
  });

  it("retains nothing between calls when autoCaptureContextTurns is 0", async () => {
    const zeroHook = registerFresh({
      autoCaptureContextTurns: 0,
      dbPath: path.join(workspaceDir, "memory-db-zero"),
    });
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(zeroHook, turnMessages(4), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 should extract");
    await fireAgentEnd(zeroHook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2, "turn 2 should extract");
    const second = extractionPrompts[1];
    assert.ok(second.includes(U3), "the call's own new turn is present");
    assert.ok(
      !second.includes(U2) && !second.includes(U1),
      "a disabled window may not carry prior pairs into the next extraction",
    );
  });

  it("defaults to disabled when the knob is absent (upstream behavior preserved)", async () => {
    const defaultHook = registerFresh({
      autoCaptureContextTurns: undefined,
      dbPath: path.join(workspaceDir, "memory-db-default"),
    });
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(defaultHook, turnMessages(4), ctx);
    await fireAgentEnd(defaultHook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2);
    const second = extractionPrompts[1];
    assert.ok(second.includes(U3));
    assert.ok(!second.includes(U2) && !second.includes(U1), "absent knob means no retained context");
  });
});

describe("pair-window review regressions: assistant context, current repeats, remember retention", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;
  let basePluginConfig;

  beforeEach(async () => {
    resetRegistration();
    workspaceDir = mkdtempSync(path.join(tmpdir(), "pair-window-review-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    basePluginConfig = {
      dbPath: path.join(workspaceDir, "memory-db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 2,
      autoCaptureContextTurns: 2,
      extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
      sessionCompression: { enabled: false },
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      embedding: {
        apiKey: "test-key",
        model: "mock-embedding-model",
        baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        apiKey: "test-key",
        model: "mock-memory-model",
        baseURL: `http://127.0.0.1:${llmServer.address().port}`,
      },
    };
  });

  function registerWith(overrides) {
    resetRegistration();
    const harness = createPluginApiHarness({
      pluginConfig: { ...basePluginConfig, ...overrides },
      resolveRoot: workspaceDir,
    });
    memoryLanceDBProPlugin.register(harness.api);
    return getAutoCaptureHook(harness.eventHandlers);
  }

  afterEach(async () => {
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("carries assistant replies as transcript context under the DEFAULT captureAssistant setting", async () => {
    const hook = registerWith({});
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    assert.equal(extractionPrompts.length, 1);
    assert.ok(
      extractionPrompts[0].includes(`<context_only_assistant_turn>\n${A2}`),
      "the current call's assistant replies must appear as context_only blocks with captureAssistant unset",
    );

    await fireAgentEnd(hook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2);
    assert.ok(
      extractionPrompts[1].includes(A2),
      "the RETAINED pair must include its assistant reply in the next prompt (rolling window carries pairs, not bare user turns)",
    );
    assert.ok(
      extractionPrompts[1].includes(A3),
      "the current call's own reply rides as context too",
    );
  });

  it("renders retained turns as context_only blocks the prompt forbids sourcing from, keeping the current turn a normal source", async () => {
    const hook = registerWith({});
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    await fireAgentEnd(hook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2);
    const second = extractionPrompts[1];
    assert.ok(
      second.includes(`<context_only_user_turn>\n${U2}`) || second.includes(`<context_only_user_turn>\n` ) && second.indexOf(U2) > second.indexOf("<context_only_user_turn>"),
      "the retained user turn must render inside a context_only_user_turn block, not as a normal source block",
    );
    assert.ok(
      second.includes(`<user_message>\n${U3}`),
      "the current call's user turn stays a normal <user_message> source block",
    );
    assert.ok(
      second.includes("Context blocks are NEVER memory sources"),
      "the prompt must carry the context-block non-source rule",
    );
  });

  it("isolates rolling windows between agents sharing a literal session key", async () => {
    const hook = registerWith({ extractMinMessages: 1 });
    const AGENT_ONE_FACT = "synthetic isolation fact from the first agent about copper pipes";
    const AGENT_TWO_FACT = "synthetic isolation fact from the second agent about tin roofs";

    await fireAgentEnd(hook, [{ role: "user", content: AGENT_ONE_FACT }], { sessionKey: "global", agentId: "agent-one" });
    await fireAgentEnd(hook, [{ role: "user", content: AGENT_TWO_FACT }], { sessionKey: "global", agentId: "agent-two" });

    const secondPrompt = extractionPrompts[extractionPrompts.length - 1];
    assert.ok(secondPrompt.includes(AGENT_TWO_FACT), "the second agent's own turn must extract");
    assert.ok(
      !secondPrompt.includes(AGENT_ONE_FACT),
      "one agent's retained transcript must never enter another agent's extraction (shared literal session key)",
    );
  });

  it("disables retention entirely for unattributable captures instead of sharing a fallback key", async () => {
    const hook = registerWith({ extractMinMessages: 1 });
    const FIRST_FACT = "synthetic unattributable fact about walnut shelving";
    const SECOND_FACT = "synthetic unattributable fact about cedar panels";

    await fireAgentEnd(hook, [{ role: "user", content: FIRST_FACT }], { sessionKey: "global", agentId: "unknown" });
    await fireAgentEnd(
      hook,
      [{ role: "user", content: FIRST_FACT }, { role: "user", content: SECOND_FACT }],
      { sessionKey: "global", agentId: "unknown" },
    );

    const secondPrompt = extractionPrompts[extractionPrompts.length - 1];
    assert.ok(secondPrompt.includes(SECOND_FACT));
    assert.ok(
      !secondPrompt.includes(`<context_only_user_turn>\n${FIRST_FACT}`),
      "an unattributable capture must not retain a rolling window at all",
    );
  });

  it("keeps the current user turn when a trailing context reply exceeds the transcript budget", async () => {
    const hook = registerWith({ extractMinMessages: 1, extractMaxChars: 600 });
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };
    const CURRENT_FACT = "synthetic budget fact about the juniper cabinet finish";
    const hugeReply = "acknowledged with an extremely long synthetic elaboration. ".repeat(40);

    await fireAgentEnd(
      hook,
      [
        { role: "user", content: CURRENT_FACT },
        { role: "assistant", content: hugeReply },
      ],
      ctx,
    );

    const prompt = extractionPrompts[extractionPrompts.length - 1];
    assert.ok(
      prompt.includes(CURRENT_FACT),
      "the current user SOURCE turn must survive the budget even when a context reply alone exceeds it",
    );
  });

  it("keeps a legitimate current-call repeat of a prior pair's user text", async () => {
    const hook = registerWith({ autoCaptureContextTurns: 3 });
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, [
      { role: "user", content: U1 },
      { role: "assistant", content: A1 },
      { role: "user", content: U2 },
    ], ctx);
    assert.equal(extractionPrompts.length, 1);

    await fireAgentEnd(hook, [
      { role: "user", content: U1 },
      { role: "assistant", content: A1 },
      { role: "user", content: U2 },
      { role: "user", content: U1 },
    ], ctx);
    assert.equal(extractionPrompts.length, 2, "the repeat turn should extract");
    const occurrences = extractionPrompts[1].split(U1).length - 1;
    assert.ok(
      occurrences >= 2,
      `a user intentionally repeating a prior pair's text must stay in its own extraction (wanted the prior pair AND the current repeat, got ${occurrences} occurrence(s))`,
    );
    assert.ok(
      extractionPrompts[1].lastIndexOf(U1) > extractionPrompts[1].indexOf(U2),
      "the current repeat must appear as the NEWEST turn (after the retained pairs), proving the current occurrence survived rather than only the prior pair",
    );
  });

  it("preserves the accumulated window across a remember flow instead of overwriting it with the remember transcript", async () => {
    const hook = registerWith({ autoCaptureContextTurns: 4 });
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 1);

    await fireAgentEnd(hook, [...turnMessages(6), { role: "user", content: "remember this" }], ctx);
    assert.equal(extractionPrompts.length, 2, "the remember flow should extract");

    await fireAgentEnd(
      hook,
      [...turnMessages(6), { role: "user", content: "remember this" }, { role: "user", content: U4 }],
      ctx,
    );
    assert.equal(extractionPrompts.length, 3);
    assert.ok(
      extractionPrompts[2].includes(U2),
      "older retained pairs must survive a remember call: the remember-shaped transcript may not replace the accumulated window",
    );
  });
});

describe("round-3 regressions: same-call repeats, epoch hygiene, provenance, leading context", () => {
  const RPT = "please redeploy the cobalt fixture build";
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    resetRegistration();
    workspaceDir = mkdtempSync(path.join(tmpdir(), "pair-window-r3-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function registerWithHandlers(overrides) {
    resetRegistration();
    const harness = createPluginApiHarness({
      pluginConfig: {
        dbPath: path.join(workspaceDir, "memory-db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 2,
        autoCaptureContextTurns: 2,
        extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
        sessionCompression: { enabled: false },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        embedding: {
          apiKey: "test-key",
          model: "mock-embedding-model",
          baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        llm: {
          apiKey: "test-key",
          model: "mock-memory-model",
          baseURL: `http://127.0.0.1:${llmServer.address().port}`,
        },
        ...overrides,
      },
      resolveRoot: workspaceDir,
    });
    memoryLanceDBProPlugin.register(harness.api);
    return { hook: getAutoCaptureHook(harness.eventHandlers), eventHandlers: harness.eventHandlers };
  }

  async function fireSessionEnd(eventHandlers, sessionKey, sessionId) {
    for (const entry of eventHandlers.get("session_end") || []) {
      await entry.handler({ sessionId }, { sessionKey });
    }
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("keeps a genuinely repeated same-call user turn as its own newest source occurrence", async () => {
    const { hook } = registerWithHandlers({});
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };
    await fireAgentEnd(hook, [
      { role: "user", content: RPT },
      { role: "assistant", content: "starting the cobalt redeploy now" },
      { role: "user", content: RPT },
    ], ctx);
    assert.equal(extractionPrompts.length, 1, "the same-call repeat batch should extract");
    const occurrences = extractionPrompts[0].split(`<user_message>\n${RPT}`).length - 1;
    assert.equal(
      occurrences,
      2,
      `a same-call repeat is real input, not replay noise: both occurrences must reach the transcript as source turns (got ${occurrences})`,
    );
  });

  it("allocates no pair-window epoch state under the disabled default", async () => {
    const { hook } = registerWithHandlers({ autoCaptureContextTurns: 0 });
    await fireAgentEnd(hook, [
      { role: "user", content: "synthetic disabled-path fact about the walnut tray" },
      { role: "assistant", content: "walnut tray noted" },
      { role: "user", content: "synthetic disabled-path fact about the pewter hook" },
    ], { sessionKey: "agent:agent-one:main", agentId: "agent-one" });
    await fireAgentEnd(hook, [
      { role: "user", content: "synthetic disabled-path fact about the willow rack" },
      { role: "assistant", content: "willow rack noted" },
      { role: "user", content: "synthetic disabled-path fact about the copper stand" },
    ], { sessionKey: "agent:agent-two:main", agentId: "agent-two" });
    assert.equal(extractionPrompts.length, 2, "both disabled-config captures should extract (the cleanup branch must actually run)");
    const sizes = pluginModule.debugAutoCaptureWindowStateSizes();
    assert.ok(sizes, "singleton state should exist after captures");
    assert.equal(sizes.pairWindowEpochs, 0, "contextTurns=0 must not allocate epoch entries");
    assert.equal(sizes.pairWindows, 0, "contextTurns=0 must not retain pair windows");
  });

  it("deletes epoch entries at session teardown once in-flight runs settle", async () => {
    const { hook, eventHandlers } = registerWithHandlers({});
    const sessionKey = "agent:test-agent:main";
    await fireAgentEnd(hook, [
      { role: "user", content: "synthetic teardown fact about the juniper crate" },
      { role: "assistant", content: "juniper crate noted" },
      { role: "user", content: "synthetic teardown fact about the cedar hamper" },
    ], { sessionKey, agentId: "test-agent" });
    assert.equal(extractionPrompts.length, 1, "the enabled capture should extract (the store path must run)");
    let sizes = pluginModule.debugAutoCaptureWindowStateSizes();
    assert.ok(sizes && sizes.pairWindowEpochs >= 1, "an enabled capture should create epoch state");
    await fireSessionEnd(eventHandlers, sessionKey, "session-r3-teardown");
    sizes = pluginModule.debugAutoCaptureWindowStateSizes();
    assert.equal(sizes.pairWindowEpochs, 0, "teardown must delete epoch entries after in-flight runs settle");
    assert.equal(sizes.pairWindows, 0, "teardown must delete the retained window");
  });

  it("keeps context_only tags and the non-source rule in the grounding rejudge prompt", () => {
    const { buildGroundingRejudgePrompt } = jiti("../src/extraction-prompts.ts");
    const CTX_FACT = "the amber shelf holds the tin whistle";
    const conversationText = [
      "<context_only_user_turn>",
      CTX_FACT,
      "</context_only_user_turn>",
      "<user_message>",
      "what did I say about that shelf?",
      "</user_message>",
    ].join("\n");
    const prompt = buildGroundingRejudgePrompt(conversationText, "real", [
      { index: 1, category: "facts", abstract: "shelf", content: CTX_FACT, grounding: "real" },
    ]);
    assert.ok(
      prompt.includes(`<context_only_user_turn>\n${CTX_FACT}`),
      "the rejudge transcript must keep the context_only wrapper instead of normalizing it away",
    );
    assert.ok(
      !prompt.includes(`<user_message>\n${CTX_FACT}`),
      "a context-wrapped turn must not be re-tagged as an ordinary user message for the judge",
    );
    assert.ok(
      prompt.includes("NEVER a source for a memory"),
      "the rejudge doctrine must carry the context-is-not-a-source rule",
    );
  });

  it("protects the referent when a null-anchored context reply is woven ahead of it", () => {
    const cleanup = jiti("../src/auto-capture-cleanup.ts");
    const referent = { role: "user", text: "remember the onyx cabinet combination is stored offline", messageId: 1 };
    const reply = { role: "assistant", text: "y".repeat(400), messageId: 2 };
    const woven = cleanup.weaveContextOnlyAssistantTurns(
      [referent, reply],
      [{ anchorMessageId: null, turn: { role: "assistant", text: "z".repeat(400), messageId: 99, contextOnly: true } }],
    );
    assert.equal(woven[0].contextOnly, true, "the null-anchored context reply weaves at the front");
    const protectedCount = cleanup.countProtectedReferentPrefix(woven, new Set([referent]));
    assert.equal(protectedCount, 1, "context turns are transparent to the protected-prefix scan");
    const bounded = cleanup.buildBoundedTranscriptWithStats(woven, 220, { protectedPrefixTurns: protectedCount });
    assert.ok(
      bounded.transcript.includes(referent.text),
      "the referent must survive an over-budget transcript even with a leading context block",
    );
    assert.equal(bounded.protectedPrefixKept, true);
  });
});
