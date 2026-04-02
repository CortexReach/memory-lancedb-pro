import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  normalizeAutoCaptureText,
  stripAutoCaptureInjectedPrefix,
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
