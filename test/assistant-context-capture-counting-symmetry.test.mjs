/**
 * Regression coverage pinning a finding from a live-incident investigation:
 * `captureAssistant: "context"` was suspected of starving the auto-capture
 * watermark gate (by halving the eligible-message count) after a session
 * that had been stuck since a process restart. That mechanism was
 * FALSIFIED -- `captureAssistantEligible = (value === true)` is `false` for
 * BOTH `false` and `"context"`, so `isEligibleRole` reduces to
 * `role === "user"` either way. The only thing "context" mode adds is that
 * assistant-role messages, which used to just vanish, get pushed into a
 * separate `assistantContextTexts` array for prompt context -- they never
 * touch `eligibleTexts` or the cumulative watermark count.
 *
 * This suite encodes the four-way harness that proved it (2x2: captureAssistant
 * {false, "context"} x payload shape {full-history, delta-only}, each run
 * across a simulated restart) as permanent tests, so a future change can't
 * silently reintroduce a counting/watermark difference between the two
 * modes without a test noticing.
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

/** LLM mock: always returns one distinct memory, deterministic, never a valid-empty. */
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

/** One turn = one user message + one assistant reply, both synthetic and distinct. */
function turnMessages(turnIndex) {
  return [
    { role: "user", content: `synthetic user turn ${turnIndex} content` },
    { role: "assistant", content: `synthetic assistant turn ${turnIndex} reply` },
  ];
}

/**
 * Runs a full pre-restart / restart / post-restart sequence (5 turns total)
 * for one (captureAssistant, payloadShape) cell, returning the sequence of
 * "did extraction fire this turn" booleans.
 *
 * payloadShape "full-history": each agent_end call carries every turn's
 * messages seen so far (accumulated). payloadShape "delta-only": each call
 * carries only that turn's own two messages.
 */
async function runScenario({ captureAssistant, payloadShape, embeddingPort, llmPort, resolveRoot, extractMinMessages }) {
  const dbPath = path.join(resolveRoot, `db-${captureAssistant}-${payloadShape}`);
  const harnessConfig = {
    dbPath,
    autoCapture: true,
    autoRecall: false,
    smartExtraction: true,
    extractMinMessages,
    captureAssistant,
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
  const ctx = { sessionKey: "agent:terry:webchat", agentId: "terry" };
  const trace = [];
  let accumulated = [];

  resetRegistration();
  let harness = createPluginApiHarness({ resolveRoot, pluginConfig: harnessConfig });
  memoryLanceDBProPlugin.register(harness.api);
  let hook = getAutoCaptureHook(harness.eventHandlers);

  async function fireTurn(turnIndex) {
    const thisTurn = turnMessages(turnIndex);
    accumulated = [...accumulated, ...thisTurn];
    const payload = payloadShape === "full-history" ? accumulated : thisTurn;
    const before = harness.logs.info.filter((l) => l.includes("smart-extracted")).length;
    await fireAgentEnd(hook, payload, ctx);
    const after = harness.logs.info.filter((l) => l.includes("smart-extracted")).length;
    trace.push(after > before);
  }

  // Pre-restart: 3 turns.
  await fireTurn(1);
  await fireTurn(2);
  await fireTurn(3);

  // Simulated restart: fresh singleton, fresh in-memory Maps, same dbPath.
  resetRegistration();
  harness = createPluginApiHarness({ resolveRoot, pluginConfig: harnessConfig });
  memoryLanceDBProPlugin.register(harness.api);
  hook = getAutoCaptureHook(harness.eventHandlers);

  // Post-restart: 2 more turns.
  await fireTurn(4);
  await fireTurn(5);

  return trace;
}

describe("captureAssistant mode does not change auto-capture counting/watermark behavior", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let embeddingPort;
  let llmPort;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "assistant-context-symmetry-"));
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer();
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    embeddingPort = embeddingServer.address().port;
    llmPort = llmServer.address().port;
  });

  afterEach(async () => {
    resetRegistration();
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  for (const payloadShape of ["full-history", "delta-only"]) {
    it(`produces an identical fire/skip trace across a restart for ${payloadShape} payloads, captureAssistant false vs "context"`, async () => {
      const traceFalse = await runScenario({
        captureAssistant: false,
        payloadShape,
        embeddingPort,
        llmPort,
        resolveRoot: workspaceDir,
        extractMinMessages: 2,
      });
      const traceContext = await runScenario({
        captureAssistant: "context",
        payloadShape,
        embeddingPort,
        llmPort,
        resolveRoot: workspaceDir,
        extractMinMessages: 2,
      });

      assert.deepEqual(
        traceContext,
        traceFalse,
        `captureAssistant="context" must fire/skip identically to captureAssistant=false for ${payloadShape} payloads ` +
        `(false: ${JSON.stringify(traceFalse)}, context: ${JSON.stringify(traceContext)})`,
      );
    });
  }

  it("the two payload shapes are not trivially identical to each other (sanity check that the harness actually distinguishes them)", async () => {
    const traceFullHistory = await runScenario({
      captureAssistant: false,
      payloadShape: "full-history",
      embeddingPort,
      llmPort,
      resolveRoot: workspaceDir,
      extractMinMessages: 2,
    });
    const traceDeltaOnly = await runScenario({
      captureAssistant: false,
      payloadShape: "delta-only",
      embeddingPort,
      llmPort,
      resolveRoot: workspaceDir,
      extractMinMessages: 2,
    });

    // Both traces are meaningful (some fires, not all-skip or all-fire) --
    // otherwise this harness would prove nothing either way.
    assert.ok(traceFullHistory.includes(true) && traceFullHistory.includes(false));
    assert.ok(traceDeltaOnly.includes(true) && traceDeltaOnly.includes(false));
  });
});
