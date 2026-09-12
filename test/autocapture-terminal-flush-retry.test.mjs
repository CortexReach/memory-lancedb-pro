/**
 * autocapture-terminal-flush-retry.test.mjs
 *
 * When a terminal flush's extraction fails, the consumed turns are handed
 * back to the deferred-flush bucket, but the session has already ended and
 * nothing else consumes that bucket. The plugin now schedules exactly one
 * unref()ed retry per session key, cancels it when a later run consumes the
 * bucket, and gives up after the retry. The tests drive the failure and let
 * the timer fire instead of emitting a second session_end by hand. Fixtures
 * are synthetic.
 *
 * Run: node --test test/autocapture-terminal-flush-retry.test.mjs
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
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const setRetryDelay = pluginModule._setAutoCaptureTerminalFlushRetryDelayMsForTest;

const EMBEDDING_DIMENSIONS = 64;
const RETRY_DELAY_MS = 40;

function hashToIndex(text, dims) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
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

// Every extraction call is recorded; the first `failures` extraction calls
// answer 401 (an upstream failure the client does not retry and the plugin
// classifies as non-transient), later ones answer one synthetic memory.
function createLlmServer(state) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");
    const isExtraction = prompt.includes("extract memories worth long-term preservation");
    if (isExtraction) {
      state.extractionCalls += 1;
      if (state.extractionCalls <= state.failures) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error" } }));
        return;
      }
    }
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
          content: JSON.stringify(
            isExtraction
              ? {
                  memories: [{
                    category: "preferences",
                    abstract: `Synthetic flush marker ${state.extractionCalls}`,
                    overview: `## Preference\n- Flush marker ${state.extractionCalls}`,
                    content: `User stated synthetic flush marker ${state.extractionCalls}.`,
                  }],
                }
              : { decision: "create", reason: "test create" },
          ),
        },
      }],
    }));
  });
}

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = { info: [], warn: [], debug: [], error: [] };
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      return path.isAbsolute(target) ? target : path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.info.push(String(message)); },
      warn(message) { logs.warn.push(String(message)); },
      debug(message) { logs.debug.push(String(message)); },
      error(message) { logs.error.push(String(message)); },
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

async function fireSessionEnd(eventHandlers, event, ctx) {
  const runs = [];
  for (const { handler } of eventHandlers.get("session_end") || []) {
    const result = handler(event, ctx);
    if (result && typeof result.then === "function") runs.push(result);
  }
  await Promise.allSettled(runs);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

const FACT_TEXT = "my synthetic greenhouse thermostat is pinned at nineteen degrees overnight.";
const CTX = {
  sessionKey: "agent:agent-one:telegram:77001",
  agentId: "agent-one",
  channelId: "telegram",
  conversationId: "77001",
};

describe("terminal flush retry", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let llmState;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "terminal-flush-retry-"));
    llmState = { extractionCalls: 0, failures: 0 };
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(llmState);
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    setRetryDelay(RETRY_DELAY_MS);
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    setRetryDelay();
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => llmServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function buildHarness() {
    return createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 4,
        extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
        sessionCompression: { enabled: false },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        embedding: {
          apiKey: "test-api-key",
          model: "mock-embedding-model",
          baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        llm: {
          apiKey: "test-api-key",
          model: "mock-memory-model",
          baseURL: `http://127.0.0.1:${llmServer.address().port}`,
        },
      },
    });
  }

  async function deferOneTurnThenEnd(harness) {
    const hook = getAutoCaptureHook(harness.eventHandlers);
    await fireAgentEnd(hook, [{ role: "user", content: FACT_TEXT }], CTX);
    assert.equal(llmState.extractionCalls, 0, "one turn under extractMinMessages defers, no extraction yet");
    await fireSessionEnd(harness.eventHandlers, { reason: "reset" }, CTX);
    return hook;
  }

  it("retries a failed terminal flush once from its own timer and persists on the retry", async () => {
    llmState.failures = 1;
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    await deferOneTurnThenEnd(harness);

    assert.equal(llmState.extractionCalls, 1, "the terminal flush extracted once and failed");
    assert.ok(
      harness.logs.warn.some((m) => m.includes("model unavailable after one retry")),
      harness.logs.warn.join("\n"),
    );
    assert.ok(
      harness.logs.info.some((m) => m.includes("one retry scheduled")),
      harness.logs.info.join("\n"),
    );

    const retried = await waitFor(() => llmState.extractionCalls >= 2);
    assert.ok(retried, "the retry timer must re-run the terminal flush without a second session_end");
    assert.ok(
      harness.logs.info.some((m) => m.includes("retrying the terminal flush")),
      harness.logs.info.join("\n"),
    );
    const persisted = await waitFor(() =>
      harness.logs.info.some((m) => /smart-extracted 1 created/.test(m)),
    );
    assert.ok(persisted, `the retried flush must persist the restored turn: ${harness.logs.info.join("\n")}`);
  });

  it("gives up after the single retry instead of looping", async () => {
    llmState.failures = 2;
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    await deferOneTurnThenEnd(harness);

    const retried = await waitFor(() => llmState.extractionCalls >= 2);
    assert.ok(retried, "the retry must fire once");
    const gaveUp = await waitFor(() =>
      harness.logs.info.some((m) => m.includes("terminal flush retry failed") && m.includes("giving up")),
    );
    assert.ok(gaveUp, harness.logs.info.join("\n"));
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 3));
    assert.equal(llmState.extractionCalls, 2, "no third attempt");
    assert.equal(
      harness.logs.info.filter((m) => m.includes("one retry scheduled")).length,
      1,
      "exactly one retry is ever scheduled per failed flush",
    );
  });

  it("cancels the pending retry when a later flush consumes the bucket", async () => {
    llmState.failures = 1;
    const harness = buildHarness();
    memoryLanceDBProPlugin.register(harness.api);
    await deferOneTurnThenEnd(harness);
    assert.equal(llmState.extractionCalls, 1);

    // A second terminal boundary for the same key consumes the restored
    // bucket before the timer fires; the retry must not run a third flush.
    await fireSessionEnd(harness.eventHandlers, { reason: "reset" }, CTX);
    assert.equal(llmState.extractionCalls, 2, "the manual flush consumed the restored turn");
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 3));
    assert.equal(llmState.extractionCalls, 2, "the cancelled retry ran no extraction");
    assert.ok(
      !harness.logs.info.some((m) => m.includes("retrying the terminal flush")),
      harness.logs.info.join("\n"),
    );
  });
});
