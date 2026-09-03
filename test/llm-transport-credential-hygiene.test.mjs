/**
 * Regression tests for the llm.transport: "host" credential-hygiene fix.
 *
 * Before this fix, index.ts's llmApiKey/llmBaseURL resolution fell back to
 * config.embedding.apiKey/config.embedding.baseURL whenever llm.apiKey /
 * llm.baseURL were not explicitly set, REGARDLESS of llm.transport. On a
 * split-provider setup (embedding via one provider, LLM via host-managed
 * routing) this meant the host->direct fallback client silently inherited
 * the embedding provider's credentials -- talking to the wrong endpoint
 * with the wrong key instead of failing with a clear, actionable error.
 *
 * Fixtures are entirely synthetic -- no real fleet data.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
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

function mockCreateLlmClient(capturedConfigs) {
  return function mockCreateLlmClientImpl(config) {
    capturedConfigs.push(config);
    return {
      async completeJson() {
        return null;
      },
      getLastError() {
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
    embedding: { apiKey: "embedding-provider-key" },
    llm: { model: "global-model" },
    smartExtraction: true,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    ...overrides,
  };
}

describe("llm.transport host credential hygiene", () => {
  let workspaceDir;
  let capturedConfigs;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "llm-transport-credential-"));
    capturedConfigs = [];
    retrieverModuleForMock.createRetriever = mockCreateRetriever();
    embedderModuleForMock.createEmbedder = mockCreateEmbedder();
    llmClientModuleForMock.createLlmClient = mockCreateLlmClient(capturedConfigs);
    resetRegistration();
  });

  afterEach(() => {
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    llmClientModuleForMock.createLlmClient = origCreateLlmClient;
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("does not inherit the embedding lane's apiKey/baseURL when llm.transport is 'host' and llm.apiKey/llm.baseURL are unset", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        embedding: { apiKey: "embedding-provider-key", baseURL: "https://embedding.example/v1" },
        llm: { model: "global-model", transport: "host" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(capturedConfigs.length >= 1, "expected at least one createLlmClient call");
    for (const config of capturedConfigs) {
      assert.notEqual(
        config.apiKey,
        "embedding-provider-key",
        "the host-transport llmClient must not inherit the embedding lane's apiKey"
      );
      assert.notEqual(
        config.baseURL,
        "https://embedding.example/v1",
        "the host-transport llmClient must not inherit the embedding lane's baseURL"
      );
    }
  });

  it("still inherits the embedding lane's apiKey/baseURL when llm.transport is 'direct' (default, non-regression)", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        embedding: { apiKey: "embedding-provider-key", baseURL: "https://embedding.example/v1" },
        llm: { model: "global-model" },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(capturedConfigs.length >= 1, "expected at least one createLlmClient call");
    assert.ok(
      capturedConfigs.every((c) => c.apiKey === "embedding-provider-key"),
      "the direct-transport llmClient should still fall back to the embedding lane's apiKey (unchanged default behavior)"
    );
  });

  it("uses an explicitly configured llm.apiKey/llm.baseURL even under host transport", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseConfig(workspaceDir, {
        embedding: { apiKey: "embedding-provider-key" },
        llm: {
          model: "global-model",
          transport: "host",
          apiKey: "explicit-llm-key",
          baseURL: "https://llm.example/v1",
        },
      }),
    });

    memoryLanceDBProPlugin.register(harness.api);

    assert.ok(capturedConfigs.length >= 1);
    assert.ok(capturedConfigs.every((c) => c.apiKey === "explicit-llm-key"));
    assert.ok(capturedConfigs.every((c) => c.baseURL === "https://llm.example/v1"));
  });
});
