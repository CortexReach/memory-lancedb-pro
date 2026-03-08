import type { ReflectionGroup } from "./reflection-aggregation.js";
import {
  type FinalSelectCandidate,
  type FinalSelectOverlapThreshold,
  selectFinalTopKSetwise,
} from "./final-topk-setwise-selection.js";

interface ReflectionFinalSelectionOptions {
  shortlistTarget?: number;
  finalTarget?: number;
  now?: number;
}

const REFLECTION_OVERLAP_THRESHOLDS: FinalSelectOverlapThreshold[] = [
  { minOverlap: 0.85, multiplier: 0.12 },
  { minOverlap: 0.70, multiplier: 0.35 },
  { minOverlap: 0.55, multiplier: 0.7 },
];

export function selectFinalReflectionRecallGroups(
  groups: ReflectionGroup[],
  options: ReflectionFinalSelectionOptions = {}
): ReflectionGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const finalTarget = Math.min(groups.length, normalizeLimit(options.finalTarget, groups.length));
  const shortlistTarget = Math.min(groups.length, normalizeLimit(options.shortlistTarget, groups.length));
  if (finalTarget <= 0) return [];

  const candidates: FinalSelectCandidate<ReflectionGroup>[] = groups.map((group) => ({
    id: group.strictKey,
    text: group.representative.text,
    baseScore: Number.isFinite(group.finalScore) ? group.finalScore : 0,
    ts: group.latestTs,
    softKey: group.softKey || group.strictKey,
    normalizedKey: group.strictKey,
    raw: group,
  }));

  return selectFinalTopKSetwise(candidates, {
    shortlistLimit: shortlistTarget,
    finalLimit: finalTarget,
    now: options.now,
    weights: {
      relevance: 1,
      freshness: 0,
      categoryCoverage: 0,
      scopeCoverage: 0,
    },
    penalties: {
      sameKeyMultiplier: 0.08,
      overlapThresholds: REFLECTION_OVERLAP_THRESHOLDS,
    },
  }).map((row) => row.raw);
}

function normalizeLimit(value: unknown, fallback: number): number {
  const resolved = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(1, Math.floor(resolved));
}
