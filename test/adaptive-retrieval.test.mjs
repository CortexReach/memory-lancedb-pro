import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { shouldSkipRetrieval } = jiti("../src/adaptive-retrieval.ts");

describe("shouldSkipRetrieval", () => {
  // --- emoji regex fix ---
  describe("emoji regex should not match digits", () => {
    it("does not skip pure digit strings", () => {
      assert.equal(shouldSkipRetrieval("12345"), false);
    });

    it("does not skip port numbers", () => {
      assert.equal(shouldSkipRetrieval("8080"), false);
    });

    it("does not skip hash-prefixed numbers", () => {
      assert.equal(shouldSkipRetrieval("#123"), false);
    });

    it("skips pure emoji input", () => {
      assert.equal(shouldSkipRetrieval("\ud83d\udc4d\ud83c\udf89\ud83d\ude80"), true);
    });

    it("does not skip emoji mixed with text", () => {
      assert.equal(shouldSkipRetrieval("\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 family trip plan"), false);
    });
  });

  // --- slash command regex fix ---
  describe("slash command regex should not match file paths", () => {
    it("skips single-word slash commands", () => {
      assert.equal(shouldSkipRetrieval("/help"), true);
    });

    it("skips slash command with trailing space", () => {
      assert.equal(shouldSkipRetrieval("/recall "), true);
    });

    it("does not skip file paths", () => {
      assert.equal(shouldSkipRetrieval("/usr/bin/node"), false);
    });

    it("does not skip path with question", () => {
      assert.equal(shouldSkipRetrieval("/etc/nginx/nginx.conf \u600e\u4e48\u914d\u7f6e"), false);
    });

    it("does not skip API paths", () => {
      assert.equal(shouldSkipRetrieval("/api/v2/users"), false);
    });
  });

  // --- CJK short text threshold fix ---
  describe("CJK short text should not be killed by hard threshold", () => {
    it("does not skip 4-char CJK query", () => {
      assert.equal(shouldSkipRetrieval("\u4ed6\u559c\u6b22\u732b"), false);
    });

    it("does not skip 4-char CJK query (residence)", () => {
      assert.equal(shouldSkipRetrieval("\u6211\u4f4f\u5317\u4eac"), false);
    });

    it("does not skip 3-char mixed CJK query", () => {
      assert.equal(shouldSkipRetrieval("\u7528Go\u5199"), false);
    });

    it("does not skip CJK query with question mark", () => {
      assert.equal(shouldSkipRetrieval("\u5bc6\u7801\u662f\u5565\uff1f"), false);
    });

    it("skips single CJK character", () => {
      assert.equal(shouldSkipRetrieval("\u597d"), true);
    });
  });

  // --- existing behavior preserved ---
  describe("existing skip/force behavior preserved", () => {
    it("skips greetings", () => {
      assert.equal(shouldSkipRetrieval("hi"), true);
    });

    it("skips short English affirmations", () => {
      assert.equal(shouldSkipRetrieval("ok"), true);
    });

    it("does not skip memory-related queries (English)", () => {
      assert.equal(shouldSkipRetrieval("remember my name is Alice"), false);
    });

    it("does not skip memory-related queries (Chinese)", () => {
      assert.equal(shouldSkipRetrieval("\u4f60\u8bb0\u5f97\u5417"), false);
    });

    it("does not skip normal length queries", () => {
      assert.equal(shouldSkipRetrieval("what was the database schema we discussed"), false);
    });
  });
});
