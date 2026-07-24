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
});
