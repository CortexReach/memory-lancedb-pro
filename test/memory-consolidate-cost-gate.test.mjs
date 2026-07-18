import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { EventEmitter } from "node:events";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  runConsolidate,
  computeConsolidateCostPreview,
  formatConsolidateCostPreview,
} = jiti(path.join(testDir, "..", "src", "consolidate.ts"));

const { createConsolidateConfirm } = jiti(path.join(testDir, "..", "cli.ts"));

let nextId = 1;
function makeRow({ scope = "global", abstract, content, factKey, vector, timestamp = 1_700_000_000_000 }) {
  const id = `row-${String(nextId++).padStart(6, "0")}`;
  const metadata = {
    l0_abstract: abstract,
    l1_overview: "",
    l2_content: content || abstract,
    memory_category: "preferences",
    fact_key: factKey,
    source: "manual",
    valid_from: timestamp,
  };
  return { id, text: abstract, vector, category: "preference", scope, importance: 0.7, timestamp, metadata: JSON.stringify(metadata) };
}

function makeFakeStore(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  return {
    rows,
    fetchRows: async (scopeFilter, maxTimestamp, limit) =>
      rows.filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp).slice(0, limit).map((r) => ({ ...r })),
    update: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.vector !== undefined) row.vector = patch.vector;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      return { ...row };
    },
    getById: async (id) => {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    embed: async (text) => [text.length, 0, 0],
  };
}

function buildMergeableRows() {
  const ts = 1_700_000_000_000;
  return [
    makeRow({ abstract: "Coffee order: oat milk latte", content: "a", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
    makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "b", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
  ];
}

describe("memory consolidate: cost preview (pure)", () => {
  it("reports N clusters -> 1 batched decider call plus the chunk-capped batched merge-writer call count", () => {
    // 3 units, each at most one merge job -> 3 jobs -> ceil(3/10) = 1 batched call
    const units = [
      { members: [{}, {}] },
      { members: [{}, {}, {}] },
      { members: [{}, {}, {}, {}] },
    ];
    const preview = computeConsolidateCostPreview(units);
    assert.equal(preview.clusterCount, 3);
    assert.equal(preview.maxMergeJobs, 3);
    assert.equal(preview.maxMergeContentCalls, 1);
  });

  it("chunk math: more units than the batch cap means more than one batched call", () => {
    const units = Array.from({ length: 12 }, () => ({ members: [{}, {}] }));
    const preview = computeConsolidateCostPreview(units);
    assert.equal(preview.maxMergeJobs, 12);
    assert.equal(preview.maxMergeContentCalls, 2);
  });

  it("formats the preview as a single line with real plural counts and one worst-case qualifier", () => {
    const preview = { clusterCount: 4, maxMergeJobs: 4, maxMergeContentCalls: 1 };
    const text = formatConsolidateCostPreview(preview);
    assert.equal(
      text,
      "4 clusters -> 1 batched decider call + worst case 1 batched merge-content call covering 4 merge jobs",
    );
    assert.ok(!text.includes("\n"), "preview must be a single line");
    assert.doesNotMatch(text, /up to|\(s\)/);
  });

  it("uses singular nouns when every count is 1", () => {
    const preview = { clusterCount: 1, maxMergeJobs: 1, maxMergeContentCalls: 1 };
    const text = formatConsolidateCostPreview(preview);
    assert.equal(
      text,
      "1 cluster -> 1 batched decider call + worst case 1 batched merge-content call covering 1 merge job",
    );
  });

  it("omits the merge-writer line when no cluster could ever produce a merge", () => {
    const preview = { clusterCount: 2, maxMergeJobs: 0, maxMergeContentCalls: 0 };
    const text = formatConsolidateCostPreview(preview);
    assert.match(text, /2 cluster/);
    assert.doesNotMatch(text, /merge-content/);
  });
});

describe("memory consolidate: item 7 cost gate (runConsolidate)", () => {
  it("aborts before any LLM call when confirmCost declines, and never invokes completeJson", async () => {
    const store = makeFakeStore(buildMergeableRows());
    let completeJsonCalls = 0;
    const completeJson = async () => {
      completeJsonCalls += 1;
      return { verdicts: [] };
    };
    let confirmCostCalledWith = null;

    const result = await runConsolidate(
      {
        ...store,
        completeJson,
        confirmCost: async (message) => {
          confirmCostCalledWith = message;
          return false;
        },
      },
      { scope: "global", apply: true, now: 1_700_100_000_000 },
    );

    assert.equal(completeJsonCalls, 0, "no LLM call may fire when the cost gate is declined");
    assert.equal(result.status, "aborted", "the result must clearly signal the run never proceeded");
    assert.ok(confirmCostCalledWith, "confirmCost must have been called with a preview message");
    assert.match(confirmCostCalledWith, /1 cluster/);
    assert.equal(store.rows.length, 2, "declining the gate must not touch the store");
  });

  it("gate also covers dry-runs: apply:false still aborts on decline with zero LLM calls", async () => {
    const store = makeFakeStore(buildMergeableRows());
    let completeJsonCalls = 0;
    const completeJson = async () => {
      completeJsonCalls += 1;
      return { verdicts: [] };
    };

    const result = await runConsolidate(
      { ...store, completeJson, confirmCost: async () => false },
      { scope: "global", apply: false, now: 1_700_100_000_000 },
    );

    assert.equal(completeJsonCalls, 0);
    assert.equal(result.status, "aborted");
  });

  it("--yes (autoConfirm) bypasses the gate entirely and never calls confirmCost", async () => {
    const store = makeFakeStore(buildMergeableRows());
    let confirmCostCalls = 0;
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "not a dup after all" }] };
      }
      return null;
    };

    const result = await runConsolidate(
      {
        ...store,
        completeJson,
        confirmCost: async () => {
          confirmCostCalls += 1;
          return true;
        },
      },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(confirmCostCalls, 0, "--yes must skip calling confirmCost at all");
    assert.equal(result.status, "completed");
  });

  it("proceeds normally when confirmCost affirms", async () => {
    const store = makeFakeStore(buildMergeableRows());
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "fine as-is" }] };
      }
      return null;
    };

    const result = await runConsolidate(
      { ...store, completeJson, confirmCost: async () => true },
      { scope: "global", apply: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.clusters.length, 1);
  });

  it("skips the gate entirely (no confirmCost call, no abort) when there are zero clusters to act on", async () => {
    const store = makeFakeStore([makeRow({ abstract: "Solo fact", vector: [9, 9], timestamp: 1_700_000_000_000 })]);
    let confirmCostCalls = 0;
    const result = await runConsolidate(
      { ...store, completeJson: async () => { throw new Error("must not be called"); }, confirmCost: async () => { confirmCostCalls += 1; return true; } },
      { scope: "global", apply: true, now: 1_700_100_000_000 },
    );
    assert.equal(confirmCostCalls, 0, "nothing to confirm when there are no clusters");
    assert.equal(result.status, "completed");
    assert.equal(result.clusters.length, 0);
  });

  it("treats a missing confirmCost dep as a safe decline (fail-safe default), not a crash", async () => {
    const store = makeFakeStore(buildMergeableRows());
    let completeJsonCalls = 0;
    const result = await runConsolidate(
      { ...store, completeJson: async () => { completeJsonCalls += 1; return { verdicts: [] }; } },
      { scope: "global", apply: true, now: 1_700_100_000_000 },
    );
    assert.equal(completeJsonCalls, 0);
    assert.equal(result.status, "aborted");
  });
});

describe("memory consolidate: item 7 CLI default confirm (TTY detection)", () => {
  function makeStream({ isTTY }) {
    const stream = new EventEmitter();
    stream.isTTY = isTTY;
    stream.write = () => true;
    return stream;
  }

  it("resolves false without reading anything when stdin is not a TTY", async () => {
    const stdin = makeStream({ isTTY: false });
    const stdout = makeStream({ isTTY: true });
    const confirm = createConsolidateConfirm({ stdin, stdout });

    const result = await confirm("Proceed?");
    assert.equal(result, false);
  });

  it("resolves false without reading anything when stdout is not a TTY", async () => {
    const stdin = makeStream({ isTTY: true });
    const stdout = makeStream({ isTTY: false });
    const confirm = createConsolidateConfirm({ stdin, stdout });

    const result = await confirm("Proceed?");
    assert.equal(result, false);
  });
});
