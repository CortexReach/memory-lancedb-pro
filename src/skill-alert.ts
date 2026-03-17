/**
 * Skill Alert System
 *
 * Checks skill health against thresholds and generates alerts.
 * Manages cooldown periods per skill per scope to avoid noise.
 */

import type { MemoryStore } from "./store.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillAlert {
  priority: "critical" | "warn" | "trend";
  message: string;
  evidenceSummary: string;
  suggestedActions: string[];
}

interface SkillObsConfig {
  alertThreshold?: "critical" | "warn" | "trend";
  minObservations?: number;
  cooldownDays?: number;
  successRateWarn?: number;
  successRateCritical?: number;
  trendDeclineRate?: number;
}

interface AggregatedObs {
  total: number;
  successRate: number;
  recentRate: number;
  historicalRate: number;
  topFailures: Array<{ pattern: string; count: number }>;
  topCorrections: string[];
}

// ============================================================================
// Core
// ============================================================================

export async function checkSkillAlert(
  store: MemoryStore,
  skillId: string,
  scopeFilter: string[],
  skillObsConfig?: SkillObsConfig,
): Promise<SkillAlert | null> {
  const minObservations = skillObsConfig?.minObservations ?? 5;
  const successRateWarn = skillObsConfig?.successRateWarn ?? 0.7;
  const successRateCritical = skillObsConfig?.successRateCritical ?? 0.5;
  const trendDeclineRate = skillObsConfig?.trendDeclineRate ?? 0.15;
  const cooldownDays = skillObsConfig?.cooldownDays ?? 7;
  const alertThreshold = skillObsConfig?.alertThreshold ?? "warn";

  const obs = await aggregateObservations(store, skillId, scopeFilter);

  if (obs.total < minObservations) return null;

  // Cooldown: check if we already alerted recently for this skill in this scope
  const lastAlert = await getLastAlert(store, skillId, scopeFilter);
  if (lastAlert) {
    const daysSince = (Date.now() - lastAlert.timestamp) / 86400_000;
    if (daysSince < cooldownDays) return null;
  }

  // Determine priority
  let priority: "critical" | "warn" | "trend" | null = null;

  if (obs.successRate < successRateCritical) {
    priority = "critical";
  } else if (obs.successRate < successRateWarn) {
    priority = "warn";
  } else if (obs.recentRate < obs.historicalRate - trendDeclineRate) {
    priority = "trend";
  }

  if (!priority) return null;

  // alertThreshold filtering
  const levelOrder = { critical: 3, warn: 2, trend: 1 } as const;
  if (levelOrder[priority] < levelOrder[alertThreshold]) return null;

  return buildAlert(priority, skillId, obs);
}

/**
 * Get pending (unacknowledged) skill suggestions for a scope.
 */
export async function getPendingSuggestions(
  store: MemoryStore,
  scopeFilter: string[],
): Promise<Array<{ id: string; text: string; meta: Record<string, unknown> }>> {
  const entries = await store.list(scopeFilter, "other", 100, 0);
  const pending: Array<{
    id: string;
    text: string;
    meta: Record<string, unknown>;
  }> = [];

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.skill_obs_type !== "suggestion") continue;
    if (meta.acknowledged === true) continue;
    pending.push({ id: entry.id, text: entry.text, meta });
  }

  return pending;
}

// ============================================================================
// Internals
// ============================================================================

async function aggregateObservations(
  store: MemoryStore,
  skillId: string,
  scopeFilter: string[],
): Promise<AggregatedObs> {
  const entries = await store.list(scopeFilter, "other", 1000, 0);
  const now = Date.now();
  const d7 = now - 7 * 86400_000;

  const all: Array<{ meta: Record<string, unknown>; ts: number }> = [];
  const recent: typeof all = [];

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.skill_obs_type !== "observation") continue;
    if (meta.skill_id !== skillId) continue;
    all.push({ meta, ts: entry.timestamp });
    if (entry.timestamp >= d7) recent.push({ meta, ts: entry.timestamp });
  }

  if (all.length === 0) {
    return {
      total: 0,
      successRate: 0,
      recentRate: 0,
      historicalRate: 0,
      topFailures: [],
      topCorrections: [],
    };
  }

  const calcRate = (obs: typeof all) => {
    if (obs.length === 0) return 0;
    return obs.filter((o) => o.meta.outcome === "success").length / obs.length;
  };

  // Failure patterns
  const patternCounts = new Map<string, number>();
  const corrections: string[] = [];

  for (const o of all) {
    if (o.meta.outcome === "success") continue;
    const chains = o.meta.error_chain as string[] | undefined;
    const userCorrs = o.meta.user_corrections as string[] | undefined;

    for (const c of chains || []) {
      const p = c.slice(0, 120).replace(/\n/g, " ").trim();
      patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
    }
    for (const c of userCorrs || []) {
      corrections.push(c.slice(0, 200));
    }
  }

  const topFailures = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pattern, count]) => ({ pattern, count }));

  // Historical baseline: exclude recent 7d to avoid self-dilution
  const historical = all.filter((o) => o.ts < d7);
  const historicalRate =
    historical.length >= 3 ? calcRate(historical) : calcRate(all);

  return {
    total: all.length,
    successRate: calcRate(all),
    recentRate: calcRate(recent),
    historicalRate,
    topFailures,
    topCorrections: corrections.slice(0, 3),
  };
}

async function getLastAlert(
  store: MemoryStore,
  skillId: string,
  scopeFilter: string[],
): Promise<{ timestamp: number } | null> {
  const entries = await store.list(scopeFilter, "other", 100, 0);

  let latest: number | null = null;
  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.skill_obs_type !== "suggestion") continue;
    if (meta.skill_id !== skillId) continue;
    if (latest === null || entry.timestamp > latest) {
      latest = entry.timestamp;
    }
  }

  return latest !== null ? { timestamp: latest } : null;
}

function buildAlert(
  priority: "critical" | "warn" | "trend",
  skillId: string,
  obs: AggregatedObs,
): SkillAlert {
  const topFailure = obs.topFailures[0];
  const topCorrection = obs.topCorrections[0];

  const pct = (rate: number) => `${(rate * 100).toFixed(0)}%`;

  switch (priority) {
    case "critical":
      return {
        priority,
        message:
          `skill "${skillId}" success rate is only ${pct(obs.successRate)} over ${obs.total} observations. ` +
          (topFailure
            ? `Main failure: ${topFailure.pattern} (${topFailure.count}x). `
            : "") +
          (topCorrection ? `User corrected: "${topCorrection}". ` : "") +
          `Consider reviewing this skill with skill_evidence.`,
        evidenceSummary: `${obs.total} observations, ${pct(obs.successRate)} success rate`,
        suggestedActions: topFailure
          ? [`Address failure pattern: ${topFailure.pattern}`]
          : ["Review recent failures"],
      };

    case "warn":
      return {
        priority,
        message:
          `skill "${skillId}" success rate is ${pct(obs.successRate)}. ` +
          (topFailure ? `Known issue: ${topFailure.pattern}.` : ""),
        evidenceSummary: `${obs.total} observations, ${pct(obs.successRate)} success rate`,
        suggestedActions: topFailure
          ? [`Watch for: ${topFailure.pattern}`]
          : ["Monitor performance"],
      };

    case "trend":
      return {
        priority,
        message: `skill "${skillId}" recent 7d success rate (${pct(obs.recentRate)}) is below historical average (${pct(obs.historicalRate)}).`,
        evidenceSummary: `Recent: ${pct(obs.recentRate)}, Historical: ${pct(obs.historicalRate)}`,
        suggestedActions: ["Investigate recent decline"],
      };
  }
}
