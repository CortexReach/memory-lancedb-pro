import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");

function makeStore() {
  return {
    async vectorSearch() {
      return [];
    },
  };
}

function makeCandidate(n) {
  return {
    category: "events",
    abstract: `candidate ${n}`,
    overview: `## Event ${n}`,
    content: `the user did thing ${n}`,
  };
}

function makeBatchItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    candidate: makeCandidate(i + 1),
    candidateVector: [0.1, 0.2, 0.3],
    conversationText: "shared conversation excerpt",
    scopeFilter: ["global"],
  }));
}

// Reflection writer-1 mapped rows: no conversation excerpt (the distiller's
// own text stands in for it), category skews toward decision/preferences,
// and the abstract follows the mapped-row heading convention rather than
// extraction's free-form phrasing. Shape-distinct from makeCandidate so
// these tests document "reflection-lane admissions", not just "batch
// admissions with events candidates again".
function makeMappedRowCandidate(n) {
  return {
    category: "decision",
    abstract: `Decision: mapped row ${n}`,
    overview: `## Reflection decision ${n}`,
    content: `the team decided outcome ${n} during reflection`,
  };
}

function makeMappedRowBatchItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    candidate: makeMappedRowCandidate(i + 1),
    candidateVector: [0.4, 0.5, 0.6],
    conversationText: "reflection distillate excerpt",
    scopeFilter: ["global"],
  }));
}

describe("AdmissionController.evaluateBatch", () => {
  it("issues exactly one LLM call for a batch of 3 candidates, producing three distinct audits", async () => {
    let callCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        callCount++;
        assert.equal(label, "admission-utility-batch");
        return {
          results: [
            { index: 1, utility: 0.9, reason: "durable" },
            { index: 2, utility: 0.05, reason: "chatter" },
            { index: 3, utility: 0.5, reason: "middling" },
          ],
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(3));

    assert.equal(callCount, 1, "expected exactly one LLM call for the whole batch");
    assert.equal(results.length, 3);
    const reasons = results.map((r) => r.audit.utility_reason);
    assert.deepEqual(reasons, ["durable", "chatter", "middling"]);
    // Distinct scores prove each got its own audit, not one shared decision.
    const scores = results.map((r) => r.audit.feature_scores.utility);
    assert.deepEqual(scores, [0.9, 0.05, 0.5]);
  });

  it("defaults only the malformed row when the batch response is missing entries, issuing no extra LLM calls", async () => {
    let batchCallCount = 0;
    let standaloneCallCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          batchCallCount++;
          // Malformed: missing index 2 and 3 entirely (count mismatch).
          return { results: [{ index: 1, utility: 0.9, reason: "ok" }] };
        }
        standaloneCallCount++;
        return { utility: 0.5, reason: "standalone fallback" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(3));

    assert.equal(batchCallCount, 1, "expected exactly one attempted batch call");
    assert.equal(standaloneCallCount, 0, "a malformed entry must not trigger any standalone fallback calls");
    assert.equal(results.length, 3);

    // The well-formed row keeps its real batch-scored utility...
    assert.equal(results[0].audit.feature_scores.utility, 0.9);
    assert.equal(results[0].audit.utility_reason, "ok");

    // ...while only the two missing rows default, independently, without
    // dragging the well-formed row's score down with them.
    assert.equal(results[1].audit.feature_scores.utility, 0.5);
    assert.equal(results[2].audit.feature_scores.utility, 0.5);
  });

  it("scores a reflection-lane mapped-row batch with exactly ceil(N/cap) LLM calls and N distinct audits", async () => {
    // 12 mapped rows chunk into 10 + 2, i.e. ceil(12/10) = 2 calls. Chunk
    // sizes are supplied explicitly rather than parsed back out of the
    // prompt: the batch prompt's own few-shot example also contains 3
    // "N. Category:" lines, so a naive regex count over the full prompt
    // over-counts by 3 and silently masks exactly the kind of fallback this
    // test exists to rule out.
    let batchCallCount = 0;
    let globalRowCounter = 0;
    const chunkSizes = [10, 2];
    const llm = {
      async completeJson(_prompt, label) {
        if (label !== "admission-utility-batch") {
          throw new Error(`unexpected non-batch call for mapped rows: ${label}`);
        }
        const count = chunkSizes[batchCallCount];
        batchCallCount++;
        return {
          results: Array.from({ length: count }, (_, i) => {
            globalRowCounter++;
            return { index: i + 1, utility: 0.1, reason: `mapped row ${globalRowCounter}` };
          }),
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeMappedRowBatchItems(12));

    assert.equal(batchCallCount, 2, "expected 12 mapped rows to chunk into exactly 2 batch calls");
    assert.equal(results.length, 12);
    const reasons = new Set(results.map((r) => r.audit.utility_reason));
    assert.equal(reasons.size, 12, "expected 12 distinct per-row audits, not one shared decision");
  });

  it("drops only the malformed row within a reflection-lane mapped-row batch, keeping the rest at their real scores", async () => {
    let batchCallCount = 0;
    let standaloneCallCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          batchCallCount++;
          // 5 mapped rows in the chunk; entry for index 3 is missing.
          return {
            results: [
              { index: 1, utility: 0.9, reason: "row 1" },
              { index: 2, utility: 0.8, reason: "row 2" },
              { index: 4, utility: 0.7, reason: "row 4" },
              { index: 5, utility: 0.6, reason: "row 5" },
            ],
          };
        }
        standaloneCallCount++;
        return { utility: 0.5, reason: "standalone fallback" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeMappedRowBatchItems(5));

    assert.equal(batchCallCount, 1, "expected exactly ceil(5/10) = 1 batch call");
    assert.equal(standaloneCallCount, 0, "the missing row must not trigger any standalone fallback calls");
    assert.equal(results.length, 5);
    assert.deepEqual(
      results.map((r) => r.audit.feature_scores.utility),
      [0.9, 0.8, 0.5, 0.7, 0.6],
      "row 3 (the missing entry) defaults independently; rows 1,2,4,5 keep their real batch scores",
    );
  });

  it("keeps evaluateBatch calls isolated per controller instance, so a lane-scoped LLM client never crosses into another lane's batch", async () => {
    // Stands in for lane/model-affinity composition (a future reflection-lane
    // controller constructed with its own lane-resolved LlmClient): proves
    // evaluateBatch always routes through the constructor-injected `llm` for
    // that specific instance, never a shared/global client, so composing a
    // second AdmissionController with a different model is a pure
    // construction-time decision with no further plumbing required here.
    // Both batches below are 2 items (well under the chunk cap), so each
    // mock returns a fixed 2-entry response rather than parsing the count
    // back out of the prompt — the batch prompt's few-shot example also
    // contains "N. Category:" lines, which a regex-based count would
    // over-count against.
    const calls = { reflection: 0, extraction: 0 };
    const reflectionLlm = {
      async completeJson(_prompt, _label) {
        calls.reflection++;
        return {
          results: [
            { index: 1, utility: 0.42, reason: "reflection-model" },
            { index: 2, utility: 0.42, reason: "reflection-model" },
          ],
        };
      },
    };
    const extractionLlm = {
      async completeJson(_prompt, _label) {
        calls.extraction++;
        return {
          results: [
            { index: 1, utility: 0.77, reason: "extraction-model" },
            { index: 2, utility: 0.77, reason: "extraction-model" },
          ],
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const reflectionController = new AdmissionController(makeStore(), reflectionLlm, config);
    const extractionController = new AdmissionController(makeStore(), extractionLlm, config);

    const [reflectionResults, extractionResults] = await Promise.all([
      reflectionController.evaluateBatch(makeMappedRowBatchItems(2)),
      extractionController.evaluateBatch(makeBatchItems(2)),
    ]);

    assert.equal(calls.reflection, 1);
    assert.equal(calls.extraction, 1);
    assert.ok(reflectionResults.every((r) => r.audit.utility_reason === "reflection-model"));
    assert.ok(extractionResults.every((r) => r.audit.utility_reason === "extraction-model"));
  });

  it("chunks batches larger than 10 candidates into multiple LLM calls", async () => {
    let batchCallCount = 0;
    const llm = {
      async completeJson(prompt, label) {
        if (label !== "admission-utility-batch") {
          throw new Error(`unexpected non-batch call in chunking test: ${label}`);
        }
        batchCallCount++;
        // Count how many "N. Category:" candidate lines this specific call's
        // prompt contains, so each chunk gets a correctly-sized response
        // (proving both chunks round-trip cleanly, with no fallback noise).
        const count = (prompt.match(/^\d+\. Category:/gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({ index: i + 1, utility: 0.5, reason: "r" })),
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    // 15 candidates should chunk into 10 + 5, i.e. two calls.
    const items = makeBatchItems(15);
    const results = await controller.evaluateBatch(items);

    assert.equal(results.length, 15);
    assert.equal(batchCallCount, 2, "expected 15 candidates to chunk into exactly 2 batch calls");
  });

  it("fences the batch few-shot example so it cannot be misread as an instruction for the live batch", async () => {
    let capturedSystem;
    const llm = {
      async completeJson(_prompt, label, systemPrompt) {
        if (label === "admission-utility-batch") {
          capturedSystem = systemPrompt;
          return {
            results: [{ index: 1, utility: 0.5, reason: "r" }],
          };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch(makeBatchItems(1));

    assert.ok(capturedSystem, "expected a batch-utility call carrying the system slot");
    assert.doesNotMatch(
      capturedSystem,
      /Expected response:/,
      "the few-shot label must not read as an instruction the model is expected to follow literally"
    );
    assert.match(capturedSystem, /Example response:/);
    assert.match(capturedSystem, /--- EXAMPLE \(not your current batch\) ---/);
    assert.match(capturedSystem, /--- END EXAMPLE ---/);
  });
});

// Rider 2: cost-preview parity. evaluateBatch has exactly one real
// call-site today (SmartExtractor's extraction lane), but a reflection-lane
// caller composing its own AdmissionController at assembly (per item 3)
// would produce a second one. A flow-accounting audit reconstructing call
// volume from logs needs every batch-mode INFO line — success or fallback
// — to carry the candidate count, consistently, so counts from different
// call-sites can be tallied the same way. Lane attribution itself is
// already free: debugLog is a constructor-injected callback (like `llm`),
// so each lane's own construction site can prefix it distinctly — proven
// generically by the "keeps evaluateBatch calls isolated per controller
// instance" test above, which covers the identical composition shape for
// the `llm` field.
describe("AdmissionController.evaluateBatch: cost-preview call accounting", () => {
  it("logs a per-chunk candidate count on a successful batch call", async () => {
    const debugLines = [];
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          return {
            results: [
              { index: 1, utility: 0.5, reason: "r1" },
              { index: 2, utility: 0.5, reason: "r2" },
              { index: 3, utility: 0.5, reason: "r3" },
            ],
          };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config, (msg) => debugLines.push(msg));

    await controller.evaluateBatch(makeBatchItems(3));

    const infoLine = debugLines.find((l) => /admission-control/.test(l) && /3 candidates/.test(l));
    assert.ok(
      infoLine,
      `expected a debugLog line reporting the 3-candidate batch call, got: ${JSON.stringify(debugLines)}`,
    );
  });

  it("logs the same candidate count on the call-failure fallback path, for consistent accounting", async () => {
    const debugLines = [];
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          throw new Error("simulated network failure");
        }
        return { utility: 0.5, reason: "standalone" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config, (msg) => debugLines.push(msg));

    await controller.evaluateBatch(makeBatchItems(3));

    const infoLine = debugLines.find((l) => /admission-control/.test(l) && /3 candidates/.test(l));
    assert.ok(
      infoLine,
      `expected the fallback debugLog line to also report the 3-candidate count, got: ${JSON.stringify(debugLines)}`,
    );
  });

  it("logs one line per chunk, each with that chunk's own count, not the whole batch's total", async () => {
    const debugLines = [];
    let batchCallCount = 0;
    const chunkSizes = [10, 2];
    const llm = {
      async completeJson(_prompt, label) {
        if (label !== "admission-utility-batch") return null;
        const count = chunkSizes[batchCallCount];
        batchCallCount++;
        return {
          results: Array.from({ length: count }, (_, i) => ({ index: i + 1, utility: 0.5, reason: "r" })),
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config, (msg) => debugLines.push(msg));

    await controller.evaluateBatch(makeBatchItems(12));

    const tenLine = debugLines.find((l) => /10 candidates/.test(l));
    const twoLine = debugLines.find((l) => /\b2 candidates/.test(l));
    assert.ok(tenLine, `expected a per-chunk line for the 10-candidate chunk, got: ${JSON.stringify(debugLines)}`);
    assert.ok(twoLine, `expected a per-chunk line for the 2-candidate chunk, got: ${JSON.stringify(debugLines)}`);
  });
});

// A lane that routes its whole burst through evaluateBatch (e.g. reflection
// mapped rows) must not change behavior when batch mode is off: the
// controller itself owns the utilityMode decision and degrades to the
// historical per-candidate topology internally.
describe("AdmissionController.evaluateBatch honors non-batch utilityMode", () => {
  it("utilityMode standalone: one admission-utility call per candidate, no batch call", async () => {
    let standaloneCallCount = 0;
    let batchCallCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          batchCallCount++;
          return { results: [] };
        }
        standaloneCallCount++;
        return { utility: 0.9, reason: "scored per candidate" };
      },
    };
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeMappedRowBatchItems(3));

    assert.equal(batchCallCount, 0, "standalone mode must never issue a batched utility call");
    assert.equal(standaloneCallCount, 3, "standalone mode keeps one utility call per candidate");
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result.audit, "per-candidate audits are unchanged in the fallback topology");
    }
  });

  it("utilityMode off: zero utility LLM calls for the whole batch", async () => {
    let llmCalls = 0;
    const llm = {
      async completeJson() {
        llmCalls++;
        return null;
      },
    };
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "off" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeMappedRowBatchItems(3));

    assert.equal(llmCalls, 0, "utilityMode off must not spend any utility LLM calls");
    assert.equal(results.length, 3);
  });
});

describe("AdmissionController.evaluateBatch transport slots", () => {
  it("sends the static judge block through the system slot and only the candidate blocks as the user prompt", async () => {
    const calls = [];
    const llm = {
      async completeJson(prompt, label, systemPrompt) {
        calls.push({ prompt, label, systemPrompt });
        return {
          results: [
            { index: 1, utility: 0.9, reason: "durable" },
            { index: 2, utility: 0.2, reason: "chatter" },
          ],
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch(makeBatchItems(2));

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.label, "admission-utility-batch");
    assert.ok(
      typeof call.systemPrompt === "string" && call.systemPrompt.startsWith("You are a memory admission judge."),
      "system slot must carry the judge identity block",
    );
    assert.ok(call.prompt.startsWith("## Candidates"), "user slot must open with the candidate data header");
    assert.ok(
      !call.prompt.includes("You are a memory admission judge."),
      "identity/static block must not be concatenated into the user slot",
    );
  });
});
