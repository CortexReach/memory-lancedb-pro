export const SEARCH_TEXT_COLUMN = "search_text";
export const LEGACY_FTS_COLUMN = "text";
const SUMMARY_LAYER_KEYS = ["l0_abstract", "l1_overview", "l2_content"];
function readSummaryLayers(metadata) {
    if (typeof metadata !== "string" || metadata.length === 0)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(metadata);
    }
    catch {
        return [];
    }
    if (!parsed || typeof parsed !== "object")
        return [];
    const record = parsed;
    return SUMMARY_LAYER_KEYS
        .map((key) => record[key])
        .filter((value) => typeof value === "string");
}
/**
 * The BM25 source for a row: the abstract plus every summary layer stored in
 * the metadata, so a token that only survives in the overview or the content
 * is still reachable by keyword. Identical layers are folded once.
 */
export function buildSearchText(text, metadata) {
    const parts = [];
    const seen = new Set();
    for (const candidate of [text ?? "", ...readSummaryLayers(metadata)]) {
        const trimmed = candidate.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        parts.push(trimmed);
    }
    return parts.join("\n");
}
