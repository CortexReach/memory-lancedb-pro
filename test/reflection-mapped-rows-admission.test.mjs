/**
 * Regression tests for reflection writer-1 (mapped rows) admission routing.
 *
 * The distiller's mapped sections (User model deltas, Agent model deltas,
 * Lessons & pitfalls, Decisions) become durable memory rows via bulkStore.
 * They historically bypassed admission control entirely. These tests cover
 * the new gate: category mapping onto the smart registers admission priors
 * are keyed by, admit/deny paths, admission-disabled passthrough, fail-open
 * on infra errors, provenance in the persisted audit, and the distiller
 * prompt's new grounding rule.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  mapReflectionMappedCategoryToSmartRegister,
  gateMappedReflectionEntry,
  gateMappedReflectionEntries,
} = jiti("../src/reflection-mapped-admission.ts");
const { AdmissionController, ADMISSION_CONTROL_PRESETS } = jiti("../src/admission-control.ts");

const REFLECTION_TEXT = [
  "## User model deltas (about the human)",
  "- Operator prefers streaming test reporters for long suites.",
  "## Decisions (durable)",
  "- Decision: keep the deploy branch cut from a fresh master.",
].join("\n");

describe("mapReflectionMappedCategoryToSmartRegister", () => {
  it("maps legacy mapped categories onto the smart registers admission priors use", () => {
    assert.equal(mapReflectionMappedCategoryToSmartRegister("preference"), "preferences");
    assert.equal(mapReflectionMappedCategoryToSmartRegister("fact"), "cases");
    assert.equal(mapReflectionMappedCategoryToSmartRegister("decision"), "events");
    assert.equal(mapReflectionMappedCategoryToSmartRegister("unknown-legacy"), "events", "unknown categories take the lowest-prior durable-free register");
  });
});

describe("gateMappedReflectionEntry", () => {
  const baseParams = {
    text: "Operator prefers streaming test reporters for long suites.",
    category: "preference",
    heading: "User model deltas (about the human)",
    vector: [1, 0, 0],
    conversationText: REFLECTION_TEXT,
    scopeFilter: ["global"],
  };

  it("passes rows through untouched when admission control is disabled (null controller)", async () => {
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: null,
      attachAudit: true,
    });
    assert.deepEqual(result, { admit: true }, "disabled admission must preserve the historical ungated behavior");
  });

  it("drops rows the controller rejects, surfacing the audit reason", async () => {
    const controller = {
      async evaluate() {
        return {
          decision: "reject",
          audit: { decision: "reject", reason: "Admission rejected (0.100 < 0.450)." },
        };
      },
    };
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: true,
    });
    assert.equal(result.admit, false);
    assert.match(result.reason, /Admission rejected/);
  });

  it("admits passing rows and tags the persisted audit with mapped-row provenance", async () => {
    let seenCandidate = null;
    let seenConversationText = null;
    const controller = {
      async evaluate(params) {
        seenCandidate = params.candidate;
        seenConversationText = params.conversationText;
        return {
          decision: "pass_to_dedup",
          audit: { decision: "pass_to_dedup", reason: "Admission passed (0.800)." },
        };
      },
    };
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: true,
    });
    assert.equal(result.admit, true);
    const audit = JSON.parse(result.auditJson);
    assert.equal(audit.provenance, "memory-reflection-mapped");
    assert.equal(seenCandidate.category, "preferences", "the controller must score under the mapped smart register");
    assert.equal(seenCandidate.content, baseParams.text);
    // Grounding evidence must be the real underlying transcript passed in via
    // conversationText, never the candidate's own text/abstract — otherwise a
    // hallucinated distillate line would appear grounded against itself.
    assert.equal(seenConversationText, baseParams.conversationText);
    assert.notEqual(seenConversationText, seenCandidate.content);
  });

  it("omits the audit when auditMetadata persistence is off", async () => {
    const controller = {
      async evaluate() {
        return { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "ok" } };
      },
    };
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: false,
    });
    assert.equal(result.admit, true);
    assert.equal(result.auditJson, undefined);
  });

  it("fails open when the admission evaluation throws (infra error must not suppress reflection rows)", async () => {
    const warnings = [];
    const controller = {
      async evaluate() {
        throw new Error("vector store unavailable");
      },
    };
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: true,
      warnLog: (msg) => warnings.push(msg),
    });
    assert.equal(result.admit, true);
    assert.match(result.reason, /failed open/);
    assert.equal(warnings.length, 1);

    // A fail-open admit still needs durable, queryable provenance on the persisted
    // row itself (the ephemeral warnLog line above is not enough — it is never
    // stored) so this row is distinguishable from a normally-scored admit later.
    assert.ok(result.auditJson, "expected a synthesized audit record on the fail-open path");
    const audit = JSON.parse(result.auditJson);
    assert.equal(audit.failedOpen, true);
    assert.equal(audit.provenance, "memory-reflection-mapped");
    assert.match(audit.error, /vector store unavailable/);
  });

  it("omits the fail-open audit when auditMetadata persistence is off", async () => {
    const controller = {
      async evaluate() {
        throw new Error("vector store unavailable");
      },
    };
    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: false,
    });
    assert.equal(result.admit, true);
    assert.equal(result.auditJson, undefined);
  });

  it("integrates with a real AdmissionController end to end (admit path)", async () => {
    const store = { async vectorSearch() { return []; } };
    const llm = {
      async completeJson(_prompt, mode) {
        return mode === "admission-utility" ? { utility: 0.9, reason: "useful" } : null;
      },
    };
    const controller = new AdmissionController(store, llm, ADMISSION_CONTROL_PRESETS.balanced);

    const result = await gateMappedReflectionEntry({
      ...baseParams,
      admissionController: controller,
      attachAudit: true,
    });
    assert.equal(result.admit, true);
    const audit = JSON.parse(result.auditJson);
    assert.equal(audit.provenance, "memory-reflection-mapped");
    assert.equal(audit.decision, "pass_to_dedup");
  });
});

describe("gateMappedReflectionEntries (batched burst)", () => {
  const rows = [
    {
      text: "Operator prefers streaming test reporters for long suites.",
      category: "preference",
      heading: "User model deltas (about the human)",
      vector: [1, 0, 0],
    },
    {
      text: "Symptom: flaky port bind. Cause: parallel suites. Fix: ephemeral ports.",
      category: "fact",
      heading: "Lessons & pitfalls",
      vector: [0, 1, 0],
    },
    {
      text: "Decision: keep the deploy branch cut from a fresh master.",
      category: "decision",
      heading: "Decisions (durable)",
      vector: [0, 0, 1],
    },
  ];
  const baseParams = {
    attachAudit: true,
    conversationText: REFLECTION_TEXT,
    scopeFilter: ["global"],
  };

  it("gates a whole burst through ONE evaluateBatch call, preserving per-row decisions and audit provenance", async () => {
    let batchCalls = 0;
    let evaluateCalls = 0;
    let seenItems = null;
    const controller = {
      async evaluate() {
        evaluateCalls++;
        throw new Error("per-row evaluate must not be used when the controller supports evaluateBatch");
      },
      async evaluateBatch(items) {
        batchCalls++;
        seenItems = items;
        return items.map((item) =>
          item.candidate.content.includes("flaky port bind")
            ? { decision: "reject", audit: { decision: "reject", reason: "not grounded in conversation" } }
            : { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "grounded" } },
        );
      },
    };

    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows,
    });

    assert.equal(batchCalls, 1, "a burst must cost exactly one evaluateBatch call");
    assert.equal(evaluateCalls, 0);
    assert.equal(results.length, 3);

    // Per-row candidate construction is identical to the singular gate: smart
    // register mapping, heading as overview, the REAL conversation as grounding.
    assert.equal(seenItems.length, 3);
    assert.equal(seenItems[0].candidate.category, "preferences");
    assert.equal(seenItems[1].candidate.category, "cases");
    assert.equal(seenItems[2].candidate.category, "events");
    for (const item of seenItems) {
      assert.equal(item.conversationText, REFLECTION_TEXT);
      assert.deepEqual(item.scopeFilter, ["global"]);
    }

    assert.equal(results[0].admit, true);
    assert.equal(results[1].admit, false);
    assert.match(results[1].reason, /not grounded/);
    assert.equal(results[2].admit, true);
    for (const admitted of [results[0], results[2]]) {
      const audit = JSON.parse(admitted.auditJson);
      assert.equal(audit.provenance, "memory-reflection-mapped");
    }
  });

  it("falls back to one evaluate call per row when the controller predates evaluateBatch (behavior unchanged)", async () => {
    let evaluateCalls = 0;
    const controller = {
      async evaluate(params) {
        evaluateCalls++;
        return params.candidate.content.includes("flaky port bind")
          ? { decision: "reject", audit: { decision: "reject", reason: "not grounded in conversation" } }
          : { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "grounded" } };
      },
    };

    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows,
    });

    assert.equal(evaluateCalls, 3, "no evaluateBatch on the controller means the historical per-row path");
    assert.equal(results.length, 3);
    assert.equal(results[0].admit, true);
    assert.equal(results[1].admit, false);
    assert.equal(results[2].admit, true);
  });

  it("returns an empty array with zero controller calls for an empty burst", async () => {
    let calls = 0;
    const controller = {
      async evaluate() { calls++; },
      async evaluateBatch() { calls++; return []; },
    };
    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows: [],
    });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });

  it("passes every row through untouched when admission control is disabled (null controller)", async () => {
    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: null,
      rows,
    });
    assert.deepEqual(results, [{ admit: true }, { admit: true }, { admit: true }]);
  });

  it("fails open for every row in the burst when the batch call itself throws", async () => {
    const warnings = [];
    const controller = {
      async evaluate() {
        throw new Error("per-row evaluate must not be used when the controller supports evaluateBatch");
      },
      async evaluateBatch() {
        throw new Error("vector store unavailable");
      },
    };
    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows,
      warnLog: (msg) => warnings.push(msg),
    });
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.admit, true);
      assert.match(result.reason, /failed open/);
      const audit = JSON.parse(result.auditJson);
      assert.equal(audit.failedOpen, true);
      assert.equal(audit.provenance, "memory-reflection-mapped");
      assert.match(audit.error, /vector store unavailable/);
    }
    assert.equal(warnings.length, 1, "one burst, one warn line");
  });

  it("fails open when evaluateBatch returns a wrong-length result (defensive, never drops rows silently)", async () => {
    const controller = {
      async evaluate() {
        throw new Error("per-row evaluate must not be used when the controller supports evaluateBatch");
      },
      async evaluateBatch() {
        return [{ decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "grounded" } }];
      },
    };
    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows,
      warnLog: () => {},
    });
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.admit, true);
      assert.match(result.reason, /failed open/);
    }
  });

  it("routes a burst per-row through a real AdmissionController on this base (no evaluateBatch yet); upgrades to batch automatically once the controller ships it", async () => {
    // On this branch's base, AdmissionController has no evaluateBatch, so the
    // plural gate must take the per-row fallback: one admission-utility call
    // per row. When the batched admission controller (evaluateBatch honoring
    // utilityMode and chunking at its own BATCH_UTILITY_MAX_SIZE) lands in
    // src/admission-control.ts, this same call site composes into one
    // admission-utility-batch call per chunk with no lane changes.
    const utilityCalls = [];
    const store = { async vectorSearch() { return []; } };
    const llm = {
      async completeJson(_prompt, mode) {
        utilityCalls.push(mode);
        return mode === "admission-utility" ? { utility: 0.9, reason: "useful" } : null;
      },
    };
    const controller = new AdmissionController(store, llm, ADMISSION_CONTROL_PRESETS.balanced);
    const hasBatch = typeof controller.evaluateBatch === "function";

    const results = await gateMappedReflectionEntries({
      ...baseParams,
      admissionController: controller,
      rows,
    });

    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.admit, true);
      assert.equal(JSON.parse(result.auditJson).provenance, "memory-reflection-mapped");
    }
    if (!hasBatch) {
      assert.equal(
        utilityCalls.filter((m) => m === "admission-utility").length,
        3,
        "pre-batch controller: per-row utility scoring, unchanged",
      );
    }
  });
});

describe("production pipeline: parse distillate -> gate -> bulkStore (end to end)", () => {
  // Mirrors index.ts's runMemoryReflection loop shape exactly: parse mapped items from
  // the distillate, gate each one, skip on reject, push admitted rows to bulkStore.
  // A change to that orchestration (e.g. the item-2 bug this PR itself fixed, where
  // pass_to_dedup was silently treated as unconditional admit with no way to reject)
  // would be caught here without needing to drive the full agent_end hook and mock an
  // embedded reflection LLM run just to reach this loop.
  async function runMappedRowPipeline({ reflectionText, admissionController, conversationText }) {
    const { extractInjectableReflectionMappedMemoryItems } = jiti("../src/reflection-slices.ts");
    const bulkStoreCalls = [];
    const store = {
      async bulkStore(entries) {
        bulkStoreCalls.push(entries);
        return entries;
      },
    };

    // Two-phase, mirroring index.ts: collect gate-eligible rows first, gate the
    // whole burst with ONE gateMappedReflectionEntries call, then consume the
    // per-row results in order.
    const mappedReflectionMemories = extractInjectableReflectionMappedMemoryItems(reflectionText);
    const gateRows = mappedReflectionMemories.map((mapped) => ({
      text: mapped.text,
      category: mapped.category,
      heading: mapped.heading,
      vector: [1, 0, 0],
    }));
    const gateResults = await gateMappedReflectionEntries({
      admissionController,
      attachAudit: true,
      rows: gateRows,
      conversationText,
      scopeFilter: ["global"],
    });

    const mappedEntries = [];
    const rejections = [];
    for (let i = 0; i < mappedReflectionMemories.length; i++) {
      const mapped = mappedReflectionMemories[i];
      const gate = gateResults[i];
      if (!gate.admit) {
        rejections.push({ text: mapped.text, reason: gate.reason });
        continue;
      }
      mappedEntries.push({ text: mapped.text, category: mapped.category, metadata: JSON.stringify({ admission_audit: gate.auditJson }) });
    }
    if (mappedEntries.length > 0) {
      await store.bulkStore(mappedEntries);
    }
    return { bulkStoreCalls, rejections };
  }

  it("a rejected mapped row is never passed to store.bulkStore, an admitted sibling still is", async () => {
    const realConversation = "User: I mostly work on backend Python services.\nAssistant: noted.";
    const distillate = [
      "## User model deltas (about the human)",
      "- User is allergic to shellfish.", // hallucinated: not grounded in realConversation at all
      "## Decisions (durable)",
      "- Decision: use pytest for the new service.", // plausible, should be admitted
    ].join("\n");

    const controller = {
      async evaluate(params) {
        const isHallucinated = params.candidate.content.includes("allergic to shellfish");
        return isHallucinated
          ? { decision: "reject", audit: { decision: "reject", reason: "not grounded in conversation" } }
          : { decision: "pass_to_dedup", audit: { decision: "pass_to_dedup", reason: "grounded" } };
      },
    };

    const { bulkStoreCalls, rejections } = await runMappedRowPipeline({
      reflectionText: distillate,
      admissionController: controller,
      conversationText: realConversation,
    });

    assert.equal(rejections.length, 1);
    assert.match(rejections[0].text, /allergic to shellfish/);

    assert.equal(bulkStoreCalls.length, 1, "the admitted row must still reach bulkStore");
    const storedTexts = bulkStoreCalls[0].map((e) => e.text);
    assert.ok(
      !storedTexts.some((t) => t.includes("allergic to shellfish")),
      "the rejected hallucinated row must never reach store.bulkStore",
    );
    assert.ok(
      storedTexts.some((t) => t.includes("pytest")),
      "the admitted sibling row must still reach store.bulkStore",
    );
  });

  it("when every mapped row is rejected, bulkStore is never called at all", async () => {
    const distillate = [
      "## User model deltas (about the human)",
      "- User lives on Mars.",
    ].join("\n");
    const controller = {
      async evaluate() {
        return { decision: "reject", audit: { decision: "reject", reason: "not grounded" } };
      },
    };

    const { bulkStoreCalls, rejections } = await runMappedRowPipeline({
      reflectionText: distillate,
      admissionController: controller,
      conversationText: "User: I like hiking.",
    });

    assert.equal(rejections.length, 1);
    assert.equal(bulkStoreCalls.length, 0, "bulkStore must not be called when nothing was admitted");
  });
});

describe("buildReflectionPrompt grounding discipline", () => {
  it("instructs the distiller to keep in-fiction claims out of the mapped (durable) sections", () => {
    const { buildReflectionPrompt } = jiti("../index.ts");
    assert.equal(typeof buildReflectionPrompt, "function", "buildReflectionPrompt must be exported for prompt-content tests");
    const prompt = buildReflectionPrompt("conversation text", 4000, []);

    assert.match(prompt, /roleplay/i);
    assert.match(prompt, /not real/i);
    assert.match(
      prompt,
      /must NEVER appear under Decisions \(durable\), User model deltas, Agent model deltas, or Lessons & pitfalls/,
      "the rule must name the four mapped sections verbatim",
    );
  });
});
