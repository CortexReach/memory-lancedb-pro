import type { MemoryCategory, MemoryTier } from "./memory-categories.js";
import type { DecayableMemory } from "./decay-engine.js";
import { randomUUID } from "node:crypto";

// ============================================================================
// Legacy Types
// ============================================================================

type LegacyStoreCategory =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "reflection"
  | "other";

type EntryLike = {
  text?: string;
  category?: LegacyStoreCategory;
  importance?: number;
  timestamp?: number;
  metadata?: string;
};

// ============================================================================
// V2 Bionic Memory Types — Claim / Provenance / Decision / Support / Relations
// ============================================================================

/** The kind of knowledge this claim represents. */
export type ClaimKind =
  | "episodic"
  | "semantic"
  | "preference"
  | "procedure"
  | "reflection";

/** How stable is this claim over time? */
export type ClaimStability = "transient" | "situational" | "stable";

/** Polarity of the claim (e.g. for preferences). */
export type ClaimPolarity = "positive" | "negative" | "mixed" | "neutral";

/** Temporal validity of the claim. */
export type ClaimValidTime = "historical" | "recent" | "current" | "ongoing";

/**
 * Structured claim extracted from evidence.
 * Represents the system's current assertion about the user/world.
 */
export interface ClaimInfo {
  kind: ClaimKind;
  subject?: string;
  attribute?: string;
  value_summary: string;
  stability: ClaimStability;
  polarity?: ClaimPolarity;
  valid_time?: ClaimValidTime;
  contexts?: string[];
  scope_of_validity?: string[];
}

/** How a piece of evidence entered the system. */
export type SourceType =
  | "auto-capture"
  | "smart-extraction"
  | "regex-fallback"
  | "reflection"
  | "manual"
  | "import"
  | "migration"
  | "feedback";

/**
 * A single evidence source record.
 * Each write creates one of these, regardless of whether a new claim is formed.
 */
export interface SourceRecord {
  source_id: string;
  type: SourceType;
  agent_id?: string;
  session_key?: string;
  timestamp: number;
  excerpt?: string;
  confidence_hint?: number;
}

/**
 * Provenance: the full evidence chain for a claim.
 */
export interface ProvenanceInfo {
  sources: SourceRecord[];
  evidence_count: number;
  first_observed_at: number;
  last_observed_at: number;
  last_confirmed_at?: number;
}

/** What action was taken and by whom. */
export type DecisionAction =
  | "created"
  | "merged"
  | "contextualized"
  | "confidence_adjusted"
  | "supported"
  | "contradicted"
  | "superseded"
  | "feedback_applied";

export type DecisionActor = "system" | "llm" | "user";

export interface DecisionEntry {
  action: DecisionAction;
  actor: DecisionActor;
  timestamp: number;
  model?: string;
  reason?: string;
  source_ids?: string[];
}

export interface DecisionInfo {
  current_reason?: string;
  history: DecisionEntry[];
}

/**
 * Predefined context vocabulary for support slices.
 * LLM should select from this list; unknown values normalized to "general".
 */
export const SUPPORT_CONTEXT_VOCABULARY = [
  "general",
  "morning", "evening", "night",
  "weekday", "weekend",
  "work", "leisure", "travel",
  "recent", "historical",
] as const;
export type SupportContext = (typeof SUPPORT_CONTEXT_VOCABULARY)[number];

const MAX_SUPPORT_SLICES = 8;

/**
 * Per-context support statistics.
 */
export interface ContextualSupport {
  context: SupportContext;
  confirmations: number;
  contradictions: number;
  strength: number;
  last_observed_at: number;
}

/**
 * Aggregate support statistics for a claim, with per-context slices.
 */
export interface SupportInfo {
  global_strength: number;
  total_observations: number;
  slices: ContextualSupport[];
}

/** The kind of relation between two claims. */
export type RelationType =
  | "supports"
  | "refines"
  | "contextualizes"
  | "coexists"
  | "contradicts"
  | "supersedes";

export interface RelationEntry {
  relation: RelationType;
  target_id: string;
  strength?: number;
  reason?: string;
}

// ============================================================================
// Smart Memory Metadata (V1 + V2 unified)
// ============================================================================

export interface SmartMemoryMetadata {
  /** Schema version: 1 = legacy (implicit), 2 = bionic. */
  schema_version?: number;

  l0_abstract: string;
  l1_overview: string;
  l2_content: string;
  memory_category: MemoryCategory;
  tier: MemoryTier;
  access_count: number;
  confidence: number;
  last_accessed_at: number;
  source_session?: string;

  /** V2: structured claim. */
  claim?: ClaimInfo;
  /** V2: evidence provenance chain. */
  provenance?: ProvenanceInfo;
  /** V2: decision trail. */
  decision?: DecisionInfo;
  /** V2: aggregate support statistics. */
  support?: SupportInfo;
  /** V2: inter-memory relations. */
  relations?: RelationEntry[];

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
}

// ============================================================================
// Internal Helpers
// ============================================================================

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

// ============================================================================
// V2 Helper: Safe parse for nested V2 structures
// ============================================================================

const VALID_CLAIM_KINDS = new Set<string>(["episodic", "semantic", "preference", "procedure", "reflection"]);
const VALID_STABILITIES = new Set<string>(["transient", "situational", "stable"]);

function parseClaimInfo(raw: unknown): ClaimInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === "string" && VALID_CLAIM_KINDS.has(obj.kind)
    ? (obj.kind as ClaimKind)
    : "semantic";
  const stability = typeof obj.stability === "string" && VALID_STABILITIES.has(obj.stability)
    ? (obj.stability as ClaimStability)
    : "stable";
  const valueSummary = typeof obj.value_summary === "string" ? obj.value_summary : "";
  if (!valueSummary) return undefined;
  return {
    kind,
    subject: typeof obj.subject === "string" ? obj.subject : undefined,
    attribute: typeof obj.attribute === "string" ? obj.attribute : undefined,
    value_summary: valueSummary,
    stability,
    polarity: typeof obj.polarity === "string" ? (obj.polarity as ClaimPolarity) : undefined,
    valid_time: typeof obj.valid_time === "string" ? (obj.valid_time as ClaimValidTime) : undefined,
    contexts: Array.isArray(obj.contexts) ? obj.contexts.filter((c): c is string => typeof c === "string") : undefined,
    scope_of_validity: Array.isArray(obj.scope_of_validity) ? obj.scope_of_validity.filter((c): c is string => typeof c === "string") : undefined,
  };
}

function parseSourceRecord(raw: unknown): SourceRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sourceId = typeof obj.source_id === "string" ? obj.source_id : "";
  const type = typeof obj.type === "string" ? (obj.type as SourceType) : "auto-capture";
  const timestamp = typeof obj.timestamp === "number" ? obj.timestamp : Date.now();
  if (!sourceId) return null;
  return {
    source_id: sourceId,
    type,
    agent_id: typeof obj.agent_id === "string" ? obj.agent_id : undefined,
    session_key: typeof obj.session_key === "string" ? obj.session_key : undefined,
    timestamp,
    excerpt: typeof obj.excerpt === "string" ? obj.excerpt : undefined,
    confidence_hint: typeof obj.confidence_hint === "number" ? obj.confidence_hint : undefined,
  };
}

function parseProvenanceInfo(raw: unknown, fallbackTimestamp: number, fallbackSession?: string): ProvenanceInfo | undefined {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const sources = Array.isArray(obj.sources)
      ? (obj.sources.map(parseSourceRecord).filter(Boolean) as SourceRecord[])
      : [];
    return {
      sources,
      evidence_count: typeof obj.evidence_count === "number" ? obj.evidence_count : sources.length,
      first_observed_at: typeof obj.first_observed_at === "number" ? obj.first_observed_at : fallbackTimestamp,
      last_observed_at: typeof obj.last_observed_at === "number" ? obj.last_observed_at : fallbackTimestamp,
      last_confirmed_at: typeof obj.last_confirmed_at === "number" ? obj.last_confirmed_at : undefined,
    };
  }
  // Synthesize minimal provenance from V1 source_session
  if (fallbackSession) {
    return {
      sources: [{
        source_id: randomUUID(),
        type: "auto-capture",
        session_key: fallbackSession,
        timestamp: fallbackTimestamp,
      }],
      evidence_count: 1,
      first_observed_at: fallbackTimestamp,
      last_observed_at: fallbackTimestamp,
    };
  }
  return undefined;
}

function parseDecisionInfo(raw: unknown): DecisionInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const history = Array.isArray(obj.history) ? obj.history.filter(
    (e): e is DecisionEntry =>
      !!e && typeof e === "object" && typeof (e as Record<string, unknown>).action === "string",
  ) : [];
  return {
    current_reason: typeof obj.current_reason === "string" ? obj.current_reason : undefined,
    history,
  };
}

function parseSupportInfo(raw: unknown): SupportInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  // V2 format: has slices array
  if (Array.isArray(obj.slices)) {
    const slices = (obj.slices as any[]).filter(
      (s): s is ContextualSupport =>
        !!s && typeof s === "object" &&
        typeof (s as any).context === "string" &&
        typeof (s as any).confirmations === "number",
    ).map(s => ({
      ...s,
      context: normalizeContext(s.context),
    }));
    return {
      global_strength: typeof obj.global_strength === "number" ? clamp01(obj.global_strength, 0.5) : 0.5,
      total_observations: typeof obj.total_observations === "number" ? obj.total_observations : 0,
      slices,
    };
  }

  // V1 backward compat: flat {confirmations, contradictions, support_strength}
  // → migrate to single "general" slice
  const confirmations = typeof obj.confirmations === "number" ? obj.confirmations : 0;
  const contradictions = typeof obj.contradictions === "number" ? obj.contradictions : 0;
  const strength = typeof obj.support_strength === "number" ? clamp01(obj.support_strength, 0.5) : 0.5;
  if (confirmations === 0 && contradictions === 0) return undefined;
  return {
    global_strength: strength,
    total_observations: confirmations + contradictions,
    slices: [{
      context: "general",
      confirmations,
      contradictions,
      strength,
      last_observed_at: Date.now(),
    }],
  };
}

/** Normalize a context string to the predefined vocabulary. */
function normalizeContext(ctx: unknown): SupportContext {
  if (typeof ctx !== "string") return "general";
  const lower = ctx.trim().toLowerCase();
  return (SUPPORT_CONTEXT_VOCABULARY as readonly string[]).includes(lower)
    ? lower as SupportContext
    : "general";
}

function parseRelations(raw: unknown): RelationEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (e): e is RelationEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as Record<string, unknown>).relation === "string" &&
      typeof (e as Record<string, unknown>).target_id === "string",
  );
}

// ============================================================================
// Core Functions
// ============================================================================

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
  const sourceSession =
    typeof parsed.source_session === "string" ? parsed.source_session : undefined;

  const normalized: SmartMemoryMetadata = {
    ...parsed,
    schema_version: typeof parsed.schema_version === "number" ? parsed.schema_version : 1,
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
    source_session: sourceSession,
    // V2 fields — parse if present, synthesize provenance from V1 if possible
    claim: parseClaimInfo(parsed.claim),
    provenance: parseProvenanceInfo(parsed.provenance, timestamp, sourceSession),
    decision: parseDecisionInfo(parsed.decision),
    support: parseSupportInfo(parsed.support),
    relations: parseRelations(parsed.relations),
  };

  return normalized;
}

export function buildSmartMetadata(
  entry: EntryLike,
  patch: Partial<SmartMemoryMetadata> = {},
): SmartMemoryMetadata {
  const base = parseSmartMetadata(entry.metadata, entry);
  const result: SmartMemoryMetadata = {
    ...base,
    ...patch,
    schema_version: patch.schema_version ?? base.schema_version ?? 2,
    l0_abstract: normalizeText(patch.l0_abstract, base.l0_abstract),
    l1_overview: normalizeText(patch.l1_overview, base.l1_overview),
    l2_content: normalizeText(patch.l2_content, base.l2_content),
    memory_category:
      typeof patch.memory_category === "string"
        ? patch.memory_category
        : base.memory_category,
    tier: normalizeTier(patch.tier ?? base.tier),
    access_count: clampCount(patch.access_count, base.access_count),
    confidence: clamp01(patch.confidence, base.confidence),
    last_accessed_at: clampCount(
      patch.last_accessed_at,
      base.last_accessed_at || entry.timestamp || Date.now(),
    ),
    source_session:
      typeof patch.source_session === "string"
        ? patch.source_session
        : base.source_session,
  };

  // V2 deep-merge: prefer patch, fallback to base
  result.claim = patch.claim ?? base.claim;
  result.provenance = mergeProvenance(base.provenance, patch.provenance);
  result.decision = mergeDecision(base.decision, patch.decision);
  result.support = patch.support ?? base.support;
  result.relations = capRelations(patch.relations ?? base.relations);

  return result;
}

/**
 * Metadata size limits to prevent unbounded growth.
 * When exceeded, oldest entries are trimmed while preserving aggregate counts.
 */
const MAX_PROVENANCE_SOURCES = 20;
const MAX_DECISION_HISTORY = 50;
const MAX_RELATIONS = 16;

/**
 * Merge provenance: combine sources from base and patch, dedupe by source_id,
 * cap at MAX_PROVENANCE_SOURCES (keep most recent).
 */
function mergeProvenance(
  base: ProvenanceInfo | undefined,
  patch: ProvenanceInfo | undefined,
): ProvenanceInfo | undefined {
  if (!base && !patch) return undefined;
  if (!base) return capProvenance(patch!);
  if (!patch) return base;

  const seenIds = new Set(base.sources.map((s) => s.source_id));
  const mergedSources = [...base.sources];
  for (const s of patch.sources) {
    if (!seenIds.has(s.source_id)) {
      mergedSources.push(s);
      seenIds.add(s.source_id);
    }
  }

  const totalCount = mergedSources.length;
  // Keep most recent sources if over limit
  const cappedSources = totalCount > MAX_PROVENANCE_SOURCES
    ? mergedSources
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_PROVENANCE_SOURCES)
    : mergedSources;

  return {
    sources: cappedSources,
    evidence_count: totalCount, // preserve true count even if sources are trimmed
    first_observed_at: Math.min(base.first_observed_at, patch.first_observed_at),
    last_observed_at: Math.max(base.last_observed_at, patch.last_observed_at),
    last_confirmed_at: patch.last_confirmed_at ?? base.last_confirmed_at,
  };
}

function capProvenance(prov: ProvenanceInfo): ProvenanceInfo {
  if (prov.sources.length <= MAX_PROVENANCE_SOURCES) return prov;
  const sorted = [...prov.sources].sort((a, b) => b.timestamp - a.timestamp);
  return {
    ...prov,
    sources: sorted.slice(0, MAX_PROVENANCE_SOURCES),
    evidence_count: prov.evidence_count, // preserve original count
  };
}

/**
 * Merge decision info: concatenate history, prefer patch's current_reason,
 * cap at MAX_DECISION_HISTORY (keep most recent).
 */
function mergeDecision(
  base: DecisionInfo | undefined,
  patch: DecisionInfo | undefined,
): DecisionInfo | undefined {
  if (!base && !patch) return undefined;
  if (!base) return capDecision(patch!);
  if (!patch) return base;

  const merged = [...base.history, ...patch.history];
  // Keep most recent entries if over limit
  const capped = merged.length > MAX_DECISION_HISTORY
    ? merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_DECISION_HISTORY)
    : merged;

  return {
    current_reason: patch.current_reason ?? base.current_reason,
    history: capped,
  };
}

function capDecision(dec: DecisionInfo): DecisionInfo {
  if (dec.history.length <= MAX_DECISION_HISTORY) return dec;
  const sorted = [...dec.history].sort((a, b) => b.timestamp - a.timestamp);
  return {
    ...dec,
    history: sorted.slice(0, MAX_DECISION_HISTORY),
  };
}

/**
 * Cap relations to MAX_RELATIONS (keep most recent by created_at fallback).
 */
function capRelations(relations: RelationEntry[] | undefined): RelationEntry[] | undefined {
  if (!relations || relations.length <= MAX_RELATIONS) return relations;
  return relations.slice(-MAX_RELATIONS);
}

export function stringifySmartMetadata(
  metadata: SmartMemoryMetadata | Record<string, unknown>,
): string {
  return JSON.stringify(metadata);
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
  };

  return { memory, meta };
}

// ============================================================================
// V2 Builder Helpers — used by the write pipeline
// ============================================================================

/**
 * Create a new SourceRecord for a write event.
 */
export function createSourceRecord(opts: {
  type: SourceType;
  agentId?: string;
  sessionKey?: string;
  excerpt?: string;
  confidenceHint?: number;
  timestamp?: number;
}): SourceRecord {
  return {
    source_id: randomUUID(),
    type: opts.type,
    agent_id: opts.agentId,
    session_key: opts.sessionKey,
    timestamp: opts.timestamp ?? Date.now(),
    excerpt: opts.excerpt,
    confidence_hint: opts.confidenceHint,
  };
}

/**
 * Append a decision entry to an existing DecisionInfo (returns a new object).
 */
export function appendDecisionEntry(
  existing: DecisionInfo | undefined,
  entry: DecisionEntry,
): DecisionInfo {
  const history = existing?.history ? [...existing.history, entry] : [entry];
  return {
    current_reason: entry.reason ?? existing?.current_reason,
    history,
  };
}

/**
 * Update support stats after a support or contradict event.
 * Now context-aware: updates the specific slice and recomputes global_strength.
 */
export function updateSupportStats(
  existing: SupportInfo | undefined,
  event: "support" | "contradict",
  context: SupportContext | string = "general",
): SupportInfo {
  const normalizedCtx = normalizeContext(context);
  const base: SupportInfo = existing ?? { global_strength: 0.5, total_observations: 0, slices: [] };

  // Find or create the target slice
  let slice = base.slices.find(s => s.context === normalizedCtx);
  if (!slice) {
    slice = { context: normalizedCtx, confirmations: 0, contradictions: 0, strength: 0.5, last_observed_at: Date.now() };
    base.slices.push(slice);
  }

  // Update slice
  if (event === "support") slice.confirmations++;
  else slice.contradictions++;
  const sliceTotal = slice.confirmations + slice.contradictions;
  slice.strength = sliceTotal > 0 ? slice.confirmations / sliceTotal : 0.5;
  slice.last_observed_at = Date.now();

  // Cap slices (keep most recently observed, but preserve dropped evidence)
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

/**
 * Build initial V2 provenance from a single source record.
 */
export function buildInitialProvenance(source: SourceRecord): ProvenanceInfo {
  return {
    sources: [source],
    evidence_count: 1,
    first_observed_at: source.timestamp,
    last_observed_at: source.timestamp,
  };
}

/**
 * Build initial decision info from a creation event.
 */
export function buildInitialDecision(opts: {
  actor: DecisionActor;
  reason?: string;
  sourceIds?: string[];
  model?: string;
  timestamp?: number;
}): DecisionInfo {
  return {
    current_reason: opts.reason,
    history: [{
      action: "created",
      actor: opts.actor,
      timestamp: opts.timestamp ?? Date.now(),
      model: opts.model,
      reason: opts.reason,
      source_ids: opts.sourceIds,
    }],
  };
}

/**
 * Infer a default ClaimKind from the memory category.
 */
export function inferClaimKind(category: MemoryCategory): ClaimKind {
  switch (category) {
    case "profile":
      return "semantic";
    case "preferences":
      return "preference";
    case "entities":
      return "semantic";
    case "events":
      return "episodic";
    case "cases":
      return "procedure";
    case "patterns":
      return "procedure";
    default:
      return "semantic";
  }
}
