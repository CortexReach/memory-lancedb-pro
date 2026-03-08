import type { ReflectionSliceItem } from "./reflection-slices.js";

export type ReflectionItemKind = "invariant" | "derived";

export interface ReflectionItemMetadata {
  type: "memory-reflection-item";
  reflectionVersion: 4;
  stage: "reflect-store";
  eventId: string;
  itemKind: ReflectionItemKind;
  section: "Invariants" | "Derived";
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
}

export interface ReflectionItemPayload {
  kind: "item-invariant" | "item-derived";
  text: string;
  metadata: ReflectionItemMetadata;
}

export interface BuildReflectionItemPayloadsParams {
  items: ReflectionSliceItem[];
  eventId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runAt: number;
  usedFallback: boolean;
  toolErrorSignals: Array<{ signatureHash: string }>;
  sourceReflectionPath?: string;
}

export const REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS = 45;
export const REFLECTION_INVARIANT_DECAY_K = 0.22;
export const REFLECTION_INVARIANT_BASE_WEIGHT = 1.1;
export const REFLECTION_INVARIANT_QUALITY = 1;

export const REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS = 7;
export const REFLECTION_DERIVED_DECAY_K = 0.65;
export const REFLECTION_DERIVED_BASE_WEIGHT = 1;
export const REFLECTION_DERIVED_QUALITY = 0.95;

export function getReflectionItemDecayDefaults(itemKind: ReflectionItemKind): {
  midpointDays: number;
  k: number;
  baseWeight: number;
  quality: number;
} {
  if (itemKind === "invariant") {
    return {
      midpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
      k: REFLECTION_INVARIANT_DECAY_K,
      baseWeight: REFLECTION_INVARIANT_BASE_WEIGHT,
      quality: REFLECTION_INVARIANT_QUALITY,
    };
  }

  return {
    midpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
    k: REFLECTION_DERIVED_DECAY_K,
    baseWeight: REFLECTION_DERIVED_BASE_WEIGHT,
    quality: REFLECTION_DERIVED_QUALITY,
  };
}

export function buildReflectionItemPayloads(params: BuildReflectionItemPayloadsParams): ReflectionItemPayload[] {
  return params.items.map((item) => {
    const defaults = getReflectionItemDecayDefaults(item.itemKind);
    const metadata: ReflectionItemMetadata = {
      type: "memory-reflection-item",
      reflectionVersion: 4,
      stage: "reflect-store",
      eventId: params.eventId,
      itemKind: item.itemKind,
      section: item.section,
      ordinal: item.ordinal,
      groupSize: item.groupSize,
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

    return {
      kind: item.itemKind === "invariant" ? "item-invariant" : "item-derived",
      text: item.text,
      metadata,
    };
  });
}
