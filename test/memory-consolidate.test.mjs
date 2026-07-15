import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  buildConsolidateCandidate,
  clusterConsolidateCandidates,
  chunkCluster,
  parseConsolidateVerdict,
  parseConsolidateBatchVerdicts,
  runConsolidate,
} = jiti(path.join(testDir, "..", "src", "consolidate.ts"));

const { buildConsolidatePrompt, buildConsolidateBatchPrompt } = jiti(path.join(testDir, "..", "src", "extraction-prompts.ts"));

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
  // Zero-padded so lexicographic (string) sort matches insertion order --
  // item 3 sorts consolidate candidates by row id for determinism, and this
  // keeps every existing fixture's insertion-order-based index assumptions
  // (e.g. "row 4 is the reversal") valid under that sort.
  const id = `row-${String(nextId++).padStart(6, "0")}`;
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

  it("links a naturally-phrased reversal to a free-text reflection-mapped duplicate, even with a mismatched derived fact_key and low cosine", () => {
    // Realistic cross-lane wording: smart-extraction follows the strict
    // "[Merge key]: Description" abstract convention and gets a clean derived
    // fact_key. Reflection writer-1 mapped rows carry NO stored fact_key and
    // are free-text LLM summaries with no colon convention at all, so their
    // DERIVED fact_key is the whole normalized sentence -- it will never match
    // the smart-extraction row's key. A naturally-phrased reversal is in the
    // same boat (confirmed against the real deriveFactKey, not a hypothetical).
    const original = buildConsolidateCandidate(
      makeRow({
        abstract: "Favorite soda: Coca-Cola",
        vector: [1, 0, 0, 0],
        factKey: "preferences:favorite soda",
        source: "auto-capture",
      })
    );
    const mappedDuplicate = buildConsolidateCandidate(
      makeRow({
        abstract: "User prefers Coca-Cola as their favorite soft drink",
        vector: [1, 0, 0, 0],
        factKey: undefined,
        source: "reflection",
      })
    );
    const reversal = buildConsolidateCandidate(
      makeRow({
        // Deliberately low cosine (orthogonal vector) to simulate an embedder
        // that separates the reversal from its originals, and a free-text
        // wording whose derived fact_key ("preferences:user has stopped
        // drinking coca-cola") does not match "preferences:favorite soda".
        abstract: "User has stopped drinking Coca-Cola",
        vector: [0, 0, 0, 1],
        factKey: undefined,
        source: "manual",
      })
    );
    const control = buildConsolidateCandidate(
      makeRow({
        abstract: "User no longer works at Acme Corp",
        vector: [0, 1, 0, 0],
        factKey: undefined,
        source: "manual",
      })
    );

    const clusters = clusterConsolidateCandidates([original, mappedDuplicate, reversal, control], 0.86);
    assert.equal(clusters.length, 1, "exactly one cluster should form");
    assert.deepEqual(
      clusters[0].slice().sort(),
      [0, 1, 2],
      "the reversal must join the cluster despite a mismatched derived fact_key and low cosine; the unrelated reversal-shaped control row must stay out"
    );
  });

  it("does not transitively chain two unrelated near-duplicate pairs together through a moderately-similar bridge pair", () => {
    // Live dry-run found 8-row grab-bag clusters mixing weekly planning,
    // standing desks, and roleplay notes -- none of these rows are
    // reversal-shaped, so this is pure cosine transitivity chaining:
    // A1~A2 direct link, A2~B1 direct link (the "bridge"), B1~B2 direct link,
    // so union-find would glue all four into one cluster even though A1/A2
    // are never directly similar enough to B1/B2. Cosine values here are
    // computed exactly (15/25/40/45-degree unit vectors), not guessed:
    // A1-A2=0.966, A2-B1=0.906 (the bridge, well above 0.86), B1-B2=0.996,
    // A1-B1=0.766, A1-B2=0.707 (both well below 0.86).
    const A1 = buildConsolidateCandidate(makeRow({ abstract: "Prefers Sunday evening weekly planning.", vector: [1, 0], factKey: undefined }));
    const A2 = buildConsolidateCandidate(makeRow({ abstract: "User now does weekly planning on Sunday evenings.", vector: [0.9659258262890683, 0.25881904510252074], factKey: undefined }));
    const B1 = buildConsolidateCandidate(makeRow({ abstract: "Experimenting this month with a standing desk for back comfort.", vector: [0.766044443118978, 0.6427876096865393], factKey: undefined }));
    const B2 = buildConsolidateCandidate(makeRow({ abstract: "Testing a standing desk setup this month to help with back pain.", vector: [0.7071067811865476, 0.7071067811865475], factKey: undefined }));

    const clusters = clusterConsolidateCandidates([A1, A2, B1, B2], 0.86);
    assert.equal(clusters.length, 2, "the weekly-planning pair and the standing-desk pair must stay as two separate clusters");
    const sorted = clusters.map((c) => c.slice().sort()).sort((x, y) => x[0] - y[0]);
    assert.deepEqual(sorted, [[0, 1], [2, 3]]);
  });

  it("does not let a long multi-topic reversal narrative bridge a tight cola cluster to unrelated desk rows (paraphrased live shape)", () => {
    // Paraphrased from the live cluster-4 grab bag: a tight favorite-drink +
    // reversal pair should stay together, but a long narrative row that also
    // happens to mention "quit" (reversal-shaped) and touches several other
    // topics at once must not bridge in the unrelated desk-move rows via
    // incidental keyword overlap.
    const favorite = buildConsolidateCandidate(
      makeRow({ abstract: "User's favorite drink is Coca-Cola.", vector: [1, 0, 0], factKey: "preferences:favorite drink" })
    );
    const reversalShort = buildConsolidateCandidate(
      makeRow({ abstract: "User will no longer drink cola", vector: [0, 0, 1], factKey: undefined })
    );
    const longNarrative = buildConsolidateCandidate(
      makeRow({
        abstract:
          "User quit drinking Coca-Cola after the fridge explosion incident. Decided to redesign their room and moved their desk from a dark corner to next to the window for natural light and better productivity.",
        vector: [0, 1, 0],
        factKey: undefined,
      })
    );
    const deskMove = buildConsolidateCandidate(
      makeRow({ abstract: "User will move their desk to sit directly next to the window for natural light.", vector: [0, 1, 0], factKey: undefined })
    );

    const clusters = clusterConsolidateCandidates([favorite, reversalShort, longNarrative, deskMove], 0.86);

    const colaCluster = clusters.find((c) => c.includes(0));
    assert.ok(colaCluster, "the favorite-drink row must be in some cluster");
    assert.ok(colaCluster.includes(1), "the short reversal must join the favorite-drink row");
    assert.ok(
      !colaCluster.includes(3),
      "the unrelated desk-move row must not be glued into the cola cluster through the long narrative row"
    );
  });

  it("clusters 3 plain near-duplicate rows from different write lanes with their contradiction, even though none of the duplicates is reversal-shaped (item 4 motivating fixture)", () => {
    // Synthetic, cross-lane favorite-drink family: three PLAIN statements of
    // the same fact, phrased the way three different write lanes would
    // phrase it (strict colon convention, free-text reflection-mapped
    // prose, and a casual auto-capture paraphrase) -- none contains reversal
    // wording, so the pre-item-4 reversal-gated topic-overlap fallback never
    // links them to EACH OTHER (only ever to the reversal row, and only for
    // whichever one becomes reachable first via seed order). Deliberately
    // orthogonal vectors and mismatched fact_keys simulate real cross-lane
    // embedding/tokenization drift, so cosine and fact_key both miss too.
    const strictConvention = buildConsolidateCandidate(
      makeRow({ abstract: "Favorite drink: cola", vector: [1, 0, 0, 0], factKey: "preferences:favorite drink", source: "manual" })
    );
    const freeTextMapped = buildConsolidateCandidate(
      makeRow({ abstract: "The user really likes cola as their favorite drink", vector: [0, 1, 0, 0], factKey: undefined, source: "reflection" })
    );
    const casualParaphrase = buildConsolidateCandidate(
      makeRow({ abstract: "Cola is what gets ordered most evenings", vector: [0, 0, 1, 0], factKey: undefined, source: "auto-capture" })
    );
    const contradiction = buildConsolidateCandidate(
      makeRow({ abstract: "No longer drinks cola", vector: [0, 0, 0, 1], factKey: undefined, source: "manual" })
    );
    const unrelated = buildConsolidateCandidate(
      makeRow({ abstract: "Prefers a standing desk for back comfort", vector: [1, 1, 0, 0], factKey: "preferences:desk setup", source: "manual" })
    );

    const clusters = clusterConsolidateCandidates(
      [strictConvention, freeTextMapped, casualParaphrase, contradiction, unrelated],
      0.86
    );

    assert.equal(clusters.length, 1, "exactly one cluster should form for the favorite-drink family");
    assert.deepEqual(
      clusters[0].slice().sort(),
      [0, 1, 2, 3],
      "all 3 cross-lane duplicates and the contradiction must land in the SAME cluster; the unrelated desk row must stay out"
    );
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

  it("tells the decider that supersede is non-destructive soft-invalidation, not deletion", () => {
    const prompt = buildConsolidatePrompt([
      { index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" },
    ]);
    // Defect 1: the live decider reasoned "kept as historical rather than
    // REQUIRING DELETION" as a reason to skip a clear reversal, because the
    // prompt never said supersede preserves history. Mirror buildDedupPrompt's
    // own SUPERSEDE language ("kept as historical but no longer current").
    assert.match(prompt.system, /not.{0,60}destructive/i);
    assert.match(prompt.system, /never (be )?delet/i);
    assert.match(prompt.system, /historical/i);
  });

  it("tells the decider it may act on a subset of the cluster, leaving append-only rows untouched", () => {
    const prompt = buildConsolidatePrompt([
      { index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" },
    ]);
    // Defect 2: the live decider skipped whole 3-8 row clusters just because
    // ONE member was an append-only events/cases row, even when the rest were
    // exact duplicates. survivor_index/absorbed_indices already support acting
    // on a subset (unlisted rows are simply left untouched) -- the prompt must
    // say so explicitly instead of implying every row must be covered.
    assert.match(prompt.system, /not.{0,40}(need|have) to (act on|cover) every row|leave.{0,40}(out|untouched)/i);
    assert.match(prompt.system, /append-only/i);
  });

  it("adds a one-line source legend to the decider system prompt so provenance informs survivor choice", () => {
    const prompt = buildConsolidatePrompt([
      { index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" },
    ]);
    assert.match(prompt.system, /legacy\s*=\s*pre-smart-format rows/i);
    assert.match(prompt.system, /manual\s*=\s*operator memory_store saves/i);
    assert.match(prompt.system, /auto-capture\s*=\s*extraction lane/i);
    assert.match(prompt.system, /reflection\*\s*=\s*mirror lanes/i);
    assert.match(prompt.system, /manual rows are operator-authored and strong survivor candidates/i);
  });

  it("includes each member's timestamp, and valid_from only when it differs, so supersede recency is explicit rather than inferred from text", () => {
    const ts1 = 1_700_000_000_000;
    const ts2 = 1_700_100_000_000;
    const vf2 = 1_699_000_000_000;
    const prompt = buildConsolidatePrompt([
      { index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual", timestamp: ts1, validFrom: ts1 },
      { index: 2, category: "preferences", abstract: "b", overview: "", content: "b", source: "auto-capture", timestamp: ts2, validFrom: vf2 },
    ]);
    assert.ok(
      prompt.user.includes(`timestamp: ${new Date(ts1).toISOString()}`),
      "member 1's timestamp must appear in the listing"
    );
    assert.ok(
      prompt.user.includes(`timestamp: ${new Date(ts2).toISOString()}`),
      "member 2's timestamp must appear in the listing"
    );
    assert.ok(
      prompt.user.includes(`valid_from: ${new Date(vf2).toISOString()}`),
      "member 2's valid_from differs from its timestamp and must be shown explicitly"
    );
    assert.ok(
      !prompt.user.includes(`valid_from: ${new Date(ts1).toISOString()}`),
      "member 1's valid_from equals its timestamp and must not be printed redundantly"
    );
  });

  it("renders identical L0/L1/L2 tiers once per member instead of repeating the same raw fallback text three times", () => {
    // mapped/manual/legacy rows without real overview/content commonly fall
    // back to the raw abstract text in all three tiers (see
    // src/smart-metadata.ts's parseSmartMetadata: l2_content falls back to
    // raw text, l1_overview falls back to `- ${abstract}`) -- printing that
    // fact three times per member wastes cluster-listing space for no signal.
    const thin = {
      index: 1,
      category: "preferences",
      abstract: "Likes tea",
      overview: "- Likes tea",
      content: "Likes tea",
      source: "legacy",
    };
    const rich = {
      index: 2,
      category: "preferences",
      abstract: "Coffee order: oat milk latte",
      overview: "## Preference\n- oat milk latte",
      content: "User always orders an oat milk latte with extra foam.",
      source: "manual",
    };
    const prompt = buildConsolidatePrompt([thin, rich]);

    assert.ok(prompt.user.includes("Fact: Likes tea"), "thin member collapses to a single Fact: line");
    assert.ok(!/Abstract: Likes tea/.test(prompt.user), "thin member must not repeat the abstract label");
    assert.ok(!/Overview: - Likes tea/.test(prompt.user), "thin member must not repeat the overview label");

    assert.ok(
      prompt.user.includes("Abstract: Coffee order: oat milk latte"),
      "rich member with genuinely distinct tiers keeps the full Abstract/Overview/Content rendering"
    );
    assert.ok(prompt.user.includes("User always orders an oat milk latte with extra foam."));
  });
});

describe("memory consolidate: batch prompt shape", () => {
  function member(index, abstract) {
    return { index, category: "preferences", abstract, overview: "", content: abstract, source: "manual" };
  }

  it("returns a {system, user} split prompt asking for a JSON array of verdicts tagged with cluster_index", () => {
    const prompt = buildConsolidateBatchPrompt([
      { clusterIndex: 1, members: [member(1, "a"), member(2, "b")] },
      { clusterIndex: 2, members: [member(1, "c"), member(2, "d")] },
    ]);
    assert.equal(typeof prompt.system, "string");
    assert.equal(typeof prompt.user, "string");
    assert.match(prompt.system, /you are a memory consolidation decider/i);
    assert.match(prompt.system, /verdicts/i);
    assert.match(prompt.system, /cluster_index/i);
    for (const verb of ["skip", "merge", "supersede", "contradict"]) {
      assert.match(prompt.system, new RegExp(verb, "i"));
    }
  });

  it("lists every cluster in the user prompt, each with its own 1-based member numbering", () => {
    const prompt = buildConsolidateBatchPrompt([
      { clusterIndex: 1, members: [member(1, "first cluster row one"), member(2, "first cluster row two")] },
      { clusterIndex: 2, members: [member(1, "second cluster row one")] },
    ]);
    assert.match(prompt.user, /cluster 1/i);
    assert.match(prompt.user, /cluster 2/i);
    assert.ok(prompt.user.includes("first cluster row one"));
    assert.ok(prompt.user.includes("first cluster row two"));
    assert.ok(prompt.user.includes("second cluster row one"));
  });

  it("still tells the decider that supersede is non-destructive and clusters may be decided as a subset", () => {
    const prompt = buildConsolidateBatchPrompt([{ clusterIndex: 1, members: [member(1, "a")] }]);
    assert.match(prompt.system, /not.{0,60}destructive/i);
    assert.match(prompt.system, /never (be )?delet/i);
    assert.match(prompt.system, /historical/i);
    assert.match(prompt.system, /append-only/i);
  });

  it("still includes the source legend and per-member timestamps", () => {
    const ts = 1_700_000_000_000;
    const prompt = buildConsolidateBatchPrompt([
      { clusterIndex: 1, members: [{ ...member(1, "a"), timestamp: ts }] },
    ]);
    assert.match(prompt.system, /legacy\s*=\s*pre-smart-format rows/i);
    assert.ok(prompt.user.includes(`timestamp: ${new Date(ts).toISOString()}`));
  });
});

describe("memory consolidate: batch verdict parsing", () => {
  it("parses multiple well-formed verdicts keyed by cluster_index", () => {
    const raw = {
      verdicts: [
        { cluster_index: 1, verdict: "skip", reason: "distinct" },
        { cluster_index: 2, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" },
      ],
    };
    const units = [
      { clusterIndex: 1, memberCount: 2 },
      { clusterIndex: 2, memberCount: 2 },
    ];
    const map = parseConsolidateBatchVerdicts(raw, units);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get(1), { verdict: "skip", reason: "distinct" });
    assert.deepEqual(map.get(2), { verdict: "merge", survivorIndex: 1, absorbedIndices: [2], reason: "dup" });
  });

  it("fails closed per-cluster: a malformed entry for one cluster does not affect other clusters' valid verdicts", () => {
    const raw = {
      verdicts: [
        { cluster_index: 1, verdict: "bogus_verdict" },
        { cluster_index: 2, verdict: "skip", reason: "fine" },
      ],
    };
    const units = [
      { clusterIndex: 1, memberCount: 2 },
      { clusterIndex: 2, memberCount: 2 },
    ];
    const map = parseConsolidateBatchVerdicts(raw, units);
    assert.equal(map.has(1), false, "malformed entry must not produce a verdict for cluster 1");
    assert.equal(map.has(2), true, "cluster 2's valid verdict must still parse");
    assert.equal(map.get(2).verdict, "skip");
  });

  it("ignores an entry whose cluster_index does not match any known unit", () => {
    const raw = { verdicts: [{ cluster_index: 99, verdict: "skip", reason: "orphan" }] };
    const units = [{ clusterIndex: 1, memberCount: 2 }];
    const map = parseConsolidateBatchVerdicts(raw, units);
    assert.equal(map.size, 0);
  });

  it("keeps the first entry and ignores later duplicates for the same cluster_index", () => {
    const raw = {
      verdicts: [
        { cluster_index: 1, verdict: "skip", reason: "first" },
        { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "second" },
      ],
    };
    const units = [{ clusterIndex: 1, memberCount: 2 }];
    const map = parseConsolidateBatchVerdicts(raw, units);
    assert.equal(map.size, 1);
    assert.equal(map.get(1).verdict, "skip");
    assert.equal(map.get(1).reason, "first");
  });

  it("returns an empty map when the whole response is not a {verdicts: [...]} shape", () => {
    const units = [{ clusterIndex: 1, memberCount: 2 }];
    assert.equal(parseConsolidateBatchVerdicts(null, units).size, 0);
    assert.equal(parseConsolidateBatchVerdicts({ nonsense: true }, units).size, 0);
    assert.equal(parseConsolidateBatchVerdicts({ verdicts: "not-an-array" }, units).size, 0);
  });
});

describe("memory consolidate: batch prompt rubric tightening", () => {
  it("states explicit decision criteria for each verdict, not just a one-line description", () => {
    const prompt = buildConsolidateBatchPrompt([
      { clusterIndex: 1, members: [{ index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" }] },
    ]);
    assert.match(prompt.system, /decision criteria/i);
  });

  it("tells the decider to prefer supersede over merge when the choice is ambiguous", () => {
    const prompt = buildConsolidateBatchPrompt([
      { clusterIndex: 1, members: [{ index: 1, category: "preferences", abstract: "a", overview: "", content: "a", source: "manual" }] },
    ]);
    assert.match(prompt.system, /ambiguous/i);
    assert.match(prompt.system, /prefer supersede/i);
  });
});

describe("memory consolidate: deterministic verdicts", () => {
  it("passes temperature 0 for the batched consolidate-decide call", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1 }),
    ];
    const store = makeFakeStore(rows);
    let capturedTemperature;
    const completeJson = async (_prompt, label, _system, temperature) => {
      if (label === "consolidate-decide") {
        capturedTemperature = temperature;
        return { verdicts: [{ cluster_index: 1, verdict: "skip", reason: "no action" }] };
      }
      return null;
    };

    await runConsolidate({ ...store, completeJson }, { scope: "global", apply: false, now: ts + 1000 });

    assert.equal(capturedTemperature, 0, "the consolidate-decide call must request temperature 0");
  });

  it("produces byte-identical prompt text for the same candidate set regardless of fetch order", async () => {
    const ts = 1_700_000_000_000;
    const rowsInOrder = [
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1 }),
      makeRow({ abstract: "Tea order: chamomile", factKey: "preferences:tea order", vector: [0, 1], timestamp: ts + 2 }),
      makeRow({ abstract: "Tea order: chamomile, no sugar", factKey: "preferences:tea order", vector: [0, 1], timestamp: ts + 3 }),
    ];
    const rowsShuffled = [rowsInOrder[3], rowsInOrder[1], rowsInOrder[0], rowsInOrder[2]];

    const capturedPrompts = [];
    const completeJson = async (prompt, label) => {
      if (label === "consolidate-decide") {
        capturedPrompts.push(prompt);
        return {
          verdicts: [
            { cluster_index: 1, verdict: "skip", reason: "n/a" },
            { cluster_index: 2, verdict: "skip", reason: "n/a" },
          ],
        };
      }
      return null;
    };

    await runConsolidate(
      { ...makeFakeStore(rowsInOrder), completeJson },
      { scope: "global", apply: false, now: ts + 1000 }
    );
    await runConsolidate(
      { ...makeFakeStore(rowsShuffled), completeJson },
      { scope: "global", apply: false, now: ts + 1000 }
    );

    assert.equal(capturedPrompts.length, 2);
    assert.equal(
      capturedPrompts[0],
      capturedPrompts[1],
      "prompt text must be byte-identical regardless of the order fetchRows returns the same candidate set in"
    );
  });

  it("acceptance: 3 consecutive dry-runs on an unchanged store produce byte-identical verdict sets", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Coffee order: oat milk latte", content: "x", factKey: "preferences:coffee order", vector: [1, 0, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "y", factKey: "preferences:coffee order", vector: [1, 0, 0], timestamp: ts + 1 }),
      makeRow({ abstract: "Desk setup: standing desk", content: "z", factKey: "preferences:desk setup", vector: [0, 1, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "Desk setup: standing desk, oak top", content: "w", factKey: "preferences:desk setup", vector: [0, 1, 0], timestamp: ts + 3 }),
    ];

    // A deterministic stand-in for a temperature-0 LLM: a pure function of
    // the prompt text itself, so if the prompt is byte-identical across
    // runs (guaranteed by the sort-before-build fix) the "model" output is
    // byte-identical too -- this isolates OUR code's contribution to
    // determinism from real model non-determinism, which a unit test can't
    // exercise directly.
    const completeJson = async (prompt, label) => {
      if (label !== "consolidate-decide") return null;
      const clusterCount = (prompt.match(/^Cluster \d+ members:/gm) || []).length;
      const verdicts = [];
      for (let i = 1; i <= clusterCount; i++) {
        verdicts.push({ cluster_index: i, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: `deterministic-${i}` });
      }
      return { verdicts };
    };

    const results = [];
    for (let i = 0; i < 3; i++) {
      const store = makeFakeStore(rows);
      results.push(await runConsolidate({ ...store, completeJson }, { scope: "global", apply: false, now: ts + 100_000 }));
    }

    assert.deepEqual(results[0].clusters, results[1].clusters, "run 1 vs run 2 verdict sets must be byte-identical");
    assert.deepEqual(results[1].clusters, results[2].clusters, "run 2 vs run 3 verdict sets must be byte-identical");
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
      verdicts: [
        {
          cluster_index: 1,
          verdict: "supersede",
          survivor_index: 4,
          absorbed_indices: [1, 2, 3],
          reason: "the reversal row supersedes the three duplicate rows",
        },
      ],
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
      verdicts: [
        {
          cluster_index: 1,
          verdict: "supersede",
          survivor_index: 4,
          absorbed_indices: [1, 2, 3],
          reason: "the reversal row supersedes the three duplicate rows",
        },
      ],
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
      verdicts: [
        {
          cluster_index: 1,
          verdict: "supersede",
          survivor_index: 4,
          absorbed_indices: [1, 2, 3],
          reason: "reversal supersedes duplicates",
        },
      ],
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
        return {
          verdicts: [
            { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same fact, second row adds detail" },
          ],
        };
      }
      return { abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "User orders an oat milk latte, extra hot." };
    };

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 100_000 });

    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].survivorId, rows[0].id);
    assert.deepEqual(result.applied[0].absorbedIds, [rows[1].id]);

    assert.equal(store.rows.length, 2, "merge is non-destructive: the absorbed row must still be present, only invalidated");
    const survivorRow = store.rows.find((r) => r.id === rows[0].id);
    assert.equal(survivorRow.text, "Coffee order: oat milk latte, extra hot");

    const absorbedRow = store.rows.find((r) => r.id === rows[1].id);
    assert.ok(absorbedRow, "the absorbed row must not be hard-deleted");
    const absorbedMeta = JSON.parse(absorbedRow.metadata);
    assert.ok(absorbedMeta.invalidated_at, "the absorbed row must be marked invalidated");
    assert.equal(absorbedMeta.superseded_by, rows[0].id, "the absorbed row must point at the survivor");
    assert.ok(absorbedMeta.consolidation_audit, "the absorbed row must carry its own consolidation audit");
    assert.equal(absorbedMeta.consolidation_audit.action, "merge");
    assert.equal(absorbedMeta.consolidation_audit.survivorId, rows[0].id);
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
    const completeJson = async () => ({
      verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" }],
    });

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
      verdicts: [
        {
          cluster_index: 1,
          verdict: "merge",
          survivor_index: 1,
          absorbed_indices: [2],
          reason: "an unsafe LLM verdict that must be rejected",
        },
      ],
    });

    const result = await runConsolidate(
      { ...store, completeJson, log: (msg) => logs.push(msg) },
      { scope: "global", apply: true, now: ts + 100 }
    );

    assert.equal(result.applied.length, 0, "append-only categories must never merge/supersede, even on LLM instruction");
    assert.equal(store.rows.length, 2, "both events rows must remain untouched");
    assert.ok(logs.some((l) => /append-only/i.test(l)));
  });

  it("still merges the actionable duplicates in a cluster that also contains an unreferenced append-only row (paraphrased live shape)", async () => {
    // Paraphrased from a live dry-run: a lamp-preference cluster of 3 rows
    // where 2 are true preference duplicates and 1 is a "finalized decision"
    // events row. The decider should be able to merge just the 2 duplicates,
    // leaving the append-only row alone -- not skip the whole cluster.
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ category: "preference", memoryCategory: "preferences", abstract: "Reading lamp preference: warm white, bookshelf side.", factKey: "preferences:reading lamp", vector: [1, 0], timestamp: ts }),
      makeRow({ category: "decision", memoryCategory: "events", abstract: "Reading lamp finalized: warm white, positioned on the bookshelf side.", factKey: "events:reading lamp", vector: [1, 0], timestamp: ts + 1 }),
      makeRow({ category: "preference", memoryCategory: "preferences", abstract: "Prefers warm white lighting on the bookshelf side for reading.", factKey: "preferences:reading lamp", vector: [1, 0], timestamp: ts + 2 }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async () => ({
      verdicts: [
        {
          cluster_index: 1,
          verdict: "merge",
          survivor_index: 1,
          absorbed_indices: [3],
          reason: "rows 1 and 3 are the same lamp preference; row 2 is an append-only decision left untouched",
        },
      ],
    });

    const result = await runConsolidate(
      { ...store, completeJson },
      { scope: "global", apply: true, now: ts + 100 }
    );

    assert.equal(result.applied.length, 1, "the actionable subset must still merge");
    assert.equal(result.applied[0].survivorId, rows[0].id);
    assert.deepEqual(result.applied[0].absorbedIds, [rows[2].id]);
    assert.equal(store.rows.length, 3, "merge is non-destructive: all 3 rows must still be present");
    const absorbedRow = store.rows.find((r) => r.id === rows[2].id);
    assert.ok(absorbedRow, "the absorbed preference duplicate must not be hard-deleted, only invalidated");
    assert.ok(JSON.parse(absorbedRow.metadata).invalidated_at, "the absorbed row must be marked invalidated");
    assert.ok(
      store.rows.some((r) => r.id === rows[1].id),
      "the unreferenced append-only events row must remain completely untouched"
    );
  });

  it("plugin-wide invariant: no LLM verdict path (merge or supersede) ever calls a hard delete", async () => {
    // deps intentionally has NO delete method at all -- if either
    // applyMergeVerdict or applySupersedeVerdict tried to call it, this
    // would throw "deps.delete is not a function" and fail the test.
    const ts = 1_700_000_000_000;
    // Deliberately disjoint vocabulary between the two pairs (no shared
    // words at all) so neither the reversal-gated nor the ratio-gated
    // topic-overlap fallback can bridge them into one cluster -- this test
    // is only about the delete-method invariant, not clustering.
    const mergeRows = [
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts + 1 }),
    ];
    const supersedeRows = [
      makeRow({ abstract: "Desk setup: standing desk", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "Desk setup: no longer using a standing desk", factKey: "preferences:desk setup", vector: [0, 1, 0, 0], timestamp: ts + 3 }),
    ];
    const rows = [...mergeRows, ...supersedeRows];
    const store = makeFakeStore(rows);
    const { delete: _omittedDelete, ...storeWithoutDelete } = store;

    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return {
          verdicts: [
            { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" },
            { cluster_index: 2, verdict: "supersede", survivor_index: 2, absorbed_indices: [1], reason: "reversal" },
          ],
        };
      }
      return { abstract: "merged", overview: "", content: "merged" };
    };

    const result = await runConsolidate(
      { ...storeWithoutDelete, completeJson },
      { scope: "global", apply: true, now: ts + 100_000 }
    );

    assert.equal(result.applied.length, 2, "both verdicts must apply successfully without a delete method available");
    assert.equal(store.rows.length, 4, "no row may be removed by either verdict path");
  });

  it("merge is idempotent: a second apply run over the same store makes zero further changes", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return {
          verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" }],
        };
      }
      return { abstract: "merged", overview: "", content: "merged" };
    };

    const first = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 100_000 });
    const second = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 200_000 });

    assert.equal(first.applied.length, 1);
    assert.equal(second.applied.length, 0, "the invalidated absorbed row must not re-enter clustering on the next run");
    assert.equal(store.rows.length, 2, "still non-destructive: both rows remain present after two runs");
  });

  it("decides multiple independent clusters with exactly ONE completeJson call, not one call per cluster", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      // Cluster A: coffee order duplicates
      makeRow({ abstract: "Coffee order: oat milk latte", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", factKey: "preferences:coffee order", vector: [1, 0, 0, 0], timestamp: ts + 1 }),
      // Cluster B: unrelated tea duplicates
      makeRow({ abstract: "Tea order: chamomile", factKey: "preferences:tea order", vector: [0, 1, 0, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "Tea order: chamomile, no sugar", factKey: "preferences:tea order", vector: [0, 1, 0, 0], timestamp: ts + 3 }),
      // Cluster C: unrelated desk duplicates
      makeRow({ abstract: "Desk setup: standing desk", factKey: "preferences:desk setup", vector: [0, 0, 1, 0], timestamp: ts + 4 }),
      makeRow({ abstract: "Desk setup: standing desk, oak top", factKey: "preferences:desk setup", vector: [0, 0, 1, 0], timestamp: ts + 5 }),
    ];
    const store = makeFakeStore(rows);
    let decideCallCount = 0;
    const completeJson = async (_prompt, label) => {
      if (label !== "consolidate-decide") {
        return { abstract: "merged", overview: "", content: "merged" };
      }
      decideCallCount += 1;
      return {
        verdicts: [
          { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "coffee dup" },
          { cluster_index: 2, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "tea dup" },
          { cluster_index: 3, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "desk dup" },
        ],
      };
    };

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 100_000 });

    assert.equal(decideCallCount, 1, "all 3 clusters must be decided in a single completeJson call");
    assert.equal(result.clusters.length, 3, "all 3 clusters must be reported");
    assert.equal(result.applied.length, 3, "all 3 clusters' merge verdicts must be applied");
  });

  it("never touches rows outside the requested scope", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ scope: "global", abstract: "Scoped fact one", factKey: "preferences:x", vector: [1, 0], timestamp: ts }),
      makeRow({ scope: "other-scope", abstract: "Different scope fact", factKey: "preferences:x", vector: [1, 0], timestamp: ts }),
    ];
    const store = makeFakeStore(rows);
    const completeJson = async () => ({
      verdicts: [{ cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" }],
    });

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: false, now: ts + 100 });
    assert.equal(result.scanned, 1, "fetchRows must only see the requested scope");
  });

  it("end-to-end: the decider sees the cross-lane favorite-drink family as ONE cluster, not fragmented or missed (item 4 acceptance)", async () => {
    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({ abstract: "Favorite drink: cola", content: "x", factKey: "preferences:favorite drink", source: "manual", vector: [1, 0, 0, 0], timestamp: ts }),
      makeRow({ abstract: "The user really likes cola as their favorite drink", content: "y", factKey: undefined, source: "reflection", vector: [0, 1, 0, 0], timestamp: ts + 1 }),
      makeRow({ abstract: "Cola is what gets ordered most evenings", content: "z", factKey: undefined, source: "auto-capture", vector: [0, 0, 1, 0], timestamp: ts + 2 }),
      makeRow({ abstract: "No longer drinks cola", content: "w", factKey: undefined, source: "manual", vector: [0, 0, 0, 1], timestamp: ts + 3 }),
    ];
    const store = makeFakeStore(rows);
    let sawClusterMemberCount = null;
    const completeJson = async (prompt, label) => {
      if (label !== "consolidate-decide") return null;
      sawClusterMemberCount = (prompt.match(/^\d+\. \[/gm) || []).length;
      return {
        verdicts: [
          { cluster_index: 1, verdict: "supersede", survivor_index: 4, absorbed_indices: [1, 2, 3], reason: "reversal supersedes all 3 cross-lane duplicates" },
        ],
      };
    };

    const result = await runConsolidate({ ...store, completeJson }, { scope: "global", apply: true, now: ts + 100_000 });

    assert.equal(result.clusters.length, 1, "exactly one cluster must reach the decider");
    assert.equal(sawClusterMemberCount, 4, "the decider's prompt must list all 4 rows together in that one cluster");
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].absorbedIds.length, 3, "all 3 cross-lane duplicates must be absorbed by the single supersede verdict");
  });
});

describe("memory consolidate: CLI attachment", () => {
  it("registers consolidate as a subcommand of the memory-pro group, not the root program", () => {
    const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));

    const program = new Command();
    const stubContext = {
      store: {},
      retriever: {},
      scopeManager: {},
      migrator: {},
    };
    createMemoryCLI(stubContext)({ program });

    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group command must be registered");

    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("consolidate"),
      `expected "consolidate" under the memory-pro group, got: ${groupNames.join(", ")}`
    );

    const rootNames = program.commands.map((c) => c.name());
    assert.ok(
      !rootNames.includes("consolidate"),
      `"consolidate" must not be reachable as a root-level command, root has: ${rootNames.join(", ")}`
    );
  });
});

describe("memory consolidate: CLI system-prompt wiring", () => {
  it("forwards buildConsolidatePrompt's system prompt through the CLI's completeJson adapter for both the decide and merge calls", async () => {
    // Root cause (live-proven): the CLI's deps adapter used to be a 2-param
    // lambda `(prompt, label) => llmClient.completeJson(prompt, label)`, so
    // the decider's system prompt never reached the model -- every call ran
    // under the generic "memory extraction assistant" system message and the
    // model returned extraction-shaped JSON instead of a verdict. This test
    // drives the real command action (not runConsolidate directly) so it
    // actually exercises the adapter closure in cli.ts, not just consolidate.ts.
    const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));

    const ts = 1_700_000_000_000;
    const rows = [
      makeRow({
        abstract: "Coffee order: oat milk latte",
        content: "User orders an oat milk latte.",
        factKey: "preferences:coffee order",
        vector: [1, 0],
        timestamp: ts,
      }),
      makeRow({
        abstract: "Coffee order: oat milk latte, extra hot",
        content: "User specified extra hot as well.",
        factKey: "preferences:coffee order",
        vector: [1, 0],
        timestamp: ts + 1000,
      }),
    ];

    const calls = [];
    const context = {
      store: {
        fetchForCompaction: async (maxTimestamp, scopeFilter, limit) =>
          rows
            .filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp)
            .slice(0, limit ?? rows.length),
        update: async () => ({}),
        delete: async () => true,
      },
      retriever: {},
      scopeManager: {},
      migrator: {},
      embedder: { embedPassage: async () => [1, 0] },
      llmClient: {
        completeJson: async (prompt, label, system, temperature) => {
          calls.push({ label, system, temperature });
          if (label === "consolidate-decide") {
            return {
              verdicts: [
                { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "same fact, second row adds detail" },
              ],
            };
          }
          return { abstract: "Coffee order: oat milk latte, extra hot", overview: "", content: "merged content" };
        },
        getLastError: () => null,
      },
    };

    const program = new Command();
    program.exitOverride();
    createMemoryCLI(context)({ program });

    await program.parseAsync(["node", "openclaw", "memory-pro", "consolidate", "--scope", "global", "--apply"]);

    const decide = calls.find((c) => c.label === "consolidate-decide");
    assert.ok(decide, "expected a consolidate-decide completeJson call");
    assert.ok(decide.system, "the CLI adapter dropped the decider's system prompt");
    assert.match(decide.system, /consolidation decider/i);
    assert.equal(decide.temperature, 0, "the CLI adapter dropped the decider's temperature override");

    const merge = calls.find((c) => c.label === "consolidate-merge");
    assert.ok(merge, "expected a consolidate-merge completeJson call");
    assert.ok(merge.system, "the CLI adapter dropped the merge writer's system prompt");
    assert.match(merge.system, /merge writer/i);
  });
});

describe("memory consolidate: CLI journal-mirror agent identity", () => {
  function buildContext(rows, mirrorCalls) {
    return {
      store: {
        fetchForCompaction: async (maxTimestamp, scopeFilter, limit) =>
          rows
            .filter((r) => (!scopeFilter || scopeFilter.includes(r.scope)) && r.timestamp <= maxTimestamp)
            .slice(0, limit ?? rows.length),
        update: async () => ({}),
        delete: async () => true,
      },
      retriever: {},
      scopeManager: {},
      migrator: {},
      embedder: { embedPassage: async () => [1, 0] },
      llmClient: {
        completeJson: async (_prompt, label) => {
          if (label === "consolidate-decide") {
            return {
              verdicts: [
                { cluster_index: 1, verdict: "merge", survivor_index: 1, absorbed_indices: [2], reason: "dup" },
              ],
            };
          }
          return { abstract: "merged", overview: "", content: "merged" };
        },
        getLastError: () => null,
      },
      mdMirror: async (entry, meta) => {
        mirrorCalls.push({ entry, meta });
      },
    };
  }

  function buildRows() {
    const ts = 1_700_000_000_000;
    return [
      makeRow({ abstract: "Coffee order: oat milk latte", content: "a", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts }),
      makeRow({ abstract: "Coffee order: oat milk latte, extra hot", content: "b", factKey: "preferences:coffee order", vector: [1, 0], timestamp: ts + 1000 }),
    ];
  }

  it("threads --agent through to the journal-mirror writer's meta.agentId", async () => {
    const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));
    const mirrorCalls = [];
    const context = buildContext(buildRows(), mirrorCalls);

    const program = new Command();
    program.exitOverride();
    createMemoryCLI(context)({ program });

    await program.parseAsync([
      "node", "openclaw", "memory-pro", "consolidate",
      "--scope", "global", "--apply", "--agent", "terry",
    ]);

    assert.equal(mirrorCalls.length, 1, "expected exactly one journal-mirror write for the applied merge");
    assert.equal(mirrorCalls[0].meta.agentId, "terry", "the CLI's --agent value must reach the journal writer");
    assert.match(mirrorCalls[0].meta.source, /memory-consolidate/);
  });

  it("leaves meta.agentId undefined when --agent is omitted, preserving the fallback-directory default", async () => {
    const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));
    const mirrorCalls = [];
    const context = buildContext(buildRows(), mirrorCalls);

    const program = new Command();
    program.exitOverride();
    createMemoryCLI(context)({ program });

    await program.parseAsync(["node", "openclaw", "memory-pro", "consolidate", "--scope", "global", "--apply"]);

    assert.equal(mirrorCalls.length, 1);
    assert.equal(mirrorCalls[0].meta.agentId, undefined);
  });
});
