import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { expandQuery } = jiti("../src/query-expander.ts");
const { createRetriever } = jiti("../src/retriever.ts");
const { createMemoryCLI } = jiti("../cli.ts");

function buildResult(id = "memory-1", text = "服务崩溃 error") {
  return {
    entry: {
      id,
      text,
      vector: [0.1, 0.2, 0.3],
      category: "other",
      scope: "global",
      importance: 0.7,
      timestamp: 1700000000000,
      metadata: "{}",
    },
    score: 0.9,
  };
}

describe("query expander", () => {
  it("expands colloquial Chinese crash queries with technical BM25 terms", () => {
    const expanded = expandQuery("服务挂了");
    assert.notEqual(expanded, "服务挂了");
    assert.match(expanded, /崩溃/);
    assert.match(expanded, /crash/);
    assert.match(expanded, /报错|error/);
  });

  it("avoids english substring false positives", () => {
    assert.equal(expandQuery("memorybank retention"), "memorybank retention");
    assert.equal(expandQuery("configurable loader"), "configurable loader");
  });
});

describe("retriever BM25 query expansion gating", () => {
  function createRetrieverHarness(
    config = {},
    storeOverrides = {},
    embedderOverrides = {},
  ) {
    const bm25Queries = [];
    const embeddedQueries = [];

    const retriever = createRetriever(
      {
        hasFtsSupport: true,
        async vectorSearch() {
          return [];
        },
        async bm25Search(query) {
          bm25Queries.push(query);
          return [buildResult()];
        },
        async hasId() {
          return true;
        },
        ...storeOverrides,
      },
      {
        async embedQuery(query) {
          embeddedQueries.push(query);
          return [0.1, 0.2, 0.3];
        },
        ...embedderOverrides,
      },
      {
        rerank: "none",
        filterNoise: false,
        minScore: 0,
        hardMinScore: 0,
        candidatePoolSize: 5,
        ...config,
      },
    );

    return { retriever, bm25Queries, embeddedQueries };
  }

  it("expands only the BM25 leg for manual retrieval", async () => {
    const { retriever, bm25Queries, embeddedQueries } = createRetrieverHarness();

    const results = await retriever.retrieve({
      query: "服务挂了",
      limit: 1,
      source: "manual",
    });

    assert.equal(results.length, 1);
    assert.deepEqual(embeddedQueries, ["服务挂了"]);
    assert.equal(bm25Queries.length, 1);
    assert.notEqual(bm25Queries[0], "服务挂了");
    assert.match(bm25Queries[0], /crash/);
    assert.deepEqual(retriever.getLastDiagnostics(), {
      source: "manual",
      mode: "hybrid",
      originalQuery: "服务挂了",
      bm25Query: bm25Queries[0],
      queryExpanded: true,
      limit: 1,
      scopeFilter: undefined,
      category: undefined,
      vectorResultCount: 0,
      bm25ResultCount: 1,
      fusedResultCount: 1,
      finalResultCount: 1,
      stageCounts: {
        afterMinScore: 1,
        rerankInput: 1,
        afterRerank: 1,
        afterRecency: 1,
        afterImportance: 1,
        afterLengthNorm: 1,
        afterTimeDecay: 1,
        afterHardMinScore: 1,
        afterNoiseFilter: 1,
        afterDiversity: 1,
      },
      dropSummary: [],
    });
  });

  it("keeps auto-recall and unspecified retrieval on the original query", async () => {
    const autoRecallHarness = createRetrieverHarness();
    await autoRecallHarness.retriever.retrieve({
      query: "服务挂了",
      limit: 1,
      source: "auto-recall",
    });
    assert.deepEqual(autoRecallHarness.bm25Queries, ["服务挂了"]);

    const unspecifiedHarness = createRetrieverHarness();
    await unspecifiedHarness.retriever.retrieve({
      query: "服务挂了",
      limit: 1,
    });
    assert.deepEqual(unspecifiedHarness.bm25Queries, ["服务挂了"]);
  });

  it("honors retrieval.queryExpansion = false", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness({
      queryExpansion: false,
    });

    await retriever.retrieve({
      query: "服务挂了",
      limit: 1,
      source: "manual",
    });

    assert.deepEqual(bm25Queries, ["服务挂了"]);
  });

  it("summarizes the biggest count drops without changing retrieval behavior", async () => {
    const { retriever } = createRetrieverHarness(
      {
        rerank: "none",
        filterNoise: false,
        minScore: 0,
        hardMinScore: 0,
      },
      {
        async bm25Search() {
          return [
            buildResult("memory-1", "故障一"),
            buildResult("memory-2", "故障二"),
            buildResult("memory-3", "故障三"),
          ];
        },
      },
    );

    const results = await retriever.retrieve({
      query: "普通查询",
      limit: 1,
      source: "manual",
    });

    assert.equal(results.length, 1);
    assert.deepEqual(retriever.getLastDiagnostics()?.dropSummary, [
      {
        stage: "limit",
        before: 3,
        after: 1,
        dropped: 2,
      },
    ]);
  });

  it("captures partial diagnostics when retrieval fails before search completes", async () => {
    const { retriever } = createRetrieverHarness(
      {},
      {},
      {
        async embedQuery() {
          throw new Error("simulated embed failure");
        },
      },
    );

    await assert.rejects(
      retriever.retrieve({
        query: "服务挂了",
        limit: 1,
        source: "manual",
      }),
      /simulated embed failure/,
    );

    assert.deepEqual(retriever.getLastDiagnostics(), {
      source: "manual",
      mode: "hybrid",
      originalQuery: "服务挂了",
      bm25Query: "服务挂了",
      queryExpanded: false,
      limit: 1,
      scopeFilter: undefined,
      category: undefined,
      vectorResultCount: 0,
      bm25ResultCount: 0,
      fusedResultCount: 0,
      finalResultCount: 0,
      stageCounts: {
        afterMinScore: 0,
        rerankInput: 0,
        afterRerank: 0,
        afterRecency: 0,
        afterImportance: 0,
        afterLengthNorm: 0,
        afterTimeDecay: 0,
        afterHardMinScore: 0,
        afterNoiseFilter: 0,
        afterDiversity: 0,
      },
      dropSummary: [],
      failureStage: "hybrid.embedQuery",
      errorMessage: "simulated embed failure",
    });
  });

  it("distinguishes vector-search failures inside the hybrid parallel stage", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async vectorSearch() {
          throw new Error("simulated vector search failure");
        },
      },
    );

    // With graceful degradation, BM25 results should be returned even though vector failed
    const results = await retriever.retrieve({
      query: "普通查询",
      limit: 1,
      source: "manual",
    });

    // Results from BM25 should be returned
    assert.ok(results.length > 0);
    assert.ok(bm25Queries.length > 0);

    // Overall retrieval did not fail (graceful degradation)
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      undefined,
    );
    // Vector result count should be 0 (failed)
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    // BM25 result count should be > 0 (succeeded)
    assert.ok(
      (retriever.getLastDiagnostics()?.bm25ResultCount ?? 0) > 0,
    );
  });

  it("distinguishes bm25-search failures inside the hybrid parallel stage", async () => {
    const { retriever, bm25Queries } = createRetrieverHarness(
      {},
      {
        async bm25Search(query) {
          bm25Queries.push(query);
          throw new Error("simulated bm25 search failure");
        },
      },
    );

    // With graceful degradation, vector results should be returned even though BM25 failed
    const results = await retriever.retrieve({
      query: "普通查询",
      limit: 1,
      source: "manual",
    });

    // Results from vector should be returned (empty by default in harness)
    assert.equal(results.length, 0);
    // BM25 was attempted (even though it failed)
    assert.equal(bm25Queries.length, 1);

    // Overall retrieval did not fail (graceful degradation)
    assert.equal(
      retriever.getLastDiagnostics()?.failureStage,
      undefined,
    );
    // Vector result count should be 0 (empty by default in harness)
    assert.equal(
      retriever.getLastDiagnostics()?.vectorResultCount,
      0,
    );
    // BM25 result count should be 0 (failed)
    assert.equal(
      retriever.getLastDiagnostics()?.bm25ResultCount,
      0,
    );
  });
});

describe("cli search source tagging", () => {
  it("marks search requests as cli so query expansion stays scoped to interactive CLI recall", async () => {
    const searchCalls = [];
    const logs = [];

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {
        async list() {
          return [];
        },
        async stats() {
          return {
            totalCount: 0,
            scopeCounts: {},
            categoryCounts: {},
          };
        },
      },
      retriever: {
        async retrieve(params) {
          searchCalls.push(params);
          return [
            {
              ...buildResult("memory-cli", "CLI search hit"),
              sources: {
                vector: { score: 0.9, rank: 1 },
              },
            },
          ];
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        getLastDiagnostics() {
          return {
            source: "cli",
            mode: "hybrid",
            originalQuery: "服务挂了",
            bm25Query: "服务挂了 崩溃 crash error 报错 宕机",
            queryExpanded: true,
            limit: 10,
            scopeFilter: undefined,
            category: undefined,
            vectorResultCount: 0,
            bm25ResultCount: 3,
            fusedResultCount: 3,
            finalResultCount: 1,
            stageCounts: {
              afterMinScore: 3,
              rerankInput: 3,
              afterRerank: 3,
              afterRecency: 3,
              afterImportance: 3,
              afterLengthNorm: 3,
              afterTimeDecay: 3,
              afterHardMinScore: 3,
              afterNoiseFilter: 3,
              afterDiversity: 3,
            },
            dropSummary: [
              {
                stage: "limit",
                before: 3,
                after: 1,
                dropped: 2,
              },
            ],
          };
        },
      },
      scopeManager: {
        getStats() {
          return { totalScopes: 1 };
        },
      },
      migrator: {},
    })({ program });

    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "search",
        "服务挂了",
        "--debug",
      ]);
    } finally {
      console.log = origLog;
    }

    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].source, "cli");
    assert.match(logs.join("\n"), /Retrieval diagnostics:/);
    assert.match(logs.join("\n"), /Original query: 服务挂了/);
    assert.match(logs.join("\n"), /BM25 query: 服务挂了 崩溃 crash error 报错 宕机/);
    assert.match(logs.join("\n"), /Stages: min=3, rerankIn=3, rerank=3, hard=3, noise=3, diversity=3/);
    assert.match(logs.join("\n"), /Drops: limit -2 \(3->1\)/);
    assert.match(logs.join("\n"), /CLI search hit/);
  });

  it("prints failure diagnostics on debug search errors", async () => {
    const logs = [];
    const errors = [];
    const exitCalls = [];

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {
        async list() {
          return [];
        },
        async stats() {
          return {
            totalCount: 0,
            scopeCounts: {},
            categoryCounts: {},
          };
        },
      },
      retriever: {
        async retrieve() {
          throw new Error("simulated search failure");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        getLastDiagnostics() {
          return {
            source: "cli",
            mode: "hybrid",
            originalQuery: "服务挂了",
            bm25Query: "服务挂了 崩溃 crash error 报错 宕机",
            queryExpanded: true,
            limit: 10,
            scopeFilter: undefined,
            category: undefined,
            vectorResultCount: 0,
            bm25ResultCount: 0,
            fusedResultCount: 0,
            finalResultCount: 0,
            stageCounts: {
              afterMinScore: 0,
              rerankInput: 0,
              afterRerank: 0,
              afterRecency: 0,
              afterImportance: 0,
              afterLengthNorm: 0,
              afterTimeDecay: 0,
              afterHardMinScore: 0,
              afterNoiseFilter: 0,
              afterDiversity: 0,
            },
            dropSummary: [],
            failureStage: "hybrid.embedQuery",
            errorMessage: "simulated search failure",
          };
        },
      },
      scopeManager: {
        getStats() {
          return { totalScopes: 1 };
        },
      },
      migrator: {},
    })({ program });

    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    process.exit = ((code = 0) => {
      exitCalls.push(Number(code));
      throw new Error(`__TEST_EXIT__${code}`);
    });
    try {
      await assert.rejects(
        program.parseAsync([
          "node",
          "openclaw",
          "memory-pro",
          "search",
          "服务挂了",
          "--debug",
        ]),
        /__TEST_EXIT__1/,
      );
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    assert.deepEqual(logs, []);
    assert.deepEqual(exitCalls, [1]);
    assert.match(errors.join("\n"), /Retrieval diagnostics:/);
    assert.match(errors.join("\n"), /Failure stage: hybrid\.embedQuery/);
    assert.match(errors.join("\n"), /Error: simulated search failure/);
    assert.match(errors.join("\n"), /Search failed:/);
  });

  it("returns structured JSON failure output for --json --debug search errors", async () => {
    const logs = [];
    const errors = [];
    const exitCalls = [];

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {
        async list() {
          return [];
        },
        async stats() {
          return {
            totalCount: 0,
            scopeCounts: {},
            categoryCounts: {},
          };
        },
      },
      retriever: {
        async retrieve() {
          throw new Error("simulated json search failure");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        getLastDiagnostics() {
          return {
            source: "cli",
            mode: "hybrid",
            originalQuery: "服务挂了",
            bm25Query: "服务挂了 崩溃 crash error 报错 宕机",
            queryExpanded: true,
            limit: 10,
            scopeFilter: undefined,
            category: undefined,
            vectorResultCount: 0,
            bm25ResultCount: 0,
            fusedResultCount: 0,
            finalResultCount: 0,
            stageCounts: {
              afterMinScore: 0,
              rerankInput: 0,
              afterRerank: 0,
              afterRecency: 0,
              afterImportance: 0,
              afterLengthNorm: 0,
              afterTimeDecay: 0,
              afterHardMinScore: 0,
              afterNoiseFilter: 0,
              afterDiversity: 0,
            },
            dropSummary: [],
            failureStage: "hybrid.embedQuery",
            errorMessage: "simulated json search failure",
          };
        },
      },
      scopeManager: {
        getStats() {
          return { totalScopes: 1 };
        },
      },
      migrator: {},
    })({ program });

    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    process.exit = ((code = 0) => {
      exitCalls.push(Number(code));
      throw new Error(`__TEST_EXIT__${code}`);
    });
    try {
      await assert.rejects(
        program.parseAsync([
          "node",
          "openclaw",
          "memory-pro",
          "search",
          "服务挂了",
          "--json",
          "--debug",
        ]),
        /__TEST_EXIT__1/,
      );
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    assert.deepEqual(exitCalls, [1]);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0]);
    assert.deepEqual(payload, {
      error: {
        code: "search_failed",
        message: "simulated json search failure",
      },
      diagnostics: {
        source: "cli",
        mode: "hybrid",
        originalQuery: "服务挂了",
        bm25Query: "服务挂了 崩溃 crash error 报错 宕机",
        queryExpanded: true,
        limit: 10,
        vectorResultCount: 0,
        bm25ResultCount: 0,
        fusedResultCount: 0,
        finalResultCount: 0,
        stageCounts: {
          afterMinScore: 0,
          rerankInput: 0,
          afterRerank: 0,
          afterRecency: 0,
          afterImportance: 0,
          afterLengthNorm: 0,
          afterTimeDecay: 0,
          afterHardMinScore: 0,
          afterNoiseFilter: 0,
          afterDiversity: 0,
        },
        dropSummary: [],
        failureStage: "hybrid.embedQuery",
        errorMessage: "simulated json search failure",
      },
    });
  });

  it("uses diagnostics from the ephemeral search retriever on --json --debug failures", async () => {
    const logs = [];
    const errors = [];
    const exitCalls = [];

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {
        hasFtsSupport: true,
        async vectorSearch() {
          throw new Error("vector search should not run after embed failure");
        },
        async bm25Search() {
          throw new Error("bm25 search should not run after embed failure");
        },
        async hasId() {
          return true;
        },
      },
      retriever: {
        async retrieve() {
          throw new Error("context retriever should not be used when embedder is present");
        },
        getConfig() {
          return {
            mode: "hybrid",
            rerank: "none",
            filterNoise: false,
            minScore: 0,
            hardMinScore: 0,
            candidatePoolSize: 5,
          };
        },
        getLastDiagnostics() {
          return null;
        },
      },
      embedder: {
        async embedQuery() {
          throw new Error("simulated embedded search failure");
        },
      },
      scopeManager: {
        getStats() {
          return { totalScopes: 1 };
        },
      },
      migrator: {},
    })({ program });

    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    process.exit = ((code = 0) => {
      exitCalls.push(Number(code));
      throw new Error(`__TEST_EXIT__${code}`);
    });
    try {
      await assert.rejects(
        program.parseAsync([
          "node",
          "openclaw",
          "memory-pro",
          "search",
          "服务挂了",
          "--json",
          "--debug",
        ]),
        /__TEST_EXIT__1/,
      );
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    assert.deepEqual(exitCalls, [1]);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0]);
    assert.deepEqual(payload, {
      error: {
        code: "search_failed",
        message: "simulated embedded search failure",
      },
      diagnostics: {
        source: "cli",
        mode: "hybrid",
        originalQuery: "服务挂了",
        bm25Query: "服务挂了",
        queryExpanded: false,
        limit: 10,
        vectorResultCount: 0,
        bm25ResultCount: 0,
        fusedResultCount: 0,
        finalResultCount: 0,
        stageCounts: {
          afterMinScore: 0,
          rerankInput: 0,
          afterRerank: 0,
          afterRecency: 0,
          afterImportance: 0,
          afterLengthNorm: 0,
          afterTimeDecay: 0,
          afterHardMinScore: 0,
          afterNoiseFilter: 0,
          afterDiversity: 0,
        },
        dropSummary: [],
        failureStage: "hybrid.embedQuery",
        errorMessage: "simulated embedded search failure",
      },
    });
  });
});
