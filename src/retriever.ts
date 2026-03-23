/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryEntry, MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import {
  AccessTracker,
  computeEffectiveHalfLife,
  parseAccessMetadata,
} from "./access-tracker.js";
import { filterNoise } from "./noise-filter.js";
import type { DecayEngine, DecayableMemory } from "./decay-engine.js";
import type { TierManager } from "./tier-manager.js";
import {
  getDecayableFromEntry,
  isMemoryActiveAt,
  parseSmartMetadata,
  toLifecycleMemory,
} from "./smart-metadata.js";

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
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score
   *  - "tei": Authorization: Bearer, string[] texts, top-level [{ index, score }] */
  rerankProvider?:
    | "jina"
    | "siliconflow"
    | "voyage"
    | "pinecone"
    | "dashscope"
    | "tei";
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
  /** Tag prefixes for exact-match queries (default: ["proj", "env", "team", "scope"]).
   *  Queries containing these prefixes (e.g. "proj:AIF") will use BM25-only + mustContain
   *  to avoid semantic false positives from vector search. */
  tagPrefixes: string[];
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands. */
  source?: "manual" | "auto-recall" | "cli";
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
  tagPrefixes: ["proj", "env", "team", "scope"],
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

function clamp01WithFloor(value: number, floor: number): number {
  const safeFloor = clamp01(floor, 0);
  return Math.max(safeFloor, clamp01(value, safeFloor));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider =
  | "jina"
  | "siliconflow"
  | "voyage"
  | "pinecone"
  | "dashscope"
  | "tei";

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
  candidates: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "tei":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          query,
          texts: candidates,
        },
      };
    case "dashscope":
      // DashScope wraps query+documents under `input` and does not use top_n.
      // Endpoint: https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          input: {
            query,
            documents: candidates,
          },
        },
      };
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
          documents: candidates.map((text) => ({ text })),
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
          documents: candidates,
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
          documents: candidates,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: unknown,
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
  const objectData =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;

  switch (provider) {
    case "tei":
      return (
        parseItems(data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"]) ??
        parseItems(objectData?.data, ["score", "relevance_score"])
      );
    case "dashscope": {
      // DashScope: { output: { results: [{ index, relevance_score }] } }
      const output = objectData?.output as Record<string, unknown> | undefined;
      if (output) {
        return parseItems(output.results, ["relevance_score", "score"]);
      }
      // Fallback: try top-level results in case API format changes
      return parseItems(objectData?.results, ["relevance_score", "score"]);
    }
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(objectData?.data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(objectData?.data, ["relevance_score", "score"]) ??
        parseItems(objectData?.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(objectData?.results, ["relevance_score", "score"]) ??
        parseItems(objectData?.data, ["relevance_score", "score"])
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
  private tierManager: TierManager | null = null;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    private decayEngine: DecayEngine | null = null,
  ) { }

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  private filterActiveResults<T extends MemorySearchResult>(results: T[]): T[] {
    return results.filter((result) =>
      isMemoryActiveAt(parseSmartMetadata(result.entry.metadata, result.entry)),
    );
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category, source } = context;
    const safeLimit = clampInt(limit, 1, 20);

    // Check if query contains tag prefixes -> use BM25-only + mustContain
    const tagTokens = this.extractTagTokens(query);
    let results: RetrievalResult[];
    
    if (tagTokens.length > 0) {
      results = await this.bm25OnlyRetrieval(
        query,
        tagTokens,
        safeLimit,
        scopeFilter,
        category,
      );
    } else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
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

  private extractTagTokens(query: string): string[] {
    if (!this.config.tagPrefixes?.length) return [];
    
    const pattern = this.config.tagPrefixes.join("|");
    const regex = new RegExp(`(?:${pattern}):[\\w-]+`, "gi");
    const matches = query.match(regex);
    return matches || [];
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
      { excludeInactive: true },
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

    const weighted = this.decayEngine ? mapped : this.applyImportanceWeight(this.applyRecencyBoost(mapped));
    const lengthNormalized = this.applyLengthNormalization(weighted);
    const hardFiltered = lengthNormalized.filter(r => r.score >= this.config.hardMinScore);
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered)
      : this.applyTimeDecay(hardFiltered);
    const denoised = this.config.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised);

    return deduplicated.slice(0, limit);
  }

  private async bm25OnlyRetrieval(
    query: string,
    tagTokens: string[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<RetrievalResult[]> {
    const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);
    
    // Run BM25 search
    const bm25Results = await this.store.bm25Search(
      query,
      candidatePoolSize,
      scopeFilter,
      { excludeInactive: true },
    );

    // Filter by category if specified
    const categoryFiltered = category
      ? bm25Results.filter((r) => r.entry.category === category)
      : bm25Results;

    // mustContain: only keep entries that literally contain all tag tokens (case-insensitive)
    const mustContainFiltered = categoryFiltered.filter((r) => {
      const textLower = r.entry.text.toLowerCase();
      return tagTokens.every((t) => textLower.includes(t.toLowerCase()));
    });

    const mapped = mustContainFiltered.map(
      (result, index) =>
        ({
          ...result,
          sources: {
            bm25: { score: result.score, rank: index + 1 },
          },
        }) as RetrievalResult,
    );

    // Apply same post-processing as hybrid retrieval to avoid behavior regression
    const temporallyRanked = this.decayEngine
      ? mapped
      : this.applyImportanceWeight(this.applyRecencyBoost(mapped));

    const lengthNormalized = this.applyLengthNormalization(temporallyRanked);
    const hardFiltered = lengthNormalized.filter(r => r.score >= this.config.hardMinScore);

    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered)
      : this.applyTimeDecay(hardFiltered);

    const denoised = this.config.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

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

    const temporallyRanked = this.decayEngine
      ? reranked
      : this.applyImportanceWeight(this.applyRecencyBoost(reranked));

    // Apply length normalization (penalize long entries dominating via keyword density)
    const lengthNormalized = this.applyLengthNormalization(temporallyRanked);

    // Hard minimum score cutoff should be based on semantic / lexical relevance.
    // Lifecycle decay and time-decay are used for re-ranking, not for dropping
    // otherwise relevant fresh memories.
    const hardFiltered = lengthNormalized.filter(r => r.score >= this.config.hardMinScore);

    // Apply lifecycle-aware decay or legacy time decay after thresholding
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered)
      : this.applyTimeDecay(hardFiltered);

    // Filter noise
    const denoised = this.config.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

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
      { excludeInactive: true },
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
    const results = await this.store.bm25Search(query, limit, scopeFilter, { excludeInactive: true });

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
      const bm25Score = bm25Result ? bm25Result.score : 0;
      // Weighted fusion: vectorWeight/bm25Weight directly control score blending.
      // BM25 high-score floor (>= 0.75) preserves exact keyword matches
      // (e.g. API keys, ticket numbers) that may have low vector similarity.
      const weightedFusion = (vectorScore * this.config.vectorWeight)
                           + (bm25Score * this.config.bm25Weight);
      const fusedScore = vectorResult
        ? clamp01(
          Math.max(
            weightedFusion,
            bm25Score >= 0.75 ? bm25Score * 0.92 : 0,
          ),
          0.1,
        )
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
          const data: unknown = await response.json();

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
                const floor = this.getRerankPreservationFloor(original, false);
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01WithFloor(
                  item.score * 0.6 + original.score * 0.4,
                  floor,
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
              .map(r => ({
                ...r,
                score: clamp01WithFloor(
                  r.score * 0.8,
                  this.getRerankPreservationFloor(r, true),
                ),
              }));

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

  private getRerankPreservationFloor(result: RetrievalResult, unreturned: boolean): number {
    const bm25Score = result.sources.bm25?.score ?? 0;

    // Exact lexical hits (IDs, env vars, ticket numbers) should not disappear
    // just because a reranker under-scores symbolic or mixed-language queries.
    if (bm25Score >= 0.75) {
      return result.score * (unreturned ? 1.0 : 0.95);
    }
    if (bm25Score >= 0.6) {
      return result.score * (unreturned ? 0.95 : 0.9);
    }
    return result.score * (unreturned ? 0.8 : 0.5);
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

  private applyDecayBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.decayEngine || results.length === 0) return results;

    const scored = results.map((result) => ({
      memory: toLifecycleMemory(result.entry.id, result.entry),
      score: result.score,
    }));

    this.decayEngine.applySearchBoost(scored);

    const reranked = results.map((result, index) => ({
      ...result,
      score: clamp01(scored[index].score, result.score * 0.3),
    }));

    return reranked.sort((a, b) => b.score - a.score);
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
   * Apply lifecycle-aware score adjustment (decay + tier floors).
   *
   * This is intentionally lightweight:
   * - reads tier/access metadata (if any)
   * - multiplies scores by max(tierFloor, decayComposite)
   */
  private applyLifecycleBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.decayEngine) return results;

    const now = Date.now();
    const pairs = results.map(r => {
      const { memory } = getDecayableFromEntry(r.entry);
      return { r, memory };
    });

    const scored = pairs.map(p => ({ memory: p.memory, score: p.r.score }));
    this.decayEngine.applySearchBoost(scored, now);

    const boosted = pairs.map((p, i) => ({ ...p.r, score: scored[i].score }));
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Record access stats (access_count, last_accessed_at) and apply tier
   * promotion/demotion for a small number of top results.
   *
   * Note: this writes back to LanceDB via delete+readd; keep it bounded.
   */
  private async recordAccessAndMaybeTransition(results: RetrievalResult[]): Promise<void> {
    if (!this.decayEngine && !this.tierManager) return;

    const now = Date.now();
    const toUpdate = results.slice(0, 3);

    for (const r of toUpdate) {
      const { memory, meta } = getDecayableFromEntry(r.entry);

      // Update access stats in-memory first
      const nextAccess = memory.accessCount + 1;
      meta.access_count = nextAccess;
      meta.last_accessed_at = now;
      if (meta.created_at === undefined && meta.createdAt === undefined) {
        meta.created_at = memory.createdAt;
      }
      if (meta.tier === undefined) {
        meta.tier = memory.tier;
      }
      if (meta.confidence === undefined) {
        meta.confidence = memory.confidence;
      }

      const updatedMemory: DecayableMemory = {
        ...memory,
        accessCount: nextAccess,
        lastAccessedAt: now,
      };

      // Tier transition (optional)
      if (this.decayEngine && this.tierManager) {
        const ds = this.decayEngine.score(updatedMemory, now);
        const transition = this.tierManager.evaluate(updatedMemory, ds, now);
        if (transition) {
          meta.tier = transition.toTier;
        }
      }

      try {
        await this.store.update(r.entry.id, {
          metadata: JSON.stringify(meta),
        });
      } catch {
        // best-effort: ignore
      }
    }
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

export interface RetrieverLifecycleOptions {
  decayEngine?: DecayEngine;
  tierManager?: TierManager;
}

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
  options?: { decayEngine?: DecayEngine | null },
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig, options?.decayEngine ?? null);
}
