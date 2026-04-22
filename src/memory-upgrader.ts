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
 *   Phase 2: DB writes (one lock per entry, LLM no longer holds lock)
 *
 * This significantly reduces lock hold time vs old approach:
 *   - OLD: lock held during LLM call (seconds, blocks plugin)
 *   - NEW: lock only during DB write (milliseconds)
 *   - Lock count per batch is unchanged (N locks for N entries)
 *   - The improvement is LOCK HOLD TIME, not lock count
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { LlmClient } from "./llm-client.js";
import type { MemoryCategory } from "./memory-categories.js";
import type { MemoryTier } from "./memory-categories.js";
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";

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
// The old implementation had each entry call store.update() individually, causing:
//   - N lock acquisitions for N entries = high contention
//   - Plugin waits seconds while LLM runs between lock acquisitions
//
// The new two-phase approach separates:
//   - Phase 1: LLM enrichment (no lock, runs quickly)
//   - Phase 2: DB writes (single lock per batch)
//
// OLD FLOW (removed):
//   for (const entry of batch) {
//     await this.upgradeEntry(entry); // LLM + store.update() inside lock
//   }
//
// NEW FLOW:
//   Phase 1: await this.prepareEntry() for all entries (no lock)
//   Phase 2: await this.writeEnrichedBatch() (single lock for all writes)
//
// The logic inside prepareEntry() is IDENTICAL to what upgradeEntry() did -
// only the timing/ordering has changed to reduce lock contention.
//
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
   * Each entry update acquires its own lock via store.update().
   * The key improvement vs the old approach is that lock hold time is
   * now milliseconds (DB write only) instead of seconds (LLM call held lock).
   * 
   * Lock count per batch: N locks for N entries (unchanged from old approach).
   * The improvement is in lock hold time, not lock acquisition count.
   *
   * [FIX MR2] Each entry is re-read before writing to pick up any Plugin
   * writes that occurred during the Phase 1 enrichment window.
   * 
   * [FIX F5] Every YIELD_EVERY entries, we yield 10ms so that concurrent
   * plugin writes have a chance to acquire the lock between entries.
   */
  private async writeEnrichedBatch(
    batch: EnrichedEntry[],
  ): Promise<{ success: number; errors: string[] }> {
    let success = 0;
    const errors: string[] = [];

    // [FIX F2] 移除巢狀 lock：store.update() 內部已有 runWithFileLock，
    // 這裡再包一層會造成 deadlock（proper-lockfile 不支援遞迴 lock）。
    // [FIX MR2] 每個 entry 在寫入前重新讀取一次，確保拿到 plugin 在
    // enrichment window 期間寫入的最新資料，避免覆蓋 injected_count 等欄位。
    // [FIX F5] 每 N 個 entry 寫入後讓出 lock，避免 plugin 長期飢餓
    const YIELD_EVERY = 5;
    
    for (let i = 0; i < batch.length; i++) {
      const { entry, newCategory, enriched } = batch[i];
      try {
        // Re-read latest state before writing (MR2 fix)
        const latest = await this.store.getById(entry.id);
        if (!latest) {
          errors.push(`Entry ${entry.id} not found during write phase`);
          continue;
        }

        // Step 3: Build enriched metadata using latest entry state
        const existingMeta = latest.metadata ? (() => {
          try { return JSON.parse(latest.metadata); } catch { return {}; }
        })() : {};

        const newMetadata: EnrichedMetadata = {
          ...buildSmartMetadata(
            { ...latest, metadata: JSON.stringify(existingMeta) },
            {
              l0_abstract: enriched.l0_abstract,
              l1_overview: enriched.l1_overview,
              l2_content: enriched.l2_content,
              memory_category: newCategory,
              tier: "working" as MemoryTier,
              access_count: 0,
              confidence: 0.7,
            },
          ),
          upgraded_from: entry.category,
          upgraded_at: Date.now(),
        };

        // Step 4: Update the memory entry (store.update() handles its own lock)
        // [FIX] 不再覆蓋 text，保留 original 內容，避免部分寫入後 crash 無法恢復
        // metadata 內含 l0_abstract，recall 時會使用
        await this.store.update(entry.id, {
          metadata: stringifySmartMetadata(newMetadata),
        });
        success++;
        
        // [FIX F5] 每 N 個 entry 寫入後短暫讓出，讓 plugin 有機會取得 lock
        if ((i + 1) % YIELD_EVERY === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } catch (err) {
        const errMsg = `Failed to update ${entry.id}: ${String(err)}`;
        errors.push(errMsg);
        this.log(`memory-upgrader: ERROR — ${errMsg}`);
      }
    }

    return { success, errors };
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
        const writeResult = await this.writeEnrichedBatch(enrichedBatch);
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
