/**
 * Memory Upgrader — Convert legacy memories to new smart memory format
 *
 * Legacy memories lack L0/L1/L2 metadata, memory_category (6-category),
 * tier, access_count, and confidence fields. This module enriches them
 * to enable unified memory lifecycle management (decay, tier promotion,
 * smart dedup).
 *
 * Pipeline per batch:
 *   1. Detect legacy format (missing `memory_category` in metadata)
 *   2. Reverse-map 5-category → 6-category and generate L0/L1/L2
 *   3. Prepare update patches without holding the DB write lock
 *   4. Write prepared patches in a batch where the store supports it
 */
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
const CURRENT_REFLECTION_METADATA_TYPES = new Set([
    "memory-reflection",
    "memory-reflection-event",
    "memory-reflection-item",
    "memory-reflection-mapped",
]);
function parseMetadata(metadata) {
    if (!metadata)
        return null;
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function isCurrentReflectionMemory(entry) {
    if (entry.category === "reflection")
        return true;
    const meta = parseMetadata(entry.metadata);
    return typeof meta?.type === "string" && CURRENT_REFLECTION_METADATA_TYPES.has(meta.type);
}
// ============================================================================
// Reverse Category Mapping
// ============================================================================
/**
 * Reverse-map old 5-category → new 6-category.
 *
 * Ambiguous case: `fact` maps to both `profile` and `cases`.
 * Without LLM, defaults to `cases` (conservative).
 * With LLM, the enrichment prompt will determine the correct category.
 */
function reverseMapCategory(oldCategory, text) {
    switch (oldCategory) {
        case "preference":
            return "preferences";
        case "entity":
            return "entities";
        case "decision":
            return "events";
        case "other":
            return "patterns";
        case "fact":
            // Heuristic: if text looks like personal identity info, map to profile
            if (/\b(my |i am |i'm |name is |叫我|我的|我是)\b/i.test(text) &&
                text.length < 200) {
                return "profile";
            }
            return "cases";
        default:
            return "patterns";
    }
}
// ============================================================================
// LLM Upgrade Prompt
// ============================================================================
function buildUpgradePrompt(text, category) {
    return `You are a memory librarian. Given a raw memory text and its category, produce a structured 3-layer summary.

**Category**: ${category}

**Raw memory text**:
"""
${text.slice(0, 2000)}
"""

Return ONLY valid JSON (no markdown fences):
{
  "l0_abstract": "One sentence (≤30 words) summarizing the core fact/preference/event",
  "l1_overview": "A structured markdown summary (2-5 bullet points)",
  "l2_content": "The full original text, cleaned up if needed",
  "resolved_category": "${category}"
}

Rules:
- l0_abstract must be a single concise sentence, suitable as a search index key
- l1_overview should use markdown bullet points to structure the information
- l2_content should preserve the original meaning; may clean up formatting
- resolved_category: if the text is clearly about personal identity/profile info (name, age, role, etc.), set to "profile"; if it's a reusable problem-solution pair, set to "cases"; otherwise keep "${category}"
- Respond in the SAME language as the raw memory text`;
}
// ============================================================================
// Simple (No-LLM) Enrichment
// ============================================================================
function simpleEnrich(text, category) {
    // L0: first sentence or first 80 chars
    const firstSentence = text.match(/^[^.!?。！？\n]+[.!?。！？]?/)?.[0] || text;
    const l0 = firstSentence.slice(0, 100).trim();
    // L1: structured as a single bullet
    const l1 = `- ${l0}`;
    // L2: full text
    return {
        l0_abstract: l0,
        l1_overview: l1,
        l2_content: text,
    };
}
// ============================================================================
// Memory Upgrader
// ============================================================================
export class MemoryUpgrader {
    store;
    llm;
    options;
    log;
    constructor(store, llm, options = {}) {
        this.store = store;
        this.llm = llm;
        this.options = options;
        this.log = options.log ?? console.log;
    }
    /**
     * Check if a memory entry is in legacy format (needs upgrade).
     * Legacy = no metadata, or metadata lacks `memory_category`.
     * Reflection rows are first-class current-format memories with their own
     * metadata schema and read path, so they intentionally do not carry
     * SmartExtractor `memory_category`.
     */
    isLegacyMemory(entry) {
        if (isCurrentReflectionMemory(entry))
            return false;
        if (!entry.metadata)
            return true;
        const meta = parseMetadata(entry.metadata);
        if (!meta)
            return true;
        // If it has memory_category, it was created by SmartExtractor → new format
        return !meta.memory_category;
    }
    /**
     * Scan and count legacy memories without modifying them.
     */
    async countLegacy(scopeFilter) {
        const allMemories = await this.store.list(scopeFilter, undefined, 10000, 0);
        let legacy = 0;
        const byCategory = {};
        for (const entry of allMemories) {
            if (this.isLegacyMemory(entry)) {
                legacy++;
                byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
            }
        }
        return { total: allMemories.length, legacy, byCategory };
    }
    /**
     * Main upgrade entry point.
     * Scans all memories, filters legacy ones, and enriches them.
     */
    async upgrade(options = {}) {
        const batchSize = options.batchSize ?? this.options.batchSize ?? 10;
        const noLlm = options.noLlm ?? this.options.noLlm ?? false;
        const dryRun = options.dryRun ?? this.options.dryRun ?? false;
        const limit = options.limit ?? this.options.limit;
        const result = {
            totalLegacy: 0,
            upgraded: 0,
            skipped: 0,
            errors: [],
        };
        // Load all memories
        this.log("memory-upgrader: scanning memories...");
        const allMemories = await this.store.list(options.scopeFilter ?? this.options.scopeFilter, undefined, 10000, 0);
        // Filter legacy memories
        const legacyMemories = allMemories.filter((m) => this.isLegacyMemory(m));
        result.totalLegacy = legacyMemories.length;
        result.skipped = allMemories.length - legacyMemories.length;
        if (legacyMemories.length === 0) {
            this.log("memory-upgrader: no legacy memories found — all memories are already in new format");
            return result;
        }
        this.log(`memory-upgrader: found ${legacyMemories.length} legacy memories out of ${allMemories.length} total`);
        if (dryRun) {
            const byCategory = {};
            for (const m of legacyMemories) {
                byCategory[m.category] = (byCategory[m.category] || 0) + 1;
            }
            this.log(`memory-upgrader: [DRY-RUN] would upgrade ${legacyMemories.length} memories`);
            this.log(`memory-upgrader: [DRY-RUN] breakdown: ${JSON.stringify(byCategory)}`);
            return result;
        }
        // Process in batches
        const toProcess = limit
            ? legacyMemories.slice(0, limit)
            : legacyMemories;
        for (let i = 0; i < toProcess.length; i += batchSize) {
            const batch = toProcess.slice(i, i + batchSize);
            this.log(`memory-upgrader: processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toProcess.length / batchSize)} (${batch.length} memories)`);
            const prepared = [];
            for (const entry of batch) {
                try {
                    prepared.push(await this.prepareUpgradeEntry(entry, noLlm));
                }
                catch (err) {
                    const errMsg = `Failed to prepare upgrade ${entry.id}: ${String(err)}`;
                    result.errors.push(errMsg);
                    this.log(`memory-upgrader: ERROR — ${errMsg}`);
                }
            }
            await this.writePreparedBatch(prepared, result, options.scopeFilter ?? this.options.scopeFilter);
            // Progress report
            this.log(`memory-upgrader: progress — ${result.upgraded} upgraded, ${result.errors.length} errors`);
        }
        this.log(`memory-upgrader: upgrade complete — ${result.upgraded} upgraded, ${result.skipped} already new, ${result.errors.length} errors`);
        return result;
    }
    /**
     * Prepare a single legacy memory entry without writing to the store.
     */
    async prepareUpgradeEntry(entry, noLlm) {
        // Step 1: Reverse-map category
        let newCategory = reverseMapCategory(entry.category, entry.text);
        // Step 2: Generate L0/L1/L2
        let enriched;
        if (!noLlm && this.llm) {
            try {
                const prompt = buildUpgradePrompt(entry.text, newCategory);
                const llmResult = await this.llm.completeJson(prompt);
                if (!llmResult) {
                    const detail = this.llm.getLastError();
                    throw new Error(detail || "LLM returned null");
                }
                enriched = {
                    l0_abstract: llmResult.l0_abstract || simpleEnrich(entry.text, newCategory).l0_abstract,
                    l1_overview: llmResult.l1_overview || simpleEnrich(entry.text, newCategory).l1_overview,
                    l2_content: llmResult.l2_content || entry.text,
                };
                // LLM may have resolved the ambiguous fact→profile/cases
                if (llmResult.resolved_category) {
                    const validCategories = new Set([
                        "profile", "preferences", "entities", "events", "cases", "patterns",
                    ]);
                    if (validCategories.has(llmResult.resolved_category)) {
                        newCategory = llmResult.resolved_category;
                    }
                }
            }
            catch (err) {
                this.log(`memory-upgrader: LLM enrichment failed for ${entry.id}, falling back to simple — ${String(err)}`);
                enriched = simpleEnrich(entry.text, newCategory);
            }
        }
        else {
            enriched = simpleEnrich(entry.text, newCategory);
        }
        // Step 3: Build enriched metadata
        const existingMeta = entry.metadata ? (() => {
            try {
                return JSON.parse(entry.metadata);
            }
            catch {
                return {};
            }
        })() : {};
        const newMetadata = {
            ...buildSmartMetadata({ ...entry, metadata: JSON.stringify(existingMeta) }, {
                l0_abstract: enriched.l0_abstract,
                l1_overview: enriched.l1_overview,
                l2_content: enriched.l2_content,
                memory_category: newCategory,
                tier: "working",
                access_count: 0,
                confidence: 0.7,
            }),
            upgraded_from: entry.category,
            upgraded_at: Date.now(),
        };
        return {
            entry,
            updates: {
                // Keep the existing upgrader behavior in this PR: the primary text
                // column is updated to L0, while L2 remains in smart metadata.
                text: enriched.l0_abstract,
                metadata: stringifySmartMetadata(newMetadata),
            },
        };
    }
    /**
     * Persist a prepared batch with one store-level batch call when available.
     */
    async writePreparedBatch(prepared, result, scopeFilter) {
        if (prepared.length === 0)
            return;
        const store = this.store;
        if (typeof store.bulkUpdateExact === "function") {
            let writeResults;
            try {
                writeResults = await store.bulkUpdateExact(prepared.map(({ entry, updates }) => ({ id: entry.id, updates })), scopeFilter);
            }
            catch (err) {
                for (const { entry } of prepared) {
                    const errMsg = `Failed to write upgrade ${entry.id}: ${String(err)}`;
                    result.errors.push(errMsg);
                    this.log(`memory-upgrader: ERROR — ${errMsg}`);
                }
                return;
            }
            for (let index = 0; index < writeResults.length; index++) {
                const writeResult = writeResults[index];
                const fallbackEntry = prepared[index]?.entry;
                if (writeResult.entry) {
                    result.upgraded++;
                }
                else {
                    const id = writeResult.id ?? fallbackEntry?.id ?? "unknown";
                    const detail = writeResult.error ? `: ${writeResult.error}` : "";
                    const errMsg = `Failed to write upgrade ${id}${detail}`;
                    result.errors.push(errMsg);
                    this.log(`memory-upgrader: ERROR — ${errMsg}`);
                }
            }
            return;
        }
        for (const { entry, updates } of prepared) {
            try {
                await this.store.update(entry.id, updates, scopeFilter);
                result.upgraded++;
            }
            catch (err) {
                const errMsg = `Failed to write upgrade ${entry.id}: ${String(err)}`;
                result.errors.push(errMsg);
                this.log(`memory-upgrader: ERROR — ${errMsg}`);
            }
        }
    }
}
// ============================================================================
// Factory
// ============================================================================
export function createMemoryUpgrader(store, llm, options = {}) {
    return new MemoryUpgrader(store, llm, options);
}
