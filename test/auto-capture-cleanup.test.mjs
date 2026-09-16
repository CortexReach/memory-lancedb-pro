import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
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

describe("trimTurnsToUserCap (context window of pairs)", () => {
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

  it("keeps the newest turns instead of dropping everything when the window has no user anchor", () => {
    const assistantOnly = [
      { role: "assistant", text: "a1" },
      { role: "assistant", text: "a2" },
    ];
    assert.deepEqual(trimTurnsToUserCap(assistantOnly, 1), [
      { role: "assistant", text: "a2" },
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
