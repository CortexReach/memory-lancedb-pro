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

// IMPORTANT: Get retriever/embedder module references BEFORE importing index.ts.
// This is because index.ts captures the createRetriever/createEmbedder binding at
// import time. We must reassign the module's exports before index.ts loads.
const retrieverModuleForMock = jiti("../src/retriever.js");
const embedderModuleForMock = jiti("../src/embedder.js");
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const {
  registerMemoryExplainRankTool,
  registerMemoryRecallTool,
  registerMemoryStoreTool,
} = jiti("../src/tools.ts");
const { MemoryRetriever } = jiti("../src/retriever.js");
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

function confirmedMetadata(overrides = {}) {
  return JSON.stringify({
    state: "confirmed",
    memory_layer: "durable",
    ...overrides,
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
        metadata: confirmedMetadata(),
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
        metadata: confirmedMetadata(),
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
        metadata: confirmedMetadata(),
      },
      score: 0.65,
      sources: {
        vector: { score: 0.65, rank: 3 },
      },
    },
  ];
}

function makeNeighborSummaryResults() {
  return [
    {
      entry: {
        id: "m-neighbor-primary",
        text: "primary alpha",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: confirmedMetadata(),
      },
      score: 0.82,
      sources: {
        vector: { score: 0.82, rank: 1 },
      },
      neighbors: [
        {
          entry: {
            id: "n1",
            text: "neighbor beta detail should share the same per item budget instead of expanding the summary line",
            category: "fact",
            scope: "global",
            importance: 0.6,
            timestamp: Date.now(),
            metadata: confirmedMetadata(),
          },
          score: 0.7,
          sources: {
            bm25: { score: 0.7, rank: 1 },
          },
        },
      ],
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

function makeManyResults(count = 7) {
  return Array.from({ length: count }, (_, i) => {
    const id = `m${i + 1}`;
    return {
      entry: {
        id,
        text: `memory-${i + 1} ${"x".repeat(240)}`,
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: confirmedMetadata(),
      },
      score: 0.9 - i * 0.05,
      sources: {
        vector: { score: 0.9 - i * 0.05, rank: i + 1 },
      },
    };
  });
}

function makeGovernanceFilteredResults() {
  const now = Date.now();
  return [
    {
      entry: {
        id: "c1",
        text: "confirmed durable memory",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({
          l0_abstract: "confirmed durable memory",
          memory_category: "cases",
          state: "confirmed",
          memory_layer: "durable",
          source: "manual",
        }),
      },
      score: 0.93,
      sources: { vector: { score: 0.93, rank: 1 } },
    },
    {
      entry: {
        id: "p1",
        text: "pending memory should not auto-recall",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({
          l0_abstract: "pending memory should not auto-recall",
          memory_category: "cases",
          state: "pending",
          memory_layer: "working",
          source: "auto-capture",
        }),
      },
      score: 0.9,
      sources: { vector: { score: 0.9, rank: 2 } },
    },
    {
      entry: {
        id: "a1",
        text: "archived memory should not auto-recall",
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({
          l0_abstract: "archived memory should not auto-recall",
          memory_category: "cases",
          state: "archived",
          memory_layer: "archive",
          source: "manual",
        }),
      },
      score: 0.88,
      sources: { vector: { score: 0.88, rank: 3 } },
    },
  ];
}

function makeNeighborGovernanceResults() {
  const now = Date.now();
  const result = (id, text, metadataOverrides = {}, neighbors = []) => ({
    entry: {
      id,
      text,
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: now,
      metadata: confirmedMetadata(metadataOverrides),
    },
    score: 0.9,
    sources: { vector: { score: 0.9, rank: 1 } },
    ...(neighbors.length > 0 ? { neighbors } : {}),
  });
  const userMdExclusiveNeighbor = result("neighbor-user-md", "称呼偏好：宙斯", {
    l0_abstract: "称呼偏好：宙斯",
    l1_overview: "## Addressing\n- Preferred form of address: 宙斯",
    l2_content: "用户希望以后被称呼为“宙斯”。",
    memory_category: "preferences",
    fact_key: "preferences:称呼偏好",
  });
  const sharedNeighbor = result("neighbor-shared", "shared neighbor should appear once");
  return [
    result("primary-1", "primary one", {}, [
      sharedNeighbor,
      result("neighbor-pending", "pending neighbor should not appear", { state: "pending", memory_layer: "working" }),
      result("neighbor-archive", "archive neighbor should not appear", { state: "archived", memory_layer: "archive" }),
      result("neighbor-reflection", "reflection neighbor should not appear", { memory_layer: "reflection" }),
      result("neighbor-suppressed", "suppressed neighbor should not appear", { suppressed_until_ms: now + 60_000 }),
      userMdExclusiveNeighbor,
    ]),
    result("primary-2", "primary two", {}, [
      sharedNeighbor,
      result("neighbor-unique", "unique safe neighbor"),
    ]),
  ];
}

function makeRecallContext(results = makeResults()) {
  return {
    retriever: {
      async retrieve(params = {}) {
        const rawLimit = typeof params.limit === "number" ? params.limit : results.length;
        const safeLimit = Math.max(1, Math.floor(rawLimit));
        return results.slice(0, safeLimit);
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
    resetRegistration();
  });

  afterEach(() => {
    MemoryRetriever.prototype.retrieve = originalRetrieve;
    // Restore factory functions on the .js module (same cache as index.ts uses)
    retrieverModuleForMock.createRetriever = origCreateRetriever;
    embedderModuleForMock.createEmbedder = origCreateEmbedder;
    resetRegistration();
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

  it("returns manual recall results before access metadata patches settle", async () => {
    const context = makeRecallContext();
    let releasePatchGate;
    const patchGate = new Promise((resolve) => {
      releasePatchGate = resolve;
    });
    const patchPromises = [];
    const patchCalls = [];
    let patchMetadataCalls = 0;
    let patchMetadataSettled = 0;

    context.store.patchMetadata = (id, patch, scopeFilter) => {
      patchMetadataCalls++;
      patchCalls.push({ id, patch, scopeFilter });
      const patchPromise = patchGate.then(() => {
        patchMetadataSettled++;
        return null;
      });
      patchPromises.push(patchPromise);
      return patchPromise;
    };

    const tool = createTool(registerMemoryRecallTool, context);
    const recallPromise = tool.execute(null, { query: "test" });
    const timeoutMarker = Symbol("timeout");
    const output = await Promise.race([
      recallPromise,
      new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), 500)),
    ]);

    try {
      assert.notEqual(output, timeoutMarker, "access metadata patches must not block manual recall");
      assert.match(output.content[0].text, /<relevant-memories>/);
      assert.equal(patchMetadataCalls, 2, "background access metadata patches should still start");
      assert.equal(patchMetadataSettled, 0, "manual recall should return before access metadata patches settle");
      assert.deepEqual(
        patchCalls.map(({ id, scopeFilter }) => ({ id, scopeFilter })),
        [
          { id: "m1", scopeFilter: ["global"] },
          { id: "m2", scopeFilter: ["global"] },
        ],
      );
      assert.deepEqual(patchCalls[0].patch, {
        access_count: 1,
        last_accessed_at: patchCalls[0].patch.last_accessed_at,
        last_confirmed_use_at: patchCalls[0].patch.last_confirmed_use_at,
        bad_recall_count: 0,
        suppressed_until_turn: 0,
        suppressed_until_ms: 0,
      });
      assert.equal(patchCalls[0].patch.last_accessed_at, patchCalls[0].patch.last_confirmed_use_at);
    } finally {
      releasePatchGate();
      await Promise.all(patchPromises);
      await recallPromise;
    }

    assert.equal(patchMetadataSettled, 2, "background access metadata patches should eventually settle");
  });

  it("logs rejected background manual recall metadata patches", async () => {
    const context = makeRecallContext();
    context.store.patchMetadata = async (id) => {
      if (id === "m1") throw new Error("simulated metadata write failure");
      return null;
    };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      const tool = createTool(registerMemoryRecallTool, context);
      const output = await tool.execute(null, { query: "test" });
      await new Promise((resolve) => setImmediate(resolve));

      assert.match(output.content[0].text, /<relevant-memories>/);
      assert.ok(
        warnings.some((line) => /background manual recall metadata patch failed for 1\/2 memories/.test(line)),
        `expected background patch warning; warnings=${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps memory_recall neighbor summaries within the per-item character budget", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext(makeNeighborSummaryResults()));
    const res = await tool.execute(null, {
      query: "neighbor budget",
      maxCharsPerItem: 60,
    });

    const line = extractRenderedMemoryRecallLines(res.content[0].text)[0];
    const summary = line.replace(/^1\. \[m-neighbor-primary\] \[fact:global\] /, "");

    assert.match(summary, /Neighbors:/);
    assert.ok(summary.length <= 60, `expected ${summary.length} chars to stay within the configured budget`);
    assert.match(summary, /…$/);
    assert.doesNotMatch(summary, /expanding the summary line/);
    assert.equal(res.details.memories[0].neighbors.length, 1);
  });

  it("filters boundary-sensitive and governance-ineligible neighbors from memory_recall output and details", async () => {
    const tool = createTool(registerMemoryRecallTool, {
      ...makeRecallContext(makeNeighborGovernanceResults()),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
    });
    const res = await tool.execute(null, {
      query: "neighbor governance",
      limit: 2,
      maxCharsPerItem: 1000,
    });

    assert.match(res.content[0].text, /neighbor-shared/);
    assert.match(res.content[0].text, /neighbor-unique/);
    assert.doesNotMatch(res.content[0].text, /neighbor-user-md|称呼偏好：宙斯/);
    assert.doesNotMatch(res.content[0].text, /neighbor-pending|pending neighbor should not appear/);
    assert.doesNotMatch(res.content[0].text, /neighbor-archive|archive neighbor should not appear/);
    assert.doesNotMatch(res.content[0].text, /neighbor-reflection|reflection neighbor should not appear/);
    assert.doesNotMatch(res.content[0].text, /neighbor-suppressed|suppressed neighbor should not appear/);

    assert.deepEqual(
      res.details.memories.map((memory) => memory.neighbors?.map((neighbor) => neighbor.id) ?? []),
      [
        ["neighbor-shared"],
        ["neighbor-shared", "neighbor-unique"],
      ],
    );
    assert.doesNotMatch(JSON.stringify(res.details.memories), /neighbor-user-md|称呼偏好：宙斯/);
    assert.doesNotMatch(JSON.stringify(res.details.memories), /neighbor-pending|neighbor-archive|neighbor-reflection|neighbor-suppressed/);
  });

  it("omits unfiltered neighbors from non-recall serialized tool details", async () => {
    const tool = createTool(registerMemoryExplainRankTool, {
      ...makeRecallContext(makeNeighborGovernanceResults()),
      workspaceBoundary: {
        userMdExclusive: {
          enabled: true,
        },
      },
    });
    const res = await tool.execute(null, {
      query: "neighbor governance",
      limit: 2,
    });

    assert.equal(res.details.results.length, 2);
    assert.equal(res.details.results[0].neighbors, undefined);
    assert.equal(res.details.results[1].neighbors, undefined);
    assert.doesNotMatch(JSON.stringify(res.details.results), /neighbor-user-md|称呼偏好：宙斯/);
    assert.doesNotMatch(JSON.stringify(res.details.results), /neighbor-pending|neighbor-archive|neighbor-reflection|neighbor-suppressed/);
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
    // jiti caches ./src/retriever.js (used by index.ts) and ../src/retriever.ts
    // (used by the test) as SEPARATE module instances.  Patching
    // MemoryRetriever.prototype does NOT reach the instance the plugin creates
    // via createRetriever.  Instead we intercept the factory.
    const mockResults = makeResults();
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever(store, embedder, config, options) {
      return {
        async retrieve(context = {}) {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);

    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-clean", sessionKey: "agent:main:session:auto-clean", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /<mode:full>/);
    assert.match(output.prependContext, /remember this/);
    assert.match(output.prependContext, /prefer concise diffs/);
    assert.doesNotMatch(output.prependContext, /vector\+BM25/);
    assert.doesNotMatch(output.prependContext, /reranked/);
    assert.doesNotMatch(output.prependContext, /\d+%/);
  });

  it("defaults memory_recall to concise output (limit=3, preview text)", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext(makeManyResults(7)));
    const res = await tool.execute(null, { query: "many memories" });
    const lines = extractRenderedMemoryRecallLines(res.content[0].text);

    assert.equal(lines.length, 3, "default recall should return 3 items");
    assert.match(lines[0], /…$/, "default recall should return truncated preview text");
  });

  it("caps summary-mode memory_recall results to 6 even if a larger limit is requested", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext(makeManyResults(9)));
    const res = await tool.execute(null, { query: "many memories", limit: 10 });
    const lines = extractRenderedMemoryRecallLines(res.content[0].text);
    assert.match(res.content[0].text, /<mode:summary>/);

    assert.equal(lines.length, 6, "summary mode should clamp limit to 6");
  });

  it("allows larger limits when includeFullText=true", async () => {
    const tool = createTool(registerMemoryRecallTool, makeRecallContext(makeManyResults(9)));
    const res = await tool.execute(null, {
      query: "many memories",
      limit: 7,
      includeFullText: true,
    });
    const lines = extractRenderedMemoryRecallLines(res.content[0].text);
    assert.match(res.content[0].text, /<mode:full>/);

    assert.equal(lines.length, 7, "full text mode should honor larger limits");
    assert.doesNotMatch(lines[0], /…$/, "full text mode should not force preview truncation");
  });

  it("includeFullText=true renders L2 content in output, not L0 abstract", async () => {
    const l0 = "short L0 abstract";
    const l2 = "Full L2 narrative: the user resolved a concurrent-write conflict by adding proper-lockfile as a write guard around all LanceDB mutation calls. Prevention: always acquire the lock before any store.add / store.update call.";

    const results = [
      {
        entry: {
          id: "case-1",
          text: l0,
          category: "fact",
          scope: "global",
          importance: 0.85,
          timestamp: Date.now(),
          metadata: stringifySmartMetadata(
            buildSmartMetadata(
              { text: l0, category: "fact", importance: 0.85 },
              {
                l0_abstract: l0,
                l1_overview: "## Conflict\n- LanceDB concurrent write resolved via proper-lockfile",
                l2_content: l2,
                memory_category: "cases",
                fact_key: "cases:lancedb-write-conflict",
              },
            ),
          ),
        },
        score: 0.95,
        sources: { vector: { score: 0.95, rank: 1 } },
      },
    ];

    // default (summary) mode should show L0
    const toolSummary = createTool(registerMemoryRecallTool, makeRecallContext(results));
    const resSummary = await toolSummary.execute(null, { query: "lancedb conflict" });
    const summaryLines = extractRenderedMemoryRecallLines(resSummary.content[0].text);
    assert.equal(summaryLines.length, 1);
    assert.match(summaryLines[0], new RegExp(l0.slice(0, 20)));
    assert.doesNotMatch(summaryLines[0], /Full L2 narrative/);

    // includeFullText=true should show L2 in rendered output
    const toolFull = createTool(registerMemoryRecallTool, makeRecallContext(results));
    const resFull = await toolFull.execute(null, { query: "lancedb conflict", includeFullText: true });
    const fullLines = extractRenderedMemoryRecallLines(resFull.content[0].text);
    assert.equal(fullLines.length, 1);
    assert.match(fullLines[0], /Full L2 narrative/, "rendered line should contain L2 content");
    assert.doesNotMatch(fullLines[0], new RegExp(`^.*\\[case-1\\].*${l0.slice(0, 15)}`), "rendered line should not be the L0 abstract");

    // details.memories[].fullText should carry L2
    assert.equal(resFull.details.memories[0].fullText, l2, "details.memories[0].fullText should be L2 content");
    // details.memories[].text still carries L0 for backwards compatibility
    assert.equal(resFull.details.memories[0].text, l0, "details.memories[0].text should still be L0 for compatibility");
  });

  it("includeFullText=false does not expose fullText in details.memories", async () => {
    const l0 = "short L0 abstract";
    const l2 = "Full L2 narrative that should not appear when includeFullText is false.";

    const results = [
      {
        entry: {
          id: "case-2",
          text: l0,
          category: "fact",
          scope: "global",
          importance: 0.85,
          timestamp: Date.now(),
          metadata: stringifySmartMetadata(
            buildSmartMetadata(
              { text: l0, category: "fact", importance: 0.85 },
              {
                l0_abstract: l0,
                l1_overview: "## Overview\n- some overview",
                l2_content: l2,
                memory_category: "cases",
                fact_key: "cases:opt-in-check",
              },
            ),
          ),
        },
        score: 0.9,
        sources: { vector: { score: 0.9, rank: 1 } },
      },
    ];

    const tool = createTool(registerMemoryRecallTool, makeRecallContext(results));
    const res = await tool.execute(null, { query: "opt-in check" });

    assert.equal(res.details.memories[0].fullText, undefined, "fullText should be absent when includeFullText=false");
    assert.equal(res.details.memories[0].text, l0, "text should still carry L0");
  });

  it("includeFullText=true falls back to entry.text for legacy memories without smart metadata", async () => {
    const legacyText = "legacy memory with no smart metadata at all";

    const results = [
      {
        entry: {
          id: "legacy-1",
          text: legacyText,
          category: "fact",
          scope: "global",
          importance: 0.6,
          timestamp: Date.now(),
          // no metadata field — simulates pre-smart-extraction records
        },
        score: 0.75,
        sources: { vector: { score: 0.75, rank: 1 } },
      },
    ];

    const tool = createTool(registerMemoryRecallTool, makeRecallContext(results));
    const res = await tool.execute(null, { query: "legacy fallback", includeFullText: true });
    const lines = extractRenderedMemoryRecallLines(res.content[0].text);

    assert.equal(lines.length, 1);
    assert.match(lines[0], /legacy memory with no smart metadata/, "should render entry.text as fallback for legacy memories");
    assert.equal(res.details.memories[0].fullText, legacyText, "details.memories[0].fullText should fall back to entry.text");
  });


  it("applies auto-recall item/char budgets before injecting context", async () => {
    // Intercept the factory functions instead of patching prototype (same jiti
    // cache mismatch reason as the test above).
    const mockResults = makeManyResults(5);
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever(store, embedder, config, options) {
      return {
        async retrieve(context = {}) {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        autoRecallMaxItems: 2,
        autoRecallMaxChars: 160,
        autoRecallPerItemMaxChars: 100,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);
    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-budget", sessionKey: "agent:main:session:auto-budget", agentId: "main" }
    );

    assert.ok(output);
    const injectedLines = output.prependContext
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    assert.ok(injectedLines.length <= 2, "injected lines should respect autoRecallMaxItems");
  });

  it("auto-recall only injects confirmed non-archived memories", async () => {
    // Intercept the factory functions instead of patching prototype (same jiti
    // cache mismatch reason as the test above).
    const mockResults = makeGovernanceFilteredResults();
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever(store, embedder, config, options) {
      return {
        async retrieve(context = {}) {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        autoRecallMaxItems: 5,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });
    memoryLanceDBProPlugin.register(harness.api);
    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-governance", sessionKey: "agent:main:session:auto-governance", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /confirmed durable memory/);
    assert.doesNotMatch(output.prependContext, /pending memory should not auto-recall/);
    assert.doesNotMatch(output.prependContext, /archived memory should not auto-recall/);
  });

  it("applies auto-recall governance and dedupe to related neighbor snippets", async () => {
    const mockResults = makeNeighborGovernanceResults();
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever() {
      return {
        async retrieve() {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        autoRecallMaxItems: 5,
        autoRecallMaxChars: 3000,
        autoRecallPerItemMaxChars: 1000,
        workspaceBoundary: {
          userMdExclusive: {
            enabled: true,
          },
        },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });
    memoryLanceDBProPlugin.register(harness.api);
    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);
    const output = await autoRecallHook(
      { prompt: "Please recall related details for this task." },
      { sessionId: "auto-neighbor-governance", sessionKey: "agent:main:session:auto-neighbor-governance", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /primary one/);
    assert.match(output.prependContext, /primary two/);
    assert.match(output.prependContext, /shared neighbor should appear once/);
    assert.match(output.prependContext, /unique safe neighbor/);
    assert.equal(
      (output.prependContext.match(/shared neighbor should appear once/g) || []).length,
      1,
      "duplicate neighbor ids should render once across auto-recall lines",
    );
    assert.doesNotMatch(output.prependContext, /pending neighbor should not appear/);
    assert.doesNotMatch(output.prependContext, /archive neighbor should not appear/);
    assert.doesNotMatch(output.prependContext, /reflection neighbor should not appear/);
    assert.doesNotMatch(output.prependContext, /suppressed neighbor should not appear/);
    assert.doesNotMatch(output.prependContext, /称呼偏好：宙斯/);
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
    // Intercept the factory functions instead of patching prototype (same jiti
    // cache mismatch reason as the test above).
    const mockResults = makeUserMdExclusiveResults();
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever(store, embedder, config, options) {
      return {
        async retrieve(context = {}) {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        workspaceBoundary: {
          userMdExclusive: {
            enabled: true,
          },
        },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);

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
    // Intercept the factory functions instead of patching prototype (same jiti
    // cache mismatch reason as the test above).
    const mockResults = makeLegacyAddressingResults();
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever(store, embedder, config, options) {
      return {
        async retrieve(context = {}) {
          return mockResults;
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
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
        workspaceBoundary: {
          userMdExclusive: {
            enabled: true,
          },
        },
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const autoRecallHook = getAutoRecallHook(harness.eventHandlers);

    const output = await autoRecallHook(
      { prompt: "Please recall what I mentioned before about this task." },
      { sessionId: "auto-filter-legacy", sessionKey: "agent:main:session:auto-filter-legacy", agentId: "main" }
    );

    assert.ok(output);
    assert.match(output.prependContext, /remember this/);
    assert.doesNotMatch(output.prependContext, /希望在主会话中被称呼为"宙斯"/);
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

  // --- PR #602: recall prefix format tests ---

  function makeAutoRecallHarness(workspaceDir, mockResults, extraConfig = {}) {
    const retrieverMod = jiti("../src/retriever.js");
    retrieverMod.createRetriever = function mockCreateRetriever() {
      return {
        async retrieve() { return mockResults; },
        getConfig() { return { mode: "hybrid" }; },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };
    const embedderMod = jiti("../src/embedder.js");
    embedderMod.createEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() { return new Float32Array(384).fill(0); },
        async embedPassage() { return new Float32Array(384).fill(0); },
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
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        ...extraConfig,
      },
    });
    memoryLanceDBProPlugin.register(harness.api);
    return getAutoRecallHook(harness.eventHandlers);
  }

  it("uses configured categoryField as display category when field is present in metadata", async () => {
    const ts = new Date("2024-05-30T00:00:00.000Z").getTime();
    const hook = makeAutoRecallHarness(workspaceDir, [
      {
        entry: {
          id: "apple-1",
          text: "reach revenue goal of $1M ARR by end of 2025",
          category: "other",
          scope: "global",
          importance: 0.8,
          timestamp: ts,
          metadata: confirmedMetadata({ folder: "Goals", source: "manual" }),
        },
        score: 0.9,
        sources: { vector: { score: 0.9, rank: 1 } },
      },
    ], { recallPrefix: { categoryField: "folder" } });

    const output = await hook(
      { prompt: "What are my goals?" },
      { sessionId: "apple-prefix-test", sessionKey: "agent:main:session:apple-prefix-test", agentId: "main" },
    );

    assert.ok(output, "expected recall output");
    // metadata.folder replaces the built-in category in the prefix
    assert.match(output.prependContext, /\[Goals:/);
    assert.doesNotMatch(output.prependContext, /\[other:/);
    // Date is appended from timestamp
    assert.match(output.prependContext, /2024-05-30/);
    // Source suffix is present
    assert.match(output.prependContext, /\(manual\)/);
  });

  it("falls back to built-in category when categoryField is configured but absent from metadata", async () => {
    const hook = makeAutoRecallHarness(workspaceDir, [
      {
        entry: {
          id: "plain-1",
          text: "prefer short commit messages",
          category: "preference",
          scope: "global",
          importance: 0.7,
          timestamp: Date.now(),
          metadata: confirmedMetadata(),
        },
        score: 0.85,
        sources: { vector: { score: 0.85, rank: 1 } },
      },
    ], { recallPrefix: { categoryField: "folder" } });

    const output = await hook(
      { prompt: "What are my preferences?" },
      { sessionId: "no-folder-test", sessionKey: "agent:main:session:no-folder-test", agentId: "main" },
    );

    assert.ok(output, "expected recall output");
    assert.match(output.prependContext, /prefer short commit messages/);
    // Falls back to built-in category (parseSmartMetadata maps "preference" → "preferences")
    assert.match(output.prependContext, /\[preferences:global\]/);
    assert.doesNotMatch(output.prependContext, /\[Goals:/);
  });

  it("uses built-in category unchanged when recallPrefix.categoryField is not configured", async () => {
    const hook = makeAutoRecallHarness(workspaceDir, [
      {
        entry: {
          id: "default-1",
          text: "prefer short commit messages",
          category: "preference",
          scope: "global",
          importance: 0.7,
          timestamp: Date.now(),
          metadata: confirmedMetadata({ folder: "Preferences", source: "manual" }),
        },
        score: 0.85,
        sources: { vector: { score: 0.85, rank: 1 } },
      },
    ]); // no recallPrefix config

    const output = await hook(
      { prompt: "What are my preferences?" },
      { sessionId: "default-prefix-test", sessionKey: "agent:main:session:default-prefix-test", agentId: "main" },
    );

    assert.ok(output, "expected recall output");
    assert.match(output.prependContext, /prefer short commit messages/);
    // No categoryField configured — folder is ignored, built-in category used
    assert.match(output.prependContext, /\[preferences:global\]/);
    assert.doesNotMatch(output.prependContext, /\[Preferences:/);
  });

  it("includes tier prefix in recall line when tier metadata is present", async () => {
    const hook = makeAutoRecallHarness(workspaceDir, [
      {
        entry: {
          id: "tiered-1",
          text: "always use absolute imports",
          category: "fact",
          scope: "global",
          importance: 0.9,
          timestamp: Date.now(),
          metadata: confirmedMetadata({ tier: "l1" }),
        },
        score: 0.88,
        sources: { vector: { score: 0.88, rank: 1 } },
      },
      {
        entry: {
          id: "tiered-2",
          text: "prefer TypeScript strict mode",
          category: "preference",
          scope: "global",
          importance: 0.85,
          timestamp: Date.now(),
          metadata: confirmedMetadata({ tier: "l2" }),
        },
        score: 0.82,
        sources: { vector: { score: 0.82, rank: 2 } },
      },
    ]);

    const output = await hook(
      { prompt: "What are my coding preferences?" },
      { sessionId: "tier-prefix-test", sessionKey: "agent:main:session:tier-prefix-test", agentId: "main" },
    );

    assert.ok(output, "expected recall output");
    // Both entries should have a tier prefix (first char of tier, uppercased, in brackets)
    const lines = output.prependContext.split("\n").filter((l) => l.startsWith("- ["));
    assert.ok(lines.length >= 2, "expected at least 2 recall lines");
    for (const line of lines) {
      assert.match(line, /^- \[[A-Z]\]\[/, "recall line should start with tier prefix [X][");
    }
  });
});
