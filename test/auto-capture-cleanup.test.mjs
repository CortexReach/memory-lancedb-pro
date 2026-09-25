import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
  trimTurnsToUserCap,
  dedupePairWindow,
  turnsOlderThan,
  composePairWindow,
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

describe("overlapping captures: chronological pair-window composition", () => {
  const retainedNewer = [
    { role: "user", text: "u3", messageId: 5, contextOnly: true },
    { role: "assistant", text: "a3", messageId: 6, contextOnly: true },
  ];
  const ownOlder = [
    { role: "user", text: "u1", messageId: 1 },
    { role: "assistant", text: "a1", messageId: 2 },
    { role: "user", text: "u2", messageId: 3 },
  ];

  it("excludes retained turns newer than the capture's own from its transcript context", () => {
    assert.deepEqual(turnsOlderThan(retainedNewer, ownOlder), []);
    const retainedOlder = [{ role: "user", text: "u0", messageId: 0, contextOnly: true }];
    assert.deepEqual(turnsOlderThan([...retainedOlder, ...retainedNewer], ownOlder), retainedOlder);
    assert.deepEqual(turnsOlderThan(retainedNewer, []), retainedNewer);
  });

  it("orders a newer retained window behind the older capture's own turns instead of trimming it out", () => {
    const window = composePairWindow(retainedNewer, ownOlder, 2);
    assert.deepEqual(window.map((turn) => turn.text), ["u2", "u3", "a3"]);
  });

  it("keeps every own user turn under the cap and the newest pairs of the retained window", () => {
    const retainedOlder = [
      { role: "user", text: "u0", messageId: 0, contextOnly: true },
      { role: "assistant", text: "a0", messageId: 1, contextOnly: true },
    ];
    const own = [
      { role: "user", text: "u1", messageId: 2 },
      { role: "assistant", text: "a1", messageId: 3 },
      { role: "user", text: "u2", messageId: 4 },
    ];
    assert.deepEqual(composePairWindow(retainedOlder, own, 3).map((turn) => turn.text), ["u0", "a0", "u1", "a1", "u2"]);
    assert.deepEqual(composePairWindow(retainedOlder, own, 1).map((turn) => turn.text), ["u1", "a1", "u2"]);
  });

  it("keeps turns without a message id in their given order behind the identified ones", () => {
    const window = composePairWindow(
      [{ role: "user", text: "u9", messageId: 9, contextOnly: true }],
      [{ role: "user", text: "ux" }, { role: "assistant", text: "ax" }],
      4,
    );
    assert.deepEqual(window.map((turn) => turn.text), ["u9", "ux", "ax"]);
  });
});
