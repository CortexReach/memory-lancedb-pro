import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { normalizeAdmissionControlConfig, createAdmissionController } = jiti("../src/admission-control.ts");

function makeStore() {
  return {
    async vectorSearch() {
      return [];
    },
    async store() {},
    async bulkStore() {},
  };
}

// Cryptographic per-dimension hash so texts differing by even one character
// (e.g. "candidate 1" vs "candidate 2") land far apart in cosine space. A
// naive rolling/modulo hash is locality-preserving for such tiny character
// deltas and produces near-identical vectors, which trips SmartExtractor's
// own batch-internal near-duplicate dedup before admission ever runs.
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
    async embed(text) {
      return vectorFor(text);
    },
    async embedBatch(texts) {
      return (texts || []).map(vectorFor);
    },
  };
}

function makeExtractionLlm(batchCalls, candidateCount) {
  return {
    async completeJson(prompt, label) {
      if (label === "extract-candidates") {
        return {
          memories: Array.from({ length: candidateCount }, (_, i) => ({
            category: "events",
            abstract: `candidate ${i + 1}`,
            overview: `## Event ${i + 1}`,
            content: `the user did thing ${i + 1}`,
          })),
        };
      }
      if (label === "admission-utility-batch") {
        batchCalls.push(prompt);
        const count = (prompt.match(/^\d+\. Category:/gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            utility: 0.9,
            reason: "batched",
          })),
        };
      }
      throw new Error(`unexpected mode: ${label}`);
    },
  };
}

describe("SmartExtractor batch admission integration", () => {
  it("scores admission utility for a whole extraction batch with exactly one LLM call", async () => {
    const batchCalls = [];
    const llm = makeExtractionLlm(batchCalls, 3);
    const store = makeStore();
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });

    const extractor = new SmartExtractor(store, makeEmbedder(), llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      admissionControl,
      admissionController: createAdmissionController(store, llm, admissionControl),
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist(
      "the user did three notable things today",
      "session-batch-1",
      { scope: "global" },
    );

    assert.equal(batchCalls.length, 1, "expected exactly one batch-utility LLM call for 3 candidates");
    assert.equal(stats.created, 3);
  });
});

// ---------------------------------------------------------------------------
// Batched dedup decider + batched merge writer
// ---------------------------------------------------------------------------

/**
 * Store whose vectorSearch returns one active similar row per dedup lookup.
 * Rows are handed out in call order (row-1, row-2, ...) unless `sharedTarget`
 * pins every lookup to the same row, and getById serves the same rows back
 * for the merge path.
 */
function makeNeighborStore({ sharedTarget = false, neighbors = true } = {}) {
  const rows = new Map();
  const updates = [];
  const bulkStored = [];
  let searchCalls = 0;
  function rowFor(id) {
    if (!rows.has(id)) {
      rows.set(id, {
        id,
        text: `existing fact ${id}`,
        category: "preference",
        scope: "global",
        metadata: JSON.stringify({
          memory_category: "preferences",
          l0_abstract: `existing fact ${id}`,
          l1_overview: `## Existing\nDetail for ${id}`,
          l2_content: `full existing content for ${id}`,
        }),
      });
    }
    return rows.get(id);
  }
  return {
    rows,
    updates,
    bulkStored,
    async vectorSearch() {
      if (!neighbors) return [];
      searchCalls += 1;
      const id = sharedTarget ? "row-1" : `row-${searchCalls}`;
      return [{ entry: rowFor(id), score: 0.85 }];
    },
    async getById(id) {
      return rows.get(id);
    },
    async update(id, patch) {
      updates.push({ id, patch });
    },
    async store() {},
    async bulkStore(entries) {
      bulkStored.push(...entries);
      return entries.map((e, i) => ({ ...e, id: `new-${i + 1}`, timestamp: Date.now() }));
    },
  };
}

/**
 * Fake LLM with hooks per internal call label. Unknown labels throw so any
 * unexpected LLM call fails the test loudly.
 */
function makeBatchLlm({ memories, onDedupBatch, onMergeBatch, onUtilityBatch, onUtility }) {
  const dedupCalls = [];
  const mergeCalls = [];
  const utilityCalls = [];
  return {
    dedupCalls,
    mergeCalls,
    utilityCalls,
    async completeJson(prompt, label) {
      if (label === "extract-candidates") {
        return { memories };
      }
      if (label === "dedup-decision-batch") {
        dedupCalls.push(prompt);
        if (!onDedupBatch) throw new Error("unexpected dedup-decision-batch call");
        return onDedupBatch(prompt, dedupCalls.length);
      }
      if (label === "merge-memory-batch") {
        mergeCalls.push(prompt);
        if (!onMergeBatch) throw new Error("unexpected merge-memory-batch call");
        return onMergeBatch(prompt, mergeCalls.length);
      }
      if (label === "admission-utility-batch") {
        utilityCalls.push(prompt);
        if (!onUtilityBatch) throw new Error("unexpected admission-utility-batch call");
        return onUtilityBatch(prompt);
      }
      if (label === "admission-utility") {
        utilityCalls.push(prompt);
        if (!onUtility) throw new Error("unexpected admission-utility call");
        return onUtility(prompt);
      }
      throw new Error(`unexpected mode: ${label}`);
    },
  };
}

function candidateFixture(i, overrides = {}) {
  return {
    category: "preferences",
    abstract: `favorite drink number ${i} is a distinct soda brand ${i}`,
    overview: `## Preference ${i}\nDetail line for preference ${i}`,
    content: `the user stated preference detail ${i} about drink ${i}`,
    ...overrides,
  };
}

function makeExtractor(store, llm, extraConfig = {}) {
  const admissionController = extraConfig.admissionControl
    ? createAdmissionController(store, llm, extraConfig.admissionControl)
    : undefined;
  return new SmartExtractor(store, makeEmbedder(), llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "global",
    log() {},
    debugLog() {},
    ...(admissionController ? { admissionController } : {}),
    ...extraConfig,
  });
}

function dedupResults(entries) {
  return { results: entries };
}

describe("SmartExtractor batched dedup decider", () => {
  it("decides dedup for a whole extraction batch with exactly one LLM call", async () => {
    const store = makeNeighborStore();
    const memories = [1, 2, 3].map((i) => candidateFixture(i));
    const llm = makeBatchLlm({
      memories,
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "skip", reason: "dup" },
          { index: 2, decision: "skip", reason: "dup" },
          { index: 3, decision: "skip", reason: "dup" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 1, "expected exactly one batched dedup call for 3 candidates");
    assert.equal(stats.skipped, 3);
    assert.equal(llm.mergeCalls.length, 0);
  });

  it("uses the batch shape even for a single candidate", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [candidateFixture(1)],
      onDedupBatch: () => dedupResults([{ index: 1, decision: "skip", reason: "dup" }]),
    });
    const extractor = makeExtractor(store, llm);

    await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 1);
    assert.match(llm.dedupCalls[0], /(^|\n)### 1\. preferences/);
  });

  it("makes zero dedup calls when admission rejects every candidate", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onUtilityBatch: (prompt) => {
        const count = 2;
        return {
          results: Array.from({ length: count }, (_, i) => ({ index: i + 1, utility: 0, reason: "junk" })),
        };
      },
      onDedupBatch: () => {
        throw new Error("dedup must not be called when nothing is admitted");
      },
    });
    const extractor = makeExtractor(store, llm, {
      admissionControl: normalizeAdmissionControlConfig({
        enabled: true,
        utilityMode: "batch",
        rejectThreshold: 0.99,
        admitThreshold: 0.995,
      }),
    });

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 0);
    assert.equal(stats.rejected, 2);
  });

  it("still makes exactly one dedup call when admission runs in standalone mode", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onUtility: () => ({ utility: 0.9, reason: "useful" }),
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "skip", reason: "dup" },
          { index: 2, decision: "skip", reason: "dup" },
        ]),
    });
    const extractor = makeExtractor(store, llm, {
      admissionControl: normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" }),
    });

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.utilityCalls.length, 2, "standalone admission keeps one utility call per candidate");
    assert.equal(llm.dedupCalls.length, 1, "dedup still batches into one call");
    assert.equal(stats.skipped, 2);
  });

  it("degrades only the missing row to CREATE when a batch entry is absent", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2, 3].map((i) => candidateFixture(i)),
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "skip", reason: "dup" },
          { index: 3, decision: "skip", reason: "dup" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 1, "a malformed row must not fan out into extra calls");
    assert.equal(stats.skipped, 2);
    assert.equal(stats.created, 1, "the missing row falls back to CREATE like a single-call parse failure");
    assert.equal(store.bulkStored.length, 1);
  });

  it("falls back to CREATE for every candidate when the whole batch response is unparseable", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => null,
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 1);
    assert.equal(stats.created, 2);
  });

  it("falls back to CREATE for every candidate when the batch call itself throws", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => {
        throw new Error("network down");
      },
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(stats.created, 2, "call-level dedup failure defaults every candidate to CREATE");
  });

  it("chunks oversized dedup batches and covers every item exactly once", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [],
      onDedupBatch: (prompt, call) => {
        const count = call === 1 ? 10 : 2;
        return dedupResults(
          Array.from({ length: count }, (_, i) => ({ index: i + 1, decision: "skip", reason: `c${call}` })),
        );
      },
    });
    const extractor = makeExtractor(store, llm);
    const items = Array.from({ length: 12 }, (_, i) => ({
      candidate: candidateFixture(i + 1),
      topSimilar: [
        { entry: { id: `row-${i + 1}`, text: "t", category: "preference", metadata: "{}" }, score: 0.8 },
      ],
    }));

    const results = await extractor.llmDedupDecisionBatch(items);

    assert.equal(llm.dedupCalls.length, 2, "12 items over a cap of 10 must split into 2 calls");
    assert.equal(results.length, 12);
    assert.ok(results.every((r) => r.decision === "skip"), "every item must receive its own real verdict");
    assert.equal(results[0].reason, "c1");
    assert.equal(results[11].reason, "c2");
  });

  it("formats the batched dedup prompt as numbered blocks without list markers", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [
        candidateFixture(1, { overview: "## Preference\n- Name: Cola\n- - Doubled marker" }),
        candidateFixture(2),
      ],
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "skip", reason: "dup" },
          { index: 2, decision: "skip", reason: "dup" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    await extractor.extractAndPersist("text", "s1", { scope: "global" });

    const prompt = llm.dedupCalls[0];
    assert.match(prompt, /\n\n### 2\. preferences/, "blocks are numbered as markdown headings and blank-line separated");
    assert.match(prompt, /^Abstract: /m, "fields are flush-left under the heading");
    assert.doesNotMatch(prompt, /^ *- (Abstract|Overview|Content|Name)/m, "no leading list markers survive");
    assert.match(prompt, /^Name: Cola/m, "content-carried markers are stripped");
    assert.match(prompt, /#### Existing similar memories/, "each candidate carries its own neighbor context");
  });

  it("routes reflection-shaped candidates through the same single batched call", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [
        candidateFixture(1, {
          category: "cases",
          abstract: "Decision: roll deploys back within 15 minutes on error-rate alarms",
          overview: "## Decision\nRollback window decided",
          content: "The team decided deploys get rolled back within 15 minutes when error-rate alarms fire.",
        }),
        candidateFixture(2, {
          category: "preferences",
          abstract: "User prefers terse status updates in the morning",
          overview: "## Preference\nTerse mornings",
          content: "User asked for terse status updates before noon.",
        }),
      ],
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "create", reason: "new decision record" },
          { index: 2, decision: "skip", reason: "dup" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.dedupCalls.length, 1);
    assert.equal(stats.created, 1);
    assert.equal(stats.skipped, 1);
  });
});

describe("SmartExtractor batched merge writer", () => {
  function mergeVerdicts(count) {
    return dedupResults(
      Array.from({ length: count }, (_, i) => ({ index: i + 1, decision: "merge", match_index: 1, reason: "adds detail" })),
    );
  }

  it("writes every merge verdict with exactly one LLM call", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: () =>
        dedupResults([
          { index: 1, abstract: "merged one", overview: "o1", content: "c1" },
          { index: 2, abstract: "merged two", overview: "o2", content: "c2" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.mergeCalls.length, 1, "expected exactly one batched merge-writer call for 2 merges");
    assert.equal(stats.merged, 2);
    const contentUpdates = store.updates.filter((u) => u.patch.text);
    assert.equal(contentUpdates.length, 2);
    assert.deepEqual(contentUpdates.map((u) => u.patch.text).sort(), ["merged one", "merged two"]);
  });

  it("makes zero merge-writer calls when no verdict is a merge", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () =>
        dedupResults([
          { index: 1, decision: "skip", reason: "dup" },
          { index: 2, decision: "create", reason: "new" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.mergeCalls.length, 0);
  });

  it("groups multiple candidates merging into the same target as one job", async () => {
    const store = makeNeighborStore({ sharedTarget: true });
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: (prompt) => {
        assert.match(prompt, /preference detail 1/, "grouped job carries the first candidate");
        assert.match(prompt, /preference detail 2/, "grouped job carries the second candidate");
        return dedupResults([{ index: 1, abstract: "merged both", overview: "o", content: "c" }]);
      },
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.mergeCalls.length, 1);
    assert.equal(stats.merged, 2, "both candidates count as merged");
    const contentUpdates = store.updates.filter((u) => u.patch.text);
    assert.equal(contentUpdates.length, 1, "one grouped store write, never a stale-content clobber");
    assert.equal(contentUpdates[0].id, "row-1");
  });

  it("skips only the missing job when a batch entry is absent, exactly like a single-call merge failure", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: () => dedupResults([{ index: 1, abstract: "merged one", overview: "o1", content: "c1" }]),
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(llm.mergeCalls.length, 1, "a malformed row must not fan out into extra calls");
    assert.equal(stats.merged, 1, "only the parsed job counts as merged");
    const contentUpdates = store.updates.filter((u) => u.patch.text);
    assert.equal(contentUpdates.length, 1);
    assert.equal(contentUpdates[0].id, "row-1");
    assert.ok(
      store.updates.every((u) => u.id !== "row-2" || !u.patch.text),
      "the failed job's target row stays untouched",
    );
  });

  it("persists nothing when the whole merge response is unparseable, without crashing", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: () => null,
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(stats.merged, 0);
    assert.equal(store.updates.filter((u) => u.patch.text).length, 0);
  });

  it("persists nothing when the merge call itself throws, without crashing", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: () => {
        throw new Error("network down");
      },
    });
    const extractor = makeExtractor(store, llm);

    const stats = await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(stats.merged, 0);
    assert.equal(store.updates.filter((u) => u.patch.text).length, 0);
  });

  it("chunks oversized merge batches and covers every job exactly once", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [],
      onMergeBatch: (prompt, call) => {
        const count = call === 1 ? 10 : 2;
        return dedupResults(
          Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            abstract: `merged-c${call}-i${i + 1}`,
            overview: "o",
            content: "c",
          })),
        );
      },
    });
    const extractor = makeExtractor(store, llm);
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      matchId: `row-${i + 1}`,
      category: "preferences",
      existing: { abstract: `a${i}`, overview: `o${i}`, content: `c${i}` },
      additions: [{ candidate: candidateFixture(i + 1) }],
      targetScope: "global",
    }));

    const results = await extractor.llmMergeContentBatch(jobs);

    assert.equal(llm.mergeCalls.length, 2, "12 jobs over a cap of 10 must split into 2 calls");
    assert.equal(results.length, 12);
    assert.equal(results[0].abstract, "merged-c1-i1");
    assert.equal(results[11].abstract, "merged-c2-i2");
  });

  it("formats the batched merge prompt as numbered blocks without list markers", async () => {
    const store = makeNeighborStore();
    const llm = makeBatchLlm({
      memories: [1, 2].map((i) => candidateFixture(i)),
      onDedupBatch: () => mergeVerdicts(2),
      onMergeBatch: () =>
        dedupResults([
          { index: 1, abstract: "m1", overview: "o1", content: "c1" },
          { index: 2, abstract: "m2", overview: "o2", content: "c2" },
        ]),
    });
    const extractor = makeExtractor(store, llm);

    await extractor.extractAndPersist("text", "s1", { scope: "global" });

    const prompt = llm.mergeCalls[0];
    assert.match(prompt, /(^|\n)### 1\. preferences/);
    assert.match(prompt, /\n\n### 2\. preferences/);
    assert.match(prompt, /^#### Existing memory$/m);
    assert.match(prompt, /^#### New information$/m);
    assert.doesNotMatch(prompt, /^ *- (Abstract|Overview|Content)/m);
  });
});

describe("batched merge-writer transport slots", () => {
  it("sends the static merge-writer block through the system slot and only the job blocks as the user prompt", async () => {
    const mergeTransportCalls = [];
    const store = makeNeighborStore();
    const llm = {
      async completeJson(prompt, label, systemPrompt) {
        if (label === "extract-candidates") {
          return { memories: [1, 2].map((i) => candidateFixture(i)) };
        }
        if (label === "dedup-decision-batch") {
          return dedupResults(
            Array.from({ length: 2 }, (_, i) => ({
              index: i + 1,
              decision: "merge",
              match_index: 1,
              reason: "adds detail",
            })),
          );
        }
        if (label === "merge-memory-batch") {
          mergeTransportCalls.push({ prompt, systemPrompt });
          return dedupResults([
            { index: 1, abstract: "merged one", overview: "o", content: "merged one" },
            { index: 2, abstract: "merged two", overview: "o", content: "merged two" },
          ]);
        }
        throw new Error(`unexpected mode: ${label}`);
      },
    };
    const extractor = makeExtractor(store, llm);

    await extractor.extractAndPersist("text", "s1", { scope: "global" });

    assert.equal(mergeTransportCalls.length, 1);
    const call = mergeTransportCalls[0];
    assert.ok(
      typeof call.systemPrompt === "string" && call.systemPrompt.startsWith("You are a memory merge writer."),
      "system slot must carry the merge-writer identity block",
    );
    assert.ok(call.prompt.startsWith("## Merge jobs"), "user slot must open with the job data header");
    assert.ok(
      !call.prompt.includes("You are a memory merge writer."),
      "identity/static block must not be concatenated into the user slot",
    );
  });
});
