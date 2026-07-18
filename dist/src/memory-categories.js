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
const SMART_TO_STORAGE_CATEGORY = {
    profile: "fact",
    preferences: "preference",
    entities: "entity",
    events: "decision",
    cases: "fact",
    patterns: "other",
};
const LEGACY_TO_SMART_CATEGORY = {
    preference: "preferences",
    fact: "cases",
    decision: "events",
    entity: "entities",
    reflection: "patterns",
    other: "patterns",
};
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
export function matchesMemoryCategoryFilter(entryCategory, requestedCategory, entryMetadata) {
    const rawEntryCategory = entryCategory.toLowerCase().trim();
    const rawRequestedCategory = requestedCategory.toLowerCase().trim();
    if (rawEntryCategory === rawRequestedCategory)
        return true;
    const metadataCategory = extractMetadataMemoryCategory(entryMetadata);
    const normalizedEntryCategory = normalizeCategory(rawEntryCategory);
    const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
    if (metadataCategory && normalizedRequestedCategory) {
        return metadataCategory === normalizedRequestedCategory;
    }
    if (normalizedEntryCategory && normalizedRequestedCategory) {
        return normalizedEntryCategory === normalizedRequestedCategory;
    }
    if (normalizedRequestedCategory && isLegacyMemoryCategory(rawEntryCategory)) {
        return LEGACY_TO_SMART_CATEGORY[rawEntryCategory] === normalizedRequestedCategory;
    }
    return false;
}
export function resolveCategoryFilterCandidates(requestedCategory) {
    const rawRequestedCategory = requestedCategory.toLowerCase().trim();
    const normalizedRequestedCategory = normalizeCategory(rawRequestedCategory);
    const candidates = new Set([rawRequestedCategory]);
    if (normalizedRequestedCategory) {
        candidates.add(normalizedRequestedCategory);
        candidates.add(SMART_TO_STORAGE_CATEGORY[normalizedRequestedCategory]);
        for (const category of TOOL_MEMORY_CATEGORIES) {
            if (normalizeCategory(category) === normalizedRequestedCategory) {
                candidates.add(category);
            }
        }
    }
    return [...candidates];
}
export function getStorageCategoryForMemoryCategory(category) {
    return SMART_TO_STORAGE_CATEGORY[category];
}
export function resolveToolMemoryCategory(rawCategory) {
    const raw = rawCategory.toLowerCase().trim();
    const normalized = normalizeCategory(raw);
    if (normalized) {
        return {
            memoryCategory: normalized,
            storageCategory: SMART_TO_STORAGE_CATEGORY[normalized],
        };
    }
    if (isLegacyMemoryCategory(raw)) {
        return {
            memoryCategory: LEGACY_TO_SMART_CATEGORY[raw],
            storageCategory: raw,
        };
    }
    return {
        memoryCategory: "patterns",
        storageCategory: "other",
    };
}
function isLegacyMemoryCategory(value) {
    return LEGACY_MEMORY_CATEGORIES.includes(value);
}
function extractMetadataMemoryCategory(rawMetadata) {
    if (!rawMetadata)
        return null;
    try {
        const parsed = JSON.parse(rawMetadata);
        if (typeof parsed.memory_category !== "string")
            return null;
        return normalizeCategory(parsed.memory_category);
    }
    catch {
        return null;
    }
}
/**
 * Clamp the batchChunkSize knob (JR-less public form: per-call chunk bound
 * for every batched pipeline stage). Non-numeric or non-positive input falls
 * back to the historical hardcoded 10; the ceiling guards prompt size.
 */
export const DEFAULT_BATCH_CHUNK_SIZE = 10;
export const MAX_BATCH_CHUNK_SIZE = 50;
export function clampBatchChunkSize(raw) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0)
        return DEFAULT_BATCH_CHUNK_SIZE;
    return Math.min(MAX_BATCH_CHUNK_SIZE, Math.max(1, Math.floor(n)));
}
