import OpenAI from "openai";
import type { BenchmarkMemory } from "../datasets/types.js";

// ============================================================================
// Extraction Layer
// ============================================================================

const EXTRACTION_PROMPT = `Extract ALL factual information from this conversation turn.
Return each fact on its own numbered line.
Preserve the original wording as much as possible.
Include: names, preferences, locations, dates, decisions, relationships, opinions.
If no factual information is present, return "NONE".`;

export async function extractFacts(
  turn: { speaker: string; text: string; turnIndex: number },
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<Array<{ text: string; turnIndex: number }>> {
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

  return parseExtractionResponse(content).map((text) => ({
    text,
    turnIndex: turn.turnIndex,
  }));
}

export function parseExtractionResponse(response: string): string[] {
  return response
    .split("\n")
    .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "NONE");
}

// ============================================================================
// Generation Layer
// ============================================================================

export function buildGenerationPrompt(
  memories: Array<{ text: string; score: number }>,
  question: string,
): string {
  const memoryBlock = memories
    .map((m, i) => `${i + 1}. ${m.text}`)
    .join("\n");

  return `Given these memory entries:
${memoryBlock}

Answer this question based ONLY on the information above.
If the information is not available, say "I don't know."

Question: ${question}`;
}

export async function generateAnswer(
  memories: Array<{ text: string; score: number }>,
  question: string,
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<string> {
  const prompt = buildGenerationPrompt(memories, question);

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ============================================================================
// LoCoMo Data Types & Loader
// ============================================================================

export interface LoCoMoConversation {
  conversation_id: string;
  sessions: Array<{
    session_id: string;
    turns: Array<{
      speaker: string;
      text: string;
    }>;
  }>;
  qa_pairs: Array<{
    question: string;
    answer: string;
    category: number;
  }>;
}

export function flattenTurns(
  conv: LoCoMoConversation,
): Array<{ speaker: string; text: string; turnIndex: number }> {
  const turns: Array<{ speaker: string; text: string; turnIndex: number }> = [];
  let idx = 0;
  for (const session of conv.sessions) {
    for (const turn of session.turns) {
      turns.push({ ...turn, turnIndex: idx++ });
    }
  }
  return turns;
}

export function factsToMemories(
  facts: Array<{ text: string; turnIndex: number }>,
  conversationId: string,
): BenchmarkMemory[] {
  return facts.map((fact, i) => ({
    id: `${conversationId}-fact-${i}`,
    text: fact.text,
    category: "fact" as const,
    scope: "global",
    importance: 0.7,
    ageDays: -(facts.length - i),
    tags: [`turn:${fact.turnIndex}`],
  }));
}
