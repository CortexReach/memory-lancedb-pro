/**
 * Unit tests for isRecallUsed() - Phase 1 recall governance core detection function.
 * Tests all three detection paths: ID+marker AND logic, Summary verbatim, Summary reverse-match.
 *
 * Run: node test/is-recall-used.test.mjs
 * Expected: ALL PASSED
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { isRecallUsed } = await import("../src/reflection-slices.ts");

function recall(responseText, injectedIds, injectedSummaries) {
  return isRecallUsed(responseText, injectedIds, injectedSummaries);
}

// ---------------------------------------------------------------------------
// Edge Cases: empty / boundary inputs
// ---------------------------------------------------------------------------
describe("isRecallUsed edge cases", () => {
  it("EC-03: empty arrays returns false", () => {
    assert.strictEqual(recall("This is a longer response", [], []), false);
  });

  it("EC-04: empty string ID and undefined summaries returns false", () => {
    assert.strictEqual(recall("This is a longer response", [""], undefined), false);
  });

  it("EC-01: response exactly 24 chars returns false (below threshold)", () => {
    // "Exactly24CharactersLong!!" = 24 chars
    assert.strictEqual(recall("Exactly24CharactersLong!!", ["mem1"], ["summary"]), false);
  });

  it("EC-02: response exactly 25 chars with ID match and marker returns true", () => {
    // "Exactly25CharactersLong!!!!" = 25 chars — has ID "mem1" and marker "remember"
    assert.strictEqual(recall("I remember mem1 was mentioned", ["mem1"], undefined), true);
  });
});

// ---------------------------------------------------------------------------
// ID Path + Marker AND Logic
// ---------------------------------------------------------------------------
describe("isRecallUsed ID path (hasSpecificRecall)", () => {
  it("ID exists in response WITHOUT marker phrase returns false", () => {
    assert.strictEqual(recall("I see memory ID mem123 in the context", ["mem123"], undefined), false);
  });

  it("ID exists WITH marker phrase returns true", () => {
    assert.strictEqual(recall("I remember mem123 from earlier", ["mem123"], undefined), true);
  });

  it("EC-05: ID present, no marker, summary also not met — false", () => {
    assert.strictEqual(recall("mem123 is in this response", ["mem123"], ["short"]), false);
  });

  it("EC-06: marker phrase present but no ID returns false", () => {
    assert.strictEqual(recall("I remember our conversation", [], undefined), false);
  });

  it("Multiple IDs — one matches with marker returns true", () => {
    assert.strictEqual(recall("Based on what you mentioned earlier about mem456", ["mem123", "mem456"], undefined), true);
  });

  it("Chinese marker with ID match — response length > 24 chars", () => {
    // Response length must exceed 24-char threshold for marker check
    const resp = "根據之前提到的 mem789 建議，我們應該調整順序";
    assert.strictEqual(recall(resp, ["mem789"], undefined), true);
  });
});

// ---------------------------------------------------------------------------
// Summary verbatim path
// ---------------------------------------------------------------------------
describe("isRecallUsed Summary verbatim path", () => {
  it("Summary verbatim in response returns true", () => {
    const summary = "prefer TypeScript strict mode";
    assert.strictEqual(
      recall("I should prefer TypeScript strict mode in this project", [], [summary]),
      true
    );
  });

  it("EC-07: Summary exactly 9 chars returns false (below F3 guard)", () => {
    const summary = "shorttext"; // 9 chars
    assert.strictEqual(recall("The shorttext guideline applies here", [], [summary]), false);
  });

  it("EC-08: Summary exactly 10 chars returns true", () => {
    const summary = "shorttextx"; // 10 chars
    assert.strictEqual(recall("The shorttextx rule should apply", [], [summary]), true);
  });

  it("Summary with leading/trailing whitespace still matches", () => {
    const summary = "  prefer absolute imports  ";
    assert.strictEqual(
      recall("You should prefer absolute imports over relative", [], [summary]),
      true
    );
  });

  it("Case-insensitive matching", () => {
    const summary = "Use TypeScript";
    assert.strictEqual(
      recall("I recommend use typescript for this", [], [summary]),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Summary reverse-match path (F3 fix)
// ---------------------------------------------------------------------------
describe("isRecallUsed Summary reverse-match (F3 fix)", () => {
  it("EC-09: response 9-char snippet in summary returns false (F3 guard)", () => {
    // reverse-match: 9-char snippet (< 10) in summary → false
    const summary = "always validate input before processing any user data";
    assert.strictEqual(recall("always validate", [], [summary]), false);
  });

  it("EC-10: response 10+ char prefix in summary returns true", () => {
    // reverse-match: summary starts with >= 10 chars from response → true
    const summary = "always validate input before processing";
    // response starts with "always validate input" (24 chars) which matches summary prefix
    assert.strictEqual(recall("always validate input before processing anything", [], [summary]), true);
  });

  it("Longer response: first 50 chars snippet matches in summary returns true", () => {
    const summary = "When implementing new features always write unit tests to ensure quality and prevent regressions";
    const response = "When implementing new features always write unit tests to ensure quality and prevent regressions is critical";
    assert.strictEqual(recall(response, [], [summary]), true);
  });

  it("Response 50-char snippet longer than summary still handled", () => {
    // summary = 36 chars, response snippet is first 50 chars but clipped to summary length
    const summary = "always validate input before processing"; // 36 chars
    const response = "always validate input before processing any user data";
    assert.strictEqual(recall(response, [], [summary]), true);
  });
});

// ---------------------------------------------------------------------------
// Mixed: ID fails but Summary succeeds
// ---------------------------------------------------------------------------
describe("isRecallUsed mixed paths", () => {
  it("ID path fails but Summary verbatim succeeds returns true", () => {
    const summary = "prefer composition over inheritance";
    assert.strictEqual(
      recall("I suggest prefer composition over inheritance in this codebase", ["mem999"], [summary]),
      true
    );
  });

  it("ID path succeeds but Summary fails returns true (ID+marker satisfied)", () => {
    assert.strictEqual(recall("I remember mem123 from last session", ["mem123"], ["different summary"]), true);
  });

  it("ID fails and Summary fails returns false", () => {
    assert.strictEqual(
      recall("Thank you for the information", ["mem999"], ["completely different summary text here"]),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// CJK / multilingual
// ---------------------------------------------------------------------------
describe("isRecallUsed Chinese / multilingual", () => {
  it("EC-13: Chinese summary + Chinese response (response > 24 chars)", () => {
    const summary = "使用絕對路徑而非相對路徑";
    assert.strictEqual(
      recall("我建議使用絕對路徑而非相對路徑來import模組，謝謝", [], [summary]),
      true
    );
  });

  it("Chinese marker with ID — response > 24 chars", () => {
    const resp = "根據之前提到的 mem001 建議，我們應該調整順序";
    assert.strictEqual(recall(resp, ["mem001"], undefined), true);
  });

  it("Summary with Chinese but response in English — no match", () => {
    const summary = "使用絕對路徑而非相對路徑";
    assert.strictEqual(recall("use absolute paths not relative", [], [summary]), false);
  });
});

// ---------------------------------------------------------------------------
// Whitespace in arrays
// ---------------------------------------------------------------------------
describe("isRecallUsed array edge cases", () => {
  it("Summary array contains whitespace-only strings — skipped", () => {
    assert.strictEqual(recall("A response that is longer than 24 characters here", [], ["  ", "\t", ""]), false);
  });

  it("Multiple summaries — one meets threshold", () => {
    assert.strictEqual(
      recall("use typescript for new files", [], ["short", "use typescript for new files", "also short"]),
      true
    );
  });

  it("Multiple summaries — all below threshold returns false", () => {
    assert.strictEqual(
      recall("some content in response", [], ["short", "tiny", "x"]),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// ID array edge cases
// ---------------------------------------------------------------------------
describe("isRecallUsed ID array edge cases", () => {
  it("All IDs are empty strings — returns false", () => {
    assert.strictEqual(recall("This is a meaningful response over 24 chars", ["", "", ""], undefined), false);
  });

  it("Mixed valid and empty IDs — only valid ID checked", () => {
    // valid ID present with marker → true
    assert.strictEqual(recall("I remember mem123 from earlier", ["", "mem123", ""], undefined), true);
    // no valid ID → false (empty strings filtered out)
    assert.strictEqual(recall("This is a response without any memory", ["", "  ", ""], undefined), false);
  });

  it("Multiple summaries — ID all invalid but summary succeeds", () => {
    // IDs all empty/invalid, but summary verbatim triggers
    assert.strictEqual(
      recall("prefer typescript for all new projects", ["", "", ""], ["prefer typescript for all new projects"]),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Summary 10-char boundary (case-insensitive)
// ---------------------------------------------------------------------------
describe("isRecallUsed Summary 10-char boundary (case-insensitive)", () => {
  it("Summary exactly 10 chars — uppercase in response matches", () => {
    const summary = "hello worl"; // exactly 10 chars
    assert.strictEqual(recall("HELLO WORL is preferred here", [], [summary]), true);
  });

  it("Summary exactly 10 chars — mixed case in response matches", () => {
    const summary = "hello worl";
    assert.strictEqual(recall("Hello Worl is the way to go", [], [summary]), true);
  });

  it("Summary 10+ chars — partial match in response returns true", () => {
    const summary = "hello worldx"; // 12 chars
    assert.strictEqual(recall("I suggest hello worldx for all cases", [], [summary]), true);
  });

  it("Summary exactly 10 chars but response is too short (<= 24)", () => {
    const summary = "hello worl"; // 10 chars
    assert.strictEqual(recall("HELLO WORL", [], [summary]), false);
  });
});

// ---------------------------------------------------------------------------
// Cross-language: CJK markers / summary in English response
// ---------------------------------------------------------------------------
describe("isRecallUsed cross-language negative cases", () => {
  it("Chinese marker phrase but response is fully English — no match", () => {
    // Has Chinese marker substring but response is pure English
    assert.strictEqual(recall("I remember our previous conversation was helpful", [], undefined), false);
  });

  it("Chinese summary in response but English-only response — no match", () => {
    const summary = "使用絕對路徑而非相對路徑";
    assert.strictEqual(recall("use absolute paths not relative for imports", [], [summary]), false);
  });

  it("Mixed response — English with CJK summary verbatim match", () => {
    const summary = "prefer absolute paths"; // English
    assert.strictEqual(recall("I recommend to prefer absolute paths over relative ones", [], [summary]), true);
  });
});