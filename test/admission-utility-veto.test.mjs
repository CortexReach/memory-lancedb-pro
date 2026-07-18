import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");


// Live-fleet trace (2026-07-18): a session-scoped candidate the judge
// scored 0.2 ("not a durable fact") still passed the gate at composite 0.596
// because the preferences type prior (0.9 x 0.6 weight = 0.54) alone clears
// the 0.45 reject bar. The veto gives the judge a floor of authority.
describe("utility veto floor", () => {
  const store = {
    async vectorSearch() {
      return [];
    },
  };
  function llmScoring(utilityScore) {
    return {
      async completeJson() {
        return { utility: utilityScore, reason: "Session-specific; not a durable fact" };
      },
    };
  }
  const candidate = {
    category: "preferences",
    abstract: "User prefers no tool usage in this session",
    overview: "## Preference",
    content: "User asked for no tools during this session only",
  };
  const evaluateParams = {
    candidate,
    candidateVector: [0.1, 0.2, 0.3],
    conversationText: "please do not use any tools for the rest of this session",
    scopeFilter: ["global"],
  };

  it("rejects outright when the judge's utility is at or below the floor, even though the type prior carries the composite past reject", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    assert.equal(config.utilityVetoThreshold, 0.25, "presets default the veto floor to 0.25");
    const controller = new AdmissionController(store, llmScoring(0.2), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(evaluation.decision, "reject");
    assert.match(evaluation.audit.reason, /utility veto/i);
    assert.equal(evaluation.audit.thresholds.utilityVeto, 0.25);
  });

  it("leaves scores above the floor to the composite (which passes on the type prior)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(store, llmScoring(0.6), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(evaluation.decision, "pass_to_dedup");
    assert.doesNotMatch(evaluation.audit.reason, /utility veto/i);
  });

  it("utilityVetoThreshold: 0 disables the veto and restores composite-only gating", async () => {
    const config = normalizeAdmissionControlConfig({
      enabled: true,
      utilityMode: "standalone",
      utilityVetoThreshold: 0,
    });
    const controller = new AdmissionController(store, llmScoring(0.2), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(
      evaluation.decision,
      "pass_to_dedup",
      "with the veto off, the preferences type prior carries the composite past the reject bar",
    );
  });

  it("does not veto degraded utility calls (failure default 0.5 stays above the floor)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const llm = {
      async completeJson() {
        return null;
      },
    };
    const controller = new AdmissionController(store, llm, config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.doesNotMatch(evaluation.audit.reason, /utility veto/i);
  });

  it("clamps config values into [0,1] and falls back to the preset default on junk", () => {
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: 5 }).utilityVetoThreshold, 1);
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: -2 }).utilityVetoThreshold, 0);
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: "junk" }).utilityVetoThreshold, 0.25);
  });
});
