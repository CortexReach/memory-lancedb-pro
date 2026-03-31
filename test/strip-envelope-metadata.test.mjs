import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { stripEnvelopeMetadata } = jiti("../src/smart-extractor.ts");

describe("stripEnvelopeMetadata", () => {
  // -----------------------------------------------------------------------
  // Case 1: Full Feishu envelope → completely stripped
  // -----------------------------------------------------------------------
  it("strips a complete Feishu envelope including all metadata sections", () => {
    const input = [
      "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_a4b6b408 [msg:om_xxx]",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id": "om_xxx", "sender_id": "ou_xxx", "timestamp": "Mon 2026-03-18 14:21 GMT+8"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label": "ou_xxx", "id": "ou_xxx", "name": "Zhang Xiaofeng"}',
      "```",
      "",
      "Replied message (untrusted, for context):",
      "```json",
      '{"body": "some quoted text"}',
      "```",
      "",
      "用户说的实际内容在这里",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, "用户说的实际内容在这里");
  });

  // -----------------------------------------------------------------------
  // Case 2: Pure user conversation → preserved intact
  // -----------------------------------------------------------------------
  it("preserves pure user conversation without any modifications", () => {
    const input = [
      "User: 帮我查一下明天的天气",
      "Assistant: 好的，正在查询...",
      "User: 谢谢",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, input);
  });

  it("preserves user text containing JSON code blocks that are not envelope metadata", () => {
    const input = [
      "User: 这是我的配置文件：",
      "```json",
      '{"name": "my-project", "version": "1.0.0"}',
      "```",
      "请帮我检查一下",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, input);
  });

  it("preserves text mentioning System: without the timestamp pattern", () => {
    const input = "System: This is a general note, not an envelope header.";
    const result = stripEnvelopeMetadata(input);
    assert.equal(result, input);
  });

  // -----------------------------------------------------------------------
  // Case 3: Mixed content → only metadata stripped
  // -----------------------------------------------------------------------
  it("strips metadata but preserves interleaved user content", () => {
    const input = [
      "System: [2026-03-20 09:00:00 GMT+8] Feishu[default] Group | oc_xxx [msg:om_yyy]",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id": "om_yyy", "sender_id": "ou_abc"}',
      "```",
      "",
      "User: 我想创建一个新的多维表格",
      "Assistant: 好的，我来帮你创建。",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label": "ou_abc", "name": "Test User"}',
      "```",
      "",
      'User: 表格名称叫做"项目进度"',
    ].join("\n");

    const result = stripEnvelopeMetadata(input);

    // User content must be preserved
    assert.match(result, /我想创建一个新的多维表格/);
    assert.match(result, /好的，我来帮你创建/);
    assert.match(result, /表格名称叫做"项目进度"/);

    // Metadata must be removed
    assert.doesNotMatch(result, /System:\s*\[/);
    assert.doesNotMatch(result, /untrusted metadata/);
    assert.doesNotMatch(result, /message_id/);
    assert.doesNotMatch(result, /sender_id/);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  it("handles Telegram-style envelope headers", () => {
    const input = [
      "System: [2026-03-18 14:21:36 GMT+8] Telegram[bot123] DM | user_456 [msg:12345]",
      "",
      "用户发的消息",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, "用户发的消息");
  });

  it("strips standalone JSON blocks with message_id and sender_id", () => {
    const input = [
      "Some text before",
      "```json",
      '{"message_id": "om_xxx", "sender_id": "ou_yyy", "timestamp": "2026-03-18"}',
      "```",
      "Some text after",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.match(result, /Some text before/);
    assert.match(result, /Some text after/);
    assert.doesNotMatch(result, /message_id/);
  });

  it("collapses excessive blank lines after stripping", () => {
    const input = [
      "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_xxx [msg:om_xxx]",
      "",
      "",
      "",
      "",
      "实际内容",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, "实际内容");
    assert.ok(!result.includes("\n\n\n"), "should not contain 3+ consecutive newlines");
  });

  it("handles empty input", () => {
    assert.equal(stripEnvelopeMetadata(""), "");
  });

  it("handles input that is only metadata", () => {
    const input = [
      "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_xxx [msg:om_xxx]",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id": "om_xxx", "sender_id": "ou_xxx"}',
      "```",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.equal(result, "");
  });

  it("handles multiple System: lines (multi-turn with envelopes)", () => {
    const input = [
      "System: [2026-03-18 14:00:00 GMT+8] Feishu[default] DM | ou_xxx [msg:om_001]",
      "User: 第一条消息",
      "System: [2026-03-18 14:05:00 GMT+8] Feishu[default] DM | ou_xxx [msg:om_002]",
      "User: 第二条消息",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    assert.match(result, /第一条消息/);
    assert.match(result, /第二条消息/);
    assert.doesNotMatch(result, /System:\s*\[/);
  });

  it("does not strip JSON blocks that only have message_id but not sender_id", () => {
    const input = [
      "Here is the log:",
      "```json",
      '{"message_id": "om_xxx", "status": "delivered"}',
      "```",
    ].join("\n");

    const result = stripEnvelopeMetadata(input);
    // regex requires both message_id AND sender_id
    assert.match(result, /message_id/);
  });
});
