export const REFLECTION_FALLBACK_SCORE_FACTOR = 0.75;

export interface ReflectionScoreInput {
  ageDays: number;
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
  usedFallback: boolean;
}

export function computeReflectionLogistic(ageDays: number, midpointDays: number, k: number): number {
  const safeAgeDays = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
  const safeMidpointDays = Number.isFinite(midpointDays) && midpointDays > 0 ? midpointDays : 1;
  const safeK = Number.isFinite(k) && k > 0 ? k : 0.1;
  return 1 / (1 + Math.exp(safeK * (safeAgeDays - safeMidpointDays)));
}

export function computeReflectionScore(input: ReflectionScoreInput): number {
  const logistic = computeReflectionLogistic(input.ageDays, input.midpointDays, input.k);
  const baseWeight = Number.isFinite(input.baseWeight) && input.baseWeight > 0 ? input.baseWeight : 1;
  const quality = Number.isFinite(input.quality) ? Math.max(0, Math.min(1, input.quality)) : 1;
  const fallbackFactor = input.usedFallback ? REFLECTION_FALLBACK_SCORE_FACTOR : 1;
  return logistic * baseWeight * quality * fallbackFactor;
}

export function normalizeReflectionLineForAggregation(line: string): string {
  return String(line)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
