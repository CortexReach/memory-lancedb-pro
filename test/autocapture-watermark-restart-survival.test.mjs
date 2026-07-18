/**
 * Regression coverage for restart-survivability of the auto-capture watermark
 * (`autoCaptureSeenTextCount`).
 *
 * `autoCaptureSeenTextCount` is an in-memory Map. Any plugin/process restart
 * wipes it. For a session that banks partial progress toward
 * `extractMinMessages` (via the ingress accumulator path, where a
 * below-threshold turn's tentative advance is intentionally kept rather than
 * rolled back — see the "below-threshold turns are deferred" comment this
 * suite pins in the second describe block below), a restart silently forgets
 * that progress. If the session's `agent_end` payload is delta-only (only the
 * newest turn, not the full transcript), there is no way to recover the lost
 * count from the payload itself, so the session needs strictly more new
 * messages after the restart than it would have needed without one.
 *
 * This suite proves the watermark survives a restart by persisting it
 * alongside the LanceDB store and rehydrating on the next `register()` call,
 * using the same "simulate a restart" technique as the rest of this test
 * family: `resetRegistration()` wipes the in-process singleton (including
 * every in-memory Map), then `register()` is called again against the same
 * `dbPath` — exactly what happens when the host process restarts and the
 * plugin reinitializes against its existing on-disk state.
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

function fireMessageReceived(eventHandlers, content, ctx) {
  const hooks = eventHandlers.get("message_received") || [];
  assert.ok(hooks.length >= 1, "expected at least one message_received handler");
  hooks[0].handler({ content, from: ctx.from || "user" }, ctx);
}

function userMessages(...texts) {
  return texts.map((text) => ({ role: "user", content: text }));
}

function buildPluginConfig({ workspaceDir, embeddingPort, llmPort, extractMinMessages }) {
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

describe("auto-capture watermark survives a simulated process restart", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let embeddingPort;
  let llmPort;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-restart-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer(extractionPrompts);
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

  it("an ingress-fed, delta-only session resumes counting from where it left off after a restart and fires once cumulative crosses minMessages", async () => {
    const pluginConfig = buildPluginConfig({ workspaceDir, embeddingPort, llmPort, extractMinMessages: 2 });
    const ctx = { sessionKey: "agent:agent-one:webchat", agentId: "agent-one", channelId: "webchat" };

    // --- "process 1" ---
    const harness1 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness1.api);
    const hook1 = getAutoCaptureHook(harness1.eventHandlers);

    // Turn 1: exactly one message arrives via the ingress path (message_received),
    // and agent_end's own payload is delta-only (just this turn's exchange).
    // cumulative = 0 + 1 = 1 < minMessages(2) -> deferred, not fired.
    fireMessageReceived(harness1.eventHandlers, "I keep my synthetic dotfiles in a bare repo named quartz.", ctx);
    await fireAgentEnd(
      hook1,
      userMessages("I keep my synthetic dotfiles in a bare repo named quartz."),
      ctx,
    );
    assert.equal(extractionPrompts.length, 0, "turn 1 alone must not cross minMessages yet");

    // --- simulated restart: fresh singleton, fresh in-memory Maps, same dbPath ---
    resetRegistration();
    const harness2 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness2.api);
    const hook2 = getAutoCaptureHook(harness2.eventHandlers);

    // Turn 2 (post-restart): exactly one MORE new message, still delta-only.
    // Without restart-survivability the watermark would have been wiped back
    // to 0 and this turn alone (cumulative=1) would defer again -- forever,
    // since every subsequent turn contributes the same single message. With
    // the persisted watermark rehydrated to 1, this turn's contribution
    // brings cumulative to 2 >= minMessages(2), and extraction fires.
    fireMessageReceived(harness2.eventHandlers, "My preferred terminal font is a synthetic monospace called Duckspace.", ctx);
    await fireAgentEnd(
      hook2,
      userMessages("My preferred terminal font is a synthetic monospace called Duckspace."),
      ctx,
    );

    assert.equal(
      extractionPrompts.length,
      1,
      "post-restart turn must fire once the persisted watermark's cumulative count reaches minMessages",
    );
  });

  it("a history-carrying session's slice cursor survives a restart without re-extracting already-consumed history", async () => {
    const pluginConfig = buildPluginConfig({ workspaceDir, embeddingPort, llmPort, extractMinMessages: 4 });
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const TURN_1_TEXTS = [
      "I keep my synthetic dotfiles in a bare repository named quartz.",
      "My preferred terminal font is a synthetic monospace called Duckspace.",
    ];
    const TURN_2_TEXTS = [
      "For synthetic backups I rotate three encrypted drives weekly.",
      "My synthetic editor theme of choice is called Marmalade Night.",
    ];
    const TURN_3_TEXTS = [
      "My synthetic standing desk motor brand is called Elevar.",
      "I label synthetic backup drives with constellation names.",
    ];

    // --- "process 1" ---
    const harness1 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness1.api);
    const hook1 = getAutoCaptureHook(harness1.eventHandlers);

    // Turn 1: history so far = 2 texts, cumulative=2 < minMessages(4) -> deferred.
    await fireAgentEnd(hook1, userMessages(...TURN_1_TEXTS), ctx);
    assert.equal(extractionPrompts.length, 0, "turn 1 alone must not cross minMessages yet");

    // Turn 2: history so far = 4 texts, cumulative=4 >= minMessages(4) -> fires,
    // consuming all 4 (nothing was extracted before this point).
    await fireAgentEnd(hook1, userMessages(...TURN_1_TEXTS, ...TURN_2_TEXTS), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 2 must cross minMessages and fire");

    // --- simulated restart: fresh singleton, fresh in-memory Maps, same dbPath ---
    resetRegistration();
    const harness2 = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness2.api);
    const hook2 = getAutoCaptureHook(harness2.eventHandlers);

    // Turn 3 (post-restart): history so far = 6 texts (4 already consumed + 2 new).
    // Without restart-survivability the watermark would have been wiped to 0,
    // and this turn would re-extract ALL 6 texts (re-reading the 4 that were
    // already extracted pre-restart). With the persisted cursor rehydrated to
    // 4, this turn must see only the 2 new texts.
    await fireAgentEnd(hook2, userMessages(...TURN_1_TEXTS, ...TURN_2_TEXTS, ...TURN_3_TEXTS), ctx);
    assert.equal(extractionPrompts.length, 2, "post-restart turn must fire on the delta only");

    const thirdPrompt = extractionPrompts[1];
    assert.ok(
      thirdPrompt.includes(TURN_3_TEXTS[0]) && thirdPrompt.includes(TURN_3_TEXTS[1]),
      "post-restart extraction must see the new texts",
    );
    for (const alreadyExtracted of [...TURN_1_TEXTS, ...TURN_2_TEXTS]) {
      assert.ok(
        !thirdPrompt.includes(alreadyExtracted),
        `post-restart extraction must not re-read already-extracted history: ${alreadyExtracted.slice(0, 40)}`,
      );
    }
  });
});

describe("auto-capture watermark rollback-on-skip (pinned so restart-survivability work cannot silently drop it)", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-rollback-"));
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

  it("below-threshold history-flow turns roll the cursor back so a later turn's slice still includes their content", async () => {
    const embeddingPort = embeddingServer.address().port;
    const llmPort = llmServer.address().port;
    const pluginConfig = buildPluginConfig({ workspaceDir, embeddingPort, llmPort, extractMinMessages: 6 });
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    const TURN_1 = ["Synthetic marker alpha.", "Synthetic marker bravo."];
    const TURN_2 = ["Synthetic marker charlie.", "Synthetic marker delta."];
    const TURN_3 = ["Synthetic marker echo.", "Synthetic marker foxtrot."];

    // Turn 1: cumulative=2 < 6 -> deferred; cursor rolls back to 0 (a no-op,
    // since previousSeenCount was already 0).
    await fireAgentEnd(hook, userMessages(...TURN_1), ctx);
    assert.equal(extractionPrompts.length, 0);

    // Turn 2: history so far = 4 texts. If the cursor had NOT rolled back and
    // instead advanced to a tentative 2, this turn would slice off only the 2
    // new texts (cumulative=2+2=4, still <6, still deferred, but now tracking
    // 4). Either way still deferred here -- the meaningful assertion is turn 3.
    await fireAgentEnd(hook, userMessages(...TURN_1, ...TURN_2), ctx);
    assert.equal(extractionPrompts.length, 0);

    // Turn 3: history so far = 6 texts, cumulative=6 >= 6 -> fires. Because the
    // cursor was rolled back (not tentatively advanced) on every deferred
    // turn, this extraction's input is the FULL 6-text window -- proving no
    // content from turns 1-2 was silently forfeited while deferred.
    await fireAgentEnd(hook, userMessages(...TURN_1, ...TURN_2, ...TURN_3), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 3 must cross minMessages and fire");

    const prompt = extractionPrompts[0];
    for (const text of [...TURN_1, ...TURN_2, ...TURN_3]) {
      assert.ok(prompt.includes(text), `deferred-turn content must survive to the firing extraction: ${text}`);
    }
  });
});
