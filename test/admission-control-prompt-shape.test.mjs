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

// A conversation excerpt containing a marker that must never reach the
// admission judge: the operator decision is that admission scores candidates
// solely on what extraction provided, never on raw transcript text.
const TRANSCRIPT_MARKER = "TRANSCRIPT_MARKER_ZZZ_do_not_leak_into_admission_prompt";
const TRANSCRIPT_TEXT = `user: hey can you remember that I like ${TRANSCRIPT_MARKER}\nassistant: sure thing`;

describe("AdmissionController prompt shape: transcript-free", () => {
  it("standalone (evaluate): the utility prompt never contains the conversation excerpt", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") {
          capturedPrompt = prompt;
        }
        return { utility: 0.5, reason: "r" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluate({
      candidate: makeCandidate(1),
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: TRANSCRIPT_TEXT,
      scopeFilter: ["global"],
    });

    assert.ok(capturedPrompt, "expected a standalone admission-utility call");
    assert.doesNotMatch(capturedPrompt, new RegExp(TRANSCRIPT_MARKER));
    assert.doesNotMatch(capturedPrompt, /Conversation excerpt/i);
  });

  it("batch (evaluateBatch): the utility prompt never contains the conversation excerpt", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      {
        candidate: makeCandidate(1),
        candidateVector: [0.1, 0.2, 0.3],
        conversationText: TRANSCRIPT_TEXT,
        scopeFilter: ["global"],
      },
    ]);

    assert.ok(capturedPrompt, "expected a batch admission-utility call");
    assert.doesNotMatch(capturedPrompt, new RegExp(TRANSCRIPT_MARKER));
    assert.doesNotMatch(capturedPrompt, /Conversation excerpt/i);
  });

  it("standalone and batch prompts carry only the candidate's own three-level content plus category, nothing else source-related", async () => {
    // Guards against a *different* leak channel (a "source context" or
    // "session excerpt" field added later, not the conversationText param).
    const candidate = makeCandidate(7);
    let standalonePrompt;
    let batchPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") standalonePrompt = prompt;
        if (label === "admission-utility-batch") {
          batchPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return { utility: 0.5, reason: "r" };
      },
    };

    const standaloneController = new AdmissionController(
      makeStore(),
      llm,
      normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" }),
    );
    await standaloneController.evaluate({
      candidate,
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: TRANSCRIPT_TEXT,
      scopeFilter: ["global"],
    });

    const batchController = new AdmissionController(
      makeStore(),
      llm,
      normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" }),
    );
    await batchController.evaluateBatch([
      { candidate, candidateVector: [0.1, 0.2, 0.3], conversationText: TRANSCRIPT_TEXT, scopeFilter: ["global"] },
    ]);

    for (const prompt of [standalonePrompt, batchPrompt]) {
      assert.ok(prompt);
      assert.match(prompt, /candidate 7/);
      assert.match(prompt, /## Event 7/);
      assert.match(prompt, /the user did thing 7/);
      assert.doesNotMatch(prompt, /user:|assistant:/);
    }
  });
});

describe("AdmissionController prompt shape: batch formatting standard", () => {
  it("separates candidates in the live batch with a blank line, not a bare newline", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return {
            results: [
              { index: 1, utility: 0.5, reason: "r1" },
              { index: 2, utility: 0.5, reason: "r2" },
            ],
          };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(1), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
      { candidate: makeCandidate(2), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    // Candidate 1's last field (Content) must be followed by a blank line
    // before candidate 2's numbered heading, not run together with a single \n.
    assert.match(capturedPrompt, /the user did thing 1\n\n### 2\. events/);
  });

  it("renders each candidate's multi-line fields as plain flush-left lines under its numbered heading", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(9), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    assert.match(capturedPrompt, /^### 1\. events$/m);
    assert.match(capturedPrompt, /^Abstract: candidate 9$/m);
    assert.match(capturedPrompt, /^Overview: ## Event 9$/m);
    assert.match(capturedPrompt, /^Content: the user did thing 9$/m);
  });

  it("separates the few-shot example's own logical blocks (header, each candidate, response, closing note) with blank lines", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(_prompt, label, systemPrompt) {
        if (label === "admission-utility-batch") {
          capturedPrompt = systemPrompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(1), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    // "## Candidates" header separated by a blank line from the first example candidate.
    assert.match(capturedPrompt, /## Candidates\n\n### 1\. preferences/);
    // Blank line between each example candidate (last field line, then blank, then next heading).
    assert.match(capturedPrompt, /\n\n### 2\. events/);
    assert.match(capturedPrompt, /\n\n### 3\. entities/);
    // Blank line between the last example candidate and the "Example response:" label.
    assert.match(capturedPrompt, /\n\nExample response:/);
    // Blank line between the bare example response JSON and the closing explanatory note.
    assert.match(capturedPrompt, /\}\n\nCandidate 2 scores low/);
  });

  it("emits the few-shot example through the live candidate formatter (same markdown block shape)", async () => {
    let capturedPrompt;
    let capturedUser;
    const llm = {
      async completeJson(prompt, label, systemPrompt) {
        if (label === "admission-utility-batch") {
          capturedPrompt = systemPrompt;
          capturedUser = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(1), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    // Each example candidate carries the exact live block shape: a `### N.
    // category` heading, then flush-left Abstract/Overview/Content lines.
    assert.match(capturedPrompt, /### 1\. preferences\nAbstract: User's preferred name is Alex\nOverview: /);
    assert.match(capturedPrompt, /### 2\. events\nAbstract: User said hello\nOverview: /);
    assert.match(
      capturedPrompt,
      /### 3\. entities\nAbstract: The project uses PostgreSQL as its primary datastore\nOverview: /,
    );
    // A number must never sit alone on its own line, in the example or anywhere else.
    assert.doesNotMatch(capturedPrompt, /^\d+\.\s*$/m);
    assert.doesNotMatch(capturedUser, /^\d+\.\s*$/m);
  });
});

describe("AdmissionController prompt shape: candidate blocks carry no markdown list markers", () => {
  // A stored row whose overview/content themselves contain markdown bullet
  // lists (the common "## Entity\n- Name: ..." overview convention). The
  // formatter must strip the leading list markers while keeping each line's
  // own indentation, and keep every continuation line under the candidate
  // so the section survives rendering intact.
  function makeBulletedCandidate() {
    return {
      category: "entities",
      abstract: "Sample is the team's build agent",
      overview: "## Entity\n- Name: Sample\n- Role: build agent\n  - Scope: CI only",
      content:
        "The user described Sample as their build agent.\n* Mentioned during a routing test\n- - Doubled marker line",
    };
  }

  function assertCandidateSectionClean(prompt, header) {
    const sectionStart = prompt.lastIndexOf(header);
    assert.ok(sectionStart >= 0, `expected a "${header}" section`);
    const section = prompt.slice(sectionStart);
    for (const line of section.split("\n")) {
      assert.doesNotMatch(line, /^\s*[-*] /, `list-marker line leaked into the candidate section: ${JSON.stringify(line)}`);
    }
    return section;
  }

  it("batch: strips content-carried bullet markers, keeps indentation and grouping", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeBulletedCandidate(), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    const section = assertCandidateSectionClean(capturedPrompt, "## Candidates");
    // First line: markdown heading with the number and category.
    assert.match(section, /^### 1\. entities$/m);
    // Multi-line field value: marker stripped, flush-left under the heading.
    assert.match(section, /^Overview: ## Entity$/m);
    assert.match(section, /^Name: Sample$/m);
    assert.match(section, /^Role: build agent$/m);
    // Nested bullet keeps its own inner indentation after the marker is stripped.
    assert.match(section, /^ {2}Scope: CI only$/m);
    // Star markers are stripped too.
    assert.match(section, /^Mentioned during a routing test$/m);
    // Doubled/mixed markers ("- - x", "* - y") must not leave a residual marker behind.
    assert.match(section, /^Doubled marker line$/m);
    // Non-list markdown (the heading) is left alone.
    assert.match(section, /## Entity/);
  });

  it("standalone (evaluate): emits the same markdown block shape with no dash-bulleted fields", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") capturedPrompt = prompt;
        return { utility: 0.5, reason: "r" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluate({
      candidate: makeBulletedCandidate(),
      candidateVector: [0.1],
      conversationText: "x",
      scopeFilter: ["global"],
    });

    assert.ok(capturedPrompt, "expected a standalone admission-utility call");
    const section = assertCandidateSectionClean(capturedPrompt, "## Candidate\n");
    // Same block shape as the batch path: `### N. category` heading, flush-left fields.
    assert.match(section, /^### 1\. entities$/m);
    assert.match(section, /^Abstract: Sample is the team's build agent$/m);
    assert.match(section, /^Overview: ## Entity$/m);
    assert.match(section, /^Name: Sample$/m);
    assert.match(section, /^Content: The user described Sample as their build agent\.$/m);
    assert.doesNotMatch(capturedPrompt, /^- Category:/m);
    assert.doesNotMatch(capturedPrompt, /^\d+\.\s*$/m);
  });

  it("reflection-lane shaped candidate (mapped-row conventions) gets the same clean block through evaluate", async () => {
    // Reflection-mapped rows reach admission through the same controller
    // evaluate/evaluateBatch surface (no separate prompt builder), so the
    // controller-layer shape guarantee is what keeps that lane clean too.
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") capturedPrompt = prompt;
        return { utility: 0.5, reason: "r" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluate({
      candidate: {
        category: "cases",
        abstract: "Decision: adopt PostgreSQL for the storage layer",
        overview: "## Decision\n- Choice: PostgreSQL\n- Rationale: relational fit",
        content: "The team decided to adopt PostgreSQL for the storage layer.",
      },
      candidateVector: [0.1],
      conversationText: "x",
      scopeFilter: ["global"],
    });

    assert.ok(capturedPrompt);
    const section = assertCandidateSectionClean(capturedPrompt, "## Candidate\n");
    assert.match(section, /^### 1\. cases$/m);
    assert.match(section, /^Choice: PostgreSQL$/m);
    assert.match(section, /^Rationale: relational fit$/m);
  });

  it("batch: keeps blank-line separation between bulleted-content candidates", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return {
            results: [
              { index: 1, utility: 0.5, reason: "r1" },
              { index: 2, utility: 0.5, reason: "r2" },
            ],
          };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeBulletedCandidate(), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
      { candidate: makeCandidate(2), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    // Candidate 1's last content line, a blank line, then candidate 2's heading.
    assert.match(capturedPrompt, /^Doubled marker line\n\n### 2\. events$/m);
  });
});

// Prompt-architecture slot conformance for the batched prompts: every static
// block (identity, taxonomy, task framing, rules, few-shot examples, the JSON
// output contract) lives in the SYSTEM slot; the USER slot carries only the
// numbered candidate/job blocks and other per-call data. These tests pin the
// builder-level split; the call sites submit the two slots through
// completeJson's system parameter, pinned by the transport-slot tests in
// admission-control-batch-utility.test.mjs and
// smart-extractor-batch-admission.test.mjs.
describe("batched prompt slot conformance (system = static, user = per-call data)", () => {
  const { buildBatchUtilityPrompt } = jiti("../src/admission-control.ts");
  const { buildBatchDedupPrompt, buildBatchMergePrompt } = jiti("../src/extraction-prompts.ts");

  function assertSlotSplit({ system, user }, { staticSentinels, userOpener }) {
    for (const sentinel of staticSentinels) {
      assert.ok(system.includes(sentinel), `system must carry static sentinel: ${sentinel}`);
      assert.ok(!user.includes(sentinel), `user must NOT carry static sentinel: ${sentinel}`);
    }
    assert.ok(user.startsWith(userOpener), `user must open with the data header ${JSON.stringify(userOpener)}`);
  }

  it("admission-utility-batch: identity, taxonomy, scoring rules, few-shot example, and output contract are system-only", () => {
    const prompt = buildBatchUtilityPrompt([makeCandidate(1), makeCandidate(2)]);
    assertSlotSplit(prompt, {
      staticSentinels: [
        "You are a memory admission judge.",
        "The memory system stores six categories:",
        "Score each candidate's future usefulness independently",
        "--- EXAMPLE (not your current batch) ---",
        "Return JSON only (the raw object, no markdown code fences), with exactly one entry per candidate",
      ],
      userOpener: "## Candidates",
    });
    assert.match(prompt.user, /### 1\. events/);
    assert.match(prompt.user, /### 2\. events/);
  });

  it("dedup-decision-batch: identity, taxonomy, verdict vocabulary, rules, and output contract are system-only", () => {
    const prompt = buildBatchDedupPrompt([
      { candidate: makeCandidate(1), existingMemories: "1. [preferences] existing memory one" },
    ]);
    assertSlotSplit(prompt, {
      staticSentinels: [
        "You are a memory dedup judge.",
        "The memory system stores six categories:",
        "- SKIP: Candidate memory duplicates existing memories",
        "IMPORTANT:",
        "Return JSON only (the raw object, no markdown code fences), with exactly one entry per candidate",
      ],
      userOpener: "## Candidates",
    });
    assert.match(prompt.user, /### 1\. events/);
    assert.ok(prompt.user.includes("existing memory one"), "per-candidate neighbor lists are per-call data and belong in user");
    assert.ok(!prompt.system.includes("existing memory one"));
  });

  it("merge-memory-batch: identity, taxonomy, merge requirements, and output contract are system-only", () => {
    const prompt = buildBatchMergePrompt([
      {
        category: "preferences",
        existing: { abstract: "existing abstract", overview: "existing overview", content: "existing content" },
        additions: [{ abstract: "new abstract", overview: "new overview", content: "new content" }],
      },
    ]);
    assertSlotSplit(prompt, {
      staticSentinels: [
        "You are a memory merge writer.",
        "The memory system stores six categories:",
        "Requirements:",
        "Return JSON only (the raw object, no markdown code fences), with exactly one entry per job",
      ],
      userOpener: "## Merge jobs",
    });
    assert.ok(prompt.user.includes("existing abstract"));
    assert.ok(prompt.user.includes("new content"));
    assert.ok(!prompt.system.includes("existing abstract"), "job payloads must never leak into system");
  });
});
