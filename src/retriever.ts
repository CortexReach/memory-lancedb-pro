/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";
import {
  AccessTracker,
  parseAccessMetadata,
  computeEffectiveHalfLife,
} from "./access-tracker.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score */
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /** Access reinforcement factor for time decay half-life extension.
   *  Higher = stronger reinforcement. 0 to disable. (default: 0.5) */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from access reinforcement.
   *  Prevents frequently accessed memories from becoming immortal. (default: 3) */
  maxHalfLifeMultiplier: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated. */
  source?: "manual" | "auto-recall";
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.1,
  filterNoise: true,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone";

interface RerankItem {
  index: number;
  score: number;
}

/** Build provider-specific request headers and body */
function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: documents.map((text) => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: Record<string, unknown>,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index =
        typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };

  switch (provider) {
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(data.data, ["score", "relevance_score"]) ??
        parseItems(data.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(data.data, ["relevance_score", "score"]) ??
        parseItems(data.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

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
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private accessTracker: AccessTracker | null = null;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {}

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category, source } = context;
    const safeLimit = clampInt(limit, 1, 20);

    let results: RetrievalResult[];
    if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
      results = await this.vectorOnlyRetrieval(
        query,
        safeLimit,
        scopeFilter,
        category,
      );
    } else {
      results = await this.hybridRetrieval(
        query,
        safeLimit,
        scopeFilter,
        category,
      );
    }

    // Record access for reinforcement (manual recall only)
    if (this.accessTracker && source === "manual" && results.length > 0) {
      this.accessTracker.recordAccess(results.map((r) => r.entry.id));
    }

    return results;
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<RetrievalResult[]> {
    const queryVector = await this.embedder.embedQuery(query);
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      this.config.minScore,
      scopeFilter,
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    const mapped = filtered.map(
      (result, index) =>
        ({
          ...result,
          sources: {
            vector: { score: result.score, rank: index + 1 },
          },
        }) as RetrievalResult,
    );

    const boosted = this.applyRecencyBoost(mapped);
    const weighted = this.applyImportanceWeight(boosted);
    const lengthNormalized = this.applyLengthNormalization(weighted);
    const timeDecayed = this.applyTimeDecay(lengthNormalized);
    const hardFiltered = timeDecayed.filter(
      (r) => r.score >= this.config.hardMinScore,
    );
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, (r) => r.entry.text)
      : hardFiltered;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised);

    return deduplicated.slice(0, limit);
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<RetrievalResult[]> {
    const candidatePoolSize = Math.max(
      this.config.candidatePoolSize,
      limit * 2,
    );

    // Compute query embedding once, reuse for vector search + reranking
    const queryVector = await this.embedder.embedQuery(query);

    // Run vector and BM25 searches in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      this.runVectorSearch(
        queryVector,
        candidatePoolSize,
        scopeFilter,
        category,
      ),
      this.runBM25Search(query, candidatePoolSize, scopeFilter, category),
    ]);

    // Fuse results using RRF (async: validates BM25-only entries exist in store)
    const fusedResults = await this.fuseResults(vectorResults, bm25Results);

    // Apply minimum score threshold
    const filtered = fusedResults.filter(
      (r) => r.score >= this.config.minScore,
    );

    // Rerank if enabled
    const reranked =
      this.config.rerank !== "none"
        ? await this.rerankResults(
            query,
            queryVector,
            filtered.slice(0, limit * 2),
          )
        : filtered;

    // Apply temporal re-ranking (recency boost)
    const temporalReranked = this.applyRecencyBoost(reranked);

    // Apply importance weighting
    const importanceWeighted = this.applyImportanceWeight(temporalReranked);

    // Apply length normalization (penalize long entries dominating via keyword density)
    const lengthNormalized = this.applyLengthNormalization(importanceWeighted);

    // Apply time decay (penalize stale entries)
    const timeDecayed = this.applyTimeDecay(lengthNormalized);

    // Hard minimum score cutoff (post all scoring stages)
    const hardFiltered = timeDecayed.filter(
      (r) => r.score >= this.config.hardMinScore,
    );

    // Filter noise
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, (r) => r.entry.text)
      : hardFiltered;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised);

    return deduplicated.slice(0, limit);
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      0.1,
      scopeFilter,
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter);

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>,
  ): Promise<RetrievalResult[]> {
    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

    vectorResults.forEach((result) => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach((result) => {
      bm25Map.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    // Calculate RRF scores
    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);

      // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
      // deleted but whose FTS index entry lingers until the next index rebuild.
      // Validate that the entry actually exists in the store before including it.
      if (!vectorResult && bm25Result) {
        try {
          const exists = await this.store.hasId(id);
          if (!exists) continue; // Skip ghost entry
        } catch {
          // If hasId fails, keep the result (fail-open)
        }
      }

      // Use the result with more complete data (prefer vector result if both exist)
      const baseResult = vectorResult || bm25Result!;

      // Use vector similarity as the base score.
      // BM25 hit acts as a bonus (keyword match confirms relevance).
      const vectorScore = vectorResult ? vectorResult.score : 0;
      const bm25Hit = bm25Result ? 1 : 0;

      // Base = vector score; BM25 hit boosts by up to 15%
      // BM25-only results use their raw BM25 score so exact keyword matches
      // (e.g. searching "JINA_API_KEY") still surface. The previous floor of 0.5
      // was too generous and allowed ghost entries to survive hardMinScore (0.35).
      const fusedScore = vectorResult
        ? clamp01(vectorScore + bm25Hit * 0.15 * vectorScore, 0.1)
        : clamp01(bm25Result!.score, 0.1);

      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult
            ? { score: vectorResult.score, rank: vectorResult.rank }
            : undefined,
          bm25: bm25Result
            ? { score: bm25Result.score, rank: bm25Result.rank }
            : undefined,
          fused: { score: fusedScore },
        },
      });
    }

    // Sort by fused score descending
    return fusedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(
    query: string,
    queryVector: number[],
    results: RetrievalResult[],
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Try cross-encoder rerank via configured provider API
    if (this.config.rerank === "cross-encoder" && this.config.rerankApiKey) {
      try {
        const provider = this.config.rerankProvider || "jina";
        const model = this.config.rerankModel || "jina-reranker-v3";
        const endpoint =
          this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
        const documents = results.map((r) => r.entry.text);

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(
          provider,
          this.config.rerankApiKey,
          model,
          query,
          documents,
          results.length,
        );

        // Timeout: 5 seconds to prevent stalling retrieval pipeline
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;

          // Parse provider-specific response into unified format
          const parsed = parseRerankResponse(provider, data);

          if (!parsed) {
            console.warn(
              "Rerank API: invalid response shape, falling back to cosine",
            );
          } else {
            // Build a Set of returned indices to identify unreturned candidates
            const returnedIndices = new Set(parsed.map((r) => r.index));

            const reranked = parsed
              .filter((item) => item.index >= 0 && item.index < results.length)
              .map((item) => {
                const original = results[item.index];
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01(
                  item.score * 0.6 + original.score * 0.4,
                  original.score * 0.5,
                );
                return {
                  ...original,
                  score: blendedScore,
                  sources: {
                    ...original.sources,
                    reranked: { score: item.score },
                  },
                };
              });

            // Keep unreturned candidates with their original scores (slightly penalized)
            const unreturned = results
              .filter((_, idx) => !returnedIndices.has(idx))
              .map((r) => ({ ...r, score: r.score * 0.8 }));

            return [...reranked, ...unreturned].sort(
              (a, b) => b.score - a.score,
            );
          }
        } else {
          const errText = await response.text().catch(() => "");
          console.warn(
            `Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("Rerank API timed out (5s), falling back to cosine");
        } else {
          console.warn("Rerank API failed, falling back to cosine:", error);
        }
      }
    }

    // Fallback: lightweight cosine similarity rerank
    try {
      const reranked = results.map((result) => {
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = result.score * 0.7 + cosineScore * 0.3;

        return {
          ...result,
          score: clamp01(combinedScore, result.score),
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (error) {
      console.warn("Reranking failed, returning original results:", error);
      return results;
    }
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      return results;
    }

    const now = Date.now();
    const boosted = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      return {
        ...r,
        score: clamp01(r.score + boost, r.score),
      };
    });

    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
   */
  private applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
    const baseWeight = 0.7;
    const weighted = results.map((r) => {
      const importance = r.entry.importance ?? 0.7;
      const factor = baseWeight + (1 - baseWeight) * importance;
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * baseWeight),
      };
    });
    return weighted.sort((a, b) => b.score - a.score);
  }

  /**
   * Length normalization: penalize long entries that dominate search results
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) get a slight boost.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + log2(charLen / anchor))
   */
  private applyLengthNormalization(
    results: RetrievalResult[],
  ): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    const normalized = results.map((r) => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      // No penalty for entries at or below anchor length.
      // Gentle logarithmic decay for longer entries:
      //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
      // This prevents long, keyword-rich entries from dominating top-k
      // while keeping their scores reasonable.
      const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
      const factor = 1 / (1 + 0.5 * logRatio);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
    });

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Time decay: multiplicative penalty for old entries.
   * Unlike recencyBoost (additive bonus for new entries), this actively
   * penalizes stale information so recent knowledge wins ties.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At 0 days: 1.0x (no penalty)
   * At halfLife: ~0.68x
   * At 2*halfLife: ~0.59x
   * Floor at 0.5x (never penalize more than half)
   */
  private applyTimeDecay(results: RetrievalResult[]): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) return results;

    const now = Date.now();
    const decayed = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;

      // Access reinforcement: frequently recalled memories decay slower
      const { accessCount, lastAccessedAt } = parseAccessMetadata(
        r.entry.metadata,
      );
      const effectiveHL = computeEffectiveHalfLife(
        halfLife,
        accessCount,
        lastAccessedAt,
        this.config.reinforcementFactor,
        this.config.maxHalfLifeMultiplier,
      );

      // floor at 0.5: even very old entries keep at least 50% of their score
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.5),
      };
    });

    return decayed.sort((a, b) => b.score - a.score);
  }

  /**
   * MMR-inspired diversity filter: greedily select results that are both
   * relevant (high score) and diverse (low similarity to already-selected).
   *
   * Uses cosine similarity between memory vectors. If two memories have
   * cosine similarity > threshold (default 0.92), the lower-scored one
   * is demoted to the end rather than removed entirely.
   *
   * This prevents top-k from being filled with near-identical entries
   * (e.g. 3 similar "SVG style" memories) while keeping them available
   * if the pool is small.
   */
  private applyMMRDiversity(
    results: RetrievalResult[],
    similarityThreshold = 0.85,
  ): RetrievalResult[] {
    if (results.length <= 1) return results;

    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];

    for (const candidate of results) {
      // Check if this candidate is too similar to any already-selected result
      const tooSimilar = selected.some((s) => {
        // Both must have vectors to compare.
        // LanceDB returns Arrow Vector objects (not plain arrays),
        // so use .length directly and Array.from() for conversion.
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;
        const sArr = Array.from(sVec as Iterable<number>);
        const cArr = Array.from(cVec as Iterable<number>);
        const sim = cosineSimilarity(sArr, cArr);
        return sim > similarityThreshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    // Append deferred results at the end (available but deprioritized)
    return [...selected, ...deferred];
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig);
}
