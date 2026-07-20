/**
 * Speaker-tagged extraction transcript.
 *
 * Motivating failure: with "User:"/"Assistant:" line prefixes, only the FIRST
 * line of a multi-paragraph assistant reply carried a speaker marker; every
 * later paragraph floated unmarked, and the extractor attributed
 * assistant-authored plans/preferences to the user and stored them. Wrapping
 * each message wholly in <user_message>/<assistant_message> tags gives every
 * line an unambiguous owner, the prompt teaches the format up front, and the
 * context-only rule pins assistant blocks to disambiguation use.
 *
 * Fixtures are synthetic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { formatConversationTranscript, trimTranscriptToTagBoundary } = jiti(
  "../src/auto-capture-cleanup.ts",
);
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");

const MULTI_PARAGRAPH_REPLY = [
  "That framing helps a lot.",
  "",
  "**What clicks for me now:**",
  "- Automatic capture handles the routine details",
  "- Manual notes are only for the rare big items",
  "",
  "So the shift is: trust the background capture and stop writing everything down.",
].join("\n");

describe("formatConversationTranscript speaker tags", () => {
  it("wraps each message wholly in speaker tags with no bare role prefixes", () => {
    const transcript = formatConversationTranscript(
      [
        { role: "user", text: "I moved the standup to 9am on Tuesdays" },
        { role: "assistant", text: "Got it, Tuesday 9am it is." },
      ],
      "User",
    );
    assert.equal(
      transcript,
      "<user_message>\nI moved the standup to 9am on Tuesdays\n</user_message>\n"
        + "<assistant_message>\nGot it, Tuesday 9am it is.\n</assistant_message>",
    );
    assert.ok(!/^(User|Assistant): /m.test(transcript), "no legacy speaker prefixes may remain");
  });

  it("keeps a multi-paragraph assistant reply inside ONE tag pair closing after the last paragraph", () => {
    const transcript = formatConversationTranscript(
      [
        { role: "user", text: "here is how the memory layers work for you" },
        { role: "assistant", text: MULTI_PARAGRAPH_REPLY },
      ],
      "User",
    );
    assert.equal(transcript.split("<assistant_message>").length - 1, 1);
    assert.equal(transcript.split("</assistant_message>").length - 1, 1);
    const close = transcript.indexOf("</assistant_message>");
    const lastParagraph = transcript.indexOf("stop writing everything down");
    assert.ok(
      lastParagraph >= 0 && lastParagraph < close,
      "every paragraph must sit inside the assistant tags",
    );
  });

  it("preserves chronological ordering across alternating turns", () => {
    const transcript = formatConversationTranscript(
      [
        { role: "user", text: "first message" },
        { role: "assistant", text: "second message" },
        { role: "user", text: "third message" },
      ],
      "User",
    );
    assert.ok(
      transcript.indexOf("first message") < transcript.indexOf("second message")
        && transcript.indexOf("second message") < transcript.indexOf("third message"),
    );
  });
});

describe("trimTranscriptToTagBoundary", () => {
  it("returns transcripts within the limit unchanged", () => {
    const transcript = "<user_message>\nhi\n</user_message>";
    assert.equal(trimTranscriptToTagBoundary(transcript, 8000), transcript);
  });

  it("snaps an over-limit transcript to the next opening tag so no half message leads", () => {
    const turns = [];
    for (let i = 0; i < 40; i++) {
      turns.push({ role: "user", text: `user note number ${i} ${"x".repeat(80)}` });
      turns.push({ role: "assistant", text: `assistant reply number ${i} ${"y".repeat(80)}` });
    }
    const transcript = formatConversationTranscript(turns, "User");
    const trimmed = trimTranscriptToTagBoundary(transcript, 1500);
    assert.ok(trimmed.length <= 1500);
    assert.ok(
      trimmed.startsWith("<user_message>") || trimmed.startsWith("<assistant_message>"),
      `trimmed transcript must start at a tag boundary, got: ${trimmed.slice(0, 40)}`,
    );
  });

  it("falls back to the raw tail when no tag boundary survives the slice", () => {
    const untagged = "z".repeat(5000);
    assert.equal(trimTranscriptToTagBoundary(untagged, 1000), "z".repeat(1000));
  });
});

describe("buildExtractionPrompt speaker teaching", () => {
  const transcript = formatConversationTranscript(
    [
      { role: "user", text: "the deploy window moved to Friday" },
      { role: "assistant", text: MULTI_PARAGRAPH_REPLY },
    ],
    "User",
  );

  it("teaches the tag format before the conversation and embeds the tagged transcript", () => {
    const prompt = buildExtractionPrompt(transcript, "User");
    const format = prompt.indexOf("## Transcript format");
    const conversation = prompt.indexOf("## Recent conversation turns");
    assert.ok(format >= 0, "prompt must teach the transcript format");
    assert.ok(conversation > format, "format teaching must precede the conversation section");
    assert.ok(prompt.indexOf(transcript) > conversation, "tagged transcript embeds under the conversation header");
    assert.ok(!prompt.includes('"Assistant:" lines'), "legacy prefix vocabulary must be gone");
  });

  it("pins assistant blocks to disambiguation-only context in the default mode", () => {
    const prompt = buildExtractionPrompt(transcript, "User");
    assert.ok(prompt.includes("context ONLY, never a source"));
    assert.ok(prompt.includes("ONLY to resolve what an ambiguous or obscure <user_message> refers to"));
    assert.ok(prompt.includes("never attribute them to the user"));
    assert.ok(!prompt.includes("eligible sources in this configuration"));
  });

  it("keeps the eligible variant when assistantEligible is true, in tag vocabulary", () => {
    const prompt = buildExtractionPrompt(transcript, "User", { assistantEligible: true });
    assert.ok(prompt.includes("<assistant_message> blocks: eligible sources in this configuration"));
    assert.ok(prompt.includes("ground it in the <user_message>"));
    assert.ok(!prompt.includes("context ONLY, never a source"));
  });
});
