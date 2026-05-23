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
const corpusEntry = {
  id: "corpus:session-runtime-1",
  text: "## user\nRemember grounded session results.",
  category: "other",
  scope: "agent:test",
  importance: 0.45,
  timestamp: Date.UTC(2026, 4, 23),
  metadata: JSON.stringify({
    openclaw_corpus: true,
    corpus_source: "sessions",
    corpus_kind: "session-transcript",
    corpus_path: "sessions/test/session-runtime-1.jsonl",
    corpus_agent_id: "test",
    corpus_start_line: 1,
    corpus_end_line: 2,
  }),
};

const calls = [];
const corpusSyncCalls = [];
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
  canonicalCorpus: {
    enabled: true,
    syncOnSearch: true,
    syncIntervalMs: 0,
    includeMemoryDir: true,
    includeSessionTranscripts: true,
    includeDreamingArtifacts: true,
    maxSessionFilesPerAgent: 25,
    maxFileBytes: 1_000_000,
  },
  canonicalCorpusIndexer: {
    async sync(params) {
      corpusSyncCalls.push(params);
    },
    async readFile(relPath, from, lines) {
      if (relPath !== "memory/2026-05-23.md") return null;
      return {
        text: "Daily memory note",
        path: relPath,
        from: from ?? 1,
        lines: lines ?? 1,
      };
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
        {
          entry: corpusEntry,
          score: 0.72,
          sources: {
            vector: { score: 0.66, rank: 3 },
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
assert.equal(results.length, 2);
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
assert.deepEqual(results[1], {
  path: "sessions/test/session-runtime-1.jsonl",
  startLine: 1,
  endLine: 2,
  score: 0.72,
  vectorScore: 0.66,
  textScore: undefined,
  snippet: corpusEntry.text,
  source: "sessions",
  citation: "sessions/test/session-runtime-1.jsonl#L1-L2",
});
assert.equal(corpusSyncCalls[0]?.reason, "search", "runtime search should sync canonical corpus opportunistically");

assert.deepEqual(
  calls.find((call) => call.op === "retrieve")?.params.scopeFilter,
  ["agent:test"],
  "runtime should apply the agent scope filter to retrieval",
);

const noSessionResults = await manager.search("oolong", { sources: ["sessions"] });
assert.deepEqual(noSessionResults, [results[1]], "runtime should honor source filtering");

const corpusRead = await manager.readFile({
  relPath: "memory/2026-05-23.md",
  from: 1,
  lines: 1,
});
assert.deepEqual(corpusRead, {
  text: "Daily memory note",
  path: "memory/2026-05-23.md",
  from: 1,
  lines: 1,
});

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
assert.deepEqual(status.sources, ["memory", "sessions"]);
assert.deepEqual(status.sourceCounts, [{ source: "memory", files: 1, chunks: 1 }]);
assert.equal(status.custom.canonicalCorpus.enabled, true);

await manager.sync({ reason: "manual", force: true });
assert.ok(
  corpusSyncCalls.some((call) => call?.reason === "manual" && call?.force === true),
  "runtime sync should delegate to canonical corpus indexer",
);

await capability.runtime.closeAllMemorySearchManagers();

console.log("OK: memory capability runtime test passed");
