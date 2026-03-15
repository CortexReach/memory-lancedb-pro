/**
 * Smart Memory Extractor — LLM-powered extraction pipeline
 * Replaces regex-triggered capture with intelligent 6-category extraction.
 *
 * Pipeline: conversation → LLM extract → candidates → dedup → persist
 *
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { LlmClient } from "./llm-client.js";
import {
  buildExtractionPrompt,
  buildDedupPrompt,
  buildMergePrompt,
} from "./extraction-prompts.js";
import {
  type CandidateMemory,
  type DedupDecision,
  type DedupResult,
  type ExtractionStats,
  type MemoryCategory,
  ALWAYS_MERGE_CATEGORIES,
  MERGE_SUPPORTED_CATEGORIES,
  MEMORY_CATEGORIES,
  TEMPORAL_VERSIONED_CATEGORIES,
  normalizeCategory,
} from "./memory-categories.js";
import { isNoise } from "./noise-filter.js";
import type { NoisePrototypeBank } from "./noise-prototypes.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  type MemoryRelation,
  parseSmartMetadata,
  stringifySmartMetadata,
  parseSupportInfo,
  updateSupportStats,
} from "./smart-metadata.js";
import {
  isUserMdExclusiveMemory,
  type WorkspaceBoundaryConfig,
} from "./workspace-boundary.js";

// ============================================================================
// Constants
// ============================================================================

const SIMILARITY_THRESHOLD = 0.7;
const MAX_SIMILAR_FOR_PROMPT = 3;
const MAX_MEMORIES_PER_EXTRACTION = 5;
const VALID_DECISIONS = new Set<string>([
  "create",
  "merge",
  "skip",
  "support",
  "contextualize",
  "contradict",
  "supersede",
]);

// ============================================================================
// Smart Extractor
// ============================================================================

export interface SmartExtractorConfig {
  /** User identifier for extraction prompt. */
  user?: string;
  /** Minimum conversation messages before extraction triggers. */
  extractMinMessages?: number;
  /** Maximum characters of conversation text to process. */
  extractMaxChars?: number;
  /** Default scope for new memories. */
  defaultScope?: string;
  /** Logger function. */
  log?: (msg: string) => void;
  /** Debug logger function. */
  debugLog?: (msg: string) => void;
  /** Optional embedding-based noise prototype bank for language-agnostic noise filtering. */
  noiseBank?: NoisePrototypeBank;
  /** Facts reserved for workspace-managed USER.md should never enter LanceDB. */
  workspaceBoundary?: WorkspaceBoundaryConfig;
}

export interface ExtractPersistOptions {
  /** Target scope for newly created memories. */
  scope?: string;
  /** Scopes visible to the current agent for dedup/merge. */
  scopeFilter?: string[];
}

export class SmartExtractor {
  private log: (msg: string) => void;
  private debugLog: (msg: string) => void;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private llm: LlmClient,
    private config: SmartExtractorConfig = {},
  ) {
    this.log = config.log ?? ((msg: string) => console.log(msg));
    this.debugLog = config.debugLog ?? (() => { });
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  /**
   * Extract memories from a conversation text and persist them.
   * Returns extraction statistics.
   */
  async extractAndPersist(
    conversationText: string,
    sessionKey: string = "unknown",
    options: ExtractPersistOptions = {},
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 };
    const targetScope = options.scope ?? this.config.defaultScope ?? "global";
    const scopeFilter =
      options.scopeFilter && options.scopeFilter.length > 0
        ? options.scopeFilter
        : [targetScope];

    // Step 1: LLM extraction
    const candidates = await this.extractCandidates(conversationText);

    if (candidates.length === 0) {
      this.log("memory-pro: smart-extractor: no memories extracted");
      // LLM returned zero candidates → strongest noise signal → feedback to noise bank
      this.learnAsNoise(conversationText);
      return stats;
    }

    this.log(
      `memory-pro: smart-extractor: extracted ${candidates.length} candidate(s)`,
    );

    // Step 2: Process each candidate through dedup pipeline
    for (const candidate of candidates.slice(0, MAX_MEMORIES_PER_EXTRACTION)) {
      if (
        isUserMdExclusiveMemory(
          {
            memoryCategory: candidate.category,
            abstract: candidate.abstract,
            content: candidate.content,
          },
          this.config.workspaceBoundary,
        )
      ) {
        stats.skipped += 1;
        stats.boundarySkipped = (stats.boundarySkipped ?? 0) + 1;
        this.log(
          `memory-pro: smart-extractor: skipped USER.md-exclusive [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
        );
        continue;
      }

      try {
        await this.processCandidate(
          candidate,
          sessionKey,
          stats,
          targetScope,
          scopeFilter,
        );
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: failed to process candidate [${candidate.category}]: ${String(err)}`,
        );
      }
    }

    return stats;
  }

  // --------------------------------------------------------------------------
  // Embedding Noise Pre-Filter
  // --------------------------------------------------------------------------

  /**
   * Filter out texts that match noise prototypes by embedding similarity.
   * Long texts (>300 chars) are passed through without checking.
   * Only active when noiseBank is configured and initialized.
   */
  async filterNoiseByEmbedding(texts: string[]): Promise<string[]> {
    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) return texts;

    const result: string[] = [];
    for (const text of texts) {
      // Very short texts lack semantic signal — skip noise check to avoid false positives
      if (text.length <= 8) {
        result.push(text);
        continue;
      }
      // Long texts are unlikely to be pure noise queries
      if (text.length > 300) {
        result.push(text);
        continue;
      }
      try {
        const vec = await this.embedder.embed(text);
        if (!vec || vec.length === 0 || !noiseBank.isNoise(vec)) {
          result.push(text);
        } else {
          this.debugLog(
            `memory-lancedb-pro: smart-extractor: embedding noise filtered: ${text.slice(0, 80)}`,
          );
        }
      } catch {
        // Embedding failed — pass text through
        result.push(text);
      }
    }
    return result;
  }

  /**
   * Feed back conversation text to the noise prototype bank.
   * Called when LLM extraction returns zero candidates (strongest noise signal).
   */
  private async learnAsNoise(conversationText: string): Promise<void> {
    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) return;

    try {
      const tail = conversationText.slice(-300);
      const vec = await this.embedder.embed(tail);
      if (vec && vec.length > 0) {
        noiseBank.learn(vec);
        this.debugLog("memory-lancedb-pro: smart-extractor: learned noise from zero-extraction");
      }
    } catch {
      // Non-critical — silently skip
    }
  }

  // --------------------------------------------------------------------------
  // Step 1: LLM Extraction
  // --------------------------------------------------------------------------

  /**
   * Call LLM to extract candidate memories from conversation text.
   */
  private async extractCandidates(
    conversationText: string,
  ): Promise<CandidateMemory[]> {
    const maxChars = this.config.extractMaxChars ?? 8000;
    const truncated =
      conversationText.length > maxChars
        ? conversationText.slice(-maxChars)
        : conversationText;

    const user = this.config.user ?? "User";
    const prompt = buildExtractionPrompt(truncated, user);

    const result = await this.llm.completeJson<{
      memories: Array<{
        category: string;
        abstract: string;
        overview: string;
        content: string;
      }>;
    }>(prompt, "extract-candidates");

    if (!result) {
      this.debugLog(
        "memory-lancedb-pro: smart-extractor: extract-candidates returned null",
      );
      return [];
    }
    if (!result.memories || !Array.isArray(result.memories)) {
      this.debugLog(
        `memory-lancedb-pro: smart-extractor: extract-candidates returned unexpected shape keys=${Object.keys(result).join(",") || "(none)"}`,
      );
      return [];
    }

    this.debugLog(
      `memory-lancedb-pro: smart-extractor: extract-candidates raw memories=${result.memories.length}`,
    );

    // Validate and normalize candidates
    const candidates: CandidateMemory[] = [];
    let invalidCategoryCount = 0;
    let shortAbstractCount = 0;
    let noiseAbstractCount = 0;
    for (const raw of result.memories) {
      const category = normalizeCategory(raw.category ?? "");
      if (!category) {
        invalidCategoryCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to invalid category rawCategory=${JSON.stringify(raw.category ?? "")} abstract=${JSON.stringify((raw.abstract ?? "").trim().slice(0, 120))}`,
        );
        continue;
      }

      const abstract = (raw.abstract ?? "").trim();
      const overview = (raw.overview ?? "").trim();
      const content = (raw.content ?? "").trim();

      // Skip empty or noise
      if (!abstract || abstract.length < 5) {
        shortAbstractCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to short abstract category=${category} abstract=${JSON.stringify(abstract)}`,
        );
        continue;
      }
      if (isNoise(abstract)) {
        noiseAbstractCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to noise abstract category=${category} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      candidates.push({ category, abstract, overview, content });
    }

    this.debugLog(
      `memory-lancedb-pro: smart-extractor: validation summary accepted=${candidates.length}, invalidCategory=${invalidCategoryCount}, shortAbstract=${shortAbstractCount}, noiseAbstract=${noiseAbstractCount}`,
    );

    return candidates;
  }

  // --------------------------------------------------------------------------
  // Step 2: Dedup + Persist
  // --------------------------------------------------------------------------

  /**
   * Process a single candidate memory: dedup → merge/create → store
   */
  private async processCandidate(
    candidate: CandidateMemory,
    sessionKey: string,
    stats: ExtractionStats,
    targetScope: string,
    scopeFilter: string[],
  ): Promise<void> {
    // Profile always merges (skip dedup)
    if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
      await this.handleProfileMerge(
        candidate,
        sessionKey,
        targetScope,
        scopeFilter,
      );
      stats.merged++;
      return;
    }

    // Embed the candidate for vector dedup
    const embeddingText = `${candidate.abstract} ${candidate.content}`;
    const vector = await this.embedder.embed(embeddingText);
    if (!vector || vector.length === 0) {
      this.log("memory-pro: smart-extractor: embedding failed, storing as-is");
      await this.storeCandidate(candidate, vector || [], sessionKey, targetScope);
      stats.created++;
      return;
    }

    // Dedup pipeline
    const dedupResult = await this.deduplicate(candidate, vector, scopeFilter);

    switch (dedupResult.decision) {
      case "create":
        await this.storeCandidate(candidate, vector, sessionKey, targetScope);
        stats.created++;
        break;

      case "merge":
        if (
          dedupResult.matchId &&
          MERGE_SUPPORTED_CATEGORIES.has(candidate.category)
        ) {
          await this.handleMerge(
            candidate,
            dedupResult.matchId,
            scopeFilter,
            targetScope,
            dedupResult.contextLabel,
          );
          stats.merged++;
        } else {
          // Category doesn't support merge → create instead
          await this.storeCandidate(candidate, vector, sessionKey, targetScope);
          stats.created++;
        }
        break;

      case "skip":
        this.log(
          `memory-pro: smart-extractor: skipped [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
        );
        stats.skipped++;
        break;

      case "supersede":
        if (
          dedupResult.matchId &&
          TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category)
        ) {
          await this.handleSupersede(
            candidate,
            vector,
            dedupResult.matchId,
            sessionKey,
            targetScope,
            scopeFilter,
          );
          stats.created++;
          stats.superseded = (stats.superseded ?? 0) + 1;
        } else {
          await this.storeCandidate(candidate, vector, sessionKey, targetScope);
          stats.created++;
        }
        break;

      case "support":
        if (dedupResult.matchId) {
          await this.handleSupport(dedupResult.matchId, scopeFilter, { session: sessionKey, timestamp: Date.now() }, dedupResult.reason, dedupResult.contextLabel);
          stats.supported = (stats.supported ?? 0) + 1;
        } else {
          await this.storeCandidate(candidate, vector, sessionKey, targetScope);
          stats.created++;
        }
        break;

      case "contextualize":
        if (dedupResult.matchId) {
          await this.handleContextualize(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel);
          stats.created++;
        } else {
          await this.storeCandidate(candidate, vector, sessionKey, targetScope);
          stats.created++;
        }
        break;

      case "contradict":
        if (dedupResult.matchId) {
          if (
            TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category) &&
            dedupResult.contextLabel === "general"
          ) {
            await this.handleSupersede(
              candidate,
              vector,
              dedupResult.matchId,
              sessionKey,
              targetScope,
              scopeFilter,
            );
            stats.created++;
            stats.superseded = (stats.superseded ?? 0) + 1;
          } else {
            await this.handleContradict(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel);
            stats.created++;
          }
        } else {
          await this.storeCandidate(candidate, vector, sessionKey, targetScope);
          stats.created++;
        }
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Dedup Pipeline (vector pre-filter + LLM decision)
  // --------------------------------------------------------------------------

  /**
   * Two-stage dedup: vector similarity search → LLM decision.
   */
  private async deduplicate(
    candidate: CandidateMemory,
    candidateVector: number[],
    scopeFilter: string[],
  ): Promise<DedupResult> {
    // Stage 1: Vector pre-filter — find similar active memories.
    // excludeInactive ensures the store over-fetches to fill N active slots,
    // preventing superseded history from crowding out the current fact.
    const activeSimilar = await this.store.vectorSearch(
      candidateVector,
      5,
      SIMILARITY_THRESHOLD,
      scopeFilter,
      { excludeInactive: true },
    );

    if (activeSimilar.length === 0) {
      return { decision: "create", reason: "No similar memories found" };
    }

    // Stage 2: LLM decision
    return this.llmDedupDecision(candidate, activeSimilar);
  }

  private async llmDedupDecision(
    candidate: CandidateMemory,
    similar: MemorySearchResult[],
  ): Promise<DedupResult> {
    const topSimilar = similar.slice(0, MAX_SIMILAR_FOR_PROMPT);
    const existingFormatted = topSimilar
      .map((r, i) => {
        // Extract L0 abstract from metadata if available, fallback to text
        let metaObj: Record<string, unknown> = {};
        try {
          metaObj = JSON.parse(r.entry.metadata || "{}");
        } catch { }
        const abstract = (metaObj.l0_abstract as string) || r.entry.text;
        const overview = (metaObj.l1_overview as string) || "";
        return `${i + 1}. [${(metaObj.memory_category as string) || r.entry.category}] ${abstract}\n   Overview: ${overview}\n   Score: ${r.score.toFixed(3)}`;
      })
      .join("\n");

    const prompt = buildDedupPrompt(
      candidate.abstract,
      candidate.overview,
      candidate.content,
      existingFormatted,
    );

    try {
      const data = await this.llm.completeJson<{
        decision: string;
        reason: string;
        match_index?: number;
      }>(prompt, "dedup-decision");

      if (!data) {
        this.log(
          "memory-pro: smart-extractor: dedup LLM returned unparseable response, defaulting to CREATE",
        );
        return { decision: "create", reason: "LLM response unparseable" };
      }

      const decision = (data.decision?.toLowerCase() ??
        "create") as DedupDecision;
      if (!VALID_DECISIONS.has(decision)) {
        return {
          decision: "create",
          reason: `Unknown decision: ${data.decision}`,
        };
      }

      // Resolve merge target from LLM's match_index (1-based)
      const idx = data.match_index;
      const hasValidIndex = typeof idx === "number" && idx >= 1 && idx <= topSimilar.length;
      const matchEntry = hasValidIndex
        ? topSimilar[idx - 1]
        : topSimilar[0];

      // For destructive decisions (supersede), missing match_index is
      // unsafe — we could invalidate the wrong memory. Degrade to create.
      const destructiveDecisions = new Set(["supersede", "contradict"]);
      if (destructiveDecisions.has(decision) && !hasValidIndex) {
        this.log(
          `memory-pro: smart-extractor: ${decision} decision has missing/invalid match_index (${idx}), degrading to create`,
        );
        return {
          decision: "create",
          reason: `${decision} degraded: missing match_index`,
        };
      }

      return {
        decision,
        reason: data.reason ?? "",
        matchId: ["merge", "support", "contextualize", "contradict", "supersede"].includes(decision) ? matchEntry?.entry.id : undefined,
        contextLabel: typeof (data as any).context_label === "string" ? (data as any).context_label : undefined,
      };
    } catch (err) {
      this.log(
        `memory-pro: smart-extractor: dedup LLM failed: ${String(err)}`,
      );
      return { decision: "create", reason: `LLM failed: ${String(err)}` };
    }
  }

  // --------------------------------------------------------------------------
  // Merge Logic
  // --------------------------------------------------------------------------

  /**
   * Profile always-merge: read existing profile, merge with LLM, upsert.
   */
  private async handleProfileMerge(
    candidate: CandidateMemory,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
  ): Promise<void> {
    // Find existing profile memory by category
    const embeddingText = `${candidate.abstract} ${candidate.content}`;
    const vector = await this.embedder.embed(embeddingText);

    // Search for existing profile memories
    const existing = await this.store.vectorSearch(
      vector || [],
      1,
      0.3,
      scopeFilter,
    );
    const profileMatch = existing.find((r) => {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        return meta.memory_category === "profile";
      } catch {
        return false;
      }
    });

    if (profileMatch) {
      await this.handleMerge(
        candidate,
        profileMatch.entry.id,
        scopeFilter,
        targetScope,
      );
    } else {
      // No existing profile — create new
      await this.storeCandidate(candidate, vector || [], sessionKey, targetScope);
    }
  }

  /**
   * Merge a candidate into an existing memory using LLM.
   */
  private async handleMerge(
    candidate: CandidateMemory,
    matchId: string,
    scopeFilter: string[],
    targetScope: string,
    contextLabel?: string,
  ): Promise<void> {
    let existingAbstract = "";
    let existingOverview = "";
    let existingContent = "";

    try {
      const existing = await this.store.getById(matchId, scopeFilter);
      if (existing) {
        const meta = parseSmartMetadata(existing.metadata, existing);
        existingAbstract = meta.l0_abstract || existing.text;
        existingOverview = meta.l1_overview || "";
        existingContent = meta.l2_content || existing.text;
      }
    } catch {
      // Fallback: store as new
      this.log(
        `memory-pro: smart-extractor: could not read existing memory ${matchId}, storing as new`,
      );
      const vector = await this.embedder.embed(
        `${candidate.abstract} ${candidate.content}`,
      );
      await this.storeCandidate(
        candidate,
        vector || [],
        "merge-fallback",
        targetScope,
      );
      return;
    }

    // Call LLM to merge
    const prompt = buildMergePrompt(
      existingAbstract,
      existingOverview,
      existingContent,
      candidate.abstract,
      candidate.overview,
      candidate.content,
      candidate.category,
    );

    const merged = await this.llm.completeJson<{
      abstract: string;
      overview: string;
      content: string;
    }>(prompt, "merge-memory");

    if (!merged) {
      this.log("memory-pro: smart-extractor: merge LLM failed, skipping merge");
      return;
    }

    // Re-embed the merged content
    const mergedText = `${merged.abstract} ${merged.content}`;
    const newVector = await this.embedder.embed(mergedText);

    // Update existing memory via store.update()
    const existing = await this.store.getById(matchId, scopeFilter);
    const metadata = stringifySmartMetadata(
      buildSmartMetadata(existing ?? { text: merged.abstract }, {
        l0_abstract: merged.abstract,
        l1_overview: merged.overview,
        l2_content: merged.content,
        memory_category: candidate.category,
        tier: "working",
        confidence: 0.8,
      }),
    );

    await this.store.update(
      matchId,
      {
        text: merged.abstract,
        vector: newVector,
        metadata,
      },
      scopeFilter,
    );

    // Update support stats on the merged memory
    try {
      const updatedEntry = await this.store.getById(matchId, scopeFilter);
      if (updatedEntry) {
        const meta = parseSmartMetadata(updatedEntry.metadata, updatedEntry);
        const supportInfo = parseSupportInfo(meta.support_info);
        const updated = updateSupportStats(supportInfo, contextLabel, "support");
        const finalMetadata = stringifySmartMetadata({ ...meta, support_info: updated });
        await this.store.update(matchId, { metadata: finalMetadata }, scopeFilter);
      }
    } catch {
      // Non-critical: merge succeeded, support stats update is best-effort
    }

    this.log(
      `memory-pro: smart-extractor: merged [${candidate.category}]${contextLabel ? ` [${contextLabel}]` : ""} into ${matchId.slice(0, 8)}`,
    );
  }

  /**
   * Handle SUPERSEDE: preserve the old record as historical but mark it as no
   * longer current, then create the new active fact.
   */
  private async handleSupersede(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
  ): Promise<void> {
    const existing = await this.store.getById(matchId, scopeFilter);
    if (!existing) {
      await this.storeCandidate(candidate, vector, sessionKey, targetScope);
      return;
    }

    const now = Date.now();
    const existingMeta = parseSmartMetadata(existing.metadata, existing);
    const factKey =
      existingMeta.fact_key ?? deriveFactKey(candidate.category, candidate.abstract);
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const created = await this.store.store({
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          {
            text: candidate.abstract,
            category: storeCategory,
          },
          {
            l0_abstract: candidate.abstract,
            l1_overview: candidate.overview,
            l2_content: candidate.content,
            memory_category: candidate.category,
            tier: "working",
            access_count: 0,
            confidence: 0.7,
            source_session: sessionKey,
            valid_from: now,
            fact_key: factKey,
            supersedes: matchId,
            relations: appendRelation([], {
              type: "supersedes",
              targetId: matchId,
            }),
          },
        ),
      ),
    });

    const invalidatedMetadata = buildSmartMetadata(existing, {
      fact_key: factKey,
      invalidated_at: now,
      superseded_by: created.id,
      relations: appendRelation(existingMeta.relations, {
        type: "superseded_by",
        targetId: created.id,
      }),
    });

    await this.store.update(
      matchId,
      { metadata: stringifySmartMetadata(invalidatedMetadata) },
      scopeFilter,
    );

    this.log(
      `memory-pro: smart-extractor: superseded [${candidate.category}] ${matchId.slice(0, 8)} -> ${created.id.slice(0, 8)}`,
    );
  }

  // --------------------------------------------------------------------------
  // Context-Aware Handlers (support / contextualize / contradict)
  // --------------------------------------------------------------------------

  /**
   * Handle SUPPORT: update support stats on existing memory for a specific context.
   */
  private async handleSupport(
    matchId: string,
    scopeFilter: string[],
    source: { session: string; timestamp: number },
    reason: string,
    contextLabel?: string,
  ): Promise<void> {
    const existing = await this.store.getById(matchId, scopeFilter);
    if (!existing) return;

    const meta = parseSmartMetadata(existing.metadata, existing);
    const supportInfo = parseSupportInfo(meta.support_info);
    const updated = updateSupportStats(supportInfo, contextLabel, "support");
    meta.support_info = updated;

    await this.store.update(
      matchId,
      { metadata: stringifySmartMetadata(meta) },
      scopeFilter,
    );

    this.log(
      `memory-pro: smart-extractor: support [${contextLabel || "general"}] on ${matchId.slice(0, 8)} — ${reason}`,
    );
  }

  /**
   * Handle CONTEXTUALIZE: create a new entry that adds situational nuance,
   * linked to the original via a relation in metadata.
   */
  private async handleContextualize(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
    contextLabel?: string,
  ): Promise<void> {
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const metadata = stringifySmartMetadata({
      l0_abstract: candidate.abstract,
      l1_overview: candidate.overview,
      l2_content: candidate.content,
      memory_category: candidate.category,
      tier: "working" as const,
      access_count: 0,
      confidence: 0.7,
      last_accessed_at: Date.now(),
      source_session: sessionKey,
      contexts: contextLabel ? [contextLabel] : [],
      relations: [{ type: "contextualizes", targetId: matchId }],
    });

    await this.store.store({
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    });

    this.log(
      `memory-pro: smart-extractor: contextualize [${contextLabel || "general"}] new entry linked to ${matchId.slice(0, 8)}`,
    );
  }

  /**
   * Handle CONTRADICT: create contradicting entry + record contradiction evidence
   * on the original memory's support stats.
   */
  private async handleContradict(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
    contextLabel?: string,
  ): Promise<void> {
    // 1. Record contradiction on the existing memory
    const existing = await this.store.getById(matchId, scopeFilter);
    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      const supportInfo = parseSupportInfo(meta.support_info);
      const updated = updateSupportStats(supportInfo, contextLabel, "contradict");
      meta.support_info = updated;
      await this.store.update(
        matchId,
        { metadata: stringifySmartMetadata(meta) },
        scopeFilter,
      );
    }

    // 2. Store the contradicting entry as a new memory
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const metadata = stringifySmartMetadata({
      l0_abstract: candidate.abstract,
      l1_overview: candidate.overview,
      l2_content: candidate.content,
      memory_category: candidate.category,
      tier: "working" as const,
      access_count: 0,
      confidence: 0.7,
      last_accessed_at: Date.now(),
      source_session: sessionKey,
      contexts: contextLabel ? [contextLabel] : [],
      relations: [{ type: "contradicts", targetId: matchId }],
    });

    await this.store.store({
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    });

    this.log(
      `memory-pro: smart-extractor: contradict [${contextLabel || "general"}] on ${matchId.slice(0, 8)}, new entry created`,
    );
  }

  // --------------------------------------------------------------------------
  // Store Helper
  // --------------------------------------------------------------------------

  /**
   * Store a candidate memory as a new entry with L0/L1/L2 metadata.
   */
  private async storeCandidate(
    candidate: CandidateMemory,
    vector: number[],
    sessionKey: string,
    targetScope: string,
  ): Promise<void> {
    // Map 6-category to existing store categories for backward compatibility
    const storeCategory = this.mapToStoreCategory(candidate.category);

    const metadata = stringifySmartMetadata(
      buildSmartMetadata(
        {
          text: candidate.abstract,
          category: this.mapToStoreCategory(candidate.category),
        },
        {
          l0_abstract: candidate.abstract,
          l1_overview: candidate.overview,
          l2_content: candidate.content,
          memory_category: candidate.category,
          tier: "working",
          access_count: 0,
          confidence: 0.7,
          source_session: sessionKey,
        },
      ),
    );

    await this.store.store({
      text: candidate.abstract, // L0 used as the searchable text
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    });

    this.log(
      `memory-pro: smart-extractor: created [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
    );
  }

  /**
   * Map 6-category to existing 5-category store type for backward compatibility.
   */
  private mapToStoreCategory(
    category: MemoryCategory,
  ): "preference" | "fact" | "decision" | "entity" | "other" {
    switch (category) {
      case "profile":
        return "fact";
      case "preferences":
        return "preference";
      case "entities":
        return "entity";
      case "events":
        return "decision";
      case "cases":
        return "fact";
      case "patterns":
        return "other";
      default:
        return "other";
    }
  }

  /**
   * Get default importance score by category.
   */
  private getDefaultImportance(category: MemoryCategory): number {
    switch (category) {
      case "profile":
        return 0.9; // Identity is very important
      case "preferences":
        return 0.8;
      case "entities":
        return 0.7;
      case "events":
        return 0.6;
      case "cases":
        return 0.8; // Problem-solution pairs are high value
      case "patterns":
        return 0.85; // Reusable processes are high value
      default:
        return 0.5;
    }
  }
}
