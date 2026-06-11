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
export const LEGACY_MEMORY_CATEGORIES = [
    "preference",
    "fact",
    "decision",
    "entity",
    "reflection",
    "other",
];
export const TOOL_MEMORY_CATEGORIES = [
    ...MEMORY_CATEGORIES,
    ...LEGACY_MEMORY_CATEGORIES,
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
    const aliases = {
        preference: "preferences",
        entity: "entities",
        event: "events",
        case: "cases",
        pattern: "patterns",
    };
    const normalized = aliases[lower] ?? lower;
    if (MEMORY_CATEGORIES.includes(normalized)) {
        return normalized;
    }
    return null;
}
export function matchesMemoryCategoryFilter(entryCategory, requestedCategory) {
    const rawEntryCategory = entryCategory.toLowerCase().trim();
    const rawRequestedCategory = requestedCategory.toLowerCase().trim();
    if (rawEntryCategory === rawRequestedCategory)
        return true;
    const normalizedEntryCategory = normalizeCategory(rawEntryCategory);
    const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
    return normalizedEntryCategory !== null &&
        normalizedRequestedCategory !== null &&
        normalizedEntryCategory === normalizedRequestedCategory;
}
export function resolveCategoryFilterCandidates(requestedCategory) {
    const rawRequestedCategory = requestedCategory.toLowerCase().trim();
    const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
    const candidates = new Set([rawRequestedCategory]);
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
