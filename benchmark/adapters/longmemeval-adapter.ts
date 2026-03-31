import OpenAI from "openai";
import type { BenchmarkMemory } from "../datasets/types.js";

// ============================================================================
// LongMemEval Data Types
// ============================================================================

export interface LongMemEvalSession {
  session_id: string;
  messages: Array<{ role: string; content: string }>;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  answer: string;
  category: string;
}

export interface LongMemEvalUser {
  user_id: string;
  sessions: LongMemEvalSession[];
  questions: LongMemEvalQuestion[];
}

export interface ParsedLongMemEval {
  userId: string;
  turns: Array<{ speaker: string; text: string; turnIndex: number; sessionId: string }>;
  questions: Array<{
    id: string;
    text: string;
    goldAnswer: string;
    category: string;
  }>;
}

// ============================================================================
// Data Parsing
// ============================================================================

export function parseLongMemEvalData(data: LongMemEvalUser): ParsedLongMemEval {
  const turns: ParsedLongMemEval["turns"] = [];
  let turnIndex = 0;

  for (const session of data.sessions) {
    for (const msg of session.messages) {
      turns.push({
        speaker: msg.role,
        text: msg.content,
        turnIndex: turnIndex++,
        sessionId: session.session_id,
      });
    }
  }

  const questions = data.questions.map((q) => ({
    id: q.question_id,
    text: q.question,
    goldAnswer: q.answer,
    category: q.category,
  }));

  return { userId: data.user_id, turns, questions };
}

// ============================================================================
// Fact Extraction
// ============================================================================

const EXTRACTION_PROMPT = `Extract ALL factual information from this conversation turn.
Return each fact on its own numbered line.
Preserve the original wording as much as possible.
Include: names, preferences, locations, dates, decisions, relationships, opinions.
If no factual information is present, return "NONE".`;

export async function extractFactsFromTurn(
  turn: { speaker: string; text: string; turnIndex: number },
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<Array<{ text: string; turnIndex: number }>> {
  // Skip assistant turns — they don't contain user facts
  if (turn.speaker === "assistant") return [];

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: `[Turn ${turn.turnIndex}] ${turn.speaker}: ${turn.text}` },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (content === "NONE" || !content) return [];

  return content
    .split("\n")
    .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "NONE")
    .map((text) => ({ text, turnIndex: turn.turnIndex }));
}

export function factsToMemories(
  facts: Array<{ text: string; turnIndex: number }>,
  userId: string,
): BenchmarkMemory[] {
  return facts.map((fact, i) => ({
    id: `${userId}-fact-${i}`,
    text: fact.text,
    category: "fact" as const,
    scope: "global",
    importance: 0.7,
    ageDays: -(facts.length - i),
    tags: [`turn:${fact.turnIndex}`],
  }));
}
