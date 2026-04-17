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

/**
 * Knowledge vs Experience decoupling (see arxiv:2602.05665 §III-C, §V-E).
 *
 * - knowledge: passive, static, verifiable reference (profile / preferences / entities / patterns)
 * - experience: trajectory log of interactions and outcomes (events / cases)
 */
export type MemoryType = "knowledge" | "experience";

const KNOWLEDGE_CATEGORIES = new Set<MemoryCategory>([
  "profile",
  "preferences",
  "entities",
  "patterns",
]);

const EXPERIENCE_CATEGORIES = new Set<MemoryCategory>([
  "events",
  "cases",
]);

const KNOWLEDGE_LEGACY = new Set(["preference", "fact", "entity"]);
const EXPERIENCE_LEGACY = new Set(["decision", "reflection"]);

/**
 * Classify a memory as knowledge or experience.
 * Prefers the 6-category `memory_category`; falls back to the legacy top-level category.
 * Defaults to "knowledge" when neither is informative (conservative for decay: knowledge decays slower).
 */
export function classifyMemoryType(
  memoryCategory: MemoryCategory | string | undefined,
  legacyCategory?: string,
): MemoryType {
  if (typeof memoryCategory === "string") {
    const mc = memoryCategory as MemoryCategory;
    if (KNOWLEDGE_CATEGORIES.has(mc)) return "knowledge";
    if (EXPERIENCE_CATEGORIES.has(mc)) return "experience";
  }
  if (legacyCategory) {
    const lc = legacyCategory.toLowerCase();
    if (KNOWLEDGE_LEGACY.has(lc)) return "knowledge";
    if (EXPERIENCE_LEGACY.has(lc)) return "experience";
  }
  return "knowledge";
}

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
  if ((MEMORY_CATEGORIES as readonly string[]).includes(lower)) {
    return lower as MemoryCategory;
  }
  return null;
}
