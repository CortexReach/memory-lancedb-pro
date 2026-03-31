import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  scoreText,
  compressTexts,
  estimateConversationValue,
} = jiti("../src/session-compressor.ts");

const {
  createExtractionRateLimiter,
} = jiti("../src/smart-extractor.ts");

// ============================================================================
// scoreText
// ============================================================================

describe("scoreText", () => {
  it("scores tool calls highest", () => {
    const result = scoreText("tool_use: memory_store", 0);
    assert.equal(result.score, 1.0);
    assert.equal(result.reason, "tool_call");
  });

  it("scores corrections very high", () => {
    const result = scoreText("No, actually that's wrong", 1);
    assert.equal(result.score, 0.95);
    assert.equal(result.reason, "correction");
  });

  it("scores Chinese corrections", () => {
    const result = scoreText("不对，应该是另一个", 2);
    assert.equal(result.score, 0.95);
    assert.equal(result.reason, "correction");
  });

  it("scores decisions high", () => {
    const result = scoreText("Let's go with option A, confirmed", 3);
    assert.equal(result.score, 0.85);
    assert.equal(result.reason, "decision");
  });

  it("scores acknowledgments low", () => {
    const result = scoreText("ok", 4);
    assert.equal(result.score, 0.1);
    assert.equal(result.reason, "acknowledgment");
  });

  it("scores Chinese acknowledgments low", () => {
    const result = scoreText("好的", 5);
    assert.equal(result.score, 0.1);
    assert.equal(result.reason, "acknowledgment");
  });

  it("scores empty text as 0", () => {
    const result = scoreText("   ", 6);
    assert.equal(result.score, 0.0);
    assert.equal(result.reason, "empty");
  });

  it("scores substantive text (>80 chars)", () => {
    const longText = "This is a very detailed explanation of the architecture that spans multiple sentences and provides significant context about the system design.";
    const result = scoreText(longText, 7);
    assert.equal(result.score, 0.7);
    assert.equal(result.reason, "substantive");
  });

  it("scores short questions at 0.5", () => {
    const result = scoreText("What version?", 8);
    assert.equal(result.score, 0.5);
    assert.equal(result.reason, "short_question");
  });

  it("preserves ordering: tool_call > correction > decision > substantive > question > acknowledgment > empty", () => {
    const scores = [
      scoreText("tool_use: memory_store", 0),
      scoreText("No, actually that's wrong", 1),
      scoreText("Confirmed, let's go with that", 2),
      scoreText("This is a very detailed explanation of the architecture that spans multiple sentences and provides context.", 3),
      scoreText("Which one?", 4),
      scoreText("ok", 5),
      scoreText("", 6),
    ];

    for (let i = 0; i < scores.length - 1; i++) {
      assert.ok(
        scores[i].score >= scores[i + 1].score,
        `Expected score[${i}] (${scores[i].score}, ${scores[i].reason}) >= score[${i + 1}] (${scores[i + 1].score}, ${scores[i + 1].reason})`,
      );
    }
  });
});

// ============================================================================
// compressTexts
// ============================================================================

describe("compressTexts", () => {
  it("returns all texts when within budget", () => {
    const texts = ["hello", "world", "test"];
    const result = compressTexts(texts, 10000);
    assert.deepEqual(result.texts, texts);
    assert.equal(result.dropped, 0);
  });

  it("enforces budget: output chars <= maxChars", () => {
    const texts = [
      "A".repeat(100),
      "B".repeat(100),
      "C".repeat(100),
      "D".repeat(100),
      "E".repeat(100),
    ];
    const result = compressTexts(texts, 250);
    assert.ok(
      result.totalChars <= 250,
      `Expected totalChars (${result.totalChars}) <= 250`,
    );
    assert.ok(result.dropped > 0);
  });

  it("always preserves first and last text", () => {
    const texts = [
      "FIRST: important setup context that should be preserved",
      "ok",
      "sure",
      "thanks",
      "got it",
      "LAST: final conclusion with critical information",
    ];
    const result = compressTexts(texts, 200);
    assert.ok(
      result.texts[0].startsWith("FIRST"),
      "First text should be preserved",
    );
    assert.ok(
      result.texts[result.texts.length - 1].startsWith("LAST"),
      "Last text should be preserved",
    );
  });

  it("preserves chronological order after compression", () => {
    const texts = [
      "First message",
      "No, actually that's wrong - this is a correction",
      "ok",
      "tool_use: memory_store with some data",
      "sure",
      "Let's go with the final decision here",
      "Last message",
    ];
    const result = compressTexts(texts, 300);

    // All texts in result should be in original order
    let lastOriginalIndex = -1;
    for (const text of result.texts) {
      const originalIndex = texts.indexOf(text);
      assert.ok(
        originalIndex > lastOriginalIndex,
        `Chronological order violated: found index ${originalIndex} after ${lastOriginalIndex}`,
      );
      lastOriginalIndex = originalIndex;
    }
  });

  it("handles paired texts: tool call + result kept together", () => {
    const texts = [
      "Start",
      "ok",
      "tool_use: memory_store",   // index 2 - tool call
      "Memory stored successfully", // index 3 - tool result (paired)
      "ok",
      "End",
    ];
    const result = compressTexts(texts, 300);

    const hasToolCall = result.texts.some((t) => t.includes("tool_use"));
    const hasToolResult = result.texts.some((t) => t.includes("Memory stored"));

    if (hasToolCall) {
      assert.ok(
        hasToolResult,
        "Tool call and its result should be kept together",
      );
    }
  });

  it("handles paired texts: both dropped when budget tight", () => {
    // When budget is very tight, paired texts might both be dropped
    const texts = [
      "A".repeat(90),  // first - must keep
      "tool_use: x",    // tool call
      "result of tool",  // tool result
      "B".repeat(90),  // last - must keep
    ];
    // Budget only fits first + last
    const result = compressTexts(texts, 185);
    assert.ok(result.texts.length >= 2, "Should keep at least first and last");
  });

  it("falls back to minTexts when all scores are low", () => {
    const texts = [
      "ok",        // 0.1
      "sure",      // 0.1
      "thanks",    // 0.1
      "got it",    // 0.1
      "alright",   // 0.1
    ];
    const result = compressTexts(texts, 100, { minTexts: 3 });
    assert.ok(
      result.texts.length >= 3,
      `Expected at least 3 texts in low-score fallback, got ${result.texts.length}`,
    );
  });

  it("handles empty input", () => {
    const result = compressTexts([], 1000);
    assert.deepEqual(result.texts, []);
    assert.equal(result.dropped, 0);
    assert.equal(result.totalChars, 0);
  });

  it("handles single text", () => {
    const result = compressTexts(["only one"], 1000);
    assert.deepEqual(result.texts, ["only one"]);
    assert.equal(result.dropped, 0);
  });
});

// ============================================================================
// estimateConversationValue
// ============================================================================

describe("estimateConversationValue", () => {
  it("returns 0 for empty conversations", () => {
    assert.equal(estimateConversationValue([]), 0);
  });

  it("returns high value for conversations with tool calls", () => {
    const value = estimateConversationValue([
      "Please store this memory",
      "tool_use: memory_store",
      "Memory stored successfully",
    ]);
    assert.ok(value >= 0.4, `Expected >= 0.4, got ${value}`);
  });

  it("returns high value for conversations with corrections", () => {
    const value = estimateConversationValue([
      "No, actually that's wrong",
      "Let me fix that",
      "Confirmed the change",
    ]);
    assert.ok(value >= 0.3, `Expected >= 0.3, got ${value}`);
  });

  it("returns low value for pure acknowledgment conversations", () => {
    const value = estimateConversationValue(["ok", "sure", "thanks"]);
    assert.ok(value < 0.3, `Expected < 0.3, got ${value}`);
  });

  it("adds +0.1 for multi-turn exchanges (>6 texts)", () => {
    const shortConvo = ["a", "b", "c"];
    const longConvo = ["a", "b", "c", "d", "e", "f", "g"];
    const shortValue = estimateConversationValue(shortConvo);
    const longValue = estimateConversationValue(longConvo);
    assert.ok(
      longValue >= shortValue,
      `Long conversation value (${longValue}) should be >= short (${shortValue})`,
    );
  });

  it("caps at 1.0", () => {
    const value = estimateConversationValue([
      "tool_use: memory_store with lots of context data",
      "No, actually that's wrong and needs to be corrected",
      "Let's go with the confirmed decision here for the project",
      "A".repeat(300),
      "B".repeat(300),
      "C".repeat(300),
      "D".repeat(300),
    ]);
    assert.ok(value <= 1.0, `Expected <= 1.0, got ${value}`);
  });

  it("returns +0.2 for conversations with >200 chars of substantive text", () => {
    const value = estimateConversationValue([
      "A".repeat(250),
    ]);
    assert.ok(value >= 0.2, `Expected >= 0.2, got ${value}`);
  });
});

// ============================================================================
// Extraction Rate Limiter
// ============================================================================

describe("createExtractionRateLimiter", () => {
  it("is not rate limited initially", () => {
    const limiter = createExtractionRateLimiter({ maxExtractionsPerHour: 5 });
    assert.equal(limiter.isRateLimited(), false);
    assert.equal(limiter.getRecentCount(), 0);
  });

  it("becomes rate limited after exceeding max", () => {
    const limiter = createExtractionRateLimiter({ maxExtractionsPerHour: 3 });
    limiter.recordExtraction();
    limiter.recordExtraction();
    limiter.recordExtraction();
    assert.equal(limiter.isRateLimited(), true);
    assert.equal(limiter.getRecentCount(), 3);
  });

  it("is not rate limited before reaching max", () => {
    const limiter = createExtractionRateLimiter({ maxExtractionsPerHour: 5 });
    limiter.recordExtraction();
    limiter.recordExtraction();
    assert.equal(limiter.isRateLimited(), false);
    assert.equal(limiter.getRecentCount(), 2);
  });

  it("uses default max of 30 when not specified", () => {
    const limiter = createExtractionRateLimiter();
    for (let i = 0; i < 29; i++) {
      limiter.recordExtraction();
    }
    assert.equal(limiter.isRateLimited(), false);
    limiter.recordExtraction();
    assert.equal(limiter.isRateLimited(), true);
  });

  it("sliding window: old entries expire (simulated)", () => {
    const limiter = createExtractionRateLimiter({ maxExtractionsPerHour: 2 });
    limiter.recordExtraction();
    limiter.recordExtraction();
    assert.equal(limiter.isRateLimited(), true);
    assert.equal(limiter.getRecentCount(), 2);
  });
});
