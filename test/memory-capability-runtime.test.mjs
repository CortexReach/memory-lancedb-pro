import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createOpenClawMemoryCapability } = jiti("../src/openclaw-memory-capability.ts");

const entry = {
  id: "mem-runtime-1",
  text: "User prefers oolong tea.\nUse TypeScript for plugin runtime code.",
  category: "preference",
  scope: "agent:test",
  importance: 0.9,
  timestamp: Date.UTC(2026, 4, 23),
  metadata: "{}",
};

const calls = [];
const capability = createOpenClawMemoryCapability({
  dbPath: "/tmp/memory-lancedb-pro-test",
  vectorDim: 4,
  embeddingProvider: "openai-compatible",
  embeddingModel: "test-embedding-model",
  workspaceDir: "/tmp/openclaw-workspace",
  store: {
    async getById(id, scopeFilter) {
      calls.push({ op: "getById", id, scopeFilter });
      return id === entry.id ? entry : null;
    },
    async stats(scopeFilter) {
      calls.push({ op: "stats", scopeFilter });
      return { totalCount: 1 };
    },
  },
  retriever: {
    async retrieve(params) {
      calls.push({ op: "retrieve", params });
      return [
        {
          entry,
          score: 0.91,
          sources: {
            vector: { score: 0.82, rank: 1 },
            bm25: { score: 0.64, rank: 2 },
          },
        },
      ];
    },
  },
  resolveScopeFilterForAgent(agentId) {
    return [`agent:${agentId}`];
  },
  getRuntimeStatus() {
    return {
      embeddingAvailable: true,
      retrievalAvailable: true,
    };
  },
  async probeEmbeddingAvailability() {
    return { ok: true, checked: true };
  },
  async probeVectorAvailability() {
    return true;
  },
});

const { manager } = await capability.runtime.getMemorySearchManager({
  cfg: {},
  agentId: "test",
});

const results = await manager.search("oolong", { maxResults: 3, minScore: 0.5 });
assert.equal(results.length, 1);
assert.deepEqual(results[0], {
  path: "memory-lancedb-pro/mem-runtime-1.md",
  startLine: 1,
  endLine: 2,
  score: 0.91,
  vectorScore: 0.82,
  textScore: 0.64,
  snippet: entry.text,
  source: "memory",
  citation: "memory-lancedb-pro/mem-runtime-1.md#L1-L2",
});

assert.deepEqual(
  calls.find((call) => call.op === "retrieve")?.params.scopeFilter,
  ["agent:test"],
  "runtime should apply the agent scope filter to retrieval",
);

const noSessionResults = await manager.search("oolong", { sources: ["sessions"] });
assert.deepEqual(noSessionResults, [], "runtime should honor source filtering");

const read = await manager.readFile({
  relPath: "memory-lancedb-pro/mem-runtime-1.md",
  from: 2,
  lines: 1,
});
assert.deepEqual(read, {
  text: "Use TypeScript for plugin runtime code.",
  path: "memory-lancedb-pro/mem-runtime-1.md",
  from: 2,
  lines: 1,
});

const embedding = await manager.probeEmbeddingAvailability();
assert.equal(embedding.ok, true);
assert.equal(manager.getCachedEmbeddingAvailability().cached, true);

const vectorOk = await manager.probeVectorAvailability();
assert.equal(vectorOk, true);

const status = manager.status();
assert.equal(status.backend, "builtin");
assert.equal(status.provider, "memory-lancedb-pro");
assert.equal(status.model, "test-embedding-model");
assert.equal(status.files, 1);
assert.deepEqual(status.sources, ["memory"]);
assert.deepEqual(status.sourceCounts, [{ source: "memory", files: 1, chunks: 1 }]);

await capability.runtime.closeAllMemorySearchManagers();

console.log("OK: memory capability runtime test passed");
