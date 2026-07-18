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
});
