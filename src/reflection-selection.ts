import type { ReflectionGroup } from "./reflection-aggregation.js";

export const DERIVED_FOCUS_V2_SHORTLIST_TARGET = 36;
export const DERIVED_FOCUS_V2_FINAL_TARGET = 13;

interface ReflectionSelectionOptions {
  shortlistTarget?: number;
  finalTarget?: number;
}

export function buildReflectionShortlist(
  groups: ReflectionGroup[],
  shortlistTarget: number = DERIVED_FOCUS_V2_SHORTLIST_TARGET
): ReflectionGroup[] {
  const target = normalizeLimit(shortlistTarget, DERIVED_FOCUS_V2_SHORTLIST_TARGET);
  return [...groups]
    .sort(compareGroups)
    .slice(0, target);
}

export function buildDiversityAwareReflectionOrder(shortlist: ReflectionGroup[]): ReflectionGroup[] {
  const ranked = [...shortlist].sort(compareGroups);
  const order: ReflectionGroup[] = [];
  const selectedSoftKeys = new Set<string>();

  while (ranked.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i += 1) {
      const adjusted = adjustedDiversityScore(ranked[i], order, selectedSoftKeys);
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }

    const [chosen] = ranked.splice(bestIndex, 1);
    order.push(chosen);
    if (chosen.softKey) selectedSoftKeys.add(chosen.softKey);
  }

  return order;
}

export function selectDiversityAwareReflectionGroups(
  groups: ReflectionGroup[],
  options?: ReflectionSelectionOptions
): ReflectionGroup[] {
  const shortlist = buildReflectionShortlist(groups, options?.shortlistTarget);
  const diversityOrdered = buildDiversityAwareReflectionOrder(shortlist);
  const finalTarget = normalizeLimit(options?.finalTarget, DERIVED_FOCUS_V2_FINAL_TARGET);
  return diversityOrdered.slice(0, finalTarget);
}

function adjustedDiversityScore(
  candidate: ReflectionGroup,
  selected: ReflectionGroup[],
  selectedSoftKeys: Set<string>
): number {
  if (selected.length === 0) return candidate.finalScore;

  let multiplier = 1;
  if (candidate.softKey && selectedSoftKeys.has(candidate.softKey)) multiplier *= 0.08;

  const candidateTokens = tokenizeSoftKey(candidate.softKey);
  let maxOverlap = 0;
  for (const picked of selected) {
    const overlap = jaccardSimilarity(candidateTokens, tokenizeSoftKey(picked.softKey));
    if (overlap > maxOverlap) maxOverlap = overlap;
  }

  if (maxOverlap >= 0.85) multiplier *= 0.12;
  else if (maxOverlap >= 0.70) multiplier *= 0.35;
  else if (maxOverlap >= 0.55) multiplier *= 0.7;

  return candidate.finalScore * multiplier;
}

function tokenizeSoftKey(softKey: string): string[] {
  return String(softKey || "")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  if (union === 0) return 0;
  return intersection / union;
}

function compareGroups(a: ReflectionGroup, b: ReflectionGroup): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs;
  return a.representative.text.localeCompare(b.representative.text);
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(Number(value)));
}
