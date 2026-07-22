/**
 * Tag-structured reflection distiller input.
 *
 * The distiller's INPUT block used to render the session as `role: text`
 * lines inside a code fence. Any code block inside the conversation
 * terminated that fence early and leaked the rest of the transcript out of
 * the input frame, and mid-message clipping could open the INPUT with a
 * headless half message. Session messages now render as <user_message>/
 * <assistant_message> blocks (the extraction lane's transcript grammar),
 * unfenced, with clipping snapped to whole tagged blocks.
 *
 * Stored session-summary rows keep the legacy labeled `role: text` shape via
 * an explicit format switch: a stored row must never carry literal speaker
 * tags that a later recall could replay into a prompt as fake transcript
 * structure.
 *
 * Fixtures are synthetic.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildReflectionPrompt, readSessionConversationWithResetFallback } = jiti("../index.ts");

const TAGGED_CONVERSATION =
  "<user_message>\nhello there\n</user_message>\n<assistant_message>\nhi, noted\n</assistant_message>";

describe("buildReflectionPrompt tagged INPUT", () => {
  it("teaches the tag grammar up front", () => {
    const prompt = buildReflectionPrompt(TAGGED_CONVERSATION, 4000, []);
    assert.ok(prompt.includes("The INPUT transcript is a sequence of tagged blocks in chronological order:"));
    assert.ok(prompt.includes("- <user_message>...</user_message> wraps ONE message written by the human user."));
    assert.ok(prompt.includes("- <assistant_message>...</assistant_message> wraps ONE message written by the AI assistant."));
  });

  it("carries the transcript unfenced at the tail (a fence would break on any code block inside the conversation)", () => {
    const prompt = buildReflectionPrompt(TAGGED_CONVERSATION, 4000, []);
    assert.ok(prompt.endsWith(`INPUT:\n${TAGGED_CONVERSATION}`), "the tagged transcript must ride unfenced at the tail");
    assert.ok(!prompt.includes("INPUT:\n```"), "no code fence may wrap the transcript");
  });

  it("keeps a fenced code block INSIDE a message intact within its tags", () => {
    const withCode =
      "<user_message>\nhere is my snippet:\n```js\nconst a = 1;\n```\ndoes it look right?\n</user_message>";
    const prompt = buildReflectionPrompt(withCode, 4000, []);
    assert.ok(prompt.endsWith("does it look right?\n</user_message>"));
    assert.ok(prompt.includes("```js\nconst a = 1;\n```"), "inner fences ride safely inside the tags");
  });

  it("snaps an over-limit clip to the next whole tagged block, never a headless half message", () => {
    const transcript =
      `<user_message>\n${"a".repeat(120)}\n</user_message>\n<assistant_message>\nkeep this tail reply\n</assistant_message>`;
    const prompt = buildReflectionPrompt(transcript, 70, []);
    assert.ok(prompt.includes("INPUT:\n<assistant_message>"), "the clipped transcript must open at a block boundary");
    assert.ok(!prompt.includes("aaaa"), "the sliced-away user block must not bleed in headless");
  });
});

describe("session conversation formats", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflection-tagged-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeSessionFile(name = "session.jsonl") {
    const sessionPath = path.join(workDir, name);
    const lines = [
      { type: "message", message: { role: "user", content: "I switched the standup to Tuesdays" } },
      { type: "message", message: { role: "assistant", content: "Noted: standup moves to Tuesdays." } },
    ];
    writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n"));
    return sessionPath;
  }

  it("renders the distiller input as tagged blocks by default", async () => {
    const sessionPath = writeSessionFile();
    const conversation = await readSessionConversationWithResetFallback(sessionPath, 10);
    assert.equal(
      conversation,
      "<user_message>\nI switched the standup to Tuesdays\n</user_message>\n"
        + "<assistant_message>\nNoted: standup moves to Tuesdays.\n</assistant_message>",
    );
  });

  it("keeps the labeled role-colon shape for stored artifacts via the explicit format switch", async () => {
    const sessionPath = writeSessionFile();
    const conversation = await readSessionConversationWithResetFallback(sessionPath, 10, "labeled");
    assert.equal(
      conversation,
      "user: I switched the standup to Tuesdays\nassistant: Noted: standup moves to Tuesdays.",
    );
    assert.ok(!conversation.includes("<user_message>"), "stored artifacts must never carry literal speaker tags");
  });
});
