/**
 * Skill Observation Storage
 *
 * Stores skill execution observations as memory entries with
 * category: "other" + metadata.skill_obs_type: "observation".
 *
 * Each observation is stored independently (no merging) to preserve
 * time distribution for 7d/30d window statistics.
 */

import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import { stringifySmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillObservationInput {
  skill_id: string;
  outcome: "success" | "partial" | "failure";
  outcome_signal?: "completion" | "user_override" | "error" | "timeout";
  text: string;
  trace_summary?: string;
  error_chain?: string[];
  user_corrections?: string[];
  scope: string;
}

// ============================================================================
// Storage
// ============================================================================

export async function storeSkillObservation(
  store: MemoryStore,
  embedder: Embedder,
  obs: SkillObservationInput,
): Promise<{ id: string }> {
  const vector = await embedder.embed(obs.text);

  const entry = await store.store({
    text: obs.text,
    vector,
    category: "other",
    importance: obs.outcome === "failure" ? 0.8 : 0.5,
    scope: obs.scope,
    metadata: stringifySmartMetadata({
      skill_obs_type: "observation",
      skill_id: obs.skill_id,
      outcome: obs.outcome,
      outcome_signal: obs.outcome_signal,
      trace_summary: obs.trace_summary,
      error_chain: obs.error_chain,
      user_corrections: obs.user_corrections,
    }),
  });

  return { id: entry.id };
}

// ============================================================================
// Helpers
// ============================================================================

export function buildObservationText(
  skillId: string,
  outcome: string,
  corrections: string[],
  toolErrors: Array<{ toolName: string; error: string }>,
): string {
  const parts: string[] = [
    `skill '${skillId}' execution: ${outcome}.`,
  ];

  if (toolErrors.length > 0) {
    const errorSummaries = toolErrors
      .slice(0, 3)
      .map((e) => `${e.toolName}: ${e.error.slice(0, 200)}`);
    parts.push(`Errors: ${errorSummaries.join("; ")}.`);
  }

  if (corrections.length > 0) {
    parts.push(
      `User corrections: ${corrections.slice(0, 3).join("; ")}.`,
    );
  }

  return parts.join(" ");
}
