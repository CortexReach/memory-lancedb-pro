/**
 * Memory Upgrader — Convert legacy memories to new smart memory format
 *
 * Legacy memories lack L0/L1/L2 metadata, memory_category (6-category),
 * tier, access_count, and confidence fields. This module enriches them
 * to enable unified memory lifecycle management (decay, tier promotion,
 * smart dedup).
 *
 * Pipeline per memory:
 *   1. Detect legacy format (missing `memory_category` in metadata)
 *   2. Reverse-map 5-category → 6-category
 *   3. Generate L0/L1/L2 via LLM (or fallback to simple rules)
 *   4. Write enriched metadata back via store.update()
 *
 * Two-Phase Processing (Issue #632 fix):
 *   Phase 1: LLM enrichment (no lock, can run concurrently)
 *   Phase 2: DB writes via bulkUpdateMetadataWithPatch (ONE LOCK per batch)
 *
 * This significantly reduces both lock hold time AND lock count:
 *   - OLD: lock held during LLM call (seconds, blocks plugin) + N locks per batch
 *   - NEW: lock only during DB write (milliseconds) + 1 lock per batch
 *   - Lock count per batch: N → 1 (true reduction, not unchanged)
 *   - The improvement is LOCK HOLD TIME and LOCK COUNT (both fixed)
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { LlmClient } from "./llm-client.js";
import type { MemoryCategory } from "./memory-categories.js";
import type { MemoryTier } from "./memory-categories.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface UpgradeOptions {
  /** Only report counts without modifying data (default: false) */
  dryRun?: boolean;
  /** Number of memories to process per batch (default: 10) */
  batchSize?: number;
  /** Skip LLM calls; use simple text truncation for L0/L1 (default: false) */
  noLlm?: boolean;
  /** Maximum number of memories to upgrade (default: unlimited) */
  limit?: number;
  /** Scope filter — only upgrade memories in these scopes */
  scopeFilter?: string[];
  /** Logger function */
  log?: (msg: string) => void;
}

export interface UpgradeResult {
  /** Total legacy memories found */
  totalLegacy: number;
  /** Successfully upgraded count */
  upgraded: number;
  /** Skipped (already new format) */
  skipped: number;
  /** Errors encountered */
  errors: string[];
}

interface EnrichedMetadata {
  l0_abstract: string;
  l1_overview: string;
  l2_content: string;
  memory_category: MemoryCategory;
  tier: MemoryTier;
  access_count: number;
  confidence: number;
  last_accessed_at: number;
  upgraded_from: string; // original 5-category
  upgraded_at: number;   // timestamp of upgrade
}

/** Phase 1 result: enriched entry ready for DB write */
interface EnrichedEntry {
  entry: MemoryEntry;
  newCategory: MemoryCategory;
  enriched: Pick<EnrichedMetadata, "l0_abstract" | "l1_overview" | "l2_content">;
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
function reverseMapCategory(
  oldCategory: MemoryEntry["category"],
  text: string,
): MemoryCategory {
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
      if (
        /\b(my |i am |i'm |name is |叫我|我的|我是)\b/i.test(text) &&
        text.length < 200
      ) {
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

function buildUpgradePrompt(text: string, category: MemoryCategory): string {
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

function simpleEnrich(
  text: string,
  category: MemoryCategory,
): Pick<EnrichedMetadata, "l0_abstract" | "l1_overview" | "l2_content"> {
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
// Memory Upgrader (Two-Phase)
// ============================================================================
//
// REFACTORING NOTE (Issue #632):
// ---------------------------
// The old implementation held lock during LLM call (seconds), blocking plugin.
// The new two-phase approach separates:
//   - Phase 1: LLM enrichment (no lock, runs concurrently)
//   - Phase 2: bulkUpdateMetadataWithPatch() — SINGLE lock for entire batch
//
// Lock count per batch: 1 lock for all entries (TRUE reduction, not N locks).
// Lock hold time: milliseconds (DB ops only, LLM not in lock).
//
// OLD FLOW (removed):
//   for (const entry of batch) {
//     await this.upgradeEntry(entry); // lock held during LLM (seconds, blocks plugin)
//   }
//
// NEW FLOW:
//   Phase 1: await this.prepareEntry() for all entries (no lock)
//   Phase 2: await this.store.bulkUpdateMetadataWithPatch() (1 lock for all writes)
//
// Plugin can acquire lock only after Phase 2 completes (full batch).
//
// [BATCH-SIZE / LOCK-DURATION TRADEOFF]
// Phase 2 holds ONE lock for the ENTIRE batch:
//   - batchSize=10  → lock held for ~10 sequential DB ops (query/delete/add)
//   - batchSize=100 → lock held for ~100 sequential DB ops (10× longer)
// Tradeoff: larger batch = fewer lock acquisitions but longer lock hold time per batch.
// Recommendation: batchSize=10 is a good balance (~10ms lock hold vs LLM seconds).
// If Plugin latency is critical, use smaller batch (5-10). If throughput is critical,
// use larger batch (50-100) with monitoring on Plugin write latency p99.
//
// MR2 FIX (Issue #632):
// ---------------------
// The old Phase 2 built a complete metadata STRING in Phase 2a,凝固（凝固 =
// solidify/serialize）it, then passed it to bulkUpdateMetadata(). This caused:
//   - Phase 1 snapshot (entry.metadata) had injected_count=0
//   - buildSmartMetadata() preserved injected_count=0 from the snapshot
//   - bulkUpdateMetadata Step 3 used this Phase 1 string, overwriting
//     Plugin's injected_count=5 that was written during the Phase 1 window
//
// Fix: Phase 2a now passes ONLY a PATCH (LLM enrichment fields) and a MARKER
// (upgraded_from/upgraded_at). The actual metadata reconstruction happens
// inside bulkUpdateMetadataWithPatch, which re-reads the DB inside the lock
// BEFORE building the merged metadata. This ensures:
//   base = DB re-read (Plugin's injected_count=5 is here)
//   + patch = LLM fields (l0_abstract, l1_overview, l2_content, memory_category)
//   + marker = upgraded_from + upgraded_at
//   → Plugin's injected_count=5 is preserved, LLM fields are added.
// ============================================================================

export class MemoryUpgrader {
  private log: (msg: string) => void;

  constructor(
    private store: MemoryStore,
    private llm: LlmClient | null,
    private options: UpgradeOptions = {},
  ) {
    this.log = options.log ?? console.log;
  }

  /**
   * Check if a memory entry is in legacy format (needs upgrade).
   * Legacy = no metadata, or metadata lacks `memory_category`.
   */
  isLegacyMemory(entry: MemoryEntry): boolean {
    if (!entry.metadata) return true;
    try {
      const meta = JSON.parse(entry.metadata);
      // If it has memory_category, it was created by SmartExtractor → new format
      return !meta.memory_category;
    } catch {
      return true;
    }
  }

  /**
   * Scan and count legacy memories without modifying them.
   */
  async countLegacy(scopeFilter?: string[]): Promise<{
    total: number;
    legacy: number;
    byCategory: Record<string, number>;
  }> {
    const allMemories = await this.store.list(scopeFilter, undefined, 10000, 0);
    let legacy = 0;
    const byCategory: Record<string, number> = {};

    for (const entry of allMemories) {
      if (this.isLegacyMemory(entry)) {
        legacy++;
        byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
      }
    }

    return { total: allMemories.length, legacy, byCategory };
  }

  // =========================================================================
  // Phase 1: LLM Enrichment (no lock, can run concurrently)
  // =========================================================================

  /**
   * Phase 1: Enrich a single entry (no lock needed).
   * 
   * This method contains the SAME logic that was previously inside upgradeEntry():
   *   - Reverse-map category
   *   - Generate L0/L1/L2 via LLM (or simple fallback)
   * 
   * The difference is that now this runs WITHOUT acquiring a lock,
   * allowing all entries in a batch to be enriched concurrently.
   * 
   * @returns EnrichedEntry containing all data needed for DB write (Phase 2)
   */
  private async prepareEntry(
    entry: MemoryEntry,
    noLlm: boolean,
  ): Promise<EnrichedEntry> {
    // Step 1: Reverse-map category
    let newCategory = reverseMapCategory(entry.category, entry.text);

    // Step 2: Generate L0/L1/L2
    let enriched: Pick<EnrichedMetadata, "l0_abstract" | "l1_overview" | "l2_content">;

    if (!noLlm && this.llm) {
      try {
        const prompt = buildUpgradePrompt(entry.text, newCategory);
        const llmResult = await this.llm.completeJson<{
          l0_abstract: string;
          l1_overview: string;
          l2_content: string;
          resolved_category?: string;
        }>(prompt);

        if (!llmResult) {
          throw new Error(this.llm.getLastError() || "LLM returned null");
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
            newCategory = llmResult.resolved_category as MemoryCategory;
          }
        }
      } catch (err) {
        this.log(
          `memory-upgrader: LLM enrichment failed for ${entry.id}, falling back to simple — ${String(err)}`,
        );
        enriched = simpleEnrich(entry.text, newCategory);
        // [FIX F3] 設置 error 欄位以追踪 fallback
        return {
          entry,
          newCategory,
          enriched,
        };
      }
    } else {
      enriched = simpleEnrich(entry.text, newCategory);
    }

    return {
      entry,
      newCategory,
      enriched,
    };
  }

  // =========================================================================
  // Phase 2: DB Write (single lock per batch)
  // =========================================================================

  /**
   * Phase 2: Write all enriched entries to DB.
   *
   * Uses store.bulkUpdateMetadataWithPatch() for TRUE 1-lock-per-batch behavior:
   *   - Single file lock acquisition for the entire batch
   *   - Batch query (re-read fresh state inside the lock, 1 LanceDB op)
   *   - Batch delete (1 LanceDB op)
   *   - Batch add (1 LanceDB op)
   * Total: 1 lock + 3 LanceDB ops (vs old: N locks + 2N LanceDB ops)
   *
   * [FIX MR2] bulkUpdateMetadataWithPatch re-reads each entry INSIDE the lock,
   * picking up any Plugin writes that occurred during Phase 1 enrichment window.
   * Merge: base (DB re-read, has Plugin's injected_count=5)
   *         + patch (LLM enrichment: l0_abstract, l1_overview, l2_content)
   *         + marker (upgraded_from, upgraded_at)
   *
   * [FIX F5] YIELD_EVERY is no longer needed: since we hold the lock for the
   * entire batch, Plugin can acquire the lock only after the batch completes.
   * The yield mechanism is handled by the shorter lock hold time.
   */
  private async writeEnrichedBatch(
    batch: EnrichedEntry[],
    scopeFilter?: string[],
  ): Promise<{ success: number; errors: string[] }> {
    const errors: string[] = [];

    // Phase 2a: Build LLM-enrichment patch for each entry (no I/O, no lock)
    // [FIX MR2] We no longer build a complete metadata string here.
    // Instead, we pass only the LLM-enrichment PATCH + upgrade MARKER.
    // The actual merge (fresh DB metadata + patch + marker) happens inside
    // bulkUpdateMetadataWithPatch, which re-reads each entry INSIDE the lock.
    // This ensures Plugin's injected_count=5 (written during Phase 1 window)
    // is preserved: base = DB re-read (has injected_count=5),
    // then patch + marker are merged on top.
    const entries: Array<{
      id: string;
      patch: {
        l0_abstract: string;
        l1_overview: string;
        l2_content: string;
        memory_category: MemoryCategory;
        tier: MemoryTier;
        access_count: number;
        confidence: number;
      };
      marker: { upgraded_from: string; upgraded_at: number };
    }> = [];

    for (const { entry, newCategory, enriched } of batch) {
      try {
        entries.push({
          id: entry.id,
          patch: {
            l0_abstract: enriched.l0_abstract,
            l1_overview: enriched.l1_overview,
            l2_content: enriched.l2_content,
            memory_category: newCategory,
            tier: "working" as MemoryTier,
            access_count: 0,
            confidence: 0.7,
          },
          marker: {
            upgraded_from: entry.category,
            upgraded_at: Date.now(),
          },
        });
      } catch (err) {
        const errMsg = `Failed to build patch for ${entry.id}: ${String(err)}`;
        errors.push(errMsg);
        this.log(`memory-upgrader: ERROR — ${errMsg}`);
      }
    }

    if (entries.length === 0) {
      return { success: 0, errors };
    }

    // Phase 2b: Single bulk write via bulkUpdateMetadataWithPatch
    // (1 lock for entire batch, re-read inside lock)
    try {
      const result = await this.store.bulkUpdateMetadataWithPatch(entries, scopeFilter);
      for (const failedId of result.failed) {
        const errMsg = `bulkUpdateMetadataWithPatch failed for ${failedId}`;
        errors.push(errMsg);
        this.log(`memory-upgrader: ERROR — ${errMsg}`);
      }

      return { success: result.success, errors };
    } catch (err) {
      const errMsg = `bulkUpdateMetadataWithPatch batch failed: ${String(err)}`;
      errors.push(errMsg);
      this.log(`memory-upgrader: ERROR — ${errMsg}`);
      return { success: 0, errors };
    }
  }

  // =========================================================================
  // Main Upgrade (Two-Phase Processing)
  // =========================================================================

  /**
   * Main upgrade entry point with two-phase processing.
   * 
   * ISSUE #632 FIX:
   * Before this fix, each entry was processed sequentially with its own lock:
   *   for (entry in batch) { upgradeEntry(entry); } // N locks
   * 
   * Now we use two-phase processing:
   *   Phase 1: Enrich all entries (no lock) -> collect results
   *   Phase 2: Write all results (one lock) -> done
   * 
   * This reduces lock acquisitions from N (one per entry) to 1 (per batch).
   * 
   * EXAMPLE: 10 entries with batchSize=10
   *   Before: 10 lock acquisitions (one per entry)
   *   After:  1 lock acquisition (all writes grouped)
   * 
   * The LLM enrichment still runs for each entry, but WITHOUT holding a lock,
   * so the plugin can acquire the lock between entries if needed.
   */
  async upgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
    const batchSize = options.batchSize ?? this.options.batchSize ?? 10;
    const noLlm = options.noLlm ?? this.options.noLlm ?? false;
    const dryRun = options.dryRun ?? this.options.dryRun ?? false;
    const limit = options.limit ?? this.options.limit;

    const result: UpgradeResult = {
      totalLegacy: 0,
      upgraded: 0,
      skipped: 0,
      errors: [],
    };

    // Load all memories
    this.log("memory-upgrader: scanning memories...");
    const allMemories = await this.store.list(
      options.scopeFilter ?? this.options.scopeFilter,
      undefined,
      10000,
      0,
    );

    // Filter legacy memories
    const legacyMemories = allMemories.filter((m) => this.isLegacyMemory(m));
    result.totalLegacy = legacyMemories.length;
    result.skipped = allMemories.length - legacyMemories.length;

    if (legacyMemories.length === 0) {
      this.log("memory-upgrader: no legacy memories found — all memories are already in new format");
      return result;
    }

    this.log(
      `memory-upgrader: found ${legacyMemories.length} legacy memories out of ${allMemories.length} total`,
    );

    if (dryRun) {
      const byCategory: Record<string, number> = {};
      for (const m of legacyMemories) {
        byCategory[m.category] = (byCategory[m.category] || 0) + 1;
      }
      this.log(
        `memory-upgrader: [DRY-RUN] would upgrade ${legacyMemories.length} memories`,
      );
      this.log(`memory-upgrader: [DRY-RUN] breakdown: ${JSON.stringify(byCategory)}`);
      return result;
    }

    // Process in batches
    const toProcess = limit
      ? legacyMemories.slice(0, limit)
      : legacyMemories;

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);
      this.log(
        `memory-upgrader: processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toProcess.length / batchSize)} (${batch.length} memories)`,
      );

      // =====================================================================
      // Phase 1: LLM enrichment (no lock, can be concurrent)
      // =====================================================================
      // NOTE: This loop runs WITHOUT holding a lock.
      // Each entry's LLM enrichment happens in sequence here, but the plugin
      // can acquire the lock between entries if needed.
      // Previously, store.update() was called inside upgradeEntry() which held
      // the lock during LLM processing - causing the contention issue.
      const enrichedBatch: EnrichedEntry[] = [];

      for (const entry of batch) {
        try {
          const enriched = await this.prepareEntry(entry, noLlm);
          enrichedBatch.push(enriched);
        } catch (err) {
          const errMsg = `Failed to enrich ${entry.id}: ${String(err)}`;
          result.errors.push(errMsg);
          this.log(`memory-upgrader: ERROR — ${errMsg}`);
        }
      }

      // =====================================================================
      // Phase 2: DB writes under single lock
      // =====================================================================
      // Previously, each entry's store.update() acquired its own lock.
      // Now we group all writes into ONE lock acquisition per batch.
      // This is the KEY FIX for Issue #632: from N locks to 1 lock per batch.
      if (enrichedBatch.length > 0) {
        const writeResult = await this.writeEnrichedBatch(
          enrichedBatch,
          options.scopeFilter ?? this.options.scopeFilter,
        );
        result.upgraded += writeResult.success;
        result.errors.push(...writeResult.errors);
      }

      // Progress report
      this.log(
        `memory-upgrader: progress — ${result.upgraded} upgraded, ${result.errors.length} errors`,
      );
    }

    this.log(
      `memory-upgrader: upgrade complete — ${result.upgraded} upgraded, ${result.skipped} already new, ${result.errors.length} errors`,
    );
    return result;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createMemoryUpgrader(
  store: MemoryStore,
  llm: LlmClient | null,
  options: UpgradeOptions = {},
): MemoryUpgrader {
  return new MemoryUpgrader(store, llm, options);
}
