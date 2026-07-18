import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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

const retrieverModuleForMock = jiti("../src/retriever.js");
const embedderModuleForMock = jiti("../src/embedder.js");
const llmClientModuleForMock = jiti("../src/llm-client.js");
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;
const origCreateLlmClient = llmClientModuleForMock.createLlmClient;

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { resetRegistration } = pluginModule;

function mockCreateRetriever() {
  return function mockCreateRetrieverImpl() {
    return {
      async retrieve() {
        return [];
      },
      getConfig() {
        return { mode: "hybrid" };
      },
      setAccessTracker() {},
      setStatsCollector() {},
    };
  };
}

function mockCreateEmbedder() {
  return function mockCreateEmbedderImpl() {
    return {
      async embedQuery() {
        return new Float32Array(384).fill(0);
      },
      async embedPassage() {
        return new Float32Array(384).fill(0);
      },
    };
  };
}

function mockCreateLlmClient(requestedModels) {
  return function mockCreateLlmClientImpl(config) {
    requestedModels.push(config.model);
    return {
      async completeJson() {
        return null;
      },
    };
  };
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
      info(message) {
        logs.info.push(String(message));
      },
      warn(message) {
        logs.warn.push(String(message));
      },
      debug(message) {
        logs.debug.push(String(message));
      },
      error(message) {
        logs.info.push(String(message));
      },
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

function baseConfig(workspaceDir, overrides = {}) {
  return {
    dbPath: path.join(workspaceDir, "db"),
    embedding: { apiKey: "test-api-key" },
    llm: { model: "global-model" },
    smartExtraction: true,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    ...overrides,
  };
}

describe("admission lane model affinity", () => {
  let workspaceDir;
  let requestedModels;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "admission-lane-model-"));
    requestedModels = [];
    retrieverModuleForMock.createRetriever = mockCreateRetriever();
    embedderModuleForMock.createEmbedder = mockCreateEmbedder();
    llmClientModuleForMock.createLlmClient = mockCreateLlmClient(requestedModels);
    resetRegistration();
  });

  afterEach(() => {
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    llmClientModuleForMock.createLlmClient = origCreateLlmClient;
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("uses only the global model when modelAffinity is absent (default, zero change)", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        admissionControl: { enabled: true },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    // The CLI command wrapper eagerly builds its own llmClient bound to the
    // same global model, independent of admission control — that's expected
    // and unrelated to this feature, so assert "never any other model" here
    // rather than an exact call count.
    assert.ok(requestedModels.length >= 1);
    assert.ok(
      requestedModels.every((m) => m === "global-model"),
      `expected every requested model to be the global model, got: ${requestedModels.join(", ")}`,
    );
  });

  it("builds a second client bound to the memoryReflection model when modelAffinity is 'lane'", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        admissionControl: { enabled: true, modelAffinity: "lane" },
        memoryReflection: { model: "reflection-model" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(requestedModels.includes("global-model"), "extraction lane still resolves the global model");
    assert.ok(requestedModels.includes("reflection-model"), "reflection lane resolves the memoryReflection model");
  });

  it("uses the same global-model client for both lanes when modelAffinity is 'lane' but no memoryReflection model is configured", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        admissionControl: { enabled: true, modelAffinity: "lane" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(
      requestedModels.every((m) => m === "global-model"),
      `expected every requested model to be the global model, got: ${requestedModels.join(", ")}`,
    );
  });

  it("normalizes a core-style provider-prefixed reflection model for the plugin's direct client (live 400 catch, 2026-07-18)", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        admissionControl: { enabled: true, modelAffinity: "lane" },
        memoryReflection: { model: "openrouter/anthropic/claude-opus-4-8" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(
      requestedModels.includes("anthropic/claude-opus-4-8"),
      "the lane clients must get the provider-stripped id a direct OpenRouter call accepts",
    );
    assert.ok(
      !requestedModels.includes("openrouter/anthropic/claude-opus-4-8"),
      "the raw core-style catalog ref must never reach a direct client",
    );
  });

  it("lets an explicit admissionControl.model override beat lane affinity for admission calls, while the lane pipeline client still rides the reflection model", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        admissionControl: { enabled: true, modelAffinity: "lane", model: "override-model" },
        memoryReflection: { model: "reflection-model" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(requestedModels.includes("global-model"), "the plain extraction client is still built");
    assert.ok(requestedModels.includes("override-model"), "admission calls use the explicit override");
    // Since the whole-lane affinity extension (operator ruling 2026-07-18),
    // "lane" also builds the reflection-lane client for the dedup decider and
    // merge writer; the admission-specific model override governs admission
    // calls only, not the lane pipeline client.
    assert.ok(
      requestedModels.includes("reflection-model"),
      "lane affinity still builds the reflection-lane pipeline client (dedup/merge) alongside the admission override",
    );
  });
});
