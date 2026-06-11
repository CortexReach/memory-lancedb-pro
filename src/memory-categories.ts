/**
 * Memory Categories — 6-category classification system
 *
 * UserMemory: profile, preferences, entities, events
 * AgentMemory: cases, patterns
 */

export const MEMORY_CATEGORIES = [
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
] as const;

export const LEGACY_MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export const TOOL_MEMORY_CATEGORIES = [
  ...MEMORY_CATEGORIES,
  ...LEGACY_MEMORY_CATEGORIES,
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Categories that always merge (skip dedup entirely). */
export const ALWAYS_MERGE_CATEGORIES = new Set<MemoryCategory>(["profile"]);

/** Categories that support MERGE decision from LLM dedup. */
export const MERGE_SUPPORTED_CATEGORIES = new Set<MemoryCategory>([
  "preferences",
  "entities",
  "patterns",
]);

/** Categories whose facts can be replaced over time without deleting history. */
export const TEMPORAL_VERSIONED_CATEGORIES = new Set<MemoryCategory>([
  "preferences",
  "entities",
]);

/** Categories that are append-only (CREATE or SKIP only, no MERGE). */
export const APPEND_ONLY_CATEGORIES = new Set<MemoryCategory>([
  "events",
  "cases",
]);

/** Memory tier levels for lifecycle management. */
export type MemoryTier = "core" | "working" | "peripheral";

/** A candidate memory extracted from conversation by LLM. */
export type CandidateMemory = {
  category: MemoryCategory;
  abstract: string; // L0: one-sentence index
  overview: string; // L1: structured markdown summary
  content: string; // L2: full narrative
};

/** Dedup decision from LLM. */
export type DedupDecision =
  | "create"
  | "merge"
  | "skip"
  | "support"
  | "contextualize"
  | "contradict"
  | "supersede";

export type DedupResult = {
  decision: DedupDecision;
  reason: string;
  matchId?: string; // ID of existing memory to merge with
  contextLabel?: string; // Optional context label for support/contextualize/contradict
};

export type ExtractionStats = {
  created: number;
  merged: number;
  skipped: number;
  rejected?: number; // admission control rejections
  boundarySkipped?: number;
  supported?: number; // context-aware support count
  superseded?: number; // temporal fact replacements
};

/** Validate and normalize a category string. */
export function normalizeCategory(raw: string): MemoryCategory | null {
  const lower = raw.toLowerCase().trim();
  const aliases: Record<string, MemoryCategory> = {
    preference: "preferences",
    entity: "entities",
    event: "events",
    case: "cases",
    pattern: "patterns",
  };
  const normalized = aliases[lower] ?? lower;
  if ((MEMORY_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as MemoryCategory;
  }
  return null;
}

export function matchesMemoryCategoryFilter(
  entryCategory: string,
  requestedCategory: string,
): boolean {
  const rawEntryCategory = entryCategory.toLowerCase().trim();
  const rawRequestedCategory = requestedCategory.toLowerCase().trim();
  if (rawEntryCategory === rawRequestedCategory) return true;

  const normalizedEntryCategory = normalizeCategory(rawEntryCategory);
  const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
  return normalizedEntryCategory !== null &&
    normalizedRequestedCategory !== null &&
    normalizedEntryCategory === normalizedRequestedCategory;
}

export function resolveCategoryFilterCandidates(requestedCategory: string): string[] {
  const rawRequestedCategory = requestedCategory.toLowerCase().trim();
  const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
  const candidates = new Set<string>([rawRequestedCategory]);

  if (normalizedRequestedCategory) {
    candidates.add(normalizedRequestedCategory);
    for (const category of TOOL_MEMORY_CATEGORIES) {
      if (normalizeCategory(category) === normalizedRequestedCategory) {
        candidates.add(category);
      }
    }
  }

  return [...candidates];
}
