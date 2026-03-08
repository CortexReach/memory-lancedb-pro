import type { RetrievalResult } from "./retriever.js";
import { normalizeRecallTextKey } from "./recall-engine.js";
import {
  DEFAULT_FINAL_SELECTION_FRESHNESS_HALF_LIFE_MS,
  type FinalSelectCandidate,
  type FinalSelectOverlapThreshold,
  type FinalSelectSemanticThreshold,
  selectFinalTopKSetwise,
} from "./final-topk-setwise-selection.js";

export interface AutoRecallFinalSelectionOptions {
  topK?: number;
  now?: number;
  shortlistLimit?: number;
}

const GENERIC_OVERLAP_THRESHOLDS: FinalSelectOverlapThreshold[] = [
  { minOverlap: 0.86, multiplier: 0.2 },
  { minOverlap: 0.72, multiplier: 0.45 },
  { minOverlap: 0.58, multiplier: 0.75 },
];

const GENERIC_SEMANTIC_THRESHOLDS: FinalSelectSemanticThreshold[] = [
  { minSimilarity: 0.985, multiplier: 0.25 },
  { minSimilarity: 0.96, multiplier: 0.45 },
  { minSimilarity: 0.93, multiplier: 0.7 },
];

export function selectFinalAutoRecallResults(
  results: RetrievalResult[],
  options: AutoRecallFinalSelectionOptions = {}
): RetrievalResult[] {
  if (!Array.isArray(results) || results.length === 0) return [];

  const finalLimit = Math.min(results.length, normalizeLimit(options.topK, results.length));
  if (finalLimit <= 0) return [];
  const shortlistLimit = Math.min(
    results.length,
    normalizeLimit(options.shortlistLimit, Math.max(finalLimit, finalLimit * 4))
  );

  const candidates: FinalSelectCandidate<RetrievalResult>[] = results.map((row) => {
    const normalizedKey = normalizeRecallTextKey(row.entry.text);
    return {
      id: row.entry.id,
      text: row.entry.text,
      baseScore: Number.isFinite(row.score) ? row.score : 0,
      ts: row.entry.timestamp,
      softKey: normalizedKey || undefined,
      normalizedKey: normalizedKey || undefined,
      category: row.entry.category,
      scope: row.entry.scope,
      embedding: normalizeEmbedding(row.entry.vector),
      raw: row,
    };
  });

  return selectFinalTopKSetwise(candidates, {
    finalLimit,
    shortlistLimit,
    now: options.now,
    freshnessHalfLifeMs: DEFAULT_FINAL_SELECTION_FRESHNESS_HALF_LIFE_MS,
    weights: {
      relevance: 1,
      freshness: 0.08,
      categoryCoverage: 0.05,
      scopeCoverage: 0.03,
    },
    penalties: {
      sameKeyMultiplier: 0.08,
      overlapThresholds: GENERIC_OVERLAP_THRESHOLDS,
      semanticThresholds: GENERIC_SEMANTIC_THRESHOLDS,
    },
  }).map((row) => row.raw);
}

function normalizeLimit(value: unknown, fallback: number): number {
  const resolved = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(1, Math.floor(resolved));
}

function normalizeEmbedding(value: unknown): number[] | undefined {
  if (value == null) return undefined;

  let raw: unknown[] = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    raw = Array.from(value as ArrayLike<unknown>);
  } else if (typeof value === "object" && Symbol.iterator in value) {
    try {
      raw = Array.from(value as Iterable<unknown>);
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }

  if (raw.length === 0) return undefined;

  const embedding: number[] = [];
  for (const item of raw) {
    const num = Number(item);
    if (!Number.isFinite(num)) return undefined;
    embedding.push(num);
  }

  return embedding.length > 0 ? embedding : undefined;
}
