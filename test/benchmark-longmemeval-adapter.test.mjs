import { describe, it } from "node:test";
import assert from "node:assert";

describe("longmemeval adapter", () => {
  it("parseLongMemEvalData should extract sessions and questions", async () => {
    const { parseLongMemEvalData } = await import("../benchmark/adapters/longmemeval-adapter.ts");

    const mockData = {
      user_id: "user_1",
      sessions: [
        {
          session_id: "s1",
          messages: [
            { role: "user", content: "My name is Alice" },
            { role: "assistant", content: "Nice to meet you, Alice!" },
          ],
        },
        {
          session_id: "s2",
          messages: [
            { role: "user", content: "I live in Tokyo" },
          ],
        },
      ],
      questions: [
        {
          question_id: "q1",
          question: "What is the user's name?",
          answer: "Alice",
          category: "information_extraction",
        },
      ],
    };

    const parsed = parseLongMemEvalData(mockData);
    assert.strictEqual(parsed.userId, "user_1");
    assert.strictEqual(parsed.turns.length, 3);
    assert.strictEqual(parsed.turns[0].turnIndex, 0);
    assert.strictEqual(parsed.turns[2].turnIndex, 2);
    assert.strictEqual(parsed.turns[2].sessionId, "s2");
    assert.strictEqual(parsed.questions.length, 1);
    assert.strictEqual(parsed.questions[0].goldAnswer, "Alice");
  });

  it("factsToMemories should create proper BenchmarkMemory array", async () => {
    const { factsToMemories } = await import("../benchmark/adapters/longmemeval-adapter.ts");
    const memories = factsToMemories(
      [{ text: "Name is Alice", turnIndex: 0 }, { text: "Lives in Tokyo", turnIndex: 2 }],
      "user_1",
    );
    assert.strictEqual(memories.length, 2);
    assert.strictEqual(memories[0].id, "user_1-fact-0");
    assert.strictEqual(memories[0].scope, "global");
    assert.strictEqual(memories[0].category, "fact");
    assert.ok(memories[0].ageDays < 0);
  });
});
