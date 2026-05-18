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
];
/** Categories that always merge (skip dedup entirely). */
export const ALWAYS_MERGE_CATEGORIES = new Set(["profile"]);
/** Categories that support MERGE decision from LLM dedup. */
export const MERGE_SUPPORTED_CATEGORIES = new Set([
    "preferences",
    "entities",
    "patterns",
]);
/** Categories whose facts can be replaced over time without deleting history. */
export const TEMPORAL_VERSIONED_CATEGORIES = new Set([
    "preferences",
    "entities",
]);
/** Categories that are append-only (CREATE or SKIP only, no MERGE). */
export const APPEND_ONLY_CATEGORIES = new Set([
    "events",
    "cases",
]);
/** Validate and normalize a category string. */
export function normalizeCategory(raw) {
    const lower = raw.toLowerCase().trim();
    if (MEMORY_CATEGORIES.includes(lower)) {
        return lower;
    }
    return null;
}
