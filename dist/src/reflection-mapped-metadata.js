const REFLECTION_MAPPED_DECAY_DEFAULTS = {
    decision: { midpointDays: 45, k: 0.25, baseWeight: 1.1, quality: 1 },
    "user-model": { midpointDays: 21, k: 0.3, baseWeight: 1, quality: 0.95 },
    "agent-model": { midpointDays: 10, k: 0.35, baseWeight: 0.95, quality: 0.93 },
    lesson: { midpointDays: 7, k: 0.45, baseWeight: 0.9, quality: 0.9 },
};
export function getReflectionMappedDecayDefaults(kind) {
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
const REFLECTION_MAPPED_MEMORY_CATEGORY = {
    "user-model": "preferences",
    // Agent self-observations are reusable assistant behavior, not statements
    // about the human -- minting them as user "preferences" polluted recall
    // and consolidation with rows that read as the user's own tendencies.
    "agent-model": "patterns",
    lesson: "cases",
    decision: "cases",
};
export function getReflectionMappedMemoryCategory(kind) {
    return REFLECTION_MAPPED_MEMORY_CATEGORY[kind];
}
export function buildReflectionMappedMetadata(params) {
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
        // Write-time L0/L1/L2: a mapped row is one distilled line, so the line is
        // its own abstract and content; the distillate section heading is the one
        // piece of extra context worth an overview. Level-less mapped rows used to
        // render as three identical fallback lines in every shared pipeline prompt.
        l0_abstract: params.mappedItem.text,
        l1_overview: `## ${params.mappedItem.heading}\n- ${params.mappedItem.text}`,
        l2_content: params.mappedItem.text,
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
