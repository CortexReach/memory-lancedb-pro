/**
 * Batch-Internal Dedup — Cosine similarity dedup within extraction batches
 *
 * Before running expensive per-candidate LLM dedup calls, this module
 * checks all candidates against each other using cosine similarity
 * on their embedded abstracts. Candidates with similarity > threshold
 * are marked as batch duplicates and skipped.
 *
 * For n <= 5 candidates, O(n^2) pairwise comparison is trivial.
 */
// ============================================================================
// Cosine Similarity
// ============================================================================
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const norm = Math.sqrt(normA) * Math.sqrt(normB);
    return norm === 0 ? 0 : dotProduct / norm;
}
// ============================================================================
// Batch Dedup
// ============================================================================
/**
 * Perform batch-internal cosine dedup on candidate abstracts.
 *
 * @param abstracts - Array of L0 abstract strings from extracted candidates
 * @param vectors - Parallel array of embedded vectors for each abstract
 * @param threshold - Cosine similarity threshold above which candidates are considered duplicates (default: 0.85)
 * @returns BatchDedupResult with surviving and duplicate indices
 */
export function batchDedup(abstracts, vectors, threshold = 0.85) {
    const n = abstracts.length;
    if (n <= 1) {
        return {
            survivingIndices: n === 1 ? [0] : [],
            duplicateIndices: [],
            inputCount: n,
            outputCount: n,
        };
    }
    // Track which candidates are duplicates
    const isDuplicate = new Array(n).fill(false);
    const duplicateOf = new Array(n).fill(undefined);
    // Pairwise comparison: O(n^2) but n <= 5 typically
    for (let i = 0; i < n; i++) {
        if (isDuplicate[i])
            continue;
        for (let j = i + 1; j < n; j++) {
            if (isDuplicate[j])
                continue;
            if (!vectors[i] || !vectors[j])
                continue;
            if (vectors[i].length === 0 || vectors[j].length === 0)
                continue;
            const sim = cosineSimilarity(vectors[i], vectors[j]);
            if (sim > threshold) {
                // Mark the later candidate as duplicate of the earlier one
                isDuplicate[j] = true;
                duplicateOf[j] = i;
            }
        }
    }
    const survivingIndices = [];
    const duplicateIndices = [];
    for (let i = 0; i < n; i++) {
        if (isDuplicate[i]) {
            duplicateIndices.push(i);
        }
        else {
            survivingIndices.push(i);
        }
    }
    return {
        survivingIndices,
        duplicateIndices,
        inputCount: n,
        outputCount: survivingIndices.length,
    };
}
/**
 * Create a fresh ExtractionCostStats tracker.
 */
export function createExtractionCostStats() {
    return {
        batchDeduped: 0,
        durationMs: 0,
        llmCalls: 0,
    };
}
