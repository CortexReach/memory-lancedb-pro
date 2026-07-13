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
const storeModuleForMock = jiti("../src/store.js");
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;
let activeCreateRetriever = origCreateRetriever;
let activeCreateEmbedder = origCreateEmbedder;

retrieverModuleForMock.createRetriever = (...args) => activeCreateRetriever(...args);
embedderModuleForMock.createEmbedder = (...args) => activeCreateEmbedder(...args);

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { resetRegistration } = pluginModule;
const { MemoryStore } = storeModuleForMock;
const origPatchMetadata = MemoryStore.prototype.patchMetadata;

function createPluginApiHarness({ pluginConfig, resolveRoot, logs }) {
  const eventHandlers = new Map();
  const logSink = logs ?? { info: [], warn: [], debug: [] };

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) {
        logSink.info.push(String(message));
      },
      warn(message) {
        logSink.warn.push(String(message));
      },
      debug(message) {
        logSink.debug.push(String(message));
      },
      error(message) {
        logSink.info.push(String(message));
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

  return { api, eventHandlers, logs: logSink };
}

function getAutoRecallHook(eventHandlers) {
  const hooks = eventHandlers.get("before_prompt_build") || [];
  const autoRecallHook = hooks.find(({ meta }) => meta?.priority === 10)?.handler;
  assert.equal(typeof autoRecallHook, "function", "expected an auto-recall before_prompt_build hook");
  return autoRecallHook;
}

function baseScopeConfig(workspaceDir) {
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

function mockCreateRetriever(retrieveCallCounter) {
  return function mockCreateRetrieverImpl() {
    return {
      async retrieve() {
        retrieveCallCounter.count += 1;
        // A non-empty result avoids retrieveWithRetry's empty-result retry,
        // which would otherwise call retrieve() twice per genuine invocation
        // and make the call count meaningless for this test's purpose.
        return [
          {
            entry: {
              id: "m1",
              text: "remember this",
              category: "fact",
              scope: "global",
              importance: 0.7,
              timestamp: Date.now(),
              metadata: JSON.stringify({
                state: "confirmed",
                memory_layer: "active",
                injected_count: 0,
                bad_recall_count: 0,
                suppressed_until_turn: 0,
              }),
            },
            score: 0.82,
            sources: {
              vector: { score: 0.82, rank: 1 },
              bm25: { score: 0.88, rank: 2 },
            },
          },
        ];
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

describe("register() re-registration hardening", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "register-scope-dedup-"));
    activeCreateRetriever = origCreateRetriever;
    activeCreateEmbedder = origCreateEmbedder;
    retrieverModuleForMock.createRetriever = (...args) => activeCreateRetriever(...args);
    embedderModuleForMock.createEmbedder = (...args) => activeCreateEmbedder(...args);
    MemoryStore.prototype.patchMetadata = origPatchMetadata;
    resetRegistration();
  });

  afterEach(() => {
    activeCreateRetriever = origCreateRetriever;
    activeCreateEmbedder = origCreateEmbedder;
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    MemoryStore.prototype.patchMetadata = origPatchMetadata;
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("(a) second register() with the same api instance is a no-op: no duplicate handlers, no re-log", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
    });

    memoryLanceDBProPlugin.register(harness.api);
    const hookCountAfterFirst = (harness.eventHandlers.get("before_prompt_build") || []).length;
    const registeredLogsAfterFirst = harness.logs.info.filter((l) => l.includes("plugin registered")).length;
    assert.ok(hookCountAfterFirst > 0, "expected at least one before_prompt_build hook after first register()");
    assert.equal(registeredLogsAfterFirst, 1, "expected exactly one 'plugin registered' log after first register()");

    // Second register() call with the exact same api instance — the existing
    // WeakSet guard should make this a pure no-op.
    memoryLanceDBProPlugin.register(harness.api);

    const hookCountAfterSecond = (harness.eventHandlers.get("before_prompt_build") || []).length;
    const registeredLogsAfterSecond = harness.logs.info.filter((l) => l.includes("plugin registered")).length;

    assert.equal(hookCountAfterSecond, hookCountAfterFirst, "no duplicate handlers should be pushed");
    assert.equal(registeredLogsAfterSecond, 1, "log must not be repeated on the idempotent re-register");
    assert.ok(
      harness.logs.debug.some((l) => l.includes("register() called again")),
      "expected the idempotent-skip debug log on the second call",
    );
  });

  it("(b) a distinct scope (fresh api instance) still registers fully, and the log stays collapsed to one", () => {
    const harnessA = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
    });
    memoryLanceDBProPlugin.register(harnessA.api);

    // Simulate a scope cache-miss: OpenClaw hands the plugin a brand-new api
    // object (own eventHandlers map) rather than calling register() again on
    // the same instance. The WeakSet guard cannot catch this by design.
    const harnessB = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
      logs: harnessA.logs,
    });
    memoryLanceDBProPlugin.register(harnessB.api);

    const hookB = getAutoRecallHook(harnessB.eventHandlers);
    assert.equal(typeof hookB, "function", "the new api instance must still get its own working hook");

    const registeredLogs = harnessA.logs.info.filter((l) => l.includes("plugin registered"));
    assert.equal(
      registeredLogs.length,
      1,
      "the 'plugin registered' log must fire exactly once across repeated registrations, not once per scope re-init",
    );
  });

  it("(c) auto-recall handler fires exactly once per prompt build after repeated registrations", async () => {
    const retrieveCallCounter = { count: 0 };
    activeCreateRetriever = mockCreateRetriever(retrieveCallCounter);
    activeCreateEmbedder = mockCreateEmbedder();
    MemoryStore.prototype.patchMetadata = async (id, patch) => ({ id, ...patch });

    const harnessA = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
    });
    memoryLanceDBProPlugin.register(harnessA.api);
    const hookA = getAutoRecallHook(harnessA.eventHandlers);

    // A second registration for what is (from the host's perspective) the
    // same logical scope, but arrives as a fresh api instance on a cache-miss.
    const harnessB = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
      logs: harnessA.logs,
    });
    memoryLanceDBProPlugin.register(harnessB.api);
    const hookB = getAutoRecallHook(harnessB.eventHandlers);

    // Same logical prompt-build event delivered to both attached handlers —
    // this is what handler accumulation would look like if the host ever
    // re-attaches without clearing the previous handler. The real
    // before_prompt_build event carries no sessionKey/timestamp of its own —
    // that identity lives on ctx — so the fabricated event here matches the
    // production shape (see other before_prompt_build call sites in index.ts,
    // all of which read identity from ctx.sessionKey / ctx.sessionId).
    const event = {
      prompt: "Please recall what I mentioned before about this task.",
    };
    const ctx = {
      sessionId: "cache-miss-test",
      sessionKey: "agent:main:session:cache-miss-test",
      agentId: "main",
    };

    await hookA(event, ctx);
    await hookB(event, ctx);

    assert.equal(
      retrieveCallCounter.count,
      1,
      "the expensive recall pipeline must run exactly once for one logical prompt-build event",
    );
  });

  it("(d) two distinct prompt-build events in the same session are NOT collapsed by the dedup guard", async () => {
    const retrieveCallCounter = { count: 0 };
    activeCreateRetriever = mockCreateRetriever(retrieveCallCounter);
    activeCreateEmbedder = mockCreateEmbedder();
    MemoryStore.prototype.patchMetadata = async (id, patch) => ({ id, ...patch });

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: baseScopeConfig(workspaceDir),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoRecallHook(harness.eventHandlers);

    const ctx = {
      sessionId: "two-turns-test",
      sessionKey: "agent:main:session:two-turns-test",
      agentId: "main",
    };

    // Same session, real event shape (no sessionKey/timestamp on event), but
    // two genuinely different turns — both must still trigger recall.
    await hook({ prompt: "What did I say about the first task?" }, ctx);
    await hook({ prompt: "What did I say about the second task?" }, ctx);

    assert.equal(
      retrieveCallCounter.count,
      2,
      "two distinct prompt-build events in the same session must each run the recall pipeline",
    );
  });
});
