import OpenAI from "openai";

/** Token-level F1 score between predicted and gold answer (SQuAD-style multiset) */
export function tokenF1(predicted: string, gold: string): number {
  const predTokens = predicted.toLowerCase().split(/\s+/).filter(Boolean);
  const goldTokens = gold.toLowerCase().split(/\s+/).filter(Boolean);

  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;

  // Multiset intersection: count each token up to its frequency in gold
  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);

  let truePositives = 0;
  const usedCounts = new Map<string, number>();
  for (const t of predTokens) {
    const available = (goldCounts.get(t) ?? 0) - (usedCounts.get(t) ?? 0);
    if (available > 0) {
      truePositives++;
      usedCounts.set(t, (usedCounts.get(t) ?? 0) + 1);
    }
  }

  const precision = truePositives / predTokens.length;
  const recall = truePositives / goldTokens.length;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** LLM-Judge: binary CORRECT/WRONG via LLM */
export async function llmJudge(
  question: string,
  predicted: string,
  gold: string,
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<{ correct: boolean; raw: string }> {
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are evaluating whether an AI assistant's answer is correct. " +
            "Compare the predicted answer with the gold answer. " +
            "Reply with exactly CORRECT or WRONG. " +
            "Be generous: if the predicted answer captures the key facts from the gold answer, mark it CORRECT even if wording differs.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nGold Answer: ${gold}\n\nPredicted Answer: ${predicted}\n\nVerdict:`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const correct = raw.toUpperCase().startsWith("CORRECT");
    return { correct, raw };
  } catch (err: any) {
    if (err?.status === 400) {
      console.warn(`    [skip] Judge filtered by content policy`);
      return { correct: false, raw: "FILTERED" };
    }
    throw err;
  }
}

export interface EndToEndResult {
  llmJudgeAccuracy: number;
  f1: number;
  totalQueries: number;
  correctCount: number;
}
