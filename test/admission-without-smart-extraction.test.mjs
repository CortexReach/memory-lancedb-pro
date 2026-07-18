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
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;

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

function findRegisteredLog(logs) {
  return [...logs.info, ...logs.debug].find((l) => l.includes("plugin registered"));
}

describe("admission control availability without smart extraction", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "admission-no-extraction-"));
    retrieverModuleForMock.createRetriever = mockCreateRetriever();
    embedderModuleForMock.createEmbedder = mockCreateEmbedder();
    resetRegistration();
  });

  afterEach(() => {
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("constructs a standalone admission controller when smartExtraction is off but admissionControl is enabled", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        admissionControl: { enabled: true },
        autoCapture: false,
        autoRecall: false,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const registeredLog = findRegisteredLog(harness.logs);
    assert.ok(registeredLog, "expected a 'plugin registered' log line");
    assert.match(registeredLog, /smartExtraction: OFF/);
    assert.match(registeredLog, /admissionControl: ON/);
  });

  it("leaves admission control unavailable when it is disabled, even with smart extraction off (configured off means off)", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        admissionControl: { enabled: false },
        autoCapture: false,
        autoRecall: false,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const registeredLog = findRegisteredLog(harness.logs);
    assert.ok(registeredLog);
    assert.match(registeredLog, /smartExtraction: OFF/);
    assert.match(registeredLog, /admissionControl: OFF/);
  });

  it("keeps smartExtraction: true behavior unchanged (both ON when admission is enabled)", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: true,
        admissionControl: { enabled: true },
        autoCapture: false,
        autoRecall: false,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const registeredLog = findRegisteredLog(harness.logs);
    assert.ok(registeredLog);
    assert.match(registeredLog, /smartExtraction: ON/);
    assert.match(registeredLog, /admissionControl: ON/);
  });
});
