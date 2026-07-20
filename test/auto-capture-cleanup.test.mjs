import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
  formatConversationTranscript,
  buildConversationTurnsForExtraction,
  trimTurnsToUserCap,
  dedupePairWindow,
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
// formatConversationTranscript
// ============================================================================

describe("formatConversationTranscript", () => {
  it("renders turns oldest-first, each wholly wrapped in speaker tags", () => {
    const turns = [
      { role: "user", text: "my name is Alex" },
      { role: "assistant", text: "nice to meet you, Alex" },
      { role: "user", text: "yes exactly, that one" },
    ];
    assert.equal(
      formatConversationTranscript(turns),
      "<user_message>\nmy name is Alex\n</user_message>\n"
        + "<assistant_message>\nnice to meet you, Alex\n</assistant_message>\n"
        + "<user_message>\nyes exactly, that one\n</user_message>",
    );
  });

  it("renders identically regardless of the configured user label (the name travels in the prompt header, not per turn)", () => {
    const turns = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    assert.equal(formatConversationTranscript(turns, "Alex"), formatConversationTranscript(turns));
  });

  it("returns an empty string for an empty turn list", () => {
    assert.equal(formatConversationTranscript([]), "");
  });
});

// ============================================================================
// buildConversationTurnsForExtraction — orthogonal to watermark
// counting: consumes already-computed eligibility/narrowing results, never
// recomputes them.
// ============================================================================

describe("buildConversationTurnsForExtraction (pair-shaped window)", () => {
  it("returns this call's message-loop turns unchanged when nothing was narrowed", () => {
    const messageLoopTurns = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
    ];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["u1", "u2"],
      newUserTexts: ["u1", "u2"],
    });
    assert.deepEqual(result, messageLoopTurns);
  });

  it("drops already-extracted leading user turns together with their pairs' assistant replies", () => {
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
    });
    assert.deepEqual(result, [{ role: "user", text: "new1" }]);
  });

  it("keeps assistant turns interleaved with kept user turns, dropping only consumed pairs", () => {
    const messageLoopTurns = [
      { role: "user", text: "old1" },
      { role: "assistant", text: "a-old" },
      { role: "user", text: "new1" },
      { role: "assistant", text: "a-new1" },
      { role: "user", text: "new2" },
      { role: "assistant", text: "a-new2" },
    ];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["old1", "new1", "new2"],
      newUserTexts: ["new1", "new2"],
    });
    assert.deepEqual(result, [
      { role: "user", text: "new1" },
      { role: "assistant", text: "a-new1" },
      { role: "user", text: "new2" },
      { role: "assistant", text: "a-new2" },
    ]);
  });

  it("falls back to flat user turns when newUserTexts did not come from a tail-slice of eligibleTexts (pending-ingress replay)", () => {
    const messageLoopTurns = [{ role: "user", text: "unrelated-this-call-text" }];
    const result = buildConversationTurnsForExtraction({
      messageLoopTurns,
      eligibleTexts: ["unrelated-this-call-text"],
      newUserTexts: ["replayed ingress text 1", "replayed ingress text 2"],
    });
    assert.deepEqual(result, [
      { role: "user", text: "replayed ingress text 1" },
      { role: "user", text: "replayed ingress text 2" },
    ]);
  });
});

describe("trimTurnsToUserCap (extractMinMessages as a window of pairs)", () => {
  const turns = [
    { role: "assistant", text: "a0" },
    { role: "user", text: "u1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "u2" },
    { role: "assistant", text: "a2" },
    { role: "user", text: "u3" },
    { role: "assistant", text: "a3" },
  ];

  it("keeps the newest N user turns with their interleaved assistant replies", () => {
    assert.deepEqual(trimTurnsToUserCap(turns, 2), [
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ]);
  });

  it("never leaves an orphan assistant turn ahead of the window's first user turn", () => {
    const trimmed = trimTurnsToUserCap(turns, 3);
    assert.deepEqual(trimmed[0], { role: "user", text: "u1" });
  });

  it("returns everything from the first user turn when the cap exceeds the user-turn count", () => {
    assert.deepEqual(trimTurnsToUserCap(turns, 10), turns.slice(1));
  });

  it("keeps single-pair windows to exactly the last pair", () => {
    assert.deepEqual(trimTurnsToUserCap(turns, 1), [
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ]);
  });
});

describe("dedupePairWindow (deferral double-include repair)", () => {
  it("collapses an identical re-included pair to its later copy (watermark-rollback signature)", () => {
    const turns = [
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "m3" },
      { role: "assistant", text: "r3" },
    ];
    assert.deepEqual(dedupePairWindow(turns), [
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "m3" },
      { role: "assistant", text: "r3" },
    ]);
  });

  it("drops a flat reply-less duplicate in favor of the pair-shaped copy (ingress-replay signature)", () => {
    const turns = [
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "m3" },
      { role: "assistant", text: "r3" },
      { role: "user", text: "m2" },
      { role: "user", text: "m3" },
    ];
    assert.deepEqual(dedupePairWindow(turns), [
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
      { role: "user", text: "m3" },
      { role: "assistant", text: "r3" },
    ]);
  });

  it("keeps a legitimately repeated user message whose assistant replies differ", () => {
    const turns = [
      { role: "user", text: "yes" },
      { role: "assistant", text: "first confirmation" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "second confirmation" },
    ];
    assert.deepEqual(dedupePairWindow(turns), turns);
  });

  it("prefers the pair-shaped copy even when the flat duplicate comes first", () => {
    const turns = [
      { role: "user", text: "m2" },
      { role: "user", text: "m3" },
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
    ];
    assert.deepEqual(dedupePairWindow(turns), [
      { role: "user", text: "m3" },
      { role: "user", text: "m2" },
      { role: "assistant", text: "r2" },
    ]);
  });

  it("collapses identical flat duplicates to the later copy", () => {
    const turns = [
      { role: "user", text: "m2" },
      { role: "user", text: "m3" },
      { role: "user", text: "m2" },
    ];
    assert.deepEqual(dedupePairWindow(turns), [
      { role: "user", text: "m3" },
      { role: "user", text: "m2" },
    ]);
  });

  it("passes windows without duplicated user texts through unchanged, including leading assistant turns", () => {
    const turns = [
      { role: "assistant", text: "a0" },
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
    ];
    assert.deepEqual(dedupePairWindow(turns), turns);
    assert.deepEqual(dedupePairWindow([]), []);
  });
});
