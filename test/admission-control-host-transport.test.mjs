import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");
const { AdmissionController, DEFAULT_ADMISSION_CONTROL_CONFIG } = jiti("../src/admission-control.ts");

describe("AdmissionController over the host transport", () => {
  it("degrades to the same fail-open utility-unavailable result as the direct transport when the host call fails", async () => {
    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/anthropic/claude-opus-4-8",
      runtimeLlmComplete: async () => {
        throw new Error("simulated host outage");
      },
      warnLog: () => {},
    });

    // candidateVector is empty so loadRelevantMatches short-circuits before
    // touching the store; the stub is never invoked.
    const controller = new AdmissionController({}, llm, DEFAULT_ADMISSION_CONTROL_CONFIG);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "preferences",
        abstract: "Favorite soda: Coca-Cola",
        overview: "",
        content: "",
      },
      candidateVector: [],
      conversationText: "I love Coca-Cola",
      scopeFilter: [],
      now: 1_752_000_000_000,
    });

    assert.equal(evaluation.audit.utility_reason, "Utility scoring unavailable");
    assert.equal(evaluation.audit.feature_scores.utility, 0.5);
    assert.ok(["reject", "pass_to_dedup"].includes(evaluation.decision));
  });
});
