import {
  TEMPORAL_VERSIONED_CATEGORIES,
  type MemoryCategory,
  type MemoryTier,
} from "./memory-categories.js";
import type { DecayableMemory } from "./decay-engine.js";

type LegacyStoreCategory =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "other"
  | "reflection";

type EntryLike = {
  text?: string;
  category?: LegacyStoreCategory;
  importance?: number;
  timestamp?: number;
  metadata?: string;
};

export interface MemoryRelation {
  type: string;
  targetId: string;
}

export type MemoryState = "pending" | "confirmed" | "archived";
export type MemoryLayer = "durable" | "working" | "reflection" | "archive";
export type MemorySource =
  | "manual"
  | "auto-capture"
  | "reflection"
  | "session-summary"
  | "legacy";

export interface SmartMemoryMetadata {
  l0_abstract: string;
  l1_overview: string;
  l2_content: string;
  memory_category: MemoryCategory;
  tier: MemoryTier;
  access_count: number;
  confidence: number;
  last_accessed_at: number;
  valid_from: number;
  invalidated_at?: number;
  memory_temporal_type?: "static" | "dynamic";
  valid_until?: number;
  fact_key?: string;
  supersedes?: string;
  superseded_by?: string;
  relations?: MemoryRelation[];
  source_session?: string;
  state: MemoryState;
  source: MemorySource;
  memory_layer: MemoryLayer;
  injected_count: number;
  last_injected_at?: number;
  last_confirmed_use_at?: number;
  bad_recall_count: number;
  suppressed_until_turn: number;
  canonical_id?: string;
  [key: string]: unknown;
}

export interface LifecycleMemory {
  id: string;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  temporalType?: "static" | "dynamic";
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampCount(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function normalizeTier(value: unknown): MemoryTier {
  switch (value) {
    case "core":
    case "working":
    case "peripheral":
      return value;
    default:
      return "working";
  }
}

function normalizeState(value: unknown): MemoryState {
  switch (value) {
    case "pending":
    case "confirmed":
    case "archived":
      return value;
    default:
      return "confirmed";
  }
}

function normalizeSource(value: unknown): MemorySource {
  switch (value) {
    case "manual":
    case "auto-capture":
    case "reflection":
    case "session-summary":
    case "legacy":
      return value;
    default:
      return "legacy";
  }
}

function normalizeLayer(value: unknown): MemoryLayer {
  switch (value) {
    case "durable":
    case "working":
    case "reflection":
    case "archive":
      return value;
    default:
      return "working";
  }
}

function deriveDefaultLayer(
  source: MemorySource,
  memoryCategory: MemoryCategory,
  state: MemoryState,
): MemoryLayer {
  if (source === "reflection" || source === "session-summary") return "reflection";
  if (state === "archived") return "archive";
  if (
    memoryCategory === "profile" ||
    memoryCategory === "preferences" ||
    memoryCategory === "events"
  ) {
    return "durable";
  }
  return "working";
}

export function reverseMapLegacyCategory(
  oldCategory: LegacyStoreCategory | undefined,
  text = "",
): MemoryCategory {
  switch (oldCategory) {
    case "preference":
      return "preferences";
    case "entity":
      return "entities";
    case "decision":
      return "events";
    case "other":
      return "patterns";
    case "fact":
      if (
        /\b(my |i am |i'm |name is |叫我|我的|我是)\b/i.test(text) &&
        text.length < 200
      ) {
        return "profile";
      }
      return "cases";
    default:
      return "patterns";
  }
}

function defaultOverview(text: string): string {
  return `- ${text}`;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function deriveFactKey(
  category: MemoryCategory,
  abstract: string,
): string | undefined {
  if (!TEMPORAL_VERSIONED_CATEGORIES.has(category)) return undefined;

  const trimmed = abstract.trim();
  if (!trimmed) return undefined;

  let topic = trimmed;
  const colonMatch = trimmed.match(/^(.{1,120}?)[：:]/);
  const arrowMatch = trimmed.match(/^(.{1,120}?)(?:\s*->|\s*=>)/);
  if (colonMatch?.[1]) {
    topic = colonMatch[1];
  } else if (arrowMatch?.[1]) {
    topic = arrowMatch[1];
  }

  const normalized = topic
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[。.!?]+$/g, "")
    .trim();

  return normalized ? `${category}:${normalized}` : undefined;
}

export function isMemoryActiveAt(
  metadata: Pick<SmartMemoryMetadata, "valid_from" | "invalidated_at">,
  at = Date.now(),
): boolean {
  if (metadata.valid_from > at) return false;
  return !metadata.invalidated_at || metadata.invalidated_at > at;
}

/**
 * Check if a memory has passed its expiry date (valid_until).
 * Separate from isMemoryActiveAt (which checks invalidated_at from superseding).
 * Returns false if valid_until is not set (no expiry = permanent).
 */
export function isMemoryExpired(
  metadata: Pick<SmartMemoryMetadata, "valid_until">,
  at: number = Date.now(),
): boolean {
  return metadata.valid_until != null && metadata.valid_until <= at;
}

export function parseSmartMetadata(
  rawMetadata: string | undefined,
  entry: EntryLike = {},
): SmartMemoryMetadata {
  let parsed: Record<string, unknown> = {};
  if (rawMetadata) {
    try {
      const obj = JSON.parse(rawMetadata);
      if (obj && typeof obj === "object") {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  const text = entry.text ?? "";
  const timestamp =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  const memoryCategory = reverseMapLegacyCategory(entry.category, text);
  const l0 = normalizeText(parsed.l0_abstract, text);
  const l2 = normalizeText(parsed.l2_content, text);
  const validFrom = normalizeTimestamp(parsed.valid_from, timestamp);
  const invalidatedAt = normalizeOptionalTimestamp(parsed.invalidated_at);
  const fallbackSource =
    parsed.type === "session-summary"
      ? "session-summary"
      : parsed.type === "memory-reflection" || parsed.type === "memory-reflection-item"
        ? "reflection"
        : "legacy";
  const source = normalizeSource(parsed.source ?? fallbackSource);
  const defaultState =
    source === "session-summary" ? "archived" : "confirmed";
  const state = normalizeState(parsed.state ?? defaultState);
  const memoryLayer = normalizeLayer(
    parsed.memory_layer ?? deriveDefaultLayer(source, memoryCategory, state),
  );
  const normalized: SmartMemoryMetadata = {
    ...parsed,
    l0_abstract: l0,
    l1_overview: normalizeText(parsed.l1_overview, defaultOverview(l0)),
    l2_content: l2,
    memory_category:
      typeof parsed.memory_category === "string"
        ? (parsed.memory_category as MemoryCategory)
        : memoryCategory,
    tier: normalizeTier(parsed.tier),
    access_count: clampCount(parsed.access_count, 0),
    confidence: clamp01(parsed.confidence, 0.7),
    last_accessed_at: clampCount(parsed.last_accessed_at, timestamp),
    valid_from: validFrom,
    invalidated_at:
      invalidatedAt && invalidatedAt >= validFrom ? invalidatedAt : undefined,
    memory_temporal_type:
      parsed.memory_temporal_type === "static" || parsed.memory_temporal_type === "dynamic"
        ? parsed.memory_temporal_type
        : undefined,
    valid_until: normalizeOptionalTimestamp(parsed.valid_until),
    fact_key:
      normalizeOptionalString(parsed.fact_key) ??
      deriveFactKey(
        typeof parsed.memory_category === "string"
          ? (parsed.memory_category as MemoryCategory)
          : memoryCategory,
        l0,
      ),
    supersedes: normalizeOptionalString(parsed.supersedes),
    superseded_by: normalizeOptionalString(parsed.superseded_by),
    source_session:
      typeof parsed.source_session === "string" ? parsed.source_session : undefined,
    state,
    source,
    memory_layer: memoryLayer,
    injected_count: clampCount(parsed.injected_count, 0),
    last_injected_at: normalizeOptionalTimestamp(parsed.last_injected_at),
    last_confirmed_use_at: normalizeOptionalTimestamp(parsed.last_confirmed_use_at),
    bad_recall_count: clampCount(parsed.bad_recall_count, 0),
    suppressed_until_turn: clampCount(parsed.suppressed_until_turn, 0),
    canonical_id: normalizeOptionalString(parsed.canonical_id),
  };

  return normalized;
}

export function buildSmartMetadata(
  entry: EntryLike,
  patch: Partial<SmartMemoryMetadata> = {},
): SmartMemoryMetadata {
  const base = parseSmartMetadata(entry.metadata, entry);
  const l0Abstract = normalizeText(patch.l0_abstract, base.l0_abstract);
  const nextCategory =
    typeof patch.memory_category === "string"
      ? patch.memory_category
      : base.memory_category;
  const nextSource =
    patch.source !== undefined ? normalizeSource(patch.source) : base.source;
  const nextState =
    patch.state !== undefined ? normalizeState(patch.state) : base.state;
  const nextLayer =
    patch.memory_layer !== undefined
      ? normalizeLayer(patch.memory_layer)
      : base.memory_layer;
  const validFrom = normalizeTimestamp(patch.valid_from, base.valid_from);
  const invalidatedAt =
    patch.invalidated_at === undefined
      ? base.invalidated_at
      : normalizeOptionalTimestamp(patch.invalidated_at);
  return {
    ...base,
    ...patch,
    l0_abstract: l0Abstract,
    l1_overview: normalizeText(patch.l1_overview, base.l1_overview),
    l2_content: normalizeText(patch.l2_content, base.l2_content),
    memory_category: nextCategory,
    tier: normalizeTier(patch.tier ?? base.tier),
    access_count: clampCount(patch.access_count, base.access_count),
    confidence: clamp01(patch.confidence, base.confidence),
    last_accessed_at: clampCount(
      patch.last_accessed_at,
      base.last_accessed_at || entry.timestamp || Date.now(),
    ),
    valid_from: validFrom,
    invalidated_at:
      invalidatedAt && invalidatedAt >= validFrom ? invalidatedAt : undefined,
    memory_temporal_type:
      patch.memory_temporal_type === undefined
        ? base.memory_temporal_type
        : patch.memory_temporal_type === "static" || patch.memory_temporal_type === "dynamic"
          ? patch.memory_temporal_type
          : undefined,
    valid_until:
      patch.valid_until === undefined
        ? base.valid_until
        : normalizeOptionalTimestamp(patch.valid_until),
    fact_key:
      normalizeOptionalString(patch.fact_key) ??
      base.fact_key ??
      deriveFactKey(nextCategory, l0Abstract),
    supersedes:
      patch.supersedes === undefined
        ? base.supersedes
        : normalizeOptionalString(patch.supersedes),
    superseded_by:
      patch.superseded_by === undefined
        ? base.superseded_by
        : normalizeOptionalString(patch.superseded_by),
    source_session:
      typeof patch.source_session === "string"
        ? patch.source_session
        : base.source_session,
    source: nextSource,
    state: nextState,
    memory_layer: nextLayer,
    injected_count: clampCount(patch.injected_count, base.injected_count),
    last_injected_at:
      patch.last_injected_at === undefined
        ? base.last_injected_at
        : normalizeOptionalTimestamp(patch.last_injected_at),
    last_confirmed_use_at:
      patch.last_confirmed_use_at === undefined
        ? base.last_confirmed_use_at
        : normalizeOptionalTimestamp(patch.last_confirmed_use_at),
    bad_recall_count: clampCount(patch.bad_recall_count, base.bad_recall_count),
    suppressed_until_turn: clampCount(
      patch.suppressed_until_turn,
      base.suppressed_until_turn,
    ),
    canonical_id:
      patch.canonical_id === undefined
        ? base.canonical_id
        : normalizeOptionalString(patch.canonical_id),
  };
}

// Metadata array size caps — prevent unbounded JSON growth
const MAX_SOURCES = 20;
const MAX_HISTORY = 50;
const MAX_RELATIONS = 16;

/**
 * Append a relation to an existing relations array, deduplicating by type+targetId.
 */
export function appendRelation(
  existing: unknown,
  relation: MemoryRelation,
): MemoryRelation[] {
  const rows = Array.isArray(existing)
    ? existing.filter(
      (item): item is MemoryRelation =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { type?: unknown }).type === "string" &&
        typeof (item as { targetId?: unknown }).targetId === "string",
    )
    : [];

  if (rows.some((item) => item.type === relation.type && item.targetId === relation.targetId)) {
    return rows;
  }

  return [...rows, relation];
}

export function stringifySmartMetadata(
  metadata: SmartMemoryMetadata | Record<string, unknown>,
): string {
  const capped = { ...metadata } as Record<string, unknown>;

  // Cap array fields to prevent metadata bloat
  if (Array.isArray(capped.sources) && capped.sources.length > MAX_SOURCES) {
    capped.sources = capped.sources.slice(-MAX_SOURCES); // keep most recent
  }
  if (Array.isArray(capped.history) && capped.history.length > MAX_HISTORY) {
    capped.history = capped.history.slice(-MAX_HISTORY);
  }
  if (Array.isArray(capped.relations) && capped.relations.length > MAX_RELATIONS) {
    capped.relations = capped.relations.slice(0, MAX_RELATIONS);
  }

  return JSON.stringify(capped);
}

export function toLifecycleMemory(
  id: string,
  entry: EntryLike,
): LifecycleMemory {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  const createdAt =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  return {
    id,
    importance:
      typeof entry.importance === "number" && Number.isFinite(entry.importance)
        ? entry.importance
        : 0.7,
    confidence: metadata.confidence,
    tier: metadata.tier,
    accessCount: metadata.access_count,
    createdAt,
    lastAccessedAt: metadata.last_accessed_at || createdAt,
    temporalType: metadata.memory_temporal_type === "dynamic" ? "dynamic"
      : metadata.memory_temporal_type === "static" ? "static"
      : undefined,
  };
}

/**
 * Parse a memory entry into both a DecayableMemory (for the decay engine)
 * and the raw SmartMemoryMetadata (for in-place mutation before write-back).
 */
export function getDecayableFromEntry(
  entry: EntryLike & { id?: string },
): { memory: DecayableMemory; meta: SmartMemoryMetadata } {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const createdAt =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : Date.now();

  const memory: DecayableMemory = {
    id: (entry as { id?: string }).id ?? "",
    importance:
      typeof entry.importance === "number" && Number.isFinite(entry.importance)
        ? entry.importance
        : 0.7,
    confidence: meta.confidence,
    tier: meta.tier,
    accessCount: meta.access_count,
    createdAt,
    lastAccessedAt: meta.last_accessed_at || createdAt,
    temporalType: meta.memory_temporal_type === "dynamic" ? "dynamic"
      : meta.memory_temporal_type === "static" ? "static"
      : undefined,
  };

  return { memory, meta };
}

// ============================================================================
// Contextual Support — optional extension to SmartMemoryMetadata
// ============================================================================

/** Predefined context vocabulary for support slices */
export const SUPPORT_CONTEXT_VOCABULARY = [
  "general", "morning", "afternoon", "evening", "night",
  "weekday", "weekend", "work", "leisure",
  "summer", "winter", "travel",
] as const;

export type SupportContext = (typeof SUPPORT_CONTEXT_VOCABULARY)[number] | string;

/** Max number of context slices per memory to prevent metadata bloat */
export const MAX_SUPPORT_SLICES = 8;

/** A single context-specific support slice */
export interface ContextualSupport {
  context: SupportContext;
  confirmations: number;
  contradictions: number;
  strength: number;       // confirmations / (confirmations + contradictions)
  last_observed_at: number;
}

/** V2 support info with per-context slices */
export interface SupportInfoV2 {
  global_strength: number;      // weighted average across all slices
  total_observations: number;   // sum of all confirmations + contradictions
  slices: ContextualSupport[];
}

/**
 * Normalize a raw context label to a canonical context.
 * Maps common variants (e.g. "晚上" → "evening") and falls back to "general".
 */
export function normalizeContext(raw: string | undefined): SupportContext {
  if (!raw || !raw.trim()) return "general";
  const lower = raw.trim().toLowerCase();

  // Direct vocabulary match
  if ((SUPPORT_CONTEXT_VOCABULARY as readonly string[]).includes(lower)) {
    return lower as SupportContext;
  }

  // Common Chinese/English mappings
  const aliases: Record<string, SupportContext> = {
    "早上": "morning", "上午": "morning", "早晨": "morning",
    "下午": "afternoon", "傍晚": "evening", "晚上": "evening",
    "深夜": "night", "夜晚": "night", "凌晨": "night",
    "工作日": "weekday", "平时": "weekday",
    "周末": "weekend", "假日": "weekend", "休息日": "weekend",
    "工作": "work", "上班": "work", "办公": "work",
    "休闲": "leisure", "放松": "leisure", "休息": "leisure",
    "夏天": "summer", "夏季": "summer",
    "冬天": "winter", "冬季": "winter",
    "旅行": "travel", "出差": "travel", "旅游": "travel",
  };

  return aliases[lower] || lower; // keep as custom context if not mapped
}

/**
 * Parse support_info from metadata JSON. Handles V1 (flat) → V2 (sliced) migration.
 */
export function parseSupportInfo(raw: unknown): SupportInfoV2 {
  const defaultV2: SupportInfoV2 = {
    global_strength: 0.5,
    total_observations: 0,
    slices: [],
  };

  if (!raw || typeof raw !== "object") return defaultV2;
  const obj = raw as Record<string, unknown>;

  // V2 format: has slices array
  if (Array.isArray(obj.slices)) {
    return {
      global_strength: typeof obj.global_strength === "number" ? obj.global_strength : 0.5,
      total_observations: typeof obj.total_observations === "number" ? obj.total_observations : 0,
      slices: (obj.slices as Record<string, unknown>[]).filter(
        s => s && typeof s.context === "string",
      ).map(s => ({
        context: String(s.context),
        confirmations: typeof s.confirmations === "number" && s.confirmations >= 0 ? s.confirmations : 0,
        contradictions: typeof s.contradictions === "number" && s.contradictions >= 0 ? s.contradictions : 0,
        strength: typeof s.strength === "number" && s.strength >= 0 && s.strength <= 1 ? s.strength : 0.5,
        last_observed_at: typeof s.last_observed_at === "number" ? s.last_observed_at : Date.now(),
      })),
    };
  }

  // V1 format: flat { confirmations, contradictions, strength }
  const conf = typeof obj.confirmations === "number" ? obj.confirmations : 0;
  const contra = typeof obj.contradictions === "number" ? obj.contradictions : 0;
  const total = conf + contra;
  if (total === 0) return defaultV2;

  return {
    global_strength: total > 0 ? conf / total : 0.5,
    total_observations: total,
    slices: [{
      context: "general",
      confirmations: conf,
      contradictions: contra,
      strength: total > 0 ? conf / total : 0.5,
      last_observed_at: Date.now(),
    }],
  };
}

/**
 * Update support stats for a specific context.
 * Returns a new SupportInfoV2 with the updated slice.
 */
export function updateSupportStats(
  existing: SupportInfoV2,
  contextLabel: string | undefined,
  event: "support" | "contradict",
): SupportInfoV2 {
  const ctx = normalizeContext(contextLabel);
  const base = { ...existing, slices: [...existing.slices.map(s => ({ ...s }))] };

  // Find or create the context slice
  let slice = base.slices.find(s => s.context === ctx);
  if (!slice) {
    slice = { context: ctx, confirmations: 0, contradictions: 0, strength: 0.5, last_observed_at: Date.now() };
    base.slices.push(slice);
  }

  // Update slice
  if (event === "support") slice.confirmations++;
  else slice.contradictions++;
  const sliceTotal = slice.confirmations + slice.contradictions;
  slice.strength = sliceTotal > 0 ? slice.confirmations / sliceTotal : 0.5;
  slice.last_observed_at = Date.now();

  // Cap slices (keep most recently observed, but preserve dropped evidence).
  // NOTE: Evidence from slices dropped in *previous* updates is already baked
  // into total_observations/global_strength, so those values may drift slightly
  // over many truncation cycles. This is an accepted trade-off for bounded JSON size.
  let slices = base.slices;
  let droppedConf = 0, droppedContra = 0;
  if (slices.length > MAX_SUPPORT_SLICES) {
    slices = slices
      .sort((a, b) => b.last_observed_at - a.last_observed_at);
    const dropped = slices.slice(MAX_SUPPORT_SLICES);
    for (const d of dropped) {
      droppedConf += d.confirmations;
      droppedContra += d.contradictions;
    }
    slices = slices.slice(0, MAX_SUPPORT_SLICES);
  }

  // Recompute global strength including evidence from dropped slices
  let totalConf = droppedConf, totalContra = droppedContra;
  for (const s of slices) {
    totalConf += s.confirmations;
    totalContra += s.contradictions;
  }
  const totalObs = totalConf + totalContra;
  const global_strength = totalObs > 0 ? totalConf / totalObs : 0.5;

  return { global_strength, total_observations: totalObs, slices };
}
