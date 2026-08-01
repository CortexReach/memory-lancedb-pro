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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const { MemoryStore } = jiti("../src/store.ts");
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
function createLlmServer({ extractionPrompts, extractMemories, utilityScore = 0.9, extractionGate }) {
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
      if (typeof extractionGate === "function") {
        await extractionGate(prompt, extractCalls);
      }
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

describe("standalone admission when smart extraction is off (Path 3)", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;
  let utilityScore;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "fallback-standalone-"));
    extractionPrompts = [];
    utilityScore = 0;
    embeddingServer = createEmbeddingServer();
    llmServer = http.createServer((req, res) => {
      createLlmServer({ extractionPrompts, extractMemories: [], utilityScore }).emit("request", req, res);
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

  function offConfig(admissionControl) {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: false,
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
      admissionControl,
    };
  }

  it("admission-rejects fallback captures with smartExtraction=false (previously an unconditional bypass) and persists the rejected audit", async () => {
    utilityScore = 0;
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: offConfig({
        enabled: true,
        preset: "balanced",
        persistRejectedAudits: true,
        typePriors: { profile: 0.01, preferences: 0.01, entities: 0.01, events: 0.01, cases: 0.01, patterns: 0.01 },
      }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    assert.ok(
      harness.logs.info.some((l) => l.includes("admission control constructed for capture fallbacks")),
      "the standalone controller must be constructed when smart extraction is off",
    );
    assert.ok(
      harness.logs.info.some((l) => l.includes("admission rejected regex-fallback capture")),
      "the fallback capture must be admission-rejected without a SmartExtractor to borrow from",
    );
    assert.ok(
      !harness.logs.info.some((l) => l.includes("auto-captured")),
      "a rejected fallback capture must not be stored",
    );

    const auditFile = path.join(workspaceDir, "admission-audit", "rejections.jsonl");
    assert.ok(existsSync(auditFile), "the rejected admission audit must be persisted for fallback rejections");
    const auditContent = readFileSync(auditFile, "utf8");
    assert.ok(auditContent.includes('"decision":"reject"'), "the persisted audit must carry the reject decision");
    assert.ok(
      auditContent.includes("synthetic tabs over spaces"),
      "the persisted audit must describe the rejected fallback candidate",
    );
  });

  it("stores fallback captures the standalone controller admits", async () => {
    utilityScore = 0.9;
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: offConfig({
        enabled: true,
        preset: "balanced",
        typePriors: { profile: 0.9, preferences: 0.9, entities: 0.9, events: 0.9, cases: 0.9, patterns: 0.9 },
      }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), { sessionKey: "agent:agent-two:main", agentId: "agent-two" });

    assert.ok(
      !harness.logs.info.some((l) => l.includes("admission rejected regex-fallback capture")),
      "an admitted capture must not be rejected",
    );
    assert.ok(
      harness.logs.info.some((l) => l.includes("auto-captured 1 memories")),
      "an admitted fallback capture must still be stored",
    );
  });
});

describe("terminal flush of deferred captures at session_end", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "fallback-flush-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => [{
        category: "preferences",
        abstract: `Synthetic flush marker number ${n}`,
        overview: `## Preference\n- Flush marker ${n}`,
        content: `User stated synthetic flush marker number ${n}.`,
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

  function flushConfig(overrides = {}) {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 4,
      sessionStrategy: "none",
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

  async function fireSessionEnd(harness, hook, ctx) {
    for (const { handler } of harness.eventHandlers.get("session_end") || []) {
      handler({}, ctx);
    }
    const run = hook.__lastRun;
    if (run && typeof run.then === "function") {
      await run;
    }
  }

  const REMEMBER_TEXT = "Please remember that my synthetic badge code is Duckhouse-77.";

  // An explicit remember command is a user instruction, not thin chatter, so it
  // must not wait on a future lifecycle event that may never arrive (absent
  // session_end, a restart, or shutdown winning the race). minMessages exists to
  // avoid extracting from low-value turns; it is not a reason to hold an explicit
  // request. These pin the immediate path, which still runs through smart
  // extraction (grounding filter and admission control), never the raw regex
  // fallback.
  it("extracts an explicit remember command immediately, without waiting for a lifecycle event", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // Turn 1: the fact alone stays below the threshold and is deferred.
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "a lone fact below the threshold still defers");

    // Turn 2: the bare command. Cumulative is 2 of 4, so the old path deferred
    // this too and the request lived only in a process-local map.
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, "remember this"), ctx);
    assert.equal(
      extractionPrompts.length,
      1,
      "an explicit remember request must reach extraction on its own turn",
    );
    assert.ok(
      extractionPrompts[0].includes(PREFERENCE_TEXT),
      "and it must carry the referenced fact, not just the command",
    );
    assert.ok(
      !harness.logs.info.some((l) => l.includes("regex fallback found")),
      "the immediate path must not route through the raw regex fallback",
    );
  });

  it("does not admit a turn whose only texts are remember commands", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // Two commands are not a command plus a referent: counting array length
    // alone would admit this and extract from imperatives with no content.
    // Both forms must be ones the command matcher actually recognizes ("remember
    // this too" would be a referent, since the matcher only accepts the bare
    // imperative).
    await fireAgentEnd(hook, userMessages("remember this", "remember"), ctx);
    assert.equal(
      extractionPrompts.length,
      0,
      "a turn carrying only commands has no referent and must stay deferred",
    );
  });

  it("does not admit a turn whose referent the noise filter removes", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // Static noise filtering runs AFTER eligibility is decided, and this
    // complaint class is exactly what precedes an explicit command. If
    // eligibility is judged before the filter, extraction runs on the bare
    // command alone.
    await fireAgentEnd(
      hook,
      userMessages("you never remember anything I say", "remember this"),
      ctx,
    );
    assert.equal(
      extractionPrompts.length,
      0,
      "eligibility must be judged on the texts that survive filtering, not the raw turn",
    );
  });

  it("keeps a concurrently deferred text when an overlapping immediate extraction finishes", async () => {
    const FACT_A = "I prefer synthetic gearbox ratio alpha for all my projects.";
    const FACT_B = "My synthetic backup drive rotation is three disks weekly.";
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    await new Promise((resolve) => llmServer.close(resolve));
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => [{
        category: "preferences",
        abstract: `Synthetic race marker ${n}`,
        overview: `## Preference\n- Race marker ${n}`,
        content: `User stated synthetic race marker ${n}.`,
      }],
      extractionGate: async (prompt) => {
        if (prompt.includes(FACT_A) && !prompt.includes(FACT_B)) {
          await gate;
        }
      },
    });
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // Turn 1 takes the immediate remember path and suspends inside extraction.
    hook({ success: true, messages: userMessages(FACT_A, "remember this") }, ctx);
    const firstRun = hook.__lastRun;
    const waitDeadline = Date.now() + 3000;
    while (!extractionPrompts.some((p) => p.includes(FACT_A))) {
      assert.ok(Date.now() < waitDeadline, "timed out waiting for the gated extraction to start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Turn 2 lands below the threshold WHILE turn 1 is still awaiting, so it
    // deposits FACT_B into the same deferred bucket turn 1 is about to retire.
    await fireAgentEnd(hook, userMessages(FACT_A, "remember this", FACT_B), ctx);

    releaseGate();
    if (firstRun && typeof firstRun.then === "function") await firstRun;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The terminal flush is the only remaining consumer of FACT_B.
    await fireSessionEnd(harness, hook, ctx);
    assert.ok(
      extractionPrompts.some((p) => p.includes(FACT_B)),
      "a text deferred during an overlapping extraction must survive to the terminal flush",
    );
  });

  it("does not treat a bare remember command with nothing to remember as extractable", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages("remember this"), ctx);
    assert.equal(
      extractionPrompts.length,
      0,
      "a command with no referent has no content to extract and must stay deferred",
    );
  });

  it("keeps a same-turn remember request recoverable when its immediate extraction is barren (history flow)", async () => {
    // A completed extraction that persists nothing (the LLM returns zero
    // candidates, or admission rejects them all) is not a failure, so the
    // failure-path restore does not run. This exit consumed its inputs before
    // the await (slice cursor advanced) and used to deposit nothing on the
    // way out: a same-turn "remember this" whose first extraction came back
    // empty ended with zero rows AND zero retries — strictly weaker than
    // ordinary below-threshold chatter, which at least reaches the terminal
    // flush.
    await new Promise((resolve) => llmServer.close(resolve));
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => (n === 1 ? [] : [{
        category: "preferences",
        abstract: "Synthetic barren retry marker alpha",
        overview: "## Preference\n- Barren retry marker alpha",
        content: "User stated synthetic barren retry marker alpha.",
      }]),
    });
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    // One turn: referent and command together, below the threshold, admitted
    // by the immediate path. The extraction completes but yields nothing.
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, "remember this"), ctx);
    assert.equal(extractionPrompts.length, 1, "the immediate path must run extraction on its turn");

    // The terminal flush is the retry venue for history-carrying sessions.
    await fireSessionEnd(harness, hook, ctx);
    assert.equal(
      extractionPrompts.length,
      2,
      "a barren immediate extraction must leave its texts for the terminal flush to retry",
    );
    assert.ok(
      extractionPrompts[1].includes(PREFERENCE_TEXT),
      "the retried extraction must carry the referenced fact",
    );

    const verifyStore = new MemoryStore({ dbPath: path.join(workspaceDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    const rows = await verifyStore.list(undefined, undefined, 50, 0);
    const retried = rows.filter((row) => String(row.text ?? "").includes("Synthetic barren retry marker alpha"));
    assert.equal(retried.length, 1, "the retried flush must persist the remembered fact exactly once");
  });

  it("requeues pending ingress texts when their immediate extraction is barren (ingress flow)", async () => {
    // Ingress-fed sessions have no transcript to re-slice: the pending queue
    // is deleted before the extraction awaits, so a barren pass that requeues
    // nothing has destroyed the only copy of the request.
    await new Promise((resolve) => llmServer.close(resolve));
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => (n === 1 ? [] : [{
        category: "preferences",
        abstract: "Synthetic barren retry marker beta",
        overview: "## Preference\n- Barren retry marker beta",
        content: "User stated synthetic barren retry marker beta.",
      }]),
    });
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 4 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const messageReceivedHooks = (harness.eventHandlers.get("message_received") || []).map((h) => h.handler);
    assert.ok(messageReceivedHooks.length > 0, "expected at least one message_received handler");
    const ingressCtx = { channelId: "synthchat", conversationId: "conv1" };
    const sessionCtx = { sessionKey: "agent:agent-two:synthchat:conv1", agentId: "agent-two" };

    for (const handler of messageReceivedHooks) {
      handler({ content: PREFERENCE_TEXT, from: "agent-two" }, ingressCtx);
      handler({ content: "remember this", from: "agent-two" }, ingressCtx);
    }
    await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), sessionCtx);
    assert.equal(extractionPrompts.length, 1, "the immediate path must run extraction on the pending texts");

    // Nothing new arrives; the requeued texts alone must drive the retry.
    await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), sessionCtx);
    assert.equal(
      extractionPrompts.length,
      2,
      "a barren pass must requeue the pending ingress texts for the next turn to retry",
    );
    assert.ok(
      extractionPrompts[1].includes(PREFERENCE_TEXT),
      "the retried extraction must still carry the referenced fact",
    );

    const verifyStore = new MemoryStore({ dbPath: path.join(workspaceDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    const rows = await verifyStore.list(undefined, undefined, 50, 0);
    const retried = rows.filter((row) => String(row.text ?? "").includes("Synthetic barren retry marker beta"));
    assert.equal(retried.length, 1, "the retry must persist the remembered fact exactly once");
  });

  it("returns the terminal flush promise from session_end so an awaiting host gets the guarantee", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "the turn defers");

    const handlers = (harness.eventHandlers.get("session_end") || []).map((h) => h.handler);
    assert.ok(handlers.length > 0, "a session_end handler must be registered");
    const returned = handlers.map((handler) => handler({}, ctx));
    assert.ok(
      returned.some((value) => value && typeof value.then === "function"),
      "session_end must return its flush promise rather than detaching it",
    );
    await Promise.all(returned);
    assert.equal(
      extractionPrompts.length,
      1,
      "awaiting only the returned value must be sufficient for the flush to have run",
    );
  });

  it("flushes a one-turn ingress session's deferred remember request exactly once (storage level)", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const messageReceivedHooks = (harness.eventHandlers.get("message_received") || []).map((h) => h.handler);
    const ingressCtx = { channelId: "synthchat", conversationId: "conv1" };
    const sessionCtx = { sessionKey: "agent:agent-two:synthchat:conv1", agentId: "agent-two" };

    for (const handler of messageReceivedHooks) {
      handler({ content: REMEMBER_TEXT, from: "agent-two" }, ingressCtx);
    }
    await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), sessionCtx);
    assert.equal(extractionPrompts.length, 0, "a one-turn session must stay below the threshold");

    await fireSessionEnd(harness, hook, sessionCtx);
    assert.equal(extractionPrompts.length, 1, "session_end must flush the deferred text through extraction");
    assert.ok(
      extractionPrompts[0].includes(REMEMBER_TEXT),
      "the flushed extraction input must contain the deferred remember request",
    );

    await fireSessionEnd(harness, hook, sessionCtx);
    assert.equal(extractionPrompts.length, 1, "a second session_end must not re-flush (exactly-once)");

    const verifyStore = new MemoryStore({ dbPath: path.join(workspaceDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    const rows = await verifyStore.list(undefined, undefined, 50, 0);
    const flushed = rows.filter((row) => String(row.text ?? "").includes("Synthetic flush marker"));
    assert.equal(flushed.length, 1, "exactly one memory row may exist for the flushed request");
  });

  it("flushes deferred history texts at session end", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "two texts stay below minMessages=4");

    await fireSessionEnd(harness, hook, ctx);
    assert.equal(extractionPrompts.length, 1, "session_end must flush the deferred history texts");
    assert.ok(extractionPrompts[0].includes(PREFERENCE_TEXT));
    assert.ok(extractionPrompts[0].includes(SECOND_TEXT));
  });

  it("does not re-extract history a threshold extraction already consumed", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: flushConfig({ extractMinMessages: 2 }),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "turn 1 defers below the threshold");
    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ctx);
    assert.equal(extractionPrompts.length, 1, "turn 2 extracts at the threshold");

    await fireSessionEnd(harness, hook, ctx);
    assert.equal(
      extractionPrompts.length,
      1,
      "session_end must not re-extract deferred texts an earlier extraction already consumed",
    );
  });

  it("no-ops a session_end with nothing deferred", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireSessionEnd(harness, hook, { sessionKey: "agent:agent-two:main", agentId: "agent-two" });
    assert.equal(extractionPrompts.length, 0, "nothing deferred means nothing to flush");
  });

  it("flushes deferred texts when agent_end and session_end carry disjoint session identifiers", async () => {
    // A supported asymmetric lifecycle shape: the per-turn prompt-build hook
    // sees BOTH identifiers, agent_end then arrives with only the sessionKey,
    // and the terminal session_end carries only the lifecycle sessionId. The
    // sessionId->sessionKey alias must be learned wherever both ids co-occur;
    // an alias learned only from an agent_end that happens to carry both
    // leaves the flush keyed on the raw sessionId, awaiting an empty in-flight
    // set and flushing an empty bucket - every deferred text silently strands.
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const sessionKey = "agent:agent-two:synthchat:conv2";
    const sessionId = "lifecycle-session-0001";

    for (const { handler } of harness.eventHandlers.get("before_prompt_build") || []) {
      await handler({ prompt: "", messages: [] }, { sessionKey, sessionId, agentId: "agent-two" });
    }

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT), { sessionKey, agentId: "agent-two" });
    assert.equal(extractionPrompts.length, 0, "the turn defers below the threshold");

    await fireSessionEnd(harness, hook, { sessionId, agentId: "agent-two" });
    assert.equal(
      extractionPrompts.length,
      1,
      "a sessionId-only session_end must resolve the alias and flush the deferred text exactly once",
    );
    assert.ok(
      extractionPrompts[0].includes(PREFERENCE_TEXT),
      "the flushed extraction input must contain the deferred turn text",
    );

    await fireSessionEnd(harness, hook, { sessionId, agentId: "agent-two" });
    assert.equal(extractionPrompts.length, 1, "a second sessionId-only session_end must not re-flush");
  });

  it("serializes the terminal flush behind its own session's in-flight extraction under concurrent sessions", async () => {
    const A_MARKER = "synthetic gearbox ratio preference alpha";
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    // Swap in an LLM server whose extraction responses hang while the gate is
    // held, but only for session A's marker text; session B stays fast.
    await new Promise((resolve) => llmServer.close(resolve));
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => [{
        category: "preferences",
        abstract: `Synthetic interleave marker ${n}`,
        overview: `## Preference\n- Interleave marker ${n}`,
        content: `User stated synthetic interleave marker ${n}.`,
      }],
      extractionGate: async (prompt) => {
        if (prompt.includes(A_MARKER)) {
          await gate;
        }
      },
    });
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    try {
      const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
      memoryLanceDBProPlugin.register(harness.api);
      const hook = getAutoCaptureHook(harness.eventHandlers);
      const ctxA = { sessionKey: "agent:agent-one:synthchat:convA", agentId: "agent-one" };
      const ctxB = { sessionKey: "agent:agent-two:synthchat:convB", agentId: "agent-two" };
      const aHistory = [
        `I prefer ${A_MARKER} for all my synthetic projects.`,
        "Second synthetic note about duck-themed editor fonts.",
        "Third synthetic note about four-space indentation.",
        "Fourth synthetic note about tiling window layouts.",
      ];

      // A turn 1: below threshold, defers the marker text for a terminal flush.
      await fireAgentEnd(hook, userMessages(aHistory[0]), ctxA);
      assert.equal(extractionPrompts.length, 0, "A's first turn must stay below the threshold");

      // A turn 2: the full history crosses the threshold; the extraction hangs
      // on the gate while A's deferred texts are not yet consumed.
      hook({ success: true, messages: userMessages(...aHistory) }, ctxA);
      const waitDeadline = Date.now() + 2000;
      while (!extractionPrompts.some((p) => p.includes(A_MARKER))) {
        assert.ok(Date.now() < waitDeadline, "timed out waiting for A's extraction to reach the LLM server");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // B: a concurrent session extracts and completes while A hangs.
      await fireAgentEnd(hook, userMessages(
        "B synthetic note one about badge printer trays.",
        "B synthetic note two about lobby plant watering.",
        "B synthetic note three about kettle descaling.",
        "B synthetic note four about stapler refills.",
      ), ctxB);
      assert.equal(extractionPrompts.length, 2, "A held and B completed must be the only extractions so far");

      // A's session_end arrives while A's extraction is still in flight. It
      // must wait for A's own run, not for B's already-settled run.
      for (const { handler } of harness.eventHandlers.get("session_end") || []) {
        handler({}, ctxA);
      }
      const flushSeam = hook.__lastRun;
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(
        extractionPrompts.length,
        2,
        "the terminal flush must not run while the same session's extraction is in flight",
      );

      releaseGate();
      await flushSeam;

      const aPrompts = extractionPrompts.filter((p) => p.includes(A_MARKER));
      assert.equal(aPrompts.length, 1, "A's deferred text must be extracted exactly once");
      assert.equal(extractionPrompts.length, 2, "the terminal flush must find nothing left to re-extract");
    } finally {
      releaseGate();
    }
  });

  it("flushes when session_end carries only the lifecycle sessionId (real payload shape)", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ingressCtx = {
      sessionKey: "agent:agent-two:synthchat:convReal",
      sessionId: "session-id-real-1",
      agentId: "agent-two",
    };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ingressCtx);
    assert.equal(extractionPrompts.length, 0, "two texts stay below minMessages=4");

    await fireSessionEnd(harness, hook, { sessionId: "session-id-real-1", agentId: "agent-two" });
    assert.equal(
      extractionPrompts.length,
      1,
      "a session_end payload carrying only sessionId must still dispatch the terminal flush",
    );
    assert.ok(extractionPrompts[0].includes(PREFERENCE_TEXT));
  });

  it("flushes on a host that keys both hooks by sessionId alone", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionId: "session-id-only-1", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "two texts stay below minMessages=4");

    await fireSessionEnd(harness, hook, ctx);
    assert.equal(
      extractionPrompts.length,
      1,
      "sessionId-only ingress and session_end must resolve to the same capture bucket",
    );
    assert.ok(extractionPrompts[0].includes(PREFERENCE_TEXT));
  });

  it("restores deferred texts when the flush extraction fails, so a later flush can retry", async () => {
    await new Promise((resolve) => llmServer.close(resolve));
    llmServer = createLlmServer({
      extractionPrompts,
      // Call 1 returns a malformed extraction payload (memories: null), the
      // shape a null/exhausted LLM completion produces; call 2 succeeds.
      extractMemories: (n) => (n === 1 ? null : [{
        category: "preferences",
        abstract: "Synthetic retry marker",
        overview: "## Preference\n- Retry marker",
        content: "User stated the synthetic retry marker.",
      }]),
    });
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: flushConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:main", agentId: "agent-two" };

    await fireAgentEnd(hook, userMessages(PREFERENCE_TEXT, SECOND_TEXT), ctx);
    assert.equal(extractionPrompts.length, 0, "two texts stay below minMessages=4");

    await fireSessionEnd(harness, hook, ctx);
    assert.equal(extractionPrompts.length, 1, "the first flush must reach the extractor");

    await fireSessionEnd(harness, hook, ctx);
    assert.equal(
      extractionPrompts.length,
      2,
      "a failed flush extraction must restore the deferred texts so the next flush retries them",
    );
    assert.ok(
      extractionPrompts[1].includes(PREFERENCE_TEXT),
      "the retried flush must carry the texts the failed attempt consumed",
    );
  });
});

describe("unique-ingress counting toward extractMinMessages", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "fallback-counting-"));
    extractionPrompts = [];
    embeddingServer = createEmbeddingServer();
    llmServer = createLlmServer({
      extractionPrompts,
      extractMemories: (n) => [{
        category: "preferences",
        abstract: `Synthetic counting marker number ${n}`,
        overview: `## Preference\n- Counting marker ${n}`,
        content: `User stated synthetic counting marker number ${n}.`,
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

  function countingConfig(extractMinMessages) {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages,
      sessionStrategy: "none",
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
    };
  }

  function ingressTexts(count) {
    return Array.from({ length: count }, (_, idx) => `Synthetic unique ingress note number ${idx + 1} about topic ${String.fromCharCode(65 + idx)}.`);
  }

  async function runIngressTurns(harness, hook, texts) {
    const messageReceivedHooks = (harness.eventHandlers.get("message_received") || []).map((h) => h.handler);
    const ingressCtx = { channelId: "synthchat", conversationId: "conv1" };
    const sessionCtx = { sessionKey: "agent:agent-two:synthchat:conv1", agentId: "agent-two" };
    const promptCountAfterTurn = [];
    for (const text of texts) {
      for (const handler of messageReceivedHooks) {
        handler({ content: text, from: "agent-two" }, ingressCtx);
      }
      await fireAgentEnd(hook, userMessages("(assistant turn placeholder)"), sessionCtx);
      promptCountAfterTurn.push(extractionPrompts.length);
    }
    return promptCountAfterTurn;
  }

  it("counts each requeued ingress text once: three unique messages extract on turn 3, not turn 2", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: countingConfig(3) });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const texts = ingressTexts(3);

    const promptCounts = await runIngressTurns(harness, hook, texts);
    assert.deepEqual(
      promptCounts,
      [0, 0, 1],
      "recounting the requeued snapshot (1, 3, 6) would fire extraction on turn 2; unique counting fires on turn 3",
    );
    for (const text of texts) {
      assert.equal(
        extractionPrompts[0].split(text).length - 1,
        1,
        `each deferred text must appear exactly once in the extraction input: ${text.slice(0, 40)}`,
      );
    }
  });

  it("retains at least extractMinMessages deferred texts, so high thresholds do not evict deferred content", async () => {
    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: countingConfig(8) });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const texts = ingressTexts(8);

    const promptCounts = await runIngressTurns(harness, hook, texts);
    assert.deepEqual(
      promptCounts,
      [0, 0, 0, 0, 0, 0, 0, 1],
      "eight unique ingress texts must reach the threshold exactly on turn 8",
    );
    for (const text of texts) {
      assert.ok(
        extractionPrompts[0].includes(text),
        `the six-entry retention cap must not evict deferred text: ${text.slice(0, 40)}`,
      );
    }
  });
});

describe("admission gates fail closed when admission is required but unavailable", () => {
  const { gateMappedReflectionEntries } = jiti("../src/reflection-mapped-admission.ts");

  it("gateRegexFallbackCapture rejects when admission is required and no controller exists", async () => {
    const result = await gateRegexFallbackCapture({
      admissionController: null,
      admissionRequired: true,
      attachAudit: false,
      text: "synthetic capture text",
      storeCategory: "preference",
      vector: [0.1, 0.2],
      conversationText: "synthetic conversation",
      scopeFilter: ["agent-a"],
    });
    assert.equal(result.admit, false, "an enabled-but-unavailable admission gate must fail closed");
    assert.match(result.reason ?? "", /failing closed/);
  });

  it("gateRegexFallbackCapture keeps the disabled passthrough when admission is not required", async () => {
    const result = await gateRegexFallbackCapture({
      admissionController: null,
      admissionRequired: false,
      attachAudit: false,
      text: "synthetic capture text",
      storeCategory: "preference",
      vector: [0.1, 0.2],
      conversationText: "synthetic conversation",
      scopeFilter: ["agent-a"],
    });
    assert.equal(result.admit, true, "admission disabled must remain a passthrough");
  });

  it("gateMappedReflectionEntries rejects the burst when admission is required and no controller exists", async () => {
    const results = await gateMappedReflectionEntries({
      admissionController: null,
      admissionRequired: true,
      attachAudit: false,
      rows: [
        { text: "synthetic mapped row one", category: "fact", heading: "Facts", vector: [0.1] },
        { text: "synthetic mapped row two", category: "fact", heading: "Facts", vector: [0.2] },
      ],
      conversationText: "synthetic conversation",
      scopeFilter: ["agent-a"],
    });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.admit, false, "an enabled-but-unavailable admission gate must fail closed");
      assert.match(result.reason ?? "", /failing closed/);
    }
  });

  it("gateMappedReflectionEntries keeps the disabled passthrough when admission is not required", async () => {
    const results = await gateMappedReflectionEntries({
      admissionController: null,
      admissionRequired: false,
      attachAudit: false,
      rows: [{ text: "synthetic mapped row", category: "fact", heading: "Facts", vector: [0.1] }],
      conversationText: "synthetic conversation",
      scopeFilter: ["agent-a"],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].admit, true, "admission disabled must remain a passthrough");
  });
});

describe("settled zero-persisted outcomes are consumed, not retried", () => {
  let workspaceDir;
  let embeddingServer;
  let llmServer;
  let extractionPrompts;
  let counters;

  function createVerdictLlmServer({ extractMemories, utilityScore, dedupDecision }) {
    return http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = String(payload.messages?.map((m) => m.content).join("\n") ?? "");
      let content;
      if (prompt.includes("Evaluate whether this candidate")) {
        counters.utility += 1;
        content = JSON.stringify({ utility: utilityScore, reason: "mock utility" });
      } else if (prompt.includes("## Recent Conversation")) {
        extractionPrompts.push(prompt);
        const memories = typeof extractMemories === "function" ? extractMemories(extractionPrompts.length) : extractMemories;
        content = JSON.stringify({ memories });
      } else {
        counters.dedup += 1;
        content = JSON.stringify(dedupDecision ?? { decision: "create", reason: "mock" });
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

  function angledVector(kind) {
    const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
    if (kind === "anchor") { v[0] = 1; }
    else { v[0] = 0.9; v[1] = Math.sqrt(1 - 0.81); }
    return v;
  }

  function createAngledEmbeddingServer() {
    return http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: String(input).includes("support-anchor-marker")
            ? angledVector("anchor")
            : String(input).includes("support-cand-marker")
              ? angledVector("cand")
              : oneHot(String(input)),
        })),
        model: payload.model || "mock-embedding-model",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }));
    });
  }

  function settledConfig() {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 2,
      extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
      sessionCompression: { enabled: false },
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      admissionControl: { enabled: true, preset: "balanced" },
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
    };
  }

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "settled-consume-"));
    extractionPrompts = [];
    counters = { utility: 0, dedup: 0 };
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    if (embeddingServer) await new Promise((resolve) => embeddingServer.close(resolve));
    if (llmServer) await new Promise((resolve) => llmServer.close(resolve));
    embeddingServer = null;
    llmServer = null;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("an admission-rejected run is settled: a repeated agent_end does not re-extract or re-charge", async () => {
    embeddingServer = createEmbeddingServer();
    llmServer = createVerdictLlmServer({
      extractMemories: [{
        category: "preferences",
        abstract: "Synthetic rejected preference marker",
        overview: "## Preference\n- rejected marker",
        content: "User stated a synthetic preference the utility gate must veto.",
      }],
      utilityScore: 0.05,
    });
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: settledConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:settled-reject", agentId: "agent-two" };
    const messages = userMessages(PREFERENCE_TEXT, SECOND_TEXT);

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "first run extracts once");
    assert.equal(counters.utility, 1, "first run evaluates admission once");

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "a settled rejection must not re-extract the same snapshot");
    assert.equal(counters.utility, 1, "a settled rejection must not re-run admission");
  });

  it("a dedup-skipped run is settled: a repeated agent_end does not re-extract or duplicate rows", async () => {
    embeddingServer = createEmbeddingServer();
    llmServer = createVerdictLlmServer({
      extractMemories: [{
        category: "preferences",
        abstract: PREFERENCE_TEXT,
        overview: `## Preference\n- ${PREFERENCE_TEXT}`,
        content: PREFERENCE_TEXT,
      }],
      utilityScore: 0.9,
      dedupDecision: { decision: "skip", reason: "mock duplicate" },
    });
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const config = settledConfig();
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const seedStore = new MemoryStore({ dbPath: config.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    await seedStore.store({
      text: PREFERENCE_TEXT,
      // The extractor embeds `${abstract} ${content}` for dedup search; the
      // seed's vector must sit on that exact string to become its neighbor.
      vector: oneHot(`${PREFERENCE_TEXT} ${PREFERENCE_TEXT}`),
      category: "preferences",
      scope: "agent:agent-two",
      importance: 0.7,
      metadata: JSON.stringify({ l0_abstract: PREFERENCE_TEXT, memory_category: "preferences" }),
    });

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: config });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:settled-skip", agentId: "agent-two" };
    const messages = userMessages(PREFERENCE_TEXT, SECOND_TEXT);

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "first run extracts once");

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "a settled dedup skip must not re-extract the same snapshot");

    const rows = await new MemoryStore({ dbPath: config.dbPath, vectorDim: EMBEDDING_DIMENSIONS })
      .list(undefined, undefined, 20, 0);
    assert.equal(rows.length, 1, "the skipped candidate must not be stored on either run");
  });

  it("a support-only run is settled: repeated agent_end does not re-run and support evidence stays single", async () => {
    embeddingServer = createAngledEmbeddingServer();
    llmServer = createVerdictLlmServer({
      extractMemories: [{
        category: "preferences",
        abstract: "support-cand-marker synthetic preference restated",
        overview: "## Preference\n- support-cand-marker restated",
        content: "support-cand-marker: user restated the anchored synthetic preference.",
      }],
      utilityScore: 0.9,
      dedupDecision: { decision: "support", match_index: 0, reason: "mock support" },
    });
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

    const config = settledConfig();
    const { MemoryStore } = jiti(path.join(testDir, "..", "src", "store.ts"));
    const seedStore = new MemoryStore({ dbPath: config.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const seeded = await seedStore.store({
      text: "support-anchor-marker synthetic preference",
      vector: angledVector("anchor"),
      category: "preference",
      scope: "agent:agent-two",
      importance: 0.7,
      metadata: JSON.stringify({ l0_abstract: "support-anchor-marker synthetic preference" }),
    });

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: config });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);
    const ctx = { sessionKey: "agent:agent-two:settled-support", agentId: "agent-two" };
    const messages = userMessages(PREFERENCE_TEXT, SECOND_TEXT);

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "first run extracts once");
    const afterFirst = JSON.parse((await seedStore.getById(seeded.id)).metadata ?? "{}");

    await fireAgentEnd(hook, messages, ctx);
    assert.equal(extractionPrompts.length, 1, "a settled support outcome must not re-extract the same snapshot");
    const afterSecond = JSON.parse((await seedStore.getById(seeded.id)).metadata ?? "{}");
    assert.deepEqual(
      afterSecond,
      afterFirst,
      "support evidence on the anchored row must not be updated again by a repeated agent_end",
    );
  });
});
