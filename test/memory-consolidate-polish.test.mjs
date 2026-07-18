import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { runConsolidate, computeClusterFingerprint, formatConsolidatePlanForDisplay } = jiti(
  path.join(testDir, "..", "src", "consolidate.ts"),
);

let nextId = 1;
function makeRow({
  scope = "global",
  abstract,
  content,
  factKey,
  vector,
  category = "preferences",
  timestamp = 1_700_000_000_000,
}) {
  const id = `row-${String(nextId++).padStart(6, "0")}`;
  const metadata = {
    l0_abstract: abstract,
    l1_overview: "",
    l2_content: content || abstract,
    memory_category: category,
    fact_key: factKey,
    source: "manual",
    valid_from: timestamp,
  };
  return {
    id,
    text: abstract,
    vector,
    category: "preference",
    scope,
    importance: 0.7,
    timestamp,
    metadata: JSON.stringify(metadata),
  };
}

function makeFakeStore(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  return {
    rows,
    fetchRows: async (scopeFilter, maxTimestamp, limit) =>
      rows
        .filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp)
        .slice(0, limit)
        .map((r) => ({ ...r })),
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

function skipPairRows() {
  const ts = 1_700_000_000_000;
  return [
    makeRow({ abstract: "Tea order: green tea", content: "a", factKey: "preferences:tea order", vector: [1, 0], timestamp: ts }),
    makeRow({ abstract: "Tea order: green tea please", content: "b", factKey: "preferences:tea order", vector: [1, 0], timestamp: ts + 1000 }),
  ];
}

describe("consolidate polish: cluster fingerprints", () => {
  it("is stable across member order and changes when any member's metadata changes", () => {
    const a = { id: "row-1", metadata: "meta-a" };
    const b = { id: "row-2", metadata: "meta-b" };
    const fp1 = computeClusterFingerprint([a, b]);
    const fp2 = computeClusterFingerprint([b, a]);
    assert.equal(fp1, fp2, "member order must not affect the fingerprint");
    const fp3 = computeClusterFingerprint([a, { id: "row-2", metadata: "meta-b-changed" }]);
    assert.notEqual(fp1, fp3, "a metadata change must change the fingerprint");
    const fp4 = computeClusterFingerprint([a]);
    assert.notEqual(fp1, fp4, "a different member set must change the fingerprint");
  });
});

describe("consolidate polish: convergence to zero via settled fingerprints", () => {
  it("reports skip verdicts as newly settled, and a rerun with those fingerprints spends zero LLM calls and reports zero clusters", async () => {
    const rows = skipPairRows();
    let llmCalls = 0;
    const llm = async (_prompt, label) => {
      llmCalls += 1;
      if (label === "consolidate-decide") {
        return { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "both rows already agree" }] };
      }
      return { results: [] };
    };

    const run1 = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );
    assert.equal(run1.clusters.length, 1);
    assert.equal(run1.newlySettled.length, 1, "a decided skip cluster must be reported as newly settled");
    assert.ok(llmCalls > 0);

    const callsAfterRun1 = llmCalls;
    const run2 = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm },
      {
        scope: "global",
        apply: false,
        autoConfirm: true,
        now: 1_700_100_000_000,
        settledFingerprints: new Set(run1.newlySettled),
      },
    );
    assert.equal(llmCalls, callsAfterRun1, "settled clusters must not spend any LLM call");
    assert.equal(run2.clusters.length, 0, "settled clusters must not reappear as candidates");
    assert.equal(run2.settledSkipped, 1, "the settled cluster must be counted");
    assert.equal(run2.newlySettled.length, 0);
  });

  it("re-opens a settled cluster when a member row's metadata changes", async () => {
    const rows = skipPairRows();
    const llm = async (_prompt, label) =>
      label === "consolidate-decide"
        ? { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "agree" }] }
        : { results: [] };

    const run1 = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    const mutated = rows.map((r, i) =>
      i === 0 ? { ...r, metadata: r.metadata.replace("green tea", "black tea") } : r,
    );
    const run2 = await runConsolidate(
      { ...makeFakeStore(mutated), completeJson: llm },
      {
        scope: "global",
        apply: false,
        autoConfirm: true,
        now: 1_700_100_000_000,
        settledFingerprints: new Set(run1.newlySettled),
      },
    );
    assert.equal(run2.settledSkipped, 0, "a changed member must re-open the cluster");
    assert.equal(run2.clusters.length, 1);
  });
});

describe("consolidate polish: append-only shield visibility", () => {
  it("marks a shield-blocked verdict as blocked in the plan report and reports it as settled", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Deploy failed with ENOENT", content: "a", factKey: "cases:deploy failure", category: "cases", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "User prefers quick deploys", content: "b", factKey: "preferences:deploys", category: "preferences", vector: [1, 0], timestamp: ts + 1000 }),
    ];
    const llm = async (_prompt, label) =>
      label === "consolidate-decide"
        ? { verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same topic" }] }
        : { results: [] };

    const result = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.clusters.length, 1);
    const cluster = result.clusters[0];
    assert.equal(cluster.action, null);
    assert.equal(cluster.blocked, "append-only-shield", "shield-blocked verdicts must be marked, not silently actionless");
    assert.equal(result.newlySettled.length, 1, "a shield-blocked cluster is settled: rerunning cannot change the outcome");
  });
});

describe("consolidate polish: honest failure classing", () => {
  it("classes a null decide response as call-failed with one aggregate log line, not per-cluster malformed spam", async () => {
    const rows = skipPairRows();
    const logs = [];
    const llm = async (_prompt, label) => (label === "consolidate-decide" ? null : { results: [] });

    const result = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm, log: (m) => logs.push(m) },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].failure, "call-failed");
    assert.equal(result.undecidedCallFailed, 1);
    assert.equal(result.skippedMalformed, 0, "a failed call is not a malformed verdict");
    assert.equal(result.newlySettled.length, 0, "an undecided cluster must not settle");
    const callFailedLines = logs.filter((l) => l.includes("no response"));
    assert.equal(callFailedLines.length, 1, "exactly one aggregate line for the failed call");
    assert.equal(
      logs.filter((l) => l.includes("missing or malformed")).length,
      0,
      "no per-cluster malformed spam when the whole call failed",
    );
  });

  it("still classes a genuinely missing verdict as malformed when the call itself succeeded", async () => {
    const rows = skipPairRows();
    const logs = [];
    const llm = async (_prompt, label) =>
      label === "consolidate-decide" ? { verdicts: [] } : { results: [] };

    const result = await runConsolidate(
      { ...makeFakeStore(rows), completeJson: llm, log: (m) => logs.push(m) },
      { scope: "global", apply: false, autoConfirm: true, now: 1_700_100_000_000 },
    );

    assert.equal(result.clusters[0].failure, "malformed-verdict");
    assert.equal(result.skippedMalformed, 1);
    assert.equal(result.undecidedCallFailed, 0);
    assert.equal(result.newlySettled.length, 0, "a malformed cluster must not settle");
    assert.ok(logs.some((l) => l.includes("missing or malformed")));
  });
});

describe("consolidate polish: plan display shows every verdict class", () => {
  const clusters = [
    {
      clusterIndex: 1,
      action: "merge",
      memberIds: ["id-a", "id-b"],
      memberTexts: ["Coffee: oat milk", "Coffee: oat milk latte"],
      survivorId: "id-a",
      absorbedIds: ["id-b"],
      verdict: { verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same coffee fact" },
      mergedContent: { abstract: "Coffee: oat milk latte", overview: "o", content: "c" },
    },
    {
      clusterIndex: 2,
      blocked: "append-only-shield",
      memberIds: ["id-c", "id-d"],
      memberTexts: ["event one", "event two"],
      verdict: { verdict: "supersede", survivor_index: 1, absorbed_indices: [2], reason: "newer event wins" },
    },
    {
      clusterIndex: 3,
      memberIds: ["id-e", "id-f"],
      memberTexts: ["tea: green", "tea: green with honey"],
      verdict: { verdict: "skip", reason: "distinct preparations" },
    },
  ];

  it("headlines all three counts and lists skip verdicts with reason and member texts", () => {
    const text = formatConsolidatePlanForDisplay(clusters);
    assert.match(text, /Plan: 1 actionable cluster, 1 blocked, 1 skip\b/);
    assert.match(text, /\[skip\] cluster 3 — distinct preparations/);
    assert.match(text, /"tea: green with honey"/);
    assert.match(text, /BLOCKED by append-only shield/);
    assert.match(text, /"event two"/);
  });

  it("keeps the no-plan message when nothing was decided at all", () => {
    assert.equal(formatConsolidatePlanForDisplay([]), "No actionable clusters in this plan.");
  });
});
