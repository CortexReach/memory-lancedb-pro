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

  it("rides self replies into the transcript as context under captureAssistant=false + context window", async () => {
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    assert.equal(extractionPrompts.length, 1);
    const first = extractionPrompts[0];
    assert.ok(first.includes(`<context_assistant_message>\n${A1}`), "self replies must appear as context_assistant_message blocks");
    assert.ok(first.includes("Context only"), "the prompt must teach the assistant tag as context");
    assert.ok(first.includes("NEVER extract memories from them"), "the context-only extraction rule must be present");
    assert.ok(!first.includes("\n<assistant_message>"), "no eligible assistant tag may appear under captureAssistant=false");

    await fireAgentEnd(hook, turnMessages(6), ctx);
    const second = extractionPrompts[1];
    assert.ok(second.includes(`<context_assistant_message>\n${A2}`), "the retained window keeps the prior pair's reply as context");
    assert.ok(second.includes(`<context_assistant_message>\n${A3}`), "the new pair's self reply is context too (self is never a source)");
  });

  it("wraps ALREADY-PROCESSED user turns as context_user_message while the new delta keeps user_message", async () => {
    const ctx = { sessionKey: "agent:test-agent:main", agentId: "test-agent" };

    await fireAgentEnd(hook, turnMessages(4), ctx);
    await fireAgentEnd(hook, turnMessages(6), ctx);
    assert.equal(extractionPrompts.length, 2);
    const second = extractionPrompts[1];
    assert.ok(second.includes(`<context_user_message>\n${U2}`), "the watermark-seen user turn must be wrapped as processed context");
    assert.ok(second.includes(`<user_message>\n${U3}`), "the new user turn keeps the extractable user_message tag");
    assert.ok(!second.includes(`<user_message>\n${U2}`), "a processed user turn must not wear the extractable tag");
    assert.ok(second.includes("ALREADY processed by a previous extraction run"), "the prompt must teach the processed-context tag");
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
