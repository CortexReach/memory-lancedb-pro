import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

const { registerMemoryRecallTool } = jiti("../src/tools.ts");

function makeResult() {
  return [
    {
      entry: {
        id: "m1",
        text: "remember this",
        category: "fact",
        scope: "global",
        importance: 0.7,
      },
      score: 0.82,
      sources: {
        vector: { score: 0.82, rank: 1 },
        bm25: { score: 0.88, rank: 2 },
      },
    },
  ];
}

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

function makeContext({ expose = false } = {}) {
  return {
    retriever: {
      async retrieve() {
        return makeResult();
      },
      getConfig() {
        return { mode: "hybrid" };
      },
    },
    store: {},
    scopeManager: {
      getAccessibleScopes: () => ["global"],
      isAccessible: () => true,
      getDefaultScope: () => "global",
    },
    embedder: { embedPassage: async () => [] },
    agentId: "main",
    workspaceDir: "/tmp",
    mdMirror: null,
    exposeRetrievalMetadata: expose,
  };
}

describe("memory_recall exposeRetrievalMetadata", () => {
  it("does not include debug when exposeRetrievalMetadata=false", async () => {
    const { api, getCreator } = makeApiCapture();
    const context = makeContext({ expose: false });
    registerMemoryRecallTool(api, context);
    const creator = getCreator();
    assert.ok(typeof creator === "function");
    const tool = creator({});
    const res = await tool.execute(null, { query: "test" });
    assert.equal(res.details.count, 1);
    assert.ok(Array.isArray(res.details.memories));
    assert.equal(res.details.debug, undefined);
    // memory items should not include score/sources
    assert.equal(Object.prototype.hasOwnProperty.call(res.details.memories[0], "score"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(res.details.memories[0], "sources"), false);
  });

  it("includes debug when exposeRetrievalMetadata=true", async () => {
    const { api, getCreator } = makeApiCapture();
    const context = makeContext({ expose: true });
    registerMemoryRecallTool(api, context);
    const creator = getCreator();
    assert.ok(typeof creator === "function");
    const tool = creator({});
    const res = await tool.execute(null, { query: "test" });
    assert.equal(res.details.count, 1);
    assert.ok(Array.isArray(res.details.memories));
    assert.ok(Array.isArray(res.details.debug));
    assert.equal(typeof res.details.debug[0].score, "number");
    assert.ok(res.details.debug[0].sources.vector);
  });
});
