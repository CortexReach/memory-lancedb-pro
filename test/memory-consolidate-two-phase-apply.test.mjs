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
    return { abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "merged content" };
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

    assert.ok(llm.calls.includes("consolidate-merge"), "merge content must be generated at plan-build time, even in dry-run");
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
      makeRow({ abstract: "Desk setup: standing desk", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "Desk setup: standing desk, oak top", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 3 }),
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
      return { abstract: "merged", overview: "", content: "merged" };
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
