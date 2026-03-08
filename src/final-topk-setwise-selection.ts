export interface FinalSelectCandidate<TRaw = unknown> {
  id: string;
  text: string;
  baseScore: number;
  raw: TRaw;
  ts?: number;
  softKey?: string;
  normalizedKey?: string;
  category?: string;
  scope?: string;
  sourceType?: string;
  entityTags?: string[];
  embedding?: number[];
}

export interface FinalSelectOverlapThreshold {
  minOverlap: number;
  multiplier: number;
}

export interface FinalSelectSemanticThreshold {
  minSimilarity: number;
  multiplier: number;
}

export interface FinalSelectWeights {
  relevance: number;
  freshness: number;
  categoryCoverage: number;
  scopeCoverage: number;
}

export interface FinalSelectPenalties {
  sameKeyMultiplier: number;
  overlapThresholds: FinalSelectOverlapThreshold[];
  semanticThresholds: FinalSelectSemanticThreshold[];
}

export interface FinalSelectConfig {
  shortlistLimit?: number;
  finalLimit?: number;
  now?: number;
  freshnessHalfLifeMs?: number;
  tokenMinLength?: number;
  weights?: Partial<FinalSelectWeights>;
  penalties?: Partial<FinalSelectPenalties>;
}

interface PreparedCandidate<TRaw = unknown> {
  candidate: FinalSelectCandidate<TRaw>;
  stableRank: number;
  ts: number;
  key: string;
  overlapTokens: string[];
  embedding?: number[];
}

const DAY_MS = 86_400_000;
const EPSILON = 1e-12;

const DEFAULT_WEIGHTS: FinalSelectWeights = {
  relevance: 1,
  freshness: 0,
  categoryCoverage: 0,
  scopeCoverage: 0,
};

const DEFAULT_PENALTIES: FinalSelectPenalties = {
  sameKeyMultiplier: 0.08,
  overlapThresholds: [],
  semanticThresholds: [],
};

export function buildFinalSelectionShortlist<TRaw = unknown>(
  candidates: FinalSelectCandidate<TRaw>[],
  config: FinalSelectConfig = {}
): FinalSelectCandidate<TRaw>[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const finalLimit = normalizeLimit(config.finalLimit, candidates.length);
  const shortlistLimit = Math.min(
    candidates.length,
    normalizeLimit(config.shortlistLimit, Math.max(finalLimit, finalLimit * 4))
  );
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => compareForPresort(a.candidate, b.candidate, a.index, b.index))
    .slice(0, shortlistLimit)
    .map(({ candidate }) => candidate);
}

export function selectFinalTopKSetwise<TRaw = unknown>(
  candidates: FinalSelectCandidate<TRaw>[],
  config: FinalSelectConfig = {}
): FinalSelectCandidate<TRaw>[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const finalLimit = Math.min(candidates.length, normalizeLimit(config.finalLimit, candidates.length));
  if (finalLimit <= 0) return [];

  const weights: FinalSelectWeights = {
    ...DEFAULT_WEIGHTS,
    ...(config.weights || {}),
  };
  const penalties: FinalSelectPenalties = {
    ...DEFAULT_PENALTIES,
    ...(config.penalties || {}),
    overlapThresholds: normalizeThresholds(config.penalties?.overlapThresholds),
    semanticThresholds: normalizeSemanticThresholds(config.penalties?.semanticThresholds),
  };
  const now = Number.isFinite(config.now) ? Number(config.now) : Date.now();
  const tokenMinLength = normalizeLimit(config.tokenMinLength, 3);
  const shortlist = buildFinalSelectionShortlist(candidates, {
    ...config,
    finalLimit,
  });

  const remaining: PreparedCandidate<TRaw>[] = shortlist.map((candidate, index) => {
    const key = normalizeKey(candidate);
    const overlapSeed = key || String(candidate.text || "");
    return {
      candidate,
      stableRank: index,
      ts: sanitizeTimestamp(candidate.ts, now),
      key,
      overlapTokens: tokenizeForOverlap(overlapSeed, tokenMinLength),
      embedding: sanitizeEmbedding(candidate.embedding),
    };
  });

  const selected: PreparedCandidate<TRaw>[] = [];
  const selectedKeys = new Set<string>();
  const selectedCategories = new Set<string>();
  const selectedScopes = new Set<string>();
  const selectedTokenSets: Set<string>[] = [];
  const selectedEmbeddings: number[][] = [];

  while (remaining.length > 0 && selected.length < finalLimit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const adjustedScore = computeAdjustedScore(candidate, {
        now,
        weights,
        penalties,
        selectedKeys,
        selectedCategories,
        selectedScopes,
        selectedTokenSets,
        selectedEmbeddings,
        freshnessHalfLifeMs: Number(config.freshnessHalfLifeMs),
      });

      if (adjustedScore > bestScore + EPSILON) {
        bestScore = adjustedScore;
        bestIndex = i;
        continue;
      }
      if (Math.abs(adjustedScore - bestScore) <= EPSILON) {
        const currentBest = remaining[bestIndex];
        if (candidate.stableRank < currentBest.stableRank) {
          bestIndex = i;
        }
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);

    if (chosen.key) selectedKeys.add(chosen.key);
    if (chosen.candidate.category) selectedCategories.add(chosen.candidate.category);
    if (chosen.candidate.scope) selectedScopes.add(chosen.candidate.scope);
    if (chosen.overlapTokens.length > 0) selectedTokenSets.push(new Set(chosen.overlapTokens));
    if (chosen.embedding && chosen.embedding.length > 0) selectedEmbeddings.push(chosen.embedding);
  }

  return selected.map((row) => row.candidate);
}

function computeAdjustedScore<TRaw>(
  candidate: PreparedCandidate<TRaw>,
  context: {
    now: number;
    freshnessHalfLifeMs: number;
    weights: FinalSelectWeights;
    penalties: FinalSelectPenalties;
    selectedKeys: Set<string>;
    selectedCategories: Set<string>;
    selectedScopes: Set<string>;
    selectedTokenSets: Set<string>[];
    selectedEmbeddings: number[][];
  }
): number {
  const baseScore = Number.isFinite(candidate.candidate.baseScore) ? candidate.candidate.baseScore : 0;
  const freshnessScore = computeFreshnessScore(candidate.ts, context.now, context.freshnessHalfLifeMs);

  let utility = (context.weights.relevance * baseScore)
    + (context.weights.freshness * freshnessScore);

  if (candidate.candidate.category && !context.selectedCategories.has(candidate.candidate.category)) {
    utility += context.weights.categoryCoverage;
  }
  if (candidate.candidate.scope && !context.selectedScopes.has(candidate.candidate.scope)) {
    utility += context.weights.scopeCoverage;
  }

  let multiplier = 1;
  if (candidate.key && context.selectedKeys.has(candidate.key)) {
    multiplier *= clampMultiplier(context.penalties.sameKeyMultiplier);
  }

  if (candidate.overlapTokens.length > 0 && context.selectedTokenSets.length > 0) {
    const candidateSet = new Set(candidate.overlapTokens);
    let maxOverlap = 0;
    for (const selectedSet of context.selectedTokenSets) {
      const overlap = jaccardSimilarity(candidateSet, selectedSet);
      if (overlap > maxOverlap) maxOverlap = overlap;
    }
    for (const threshold of context.penalties.overlapThresholds) {
      if (maxOverlap >= threshold.minOverlap) {
        multiplier *= clampMultiplier(threshold.multiplier);
        break;
      }
    }
  }

  if (candidate.embedding && context.selectedEmbeddings.length > 0) {
    let maxSimilarity = -1;
    for (const selectedEmbedding of context.selectedEmbeddings) {
      const similarity = cosineSimilarity(candidate.embedding, selectedEmbedding);
      if (similarity !== null && similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
    }

    if (maxSimilarity >= 0) {
      for (const threshold of context.penalties.semanticThresholds) {
        if (maxSimilarity >= threshold.minSimilarity) {
          multiplier *= clampMultiplier(threshold.multiplier);
          break;
        }
      }
    }
  }

  return utility * multiplier;
}

function compareForPresort<TRaw>(
  a: FinalSelectCandidate<TRaw>,
  b: FinalSelectCandidate<TRaw>,
  aIndex: number,
  bIndex: number
): number {
  const aScore = Number.isFinite(a.baseScore) ? a.baseScore : 0;
  const bScore = Number.isFinite(b.baseScore) ? b.baseScore : 0;
  if (bScore !== aScore) return bScore - aScore;

  const aTs = Number.isFinite(a.ts) ? Number(a.ts) : 0;
  const bTs = Number.isFinite(b.ts) ? Number(b.ts) : 0;
  if (bTs !== aTs) return bTs - aTs;

  const idOrder = String(a.id || "").localeCompare(String(b.id || ""));
  if (idOrder !== 0) return idOrder;

  const textOrder = String(a.text || "").localeCompare(String(b.text || ""));
  if (textOrder !== 0) return textOrder;

  return aIndex - bIndex;
}

function sanitizeTimestamp(value: unknown, fallback: number): number {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return fallback;
  return ts;
}

function computeFreshnessScore(ts: number, now: number, halfLifeMs: number): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  const ageMs = Math.max(0, now - ts);
  return Math.exp(-ageMs / halfLifeMs);
}

function normalizeKey<TRaw>(candidate: FinalSelectCandidate<TRaw>): string {
  const soft = String(candidate.softKey || "").trim();
  if (soft) return soft;
  const normalized = String(candidate.normalizedKey || "").trim();
  if (normalized) return normalized;
  return "";
}

function tokenizeForOverlap(value: string, tokenMinLength: number): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[_/\-\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= tokenMinLength);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 0;
  return intersection / union;
}

function normalizeLimit(value: unknown, fallback: number): number {
  const resolved = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(1, Math.floor(resolved));
}

function clampMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeThresholds(thresholds: unknown): FinalSelectOverlapThreshold[] {
  if (!Array.isArray(thresholds) || thresholds.length === 0) return DEFAULT_PENALTIES.overlapThresholds;
  return thresholds
    .map((row) => {
      const minOverlap = Number((row as FinalSelectOverlapThreshold).minOverlap);
      const multiplier = Number((row as FinalSelectOverlapThreshold).multiplier);
      if (!Number.isFinite(minOverlap) || minOverlap < 0 || minOverlap > 1) return null;
      if (!Number.isFinite(multiplier)) return null;
      return { minOverlap, multiplier: clampMultiplier(multiplier) };
    })
    .filter((row): row is FinalSelectOverlapThreshold => row !== null)
    .sort((a, b) => b.minOverlap - a.minOverlap);
}

function normalizeSemanticThresholds(thresholds: unknown): FinalSelectSemanticThreshold[] {
  if (!Array.isArray(thresholds) || thresholds.length === 0) return DEFAULT_PENALTIES.semanticThresholds;
  return thresholds
    .map((row) => {
      const minSimilarity = Number((row as FinalSelectSemanticThreshold).minSimilarity);
      const multiplier = Number((row as FinalSelectSemanticThreshold).multiplier);
      if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) return null;
      if (!Number.isFinite(multiplier)) return null;
      return { minSimilarity, multiplier: clampMultiplier(multiplier) };
    })
    .filter((row): row is FinalSelectSemanticThreshold => row !== null)
    .sort((a, b) => b.minSimilarity - a.minSimilarity);
}

function sanitizeEmbedding(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const embedding: number[] = [];
  for (const item of value) {
    const num = Number(item);
    if (!Number.isFinite(num)) return undefined;
    embedding.push(num);
  }
  return embedding.length > 0 ? embedding : undefined;
}

function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA <= 0 || normB <= 0) return null;
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(score)) return null;
  return Math.max(-1, Math.min(1, score));
}

export const DEFAULT_FINAL_SELECTION_FRESHNESS_HALF_LIFE_MS = 14 * DAY_MS;
