/**
 * Memory Compactor — Progressive Summarization
 *
 * Identifies clusters of semantically similar memories older than a configured
 * age threshold and merges each cluster into a single, higher-quality entry.
 *
 * Implements the "progressive summarization" pattern: memories get more refined
 * over time as related fragments are consolidated, reducing noise and improving
 * retrieval quality without requiring an external LLM call.
 *
 * Algorithm:
 *   1. Load memories older than `minAgeDays` (with vectors).
 *   2. Build similarity clusters using greedy cosine-similarity expansion.
 *   3. For each cluster >= `minClusterSize`, merge into one entry:
 *        - text:       deduplicated lines joined with newlines
 *        - importance: max of cluster members (never downgrade)
 *        - category:   plurality vote
 *        - scope:      shared scope (all members must share one)
 *        - metadata:   marked { compacted: true, sourceCount: N }
 *   4. Delete source entries, store merged entry.
 */
// ============================================================================
// Math helpers
// ============================================================================
/** Dot product of two equal-length vectors. */
function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
/** L2 norm of a vector. */
function norm(v) {
    return Math.sqrt(dot(v, v));
}
/**
 * Cosine similarity in [0, 1].
 * Returns 0 if either vector has zero norm (avoids NaN).
 */
export function cosineSimilarity(a, b) {
    if (a.length === 0 || a.length !== b.length)
        return 0;
    const na = norm(a);
    const nb = norm(b);
    if (na === 0 || nb === 0)
        return 0;
    return Math.max(0, Math.min(1, dot(a, b) / (na * nb)));
}
// ============================================================================
// Cluster building
// ============================================================================
/**
 * Greedy cluster expansion.
 *
 * Sort entries by importance DESC so the most valuable memory seeds each
 * cluster. Expand each seed by collecting every unassigned entry whose
 * cosine similarity with the seed is >= threshold.
 *
 * Returns an array of index-arrays (each inner array = one cluster).
 * Only clusters with >= minClusterSize entries are returned.
 */
export function buildClusters(entries, threshold, minClusterSize) {
    if (entries.length < minClusterSize)
        return [];
    // Sort indices by importance desc (highest importance seeds first)
    const order = entries
        .map((_, i) => i)
        .sort((a, b) => entries[b].importance - entries[a].importance);
    const assigned = new Uint8Array(entries.length); // 0 = unassigned
    const plans = [];
    for (const seedIdx of order) {
        if (assigned[seedIdx])
            continue;
        const cluster = [seedIdx];
        assigned[seedIdx] = 1;
        const seedVec = entries[seedIdx].vector;
        if (seedVec.length === 0)
            continue; // skip entries without vectors
        for (let j = 0; j < entries.length; j++) {
            if (assigned[j])
                continue;
            const jVec = entries[j].vector;
            if (jVec.length === 0)
                continue;
            if (cosineSimilarity(seedVec, jVec) >= threshold) {
                cluster.push(j);
                assigned[j] = 1;
            }
        }
        if (cluster.length >= minClusterSize) {
            const members = cluster.map((i) => entries[i]);
            plans.push({
                memberIndices: cluster,
                merged: buildMergedEntry(members),
            });
        }
    }
    return plans;
}
// ============================================================================
// Merge strategy
// ============================================================================
/**
 * Merge a cluster of entries into a single proposed entry.
 *
 * Text strategy: deduplicate lines across all member texts, join with newline.
 * This preserves all unique information while removing redundancy.
 *
 * Importance: max across cluster (never downgrade).
 * Category: plurality vote; ties broken by member with highest importance.
 * Scope: all members must share a scope (validated upstream).
 */
export function buildMergedEntry(members) {
    // --- text: deduplicate lines ---
    const seen = new Set();
    const lines = [];
    for (const m of members) {
        for (const line of m.text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && !seen.has(trimmed.toLowerCase())) {
                seen.add(trimmed.toLowerCase());
                lines.push(trimmed);
            }
        }
    }
    const text = lines.join("\n");
    // --- importance: max ---
    const importance = Math.min(1.0, Math.max(...members.map((m) => m.importance)));
    // --- category: plurality vote ---
    const counts = new Map();
    for (const m of members) {
        counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
    }
    let category = "other";
    let best = 0;
    for (const [cat, count] of counts) {
        if (count > best) {
            best = count;
            category = cat;
        }
    }
    // --- scope: use the first (all should match) ---
    const scope = members[0].scope;
    // --- metadata ---
    const metadata = JSON.stringify({
        compacted: true,
        sourceCount: members.length,
        compactedAt: Date.now(),
    });
    return { text, importance, category, scope, metadata };
}
// ============================================================================
// Main runner
// ============================================================================
/**
 * Run a single compaction pass over memories in the given scopes.
 *
 * @param store     Storage backend (must support fetchForCompaction + store + delete)
 * @param embedder  Used to embed merged text before storage
 * @param config    Compaction configuration
 * @param scopes    Scope filter; undefined = all scopes
 * @param logger    Optional logger
 */
export async function runCompaction(store, embedder, config, scopes, logger) {
    const cutoff = Date.now() - config.minAgeDays * 24 * 60 * 60 * 1000;
    const entries = await store.fetchForCompaction(cutoff, scopes, config.maxMemoriesToScan);
    if (entries.length === 0) {
        return {
            scanned: 0,
            clustersFound: 0,
            memoriesDeleted: 0,
            memoriesCreated: 0,
            dryRun: config.dryRun,
        };
    }
    // Filter out entries without vectors (shouldn't happen but be safe)
    const valid = entries.filter((e) => e.vector && e.vector.length > 0);
    const plans = buildClusters(valid, config.similarityThreshold, config.minClusterSize);
    if (config.dryRun) {
        logger?.info(`memory-compactor [dry-run]: scanned=${valid.length} clusters=${plans.length}`);
        return {
            scanned: valid.length,
            clustersFound: plans.length,
            memoriesDeleted: 0,
            memoriesCreated: 0,
            dryRun: true,
        };
    }
    let memoriesDeleted = 0;
    let memoriesCreated = 0;
    for (const plan of plans) {
        const members = plan.memberIndices.map((i) => valid[i]);
        try {
            // Embed the merged text
            const vector = await embedder.embedPassage(plan.merged.text);
            // Store merged entry
            await store.store({
                text: plan.merged.text,
                vector,
                importance: plan.merged.importance,
                category: plan.merged.category,
                scope: plan.merged.scope,
                metadata: plan.merged.metadata,
            });
            memoriesCreated++;
            // Delete source entries
            for (const m of members) {
                const deleted = await store.delete(m.id);
                if (deleted)
                    memoriesDeleted++;
            }
        }
        catch (err) {
            logger?.warn(`memory-compactor: failed to merge cluster of ${members.length}: ${String(err)}`);
        }
    }
    logger?.info(`memory-compactor: scanned=${valid.length} clusters=${plans.length} ` +
        `deleted=${memoriesDeleted} created=${memoriesCreated}`);
    return {
        scanned: valid.length,
        clustersFound: plans.length,
        memoriesDeleted,
        memoriesCreated,
        dryRun: false,
    };
}
// ============================================================================
// Cooldown helper
// ============================================================================
/**
 * Check whether enough time has passed since the last compaction run.
 * Uses a simple JSON file at `stateFile` to persist the last-run timestamp.
 */
export async function shouldRunCompaction(stateFile, cooldownHours) {
    try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(stateFile, "utf8");
        const state = JSON.parse(raw);
        if (typeof state.lastRunAt === "number") {
            const elapsed = Date.now() - state.lastRunAt;
            return elapsed >= cooldownHours * 60 * 60 * 1000;
        }
    }
    catch {
        // File doesn't exist or is malformed — treat as never run
    }
    return true;
}
export async function recordCompactionRun(stateFile) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}
