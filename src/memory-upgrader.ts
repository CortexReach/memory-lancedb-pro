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
// Memory Upgrader
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

  /**
   * Main upgrade entry point.
   * Scans all memories, filters legacy ones, and enriches them.
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

      for (const entry of batch) {
        try {
          await this.upgradeEntry(entry, noLlm);
          result.upgraded++;
        } catch (err) {
          const errMsg = `Failed to upgrade ${entry.id}: ${String(err)}`;
          result.errors.push(errMsg);
          this.log(`memory-upgrader: ERROR — ${errMsg}`);
        }
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

  /**
   * Upgrade a single legacy memory entry.
   */
  private async upgradeEntry(
    entry: MemoryEntry,
    noLlm: boolean,
  ): Promise<void> {
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
            newCategory = llmResult.resolved_category as MemoryCategory;
          }
        }
      } catch (err) {
        this.log(
          `memory-upgrader: LLM enrichment failed for ${entry.id}, falling back to simple — ${String(err)}`,
        );
        enriched = simpleEnrich(entry.text, newCategory);
      }
    } else {
      enriched = simpleEnrich(entry.text, newCategory);
    }

    // Step 3: Build enriched metadata
    const existingMeta = entry.metadata ? (() => {
      try { return JSON.parse(entry.metadata!); } catch { return {}; }
    })() : {};

    const newMetadata: EnrichedMetadata = {
      ...buildSmartMetadata(
        { ...entry, metadata: JSON.stringify(existingMeta) },
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

    // Step 4: Update the memory entry
    await this.store.update(entry.id, {
      // Update text to L0 abstract for better search indexing
      text: enriched.l0_abstract,
      metadata: stringifySmartMetadata(newMetadata),
    });
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
