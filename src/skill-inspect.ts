/**
 * Skill Inspection & Health Dashboard
 *
 * Queries skill observation records and provides:
 * - Per-skill health reports with time window statistics
 * - Global health dashboard across all tracked skills
 * - Cross-skill semantic pattern detection for systemic issues
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { MemoryRetriever } from "./retriever.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillReport {
  skill_id: string;
  total_observations: number;
  success_rate: number;
  trend: "improving" | "stable" | "declining";
  time_windows: {
    recent_7d: { observations: number; success_rate: number };
    recent_30d: { observations: number; success_rate: number };
    all_time: { observations: number; success_rate: number };
  };
  trend_alert?: string;
  top_failures: Array<{ pattern: string; count: number }>;
  related_failures: Array<{
    skill_id: string;
    similarity: number;
    shared_pattern: string;
  }>;
}

export interface HealthDashboard {
  summary: {
    total_skills: number;
    healthy: number;
    degraded: number;
    critical: number;
  };
  skills: Array<{
    id: string;
    status: "healthy" | "degraded" | "critical";
    success_rate: number;
    trend: string;
    observations: number;
    last_used: string;
  }>;
  systemic_issues: Array<{
    pattern: string;
    affected_skills: string[];
    count: number;
  }>;
}

export interface SkillHistoryEntry {
  id: string;
  skill_id: string;
  outcome: string;
  text: string;
  timestamp: number;
  date: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get all skill observation entries from the store.
 * Filters category: "other" entries by metadata.skill_obs_type === "observation".
 */
async function getSkillObservations(
  store: MemoryStore,
  scopeFilter?: string[],
  skillId?: string,
  daysBack?: number,
): Promise<Array<{ entry: MemoryEntry; meta: Record<string, unknown> }>> {
  // Fetch a large batch of "other" category entries
  const entries = await store.list(scopeFilter, "other", 1000, 0);

  const now = Date.now();
  const cutoff = daysBack ? now - daysBack * 86400_000 : 0;

  const observations: Array<{
    entry: MemoryEntry;
    meta: Record<string, unknown>;
  }> = [];

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.skill_obs_type !== "observation") continue;
    if (skillId && meta.skill_id !== skillId) continue;
    if (daysBack && entry.timestamp < cutoff) continue;

    observations.push({ entry, meta });
  }

  return observations;
}

/**
 * Inspect a single skill's health, failure patterns, and cross-skill correlations.
 */
export async function inspectSkill(
  store: MemoryStore,
  retriever: MemoryRetriever,
  skillId: string,
  opts: { days?: number; scopeFilter?: string[] } = {},
): Promise<SkillReport> {
  const days = opts.days ?? 30;
  const allObs = await getSkillObservations(
    store,
    opts.scopeFilter,
    skillId,
    days,
  );
  const now = Date.now();

  // Time window bucketing
  const d7 = now - 7 * 86400_000;
  const d30 = now - 30 * 86400_000;

  const windows = {
    recent_7d: allObs.filter((o) => o.entry.timestamp >= d7),
    recent_30d: allObs.filter((o) => o.entry.timestamp >= d30),
    all_time: allObs,
  };

  const calcRate = (obs: typeof allObs) => {
    if (obs.length === 0) return 0;
    const successes = obs.filter((o) => o.meta.outcome === "success").length;
    return successes / obs.length;
  };

  const rate7d = calcRate(windows.recent_7d);
  const rate30d = calcRate(windows.recent_30d);
  const rateAll = calcRate(windows.all_time);

  // Trend detection
  let trend: SkillReport["trend"] = "stable";
  let trendAlert: string | undefined;

  if (windows.recent_7d.length >= 3 && windows.recent_30d.length >= 5) {
    if (rate7d < rate30d - 0.15) {
      trend = "declining";
      trendAlert = `Recent 7d success rate (${pct(rate7d)}) is below 30d average (${pct(rate30d)}).`;
    } else if (rate7d > rate30d + 0.15) {
      trend = "improving";
    }
  }

  // Top failure patterns
  const failures = allObs.filter((o) => o.meta.outcome !== "success");
  const patternCounts = new Map<string, number>();

  for (const f of failures) {
    const chains = f.meta.error_chain as string[] | undefined;
    const corrections = f.meta.user_corrections as string[] | undefined;
    const patterns = [
      ...(chains || []).map((c) => truncatePattern(c)),
      ...(corrections || []).map((c) => truncatePattern(c)),
    ];
    if (patterns.length === 0) {
      patterns.push(truncatePattern(f.entry.text));
    }
    for (const p of patterns) {
      patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
    }
  }

  const topFailures = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));

  // Cross-skill related failures
  const related = await findRelatedFailures(
    store,
    retriever,
    skillId,
    failures.map((f) => f.entry),
    opts.scopeFilter,
  );

  return {
    skill_id: skillId,
    total_observations: allObs.length,
    success_rate: rateAll,
    trend,
    time_windows: {
      recent_7d: {
        observations: windows.recent_7d.length,
        success_rate: rate7d,
      },
      recent_30d: {
        observations: windows.recent_30d.length,
        success_rate: rate30d,
      },
      all_time: {
        observations: windows.all_time.length,
        success_rate: rateAll,
      },
    },
    trend_alert: trendAlert,
    top_failures: topFailures,
    related_failures: related,
  };
}

/**
 * Get a global health dashboard for all tracked skills.
 */
export async function getSkillHealth(
  store: MemoryStore,
  retriever: MemoryRetriever,
  opts: { scopeFilter?: string[] } = {},
): Promise<HealthDashboard> {
  const allObs = await getSkillObservations(store, opts.scopeFilter);

  // Group by skill_id
  const bySkill = new Map<string, typeof allObs>();
  for (const o of allObs) {
    const sid = o.meta.skill_id as string;
    if (!bySkill.has(sid)) bySkill.set(sid, []);
    bySkill.get(sid)!.push(o);
  }

  const now = Date.now();
  const d7 = now - 7 * 86400_000;

  let healthy = 0;
  let degraded = 0;
  let critical = 0;

  const skills: HealthDashboard["skills"] = [];

  for (const [sid, obs] of bySkill) {
    const successes = obs.filter((o) => o.meta.outcome === "success").length;
    const rate = obs.length > 0 ? successes / obs.length : 0;

    const recent = obs.filter((o) => o.entry.timestamp >= d7);
    const recentRate =
      recent.length > 0
        ? recent.filter((o) => o.meta.outcome === "success").length /
          recent.length
        : rate;

    let status: "healthy" | "degraded" | "critical";
    if (rate < 0.5) {
      status = "critical";
      critical++;
    } else if (rate < 0.7) {
      status = "degraded";
      degraded++;
    } else {
      status = "healthy";
      healthy++;
    }

    const lastTs = Math.max(...obs.map((o) => o.entry.timestamp));
    const daysAgo = Math.floor((now - lastTs) / 86400_000);
    const lastUsed =
      daysAgo === 0 ? "today" : daysAgo === 1 ? "1d ago" : `${daysAgo}d ago`;

    const trendStr =
      recent.length >= 3 && recentRate < rate - 0.15
        ? "↓"
        : recent.length >= 3 && recentRate > rate + 0.15
          ? "↑"
          : "→";

    skills.push({
      id: sid,
      status,
      success_rate: rate,
      trend: trendStr,
      observations: obs.length,
      last_used: lastUsed,
    });
  }

  // Sort: critical first, then degraded, then by observation count
  skills.sort((a, b) => {
    const statusOrder = { critical: 0, degraded: 1, healthy: 2 };
    const diff = statusOrder[a.status] - statusOrder[b.status];
    return diff !== 0 ? diff : b.observations - a.observations;
  });

  // Systemic issues: find failure patterns that appear across multiple skills
  const systemicPatterns = new Map<string, Set<string>>();
  for (const [sid, obs] of bySkill) {
    for (const o of obs) {
      if (o.meta.outcome === "success") continue;
      const chains = o.meta.error_chain as string[] | undefined;
      for (const c of chains || []) {
        const p = truncatePattern(c);
        if (!systemicPatterns.has(p)) systemicPatterns.set(p, new Set());
        systemicPatterns.get(p)!.add(sid);
      }
    }
  }

  const systemic = [...systemicPatterns.entries()]
    .filter(([, skills]) => skills.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
    .map(([pattern, affectedSet]) => ({
      pattern,
      affected_skills: [...affectedSet],
      count: affectedSet.size,
    }));

  return {
    summary: {
      total_skills: bySkill.size,
      healthy,
      degraded,
      critical,
    },
    skills,
    systemic_issues: systemic,
  };
}

/**
 * Get chronological observation history for a skill.
 */
export async function getSkillHistory(
  store: MemoryStore,
  skillId: string,
  opts: { limit?: number; scopeFilter?: string[] } = {},
): Promise<SkillHistoryEntry[]> {
  const limit = opts.limit ?? 20;
  const allObs = await getSkillObservations(store, opts.scopeFilter, skillId);

  // Sort by timestamp descending (most recent first)
  allObs.sort((a, b) => b.entry.timestamp - a.entry.timestamp);

  return allObs.slice(0, limit).map((o) => ({
    id: o.entry.id,
    skill_id: o.meta.skill_id as string,
    outcome: o.meta.outcome as string,
    text: o.entry.text,
    timestamp: o.entry.timestamp,
    date: new Date(o.entry.timestamp).toISOString().split("T")[0],
  }));
}

// ============================================================================
// Cross-Skill Pattern Detection
// ============================================================================

async function findRelatedFailures(
  store: MemoryStore,
  retriever: MemoryRetriever,
  skillId: string,
  failures: MemoryEntry[],
  scopeFilter?: string[],
): Promise<SkillReport["related_failures"]> {
  const related: SkillReport["related_failures"] = [];
  const seen = new Set<string>();

  // Only check top 5 failures to limit API calls
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
          skill_id: sid,
          similarity: r.score,
          shared_pattern: truncatePattern(failure.text),
        });
      }
    } catch {
      // Non-critical: skip if retrieval fails for one failure
    }
  }

  return related.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// ============================================================================
// Helpers
// ============================================================================

function truncatePattern(text: string): string {
  return text.slice(0, 120).replace(/\n/g, " ").trim();
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
