import type { MemoryEntry } from "./store.js";
import { parseReflectionMetadata } from "./reflection-metadata.js";
import { sanitizeReflectionSliceLines } from "./reflection-slices.js";
import { computeReflectionScore, normalizeReflectionLineForAggregation } from "./reflection-ranking.js";
import { getReflectionItemDecayDefaults, type ReflectionItemKind } from "./reflection-item-store.js";
import { filterByMaxAge, keepMostRecentPerNormalizedKey } from "./recall-engine.js";
import { normalizeReflectionSoftKey, normalizeReflectionStrictKey } from "./reflection-normalize.js";
import { aggregateReflectionGroups, type ReflectionScoredItem } from "./reflection-aggregation.js";
import { selectFinalReflectionRecallGroups } from "./reflection-recall-final-selection.js";

export interface ReflectionRecallOptions {
  agentId: string;
  includeKinds: ReflectionItemKind[];
  now?: number;
  topK?: number;
  maxAgeMs?: number;
  maxEntriesPerKey?: number;
  minScore?: number;
}

export interface ReflectionRecallRow {
  id: string;
  text: string;
  score: number;
  latestTs: number;
  kind: ReflectionItemKind;
  repeatCount: number;
}

interface WeightedReflectionLine {
  text: string;
  timestamp: number;
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
  usedFallback: boolean;
  kind: ReflectionItemKind;
}

interface ReflectionRecallScoredItem extends ReflectionScoredItem {
  kind: ReflectionItemKind;
}

export function rankDynamicReflectionRecallFromEntries(
  entries: MemoryEntry[],
  options: ReflectionRecallOptions,
): ReflectionRecallRow[] {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const includeKinds = options.includeKinds.length > 0 ? options.includeKinds : ["invariant"];
  const weighted = entries
    .map((entry) => ({ entry, metadata: parseReflectionMetadata(entry.metadata) }))
    .filter(({ metadata }) => metadata.type === "memory-reflection-item" && isOwnedByAgent(metadata, options.agentId))
    .flatMap(({ entry, metadata }) => {
      const kind = parseItemKind(metadata.itemKind);
      if (!kind || !includeKinds.includes(kind)) return [];
      const defaults = getReflectionItemDecayDefaults(kind);
      const timestamp = metadataTimestamp(metadata, entry.timestamp);
      const lines = sanitizeReflectionSliceLines([entry.text]);
      return lines.map((line) => ({
        text: line,
        kind,
        timestamp,
        midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
        k: readPositiveNumber(metadata.decayK, defaults.k),
        baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
        quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
        usedFallback: metadata.usedFallback === true,
      }));
    });

  const withinAge = filterByMaxAge({
    items: weighted,
    maxAgeMs: options.maxAgeMs,
    now,
    getTimestamp: (row) => row.timestamp,
  });

  const cappedPerKey = keepMostRecentPerNormalizedKey({
    items: withinAge,
    maxEntriesPerKey: options.maxEntriesPerKey,
    getTimestamp: (row) => row.timestamp,
    getNormalizedKey: (row) => `${row.kind}::${normalizeReflectionLineForAggregation(row.text)}`,
  });

  const scoredItems: ReflectionRecallScoredItem[] = [];

  for (const row of cappedPerKey) {
    const ageDays = Math.max(0, (now - row.timestamp) / 86_400_000);
    const score = computeReflectionScore({
      ageDays,
      midpointDays: row.midpointDays,
      k: row.k,
      baseWeight: row.baseWeight,
      quality: row.quality,
      usedFallback: row.usedFallback,
    });
    if (!Number.isFinite(score) || score <= 0) continue;

    const strictKey = normalizeReflectionStrictKey(row.text);
    if (!strictKey) continue;
    const partitionedStrictKey = `${row.kind}::${strictKey}`;
    const softKey = normalizeReflectionSoftKey(row.text) || strictKey;

    scoredItems.push({
      text: row.text,
      ts: row.timestamp,
      score,
      quality: row.quality,
      isFallback: row.usedFallback,
      strictKey: partitionedStrictKey,
      softKey,
      kind: row.kind,
    });
  }

  const groups = aggregateReflectionGroups(scoredItems, now);
  if (groups.length === 0) return [];
  const grouped = selectFinalReflectionRecallGroups(groups, {
    shortlistTarget: groups.length,
    finalTarget: groups.length,
    now,
  });
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;
  const rows = grouped
    .map((group) => {
      const representative = group.representative as ReflectionRecallScoredItem;
      const primary = (group.items[0] || representative) as ReflectionRecallScoredItem;
      return {
        id: `reflection:${group.strictKey}`,
        text: group.representative.text,
        score: Number(group.finalScore.toFixed(6)),
        latestTs: group.latestTs,
        kind: representative.kind || primary.kind || "invariant",
        repeatCount: group.repeatCount,
      };
    })
    .filter((row) => row.score >= minScore);

  const topK = Number.isFinite(options.topK) ? Math.max(1, Math.floor(Number(options.topK))) : rows.length;
  return rows.slice(0, topK);
}

function parseItemKind(value: unknown): ReflectionItemKind | null {
  if (value === "invariant" || value === "derived") return value;
  return null;
}

function isOwnedByAgent(metadata: Record<string, unknown>, agentId: string): boolean {
  const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";
  if (!owner) return true;
  return owner === agentId || owner === "main";
}

function metadataTimestamp(metadata: Record<string, unknown>, fallbackTs: number): number {
  const storedAt = Number(metadata.storedAt);
  if (Number.isFinite(storedAt) && storedAt > 0) return storedAt;
  return Number.isFinite(fallbackTs) ? fallbackTs : Date.now();
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function readClampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  const resolved = Number.isFinite(num) ? num : fallback;
  return Math.max(min, Math.min(max, resolved));
}
