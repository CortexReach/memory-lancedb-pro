import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { createRetriever } = jiti("../src/retriever.ts");

function createEntry(id, text, score, extra = {}) {
  return {
    entry: {
      id,
      text,
      vector: extra.vector || [1, 0, 0],
      category: extra.category || "fact",
      scope: extra.scope || "global",
      importance: extra.importance ?? 0.8,
      timestamp: extra.timestamp ?? Date.now(),
      metadata: extra.metadata || "{}",
    },
    score,
  };
}

describe("retriever trace and telemetry", () => {
  it("returns stage trace for vector retrieval and updates telemetry", async () => {
    const store = {
      hasFtsSupport: false,
      async vectorSearch() {
        return [
          createEntry("m1", "user prefers vim", 0.91),
          createEntry("m2", "user uses tmux daily", 0.86),
        ];
      },
    };
    const embedder = {
      async embedQuery() {
        return [1, 0, 0];
      },
    };

    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      filterNoise: false,
      rerank: "none",
    });

    const execution = await retriever.retrieveWithTrace({
      query: "what editor do I use",
      limit: 2,
      source: "manual",
    });

    assert.equal(execution.results.length, 2);
    assert.equal(execution.trace.resultCount, 2);
    assert.ok(execution.trace.totalElapsedMs >= 0);
    assert.ok(execution.trace.stages.some((stage) => stage.name === "vector_search"));
    assert.ok(execution.trace.stages.some((stage) => stage.name === "hard_min_score"));
    assert.ok(execution.trace.stages.some((stage) => stage.name === "mmr_diversity"));

    const telemetry = retriever.getTelemetry();
    assert.equal(telemetry.totalRequests, 1);
    assert.equal(telemetry.zeroResultRequests, 0);
    assert.equal(telemetry.totalResults, 2);
    assert.equal(telemetry.executedBySource.manual, 1);
    assert.equal(telemetry.sourceBreakdown.vectorOnly, 2);
  });

  it("tracks skipped requests separately from executed recalls", () => {
    const retriever = createRetriever(
      { hasFtsSupport: false, async vectorSearch() { return []; } },
      { async embedQuery() { return [0, 0, 0]; } },
      { mode: "vector" },
    );

    retriever.recordSkippedRequest("auto-recall", "adaptive_skip");
    retriever.recordSkippedRequest("auto-recall", "adaptive_skip");

    const telemetry = retriever.getTelemetry();
    assert.equal(telemetry.totalRequests, 0);
    assert.equal(telemetry.skippedRequests, 2);
    assert.equal(telemetry.skippedBySource["auto-recall"], 2);
    assert.equal(telemetry.skipReasons.adaptive_skip, 2);
  });
});
