import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { isRecallUsed } = jiti("../src/reflection-slices.ts");

describe("isRecallUsed", () => {
  // =======================================================================
  // Guard: short / empty responseText → false
  // =======================================================================
  describe("rejects short or empty responseText", () => {
    const shortTexts = [
      { text: "",        expected: false },
      { text: "ok",      expected: false, note: "2 chars" },
      { text: "好",      expected: false, note: "1 char" },
      { text: "yes",     expected: false, note: "3 chars" },
      { text: "不知道",  expected: false, note: "3 chars" },
      { text: "xxxxxxxxxxxxxxxxxxxx", expected: false, note: "20 chars — below 24-char threshold" },
    ];

    for (const { text, expected } of shortTexts) {
      it(`length=${text.length} → ${expected}`, () => {
        assert.equal(isRecallUsed(text, ["abc1234567890"]), expected);
      });
    }
  });

  // =======================================================================
  // Guard: empty / falsy injectedIds → false
  // =======================================================================
  describe("rejects empty or falsy injectedIds", () => {
    const cases = [
      { ids: [],       label: "empty array" },
      { ids: undefined, label: "undefined"  },
      { ids: null,     label: "null"         },
    ];

    for (const { ids, label } of cases) {
      it(`injectedIds=${label} → false`, () => {
        const longText = "remember when we discussed this project last time. Here are the details...";
        assert.equal(isRecallUsed(longText, ids), false);
      });
    }
  });

  // =======================================================================
  // English usage markers (all > 24 chars)
  // =======================================================================
  describe("detects English usage markers", () => {
    const markers = [
      "remember",
      "According to",   // case-insensitive
      "AS YOU MENTIONED", // case-insensitive uppercase
      "according to",
      "based on what",
      "as you mentioned",
      "in the memory",
      "the memory mentioned",
      "the memories show",
      "from previous",
      "earlier you",
    ];

    for (const marker of markers) {
      it(`"${marker}"`, () => {
        // Must be > 24 chars to pass the length guard
        const text = `Sure, ${marker} our discussion. Here are the full details of the plan.`;
        assert.ok(text.length > 24, `Text length ${text.length} must be > 24`);
        assert.equal(isRecallUsed(text, ["abc12345"]), true);
      });
    }
  });

  // =======================================================================
  // Chinese usage markers (Simplified + Traditional — both in actual markers list)
  // =======================================================================
  describe("detects Chinese usage markers (Simplified + Traditional — both in markers list)", () => {
    const markers = [
      // Simplified
      "之前",
      "记得",
      "如前所述",
      "如您所说的",
      "我记得",
      "之前提到的",
      "之前你说",
      "根据之前",
      "依据之前",
      "按照之前",
      "照你说的",
      "照您之前",
      // Traditional
      "如您所說",
      "我記得",
      "之前你說",
      // NOTE: "記得" (standalone, Traditional) is NOT in the markers list
      // Only "我记得" and "我記得" (with subject prefix) are present
    ];

    for (const marker of markers) {
      it(`"${marker}"`, () => {
        // Text must be > 24 chars; append filler to ensure sufficient length
        const base = `${marker}，我们讨论过这个问题。`;
        const filler = "这是额外的填充文字用来确保总长度超过24个字符的要求。";
        const text = base + filler;
        assert.ok(text.length > 24, `Text length ${text.length} must be > 24`);
        assert.equal(isRecallUsed(text, ["abc12345"]), true);
      });
    }
  });

  // =======================================================================
  // Negative: no usage markers present → false
  // =======================================================================
  describe("returns false when no usage markers present", () => {
    // These texts are all > 24 chars and contain no usage markers
    const noMarkerTexts = [
      "The API endpoint is /v1/embeddings. It accepts POST requests with a JSON body.",
      "I think we should use JSON for the response format. Let me know if that works.",
      "Let me check the documentation and get back to you with a more detailed response.",
      "Sure, I can help with that task. Here's what I suggest based on common patterns.",
      "This is a general response with no specific memory reference. Just practical advice.",
    ];

    for (const text of noMarkerTexts) {
      it(`"${text.substring(0, 50)}..."`, () => {
        assert.ok(text.length > 24);
        assert.equal(isRecallUsed(text, ["abc1234567890"]), false);
      });
    }
  });

  // =======================================================================
  // Boundary: length threshold is > 24
  // =======================================================================
  describe("boundary: length threshold is > 24 chars", () => {
    it("exactly 24 chars → false (hits length guard)", () => {
      const text = "according to memory!!xxx"; // 24 chars exactly
      assert.equal(text.length, 24);
      assert.equal(isRecallUsed(text, ["abc1234567890"]), false);
    });

    it("25 chars with marker → true", () => {
      const text = "according to memory!!xxxx"; // 25 chars, has "according to"
      assert.equal(text.length, 25);
      assert.equal(isRecallUsed(text, ["abc1234567890"]), true);
    });

    it("25 chars without marker → false", () => {
      const t = "This is a helpful answer."; // 25 chars, no usage marker
      assert.equal(t.length, 25, `Expected 25, got ${t.length}`);
      assert.equal(isRecallUsed(t, ["abc1234567890"]), false);
    });
  });

  // =======================================================================
  // Realistic full-turn scenarios
  // =======================================================================
  describe("realistic full-turn scenarios", () => {
    it("detects recall in an agent response (Simplified Chinese)", () => {
      const response =
        "当然记得！你之前说想要用 PostgreSQL 当主要数据库。根据之前的讨论，我建议我们采用连接池的方式来优化查询性能。";
      assert.ok(response.length > 24);
      assert.equal(isRecallUsed(response, ["a1b2c3d4e5f6"]), true);
    });

    it("detects recall in an agent response (Traditional Chinese)", () => {
      const response =
        "當然記得！你之前說想要用 PostgreSQL 當主要資料庫。根據之前的討論，我建議我們採用連接池的方式來優化查詢效能。";
      assert.ok(response.length > 24);
      assert.equal(isRecallUsed(response, ["a1b2c3d4e5f6"]), true);
    });

    it("does not detect recall in a generic technical response", () => {
      const response =
        "这个问题的解决方案是使用 REST API 配合 JSON 格式。我会使用 Express.js 配合 PostgreSQL 数据库来构建后端服务。";
      assert.ok(response.length > 24);
      assert.equal(isRecallUsed(response, ["a1b2c3d4e5f6"]), false);
    });

    it("handles long response with marker at the end", () => {
      const filler = "这是一些额外的内容用来增加文本长度。" + "更多内容来确保超过24字符的阈值。" + "继续添加更多文字。".repeat(5);
      const text = "这个问题可以从多个角度来分析。" + filler + "综上所述，根据之前确定的方案，我们继续执行。";
      assert.ok(text.length > 24);
      assert.equal(isRecallUsed(text, ["abc123"]), true);
    });

    it("handles long response without any marker", () => {
      const text = ("这是一个测试场景的回复内容。" + "我们从技术角度来分析这个问题。" + "采用标准的解决方案。").repeat(8);
      assert.ok(text.length > 24);
      assert.equal(isRecallUsed(text, ["abc123"]), false);
    });
  });
});
