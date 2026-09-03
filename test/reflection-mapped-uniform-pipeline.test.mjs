// Uniform pipeline for reflection mapped rows: after the reflection-lane
// admission gate, mapped rows take exactly the extraction candidates' path --
// batched dedup decider, verdict handling, batched merge writer, bulk create --
// via SmartExtractor.persistGatedCandidates, so a duplicate mapped row MERGES
// into its existing target instead of landing beside it, a judge outage
// creates instead of dropping, and a whole burst costs one batched dedup call.
//
// Fixtures are entirely synthetic; no real conversation data.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { matchesMemoryCategoryFilter, resolveCategoryFilterCandidates } = jiti("../src/memory-categories.ts");

function vectorFor(text) {
  const vec = [];
  for (let d = 0; d < 16; d++) {
    const digest = createHash("sha256").update(`${text}:${d}`).digest();
    vec.push(((digest.readUInt32BE(0) % 2000) - 1000) / 1000);
  }
  return vec;
}

function makeEmbedder() {
  return {
    embed: async (text) => vectorFor(text),
    embedBatch: async (texts) => texts.map((t) => vectorFor(t)),
  };
}

function makeStore({ neighbors = [] } = {}) {
  const rows = new Map();
  for (const n of neighbors) rows.set(n.id, n);
  const updates = [];
  const bulkStored = [];
  return {
    rows,
    updates,
    bulkStored,
    async vectorSearch() {
      return [...rows.values()].map((entry) => ({ entry, score: 0.85 }));
    },
    async getById(id) {
      return rows.get(id) ?? null;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return rows.get(id) ?? null;
    },
    async store() {},
    async bulkStore(entries) {
      bulkStored.push(...entries);
      const stored = entries.map((e, i) => ({ ...e, id: `new-${rows.size + i + 1}`, timestamp: 1_700_000_500_000 }));
      for (const s of stored) rows.set(s.id, s);
      return stored;
    },
  };
}

function neighborRow(id, text) {
  return {
    id,
    text,
    category: "patterns",
    scope: "agent:probe",
    importance: 0.8,
    timestamp: 1_700_000_000_000,
    metadata: JSON.stringify({
      memory_category: "patterns",
      l0_abstract: text,
      l1_overview: `## Existing\n${text}`,
      l2_content: text,
    }),
  };
}

function makeLlm({ onDedupBatch, onMergeBatch } = {}) {
  const calls = [];
  return {
    calls,
    async completeJson(prompt, label) {
      calls.push(label);
      if (label === "dedup-decision-batch") {
        if (!onDedupBatch) throw new Error("unexpected dedup-decision-batch call");
        return onDedupBatch(prompt);
      }
      if (label === "merge-memory-batch") {
        if (!onMergeBatch) throw new Error("unexpected merge-memory-batch call");
        return onMergeBatch(prompt);
      }
      throw new Error(`unexpected llm call: ${label}`);
    },
  };
}

function makeExtractor(store, llm, extraConfig = {}) {
  return new SmartExtractor(store, makeEmbedder(), llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "agent:probe",
    log() {},
    debugLog() {},
    ...extraConfig,
  });
}

function reflectionItem(text, { category = "patterns", heading = "Agent model deltas (about the assistant/system)", mappedKind } = {}) {
  const metadata = JSON.stringify({
    type: "memory-reflection-mapped",
    memory_category: category,
    _reflectionHeading: heading,
    ...(mappedKind ? { mappedKind } : {}),
    marker: "reflection-metadata-preserved",
  });
  return {
    candidate: { category, abstract: text, overview: `## ${heading}`, content: text },
    vector: vectorFor(text),
    buildEntry: (v) => ({
      text,
      vector: v,
      importance: 0.8,
      category,
      scope: "agent:probe",
      metadata,
    }),
  };
}

describe("reflection mapped rows: uniform dedup -> merge pipeline", () => {
  it("merges a duplicate mapped row into its existing target instead of storing it beside it", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Prefer bulleted answers when the user asks for outlines.")] });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Prefer short answers whenever the user explicitly requests brevity in chat.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.merged, 1, "the duplicate mapped row must merge");
    assert.equal(createdEntries.length, 0, "nothing new lands beside the target");
    assert.equal(store.bulkStored.length, 0);
    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.ok(contentUpdate, "the merge target must be updated");
    assert.equal(contentUpdate.id, "row-1");
    assert.deepEqual(
      llm.calls.filter((c) => c === "dedup-decision-batch"),
      ["dedup-decision-batch"],
      "exactly one batched dedup call",
    );
    assert.deepEqual(
      llm.calls.filter((c) => c === "merge-memory-batch"),
      ["merge-memory-batch"],
      "exactly one batched merge-writer call",
    );
  });

  it("stores a novel mapped row through the caller's entry builder, reflection metadata intact", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Do not restate a setting once its owner has withdrawn it.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1);
    assert.equal(createdEntries.length, 1);
    assert.equal(store.bulkStored.length, 1);
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved", "CREATE writes must keep the reflection metadata");
    assert.equal(meta.type, "memory-reflection-mapped");
    assert.equal(store.bulkStored[0].category, "patterns");
    assert.equal(llm.calls.length, 0, "no similar rows -> no dedup or merge LLM calls");
  });

  it("decides a whole burst with exactly one batched dedup call and drops skip verdicts", async () => {
    const store = makeStore({
      neighbors: [
        neighborRow("row-1", "Prefer bulleted answers when the user asks for outlines."),
        neighborRow("row-2", "Always honor a session-scoped no-tools constraint."),
      ],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "skip", match_index: 1, reason: "duplicate" },
          { index: 2, decision: "skip", match_index: 2, reason: "duplicate" },
          { index: 3, decision: "create", reason: "new" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [
        reflectionItem("Keep replies compact once a requester opts into terse output."),
        reflectionItem("Apply the per-thread capability limits on every turn."),
        reflectionItem("Confirm the target branch before opening a pull request."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(llm.calls.filter((c) => c === "dedup-decision-batch").length, 1, "one dedup call for the burst");
    assert.equal(stats.skipped, 2);
    assert.equal(stats.created, 1);
    assert.equal(createdEntries.length, 1);
  });

  it("persists the row when the dedup judge fails, instead of dropping it (fail-open)", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Prefer bulleted answers when the user asks for outlines.")] });
    const llm = makeLlm({
      onDedupBatch: () => {
        throw new Error("judge outage");
      },
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Prefer concise answers when the user explicitly asks for brevity.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "a judge outage must not lose the reflection row");
    assert.equal(createdEntries.length, 1);
    assert.equal(store.bulkStored.length, 1);
  });

  it("never re-scores pre-gated rows through admission control", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    const { stats } = await extractor.persistGatedCandidates(
      [reflectionItem("Track the deploy window in the release checklist.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "the pre-gated row must persist without a second admission pass");
    assert.deepEqual(llm.calls, [], "no admission (or any other) LLM call may fire for pre-gated rows");
  });
});

// Production shape: index.ts's mapped lane serializes the gate's admission
// record (plus provenance) and stores it as a nested JSON STRING under
// metadata.admission_audit — mirror that exactly, never an invented field.
const PRODUCTION_MAPPED_AUDIT = {
  version: "amac-v1",
  decision: "pass_to_dedup",
  score: 0.62,
  reason: "caller-gate-probe",
  thresholds: { reject: 0.25, admit: 0.55 },
  weights: { similarity: 0.4, utility: 0.3, novelty: 0.3 },
  feature_scores: { similarity: 0.5, utility: 0.7, novelty: 0.6 },
  matched_existing_memory_ids: [],
  compared_existing_memory_ids: [],
  max_similarity: 0.5,
  evaluated_at: 1_700_000_400_000,
  provenance: "memory-reflection-mapped",
};

function auditedReflectionItem(text, opts = {}) {
  const item = reflectionItem(text, opts);
  const build = item.buildEntry;
  item.buildEntry = (v) => {
    const entry = build(v);
    const meta = JSON.parse(entry.metadata);
    meta.admission_audit = JSON.stringify(PRODUCTION_MAPPED_AUDIT);
    return { ...entry, metadata: JSON.stringify(meta) };
  };
  return item;
}

describe("reflection mapped rows: review-round hardening (audit fidelity, provenance, fail-open, burst dedup)", () => {
  it("persists the caller's own admission audit on a merge target, never the pre-gated marker", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Track deploy windows in the release checklist file.")] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    await extractor.persistGatedCandidates(
      [auditedReflectionItem("Record every deploy window inside the shared release checklist.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const auditUpdates = store.updates
      .map((u) => {
        try { return JSON.parse(u.patch.metadata).admission_control; } catch { return undefined; }
      })
      .filter(Boolean);
    assert.ok(auditUpdates.length >= 1, "the merged target must carry an admission audit");
    for (const audit of auditUpdates) {
      assert.equal(audit.reason, "caller-gate-probe", "the caller's own gate record must persist");
      assert.equal(audit.provenance, "memory-reflection-mapped", "the mapped-lane provenance must survive the nested-JSON parse");
      assert.equal(audit.version, "amac-v1", "the full production record flows through, not a synthetic marker");
    }
  });

  it("builds supersede rows from the caller's entry, layering the verdict fields on top", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "The staging smoke test runs before every deploy.")] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "supersede", match_index: 1, reason: "newer fact" }] }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("The staging smoke test now runs after every deploy instead of before it.", { category: "preferences" })],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 1, "the superseding row must be created");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved", "reflection provenance must survive the supersede path");
    assert.equal(meta.type, "memory-reflection-mapped", "the mapped kind must survive the supersede path");
    assert.equal(JSON.parse(meta.admission_audit).reason, "caller-gate-probe", "the caller's audit must survive the supersede path");
    assert.equal(meta.supersedes, "row-1", "the verdict linkage must be layered on");
    assert.ok(meta.fact_key, "the verdict fact_key must be layered on");
    assert.equal(store.bulkStored[0].importance, 0.8, "the caller's importance must survive");
    assert.ok(stats.created >= 1 || stats.merged >= 1, "the outcome is accounted");
  });

  it("fails open to the caller-built row when the dedup search fails twice", async () => {
    const store = makeStore({ neighbors: [] });
    store.vectorSearch = async () => {
      throw new Error("simulated search outage");
    };
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("Keep one canonical runbook per service in the operations space.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "an admitted row must never be dropped by a failing dedup search");
    assert.equal(store.bulkStored.length, 1);
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved", "the fail-open row is the caller's own entry");
  });

  it("falls back to create when the batched merge writer degrades, instead of dropping the addition", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Rotate the API token on the first Monday of the month.")] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [] }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("Rotate the API token on the first Monday, and log the rotation in the audit sheet.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.merged, 0, "a degraded merge must not count as merged");
    assert.equal(stats.created, 1, "the admitted addition must fall back to create");
    assert.equal(store.bulkStored.length, 1, "the caller-built row lands instead of disappearing");
    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.equal(contentUpdate, undefined, "the merge target stays untouched");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved");
  });

  it("falls back to the caller-built row when the merge target vanishes before the read", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Publish the weekly changelog digest every Friday afternoon.")] });
    const realGet = store.getById.bind(store);
    store.getById = async (id, scopeFilter) => (id === "row-1" ? null : realGet(id, scopeFilter));
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("Publish the changelog digest each Friday and pin it in the team space.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 1, "the admitted row must land as a create, never vanish");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved", "the fallback row is the caller's own entry");
    assert.equal(stats.merged ?? 0, 0, "a vanished target must not count as merged");
    assert.equal(stats.created, 1, "the fallback is accounted as a create");
    assert.ok(!llm.calls.includes("merge-memory-batch"), "no merge may be generated against a vanished target");
    assert.equal(store.updates.length, 0, "nothing is written over the missing row");
  });

  it("falls back to the caller-built row when the merge target vanishes during the update", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Send the incident retro invite within two business days.")] });
    const realUpdates = store.updates;
    store.update = async (id, patch) => {
      realUpdates.push({ id, patch });
      return null;
    };
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("Schedule the incident retro invite inside two business days of closure.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.merged ?? 0, 0, "a null update result must not be reported as a merge");
    assert.equal(stats.created, 1, "the admitted row falls back to a create");
    assert.equal(store.bulkStored.length, 1, "the caller-built row lands instead of disappearing");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved");
  });

  it("falls back to the caller-built row when a support target has vanished", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Keep the sandbox image list mirrored in the platform wiki.")] });
    const realGet = store.getById.bind(store);
    store.getById = async (id, scopeFilter) => (id === "row-1" ? null : realGet(id, scopeFilter));
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "support", match_index: 1, reason: "same fact restated" }] }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [auditedReflectionItem("Mirror every sandbox image name into the platform wiki page.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.supported ?? 0, 0, "a vanished support target must not count as supported");
    assert.equal(stats.created, 1, "the admitted row falls back to a create");
    assert.equal(store.bulkStored.length, 1, "the caller-built row lands instead of disappearing");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved");
  });

  it("collapses same-burst near-duplicate mapped rows to a single create", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);
    const text = "Archive finished experiment notebooks into the research index.";

    const { stats } = await extractor.persistGatedCandidates(
      [reflectionItem(text), reflectionItem(text)],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 1, "twin rows in one burst must collapse to one create");
    assert.equal(stats.created, 1);
    assert.equal(stats.skipped, 1, "the dropped twin is accounted as skipped");
  });

  it("a merged row stays reachable through its own category-filtered list view (real filter semantics)", async () => {
    const target = neighborRow("row-1", "Review the failing check output before re-running the pipeline.");
    const store = makeStore({ neighbors: [target] });
    const persistedSources = [];
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "same practice, richer detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm, {
      onPersisted: (entry, info) => { persistedSources.push(info.source); },
    });

    await extractor.persistGatedCandidates(
      [auditedReflectionItem("Always review the failing check output before restarting the pipeline run.", { category: "preferences" })],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.ok(contentUpdate, "the merge target must be updated");
    const mergedColumnCategory = target.category;
    const mergedMetadata = contentUpdate.patch.metadata;
    assert.ok(
      resolveCategoryFilterCandidates("patterns").includes(mergedColumnCategory),
      "the target's own view must still SQL-prefilter the row in",
    );
    assert.ok(
      matchesMemoryCategoryFilter(mergedColumnCategory, "patterns", mergedMetadata),
      "the merged row must remain visible in the target's category view; a cross-category merge must not reclassify it out of both views",
    );
    assert.ok(
      !resolveCategoryFilterCandidates("preferences").includes(mergedColumnCategory),
      "the incoming candidate's view never sees the target's column",
    );
    assert.ok(
      persistedSources.some((s) => typeof s === "string" && s.startsWith("reflection:")),
      "a mapped-row merge must carry its reflection provenance in the persistence notification",
    );
  });

  it("routes a richer same-burst restatement through the semantic judge (MERGE verdict, one row)", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "richer restatement of the sibling row" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged digest practice", overview: "o", content: "merged digest practice content" }] }),
    });
    const extractor = makeExtractor(store, llm);
    const short = reflectionItem("Ship the weekly metrics digest on Mondays.");
    const richer = reflectionItem("Ship the weekly metrics digest on Mondays, and attach the anomaly summary when a threshold tripped.");
    richer.vector = [...short.vector];

    const { stats } = await extractor.persistGatedCandidates(
      [short, richer],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.ok(llm.calls.includes("dedup-decision-batch"), "same-lane burst pairs must reach the semantic judge");
    assert.equal(store.bulkStored.length, 1, "a MERGE verdict must prevent two unconditional creates");
    assert.equal(stats.created, 1);
    assert.equal(stats.merged, 1, "the richer row merges into its sibling's stored row");
    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.ok(contentUpdate, "the merged content lands on the sibling's stored row");
    assert.equal(contentUpdate.id, "new-1");
  });

  it("honors a same-burst SKIP verdict from the judge", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "skip", match_index: 1, reason: "adds nothing beyond the sibling" }] }),
    });
    const extractor = makeExtractor(store, llm);
    const first = reflectionItem("Rotate the pager schedule at the sprint boundary.");
    const restated = reflectionItem("The pager schedule rotates when a sprint boundary arrives.");
    restated.vector = [...first.vector];

    const { stats } = await extractor.persistGatedCandidates(
      [first, restated],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.ok(llm.calls.includes("dedup-decision-batch"), "the skip must come from the judge, not a blind guard");
    assert.equal(store.bulkStored.length, 1, "a SKIP verdict must prevent the duplicate create");
    assert.equal(stats.created, 1);
    assert.equal(stats.skipped, 1);
  });

  it("leaves dissimilar same-lane burst rows judge-free (below the sibling similarity threshold)", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);
    const a = reflectionItem("Track quarterly budget variance in the shared finance sheet.");
    const b = reflectionItem("Recycle stale sandbox images at the start of each month.");
    a.vector = [1, 0, 0, 0];
    b.vector = [0, 1, 0, 0];

    const { stats } = await extractor.persistGatedCandidates(
      [a, b],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 2, "unrelated rows persist independently with no judge call");
    assert.equal(stats.created, 2);
    assert.equal(stats.skipped ?? 0, 0);
  });

  it("keeps a lesson and a decision with identical text independent in one burst (shared candidate category)", async () => {
    // Reflection lessons and decisions BOTH map to candidate category
    // "cases" while carrying different mapped kinds, headings, importance,
    // and decay policies. A category+text twin key silently drops whichever
    // lane the slicer emits second.
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);
    const text = "Verify the backup restore end to end before rotating the encryption keys.";
    const lessonRow = reflectionItem(text, { category: "cases", heading: "Lessons (durable)", mappedKind: "lesson" });
    const decisionRow = reflectionItem(text, { category: "cases", heading: "Decisions (durable)", mappedKind: "decision" });
    decisionRow.vector = [...lessonRow.vector];

    const { stats } = await extractor.persistGatedCandidates(
      [lessonRow, decisionRow],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 2, "identical text under lesson and decision is two lanes, not a twin");
    assert.equal(stats.created, 2);
    assert.equal(stats.skipped ?? 0, 0, "neither lane's row may be silently discarded before semantic judging");
    const kinds = store.bulkStored
      .map((e) => { try { return JSON.parse(e.metadata).mappedKind; } catch { return undefined; } })
      .sort();
    assert.deepEqual(kinds, ["decision", "lesson"], "both mapped kinds must persist");
  });

  it("keeps same-text rows from different reflection sections independent in one burst", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);
    const text = "Keep the changelog draft current while a release window is open.";
    const patternsRow = reflectionItem(text, { category: "patterns" });
    const prefsRow = reflectionItem(text, { category: "preferences", heading: "User model deltas (about the user)" });
    prefsRow.vector = [...patternsRow.vector];

    const { stats } = await extractor.persistGatedCandidates(
      [patternsRow, prefsRow],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 2, "identical text under different categories is two facts, not a twin");
    assert.equal(stats.created, 2);
  });

  it("never lets a fail-open gate marker replace a target's complete admission audit", async () => {
    const target = neighborRow("row-1", "Rotate the standby credentials during the maintenance window.");
    const store = makeStore({ neighbors: [target] });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    const item = reflectionItem("Rotate standby credentials inside the maintenance window and log the rotation.");
    const build = item.buildEntry;
    item.buildEntry = (v) => {
      const entry = build(v);
      const meta = JSON.parse(entry.metadata);
      meta.admission_audit = JSON.stringify({
        provenance: "memory-reflection-mapped",
        failedOpen: true,
        reason: "gate error",
        error: "synthetic outage",
      });
      return { ...entry, metadata: JSON.stringify(meta) };
    };

    await extractor.persistGatedCandidates(
      [item],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    for (const u of store.updates) {
      let auditOnTarget;
      try { auditOnTarget = JSON.parse(u.patch.metadata).admission_control; } catch { auditOnTarget = undefined; }
      if (auditOnTarget !== undefined) {
        assert.equal(auditOnTarget.version, "amac-v1", "only a complete audit record may land on a target, never a fail-open marker");
      }
    }
  });
});

// Deferred same-burst verdicts resolve through store reads/writes that can
// throw; each verdict must degrade alone (fail open to its own create) so one
// storage failure never rejects the whole persistence call, discards queued
// follow-up work, or skips later verdicts.
describe("reflection mapped rows: deferred sibling-verdict fail-open", () => {
  function siblingSupportPair() {
    const anchor = reflectionItem("Confirm the failover runbook after every region switch.");
    const restated = reflectionItem("After a region switch, always confirm the failover runbook.");
    restated.vector = [...anchor.vector];
    return [anchor, restated];
  }
  const supportVerdict = () => ({
    results: [{ index: 1, decision: "support", match_index: 1, reason: "same practice restated" }],
  });

  it("fails open to a create when the deferred support target read throws", async () => {
    const store = makeStore({ neighbors: [] });
    store.getById = async () => {
      throw new Error("read outage");
    };
    const llm = makeLlm({ onDedupBatch: supportVerdict });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      siblingSupportPair(),
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 2, "a throwing getById must not reject the whole persistence call");
    assert.equal(stats.supported ?? 0, 0);
    assert.equal(store.bulkStored.length, 2, "the caller-built row is enqueued exactly once");
    assert.equal(store.updates.length, 0, "no partial support write may land");
  });

  it("fails open to a create when the deferred support write throws", async () => {
    const store = makeStore({ neighbors: [] });
    store.update = async () => {
      throw new Error("support write outage");
    };
    const llm = makeLlm({ onDedupBatch: supportVerdict });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      siblingSupportPair(),
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 2, "a throwing store.update must not reject the whole persistence call");
    assert.equal(stats.supported ?? 0, 0);
    assert.equal(store.bulkStored.length, 2, "the admitted row lands as a create, exactly once");
  });

  it("isolates one deferred-verdict failure: earlier merges still flush and later verdicts still resolve", async () => {
    const anchor = reflectionItem("Run the capacity check before enabling a new tenant.");
    const mergeRow = reflectionItem("Run the capacity check before enabling a new tenant, and file the result in the intake ticket.");
    const failingSupport = reflectionItem("Capacity checks precede any new tenant enablement.");
    const laterSupport = reflectionItem("Before a tenant goes live, the capacity check must have run.");
    // Geometry pins every verdict's top-scored sibling to the anchor with
    // comfortable margins (anchor first, other siblings well below).
    anchor.vector = [1, 0, 0, 0];
    mergeRow.vector = [0.9, 0.43588989, 0, 0];
    failingSupport.vector = [0.98, 0.19899749, 0, 0];
    laterSupport.vector = [0.9995, 0.0316186, 0, 0];

    const store = makeStore({ neighbors: [] });
    const baseUpdate = store.update.bind(store);
    let supportAttempts = 0;
    store.update = async (id, patch) => {
      if (!patch.text) {
        supportAttempts++;
        if (supportAttempts === 1) throw new Error("support write outage");
      }
      return baseUpdate(id, patch);
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "merge", match_index: 1, reason: "richer restatement" },
          { index: 2, decision: "support", match_index: 1, reason: "same practice" },
          { index: 3, decision: "support", match_index: 1, reason: "same practice" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged capacity practice", overview: "o", content: "merged capacity practice content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [anchor, mergeRow, failingSupport, laterSupport],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.merged, 1, "the merge queued before the failure must still flush");
    assert.equal(stats.supported ?? 0, 1, "the verdict after the failure must still resolve");
    assert.equal(stats.created, 2, "the anchor plus exactly one fail-open create for the failed verdict");
    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.ok(contentUpdate, "the merged content still lands on the anchor row");
    assert.equal(contentUpdate.id, "new-1");
    assert.equal(store.bulkStored.length, 2, "no verdict may enqueue more than one caller-built row");
  });

  it("binds a deferred verdict by lane identity, never to a same-text row from another lane", async () => {
    const text = "Escalate stuck deploys to the on-call channel after two failed retries.";
    const lessonTwin = reflectionItem(text, { category: "cases", heading: "Lessons (durable)", mappedKind: "lesson" });
    const decisionAnchor = reflectionItem(text, { category: "cases", heading: "Decisions (durable)", mappedKind: "decision" });
    const decisionSupport = reflectionItem(
      "Two failed deploy retries mean an escalation to the on-call channel.",
      { category: "cases", heading: "Decisions (durable)", mappedKind: "decision" },
    );
    decisionSupport.vector = [...decisionAnchor.vector];

    // bulkStore drops the decision anchor, shifting positions so the
    // deferred verdict has to resolve through the identity fallback.
    const store = makeStore({ neighbors: [] });
    const baseBulkStore = store.bulkStore.bind(store);
    let firstBulk = true;
    store.bulkStore = async (entries) => {
      if (!firstBulk) {
        return baseBulkStore(entries);
      }
      firstBulk = false;
      store.bulkStored.push(...entries);
      const kept = entries.filter((e) => !String(e.metadata).includes('"mappedKind":"decision"'));
      const stored = kept.map((e, i) => ({ ...e, id: `new-${store.rows.size + i + 1}`, timestamp: 1_700_000_500_000 }));
      for (const s of stored) store.rows.set(s.id, s);
      return stored;
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "support", match_index: 1, reason: "same decision restated" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [lessonTwin, decisionAnchor, decisionSupport],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.supported ?? 0, 0, "the support must not bind to the lesson row that merely shares the text");
    assert.equal(store.updates.length, 0, "no support write may land on the other lane's row");
    assert.equal(stats.created, 3, "the unresolvable verdict falls open to its own create");
  });
});

// Round-5 review regressions: supersede invalidation is isolated from the
// already-committed replacement, and fail-open admission markers survive as
// bypass evidence on MERGE/SUPPORT targets instead of vanishing.
// Fixtures are entirely synthetic; no real conversation data.
const PRODUCTION_FAIL_OPEN_MARKER = {
  provenance: "memory-reflection-mapped",
  failedOpen: true,
  reason: "admission evaluation failed open",
  error: "Error: gate outage",
};

function failOpenReflectionItem(text, opts = {}) {
  const item = reflectionItem(text, opts);
  const build = item.buildEntry;
  item.buildEntry = (v) => {
    const entry = build(v);
    const meta = JSON.parse(entry.metadata);
    meta.admission_audit = JSON.stringify(PRODUCTION_FAIL_OPEN_MARKER);
    return { ...entry, metadata: JSON.stringify(meta) };
  };
  return item;
}

function auditedNeighborRow(id, text) {
  const row = neighborRow(id, text);
  const meta = JSON.parse(row.metadata);
  meta.admission_control = PRODUCTION_MAPPED_AUDIT;
  row.metadata = JSON.stringify(meta);
  return row;
}

describe("reflection mapped rows: round-5 data-integrity regressions", () => {
  it("isolates a throwing supersede invalidation: replacement stays, claim stripped, later invalidations run", async () => {
    const store = makeStore({
      neighbors: [
        neighborRow("row-1", "The nightly export job writes into the archive bucket."),
        neighborRow("row-2", "Weekly metrics roll up on Mondays before standup."),
      ],
    });
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch, scopeFilter) => {
      if (id === "row-1" && patch?.metadata?.includes("superseded_by")) {
        throw new Error("invalidate outage");
      }
      return baseUpdate(id, patch, scopeFilter);
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "supersede", match_index: 1, reason: "newer fact" },
          { index: 2, decision: "supersede", match_index: 2, reason: "newer fact" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [
        reflectionItem("The nightly export job now writes into the cold-storage bucket instead.", { category: "preferences" }),
        reflectionItem("Weekly metrics now roll up on Fridays after the retro instead.", { category: "entities" }),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 2, "both replacements are committed");
    assert.equal(createdEntries.length, 2, "the batch resolves instead of rejecting past the commit");
    const oldRowMeta = JSON.parse(store.rows.get("row-1").metadata);
    assert.equal(oldRowMeta.superseded_by, undefined, "the old row stays active after the failed invalidation");
    const row2Invalidation = store.updates.find(
      (u) => u.id === "row-2" && u.patch?.metadata?.includes("superseded_by"),
    );
    assert.ok(row2Invalidation, "the later invalidation still runs after the earlier one failed");
    assert.equal(
      store.updates.some((u) => u.id === "row-1" && u.patch?.metadata?.includes("superseded_by")),
      false,
      "the failed invalidation never lands on the old row",
    );
    const stripWrite = store.updates.find((u) => u.id === "new-3" && u.patch?.metadata);
    assert.ok(stripWrite, "the downgrade rewrites the failed pair's replacement row");
    const strippedMeta = JSON.parse(stripWrite.patch.metadata);
    assert.equal(strippedMeta.supersedes, undefined, "the supersedes claim is stripped");
    assert.equal(
      (strippedMeta.relations ?? []).some((r) => r.type === "supersedes"),
      false,
      "the supersedes relation is stripped",
    );
  });

  it("treats an invalidation update that writes nothing as a failure and downgrades to a plain create", async () => {
    const store = makeStore({
      neighbors: [neighborRow("row-1", "The canary check gates every rollout stage.")],
    });
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch, scopeFilter) => {
      if (id === "row-1" && patch?.metadata?.includes("superseded_by")) {
        return null;
      }
      return baseUpdate(id, patch, scopeFilter);
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "supersede", match_index: 1, reason: "newer fact" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("The canary check now gates only the final rollout stage.", { category: "preferences" })],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(createdEntries.length, 1, "the replacement row stays committed");
    const oldRowMeta = JSON.parse(store.rows.get("row-1").metadata);
    assert.equal(oldRowMeta.superseded_by, undefined, "a nothing-written update must not count as invalidated");
    const stripWrite = store.updates.find((u) => u.id === "new-2" && u.patch?.metadata);
    assert.ok(stripWrite, "the outcome downgrades to a plain create");
    assert.equal(JSON.parse(stripWrite.patch.metadata).supersedes, undefined, "the supersedes claim is stripped");
  });

  it("MERGE with a production fail-open marker preserves the target audit and appends bypass evidence", async () => {
    const store = makeStore({
      neighbors: [auditedNeighborRow("row-1", "Keep the sandbox image list inside the platform handbook.")],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }] }),
      onMergeBatch: () => ({ results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }] }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    await extractor.persistGatedCandidates(
      [failOpenReflectionItem("List every sandbox image in the platform handbook appendix as well.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const targetWrite = store.updates.find((u) => u.id === "row-1" && u.patch?.metadata);
    assert.ok(targetWrite, "the merge must update its target");
    const meta = JSON.parse(targetWrite.patch.metadata);
    assert.deepEqual(
      meta.admission_control,
      PRODUCTION_MAPPED_AUDIT,
      "the target's complete audit must be preserved, never replaced by the marker",
    );
    assert.ok(Array.isArray(meta.admission_bypass_events), "bypass evidence must be recorded");
    assert.equal(meta.admission_bypass_events.length, 1);
    assert.equal(meta.admission_bypass_events[0].failedOpen, true);
    assert.equal(meta.admission_bypass_events[0].provenance, "memory-reflection-mapped");
    assert.equal(typeof meta.admission_bypass_events[0].at, "number");
  });

  it("SUPPORT with a production fail-open marker preserves the target audit and appends bypass evidence", async () => {
    const store = makeStore({
      neighbors: [auditedNeighborRow("row-1", "Run the schema linter before publishing any config change.")],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({ results: [{ index: 1, decision: "support", match_index: 1, reason: "same practice" }] }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    const { stats } = await extractor.persistGatedCandidates(
      [failOpenReflectionItem("Always run the schema linter ahead of publishing configuration changes.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.skipped >= 1 || stats.merged >= 1 || stats.created === 0, true, "support resolves against the target");
    const targetWrite = store.updates.find((u) => u.id === "row-1" && u.patch?.metadata);
    assert.ok(targetWrite, "the support must update its target");
    const meta = JSON.parse(targetWrite.patch.metadata);
    assert.deepEqual(meta.admission_control, PRODUCTION_MAPPED_AUDIT, "the complete audit survives");
    assert.equal(meta.admission_bypass_events?.length, 1, "the bypass marker is appended once");
    assert.equal(meta.admission_bypass_events[0].failedOpen, true);
    assert.ok(meta.support_info, "the support stats still update");
  });
});

// Round-6 review regressions: failure-path integrity — identity-stable
// deferred invalidation under bulkStore filtering, complete evidence on
// grouped merges, guarded contextualize/contradict fallbacks, confirmed-only
// downgrade and statistics. Fixtures are entirely synthetic.
describe("reflection mapped rows: round-6 failure-path integrity", () => {
  it("binds a deferred supersede invalidation by entry identity when bulkStore filters an earlier row", async () => {
    const store = makeStore({
      neighbors: [neighborRow("row-1", "The staging balancer drains connections before each maintenance window.")],
    });
    const filteredText = "Rotate the artifact signing key at the start of every quarter.";
    const baseBulkStore = store.bulkStore.bind(store);
    store.bulkStore = async (entries) => {
      const accepted = entries.filter((e) => e.text !== filteredText);
      store.bulkStored.push(...entries);
      const stored = accepted.map((e, i) => ({ ...e, id: `new-${i + 2}`, timestamp: 1_700_000_500_000 }));
      for (const s of stored) store.rows.set(s.id, s);
      return stored;
    };
    void baseBulkStore;
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "create", reason: "novel" },
          { index: 2, decision: "supersede", match_index: 1, reason: "newer fact" },
          { index: 3, decision: "create", reason: "novel" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [
        reflectionItem(filteredText),
        reflectionItem("The staging balancer now drains connections only during the overnight window.", { category: "preferences" }),
        reflectionItem("Publish the deprecation calendar to the shared operations wiki."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const invalidation = store.updates.find(
      (u) => u.id === "row-1" && u.patch?.metadata?.includes("superseded_by"),
    );
    assert.ok(invalidation, "the surviving replacement still invalidates its target");
    const oldMeta = JSON.parse(invalidation.patch.metadata);
    assert.equal(
      oldMeta.superseded_by,
      "new-2",
      "superseded_by must point at the actual replacement, not the row that shifted into its position",
    );
    assert.notEqual(oldMeta.superseded_by, "new-3", "an unrelated create must never claim the supersede");
    assert.equal(stats.superseded, 1);
  });

  it("skips a deferred invalidation entirely when bulkStore filtered the replacement itself", async () => {
    const store = makeStore({
      neighbors: [neighborRow("row-1", "Cache warmers replay the top queries after every deploy completes.")],
    });
    const filteredText = "Cache warmers now replay only the checkout queries after deploys.";
    store.bulkStore = async (entries) => {
      const accepted = entries.filter((e) => e.text !== filteredText);
      store.bulkStored.push(...entries);
      const stored = accepted.map((e, i) => ({ ...e, id: `new-${i + 2}`, timestamp: 1_700_000_500_000 }));
      for (const s of stored) store.rows.set(s.id, s);
      return stored;
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "supersede", match_index: 1, reason: "newer fact" },
          { index: 2, decision: "create", reason: "novel" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [
        reflectionItem(filteredText, { category: "preferences" }),
        reflectionItem("Route the weekly digest through the notifications relay instead of direct send."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(
      store.updates.some((u) => u.id === "row-1" && u.patch?.metadata?.includes("superseded_by")),
      false,
      "no replacement row exists, so the old row must stay untouched",
    );
    assert.equal(stats.superseded ?? 0, 0, "an unconfirmed supersede must not be counted");
  });

  it("aggregates every merge addition's fail-open evidence, not only the first addition's", async () => {
    const store = makeStore({
      neighbors: [auditedNeighborRow("row-1", "Keep the incident timeline template pinned in the response channel.")],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "merge", match_index: 1, reason: "adds detail" },
          { index: 2, decision: "merge", match_index: 1, reason: "adds detail" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }],
      }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    await extractor.persistGatedCandidates(
      [
        reflectionItem("Pin the incident timeline template near the top of the response channel."),
        failOpenReflectionItem("Link the incident timeline template from the escalation runbook too."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const targetWrite = store.updates.find((u) => u.id === "row-1" && u.patch?.metadata?.includes("l0_abstract"));
    assert.ok(targetWrite, "the grouped merge must update its target");
    const meta = JSON.parse(targetWrite.patch.metadata);
    assert.deepEqual(meta.admission_control, PRODUCTION_MAPPED_AUDIT, "the target's complete audit survives");
    assert.ok(Array.isArray(meta.admission_bypass_events), "the second addition's marker must be recorded");
    assert.equal(meta.admission_bypass_events.length, 1);
    assert.equal(meta.admission_bypass_events[0].failedOpen, true, "the fail-open marker from the non-first addition survives");
  });

  it("falls back to an unlinked create when the contextualize target read throws", async () => {
    const logs = [];
    const store = makeStore({
      neighbors: [neighborRow("row-1", "Pre-warm the reporting cluster ahead of the month-end close.")],
    });
    store.getById = async (id) => {
      if (id === "row-1") throw new Error("read outage");
      return store.rows.get(id) ?? null;
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "contextualize", match_index: 1, reason: "adds nuance" }],
      }),
    });
    const extractor = makeExtractor(store, llm, { log: (m) => logs.push(m) });

    const { createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Pre-warming matters most when the close lands right after a long weekend.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(createdEntries.length, 1, "the admitted candidate must still land");
    assert.ok(
      logs.some((m) => m.includes("contextualize target read failed")),
      "the read failure resolves through the guarded contextualize fallback, not the generic processing-failure catch",
    );
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(
      (meta.relations ?? []).some((r) => r.type === "contextualizes"),
      false,
      "no relation may point at an unreadable target",
    );
  });

  it("stores a contradict candidate without a relation when the evidence update writes nothing", async () => {
    const logs = [];
    const store = makeStore({
      neighbors: [neighborRow("row-1", "Roll access reviews on the first business day of each month.")],
    });
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch, scopeFilter) => {
      if (id === "row-1") return null;
      return baseUpdate(id, patch, scopeFilter);
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "contradict", match_index: 1, reason: "opposite practice" }],
      }),
    });
    const extractor = makeExtractor(store, llm, { log: (m) => logs.push(m) });

    const { createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Access reviews actually roll on the last business day of each month.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(createdEntries.length, 1, "the contradicting row still lands");
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(
      (meta.relations ?? []).some((r) => r.type === "contradicts"),
      false,
      "a nothing-written evidence update must not leave a dangling contradicts relation",
    );
    assert.ok(
      logs.some((m) => m.includes("vanished during update")),
      "the null update is surfaced as a vanished target",
    );
  });

  it("surfaces an unresolved repair when the downgrade strip also writes nothing, and counts only confirmed supersedes", async () => {
    const logs = [];
    const store = makeStore({
      neighbors: [
        neighborRow("row-1", "Mirror the build artifacts into the secondary region nightly."),
        neighborRow("row-2", "Contract tests run against the recorded provider snapshots."),
      ],
    });
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch, scopeFilter) => {
      if (id === "row-1" && patch?.metadata?.includes("superseded_by")) return null;
      if (id === "new-3" ) return null;
      return baseUpdate(id, patch, scopeFilter);
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "supersede", match_index: 1, reason: "newer fact" },
          { index: 2, decision: "supersede", match_index: 2, reason: "newer fact" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm, { log: (m) => logs.push(m) });

    const { stats } = await extractor.persistGatedCandidates(
      [
        reflectionItem("Build artifacts now mirror into the secondary region twice a day.", { category: "preferences" }),
        reflectionItem("Contract tests now run against live provider sandboxes instead.", { category: "entities" }),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.ok(
      logs.some((m) => m.includes("UNRESOLVED supersede repair")),
      "an unconfirmed strip must surface the unresolved repair state, never a success-style downgrade log",
    );
    assert.equal(stats.superseded, 1, "only the confirmed invalidation is counted");
  });
});

// Round-7 review regressions: a partial bulkStore result must not break
// anchor sharing between deferred verdicts, and the bypass history stays
// exclusive to fail-open markers so pass audits can never evict them.
// Fixtures are entirely synthetic; no real conversation data.
describe("reflection mapped rows: round-7 partial-batch and evidence-history integrity", () => {
  it("lets multiple deferred verdicts share one surviving anchor after bulkStore filters an unrelated row", async () => {
    const filtered = reflectionItem("Digest emails render with the compact template from now on.", { category: "preferences" });
    const anchor = reflectionItem("Rotate the standby database credentials during the monthly window.");
    const firstSupport = reflectionItem("Standby database credentials rotate in the monthly window.");
    const secondSupport = reflectionItem("Credential rotation for the standby database happens monthly.");
    // Geometry: the filtered row is orthogonal to the cluster; both support
    // rows score the anchor as their top sibling with comfortable margins.
    filtered.vector = [0, 1, 0, 0];
    anchor.vector = [1, 0, 0, 0];
    firstSupport.vector = [0.98, 0.19899749, 0, 0];
    secondSupport.vector = [0.9995, 0.0316186, 0, 0];

    // bulkStore filters the unrelated row, shortening the result so the
    // anchor resolves through the identity fallback for BOTH verdicts.
    const store = makeStore({ neighbors: [] });
    const baseBulkStore = store.bulkStore.bind(store);
    let firstBulk = true;
    store.bulkStore = async (entries) => {
      if (!firstBulk) {
        return baseBulkStore(entries);
      }
      firstBulk = false;
      store.bulkStored.push(...entries);
      const kept = entries.filter((e) => !String(e.metadata).includes('"memory_category":"preferences"'));
      const stored = kept.map((e, i) => ({ ...e, id: `new-${store.rows.size + i + 1}`, timestamp: 1_700_000_500_000 }));
      for (const s of stored) store.rows.set(s.id, s);
      return stored;
    };
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "support", match_index: 1, reason: "same practice restated" },
          { index: 2, decision: "support", match_index: 1, reason: "same practice restated" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [filtered, anchor, firstSupport, secondSupport],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.supported ?? 0, 2, "both verdicts must resolve through the shared surviving anchor");
    assert.equal(stats.created, 2, "no duplicate fail-open create may land beside the anchor");
    assert.equal(store.bulkStored.length, 2, "only the two create rows are ever enqueued");
    const supportWrites = store.updates.filter((u) => u.patch && !u.patch.text);
    assert.equal(supportWrites.length, 2, "both support writes must land");
    assert.ok(supportWrites.every((u) => u.id === "new-1"), "both supports bind to the same surviving anchor row");
  });

  it("keeps the bypass history exclusive to fail-open markers and routes complete audits to admission_control_history", async () => {
    const store = makeStore({
      neighbors: [auditedNeighborRow("row-1", "Keep the retro action list pinned to the team wiki page.")],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "merge", match_index: 1, reason: "adds detail" },
          { index: 2, decision: "merge", match_index: 1, reason: "adds detail" },
          { index: 3, decision: "merge", match_index: 1, reason: "adds detail" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }],
      }),
    });
    const extractor = makeExtractor(store, llm, { admissionControl: { enabled: true } });

    await extractor.persistGatedCandidates(
      [
        reflectionItem("Pin the retro action list at the top of the team wiki."),
        auditedReflectionItem("Retro action items belong on the pinned wiki list as well."),
        failOpenReflectionItem("Link the retro action list from the sprint board too."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    const targetWrite = store.updates.find((u) => u.id === "row-1" && u.patch?.metadata?.includes("l0_abstract"));
    assert.ok(targetWrite, "the grouped merge must update its target");
    const meta = JSON.parse(targetWrite.patch.metadata);
    assert.deepEqual(meta.admission_control, PRODUCTION_MAPPED_AUDIT, "the target's own complete audit survives untouched");
    assert.equal(meta.admission_bypass_events?.length ?? 0, 1, "only the fail-open marker may occupy the bypass history");
    assert.equal(meta.admission_bypass_events[0].failedOpen, true, "the bypass record is the fail-open marker");
    assert.equal(meta.admission_control_history?.length ?? 0, 1, "the additional complete audit lands in its own history");
    assert.equal(meta.admission_control_history[0].version, "amac-v1");
    assert.equal(meta.admission_control_history[0].decision, "pass_to_dedup");
    assert.equal(typeof meta.admission_control_history[0].at, "number");
    assert.equal(meta.admission_control_history[0].failedOpen, undefined, "no fail-open marker may leak into the audit history");
  });
});

// Round-8 review regressions: deferred verdict chains resolve transitively
// to their durable anchor (created row or existing stored row), and a
// create-decision short circuit no longer suppresses burst-sibling
// adjudication. Fixtures are entirely synthetic; no real conversation data.
describe("reflection mapped rows: round-8 transitive anchors and short-circuit sibling adjudication", () => {
  it("resolves a merge chain transitively: B merges into A, C merges into B, one row persists", async () => {
    const anchor = reflectionItem("Archive the load-test artifacts to cold storage every Friday.");
    const restated = reflectionItem("Load-test artifacts move to cold storage on Fridays.");
    const restatedAgain = reflectionItem("Every Friday the load-test artifacts go into cold storage.");
    anchor.vector = [1, 0, 0, 0];
    restated.vector = [0.98, 0.19899749, 0, 0];
    restatedAgain.vector = [0.97, 0.24310491, 0, 0];

    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "merge", match_index: 1, reason: "same practice restated" },
          { index: 2, decision: "merge", match_index: 1, reason: "restates the restatement" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged cold-storage practice", overview: "o", content: "merged cold-storage practice content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [anchor, restated, restatedAgain],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "only the chain anchor may persist as a create");
    assert.equal(stats.merged, 2, "both chained merge verdicts must resolve");
    assert.equal(store.bulkStored.length, 1, "no fail-open duplicate may land beside the anchor");
    const contentUpdate = store.updates.find((u) => u.id === "new-1" && u.patch?.metadata?.includes("l0_abstract"));
    assert.ok(contentUpdate, "the grouped merge lands on the anchor row");
  });

  it("resolves a sibling verdict through an anchor that itself merged into an existing stored row", async () => {
    const store = makeStore({
      neighbors: [neighborRow("row-1", "Rotate the audit log encryption key at the end of each quarter.")],
    });
    const mergingAnchor = reflectionItem("The audit log encryption key rotates at quarter end.");
    const supporter = reflectionItem("Quarter end is when the audit log encryption key gets rotated.");
    supporter.vector = [...mergingAnchor.vector];

    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "merge", match_index: 1, reason: "adds nothing new beyond the stored row" },
          { index: 2, decision: "support", match_index: 1, reason: "same practice restated" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged rotation practice", overview: "o", content: "merged rotation practice content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [mergingAnchor, supporter],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(store.bulkStored.length, 0, "neither candidate may create a row");
    assert.equal(stats.created ?? 0, 0, "the supporter must not fall open to a duplicate create");
    assert.equal(stats.merged, 1, "the anchor's merge into the stored row resolves");
    assert.equal(stats.supported ?? 0, 1, "the deferred support resolves through the anchor's stored target");
    const supportWrite = store.updates.find((u) => u.id === "row-1" && u.patch && !u.patch.text);
    assert.ok(supportWrite, "the support evidence lands on the stored row the anchor merged into");
  });

  it("adjudicates burst siblings when the preference-slot guard excludes every stored neighbor", async () => {
    const storedPreference = {
      ...neighborRow("row-1", "I really like the curly fries from Crown Grill."),
      category: "preferences",
      metadata: JSON.stringify({
        memory_category: "preferences",
        l0_abstract: "I really like the curly fries from Crown Grill.",
        l1_overview: "## Existing\nI really like the curly fries from Crown Grill.",
        l2_content: "I really like the curly fries from Crown Grill.",
      }),
    };
    const store = makeStore({ neighbors: [storedPreference] });
    const firstWording = reflectionItem("I really like the smash burger from Crown Grill.", { category: "preferences" });
    const secondWording = reflectionItem("I still love the smash burger from Crown Grill.", { category: "preferences" });
    secondWording.vector = [...firstWording.vector];

    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "skip", match_index: 1, reason: "same incoming preference reworded" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      [firstWording, secondWording],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(llm.calls.filter((c) => c === "dedup-decision-batch").length, 1, "eligible burst siblings must reach the judge despite the guard");
    assert.equal(stats.created, 1, "only the first wording persists");
    assert.equal(stats.skipped ?? 0, 1, "the reworded twin collapses through sibling adjudication");
    assert.equal(store.bulkStored.length, 1, "the guard must not double-create same-item siblings");
  });
});

// Round-9 review regression: a same-burst SKIP must preserve its anchor so
// later sibling verdicts resolve through the skipped survivor.
// Fixtures are entirely synthetic; no real conversation data.
describe("reflection mapped rows: round-9 skip-anchored sibling chains", () => {
  function skipChainItems() {
    const anchor = reflectionItem("Publish the incident retro notes within two days of closure.");
    const skippedTwin = reflectionItem("Incident retro notes go out within two days of closing.");
    const chained = reflectionItem("Within two days of an incident closing, the retro notes get published.");
    anchor.vector = [1, 0, 0, 0];
    skippedTwin.vector = [0.98, 0.19899749, 0, 0];
    chained.vector = [0.97, 0.24310491, 0, 0];
    return [anchor, skippedTwin, chained];
  }

  it("resolves a MERGE through a skipped sibling anchor: B skips against A, C merges into B", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "skip", match_index: 1, reason: "same practice reworded" },
          { index: 2, decision: "merge", match_index: 1, reason: "adds phrasing detail" },
        ],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged retro practice", overview: "o", content: "merged retro practice content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      skipChainItems(),
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "only the anchor persists");
    assert.equal(stats.skipped ?? 0, 1, "the twin collapses as a skip");
    assert.equal(stats.merged, 1, "the chained merge resolves through the skipped survivor to the anchor");
    assert.equal(store.bulkStored.length, 1, "no fail-open duplicate lands");
    const contentUpdate = store.updates.find((u) => u.id === "new-1" && u.patch?.metadata?.includes("l0_abstract"));
    assert.ok(contentUpdate, "the merge lands on the anchor row");
  });

  it("resolves a SUPPORT through a skipped sibling anchor: B skips against A, C supports B", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "skip", match_index: 1, reason: "same practice reworded" },
          { index: 2, decision: "support", match_index: 1, reason: "restates the practice" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats } = await extractor.persistGatedCandidates(
      skipChainItems(),
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1, "only the anchor persists");
    assert.equal(stats.skipped ?? 0, 1, "the twin collapses as a skip");
    assert.equal(stats.supported ?? 0, 1, "the support resolves through the skipped survivor to the anchor");
    assert.equal(store.bulkStored.length, 1, "no fail-open duplicate lands");
    const supportWrite = store.updates.find((u) => u.id === "new-1" && u.patch && !u.patch.text);
    assert.ok(supportWrite, "the support evidence lands on the anchor row");
  });
});
