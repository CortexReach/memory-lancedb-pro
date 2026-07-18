/**
 * Regression test for a live-fleet finding: a "valid-empty" extraction call
 * (the LLM genuinely ran and confirmed there was nothing worth storing, not
 * a failure) does not reset autoCaptureSeenTextCount the same way a
 * successful extraction does. For ingress-fed sessions (message_received
 * feeds autoCapturePendingIngressTexts; each agent_end drains only the
 * newest message(s)) the counter is meant to be a pure accumulator that
 * resets to 0 after every genuinely-considered batch, per issue #417 Fix
 * #9's own comment ("their counter is a pure accumulator of new texts
 * toward minMessages... resetting it to 0 after a successful extraction is
 * the intended windowing behavior"). Because the valid-empty branch returns
 * before ever reaching that reset, the counter is left at whatever the
 * pre-extraction cumulative set it to, and the NEXT turn re-fires with only
 * one genuinely new message instead of waiting for a fresh windowful.
 *
 * This is pre-existing on plain master (predates every fleet-2026-07-13
 * feature branch); confirmed via `git show master:index.ts` before writing
 * this test. Fixed as a standalone branch rather than by touching any live
 * PR head.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { NoisePrototypeBank } = jiti("../src/noise-prototypes.ts");
// Deterministic one-hot embeddings can land arbitrary texts near noise
// prototypes; force the bank off so this test isolates the watermark logic.
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
 * LLM mock: the first extract-candidates call returns a genuine valid-empty
 * result (memories: []). Every call after that returns one distinct memory.
 */
function createLlmServerEmptyThenPopulated(extractionPrompts) {
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
    const memories = calls === 1
      ? []
      : [{
        category: "preferences",
        abstract: `Synthetic preference marker number ${calls}`,
        overview: `## Preference\n- Marker ${calls}`,
        content: `User stated synthetic preference marker number ${calls}.`,
      }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "mock-memory-model",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify({ memories }) },
      }],
    }));
  });
}

function appendHook(api, name, handler) {
  const existing = api.hooks[name];
  if (!existing) {
    api.hooks[name] = handler;
    return;
  }
  const handlers = existing.__handlers || [existing];
  handlers.push(handler);
  const combined = async (...args) => {
    let result;
    for (const hook of handlers) {
      result = await hook(...args);
      const backgroundRun = hook.__lastRun;
      if (backgroundRun && typeof backgroundRun.then === "function") {
        combined.__lastRun = backgroundRun;
      }
    }
    return result;
  };
  combined.__handlers = handlers;
  api.hooks[name] = combined;
}

function createMockApi(dbPath, embeddingBaseURL, llmBaseURL) {
  return {
    pluginConfig: {
      dbPath,
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
        baseURL: embeddingBaseURL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        apiKey: "test-api-key",
        model: "mock-memory-model",
        baseURL: llmBaseURL,
      },
    },
    hooks: {},
    toolFactories: {},
    services: [],
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    resolvePath(value) {
      return value;
    },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService(service) {
      this.services.push(service);
    },
    on(name, handler) {
      appendHook(this, name, handler);
    },
    registerHook(name, handler) {
      appendHook(this, name, handler);
    },
  };
}

async function runAgentEndHook(api, event, ctx) {
  await api.hooks.agent_end(event, ctx);
  const backgroundRun = api.hooks.agent_end?.__lastRun;
  if (backgroundRun && typeof backgroundRun.then === "function") {
    await backgroundRun;
  }
}

describe("auto-capture watermark reset after a valid-empty extraction (ingress flow)", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-empty-ingress-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServerEmptyThenPopulated(extractionPrompts);
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

  it("does not re-fire on a single new message after a valid-empty result (counter must reset to 0, same as a successful extraction)", async () => {
    const embeddingPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    const api = createMockApi(
      path.join(workspaceDir, "db"),
      `http://127.0.0.1:${embeddingPort}/v1`,
      `http://127.0.0.1:${llmPort}`,
    );
    memoryLanceDBProPlugin.register(api);
    const ctx = {
      channelId: "webchat",
      conversationId: "conv1",
      accountId: "default",
      sessionKey: "agent:main:webchat:conv1",
      agentId: "main",
    };

    // Turn 1: 3 texts queued via message_received (e.g. replayed history),
    // drained by one agent_end. cumulative=3 >= minMessages=2 -> extraction
    // runs; the LLM genuinely finds nothing (valid-empty), not a failure.
    await api.hooks.message_received({ from: "user:u1", content: "text one about quartz repo" }, ctx);
    await api.hooks.message_received({ from: "user:u1", content: "text two about Duckspace font" }, ctx);
    await api.hooks.message_received({ from: "user:u1", content: "text three about drive rotation" }, ctx);
    await runAgentEndHook(api, { success: true, messages: [{ role: "user", content: "text three about drive rotation" }] }, ctx);
    assert.equal(extractionPrompts.length, 1, "turn 1 must extract (valid-empty result)");

    // Turn 2: exactly ONE new message arrives. A successful extraction would
    // have reset the ingress counter to 0, requiring a fresh minMessages=2
    // window before firing again -- the valid-empty result must behave the
    // same way. It must NOT re-fire on just this one new message.
    await api.hooks.message_received({ from: "user:u1", content: "text four about Marmalade theme" }, ctx);
    await runAgentEndHook(api, { success: true, messages: [{ role: "user", content: "text four about Marmalade theme" }] }, ctx);
    assert.equal(
      extractionPrompts.length,
      1,
      "turn 2 must defer: only 1 new message since the valid-empty result, minMessages=2 not yet reached",
    );

    // Turn 3: a second new message arrives, completing the fresh window
    // (text four + text five = 2 new messages). Extraction must fire now.
    await api.hooks.message_received({ from: "user:u1", content: "text five about Cobaltvault manager" }, ctx);
    await runAgentEndHook(api, { success: true, messages: [{ role: "user", content: "text five about Cobaltvault manager" }] }, ctx);
    assert.equal(
      extractionPrompts.length,
      2,
      "turn 3 must fire: 2 new messages have now accumulated in the fresh window",
    );
  });
});
