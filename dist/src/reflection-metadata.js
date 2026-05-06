export function parseReflectionMetadata(metadataRaw) {
    if (!metadataRaw)
        return {};
    try {
        const parsed = JSON.parse(metadataRaw);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
export function isReflectionEntry(entry) {
    if (entry.category === "reflection")
        return true;
    const metadata = parseReflectionMetadata(entry.metadata);
    return metadata.type === "memory-reflection" ||
        metadata.type === "memory-reflection-event" ||
        metadata.type === "memory-reflection-item";
}
export function getDisplayCategoryTag(entry) {
    if (!isReflectionEntry(entry))
        return `${entry.category}:${entry.scope}`;
    return `reflection:${entry.scope}`;
}
