import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  buildConsolidateCandidate,
  clusterConsolidateCandidates,
  chunkCluster,
  parseConsolidateVerdict,
  runConsolidate,
} = jiti(path.join(testDir, "..", "src", "consolidate.ts"));

const { buildConsolidatePrompt } = jiti(path.join(testDir, "..", "src", "extraction-prompts.ts"));

let nextId = 1;
function makeRow({
  scope = "global",
  category = "preference",
  memoryCategory = "preferences",
  abstract,
  overview = "",
  content,
  factKey,
  source = "manual",
  vector,
  timestamp = 1_700_000_000_000,
  invalidatedAt,
  supersededBy,
}) {
  const id = `row-${nextId++}`;
  const metadata = {
    l0_abstract: abstract,
    l1_overview: overview,
    l2_content: content || abstract,
    memory_category: memoryCategory,
    fact_key: factKey,
    source,
    valid_from: timestamp,
    ...(invalidatedAt ? { invalidated_at: invalidatedAt } : {}),
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  };
  return {
    id,
    text: abstract,
    vector,
    category,
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
    fetchRows: async (scopeFilter, maxTimestamp, limit) => {
      return rows
        .filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    update: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.vector !== undefined) row.vector = patch.vector;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      return { ...row };
    },
    delete: async (id) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
    embed: async (text) => [text.length, 0, 0],
  };
}

describe("memory consolidate: clustering", () => {
  it("clusters rows purely by cosine similarity when fact_key is absent", () => {
    const a = buildConsolidateCandidate(makeRow({ abstract: "Likes tea", vector: [1, 0, 0], factKey: undefined }));
    const b = buildConsolidateCandidate(makeRow({ abstract: "Likes tea a lot", vector: [1, 0, 0], factKey: undefined }));
    const c = buildConsolidateCandidate(makeRow({ abstract: "Unrelated fact", vector: [0, 1, 0], factKey: undefined }));

    const clusters = clusterConsolidateCandidates([a, b, c], 0.9);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].slice().sort(), [0, 1]);
  });

  it("clusters a low-cosine reversal row with its originals via a shared fact_key", () => {
    const fk = "preferences:evening drink preference";
    const dup1 = buildConsolidateCandidate(makeRow({ abstract: "Evening drink: likes chamomile tea", vector: [1, 0, 0], factKey: fk }));
    const dup2 = buildConsolidateCandidate(makeRow({ abstract: "Evening drink: likes chamomile tea", vector: [1, 0, 0], factKey: fk }));
    const reversal = buildConsolidateCandidate(makeRow({ abstract: "Evening drink: quit chamomile tea", vector: [0, 0, 1], factKey: fk }));
    const control = buildConsolidateCandidate(makeRow({ abstract: "Unrelated: prefers dark mode", vector: [0, 1, 0], factKey: "preferences:unrelated" }));

    const clusters = clusterConsolidateCandidates([dup1, dup2, reversal, control], 0.9);
    assert.equal(clusters.length, 1, "exactly one cluster should form");
    assert.deepEqual(clusters[0].slice().sort(), [0, 1, 2], "the reversal row must join its originals despite low cosine similarity");
  });

  it("never clusters a single unrelated row", () => {
    const a = buildConsolidateCandidate(makeRow({ abstract: "Solo fact", vector: [1, 0, 0], factKey: "preferences:solo" }));
    const clusters = clusterConsolidateCandidates([a], 0.9);
    assert.equal(clusters.length, 0);
  });
});

describe("memory consolidate: cluster chunking", () => {
  it("chunks a cluster into groups no larger than the cap", () => {
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkCluster(indices, 8);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 8);
    assert.equal(chunks[1].length, 2);
  });
});

describe("memory consolidate: verdict parsing", () => {
  it("accepts a well-formed skip verdict", () => {
    const verdict = parseConsolidateVerdict({ verdict: "skip", reason: "distinct facts" }, 3);
    assert.deepEqual(verdict, { verdict: "skip", reason: "distinct facts" });
  });

  it("accepts a well-formed merge verdict with survivor and absorbed indices", () => {
    const verdict = parseConsolidateVerdict(
      { verdict: "merge", survivor_index: 1, absorbed_indices: [2, 3], reason: "duplicates" },
      3
    );
    assert.deepEqual(verdict, { verdict: "merge", survivorIndex: 1, absorbedIndices: [2, 3], reason: "duplicates" });
  });

  it("rejects an unknown verdict string", () => {
    assert.equal(parseConsolidateVerdict({ verdict: "delete_everything" }, 3), null);
  });

  it("rejects merge missing absorbed_indices", () => {
    assert.equal(parseConsolidateVerdict({ verdict: "merge", survivor_index: 1 }, 3), null);
  });

  it("rejects an out-of-range survivor_index", () => {
    assert.equal(parseConsolidateVerdict({ verdict: "merge", survivor_index: 9, absorbed_indices: [1] }, 3), null);
  });

  it("rejects non-object input", () => {
    assert.equal(parseConsolidateVerdict(null, 3), null);
    assert.equal(parseConsolidateVerdict("skip", 3), null);
  });
});

describe("memory consolidate: prompt shape", () => {
  it("returns a {system, user} split prompt naming the four verdicts", () => {
    const prompt = buildConsolidatePrompt([
      { index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" },
      { index: 2, category: "preferences", abstract: "b", overview: "", content: "b", source: "reflection" },
    ]);
    assert.equal(typeof prompt.system, "string");
    assert.equal(typeof prompt.user, "string");
    assert.match(prompt.system, /you are a memory consolidation decider/i);
    for (const verb of ["skip", "merge", "supersede", "contradict"]) {
      assert.match(prompt.system, new RegExp(verb, "i"));
    }
    assert.match(prompt.user, /1\./);
    assert.match(prompt.user, /2\./);
  });
});

describe("memory consolidate: orchestration", () => {
  function buildFixtureRows() {
    const fk = "preferences:evening drink preference";
    const ts = 1_700_000_000_000;
    return [
      makeRow({ abstract: "Evening drink preference: likes chamomile tea", content: "User mentioned liking chamomile tea in the evening.", factKey: fk, source: "manual", vector: [1, 0, 0, 0], timestamp: ts }),
      makeRow({ abstract: "Evening drink preference: likes chamomile tea", content: "Reflection noted the user's chamomile tea habit.", factKey: fk, source: "reflection", vector: [1, 0, 0, 0], timestamp: ts + 1000 }),
      makeRow({ abstract: "Evening drink preference: likes chamomile tea", content: "Extracted from conversation about evening routines.", factKey: fk, source: "auto-capture", vector: [1, 0, 0, 0], timestamp: ts + 2000 }),
      makeRow({ abstract: "Evening drink preference: quit chamomile tea", content: "User decided to stop drinking chamomile tea.", factKey: fk, source: "manual", vector: [0, 0, 0, 1], timestamp: ts + 3000 }),
      makeRow({ abstract: "Editor theme preference: prefers dark mode", content: "User prefers a dark editor theme.", factKey: "preferences:editor theme preference", source: "manual", vector: [0, 1, 0, 0], timestamp: ts + 4000 }),
    ];
  }

  it("dry-run clusters the four related rows and reports a supersede verdict, leaving the control row untouched", async () => {
    const store = makeFakeStore(buildFixtureRows());
    const completeJson = async () => ({
      verdict: "supersede",
      survivor_index: 4,
      absorbed_indices: [1, 2, 3],
      reason: "the reversal row supersedes the three duplicate rows",
    });

    const result = await runConsolidate(
      { ...store, completeJson },
      { scope: "global", apply: false, now: 1_700_100_000_000 }
    );

    assert.equal(result.apply, false);
    assert.equal(result.scanned, 5);
    assert.equal(result.eligible, 5);
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].memberIds.length, 4);
    assert.equal(result.clusters[0].verdict.verdict, "supersede");
    assert.equal(result.applied.length, 0, "dry-run must not apply anything");
    assert.equal(store.rows.length, 5, "dry-run must not delete or mutate any row");
  });

  it("apply mode executes the supersede verdict, invalidates the duplicates, and leaves the control row byte-identical", async () => {
    const fixture = buildFixtureRows();
    const controlBefore = fixture.find((r) => r.text.includes("dark mode"));
    const store = makeFakeStore(fixture);
    const audits = [];
    const completeJson = async () => ({
      verdict: "supersede",
      survivor_index: 4,
      absorbed_indices: [1, 2, 3],
      reason: "the reversal row supersedes the three duplicate rows",
    });

    const result = await runConsolidate(
      { ...store, completeJson, onAudit: (a) => audits.push(a) },
      { scope: "global", apply: true, now: 1_700_100_000_000 }
    );

    assert.equal(result.applied.length, 1);
    assert.equal(audits.length, 1);

    const survivorRow = store.rows.find((r) => r.text.includes("quit chamomile tea"));
    assert.ok(survivorRow, "the reversal row must remain");
    const survivorMeta = JSON.parse(survivorRow.metadata);
    assert.ok(survivorMeta.consolidation_audit, "survivor gets an audit trail");

    const absorbedRows = store.rows.filter((r) => r.text.includes("likes chamomile tea"));
    assert.equal(absorbedRows.length, 3, "absorbed rows are not deleted, only invalidated");
    for (const row of absorbedRows) {
      const meta = JSON.parse(row.metadata);
      assert.ok(meta.invalidated_at, "each absorbed row must be marked invalidated");
      assert.equal(meta.superseded_by, survivorRow.id);
    }

    const controlAfter = store.rows.find((r) => r.text.includes("dark mode"));
    assert.deepEqual(controlAfter, { ...controlBefore }, "control row must be byte-identical after apply");
  });

  it("is idempotent: a second apply run over the same store makes zero further changes", async () => {
    const store = makeFakeStore(buildFixtureRows());
    const completeJson = async () => ({
      verdict: "supersede",
      survivor_index: 4,
      absorbed_indices: [1, 2, 3],
      reason: "reversal supersedes duplicates",
    });

    await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: 1_700_100_000_000 });
    const secondResult = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: 1_700_200_000_000 });

    assert.equal(secondResult.applied.length, 0, "no cluster should reform once duplicates are invalidated");
  });

  it("executes a pure merge verdict by combining two duplicate rows into one via the merge-writer prompt", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Coffee order: oat milk latte", content: "User orders an oat milk latte.", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "User specified extra hot as well.", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return { verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same fact, second row adds detail" };
      }
      return { abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "User orders an oat milk latte, extra hot." };
    };

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 100_000 });

    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].survivorId, rows[0].id);
    assert.deepEqual(result.applied[0].absorbedIds, [rows[1].id]);
    assert.equal(store.rows.length, 1, "the absorbed row is removed on merge");
    assert.equal(store.rows[0].text, "Coffee order: oat milk latte, extra hot");
  });

  it("skips a cluster with a warning when the LLM response is malformed, without failing the run", async () => {
    const store = makeFakeStore(buildFixtureRows());
    const logs = [];
    const completeJson = async () => ({ nonsense: true });

    const result = await runConsolidate(
      { ...store, completeJson, log: (msg) => logs.push(msg) },
      { scope: "global", apply: true, now: 1_700_100_000_000 }
    );

    assert.equal(result.skippedMalformed, 1);
    assert.equal(result.applied.length, 0);
    assert.equal(store.rows.length, 5, "no rows touched when the verdict is malformed");
    assert.ok(logs.some((l) => /malformed|missing/i.test(l)));
  });

  it("excludes reflection-category rows by default and includes them with the opt-in flag", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ category: "reflection", memoryCategory: "patterns", abstract: "Reflection slice: always verify output", factKey: undefined, vector: [1, 0], timestamp: ts }),
      makeRow({ category: "reflection", memoryCategory: "patterns", abstract: "Reflection slice: always verify output twice", factKey: undefined, vector: [1, 0], timestamp: ts + 1 }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async () => ({ verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" });

    const excluded = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: false, now: ts + 100 });
    assert.equal(excluded.eligible, 0, "reflection rows excluded by default");

    const included = await runConsolidate(
      { ...store, completeJson },
      { scope: "global", apply: false, now: ts + 100, includeReflectionSlices: true }
    );
    assert.equal(included.eligible, 2, "reflection rows included with the opt-in flag");
  });

  it("refuses to merge or supersede append-only categories even if the LLM says to", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ category: "decision", memoryCategory: "events", abstract: "Deploy event: shipped v1", factKey: "events:deploy", vector: [1, 0], timestamp: ts }),
      makeRow({ category: "decision", memoryCategory: "events", abstract: "Deploy event: shipped v1 again", factKey: "events:deploy", vector: [1, 0], timestamp: ts + 1 }),
    ];
    const store = makeFakeStore(rows);
    const logs = [];
    const completeJson = async () => ({
      verdict: "merge",
      survivor_index: 1,
      absorbed_indices: [2],
      reason: "an unsafe LLM verdict that must be rejected",
    });

    const result = await runConsolidate(
      { ...store, completeJson, log: (msg) => logs.push(msg) },
      { scope: "global", apply: true, now: ts + 100 }
    );

    assert.equal(result.applied.length, 0, "append-only categories must never merge/supersede, even on LLM instruction");
    assert.equal(store.rows.length, 2, "both events rows must remain untouched");
    assert.ok(logs.some((l) => /append-only/i.test(l)));
  });

  it("never touches rows outside the requested scope", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ scope: "global", abstract: "Scoped fact one", factKey: "preferences:x", vector: [1, 0], timestamp: ts }),
      makeRow({ scope: "other-scope", abstract: "Different scope fact", factKey: "preferences:x", vector: [1, 0], timestamp: ts }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async () => ({ verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" });

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: false, now: ts + 100 });
    assert.equal(result.scanned, 1, "fetchRows must only see the requested scope");
  });
});
