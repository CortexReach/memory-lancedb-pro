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
      return entries.map((e, i) => ({ ...e, id: `new-${i + 1}`, timestamp: 1_700_000_500_000 }));
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

function reflectionItem(text, { category = "patterns", heading = "Agent model deltas (about the assistant/system)" } = {}) {
  const metadata = JSON.stringify({
    type: "memory-reflection-mapped",
    memory_category: category,
    _reflectionHeading: heading,
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

function auditedReflectionItem(text, opts = {}) {
  const item = reflectionItem(text, opts);
  const build = item.buildEntry;
  item.buildEntry = (v) => {
    const entry = build(v);
    const meta = JSON.parse(entry.metadata);
    meta.admission_control = { decision: "create", reason: "caller-gate", utility: 0.9 };
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
      assert.notEqual(audit.decision, "pass_to_dedup", "the synthetic pre-gated marker must never persist");
      assert.equal(audit.reason, "caller-gate", "the caller's own audit must persist");
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
    assert.equal(meta.admission_control.reason, "caller-gate", "the caller's audit must survive the supersede path");
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
});
