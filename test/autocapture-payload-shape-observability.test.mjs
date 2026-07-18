/**
 * Regression coverage for the auto-capture payload-shape INFO line.
 *
 * The one debug line that reveals whether a session's agent_end payload is
 * delta-only (small, roughly constant message count per turn) or
 * history-carrying (grows every turn) was previously only written at DEBUG,
 * which is invisible in the file logger used in production. Diagnosing a
 * stuck watermark meant reconstructing this from indirect evidence across
 * hours of unrelated log lines.
 *
 * This suite pins a compact INFO-level line, emitted once per session per
 * process (not once per turn -- that would just be a different kind of log
 * spam), carrying exactly the fields needed to read the payload shape and
 * the watermark's gate decision at a glance: messages, eligible,
 * previousSeen, cumulative, fired.
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

function createLlmServer() {
  let calls = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
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

function payloadShapeLines(logs) {
  return logs.info.filter((line) => line.includes("auto-capture payload shape"));
}

describe("auto-capture payload-shape INFO line", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let embeddingPort;
  let llmPort;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-payload-shape-"));
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer();
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    embeddingPort = embeddingServer.address().port;
    llmPort = llmServer.address().port;
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function buildPluginConfig(extractMinMessages) {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages,
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
    };
  }

  it("logs one INFO line on the first turn with messages/eligible/previousSeen/cumulative/fired, then stays silent on later turns in the same process", async () => {
    const pluginConfig = buildPluginConfig(4);
    const ctx = { sessionKey: "agent:agent-one:webchat", agentId: "agent-one" };
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    // Turn 1: 2 texts, below minMessages(4) -- gate does not fire yet.
    await fireAgentEnd(hook, userMessages("alpha turn content", "bravo turn content"), ctx);

    let lines = payloadShapeLines(harness.logs);
    assert.equal(lines.length, 1, "exactly one payload-shape INFO line after the first turn");
    assert.match(lines[0], /messages=2/);
    assert.match(lines[0], /eligible=2/);
    assert.match(lines[0], /previousSeen=0/);
    assert.match(lines[0], /cumulative=2/);
    assert.match(lines[0], /fired=no/);

    // Turn 2: 2 more texts, cumulative should now cross minMessages(4) and
    // fire -- but the INFO line itself must NOT repeat (rate-limited to once
    // per session per process).
    await fireAgentEnd(hook, userMessages("charlie turn content", "delta turn content"), ctx);

    lines = payloadShapeLines(harness.logs);
    assert.equal(lines.length, 1, "no additional payload-shape INFO line on a later turn in the same process");
  });

  it("logs again for a different session in the same process (rate limit is per-session, not global)", async () => {
    const pluginConfig = buildPluginConfig(4);
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(hook, userMessages("alpha turn content"), { sessionKey: "agent:agent-one:webchat", agentId: "agent-one" });
    await fireAgentEnd(hook, userMessages("zulu turn content"), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    const lines = payloadShapeLines(harness.logs);
    assert.equal(lines.length, 2, "each distinct session gets its own first-turn payload-shape line");
    assert.ok(lines.some((l) => l.includes("agent:agent-one:webchat")));
    assert.ok(lines.some((l) => l.includes("agent:agent-two:main")));
  });

  it("logs again after a simulated restart (rate limit is per-process, not persisted)", async () => {
    const pluginConfig = buildPluginConfig(4);
    const ctx = { sessionKey: "agent:agent-one:webchat", agentId: "agent-one" };

    const harness1 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness1.api);
    const hook1 = getAutoCaptureHook(harness1.eventHandlers);
    await fireAgentEnd(hook1, userMessages("alpha turn content"), ctx);
    assert.equal(payloadShapeLines(harness1.logs).length, 1);

    resetRegistration();
    const harness2 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness2.api);
    const hook2 = getAutoCaptureHook(harness2.eventHandlers);
    await fireAgentEnd(hook2, userMessages("bravo turn content"), ctx);

    assert.equal(
      payloadShapeLines(harness2.logs).length,
      1,
      "a fresh process must re-emit the payload-shape line for a session it hasn't seen yet this run",
    );
  });

  it("reports fired=yes once cumulative reaches minMessages", async () => {
    const pluginConfig = buildPluginConfig(2);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(hook, userMessages("alpha turn content", "bravo turn content"), ctx);

    const lines = payloadShapeLines(harness.logs);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /cumulative=2/);
    assert.match(lines[0], /fired=yes/);
  });
});
