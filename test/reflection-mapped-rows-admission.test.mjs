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
    reflectionText: REFLECTION_TEXT,
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
    const controller = {
      async evaluate(params) {
        seenCandidate = params.candidate;
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
