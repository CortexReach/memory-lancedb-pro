/**
 * Skill Evidence Pack Generation
 *
 * Aggregates observation data into a structured evidence pack
 * for human review or external optimization engines (GEPA, TextGrad).
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { MemoryRetriever } from "./retriever.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillEvidencePack {
  skill_id: string;
  evidence: {
    failure_clusters: Array<{
      pattern: string;
      frequency: number;
      representative_traces: string[];
      user_corrections: string[];
    }>;
    time_windows: {
      recent_7d: { observations: number; success_rate: number };
      recent_30d: { observations: number; success_rate: number };
      all_time: { observations: number; success_rate: number };
    };
    related_skills: Array<{
      id: string;
      shared_failure: string;
    }>;
  };
  suggested_actions: string[];
}

// ============================================================================
// Core
// ============================================================================

export async function generateSkillEvidence(
  store: MemoryStore,
  retriever: MemoryRetriever,
  skillId: string,
  scopeFilter?: string[],
): Promise<SkillEvidencePack> {
  // Fetch all observations for this skill
  const entries = await store.list(scopeFilter, "other", 1000, 0);

  const now = Date.now();
  const d7 = now - 7 * 86400_000;
  const d30 = now - 30 * 86400_000;

  const observations: Array<{ entry: MemoryEntry; meta: Record<string, unknown> }> = [];
  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.skill_obs_type !== "observation") continue;
    if (meta.skill_id !== skillId) continue;
    observations.push({ entry, meta });
  }

  // Time windows
  const calcRate = (obs: typeof observations) => {
    if (obs.length === 0) return 0;
    return obs.filter((o) => o.meta.outcome === "success").length / obs.length;
  };

  const w7d = observations.filter((o) => o.entry.timestamp >= d7);
  const w30d = observations.filter((o) => o.entry.timestamp >= d30);

  // Failure clustering
  const failures = observations.filter((o) => o.meta.outcome !== "success");
  const clusterMap = new Map<string, {
    frequency: number;
    traces: string[];
    corrections: string[];
  }>();

  for (const f of failures) {
    const chains = (f.meta.error_chain as string[] | undefined) || [];
    const corrections = (f.meta.user_corrections as string[] | undefined) || [];
    const traceSummary = (f.meta.trace_summary as string | undefined) || f.entry.text;

    // Use first error chain entry as cluster key, fallback to text prefix
    const clusterKey = chains.length > 0
      ? chains[0].slice(0, 80).replace(/\n/g, " ").trim()
      : traceSummary.slice(0, 80).replace(/\n/g, " ").trim();

    const existing = clusterMap.get(clusterKey);
    if (existing) {
      existing.frequency++;
      if (existing.traces.length < 3) existing.traces.push(traceSummary.slice(0, 200));
      for (const c of corrections) {
        if (existing.corrections.length < 3) existing.corrections.push(c.slice(0, 200));
      }
    } else {
      clusterMap.set(clusterKey, {
        frequency: 1,
        traces: [traceSummary.slice(0, 200)],
        corrections: corrections.slice(0, 3).map((c) => c.slice(0, 200)),
      });
    }
  }

  const failureClusters = [...clusterMap.entries()]
    .sort((a, b) => b[1].frequency - a[1].frequency)
    .slice(0, 10)
    .map(([pattern, data]) => ({
      pattern,
      frequency: data.frequency,
      representative_traces: data.traces,
      user_corrections: data.corrections,
    }));

  // Cross-skill related failures
  const relatedSkills = await findRelatedSkills(
    retriever,
    skillId,
    failures.map((f) => f.entry),
    scopeFilter,
  );

  // Generate suggested actions from evidence
  const suggestedActions = deriveSuggestedActions(failureClusters);

  return {
    skill_id: skillId,
    evidence: {
      failure_clusters: failureClusters,
      time_windows: {
        recent_7d: { observations: w7d.length, success_rate: calcRate(w7d) },
        recent_30d: { observations: w30d.length, success_rate: calcRate(w30d) },
        all_time: { observations: observations.length, success_rate: calcRate(observations) },
      },
      related_skills: relatedSkills,
    },
    suggested_actions: suggestedActions,
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function findRelatedSkills(
  retriever: MemoryRetriever,
  skillId: string,
  failures: MemoryEntry[],
  scopeFilter?: string[],
): Promise<Array<{ id: string; shared_failure: string }>> {
  const related: Array<{ id: string; shared_failure: string }> = [];
  const seen = new Set<string>();

  for (const failure of failures.slice(0, 5)) {
    try {
      const results = await retriever.retrieve({
        query: failure.text,
        limit: 10,
        scopeFilter,
      });

      for (const r of results) {
        const meta = parseSmartMetadata(r.entry.metadata, r.entry);
        if (meta.skill_obs_type !== "observation") continue;
        if (meta.skill_id === skillId) continue;
        if (meta.outcome === "success") continue;

        const sid = meta.skill_id as string;
        if (seen.has(sid)) continue;
        seen.add(sid);

        related.push({
          id: sid,
          shared_failure: failure.text.slice(0, 120).replace(/\n/g, " ").trim(),
        });
      }
    } catch {
      // Non-critical
    }
  }

  return related.slice(0, 5);
}

function deriveSuggestedActions(
  clusters: Array<{ pattern: string; frequency: number; user_corrections: string[] }>,
): string[] {
  const actions: string[] = [];

  for (const cluster of clusters.slice(0, 3)) {
    if (cluster.user_corrections.length > 0) {
      actions.push(
        `Address "${cluster.pattern}" (${cluster.frequency}x). User suggested: "${cluster.user_corrections[0]}"`,
      );
    } else {
      actions.push(
        `Investigate failure pattern: "${cluster.pattern}" (${cluster.frequency} occurrences)`,
      );
    }
  }

  if (actions.length === 0) {
    actions.push("Review recent failures for improvement opportunities");
  }

  return actions;
}
