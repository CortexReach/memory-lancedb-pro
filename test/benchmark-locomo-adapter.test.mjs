import { describe, it } from "node:test";
import assert from "node:assert";

describe("locomo adapter", () => {
  it("parseExtractionResponse should extract facts from numbered lines", async () => {
    const { parseExtractionResponse } = await import("../benchmark/adapters/locomo-adapter.ts");
    const response = "1. User's name is Alice\n2. User lives in New York\n3. User prefers dark theme";
    const facts = parseExtractionResponse(response);
    assert.strictEqual(facts.length, 3);
    assert.ok(facts[0].includes("Alice"));
    assert.ok(facts[1].includes("New York"));
  });

  it("parseExtractionResponse should handle NONE response", async () => {
    const { parseExtractionResponse } = await import("../benchmark/adapters/locomo-adapter.ts");
    assert.strictEqual(parseExtractionResponse("NONE").length, 0);
  });

  it("parseExtractionResponse should handle empty lines", async () => {
    const { parseExtractionResponse } = await import("../benchmark/adapters/locomo-adapter.ts");
    const result = parseExtractionResponse("1. Fact one\n\n2. Fact two\n\n");
    assert.strictEqual(result.length, 2);
  });

  it("buildGenerationPrompt should format correctly", async () => {
    const { buildGenerationPrompt } = await import("../benchmark/adapters/locomo-adapter.ts");
    const prompt = buildGenerationPrompt(
      [{ text: "User lives in NYC", score: 0.9 }],
      "Where does the user live?",
    );
    assert.ok(prompt.includes("NYC"));
    assert.ok(prompt.includes("Where does the user live?"));
    assert.ok(prompt.includes("ONLY on the information above"));
  });

  it("flattenTurns should flatten multi-session conversations", async () => {
    const { flattenTurns } = await import("../benchmark/adapters/locomo-adapter.ts");
    const conv = {
      conversation_id: "test",
      sessions: [
        { session_id: "s1", turns: [{ speaker: "user", text: "hello" }] },
        { session_id: "s2", turns: [{ speaker: "user", text: "world" }] },
      ],
      qa_pairs: [],
    };
    const turns = flattenTurns(conv);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].turnIndex, 0);
    assert.strictEqual(turns[1].turnIndex, 1);
  });

  it("factsToMemories should create BenchmarkMemory array", async () => {
    const { factsToMemories } = await import("../benchmark/adapters/locomo-adapter.ts");
    const memories = factsToMemories(
      [{ text: "User is Alice", turnIndex: 0 }, { text: "Likes cats", turnIndex: 3 }],
      "conv-1",
    );
    assert.strictEqual(memories.length, 2);
    assert.strictEqual(memories[0].id, "conv-1-fact-0");
    assert.strictEqual(memories[0].scope, "global");
    assert.ok(memories[0].ageDays < 0, "ageDays should be negative (past)");
  });
});
