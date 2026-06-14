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
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
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

  return { api, eventHandlers };
}

function getAutoRecallHook(eventHandlers) {
  const hooks = eventHandlers.get("before_prompt_build") || [];
  const autoRecallHook = hooks.find(({ meta }) => meta?.priority === 10)?.handler;
  assert.equal(typeof autoRecallHook, "function", "expected an auto-recall before_prompt_build hook");
  return autoRecallHook;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeConfirmedMetadata() {
  return JSON.stringify({
    state: "confirmed",
    memory_layer: "active",
    injected_count: 0,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
  });
}

function makeResults() {
  return [
    {
      entry: {
        id: "m1",
        text: "remember this",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: makeConfirmedMetadata(),
      },
      score: 0.82,
      sources: {
        vector: { score: 0.82, rank: 1 },
        bm25: { score: 0.88, rank: 2 },
      },
    },
    {
      entry: {
        id: "m2",
        text: "prefer concise diffs",
        category: "preference",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: makeConfirmedMetadata(),
      },
      score: 0.77,
      sources: {
        vector: { score: 0.77, rank: 2 },
        bm25: { score: 0.71, rank: 3 },
      },
    },
  ];
}

describe("auto-recall timeout", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "auto-recall-timeout-"));
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

  it("drops late auto-recall results after the timeout", async () => {
    const logs = { info: [], warn: [], debug: [] };
    let patchMetadataCalls = 0;

    activeCreateRetriever = function mockCreateRetriever() {
      return {
        async retrieve() {
          await delay(25);
          return makeResults();
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    activeCreateEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    MemoryStore.prototype.patchMetadata = async () => {
      patchMetadataCalls++;
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      logs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-timeout", sessionKey: "agent:main:session:auto-timeout", agentId: "main" },
    );

    assert.equal(output, undefined);
    await delay(75);

    assert.equal(patchMetadataCalls, 0, "late recall should not update injection metadata");
    assert.ok(
      logs.warn.some((line) => line.includes("auto-recall timed out after 1ms")),
      "expected timeout warning",
    );
    assert.ok(
      logs.warn.some((line) => line.includes("dropping late auto-recall result after timeout")),
      "expected late-result drop warning",
    );
    assert.equal(
      logs.info.some((line) => /injecting \d+ memories into context/.test(line)),
      false,
      "late recall should not log a context injection",
    );
  });

  it("aborts in-flight retrieval when auto-recall times out", async () => {
    const logs = { info: [], warn: [], debug: [] };
    let retrieveCalls = 0;
    let retrievalSignal;

    activeCreateRetriever = function mockCreateRetriever() {
      return {
        async retrieve(context) {
          retrieveCalls++;
          retrievalSignal = context.signal;
          assert.ok(retrievalSignal, "auto-recall should pass a retrieval AbortSignal");
          await new Promise((resolve) => {
            if (retrievalSignal.aborted) {
              resolve();
              return;
            }
            retrievalSignal.addEventListener("abort", resolve, { once: true });
          });
          return [];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    activeCreateEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      logs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-timeout-abort", sessionKey: "agent:main:session:auto-timeout-abort", agentId: "main" },
    );

    assert.equal(output, undefined);
    assert.equal(retrieveCalls, 1, "aborted retrieval should not retry after timeout");
    assert.equal(retrievalSignal?.aborted, true, "auto-recall timeout should abort retrieval");
    assert.ok(
      logs.warn.some((line) => line.includes("auto-recall timed out after 1ms")),
      "expected timeout warning",
    );
    assert.equal(
      logs.warn.some((line) => line.includes("recall failed")),
      false,
      "expected timeout abort to be consumed without a second noisy warning",
    );
  });

  it("uses a shorter default rerank timeout inside the auto-recall budget", async () => {
    let capturedContext;

    activeCreateRetriever = function mockCreateRetriever() {
      return {
        async retrieve(context) {
          capturedContext = context;
          return [];
        },
        getConfig() {
          return {
            mode: "hybrid",
            rerank: "cross-encoder",
            rerankApiKey: "rerank-key",
            rerankProvider: "jina",
          };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    activeCreateEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 5000,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const beforeHookMs = Date.now();
    await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-rerank-budget", sessionKey: "agent:main:session:auto-rerank-budget", agentId: "main" },
    );

    assert.equal(capturedContext?.source, "auto-recall");
    assert.equal(capturedContext?.rerankTimeoutMs, 2500);
    assert.equal(typeof capturedContext?.rerankDeadlineMs, "number");
    assert.ok(capturedContext.rerankDeadlineMs > beforeHookMs);
    assert.ok(capturedContext.rerankDeadlineMs <= beforeHookMs + 5100);
  });

  it("skips remote rerank timeout budget for very small auto-recall budgets", async () => {
    let capturedContext;

    activeCreateRetriever = function mockCreateRetriever() {
      return {
        async retrieve(context) {
          capturedContext = context;
          return [];
        },
        getConfig() {
          return {
            mode: "hybrid",
            rerank: "cross-encoder",
            rerankApiKey: "rerank-key",
            rerankProvider: "jina",
          };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    activeCreateEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-rerank-tiny-budget", sessionKey: "agent:main:session:auto-rerank-tiny-budget", agentId: "main" },
    );

    assert.equal(capturedContext?.source, "auto-recall");
    assert.equal(capturedContext?.rerankTimeoutMs, 0);
  });

  it("returns context before auto-recall metadata patch settles", async () => {
    const logs = { info: [], warn: [], debug: [] };
    const patchResolvers = [];
    let patchMetadataCalls = 0;
    let patchMetadataSettled = 0;

    activeCreateRetriever = function mockCreateRetriever() {
      return {
        async retrieve() {
          return makeResults();
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    activeCreateEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    MemoryStore.prototype.patchMetadata = async () => {
      patchMetadataCalls++;
      await new Promise((resolve) => patchResolvers.push(resolve));
      patchMetadataSettled++;
      return null;
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      logs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallTimeoutMs: 10000,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const timeoutMarker = Symbol("timeout");
    const output = await Promise.race([
      autoRecallHook(
        { prompt: "Please recall what I mentioned before about this task." },
        { sessionId: "auto-patch-bg", sessionKey: "agent:main:session:auto-patch-bg", agentId: "main" },
      ),
      delay(500).then(() => timeoutMarker),
    ]);

    assert.notEqual(output, timeoutMarker, "metadata patch must not block context injection");
    assert.match(
      output?.prependContext ?? "",
      /<relevant-memories>/,
      `expected memory context; logs=${JSON.stringify(logs)}`,
    );
    assert.equal(patchMetadataCalls, 2, "background metadata patch should still start");
    assert.equal(patchMetadataSettled, 0, "hook should return before background patch settles");
    assert.ok(
      logs.info.some((line) => /injecting \d+ memories into context/.test(line)),
      "expected context injection log",
    );

    patchResolvers.forEach((resolve) => resolve());
    await delay(0);
    assert.equal(patchMetadataSettled, 2, "background metadata patch should settle after hook returns");
  });
});
