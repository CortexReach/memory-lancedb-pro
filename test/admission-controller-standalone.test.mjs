import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createAdmissionController, normalizeAdmissionControlConfig, AdmissionController } =
  jiti("../src/admission-control.ts");

describe("createAdmissionController", () => {
  it("returns null when admission control is disabled", () => {
    const config = normalizeAdmissionControlConfig({ enabled: false });
    const controller = createAdmissionController({}, {}, config);
    assert.equal(controller, null);
  });

  it("returns a usable AdmissionController instance when enabled, without any extractor involved", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "off" });
    const store = {
      async vectorSearch() {
        return [];
      },
    };
    const llm = {};

    const controller = createAdmissionController(store, llm, config);

    assert.ok(controller instanceof AdmissionController);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "events",
        abstract: "user mentioned a fact",
        overview: "## Event",
        content: "the user mentioned a fact",
      },
      candidateVector: [],
      conversationText: "the user mentioned a fact today",
      scopeFilter: ["global"],
    });

    assert.ok(evaluation.decision === "reject" || evaluation.decision === "pass_to_dedup");
    assert.equal(evaluation.audit.version, "amac-v1");
  });

  // Live-fleet trace: llm-client.ts's completeJson() never throws on an HTTP
  // failure (e.g. a 400 from a bad model id) -- it catches internally and
  // resolves null. This pins the intended behavior for that contract: a null
  // utility response must not abort or throw the evaluation; it degrades to
  // a neutral utility score with an explicit, non-genuine reason string, and
  // the overall decision still comes from the other (non-LLM) features.
  it("degrades to a neutral utility score, not a thrown error, when the LLM client resolves null (e.g. an upstream request failure)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const store = {
      async vectorSearch() {
        return [];
      },
    };
    const llm = {
      async completeJson() {
        return null;
      },
    };

    const controller = createAdmissionController(store, llm, config);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "profile",
        abstract: "User is a backend engineer",
        overview: "## Profile",
        content: "The user is a backend engineer.",
      },
      candidateVector: [],
      conversationText: "I've been doing backend engineering for years",
      scopeFilter: ["global"],
    });

    assert.equal(evaluation.audit.feature_scores.utility, 0.5, "utility score neutrally degrades, not zero/thrown");
    assert.equal(evaluation.audit.utility_reason, "Utility scoring unavailable");
    assert.ok(
      evaluation.audit.reason.includes("Utility scoring unavailable"),
      `expected the overall reason to surface the degraded utility call, got: ${evaluation.audit.reason}`,
    );
  });
});
