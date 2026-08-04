/**
 * Manual-store echo guard (class): when the user dictates a memory,
 * the same sentence reaches BOTH the manual store lane (memory_store /
 * memory_update, always-priority, verbatim) and auto-capture extraction,
 * which mints near-twin candidates the dedup layer cannot reliably collide —
 * the manual row may be seconds old (fresh-row vector visibility) or land in
 * a different category. The guard remembers recent manual texts per agent
 * and drops near-identical extraction candidates BEFORE the admission judge:
 * deterministic, string-only, no LLM calls, no vector search.
 *
 * Scoped per agent (not per session): the store tool and the auto-capture
 * hook derive their session keys differently, but both resolve the same
 * agent id, and an echo of ANY recent manual text of the same agent is a
 * correct drop regardless of session boundaries. The ring bounds staleness.
 */
export const MANUAL_ECHO_JACCARD_THRESHOLD = 0.75;
export const MANUAL_ECHO_SUBSET_THRESHOLD = 0.9;
export const MANUAL_ECHO_RING_SIZE = 8;
const MAX_TRACKED_AGENTS = 128;
const MIN_CONTAINMENT_TOKENS = 3;
const DEFAULT_AGENT_BUCKET = "main";
export function normalizeEchoText(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function tokenSet(normalized) {
    return new Set(normalized.split(" ").filter((t) => t.length > 0));
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const token of a) {
        if (b.has(token))
            intersection++;
    }
    return intersection / (a.size + b.size - intersection);
}
function subsetRatio(inner, outer) {
    if (inner.size === 0)
        return 0;
    let contained = 0;
    for (const token of inner) {
        if (outer.has(token))
            contained++;
    }
    return contained / inner.size;
}
export function isNearIdenticalEcho(candidateText, manualText) {
    const candidate = normalizeEchoText(candidateText);
    const manual = normalizeEchoText(manualText);
    if (candidate.length === 0 || manual.length === 0)
        return false;
    if (candidate === manual)
        return true;
    const manualTokens = tokenSet(manual);
    // Very short manual texts over-match as substrings ("blue mug" is inside
    // any sentence mentioning it); those only count as echoes when exact.
    if (manualTokens.size < MIN_CONTAINMENT_TOKENS)
        return false;
    if (candidate.includes(manual) || manual.includes(candidate))
        return true;
    // Token-subset containment: the canonical echo shape is the extractor
    // sentence-wrapping the manual fact ("favorite teacup: the red one" ->
    // "User's favorite teacup is the red one"), where glue words break
    // character containment and dilute Jaccard. One side's tokens (nearly)
    // all present in the other = echo.
    const candidateTokens = tokenSet(candidate);
    if (subsetRatio(manualTokens, candidateTokens) >= MANUAL_ECHO_SUBSET_THRESHOLD ||
        (candidateTokens.size >= MIN_CONTAINMENT_TOKENS &&
            subsetRatio(candidateTokens, manualTokens) >= MANUAL_ECHO_SUBSET_THRESHOLD)) {
        return true;
    }
    return jaccard(candidateTokens, manualTokens) >= MANUAL_ECHO_JACCARD_THRESHOLD;
}
export class ManualEchoLedger {
    byAgent = new Map();
    record(agentId, text) {
        if (typeof text !== "string" || text.trim().length === 0)
            return;
        const key = agentId?.trim() || DEFAULT_AGENT_BUCKET;
        const ring = this.byAgent.get(key) ?? [];
        ring.push(text);
        while (ring.length > MANUAL_ECHO_RING_SIZE)
            ring.shift();
        this.byAgent.delete(key);
        this.byAgent.set(key, ring);
        while (this.byAgent.size > MAX_TRACKED_AGENTS) {
            const oldest = this.byAgent.keys().next().value;
            if (oldest === undefined)
                break;
            this.byAgent.delete(oldest);
        }
    }
    /** Returns the matched manual text, or null when the candidate is no echo. */
    match(agentId, candidateText) {
        const key = agentId?.trim() || DEFAULT_AGENT_BUCKET;
        const ring = this.byAgent.get(key);
        if (!ring || ring.length === 0)
            return null;
        for (let i = ring.length - 1; i >= 0; i--) {
            if (isNearIdenticalEcho(candidateText, ring[i]))
                return ring[i];
        }
        return null;
    }
    clear(agentId) {
        this.byAgent.delete(agentId?.trim() || DEFAULT_AGENT_BUCKET);
    }
}
