import type { ReflectionMappedMemoryItem } from "./reflection-slices.js";
import type { MemoryCategory } from "./memory-categories.js";
import type { MemorySource } from "./smart-metadata.js";

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";
export type ReflectionMappedCategory = "preference" | "fact" | "decision";

export interface ReflectionMappedMetadata {
  type: "memory-reflection-mapped";
  source: MemorySource;
  reflectionVersion: 4;
  stage: "reflect-store";
  eventId: string;
  mappedKind: ReflectionMappedKind;
  mappedCategory: ReflectionMappedCategory;
  memory_category: MemoryCategory;
  section: string;
  ordinal: number;
  groupSize: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storedAt: number;
  usedFallback: boolean;
  errorSignals: string[];
  decayModel: "logistic";
  decayMidpointDays: number;
  decayK: number;
  baseWeight: number;
  quality: number;
  sourceReflectionPath?: string;
  // Issue #680: heading stored in entry for bulkStore filtering recovery
  _reflectionHeading?: string;
  /** Serialized admission audit when the row passed through admission control. */
  admission_audit?: string;
}

export interface ReflectionMappedDecayDefaults {
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
}

const REFLECTION_MAPPED_DECAY_DEFAULTS: Record<ReflectionMappedKind, ReflectionMappedDecayDefaults> = {
  decision: { midpointDays: 45, k: 0.25, baseWeight: 1.1, quality: 1 },
  "user-model": { midpointDays: 21, k: 0.3, baseWeight: 1, quality: 0.95 },
  "agent-model": { midpointDays: 10, k: 0.35, baseWeight: 0.95, quality: 0.93 },
  lesson: { midpointDays: 7, k: 0.45, baseWeight: 0.9, quality: 0.9 },
};

export function getReflectionMappedDecayDefaults(kind: ReflectionMappedKind): ReflectionMappedDecayDefaults {
  return REFLECTION_MAPPED_DECAY_DEFAULTS[kind];
}

/**
 * mappedKind is known structurally at write time (each kind comes from a
 * fixed reflection section), so the 6-category classification is a direct
 * lookup rather than a text-sniffing heuristic. This map is the SINGLE
 * source of the reflection heading→taxonomy mapping: metadata stamps, the
 * stored row category, and admission scoring all read it. "decision" and
 * "lesson" both land in "cases" — durable operational facts, not one-off
 * "events" — which is what kept mapped decision rows shielded from
 * consolidation before this stamp existed.
 */
const REFLECTION_MAPPED_MEMORY_CATEGORY: Record<ReflectionMappedKind, MemoryCategory> = {
  "user-model": "preferences",
  // Agent self-observations are reusable assistant behavior, not statements
  // about the human -- minting them as user "preferences" polluted recall
  // and consolidation with rows that read as the user's own tendencies.
  "agent-model": "patterns",
  lesson: "cases",
  decision: "cases",
};

export function getReflectionMappedMemoryCategory(kind: ReflectionMappedKind): MemoryCategory {
  return REFLECTION_MAPPED_MEMORY_CATEGORY[kind];
}

export function buildReflectionMappedMetadata(params: {
  mappedItem: ReflectionMappedMemoryItem;
  eventId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runAt: number;
  usedFallback: boolean;
  toolErrorSignals: Array<{ signatureHash: string }>;
  sourceReflectionPath?: string;
}): ReflectionMappedMetadata {
  const defaults = getReflectionMappedDecayDefaults(params.mappedItem.mappedKind);
  return {
    type: "memory-reflection-mapped",
    source: "reflection",
    reflectionVersion: 4,
    stage: "reflect-store",
    eventId: params.eventId,
    mappedKind: params.mappedItem.mappedKind,
    mappedCategory: params.mappedItem.category,
    memory_category: getReflectionMappedMemoryCategory(params.mappedItem.mappedKind),
    section: params.mappedItem.heading,
    ordinal: params.mappedItem.ordinal,
    groupSize: params.mappedItem.groupSize,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storedAt: params.runAt,
    usedFallback: params.usedFallback,
    errorSignals: params.toolErrorSignals.map((signal) => signal.signatureHash),
    decayModel: "logistic",
    decayMidpointDays: defaults.midpointDays,
    decayK: defaults.k,
    baseWeight: defaults.baseWeight,
    quality: defaults.quality,
    ...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
  };
}
