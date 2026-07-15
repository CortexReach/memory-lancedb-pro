/**
 * Regression coverage for bounded injection when a session's watermark is
 * genuinely unknown (first-ever run, or persisted state lost -- see
 * test/autocapture-watermark-restart-survival.test.mjs for the
 * restart-survivability half of this story) and the agent_end payload is
 * history-carrying with far more than one batch's worth of messages.
 *
 * Without a cap, `previousSeenCount === 0` takes the unsliced default
 * (`newTexts = eligibleTexts`), so the entire transcript is handed to
 * extraction in one call -- expensive, and floods the extraction with
 * mostly-stale content. This suite proves the injected window is capped to
 * the most recent batch, the watermark jumps straight to the full length
 * (the older prefix is forfeited, not queued for a later turn), and the
 * very next turn behaves as a normal small delta.
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

describe("bounded injection when the watermark is unknown and history is large", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-unknown-watermark-"));
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

  it("caps a 40-turn history to the batch window, forfeits the rest, and resumes as a normal delta next turn", async () => {
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
        extractMaxChars: 8000,
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
    const ctx = { sessionKey: "agent:terry:webchat", agentId: "terry" };

    // A 40-message history arrives in a single agent_end call on a session
    // whose watermark has never been established (fresh Map, nothing
    // persisted) -- e.g. a long-lived session picked up for the first time
    // after the plugin was installed, or a persisted-state wipe.
    const history = Array.from({ length: 40 }, (_, i) => `synthetic turn ${i + 1} content here`);
    await fireAgentEnd(hook, userMessages(...history), ctx);

    assert.equal(extractionPrompts.length, 1, "the oversized history must still fire exactly one extraction");
    const firstPrompt = extractionPrompts[0];
    // Only the capped window (last extractMinMessages=2 texts) may appear.
    assert.ok(firstPrompt.includes("synthetic turn 39 content here"));
    assert.ok(firstPrompt.includes("synthetic turn 40 content here"));
    for (let i = 1; i <= 38; i++) {
      assert.ok(
        !firstPrompt.includes(`synthetic turn ${i} content here`),
        `forfeited turn ${i} must not appear in the capped extraction input`,
      );
    }

    // Second call: one more new message. The watermark must have jumped to
    // the FULL prior length (40, not just the 2-text window), so this turn
    // is a normal small delta -- not another oversized dump, and not a
    // re-read of the forfeited prefix.
    await fireAgentEnd(hook, userMessages(...history, "synthetic turn 41 content here"), ctx);
    assert.equal(extractionPrompts.length, 2, "the next turn's single new message must fire a normal delta extraction");
    const secondPrompt = extractionPrompts[1];
    assert.ok(secondPrompt.includes("synthetic turn 41 content here"));
    for (let i = 1; i <= 40; i++) {
      assert.ok(
        !secondPrompt.includes(`synthetic turn ${i} content here`),
        `turn 2 must not re-read forfeited or already-extracted turn ${i}`,
      );
    }
  });

  it("does not cap a session with a small, normal amount of history even with an unknown watermark", async () => {
    const embeddingPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 4,
        extractMaxChars: 8000,
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

    // Only 3 texts total, at or under minMessages(4) -- a totally normal
    // fresh session, not the "large unknown history" scenario. Must not be
    // capped or forfeit anything, and must not even fire yet.
    const smallHistory = ["alpha turn content", "bravo turn content", "charlie turn content"];
    await fireAgentEnd(hook, userMessages(...smallHistory), ctx);
    assert.equal(extractionPrompts.length, 0, "a small fresh history under minMessages must simply defer, not fire");
  });
});
