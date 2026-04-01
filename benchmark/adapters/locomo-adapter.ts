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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          {
            role: "user",
            content: `[Turn ${turn.turnIndex}] ${turn.speaker}: ${turn.text}`,
          },
        ],
      });

      const content = response.choices[0]?.message?.content?.trim() ?? "";
      if (content === "NONE" || !content) return [];

      return parseExtractionResponse(content).map((text) => ({
        text,
        turnIndex: turn.turnIndex,
      }));
    } catch (err: any) {
      // Azure content filter — skip turn
      const code = err?.status ?? err?.code ?? "";
      if (
        code === 400 ||
        /content.*filter|content.*management/i.test(String(err))
      ) {
        console.warn(
          `    [skip] Turn ${turn.turnIndex} filtered by content policy`,
        );
        return [];
      }
      // Transient network errors — retry
      const isTransient = /ECONNRESET|ETIMEDOUT|abort|socket|network/i.test(
        String(err),
      );
      if (isTransient && attempt < 2) {
        console.warn(
          `    [retry] Extraction turn ${turn.turnIndex} attempt ${attempt + 1}: ${String(err).slice(0, 60)}`,
        );
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return [];
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
  const memoryBlock = memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n");

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
  try {
    const prompt = buildGenerationPrompt(memories, question);

    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err: any) {
    if (err?.status === 400) {
      console.warn(`    [skip] Generation filtered by content policy`);
      return "I don't know.";
    }
    throw err;
  }
}

// ============================================================================
// LoCoMo Data Types & Loader
// ============================================================================

/**
 * Actual LoCoMo data format (locomo10.json):
 * - Top level: array of conversation objects
 * - conversation: { speaker_a, speaker_b, session_1: [{speaker, text, dia_id}], session_2: [...], ... }
 * - qa: [{question, answer, evidence, category}]
 * - sample_id: "conv-26"
 */
export interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: Array<{
    question: string;
    answer: string;
    evidence: string[];
    category: number;
  }>;
}

export function flattenTurns(
  conv: LoCoMoConversation,
): Array<{ speaker: string; text: string; turnIndex: number }> {
  const turns: Array<{ speaker: string; text: string; turnIndex: number }> = [];
  let idx = 0;
  const c = conv.conversation;

  // Sessions are stored as session_1, session_2, ... (arrays of {speaker, text, dia_id})
  for (let s = 1; s <= 100; s++) {
    const session = c[`session_${s}`];
    if (!Array.isArray(session)) break;
    for (const turn of session) {
      if (
        turn &&
        typeof turn === "object" &&
        "speaker" in turn &&
        "text" in turn
      ) {
        turns.push({
          speaker: (turn as any).speaker,
          text: (turn as any).text,
          turnIndex: idx++,
        });
      }
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
