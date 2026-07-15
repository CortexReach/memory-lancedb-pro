import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
  formatConversationTranscript,
  buildConversationTurnsForExtraction,
} = jiti("../src/auto-capture-cleanup.ts");

describe("auto-capture cleanup", () => {
  it("preserves real content when wrapper lines are mixed with facts in the same payload", () => {
    const input = [
      "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
      "[Subagent Task] Reply with a brief acknowledgment only. Facts for automatic memory extraction quality test: 1) Shen prefers concise blunt status updates. 2) Project Orion deploy window is Friday 21:00 Asia/Shanghai. 3) If a database migration touches billing tables, require a dry run first. Do not use any memory tools.",
    ].join("\n");

    const result = normalizeAutoCaptureText("user", input);
    assert.equal(
      result,
      "Facts for automatic memory extraction quality test: 1) Shen prefers concise blunt status updates. 2) Project Orion deploy window is Friday 21:00 Asia/Shanghai. 3) If a database migration touches billing tables, require a dry run first.",
    );
  });

  it("drops wrapper-only payloads", () => {
    const input = [
      "[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester.",
      "[Subagent Task] Reply with a brief acknowledgment only.",
    ].join("\n");

    assert.equal(normalizeAutoCaptureText("user", input), null);
  });

  it("strips inbound metadata before preserving the remaining content", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"om_123","sender_id":"ou_456"}',
      "```",
      "",
      "[Subagent Task] Reply with a brief acknowledgment only. Actual user content starts here.",
    ].join("\n");

    assert.equal(
      stripAutoCaptureInjectedPrefix("user", input),
      "Actual user content starts here.",
    );
  });
});

// ============================================================================
// formatConversationTranscript (JR-184/185)
// ============================================================================

describe("formatConversationTranscript", () => {
  it("renders turns oldest-first as continuous User:/Assistant: line-groups with no blank lines between them", () => {
    const turns = [
      { role: "user", text: "my name is Alex" },
      { role: "assistant", text: "nice to meet you, Alex" },
      { role: "user", text: "yes exactly, that one" },
    ];
    assert.equal(
      formatConversationTranscript(turns),
      "User: my name is Alex\nAssistant: nice to meet you, Alex\nUser: yes exactly, that one",
    );
  });

  it("uses the configured user label in place of the generic 'User' label when provided", () => {
    const turns = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    assert.equal(
      formatConversationTranscript(turns, "Alex"),
      "Alex: hi\nAssistant: hello",
    );
  });

  it("falls back to the generic 'User' label when no name is configured", () => {
    const turns = [{ role: "user", text: "hi" }];
    assert.equal(formatConversationTranscript(turns), "User: hi");
  });

  it("returns an empty string for an empty turn list", () => {
    assert.equal(formatConversationTranscript([]), "");
  });
});

// ============================================================================
// buildConversationTurnsForExtraction (JR-184/185) — orthogonal to watermark
// counting: consumes already-computed eligibility/narrowing results, never
// recomputes them.
// ============================================================================

describe("buildConversationTurnsForExtraction", () => {
  it("returns this call's message-loop turns unchanged when nothing was narrowed and no context rolled over from a prior call", () => {
    const messageLoopTurns = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
    ];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["u1", "u2"],
      newUserTexts: ["u1", "u2"],
      assistantContextForRun: ["a1"],
      assistantContextTexts: ["a1"],
    });
    assert.deepEqual(result, messageLoopTurns);
  });

  it("drops already-extracted leading user turns (watermark narrowing) while keeping every assistant-context turn from this call", () => {
    const messageLoopTurns = [
      { role: "user", text: "old1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "old2" },
      { role: "user", text: "new1" },
    ];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["old1", "old2", "new1"],
      newUserTexts: ["new1"],
      assistantContextForRun: ["a1"],
      assistantContextTexts: ["a1"],
    });
    assert.deepEqual(result, [
      { role: "assistant", text: "a1" },
      { role: "user", text: "new1" },
    ]);
  });

  it("prepends assistant-context turns rolled over from before this call, ahead of this call's own turns", () => {
    const messageLoopTurns = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a2" },
    ];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["u1"],
      newUserTexts: ["u1"],
      assistantContextForRun: ["a1", "a2"],
      assistantContextTexts: ["a2"],
    });
    assert.deepEqual(result, [
      { role: "assistant", text: "a1" },
      { role: "user", text: "u1" },
      { role: "assistant", text: "a2" },
    ]);
  });

  it("falls back to flat user turns (plus any rolled-over assistant context) when newUserTexts did not come from a tail-slice of eligibleTexts (pending-ingress replay)", () => {
    const messageLoopTurns = [{ role: "user", text: "unrelated-this-call-text" }];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["unrelated-this-call-text"],
      newUserTexts: ["replayed ingress text 1", "replayed ingress text 2"],
      assistantContextForRun: ["a1"],
      assistantContextTexts: [],
    });
    assert.deepEqual(result, [
      { role: "assistant", text: "a1" },
      { role: "user", text: "replayed ingress text 1" },
      { role: "user", text: "replayed ingress text 2" },
    ]);
  });
});
