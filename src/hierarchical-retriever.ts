/**
 * Hierarchical Retriever — Two-pass structure-aware retrieval
 *
 * Pass 1: Find top-3 relevant topic clusters by cosine to query vector
 * Pass 2: Retrieve within winning clusters using flat retriever
 * Score propagation: alpha * intra_score + (1-alpha) * cluster_score
 *
 * Falls back to flat retrieval on cold start (topic index not built).
 */

import type { MemoryRetriever, RetrievalResult, RetrievalContext } from "./retriever.js";
import type { TopicIndex } from "./topic-index.js";
import type { Embedder } from "./embedder.js";

// ============================================================================
// Configuration
// ============================================================================

export interface HierarchicalRetrievalConfig {
  /** Weight for intra-cluster score vs cluster-level score. Default: 0.7 */
  alpha: number;
  /** Number of top clusters to search. Default: 3 */
  topClusters: number;
}

export const DEFAULT_HIERARCHICAL_CONFIG: HierarchicalRetrievalConfig = {
  alpha: 0.7,
  topClusters: 3,
};

// ============================================================================
// Hierarchical Retriever
// ============================================================================

export class HierarchicalRetriever {
  constructor(
    private flatRetriever: MemoryRetriever,
    private topicIndex: TopicIndex,
    private embedder: Embedder,
    private config: HierarchicalRetrievalConfig = DEFAULT_HIERARCHICAL_CONFIG,
  ) {}

  /**
   * Two-pass hierarchical retrieval.
   * Falls back to flat retrieval if topic index is not built (cold start).
   */
  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    // Cold start fallback: use flat retrieval
    if (!this.topicIndex.isBuilt) {
      return this.flatRetriever.retrieve(context);
    }

    const { query, limit } = context;
    const alpha = this.config.alpha;

    // Pass 1: embed query and find relevant topic clusters
    const queryVector = await this.embedder.embedQuery(query);
    const topClusters = this.topicIndex.findRelevant(
      queryVector,
      this.config.topClusters,
    );

    if (topClusters.length === 0) {
      return this.flatRetriever.retrieve(context);
    }

    // Collect all memory IDs from winning clusters
    const clusterMemoryIds = new Set<string>();
    const clusterScoreByMemoryId = new Map<string, number>();

    for (const cluster of topClusters) {
      for (const memoryId of cluster.memoryIds) {
        clusterMemoryIds.add(memoryId);
        // Use the highest cluster score if a memory appears in multiple clusters
        const existing = clusterScoreByMemoryId.get(memoryId) ?? 0;
        if (cluster.score > existing) {
          clusterScoreByMemoryId.set(memoryId, cluster.score);
        }
      }
    }

    // Pass 2: flat retrieval for the full candidate pool
    // We request more results to ensure we capture cluster members
    const expandedLimit = Math.max(limit * 3, 20);
    const flatResults = await this.flatRetriever.retrieve({
      ...context,
      limit: expandedLimit,
    });

    // Score propagation: combine intra-cluster (flat) score with cluster score
    const propagated: RetrievalResult[] = [];
    for (const result of flatResults) {
      const clusterScore = clusterScoreByMemoryId.get(result.entry.id);
      if (clusterScore !== undefined) {
        // Memory belongs to a winning cluster: apply score propagation
        const combinedScore = alpha * result.score + (1 - alpha) * clusterScore;
        propagated.push({ ...result, score: combinedScore });
      } else {
        // Memory not in any winning cluster: keep flat score but penalize slightly
        propagated.push({ ...result, score: result.score * alpha });
      }
    }

    // Re-sort by propagated score and return top results
    propagated.sort((a, b) => b.score - a.score);
    return propagated.slice(0, limit);
  }
}
