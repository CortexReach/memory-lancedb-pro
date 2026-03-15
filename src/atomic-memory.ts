import type { MemoryEntry } from "./store.js";

export const ATOMIC_MEMORY_SCHEMA = "openclaw.atomic-memory/v1";
export const ATOMIC_MEMORY_UNIT_TYPES = [
  "preference",
  "fact",
  "decision",
  "lesson",
  "environment",
  "entity",
  "other",
] as const;
export const ATOMIC_MEMORY_SOURCE_KINDS = ["user", "tool", "agent", "imported"] as const;

export type AtomicMemoryUnitType = (typeof ATOMIC_MEMORY_UNIT_TYPES)[number];
export type AtomicMemorySourceKind = (typeof ATOMIC_MEMORY_SOURCE_KINDS)[number];

export interface AtomicMemory {
  schema: typeof ATOMIC_MEMORY_SCHEMA;
  unitType: AtomicMemoryUnitType;
  sourceKind: AtomicMemorySourceKind;
  confidence: number;
  sourceRef?: string;
  tags?: string[];
}

export interface AtomicMemoryInput {
  unitType?: AtomicMemoryUnitType;
  sourceKind?: AtomicMemorySourceKind;
  confidence?: number;
  sourceRef?: string;
  tags?: string[];
}

type MetadataEnvelope = Record<string, unknown> & { atomic?: unknown };

function clamp01(value: unknown, fallback = 0.7): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  return tags.length > 0 ? tags : undefined;
}

function defaultUnitTypeForCategory(category: MemoryEntry["category"] | string): AtomicMemoryUnitType {
  switch (category) {
    case "preference":
    case "fact":
    case "decision":
    case "entity":
      return category;
    default:
      return "other";
  }
}

export function parseMemoryMetadata(raw?: string): MetadataEnvelope {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MetadataEnvelope)
      : {};
  } catch {
    return {};
  }
}

export function extractAtomicMemory(raw?: string): AtomicMemory | undefined {
  const atomic = parseMemoryMetadata(raw).atomic;
  if (!atomic || typeof atomic !== "object" || Array.isArray(atomic)) return undefined;

  const node = atomic as Record<string, unknown>;
  const unitType = ATOMIC_MEMORY_UNIT_TYPES.includes(node.unitType as AtomicMemoryUnitType)
    ? (node.unitType as AtomicMemoryUnitType)
    : undefined;
  const sourceKind = ATOMIC_MEMORY_SOURCE_KINDS.includes(node.sourceKind as AtomicMemorySourceKind)
    ? (node.sourceKind as AtomicMemorySourceKind)
    : undefined;

  if (node.schema !== ATOMIC_MEMORY_SCHEMA || !unitType || !sourceKind) return undefined;

  const sourceRef = asString(node.sourceRef);
  const tags = normalizeTags(node.tags);

  return {
    schema: ATOMIC_MEMORY_SCHEMA,
    unitType,
    sourceKind,
    confidence: clamp01(node.confidence, 0.7),
    ...(sourceRef ? { sourceRef } : {}),
    ...(tags ? { tags } : {}),
  };
}

export function buildAtomicMemoryMetadata(
  category: MemoryEntry["category"] | string,
  atomic?: AtomicMemoryInput,
  existingRaw?: string,
): string | undefined {
  if (!atomic) return existingRaw;

  const metadata = parseMemoryMetadata(existingRaw);
  const existingAtomic = extractAtomicMemory(existingRaw);
  const unitType = ATOMIC_MEMORY_UNIT_TYPES.includes(atomic.unitType as AtomicMemoryUnitType)
    ? (atomic.unitType as AtomicMemoryUnitType)
    : existingAtomic?.unitType ?? defaultUnitTypeForCategory(category);
  const sourceKind = ATOMIC_MEMORY_SOURCE_KINDS.includes(atomic.sourceKind as AtomicMemorySourceKind)
    ? (atomic.sourceKind as AtomicMemorySourceKind)
    : existingAtomic?.sourceKind ?? "user";
  const sourceRef = asString(atomic.sourceRef) ?? existingAtomic?.sourceRef;
  const tags = normalizeTags(atomic.tags) ?? existingAtomic?.tags;
  const confidence = atomic.confidence !== undefined
    ? clamp01(atomic.confidence, existingAtomic?.confidence ?? 0.7)
    : existingAtomic?.confidence ?? 0.7;

  metadata.atomic = {
    schema: ATOMIC_MEMORY_SCHEMA,
    unitType,
    sourceKind,
    confidence,
    ...(sourceRef ? { sourceRef } : {}),
    ...(tags ? { tags } : {}),
  } satisfies AtomicMemory;

  return JSON.stringify(metadata);
}

export function describeKnowledgeUnit(
  entry: Pick<MemoryEntry, "id" | "text" | "category" | "scope" | "importance" | "metadata">,
) {
  const atomic = extractAtomicMemory(entry.metadata);
  return {
    id: entry.id,
    text: entry.text,
    category: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    ...(atomic ? { atomic } : {}),
  };
}