const DAY_MS = 86_400_000;
const BURST_GAP_MS = 6 * 60 * 60 * 1000;

export interface ReflectionScoredItem {
  text: string;
  ts: number;
  score: number;
  quality: number;
  isFallback: boolean;
  strictKey: string;
  softKey: string;
}

export interface ReflectionGroup {
  strictKey: string;
  softKey: string;
  items: ReflectionScoredItem[];
  repeatCount: number;
  latestTs: number;
  representative: ReflectionScoredItem;
  baseScore: number;
  supportScore: number;
  freshnessScore: number;
  stabilityScore: number;
  qualityScore: number;
  finalScore: number;
}

export function aggregateReflectionGroups(items: ReflectionScoredItem[], now: number): ReflectionGroup[] {
  const byStrictKey = new Map<string, ReflectionScoredItem[]>();
  for (const item of items) {
    if (!item.strictKey) continue;
    if (!Number.isFinite(item.score) || item.score <= 0) continue;
    const ts = Number.isFinite(item.ts) ? item.ts : now;
    const next = {
      ...item,
      ts,
      quality: clamp(item.quality, 0.2, 1),
      softKey: item.softKey || item.strictKey,
    };
    const list = byStrictKey.get(item.strictKey);
    if (!list) {
      byStrictKey.set(item.strictKey, [next]);
      continue;
    }
    list.push(next);
  }

  return [...byStrictKey.entries()].map(([strictKey, groupedItems]) => {
    const itemsByRecency = [...groupedItems].sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      if (b.score !== a.score) return b.score - a.score;
      return a.text.localeCompare(b.text);
    });
    const repeatCount = itemsByRecency.length;
    const latestTs = itemsByRecency[0]?.ts ?? now;
    const representative = pickRepresentative(itemsByRecency, latestTs);
    const softKey = dominantSoftKey(itemsByRecency, representative.softKey || strictKey);

    const topScores = itemsByRecency.map((item) => item.score).sort((a, b) => b - a);
    const maxItemScore = topScores[0] ?? 0;
    const top2MeanScore = topScores.length > 1
      ? ((topScores[0] ?? 0) + (topScores[1] ?? 0)) / 2
      : maxItemScore;
    const baseScore = 0.7 * maxItemScore + 0.3 * top2MeanScore;

    const supportScore = 1 - Math.exp(-repeatCount / 2.5);
    const latestAgeDays = Math.max(0, (now - latestTs) / DAY_MS);
    const freshnessScore = Math.exp(-latestAgeDays / 7);
    const densityScore = computeDensityScore(itemsByRecency);
    const burstPenalty = computeBurstPenalty(itemsByRecency);
    const stabilityScore = Math.max(0, 0.7 * densityScore + 0.3 * supportScore - burstPenalty);
    const qualityScore = clamp(representative.quality, 0.2, 1);
    const finalScore = (0.50 * baseScore)
      + (0.16 * supportScore)
      + (0.12 * freshnessScore)
      + (0.16 * stabilityScore)
      + (0.06 * qualityScore);

    return {
      strictKey,
      softKey,
      items: itemsByRecency,
      repeatCount,
      latestTs,
      representative,
      baseScore,
      supportScore,
      freshnessScore,
      stabilityScore,
      qualityScore,
      finalScore,
    };
  });
}

function pickRepresentative(items: ReflectionScoredItem[], latestTs: number): ReflectionScoredItem {
  const maxScore = items.reduce((max, item) => Math.max(max, item.score), 0);
  const scored = items.map((item) => ({
    item,
    score: representativeUtility(item, { maxScore, latestTs }),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.item.ts !== a.item.ts) return b.item.ts - a.item.ts;
    if (a.item.text.length !== b.item.text.length) return a.item.text.length - b.item.text.length;
    return a.item.text.localeCompare(b.item.text);
  });

  return scored[0]?.item ?? items[0];
}

function representativeUtility(
  item: ReflectionScoredItem,
  options: { maxScore: number; latestTs: number }
): number {
  const normalizedScore = options.maxScore > 0 ? item.score / options.maxScore : 0;
  const recencyScore = Math.exp(-Math.max(0, options.latestTs - item.ts) / (3 * DAY_MS));
  const fallbackPenalty = item.isFallback ? 0.18 : 0;
  const verbosityPenalty = item.text.length > 180 ? 0.04 : 0;
  return (0.56 * normalizedScore) + (0.24 * clamp(item.quality, 0.2, 1)) + (0.20 * recencyScore) - fallbackPenalty - verbosityPenalty;
}

function dominantSoftKey(items: ReflectionScoredItem[], fallback: string): string {
  const totals = new Map<string, { score: number; count: number }>();
  for (const item of items) {
    const key = item.softKey || fallback;
    const current = totals.get(key) || { score: 0, count: 0 };
    current.score += item.score;
    current.count += 1;
    totals.set(key, current);
  }

  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1].score !== a[1].score) return b[1].score - a[1].score;
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]?.[0] || fallback;
}

function computeDensityScore(items: ReflectionScoredItem[]): number {
  if (items.length === 0) return 0;
  const uniqueDays = new Set(items.map((item) => Math.floor(item.ts / DAY_MS))).size;
  return clamp(uniqueDays / items.length, 0, 1);
}

function computeBurstPenalty(items: ReflectionScoredItem[]): number {
  if (items.length < 3) return 0;
  const byTimeAsc = [...items].sort((a, b) => a.ts - b.ts);
  let shortGapCount = 0;
  for (let i = 1; i < byTimeAsc.length; i += 1) {
    if (byTimeAsc[i].ts - byTimeAsc[i - 1].ts <= BURST_GAP_MS) shortGapCount += 1;
  }

  const shortGapRatio = shortGapCount / Math.max(1, byTimeAsc.length - 1);
  const sameDayRatio = 1 - computeDensityScore(items);
  return Math.min(0.35, (shortGapRatio * 0.24) + (sameDayRatio * 0.16));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
