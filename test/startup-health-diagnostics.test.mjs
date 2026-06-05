import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  MemoryRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
} = jiti("../src/retriever.ts");
const {
  createOpenClawMemoryCapability,
} = jiti("../src/openclaw-memory-capability.ts");

describe("startup health diagnostics", () => {
  it("preserves retrieval and FTS status failures in retriever.test()", async () => {
    const store = {
      hasFtsSupport: false,
      async refreshFtsSupport() {
        throw new Error("listIndices failed: permission denied");
      },
      async vectorSearch() {
        throw new Error("LanceDB query failed: table missing");
      },
    };
    const embedder = {
      async embedQuery() {
        return [0.1, 0.2, 0.3, 0.4];
      },
    };
    const retriever = new MemoryRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      rerank: "none",
    });

    const result = await retriever.test("health probe");

    assert.equal(result.success, false);
    assert.equal(result.hasFtsSupport, false);
    assert.equal(result.failureStage, "vector.vectorSearch");
    assert.match(result.error, /LanceDB query failed: table missing/);
    assert.match(result.error, /FTS status check failed: Error: listIndices failed: permission denied/);
  });

  it("surfaces startup health errors in runtime status metadata", async () => {
    const capability = createOpenClawMemoryCapability({
      dbPath: "/tmp/memory-lancedb-pro-health-test",
      vectorDim: 4,
      embeddingProvider: "openai-compatible",
      embeddingModel: "test-model",
      workspaceDir: "/tmp/openclaw-workspace",
      getRuntimeStatus() {
        return {
          embeddingAvailable: true,
          retrievalAvailable: false,
          retrievalError: "vector.vectorSearch: table missing",
        };
      },
      async probeEmbeddingAvailability() {
        return { ok: true, checked: true };
      },
      async probeVectorAvailability() {
        return false;
      },
    });

    const { manager } = await capability.runtime.getMemorySearchManager({
      cfg: {},
      agentId: "main",
    });
    const status = manager.status();

    assert.equal(status.fts.available, false);
    assert.equal(status.fts.error, "vector.vectorSearch: table missing");
    assert.equal(status.vector.available, false);
    assert.equal(status.vector.loadError, "vector.vectorSearch: table missing");
    assert.equal(status.custom.retrievalError, "vector.vectorSearch: table missing");
    assert.deepEqual(status.custom.startupHealth.retrieval, {
      available: false,
      error: "vector.vectorSearch: table missing",
    });
  });
});
