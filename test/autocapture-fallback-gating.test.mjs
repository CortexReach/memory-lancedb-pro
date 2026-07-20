/**
 * Regression tests for regex-fallback gating in the agent_end auto-capture
 * hook.
 *
 * The hook falls back to legacy regex-triggered capture (raw text stored
 * verbatim) whenever the smart extractor does not handle a turn. Two trigger
 * paths existed:
 *
 * - Path 1 (minMessages not met): the extractor never ran, so the very first
 *   rich message of a fresh session could be bulkStored verbatim, bypassing
 *   the entire grounding + admission stack. With smart extraction enabled the
 *   fallback is now skipped and the turn deferred: the slice cursor is rolled
 *   back for history-carrying sessions so the next turn's extraction input
 *   re-includes the deferred texts.
 * - Path 2 (fallback actually runs: smart extraction disabled, or the
 *   boundary-skip continuation): each capture is now routed through the same
 *   admission gate as extraction candidates when admission control is
 *   enabled.
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
const { gateRegexFallbackCapture } = jiti("../src/autocapture-fallback-admission.ts");
// One-hot embeddings can land arbitrary texts near noise prototypes; force
// the bank off for determinism.
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
 * LLM mock distinguishing calls by prompt shape:
 * - extract-candidates prompts (contain "## Recent Conversation") return
 *   `extractMemories` (a function of the call index, or a fixed array) and
 *   are recorded in `extractionPrompts`.
 * - admission-utility prompts (contain "Evaluate whether this candidate")
 *   return `utilityScore`.
 */
function createLlmServer({ extractionPrompts, extractMemories, utilityScore = 0.9 }) {
  let extractCalls = 0;
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");

    let content;
    if (prompt.includes("Evaluate whether this candidate")) {
      content = JSON.stringify({ utility: utilityScore, reason: "mock utility" });
    } else if (prompt.includes("## Recent Conversation")) {
      extractionPrompts.push(prompt);
      extractCalls += 1;
      const memories = typeof extractMemories === "function" ? extractMemories(extractCalls) : extractMemories;
      content = JSON.stringify({ memories });
    } else {
      // dedup/merge or anything else: create
      content = JSON.stringify({ decision: "create", reason: "mock" });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "mock-memory-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
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

const PREFERENCE_TEXT = "I prefer synthetic tabs over spaces for all my projects.";
const SECOND_TEXT = "I also like a synthetic monospace font called Duckspace.";
const IDENTITY_TEXT = "My name is Sam Rivera and I like puzzle games in the evening.";

describe("regex-fallback gating (Path 1: minMessages not met)", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "fallback-gating-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => [{
        category: "preferences",
        abstract: `Synthetic preference marker number ${n}`,
        overview: `## Preference\n- Marker ${n}`,
        content: `User stated synthetic preference marker number ${n}.`,
      }],
    });
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

  function smartConfig(overrides = {}) {
    return {
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
        baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        apiKey: "test-api-key",
        model: "mock-memory-model",
        baseURL: `http://127.0.0.1:${llmServer.address().port}`,
      },
      ...overrides,
    };
  }

  it("skips the regex fallback for a below-threshold turn when smart extraction is enabled", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: smartConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    // One rich first message: cumulative=1 < minMessages=2.
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 0, "smart extraction must not run below the threshold");
    assert.ok(
      !harness.logs.info.some((l) => l.includes("regex fallback found")),
      "the regex fallback must not run when smart extraction is enabled",
    );
    assert.ok(
      !harness.logs.info.some((l) => l.includes("auto-captured")),
      "nothing may be stored verbatim from a below-threshold turn",
    );
    assert.ok(
      harness.logs.debug.some((l) => l.includes("regex fallback skipped")),
      "the skip must be debug-logged",
    );
  });

  it("re-includes the deferred texts in the next turn's extraction input (history flow)", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: smartConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // Turn 1: below threshold, deferred.
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0);

    // Turn 2: agent_end carries the full history (deferred + new text).
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ctx);
    assert.equal(extractionPrompts.length, 1, "the threshold is met on turn 2");
    assert.ok(
      extractionPrompts[0].includes(PREFERENCE_TEXT),
      "the deferred turn-1 text must be part of the turn-2 extraction input",
    );
    assert.ok(
      extractionPrompts[0].includes(SECOND_TEXT),
      "the new turn-2 text must be part of the turn-2 extraction input",
    );
  });

  it("re-queues deferred ingress texts so a later turn's extraction sees all of them (ingress flow)", async () => {
    // Distinct from the "history flow" test above: an ingress-fed session has no
    // external transcript to re-read on the next turn, so the accumulator rollback
    // that works for history-carrying sessions cannot apply here. Before the fix,
    // pendingIngressTexts was consumed and deleted on every below-threshold turn
    // with nothing to replace it: the counter advanced correctly, but the actual
    // text content of every deferred turn except the last was silently lost.
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: smartConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const messageReceivedHooks = (harness.eventHandlers.get("message_received") || []).map((h) => h.handler);
    assert.ok(messageReceivedHooks.length > 0, "expected at least one message_received handler");

    const ingressCtx = { channelId: "synthchat", conversationId: "conv1" };
    const sessionKey = "agent:agent-two:synthchat:conv1";

    function fireMessageReceived(text) {
      for (const handler of messageReceivedHooks) {
        handler({ content: text, from: "agent-two" }, ingressCtx);
      }
    }

    // Turn 1: one ingress message queued, then agent_end fires. The hook requires a
    // non-empty event.messages to run at all, but pendingIngressTexts fully overrides
    // eligibleTexts once present, so a trivial placeholder message's own content never
    // reaches extraction and does not affect the count. Below threshold, deferred.
    fireMessageReceived(PREFERENCE_TEXT);
    await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), { sessionKey, agentId: "agent-two" });
    assert.equal(extractionPrompts.length, 0, "turn 1 alone must stay below the threshold");

    // Turn 2: a second ingress message arrives. If turn 1's text was lost (the
    // pre-fix bug), only SECOND_TEXT would be visible here.
    fireMessageReceived(SECOND_TEXT);
    await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), { sessionKey, agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 1, "the threshold is met on turn 2");
    assert.ok(
      extractionPrompts[0].includes(PREFERENCE_TEXT),
      "turn 1's deferred ingress text must still reach extraction on turn 2, not just turn 2's own text",
    );
    assert.ok(
      extractionPrompts[0].includes(SECOND_TEXT),
      "turn 2's own ingress text must also reach extraction",
    );
  });

  it("preserves the legacy fallback when smart extraction is disabled (pin)", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: smartConfig({ smartExtraction: false }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    assert.ok(
      harness.logs.info.some((l) => l.includes("regex fallback found 1 capturable text")),
      "with smart extraction disabled the legacy fallback must still run",
    );
    assert.ok(
      harness.logs.info.some((l) => l.includes("auto-captured 1 memories")),
      "with smart extraction disabled the legacy fallback must still store",
    );
  });

  it("gates the boundary-skip continuation path through admission (Path 2, end to end)", async () => {
    // Extraction returns only a profile candidate; with the workspace
    // boundary enabled it is boundary-skipped (created=0, boundarySkipped=1),
    // which is the one remaining route into the regex fallback while smart
    // extraction is enabled. Admission is tuned to deterministically reject
    // (utility 0 from the mock, floor-low durable priors).
    llmServer.removeAllListeners("request");
    const rejectingLlm = createLlmServer({
      extractionPrompts,
      utilityScore: 0,
      extractMemories: [{
        category: "profile",
        abstract: "User canonical name: Sam Rivera",
        overview: "## Background\n- Name: Sam Rivera",
        content: "The user's name is Sam Rivera.",
      }],
    });
    // Reuse the already-bound port by attaching the new handler to the old server.
    llmServer.on("request", (req, res) => rejectingLlm.emit("request", req, res));

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: smartConfig({
        extractMinMessages: 1,
        workspaceBoundary: { userMdExclusive: { enabled: true } },
        admissionControl: {
          enabled: true,
          preset: "balanced",
          typePriors: { profile: 0.01, preferences: 0.01, entities: 0.01, events: 0.01, cases: 0.01, patterns: 0.01 },
        },
      }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    // Two texts: the identity text drives extraction's boundary skip (and is
    // itself skipped by the fallback's own USER.md-exclusive check); the
    // preference text reaches the fallback's admission gate.
    await fireAgentEnd(hook, userMessages(IDENTITY_TEXT, PREFERENCE_TEXT), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    assert.equal(extractionPrompts.length, 1, "smart extraction must run (threshold 1)");
    assert.ok(
      harness.logs.info.some((l) => l.includes("continuing to regex fallback")),
      "the boundary-skip continuation must be taken",
    );
    assert.ok(
      harness.logs.info.some((l) => l.includes("admission rejected regex-fallback capture")),
      "the fallback capture must be admission-rejected",
    );
    assert.ok(
      !harness.logs.info.some((l) => l.includes("auto-captured")),
      "a rejected fallback capture must not be stored",
    );
  });
});

describe("gateRegexFallbackCapture (Path 2 unit)", () => {
  const baseParams = {
    text: PREFERENCE_TEXT,
    storeCategory: "preference",
    vector: [1, 0, 0],
    conversationText: PREFERENCE_TEXT,
    scopeFilter: ["global"],
  };

  it("passes captures through untouched when no admission controller exists", async () => {
    const result = await gateRegexFallbackCapture({
      ...baseParams,
      admissionController: null,
      attachAudit: true,
    });
    assert.deepEqual(result, { admit: true }, "no controller (admission off, or smart extraction off) must preserve legacy behavior");
  });

  it("drops captures the controller rejects, surfacing the audit reason", async () => {
    const controller = {
      async evaluate() {
        return { decision: "reject", audit: { decision: "reject", reason: "Admission rejected (0.100 < 0.450)." } };
      },
    };
    const result = await gateRegexFallbackCapture({ ...baseParams, admissionController: controller, attachAudit: true });
    assert.equal(result.admit, false);
    assert.match(result.reason, /Admission rejected/);
  });

  it("admits passing captures with fallback provenance in the audit, scored under the mapped smart register", async () => {
    let seenCandidate = null;
    const controller = {
      async evaluate(params) {
        seenCandidate = params.candidate;
        return { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "Admission passed (0.800)." } };
      },
    };
    const result = await gateRegexFallbackCapture({ ...baseParams, admissionController: controller, attachAudit: true });
    assert.equal(result.admit, true);
    const audit = JSON.parse(result.auditJson);
    assert.equal(audit.provenance, "auto-capture-regex-fallback");
    assert.equal(seenCandidate.category, "preferences", "legacy store category must be scored under its smart register");
  });

  it("omits the audit when auditMetadata persistence is off", async () => {
    const controller = {
      async evaluate() {
        return { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "ok" } };
      },
    };
    const result = await gateRegexFallbackCapture({ ...baseParams, admissionController: controller, attachAudit: false });
    assert.equal(result.admit, true);
    assert.equal(result.auditJson, undefined);
  });

  it("fails open when the admission evaluation throws", async () => {
    const warnings = [];
    const controller = { async evaluate() { throw new Error("vector store unavailable"); } };
    const result = await gateRegexFallbackCapture({
      ...baseParams,
      admissionController: controller,
      attachAudit: true,
      warnLog: (msg) => warnings.push(msg),
    });
    assert.equal(result.admit, true);
    assert.match(result.reason, /failed open/);
    assert.equal(warnings.length, 1);

    // A fail-open admit still needs durable, queryable provenance on the persisted
    // row itself (the ephemeral warnLog line above is never stored) so this row is
    // distinguishable from a normally-scored admit later.
    assert.ok(result.auditJson, "expected a synthesized audit record on the fail-open path");
    const audit = JSON.parse(result.auditJson);
    assert.equal(audit.failedOpen, true);
    assert.equal(audit.provenance, "auto-capture-regex-fallback");
    assert.match(audit.error, /vector store unavailable/);
  });

  it("omits the fail-open audit when auditMetadata persistence is off", async () => {
    const controller = { async evaluate() { throw new Error("vector store unavailable"); } };
    const result = await gateRegexFallbackCapture({
      ...baseParams,
      admissionController: controller,
      attachAudit: false,
    });
    assert.equal(result.admit, true);
    assert.equal(result.auditJson, undefined);
  });
});
