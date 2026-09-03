/**
 * index.ts composition regression for the host transport (review findings on
 * the runtime-llm-completions family):
 *
 * 1. A core-style catalog model reference configured as llm.model must reach
 *    the host runtime WHOLE on every lane the plugin wires (extraction AND
 *    admission utility). resolveAdmissionModel() and admissionClientFor()
 *    both normalize for the direct transport; unit tests that construct the
 *    host client directly cannot catch a strip re-introduced in the index.ts
 *    wiring between them.
 *
 * 2. The host request carries a `model` field ONLY when the operator
 *    configured one: the host runtime treats a supplied model as a model
 *    override and rejects it under the default plugin override policy, so a
 *    plugin-internal default must be omitted.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";
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
const HOST_CATALOG_MODEL = "openrouter/vendor-example/model-x";

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
 * Host runtime stub: records every runtime.llm.complete params object and
 * answers by prompt shape (extraction vs admission utility vs dedup).
 */
function createRuntimeLlmStub(captured) {
  return async (params) => {
    captured.push(params);
    const prompt = String(params.messages?.map((m) => m.content).join("\n") ?? "");
    let text;
    if (prompt.includes("Evaluate whether this candidate")) {
      text = JSON.stringify({ utility: 0.9, reason: "stub utility" });
    } else if (prompt.includes("## Recent Conversation")) {
      text = JSON.stringify({
        memories: [{
          category: "preferences",
          abstract: "Synthetic composition-probe preference",
          overview: "## Preference\n- Composition probe",
          content: "User stated a synthetic composition-probe preference.",
        }],
      });
    } else {
      text = JSON.stringify({ decision: "create", reason: "stub" });
    }
    return { text, provider: "host-stub", model: params.model ?? "host-default" };
  };
}

function createPluginApiHarness({ pluginConfig, resolveRoot, runtimeLlmComplete }) {
  const eventHandlers = new Map();
  const logs = { info: [], warn: [], debug: [] };
  const api = {
    pluginConfig,
    runtime: { llm: { complete: runtimeLlmComplete } },
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

describe("host transport composition through the plugin wiring (index.ts)", () => {
  let workspaceDir;
  let embeddingServer;
  let captured;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "host-composition-"));
    captured = [];
    embeddingServer = createEmbeddingServer();
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    resetRegistration();
  });

  afterEach(async () => {
    resetRegistration();
    await new Promise((resolve) => embeddingServer.close(resolve));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function hostConfig(overrides = {}) {
    return {
      dbPath: path.join(workspaceDir, "db"),
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 1,
      extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
      sessionCompression: { enabled: false },
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      admissionControl: { enabled: true },
      embedding: {
        apiKey: "test-api-key",
        model: "mock-embedding-model",
        baseURL: `http://127.0.0.1:${embeddingServer.address().port}/v1`,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        transport: "host",
        model: HOST_CATALOG_MODEL,
      },
      ...overrides,
    };
  }

  it("keeps the full catalog model reference on every host call (extraction and admission), never the stripped form", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: hostConfig(),
      runtimeLlmComplete: createRuntimeLlmStub(captured),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(
      hook,
      userMessages("I prefer synthetic teal accents in every dashboard I build."),
      { sessionKey: "agent:agent-two:main", agentId: "agent-two" },
    );

    assert.ok(captured.length >= 1, "expected at least one host runtime call");
    const stripped = HOST_CATALOG_MODEL.split("/").slice(1).join("/");
    for (const call of captured) {
      assert.equal(
        call.model,
        HOST_CATALOG_MODEL,
        `host call must carry the full catalog reference, got: ${String(call.model)}`,
      );
      assert.notEqual(call.model, stripped, "provider prefix must not be stripped on the host transport");
    }
  });

  it("omits the model field on host calls when the operator did not configure llm.model", async () => {
    const config = hostConfig();
    delete config.llm.model;
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: config,
      runtimeLlmComplete: createRuntimeLlmStub(captured),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    await fireAgentEnd(
      hook,
      userMessages("I prefer synthetic amber accents in every report I write."),
      { sessionKey: "agent:agent-two:main", agentId: "agent-two" },
    );

    assert.ok(captured.length >= 1, "expected at least one host runtime call");
    for (const call of captured) {
      assert.ok(
        !("model" in call) || call.model === undefined,
        `an unconfigured model must be omitted from the host request, got: ${String(call.model)}`,
      );
    }
  });
});
