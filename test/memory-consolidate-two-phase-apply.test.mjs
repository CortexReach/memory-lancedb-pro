import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { runConsolidate } = jiti(path.join(testDir, "..", "src", "consolidate.ts"));

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

function twoMemberMergeRows() {
  const ts = 1_700_000_000_000;
  return [
    makeRow({ abstract: "Coffee order: oat milk latte", content: "a", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
    makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "b", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
  ];
}

function mergeDeciderLlm() {
  let completeJsonCalls = 0;
  const calls = [];
  const completeJson = async (_prompt, label) => {
    completeJsonCalls += 1;
    calls.push(label);
    if (label === "consolidate-decide") {
      return { verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same fact, second row adds detail" }] };
    }
    return {
      results: [
        { index: 1, abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "merged content" },
      ],
    };
  };
  return { completeJson, calls, callCount: () => completeJsonCalls };
}

describe("memory consolidate: item 8 plan building (merge content precomputed at plan time)", () => {
  it("dry-run (apply:false) generates merge content during plan build, not just verdicts", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();

    const result = await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.ok(llm.calls.includes("consolidate-merge-batch"), "merge content must be generated at plan-build time, even in dry-run");
    assert.equal(result.clusters[0].mergedContent?.abstract, "Coffee order: oat milk latte, extra hot");
    assert.equal(result.clusters[0].action, "merge");
  });
});

describe("memory consolidate: item 8 two-phase apply (dry-run -> present -> confirm -> execute)", () => {
  it("declining the apply prompt (anything other than true) makes zero store writes", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();
    let confirmApplyCalledWith = null;

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        confirmApply: async (message, clusters) => {
          confirmApplyCalledWith = { message, clusters };
          return false;
        },
      },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.ok(confirmApplyCalledWith, "confirmApply must be called with the full plan");
    assert.equal(confirmApplyCalledWith.clusters.length, 1);
    assert.equal(confirmApplyCalledWith.clusters[0].action, "merge");
    assert.equal(confirmApplyCalledWith.clusters[0].survivorId, store.rows[0].id);
    assert.deepEqual(confirmApplyCalledWith.clusters[0].absorbedIds, [store.rows[1].id]);
    assert.equal(confirmApplyCalledWith.clusters[0].mergedContent.content, "merged content");

    assert.equal(result.executed, false);
    assert.equal(result.applied.length, 0);
    assert.equal(store.rows[1].text, "Coffee order: oat milk latte, extra hot", "unmutated original text, not the merged text");
    assert.equal(JSON.parse(store.rows[1].metadata).invalidated_at, undefined, "no row may be invalidated when the user declines");
  });

  it("confirming YES executes the plan as pure store operations, with the LLM dep provably not called again during execution", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        confirmApply: async () => true,
      },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    const callsAfterBuild = llm.callCount();
    assert.equal(callsAfterBuild, 2, "exactly one decide call + one merge-content call during plan build");

    assert.equal(result.executed, true);
    assert.equal(result.applied.length, 1);
    assert.equal(llm.callCount(), callsAfterBuild, "execution must call zero further LLM completions");

    const survivor = store.rows.find((r) => r.id === result.applied[0].survivorId);
    assert.equal(survivor.text, "Coffee order: oat milk latte, extra hot");
    const absorbed = store.rows.find((r) => r.id === result.applied[0].absorbedIds[0]);
    assert.ok(JSON.parse(absorbed.metadata).invalidated_at, "absorbed row must be invalidated by execution");
  });

  it("applies exactly the content that was presented, byte for byte", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();
    let presented = null;

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        confirmApply: async (_message, clusters) => {
          presented = clusters[0].mergedContent;
          return true;
        },
      },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.applied.length, 1);
    const survivor = store.rows.find((r) => r.id === result.applied[0].survivorId);
    assert.equal(survivor.text, presented.abstract, "the applied text must exactly match what was presented in the plan");
  });
});

describe("memory consolidate: item 8 staleness guard", () => {
  it("skips a cluster whose member row was mutated between plan build and execution, without partially applying it", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();
    const logs = [];

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        log: (msg) => logs.push(msg),
        confirmApply: async () => {
          // Simulate a concurrent writer mutating the second member's row
          // in the window between plan build and the user's confirmation.
          const row = store.rows.find((r) => r.id === store.rows[1].id);
          row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), l0_abstract: "mutated by someone else" });
          return true;
        },
      },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.applied.length, 0, "a stale cluster must never be partially or fully applied");
    assert.equal(result.staleSkipped.length, 1);
    assert.deepEqual(result.staleSkipped[0].memberIds.sort(), [store.rows[0].id, store.rows[1].id].sort());
    assert.ok(logs.some((l) => /stale/i.test(l)), "a per-cluster report line must explain the skip");

    const survivorRow = store.rows.find((r) => r.id === store.rows[0].id);
    assert.equal(survivorRow.text, "Coffee order: oat milk latte", "the untouched survivor candidate must not have been merged in");
  });

  it("a mutated row that disappears entirely (deleted/moved out of scope) is also treated as stale, not crashed on", async () => {
    const rows = twoMemberMergeRows();
    const store = makeFakeStore(rows);
    const llm = mergeDeciderLlm();
    const disappearedId = rows[1].id;

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        confirmApply: async () => {
          const idx = store.rows.findIndex((r) => r.id === disappearedId);
          store.rows.splice(idx, 1);
          return true;
        },
      },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.applied.length, 0);
    assert.equal(result.staleSkipped.length, 1);
  });

  it("only skips the stale cluster, still applies unrelated fresh clusters in the same run", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts + 1 }),
      makeRow({ abstract: "Desk setup: kneeling chair", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "Desk setup: kneeling chair, oak top", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 3 }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return {
          verdicts: [
            { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "coffee dup" },
            { cluster_index: 2, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "desk dup" },
          ],
        };
      }
      return {
        results: [
          { index: 1, abstract: "merged", overview: "", content: "merged" },
          { index: 2, abstract: "merged", overview: "", content: "merged" },
        ],
      };
    };

    const result = await runConsolidate(
      {
        ...store,
        completeJson,
        confirmApply: async () => {
          // Mutate only the coffee cluster's second row.
          const row = store.rows.find((r) => r.id === rows[1].id);
          row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), l0_abstract: "mutated" });
          return true;
        },
      },
      { scope: "global", apply: false, autoConfirm: true, now: ts + 100_000 },
    );

    assert.equal(result.staleSkipped.length, 1);
    assert.equal(result.applied.length, 1, "the desk cluster must still apply despite the coffee cluster going stale");
    assert.equal(result.applied[0].survivorId, rows[2].id);
  });
});

describe("memory consolidate: item 8 direct --apply path (unchanged semantics)", () => {
  it("gate -> build plan -> execute immediately, with no confirmApply call at all", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();
    let confirmApplyCalls = 0;

    const result = await runConsolidate(
      {
        ...store,
        completeJson: llm.completeJson,
        confirmApply: async () => {
          confirmApplyCalls += 1;
          return true;
        },
      },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(confirmApplyCalls, 0, "direct --apply must never call confirmApply");
    assert.equal(result.executed, true);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].survivorId, store.rows[0].id);
  });
});

// ---------------------------------------------------------------------------
// Batched merge writer: one consolidate-merge-batch call per plan build
// ---------------------------------------------------------------------------

/**
 * N same-fact pairs, each pair on its own one-hot vector axis AND with
 * fully pair-unique topic tokens (so neither cosine, fact_key, nor the
 * token-overlap fallbacks can chain different pairs), so clustering
 * yields exactly N units.
 */
function pairRows(pairCount) {
  const ts = 1_700_000_000_000;
  const rows = [];
  for (let p = 0; p < pairCount; p++) {
    const vector = Array.from({ length: pairCount }, (_, d) => (d === p ? 1 : 0));
    rows.push(
      makeRow({ abstract: `topic${p + 1}key: value${p + 1}base`, factKey: `preferences:topic${p + 1}key`, vector, timestamp: ts + p * 10 }),
      makeRow({ abstract: `topic${p + 1}key: value${p + 1}base extra${p + 1}note`, factKey: `preferences:topic${p + 1}key`, vector, timestamp: ts + p * 10 + 1 }),
    );
  }
  return rows;
}

function batchWriterLlm({ verdictCount, onMergeBatch }) {
  const mergeBatchCalls = [];
  const calls = [];
  const completeJson = async (prompt, label, system) => {
    calls.push(label);
    if (label === "consolidate-decide") {
      return {
        verdicts: Array.from({ length: verdictCount }, (_, i) => ({
          cluster_index: i + 1,
          verdict: "merge",
          survivor_index: 1,
          absorbed_indices: [2],
          reason: "duplicate pair",
        })),
      };
    }
    if (label === "consolidate-merge-batch") {
      mergeBatchCalls.push({ prompt, system });
      if (!onMergeBatch) throw new Error("unexpected consolidate-merge-batch call");
      return onMergeBatch(prompt, mergeBatchCalls.length);
    }
    throw new Error(`unexpected label: ${label}`);
  };
  return { completeJson, mergeBatchCalls, calls };
}

function mergedResults(count, tag = "") {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      abstract: `merged-${tag}${i + 1}`,
      overview: "o",
      content: "c",
    })),
  };
}

describe("memory consolidate: batched merge writer", () => {
  const NOW = 1_700_100_000_000;

  it("writes every merge verdict's plan content with exactly one LLM call", async () => {
    const store = makeFakeStore(pairRows(3));
    const llm = batchWriterLlm({ verdictCount: 3, onMergeBatch: () => mergedResults(3) });

    const result = await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(llm.mergeBatchCalls.length, 1, "3 merge verdicts must share one batched merge-content call");
    assert.equal(llm.calls.filter((l) => l === "consolidate-merge").length, 0, "no per-verdict merge calls remain");
    const merged = result.clusters.filter((c) => c.action === "merge").map((c) => c.mergedContent?.abstract).sort();
    assert.deepEqual(merged, ["merged-1", "merged-2", "merged-3"]);
  });

  it("uses the batch shape even for a single merge verdict", async () => {
    const store = makeFakeStore(pairRows(1));
    const llm = batchWriterLlm({ verdictCount: 1, onMergeBatch: () => mergedResults(1) });

    await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(llm.mergeBatchCalls.length, 1);
    assert.match(llm.mergeBatchCalls[0].prompt, /(^|\n)1\. Category: preferences/);
  });

  it("makes zero merge-writer calls when no verdict is a merge", async () => {
    const store = makeFakeStore(pairRows(2));
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return {
          verdicts: [
            { cluster_index: 1, verdict: "skip", reason: "unrelated" },
            { cluster_index: 2, verdict: "skip", reason: "unrelated" },
          ],
        };
      }
      throw new Error(`unexpected label: ${label}`);
    };

    const result = await runConsolidate(
      { ...store, completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(result.clusters.filter((c) => c.action).length, 0);
  });

  it("degrades only the missing job to the survivor's own content, like a failed single-call fold", async () => {
    const store = makeFakeStore(pairRows(2));
    const llm = batchWriterLlm({
      verdictCount: 2,
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged-1", overview: "o", content: "c" }] }),
    });

    const result = await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(llm.mergeBatchCalls.length, 1, "a malformed row must not fan out into extra calls");
    const mergeClusters = result.clusters.filter((c) => c.action === "merge");
    assert.equal(mergeClusters.length, 2, "both verdicts stay actionable");
    const abstracts = mergeClusters.map((c) => c.mergedContent?.abstract).sort();
    assert.ok(abstracts.includes("merged-1"), "the parsed job keeps its generated content");
    assert.ok(
      abstracts.some((a) => /^topic\d+key: value\d+base$/.test(a)),
      "the missing job falls back to its survivor's own content",
    );
  });

  it("falls back to survivor content for every job when the whole response is unparseable", async () => {
    const store = makeFakeStore(pairRows(2));
    const llm = batchWriterLlm({ verdictCount: 2, onMergeBatch: () => null });

    const result = await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(llm.mergeBatchCalls.length, 1);
    const mergeClusters = result.clusters.filter((c) => c.action === "merge");
    assert.equal(mergeClusters.length, 2);
    for (const cluster of mergeClusters) {
      assert.match(cluster.mergedContent?.abstract, /^topic\d+key: value\d+base$/);
    }
  });

  it("chunks oversized merge batches and covers every job exactly once", async () => {
    const store = makeFakeStore(pairRows(12));
    const llm = batchWriterLlm({
      verdictCount: 12,
      onMergeBatch: (_prompt, call) => mergedResults(call === 1 ? 10 : 2, `c${call}-`),
    });

    const result = await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    assert.equal(llm.mergeBatchCalls.length, 2, "12 merge verdicts over a cap of 10 must split into 2 calls");
    const merged = result.clusters.filter((c) => c.action === "merge").map((c) => c.mergedContent?.abstract);
    assert.equal(merged.length, 12);
    assert.equal(merged.filter((a) => /^merged-c1-/.test(a)).length, 10);
    assert.equal(merged.filter((a) => /^merged-c2-/.test(a)).length, 2);
  });

  it("formats the batched merge prompt as numbered blocks without list markers", async () => {
    const store = makeFakeStore(pairRows(2));
    const llm = batchWriterLlm({ verdictCount: 2, onMergeBatch: () => mergedResults(2) });

    await runConsolidate(
      { ...store, completeJson: llm.completeJson, autoConfirm: true, confirmApply: async () => false },
      { scope: "global", apply: false, autoConfirm: true, now: NOW },
    );

    const { prompt } = llm.mergeBatchCalls[0];
    assert.match(prompt, /\n\n2\. Category: preferences/, "jobs are numbered inline and blank-line separated");
    assert.match(prompt, /^ {3}Existing memory:/m);
    assert.match(prompt, /^ {3}New information/m);
    assert.doesNotMatch(prompt, /^ *- (Abstract|Overview|Content)/m, "no leading list markers");
  });
});

// ---------------------------------------------------------------------------
// Round-1 review regressions: fault injection at every write position,
// text-aware staleness/fingerprints, decide chunking, scan bound, and the
// crash/concurrency-safe settled ledger.
// ---------------------------------------------------------------------------

const consolidateModule = jiti(path.join(testDir, "..", "src", "consolidate.ts"));
const {
  computeClusterFingerprint,
  clusterConsolidateCandidates,
  buildConsolidateCandidate,
  loadConsolidateSettledLedger,
  saveConsolidateSettledLedger,
  CONSOLIDATE_DECIDE_BATCH_MAX_SIZE,
  SETTLED_LEDGER_MAX_PER_SCOPE,
} = consolidateModule;
const runConsolidate2 = consolidateModule.runConsolidate;
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2, existsSync, readdirSync, writeFileSync, readFileSync as readFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";

function failingUpdateStore(initialRows, failOn) {
  const store = makeFakeStore(initialRows);
  const baseUpdate = store.update;
  const updateCalls = [];
  store.update = async (id, patch, scopeFilter) => {
    updateCalls.push(id);
    if (failOn(id, updateCalls.length)) {
      throw new Error(`injected write failure for ${id}`);
    }
    return baseUpdate(id, patch, scopeFilter);
  };
  store.updateCalls = updateCalls;
  return store;
}

function threeMemberMergeRows() {
  const ts = 1_700_000_000_000;
  return [
    makeRow({ abstract: "Coffee order: oat milk latte", content: "a", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
    makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "b", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
    makeRow({ abstract: "Coffee order: oat milk latte, always double shot", content: "c", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 2000 }),
  ];
}

function threeMemberMergeLlm() {
  return {
    completeJson: async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return { verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2, 3], reason: "same fact" }] };
      }
      return { results: [{ index: 1, abstract: "Coffee order: merged", overview: "", content: "merged content" }] };
    },
  };
}

function supersedeLlm() {
  return {
    completeJson: async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return { verdicts: [{ cluster_index: 1, verdict: "supersede", survivor_index: 3, absorbed_indices: [1, 2], reason: "newest wins" }] };
      }
      return { results: [] };
    },
  };
}

describe("fault injection: partial-apply safety at every write position", () => {
  it("merge: survivor write (first position) fails -> cluster reported failed, nothing applied, absorbed rows untouched", async () => {
    const rows = threeMemberMergeRows();
    const store = failingUpdateStore(rows, (id) => id === rows[0].id);
    const result = await runConsolidate2({ ...store, ...threeMemberMergeLlm() }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 0, "a failed survivor write applies nothing");
    assert.equal(result.applyFailed.length, 1);
    assert.equal(result.applyFailed[0].action, "merge");
    for (const absorbed of [rows[1], rows[2]]) {
      const row = store.rows.find((r) => r.id === absorbed.id);
      assert.ok(!JSON.parse(row.metadata).invalidated_at, "no absorbed row may be invalidated when the survivor write failed first");
    }
  });

  it("merge: one absorbed invalidation (middle position) fails -> applied with partialFailures, the other absorbed row still invalidated", async () => {
    const rows = threeMemberMergeRows();
    const store = failingUpdateStore(rows, (id) => id === rows[1].id);
    const result = await runConsolidate2({ ...store, ...threeMemberMergeLlm() }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 1);
    assert.equal(result.applyFailed.length, 0);
    const partial = result.applied[0].partialFailures;
    assert.ok(partial && partial.length === 1, "the failed absorbed write must be reported");
    assert.equal(partial[0].id, rows[1].id);
    assert.equal(partial[0].step, "invalidate-absorbed");
    const failedRow = store.rows.find((r) => r.id === rows[1].id);
    assert.ok(!JSON.parse(failedRow.metadata).invalidated_at, "the failed row stays ACTIVE (pre-consolidate status quo)");
    const okRow = store.rows.find((r) => r.id === rows[2].id);
    assert.ok(JSON.parse(okRow.metadata).invalidated_at, "one absorbed failure must not abandon the remaining invalidations");
  });

  it("supersede: one absorbed invalidation fails -> applied with partialFailures, remaining writes proceed", async () => {
    const rows = threeMemberMergeRows();
    const store = failingUpdateStore(rows, (id) => id === rows[0].id);
    const result = await runConsolidate2({ ...store, ...supersedeLlm() }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 1);
    const partial = result.applied[0].partialFailures;
    assert.ok(partial && partial.some((f) => f.id === rows[0].id && f.step === "invalidate-absorbed"));
    const okRow = store.rows.find((r) => r.id === rows[1].id);
    assert.ok(JSON.parse(okRow.metadata).invalidated_at);
  });

  it("supersede: EVERY absorbed invalidation fails -> cluster reported failed, nothing applied", async () => {
    const rows = threeMemberMergeRows();
    const store = failingUpdateStore(rows, (id) => id === rows[0].id || id === rows[1].id);
    const result = await runConsolidate2({ ...store, ...supersedeLlm() }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 0);
    assert.equal(result.applyFailed.length, 1);
    assert.equal(result.applyFailed[0].action, "supersede");
  });

  it("supersede: survivor annotation (last position) fails -> applied with an annotate-survivor partial, invalidations preserved", async () => {
    const rows = threeMemberMergeRows();
    const store = failingUpdateStore(rows, (id) => id === rows[2].id);
    const result = await runConsolidate2({ ...store, ...supersedeLlm() }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 1);
    const partial = result.applied[0].partialFailures;
    assert.ok(partial && partial.some((f) => f.id === rows[2].id && f.step === "annotate-survivor"));
    for (const absorbed of [rows[0], rows[1]]) {
      const row = store.rows.find((r) => r.id === absorbed.id);
      assert.ok(JSON.parse(row.metadata).invalidated_at, "a cosmetic survivor-annotation failure must never unwind applied invalidations");
    }
  });
});

describe("text-aware staleness and settled fingerprints", () => {
  it("a concurrent text-only change makes the cluster stale at execution time", async () => {
    const rows = twoMemberMergeRows();
    const store = makeFakeStore(rows);
    const llm = mergeDeciderLlm();
    const baseGetById = store.getById;
    store.getById = async (id) => {
      const row = await baseGetById(id);
      if (row && row.id === rows[1].id) {
        return { ...row, text: "Coffee order: switched to black americano" };
      }
      return row;
    };
    const result = await runConsolidate2({ ...store, completeJson: llm.completeJson }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.applied.length, 0, "a text-only concurrent change must not be overwritten by a stale plan");
    assert.equal(result.staleSkipped.length, 1);
  });

  it("a text-only change re-opens a previously settled cluster (fingerprint covers the text)", () => {
    const membersBefore = [
      { id: "row-a", text: "favorite drink: cola", metadata: "{}" },
      { id: "row-b", text: "favorite drink: cola zero", metadata: "{}" },
    ];
    const before = computeClusterFingerprint(membersBefore);
    const after = computeClusterFingerprint([
      membersBefore[0],
      { ...membersBefore[1], text: "favorite drink: switched to water" },
    ]);
    assert.notEqual(before, after, "same ids + same metadata with different text must produce a different fingerprint");
  });
});

describe("decide-call chunking and failure isolation", () => {
  // One unique topic word per pair (and no shared content words across
  // pairs), so the near-duplicate topic-overlap fallback cannot bridge
  // unrelated pairs into one mega-cluster: each pair clusters via its own
  // factKey and yields exactly one decision unit.
  const PAIR_TOPIC_WORDS = [
    "amber", "basalt", "cobalt", "damson", "fennel", "garnet", "hazel",
    "jade", "kelp", "lilac", "maple", "nectar", "onyx", "quartz", "rowan",
    "sage", "tulip", "umber", "violet", "wren", "yarrow", "zinnia",
  ];

  function manyPairRows(pairCount) {
    const ts = 1_700_000_000_000;
    const rows = [];
    for (let i = 0; i < pairCount; i++) {
      const word = PAIR_TOPIC_WORDS[i % PAIR_TOPIC_WORDS.length];
      const key = `preferences:${word}`;
      rows.push(makeRow({ abstract: `${word} v1`, content: "a", factKey: key, vector: [], timestamp: ts + i }));
      rows.push(makeRow({ abstract: `${word} v2`, content: "b", factKey: key, vector: [], timestamp: ts + i + 500 }));
    }
    return rows;
  }

  it("chunks the decide prompt and a thrown chunk strands only its own clusters", async () => {
    const pairCount = CONSOLIDATE_DECIDE_BATCH_MAX_SIZE + 3;
    const store = makeFakeStore(manyPairRows(pairCount));
    let decideCalls = 0;
    const completeJson = async (_prompt, label) => {
      if (label !== "consolidate-decide") return { results: [] };
      decideCalls += 1;
      if (decideCalls === 1) throw new Error("injected provider rejection");
      return { verdicts: [] };
    };
    const logs = [];
    const result = await runConsolidate2(
      { ...store, completeJson, log: (m) => logs.push(m) },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 },
    );
    assert.equal(decideCalls, 2, "clusters beyond the batch size must go to a second decide call");
    assert.equal(result.undecidedCallFailed, CONSOLIDATE_DECIDE_BATCH_MAX_SIZE, "only the thrown chunk's clusters are call-failed");
    assert.equal(result.skippedMalformed, 3, "the surviving chunk's clusters get normal (here: missing-verdict) handling");
    assert.ok(logs.some((l) => l.includes("consolidate-decide call threw")));
  });
});

describe("scan bound", () => {
  it("truncates the scan at scanLimit and reports it", async () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push(makeRow({ abstract: `Unrelated synthetic fact number ${i}`, content: "x", factKey: `preferences:distinct ${i}`, vector: [], timestamp: 1_700_000_000_000 + i }));
    }
    const store = makeFakeStore(rows);
    const logs = [];
    const result = await runConsolidate2(
      { ...store, completeJson: async () => ({ verdicts: [] }), log: (m) => logs.push(m) },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000, scanLimit: 10 },
    );
    assert.equal(result.scanTruncated, true);
    assert.equal(result.scanned, 10);
    assert.ok(logs.some((l) => l.includes("scan truncated at 10 rows")));
  });

  it("clusters a realistically large scope quickly (memoized tokens + unit-vector dot products)", () => {
    const candidates = [];
    for (let i = 0; i < 1200; i++) {
      const angle = (i / 1200) * Math.PI;
      candidates.push(
        buildConsolidateCandidate({
          id: `bulk-${i}`,
          text: `Synthetic bulk fact ${i} about workshop shelf ${i % 40}`,
          vector: [Math.cos(angle), Math.sin(angle)],
          category: "preference",
          scope: "global",
          importance: 0.5,
          timestamp: 1_700_000_000_000 + i,
          metadata: JSON.stringify({ memory_category: "preferences", l0_abstract: `Synthetic bulk fact ${i} about workshop shelf ${i % 40}` }),
        }),
      );
    }
    const startedAt = process.hrtime.bigint();
    clusterConsolidateCandidates(candidates, 0.9999);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < 10_000, `1200-candidate clustering should stay in interactive time (took ${Math.round(elapsedMs)}ms)`);
  });
});

describe("settled ledger persistence (crash- and concurrency-safe)", () => {
  let dir;
  it("setup", () => {
    dir = mkdtempSync2(path.join(tmpdir2(), "consolidate-ledger-"));
  });

  it("merges with the CURRENT on-disk ledger instead of overwriting concurrent writers", async () => {
    const ledgerPath = path.join(dir, "consolidate-settled.json");
    await saveConsolidateSettledLedger(ledgerPath, "agent:one", ["fp-one"]);
    await saveConsolidateSettledLedger(ledgerPath, "agent:two", ["fp-two"]);
    const loaded = await loadConsolidateSettledLedger(ledgerPath);
    assert.ok(loaded["agent:one"]?.some((e) => e.fp === "fp-one"), "an earlier writer's scope must survive a later writer's save");
    assert.ok(loaded["agent:two"]?.some((e) => e.fp === "fp-two"));
    assert.ok(!existsSync(`${ledgerPath}.lock`), "the lock must be released");
    assert.ok(readdirSync(dir).every((f) => !f.includes(".tmp-")), "the atomic temp file must not linger");
  });

  it("reports and sets aside a corrupt ledger instead of silently treating it as empty", async () => {
    const ledgerPath = path.join(dir, "corrupt-ledger.json");
    writeFileSync(ledgerPath, "{ this is not json", "utf-8");
    const loaded = await loadConsolidateSettledLedger(ledgerPath);
    assert.deepEqual(loaded, {});
    assert.ok(!existsSync(ledgerPath), "the corrupt file must be moved aside, not left in place");
    assert.ok(readdirSync(dir).some((f) => f.startsWith("corrupt-ledger.json.corrupt-")), "the damaged file must survive for inspection");
  });

  it("normalizes the legacy bare-string format", async () => {
    const ledgerPath = path.join(dir, "legacy-ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ "agent:legacy": ["legacy-fp-1", "legacy-fp-2"] }), "utf-8");
    const loaded = await loadConsolidateSettledLedger(ledgerPath);
    assert.equal(loaded["agent:legacy"].length, 2);
    assert.ok(loaded["agent:legacy"].every((e) => typeof e.fp === "string" && typeof e.at === "number"));
  });

  it("prunes the ledger to the per-scope cap on save", async () => {
    const ledgerPath = path.join(dir, "prune-ledger.json");
    const bulk = Array.from({ length: SETTLED_LEDGER_MAX_PER_SCOPE + 50 }, (_, i) => `bulk-fp-${i}`);
    await saveConsolidateSettledLedger(ledgerPath, "agent:bulk", bulk);
    const loaded = await loadConsolidateSettledLedger(ledgerPath);
    assert.equal(loaded["agent:bulk"].length, SETTLED_LEDGER_MAX_PER_SCOPE);
  });

  it("teardown", () => {
    rmSync2(dir, { recursive: true, force: true });
  });
});

describe("round-2 regressions: topic-fallback false positives, audit-mirror isolation, malformed duplicates", () => {
  const { parseConsolidateVerdict } = consolidateModule;

  function candidateWithAbstract(abstract, id) {
    return buildConsolidateCandidate({
      id,
      text: abstract,
      vector: [],
      category: "preference",
      scope: "global",
      importance: 0.5,
      timestamp: 1_700_000_000_000,
      metadata: JSON.stringify({ memory_category: "preferences", l0_abstract: abstract }),
    });
  }

  it("boundary token semantics: port must not bridge support/report rows", () => {
    const a = candidateWithAbstract("harbor port schedule pinned", "fp-a");
    const b = candidateWithAbstract("weekly support rotation summary", "fp-b");
    const c = candidateWithAbstract("quarterly report cadence chosen", "fp-c");
    assert.deepEqual(clusterConsolidateCandidates([a, b], 0.9999), [], "port/support raw-substring bridging must be gone");
    assert.deepEqual(clusterConsolidateCandidates([a, c], 0.9999), [], "port/report raw-substring bridging must be gone");
  });

  it("compound-boundary containment still links abbreviated brand tokens", () => {
    const a = candidateWithAbstract("Favorite drink: cola", "brand-a");
    const b = candidateWithAbstract("coca-cola bottles restocked weekly", "brand-b");
    const clusters = clusterConsolidateCandidates([a, b], 0.9999);
    assert.equal(clusters.length, 1, "cola must still match the coca-cola compound part");
  });

  it("two-sided overlap: one shared token cannot bridge multi-token rows", () => {
    const a = candidateWithAbstract("cobalt shelf paint order", "ms-a");
    const b = candidateWithAbstract("cobalt earring gift wrapped yesterday evening", "ms-b");
    assert.deepEqual(
      clusterConsolidateCandidates([a, b], 0.9999),
      [],
      "sharing only 'cobalt' between two multi-token rows must not make them the same fact",
    );
  });

  it("the motivating single-token cross-lane case still clusters", () => {
    const a = candidateWithAbstract("Favorite drink: cola", "mv-a");
    const b = candidateWithAbstract("Cola is what gets ordered most evenings", "mv-b");
    const clusters = clusterConsolidateCandidates([a, b], 0.9999);
    assert.equal(clusters.length, 1, "the PR's motivating paraphrase pair must keep clustering");
  });

  it("a rejecting audit mirror never re-classifies an applied cluster as failed", async () => {
    const store = makeFakeStore(twoMemberMergeRows());
    const llm = mergeDeciderLlm();
    const logs = [];
    const result = await runConsolidate2(
      {
        ...store,
        completeJson: llm.completeJson,
        log: (m) => logs.push(m),
        onAudit: async () => {
          throw new Error("injected mirror failure");
        },
      },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 },
    );
    assert.equal(result.applied.length, 1, "the store writes applied; the mirror is not part of that classification");
    assert.equal(result.applyFailed.length, 0, "a mirror failure must not appear as an apply failure");
    assert.ok(logs.some((l) => l.includes("audit mirror failed")), "the mirror failure must still be reported");
  });

  it("a verdict with duplicate absorbed indices is malformed", () => {
    assert.equal(
      parseConsolidateVerdict(
        { verdict: "merge", reason: "dup", survivor_index: 1, absorbed_indices: [2, 2] },
        3,
      ),
      null,
    );
  });

  it("a contradiction is never persisted as settled", async () => {
    const rows = twoMemberMergeRows();
    const store = makeFakeStore(rows);
    const completeJson = async (_prompt, label) =>
      label === "consolidate-decide"
        ? { verdicts: [{ cluster_index: 1, verdict: "contradict", reason: "live conflict" }] }
        : { results: [] };
    const result = await runConsolidate2({ ...store, completeJson }, { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000 });
    assert.equal(result.newlySettled.length, 0, "a contradiction is unresolved work; settling it would hide it for the ledger's retention");
    const again = await runConsolidate2(
      { ...store, completeJson },
      { scope: "global", apply: true, autoConfirm: true, now: 1_700_100_000_000, settledFingerprints: new Set(result.newlySettled) },
    );
    assert.equal(again.settledSkipped, 0, "the contradiction must re-surface on the next run");
    assert.equal(again.clusters.length, 1);
  });

  it("clusters production-dimension vectors in interactive time", () => {
    const DIMS = 2560;
    const candidates = [];
    for (let i = 0; i < 600; i++) {
      const vector = new Array(DIMS).fill(0);
      vector[i % DIMS] = 1;
      candidates.push(
        buildConsolidateCandidate({
          id: `dim-${i}`,
          text: `distinct highdim fixture row ${i}`,
          vector,
          category: "preference",
          scope: "global",
          importance: 0.5,
          timestamp: 1_700_000_000_000 + i,
          metadata: JSON.stringify({ memory_category: "preferences", l0_abstract: `distinct highdim fixture row ${i}` }),
        }),
      );
    }
    const startedAt = process.hrtime.bigint();
    clusterConsolidateCandidates(candidates, 0.86);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < 15_000, `600 production-dimension candidates should cluster in interactive time (took ${Math.round(elapsedMs)}ms)`);
  });
});
