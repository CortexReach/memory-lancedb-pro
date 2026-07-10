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
let activeCreateRetriever = origCreateRetriever;
let activeCreateEmbedder = origCreateEmbedder;

retrieverModuleForMock.createRetriever = (...args) => activeCreateRetriever(...args);
embedderModuleForMock.createEmbedder = (...args) => activeCreateEmbedder(...args);

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { MemoryStore } = jiti("../src/store.ts");
const { storeReflectionToLanceDB } = jiti("../src/reflection-store.ts");

// A sessionKey shaped like the reflection distiller's own embedded sub-session
// (see runEmbeddedPiAgent's sessionKey: `temp:memory-reflection:${agentId}`).
const DISTILLER_SESSION_KEY = "temp:memory-reflection:dave";
const CONTROL_SESSION_KEY = "agent:dave:main";
const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedReflection(dbPath, agentId) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  await storeReflectionToLanceDB({
    reflectionText: [
      "## Invariants",
      `- Always verify reflection hook coverage for ${agentId}.`,
      "## Derived",
      `- Next run exercise the reflection injection path for ${agentId}.`,
    ].join("\n"),
    sessionKey: `agent:${agentId}:session:test`,
    sessionId: `session-${agentId}`,
    agentId,
    command: "command:new",
    scope: "global",
    toolErrorSignals: [],
    runAt: Date.now() - 2 * DAY_MS,
    usedFallback: false,
    embedPassage: async () => FIXED_VECTOR,
    vectorSearch: async () => [],
    store: async (entry) => store.store(entry),
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
      info(message) {
        logs.info.push(String(message));
      },
      warn(message) {
        logs.warn.push(String(message));
      },
      debug(message) {
        logs.debug.push(String(message));
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

function getAutoRecallHook(eventHandlers) {
  const hooks = eventHandlers.get("before_prompt_build") || [];
  const hook = hooks.find(({ meta }) => meta?.priority === 10)?.handler;
  assert.equal(typeof hook, "function", "expected an auto-recall before_prompt_build hook");
  return hook;
}

function getReflectionHooks(eventHandlers) {
  const hooks = eventHandlers.get("before_prompt_build") || [];
  const inheritedRules = hooks.find(({ meta }) => meta?.priority === 12)?.handler;
  const derivedFocus = hooks.find(({ meta }) => meta?.priority === 15)?.handler;
  assert.equal(typeof inheritedRules, "function", "expected inherited-rules before_prompt_build hook");
  assert.equal(typeof derivedFocus, "function", "expected derived-focus before_prompt_build hook");
  return { inheritedRules, derivedFocus };
}

function mockRetrieverAndEmbedder(onRetrieve) {
  activeCreateRetriever = () => ({
    async retrieve() {
      onRetrieve();
      return [];
    },
    getConfig() {
      return { mode: "hybrid" };
    },
    setAccessTracker() {},
    setStatsCollector() {},
  });
  activeCreateEmbedder = () => ({
    async embedQuery() {
      return new Float32Array(384).fill(0);
    },
    async embedPassage() {
      return new Float32Array(384).fill(0);
    },
  });
}

describe("reflection distiller sub-session hook gating", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "reflection-distiller-hooks-"));
    activeCreateRetriever = origCreateRetriever;
    activeCreateEmbedder = origCreateEmbedder;
    retrieverModuleForMock.createRetriever = (...args) => activeCreateRetriever(...args);
    embedderModuleForMock.createEmbedder = (...args) => activeCreateEmbedder(...args);
    resetRegistration();
  });

  afterEach(() => {
    activeCreateRetriever = origCreateRetriever;
    activeCreateEmbedder = origCreateEmbedder;
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function autoRecallPluginConfig() {
    return {
      dbPath: path.join(workspaceDir, "db"),
      embedding: { apiKey: "test-api-key" },
      smartExtraction: false,
      autoCapture: false,
      autoRecall: true,
      autoRecallMinLength: 1,
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    };
  }

  it("skips auto-recall for the reflection distiller's own sub-session (no retriever call, no prependContext)", async () => {
    let retrieveCalls = 0;
    mockRetrieverAndEmbedder(() => retrieveCalls++);

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: autoRecallPluginConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoRecallHook(harness.eventHandlers);

    const output = await hook(
      { prompt: "summarize this session into invariants and derived focus" },
      { sessionId: "distiller-1", sessionKey: DISTILLER_SESSION_KEY, agentId: "dave" },
    );

    assert.equal(output, undefined, "the distiller sub-session must not receive injected context");
    assert.equal(retrieveCalls, 0, "the distiller sub-session must not trigger a retrieval");
  });

  it("proceeds with auto-recall for a normal control session", async () => {
    let retrieveCalls = 0;
    mockRetrieverAndEmbedder(() => retrieveCalls++);

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig: autoRecallPluginConfig() });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoRecallHook(harness.eventHandlers);

    await hook(
      { prompt: "please recall what we discussed" },
      { sessionId: "control-1", sessionKey: CONTROL_SESSION_KEY, agentId: "dave" },
    );

    assert.ok(retrieveCalls > 0, "control session must reach the retriever");
  });

  function reflectionPluginConfig() {
    return {
      dbPath: path.join(workspaceDir, "db"),
      embedding: { apiKey: "test-api-key", dimensions: EMBEDDING_DIMENSIONS },
      sessionStrategy: "memoryReflection",
      smartExtraction: false,
      autoCapture: false,
      autoRecall: false,
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    };
  }

  it("still skips the inherited-rules reflection injector for the distiller sub-session (pre-existing guard, regression)", async () => {
    const pluginConfig = reflectionPluginConfig();
    await seedReflection(pluginConfig.dbPath, "dave");

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const { inheritedRules } = getReflectionHooks(harness.eventHandlers);

    const output = await inheritedRules({}, { sessionKey: DISTILLER_SESSION_KEY, agentId: "dave" });

    assert.equal(output, undefined, "the distiller sub-session must not receive inherited-rules injection even when data exists");
  });

  it("still skips the derived-focus reflection injector for the distiller sub-session (pre-existing guard, regression)", async () => {
    const pluginConfig = reflectionPluginConfig();
    await seedReflection(pluginConfig.dbPath, "dave");

    const harness = createPluginApiHarness({ resolveRoot: workspaceDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const { derivedFocus } = getReflectionHooks(harness.eventHandlers);

    const output = await derivedFocus({}, { sessionKey: DISTILLER_SESSION_KEY, agentId: "dave" });

    assert.equal(output, undefined, "the distiller sub-session must not receive derived-focus injection even when data exists");
  });
});
