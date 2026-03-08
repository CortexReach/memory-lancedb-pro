import type { MemoryEntry } from "./store.js";
import {
  extractReflectionSliceItems,
  extractReflectionSlices,
  sanitizeReflectionSliceLines,
  type ReflectionSlices,
} from "./reflection-slices.js";
import { parseReflectionMetadata } from "./reflection-metadata.js";
import { buildReflectionEventPayload, createReflectionEventId } from "./reflection-event-store.js";
import {
  buildReflectionItemPayloads,
  getReflectionItemDecayDefaults,
  REFLECTION_DERIVED_DECAY_K,
  REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
  REFLECTION_INVARIANT_DECAY_K,
  REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
} from "./reflection-item-store.js";
import { getReflectionMappedDecayDefaults, type ReflectionMappedKind } from "./reflection-mapped-metadata.js";
import { computeReflectionScore, normalizeReflectionLineForAggregation } from "./reflection-ranking.js";
import { aggregateReflectionGroups, type ReflectionScoredItem } from "./reflection-aggregation.js";
import { normalizeReflectionSoftKey, normalizeReflectionStrictKey } from "./reflection-normalize.js";
import {
  DERIVED_FOCUS_V2_FINAL_TARGET,
  DERIVED_FOCUS_V2_SHORTLIST_TARGET,
  selectDiversityAwareReflectionGroups,
} from "./reflection-selection.js";

export const DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const LEGACY_REFLECTION_DERIVED_SLICE_LIMIT = 10;
export const DEFAULT_REFLECTION_DERIVED_SHORTLIST_LIMIT = DERIVED_FOCUS_V2_SHORTLIST_TARGET;
export const DEFAULT_REFLECTION_DERIVED_FINAL_LIMIT = DERIVED_FOCUS_V2_FINAL_TARGET;

type ReflectionStoreKind = "event" | "item-invariant" | "item-derived";

type ReflectionErrorSignalLike = {
  signatureHash: string;
};

interface ReflectionStorePayload {
  text: string;
  metadata: Record<string, unknown>;
  kind: ReflectionStoreKind;
}

interface BuildReflectionStorePayloadsParams {
  reflectionText: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  command: string;
  scope: string;
  toolErrorSignals: ReflectionErrorSignalLike[];
  runAt: number;
  usedFallback: boolean;
  eventId?: string;
  sourceReflectionPath?: string;
}

export function buildReflectionStorePayloads(params: BuildReflectionStorePayloadsParams): {
  eventId: string;
  slices: ReflectionSlices;
  payloads: ReflectionStorePayload[];
} {
  const slices = extractReflectionSlices(params.reflectionText);
  const eventId = params.eventId || createReflectionEventId({
    runAt: params.runAt,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    command: params.command,
  });

  const payloads: ReflectionStorePayload[] = [
    buildReflectionEventPayload({
      eventId,
      scope: params.scope,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      command: params.command,
      toolErrorSignals: params.toolErrorSignals,
      runAt: params.runAt,
      usedFallback: params.usedFallback,
      sourceReflectionPath: params.sourceReflectionPath,
    }),
  ];

  const itemPayloads = buildReflectionItemPayloads({
    items: extractReflectionSliceItems(params.reflectionText),
    eventId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runAt: params.runAt,
    usedFallback: params.usedFallback,
    toolErrorSignals: params.toolErrorSignals,
    sourceReflectionPath: params.sourceReflectionPath,
  });
  payloads.push(...itemPayloads);

  return { eventId, slices, payloads };
}

interface ReflectionStoreDeps {
  embedPassage: (text: string) => Promise<number[]>;
  store: (entry: Omit<MemoryEntry, "id" | "timestamp">) => Promise<MemoryEntry>;
}

interface StoreReflectionToLanceDBParams extends BuildReflectionStorePayloadsParams, ReflectionStoreDeps {
}

export async function storeReflectionToLanceDB(params: StoreReflectionToLanceDBParams): Promise<{
  stored: boolean;
  eventId: string;
  slices: ReflectionSlices;
  storedKinds: ReflectionStoreKind[];
}> {
  const { eventId, slices, payloads } = buildReflectionStorePayloads(params);
  const storedKinds: ReflectionStoreKind[] = [];

  for (const payload of payloads) {
    const vector = await params.embedPassage(payload.text);

    await params.store({
      text: payload.text,
      vector,
      category: "reflection",
      scope: params.scope,
      importance: resolveReflectionImportance(payload.kind),
      metadata: JSON.stringify(payload.metadata),
    });
    storedKinds.push(payload.kind);
  }

  return { stored: storedKinds.length > 0, eventId, slices, storedKinds };
}

function resolveReflectionImportance(kind: ReflectionStoreKind): number {
  if (kind === "event") return 0.55;
  if (kind === "item-invariant") return 0.82;
  return 0.78;
}

export interface LoadReflectionSlicesParams {
  entries: MemoryEntry[];
  agentId: string;
  now?: number;
  deriveMaxAgeMs?: number;
  invariantMaxAgeMs?: number;
}

export interface ScoredReflectionLine {
  text: string;
  score: number;
  latestTs: number;
}

export function loadAgentReflectionSlicesFromEntries(params: LoadReflectionSlicesParams): {
  invariants: string[];
  derived: string[];
} {
  const ranked = loadAgentReflectionRankedSlicesFromEntries(params, {
    derivedShortlistLimit: LEGACY_REFLECTION_DERIVED_SLICE_LIMIT,
    derivedFinalLimit: LEGACY_REFLECTION_DERIVED_SLICE_LIMIT,
  });
  return {
    invariants: ranked.invariants.map((row) => row.text),
    derived: ranked.derived.map((row) => row.text),
  };
}

export function loadAgentDerivedRowsWithScoresFromEntries(
  params: LoadReflectionSlicesParams & { limit?: number; finalLimit?: number }
): ScoredReflectionLine[] {
  const shortlistLimit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(Number(params.limit)))
    : DEFAULT_REFLECTION_DERIVED_SHORTLIST_LIMIT;
  const finalLimit = Number.isFinite(params.finalLimit)
    ? Math.max(1, Math.floor(Number(params.finalLimit)))
    : shortlistLimit;
  const ranked = loadAgentReflectionRankedSlicesFromEntries(params, {
    derivedShortlistLimit: shortlistLimit,
    derivedFinalLimit: finalLimit,
  });
  return ranked.derived;
}

export function loadAgentDerivedFocusRowsForHandoffFromEntries(
  params: LoadReflectionSlicesParams & {
    shortlistLimit?: number;
    finalLimit?: number;
  }
): ScoredReflectionLine[] {
  const shortlistLimit = Number.isFinite(params.shortlistLimit)
    ? Math.max(1, Math.floor(Number(params.shortlistLimit)))
    : DEFAULT_REFLECTION_DERIVED_SHORTLIST_LIMIT;
  const finalLimit = Number.isFinite(params.finalLimit)
    ? Math.max(1, Math.floor(Number(params.finalLimit)))
    : DEFAULT_REFLECTION_DERIVED_FINAL_LIMIT;

  return loadAgentDerivedRowsWithScoresFromEntries({
    ...params,
    limit: shortlistLimit,
    finalLimit,
  });
}

function loadAgentReflectionRankedSlicesFromEntries(
  params: LoadReflectionSlicesParams,
  options?: { derivedShortlistLimit?: number; derivedFinalLimit?: number }
): {
  invariants: ScoredReflectionLine[];
  derived: ScoredReflectionLine[];
} {
  const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const deriveMaxAgeMs = Number.isFinite(params.deriveMaxAgeMs)
    ? Math.max(0, Number(params.deriveMaxAgeMs))
    : DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS;
  const invariantMaxAgeMs = Number.isFinite(params.invariantMaxAgeMs)
    ? Math.max(0, Number(params.invariantMaxAgeMs))
    : undefined;

  const reflectionRows = params.entries
    .map((entry) => ({ entry, metadata: parseReflectionMetadata(entry.metadata) }))
    .filter(({ metadata }) => isReflectionMetadataType(metadata.type) && isOwnedByAgent(metadata, params.agentId))
    .sort((a, b) => b.entry.timestamp - a.entry.timestamp)
    .slice(0, 160);

  const itemRows = reflectionRows.filter(({ metadata }) => metadata.type === "memory-reflection-item");
  const invariantCandidates = buildInvariantCandidates(itemRows);
  const derivedCandidates = buildDerivedCandidates(itemRows);
  const derivedShortlistLimit = Number.isFinite(options?.derivedShortlistLimit)
    ? Math.max(1, Math.floor(Number(options?.derivedShortlistLimit)))
    : LEGACY_REFLECTION_DERIVED_SLICE_LIMIT;
  const derivedFinalLimit = Number.isFinite(options?.derivedFinalLimit)
    ? Math.max(1, Math.floor(Number(options?.derivedFinalLimit)))
    : derivedShortlistLimit;

  const invariants = rankReflectionLineScoresLinear(invariantCandidates, {
    now,
    maxAgeMs: invariantMaxAgeMs,
    limit: 8,
  });

  const derived = rankDerivedReflectionLineScoresV2(derivedCandidates, {
    now,
    maxAgeMs: deriveMaxAgeMs,
    shortlistLimit: derivedShortlistLimit,
    finalLimit: derivedFinalLimit,
  });

  return { invariants, derived };
}

type WeightedLineCandidate = {
  line: string;
  timestamp: number;
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
  usedFallback: boolean;
};

function buildInvariantCandidates(
  itemRows: Array<{ entry: MemoryEntry; metadata: Record<string, unknown> }>
): WeightedLineCandidate[] {
  return itemRows
    .filter(({ metadata }) => metadata.itemKind === "invariant")
    .flatMap(({ entry, metadata }) => {
      const lines = sanitizeReflectionSliceLines([entry.text]);
      if (lines.length === 0) return [];

      const defaults = getReflectionItemDecayDefaults("invariant");
      const timestamp = metadataTimestamp(metadata, entry.timestamp);
      return lines.map((line) => ({
        line,
        timestamp,
        midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
        k: readPositiveNumber(metadata.decayK, defaults.k),
        baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
        quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
        usedFallback: metadata.usedFallback === true,
      }));
    });
}

function buildDerivedCandidates(
  itemRows: Array<{ entry: MemoryEntry; metadata: Record<string, unknown> }>
): WeightedLineCandidate[] {
  return itemRows
    .filter(({ metadata }) => metadata.itemKind === "derived")
    .flatMap(({ entry, metadata }) => {
      const lines = sanitizeReflectionSliceLines([entry.text]);
      if (lines.length === 0) return [];

      const defaults = getReflectionItemDecayDefaults("derived");
      const timestamp = metadataTimestamp(metadata, entry.timestamp);
      return lines.map((line) => ({
        line,
        timestamp,
        midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
        k: readPositiveNumber(metadata.decayK, defaults.k),
        baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
        quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
        usedFallback: metadata.usedFallback === true,
      }));
    });
}

function rankReflectionLineScoresLinear(
  candidates: WeightedLineCandidate[],
  options: { now: number; maxAgeMs?: number; limit: number }
): ScoredReflectionLine[] {
  type WeightedLine = { line: string; score: number; latestTs: number };
  const lineScores = new Map<string, WeightedLine>();

  for (const candidate of candidates) {
    const timestamp = Number.isFinite(candidate.timestamp) ? candidate.timestamp : options.now;
    if (Number.isFinite(options.maxAgeMs) && options.maxAgeMs! >= 0 && options.now - timestamp > options.maxAgeMs!) {
      continue;
    }

    const ageDays = Math.max(0, (options.now - timestamp) / 86_400_000);
    const score = computeReflectionScore({
      ageDays,
      midpointDays: candidate.midpointDays,
      k: candidate.k,
      baseWeight: candidate.baseWeight,
      quality: candidate.quality,
      usedFallback: candidate.usedFallback,
    });
    if (!Number.isFinite(score) || score <= 0) continue;

    const key = normalizeReflectionLineForAggregation(candidate.line);
    if (!key) continue;

    const current = lineScores.get(key);
    if (!current) {
      lineScores.set(key, { line: candidate.line, score, latestTs: timestamp });
      continue;
    }

    current.score += score;
    if (timestamp > current.latestTs) {
      current.latestTs = timestamp;
      current.line = candidate.line;
    }
  }

  return [...lineScores.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs;
      return a.line.localeCompare(b.line);
    })
    .slice(0, options.limit)
    .map((item) => ({
      text: item.line,
      score: Number(item.score.toFixed(6)),
      latestTs: item.latestTs,
    }));
}

function rankDerivedReflectionLineScoresV2(
  candidates: WeightedLineCandidate[],
  options: { now: number; maxAgeMs?: number; shortlistLimit: number; finalLimit: number }
): ScoredReflectionLine[] {
  const scoredItems: ReflectionScoredItem[] = [];
  for (const candidate of candidates) {
    const timestamp = Number.isFinite(candidate.timestamp) ? candidate.timestamp : options.now;
    if (Number.isFinite(options.maxAgeMs) && options.maxAgeMs! >= 0 && options.now - timestamp > options.maxAgeMs!) {
      continue;
    }

    const ageDays = Math.max(0, (options.now - timestamp) / 86_400_000);
    const score = computeReflectionScore({
      ageDays,
      midpointDays: candidate.midpointDays,
      k: candidate.k,
      baseWeight: candidate.baseWeight,
      quality: candidate.quality,
      usedFallback: candidate.usedFallback,
    });
    if (!Number.isFinite(score) || score <= 0) continue;

    const strictKey = normalizeReflectionStrictKey(candidate.line);
    if (!strictKey) continue;
    const softKey = normalizeReflectionSoftKey(candidate.line) || strictKey;

    scoredItems.push({
      text: candidate.line,
      ts: timestamp,
      score,
      quality: candidate.quality,
      isFallback: candidate.usedFallback,
      strictKey,
      softKey,
    });
  }

  if (scoredItems.length === 0) return [];

  const groups = aggregateReflectionGroups(scoredItems, options.now);
  const selected = selectDiversityAwareReflectionGroups(groups, {
    shortlistTarget: options.shortlistLimit,
    finalTarget: options.finalLimit,
  });

  return selected
    .filter((group) => Number.isFinite(group.finalScore) && group.finalScore > 0)
    .map((group) => ({
      text: group.representative.text,
      score: Number(group.finalScore.toFixed(6)),
      latestTs: group.latestTs,
    }));
}

function isReflectionMetadataType(type: unknown): boolean {
  return type === "memory-reflection-item";
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
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

function readClampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  const resolved = Number.isFinite(num) ? num : fallback;
  return Math.max(min, Math.min(max, resolved));
}

export interface LoadReflectionMappedRowsParams {
  entries: MemoryEntry[];
  agentId: string;
  now?: number;
  maxAgeMs?: number;
  maxPerKind?: number;
}

export interface ReflectionMappedSlices {
  userModel: string[];
  agentModel: string[];
  lesson: string[];
  decision: string[];
}

export function loadReflectionMappedRowsFromEntries(params: LoadReflectionMappedRowsParams): ReflectionMappedSlices {
  const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const maxAgeMs = Number.isFinite(params.maxAgeMs)
    ? Math.max(0, Number(params.maxAgeMs))
    : DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS;
  const maxPerKind = Number.isFinite(params.maxPerKind) ? Math.max(1, Math.floor(Number(params.maxPerKind))) : 10;

  type WeightedMapped = {
    text: string;
    mappedKind: ReflectionMappedKind;
    timestamp: number;
    midpointDays: number;
    k: number;
    baseWeight: number;
    quality: number;
    usedFallback: boolean;
  };

  const weighted: WeightedMapped[] = params.entries
    .map((entry) => ({ entry, metadata: parseReflectionMetadata(entry.metadata) }))
    .filter(({ metadata }) => metadata.type === "memory-reflection-mapped" && isOwnedByAgent(metadata, params.agentId))
    .flatMap(({ entry, metadata }) => {
      const mappedKind = parseMappedKind(metadata.mappedKind);
      if (!mappedKind) return [];

      const lines = sanitizeReflectionSliceLines([entry.text]);
      if (lines.length === 0) return [];

      const defaults = getReflectionMappedDecayDefaults(mappedKind);
      const timestamp = metadataTimestamp(metadata, entry.timestamp);

      return lines.map((line) => ({
        text: line,
        mappedKind,
        timestamp,
        midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
        k: readPositiveNumber(metadata.decayK, defaults.k),
        baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
        quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
        usedFallback: metadata.usedFallback === true,
      }));
    });

  const grouped = new Map<string, { text: string; score: number; latestTs: number; kind: ReflectionMappedKind }>();

  for (const item of weighted) {
    if (now - item.timestamp > maxAgeMs) continue;
    const ageDays = Math.max(0, (now - item.timestamp) / 86_400_000);
    const score = computeReflectionScore({
      ageDays,
      midpointDays: item.midpointDays,
      k: item.k,
      baseWeight: item.baseWeight,
      quality: item.quality,
      usedFallback: item.usedFallback,
    });
    if (!Number.isFinite(score) || score <= 0) continue;

    const normalized = normalizeReflectionLineForAggregation(item.text);
    if (!normalized) continue;

    const key = `${item.mappedKind}::${normalized}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { text: item.text, score, latestTs: item.timestamp, kind: item.mappedKind });
      continue;
    }

    current.score += score;
    if (item.timestamp > current.latestTs) {
      current.latestTs = item.timestamp;
      current.text = item.text;
    }
  }

  const sortedByKind = (kind: ReflectionMappedKind) => [...grouped.values()]
    .filter((row) => row.kind === kind)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.latestTs !== a.latestTs) return b.latestTs - a.latestTs;
      return a.text.localeCompare(b.text);
    })
    .slice(0, maxPerKind)
    .map((row) => row.text);

  return {
    userModel: sortedByKind("user-model"),
    agentModel: sortedByKind("agent-model"),
    lesson: sortedByKind("lesson"),
    decision: sortedByKind("decision"),
  };
}

function parseMappedKind(value: unknown): ReflectionMappedKind | null {
  if (value === "user-model" || value === "agent-model" || value === "lesson" || value === "decision") {
    return value;
  }
  return null;
}

export function getReflectionDerivedDecayDefaults(): { midpointDays: number; k: number } {
  return {
    midpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
    k: REFLECTION_DERIVED_DECAY_K,
  };
}

export function getReflectionInvariantDecayDefaults(): { midpointDays: number; k: number } {
  return {
    midpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
    k: REFLECTION_INVARIANT_DECAY_K,
  };
}
