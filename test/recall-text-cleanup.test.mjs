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

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { registerMemoryRecallTool, registerMemoryStoreTool } = jiti("../src/tools.ts");
const { MemoryRetriever } = jiti("../src/retriever.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function makeApiCapture() {
  let capturedCreator = null;
  const api = {
    registerTool(cb) {
      capturedCreator = cb;
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  return { api, getCreator: () => capturedCreator };
}

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info() {},
      warn() {},
      debug() {},
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook() {},
  };

  return { api, eventHandlers };
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
      },
      score: 0.82,
      sources: {
        vector: { score: 0.82, rank: 1 },
        bm25: { score: 0.88, rank: 2 },
        reranked: { score: 0.91 },
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
      },
      score: 0.77,
      sources: {
        vector: { score: 0.77, rank: 2 },
        bm25: { score: 0.71, rank: 3 },
      },
    },
  ];
}

function makeExpandedResults() {
  return [
    ...makeResults(),
    {
      entry: {
        id: "m3",
        text: "third item stays clean",
        category: "note",
        scope: "project",
        importance: 0.5,
        timestamp: Date.now(),
      },
      score: 0.65,
      sources: {
        vector: { score: 0.65, rank: 3 },
      },
    },
  ];
}

function makeUserMdExclusiveResults() {
  return [
    ...makeResults(),
    {
      entry: {
        id: "m3",
        text: "称呼偏好：宙斯",
        category: "preference",
        scope: "global",
        importance: 0.9,
        timestamp: Date.now(),
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: "称呼偏好：宙斯", category: "preference", importance: 0.9 },
            {
              l0_abstract: "称呼偏好：宙斯",
              l1_overview: "## Addressing\n- Preferred form of address: 宙斯",
              l2_content: "用户希望以后被称呼为“宙斯”。",
              memory_category: "preferences",
              fact_key: "preferences:称呼偏好",
            },
          ),
        ),
      },
      score: 0.96,
      sources: {
        vector: { score: 0.96, rank: 1 },
      },
    },
  ];
}

function makeLegacyAddressingResults() {
  return [
    ...makeResults(),
    {
      entry: {
        id: "m4",
        text: "用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”。",
        category: "preference",
        scope: "agent:main",
        importance: 0.95,
        timestamp: Date.now(),
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            {
              text: "用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”。",
              category: "preference",
              importance: 0.95,
            },
            {
              l0_abstract: "用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”。",
              l1_overview: "- 用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”。",
              l2_content: "用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”。",
              memory_category: "preferences",
              fact_key: "preferences:用户从 2026-03-15 起希望在主会话中被称呼为“宙斯”",
            },
          ),
        ),
      },
      score: 0.91,
      sources: {
        vector: { score: 0.91, rank: 1 },
      },
    },
  ];
}

function makeRecallContext(results = makeResults()) {
  return {
    retriever: {
      async retrieve() {
        return results;
      },
      getConfig() {
        return { mode: "hybrid" };
      },
    },
    store: {
      patchMetadata: async () => null,
    },
    scopeManager: {
      getAccessibleScopes: () => ["global"],
      isAccessible: () => true,
      getDefaultScope: () => "global",
    },
    embedder: { embedPassage: async () => [] },
    agentId: "main",
    workspaceDir: "/tmp",
    mdMirror: null,
  };
}

function createTool(registerTool, context) {
  const { api, getCreator } = makeApiCapture();
  registerTool(api, context);
  const creator = getCreator();
  assert.ok(typeof creator === "function");
  return creator({});
}

function extractRenderedMemoryRecallLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s\[/.test(line));
}

describe("recall text cleanup", () => {
  let workspaceDir;
  let originalRetrieve;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "recall-text-cleanup-test-"));
    originalRetrieve = MemoryRetriever.prototype.retrieve;
  });

  afterEach(() => {
    MemoryRetriever.prototype.retrieve = originalRetrieve;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("removes retrieval metadata from memory_recall content text but preserves details fields", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext());
    const res = await tool.execute(null, { query: "test" });

    assert.deepEqual(extractRenderedMemoryRecallLines(res.content[0].text), [
      "1. [m1] [fact:global] remember this",
      "2. [m2] [preference:global] prefer concise diffs",
    ]);

    assert.equal(typeof res.details.memories[0].score, "number");
    assert.ok(res.details.memories[0].sources.vector);
    assert.ok(res.details.memories[0].sources.bm25);
    assert.ok(res.details.memories[0].sources.reranked);
    assert.equal(typeof res.details.memories[1].score, "number");
    assert.ok(res.details.memories[1].sources.vector);
    assert.ok(res.details.memories[1].sources.bm25);
  });

  it("removes retrieval metadata from every rendered memory_recall line", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext(makeExpandedResults()));
    const res = await tool.execute(null, { query: "test with multiple memories" });

    const lines = extractRenderedMemoryRecallLines(res.content[0].text);

    assert.equal(lines.length, 3, "expected three rendered memory lines");
    assert.match(lines[2], /third item stays clean/);
    for (const line of lines) {
      assert.doesNotMatch(line, /\d+%/);
      assert.doesNotMatch(line, /\bvector\b|\bBM25\b|\breranked\b/);
    }
  });

  it("removes retrieval metadata from auto-recall injected text", async () => {
    MemoryRetriever.prototype.retrieve = async () => makeResults();

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("before_agent_start") || [];
    assert.equal(hooks.length, 1, "expected exactly one before_agent_start hook for this config");
    const [{ handler: autoRecallHook }] = hooks;
    assert.equal(typeof autoRecallHook, "function");

    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-clean", sessionKey: "agent:main:session:auto-clean", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /remember this/);
    assert.match(output.prependContext, /prefer concise diffs/);
    assert.doesNotMatch(output.prependContext, /vector\+BM25/);
    assert.doesNotMatch(output.prependContext, /reranked/);
    assert.doesNotMatch(output.prependContext, /\d+%/);
  });

  it("filters USER.md-exclusive facts from memory_recall output", async () => {
    const tool = createTool(registerMemoryRecallTool, {
      ...makeRecallContext(makeUserMdExclusiveResults()),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
    });
    const res = await tool.execute(null, { query: "addressing" });

    assert.deepEqual(extractRenderedMemoryRecallLines(res.content[0].text), [
      "1. [m1] [fact:global] remember this",
      "2. [m2] [preference:global] prefer concise diffs",
    ]);
    assert.equal(res.details.memories.length, 2);
    assert.doesNotMatch(res.content[0].text, /称呼偏好：宙斯/);
  });

  it("skips USER.md-exclusive facts in memory_store", async () => {
    const tool = createTool(registerMemoryStoreTool, {
      ...makeRecallContext(),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
      embedder: {
        embedPassage: async () => {
          throw new Error("embedder should not run for USER.md-exclusive facts");
        },
      },
    });
    const res = await tool.execute(null, { text: "以后请叫我宙斯" });

    assert.match(res.content[0].text, /belongs in USER\.md/);
    assert.equal(res.details.action, "skipped_by_workspace_boundary");
  });

  it("skips startup profile facts in memory_store", async () => {
    const tool = createTool(registerMemoryStoreTool, {
      ...makeRecallContext(),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
      embedder: {
        embedPassage: async () => {
          throw new Error("embedder should not run for USER.md-exclusive profile facts");
        },
      },
    });
    const res = await tool.execute(null, { text: "我的时区是 Asia/Shanghai。" });

    assert.match(res.content[0].text, /belongs in USER\.md/);
    assert.equal(res.details.action, "skipped_by_workspace_boundary");
  });

  it("filters USER.md-exclusive facts from auto-recall injected text", async () => {
    MemoryRetriever.prototype.retrieve = async () => makeUserMdExclusiveResults();

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        workspaceBoundary: {
          userMdExclusive: {
            enabled: true,
          },
        },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("before_agent_start") || [];
    assert.equal(hooks.length, 1);
    const [{ handler: autoRecallHook }] = hooks;

    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-filter", sessionKey: "agent:main:session:auto-filter", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /remember this/);
    assert.doesNotMatch(output.prependContext, /称呼偏好：宙斯/);
  });

  it("filters legacy addressing memories with non-canonical fact keys", async () => {
    const tool = createTool(registerMemoryRecallTool, {
      ...makeRecallContext(makeLegacyAddressingResults()),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
    });
    const res = await tool.execute(null, { query: "legacy addressing" });

    assert.deepEqual(extractRenderedMemoryRecallLines(res.content[0].text), [
      "1. [m1] [fact:global] remember this",
      "2. [m2] [preference:global] prefer concise diffs",
    ]);
    assert.equal(res.details.memories.length, 2);
    assert.doesNotMatch(res.content[0].text, /希望在主会话中被称呼为“宙斯”/);
  });

  it("filters legacy addressing memories from auto-recall injected text", async () => {
    MemoryRetriever.prototype.retrieve = async () => makeLegacyAddressingResults();

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        workspaceBoundary: {
          userMdExclusive: {
            enabled: true,
          },
        },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("before_agent_start") || [];
    assert.equal(hooks.length, 1);
    const [{ handler: autoRecallHook }] = hooks;

    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-filter-legacy", sessionKey: "agent:main:session:auto-filter-legacy", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /remember this/);
    assert.doesNotMatch(output.prependContext, /希望在主会话中被称呼为“宙斯”/);
  });

  it("respects filterRecall=false for memory_recall output", async () => {
    const tool = createTool(registerMemoryRecallTool, {
      ...makeRecallContext(makeUserMdExclusiveResults()),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
          filterRecall: false,
        },
      },
    });
    const res = await tool.execute(null, { query: "addressing without recall filter" });

    assert.equal(res.details.memories.length, 3);
    assert.match(res.content[0].text, /称呼偏好：宙斯/);
  });
});
