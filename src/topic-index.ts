/**
 * Topic Index — Hierarchical Retrieval Support
 *
 * Groups memories by topic, computes centroids per topic cluster,
 * and enables two-pass retrieval: first find relevant clusters,
 * then search within those clusters.
 *
 * Cold start: <100 memories or <3 topics → empty index (triggers flat fallback).
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { parseSmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface TopicCluster {
  topic: string;
  centroid: number[];
  memoryIds: string[];
  score: number;      // cosine similarity to query
  avgImportance: number;
}

interface TopicEntry {
  memoryId: string;
  vector: number[];
  importance: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum number of memories before topic index activates. */
const COLD_START_MIN_MEMORIES = 100;

/** Minimum number of distinct topics before topic index activates. */
const COLD_START_MIN_TOPICS = 3;

/** Topic assigned to memories without an explicit topic. */
const UNCATEGORIZED_TOPIC = "_uncategorized";

// ============================================================================
// Utilities
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
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

function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Float64Array(dim);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }
  const centroid: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    centroid[i] = sum[i] / vectors.length;
  }
  return centroid;
}

// ============================================================================
// TopicIndex
// ============================================================================

export class TopicIndex {
  private clusters = new Map<string, TopicEntry[]>();
  private centroids = new Map<string, number[]>();
  private _built = false;

  /**
   * Build the topic index from all memories in the store.
   * Groups by metadata.topic field, computes centroids.
   * No-ops if cold start conditions are not met.
   */
  async build(store: MemoryStore, embedder: Embedder): Promise<void> {
    this.clusters.clear();
    this.centroids.clear();
    this._built = false;

    // Fetch all memories (paginated in batches of 200)
    let offset = 0;
    const batchSize = 200;
    let totalMemories = 0;

    while (true) {
      const entries = await store.list(undefined, undefined, batchSize, offset);
      if (entries.length === 0) break;

      for (const entry of entries) {
        const metadata = parseSmartMetadata(entry.metadata, entry);
        const topic = (metadata as any).topic as string || UNCATEGORIZED_TOPIC;
        const vector = entry.vector;
        const importance = entry.importance ?? 0.5;

        if (!this.clusters.has(topic)) {
          this.clusters.set(topic, []);
        }
        this.clusters.get(topic)!.push({
          memoryId: entry.id,
          vector,
          importance,
        });
        totalMemories++;
      }

      offset += entries.length;
      if (entries.length < batchSize) break;
    }

    // Cold start check
    const topicCount = this.clusters.size;
    if (totalMemories < COLD_START_MIN_MEMORIES || topicCount < COLD_START_MIN_TOPICS) {
      this.clusters.clear();
      return;
    }

    // Compute centroids for each topic
    for (const [topic, entries] of this.clusters) {
      const vectors = entries.map(e => e.vector).filter(v => v && v.length > 0);
      if (vectors.length > 0) {
        this.centroids.set(topic, computeCentroid(vectors));
      }
    }

    this._built = true;
  }

  /**
   * Find the most relevant topic clusters for a query vector.
   * Returns top-K clusters sorted by cosine similarity to their centroids.
   */
  findRelevant(queryVector: number[], topK: number): TopicCluster[] {
    if (!this._built || this.centroids.size === 0) return [];

    const scored: TopicCluster[] = [];
    for (const [topic, centroid] of this.centroids) {
      const score = cosineSimilarity(queryVector, centroid);
      const entries = this.clusters.get(topic) || [];
      const avgImportance = entries.length > 0
        ? entries.reduce((sum, e) => sum + e.importance, 0) / entries.length
        : 0;

      scored.push({
        topic,
        centroid,
        memoryIds: entries.map(e => e.memoryId),
        score,
        avgImportance,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Add a single memory to the index at runtime (incremental update).
   */
  addMemory(
    topic: string,
    memoryId: string,
    vector: number[],
    importance: number,
  ): void {
    const effectiveTopic = topic || UNCATEGORIZED_TOPIC;

    if (!this.clusters.has(effectiveTopic)) {
      this.clusters.set(effectiveTopic, []);
    }
    this.clusters.get(effectiveTopic)!.push({ memoryId, vector, importance });

    // Recompute centroid for this topic
    const entries = this.clusters.get(effectiveTopic)!;
    const vectors = entries.map(e => e.vector).filter(v => v && v.length > 0);
    if (vectors.length > 0) {
      this.centroids.set(effectiveTopic, computeCentroid(vectors));
    }
  }

  /**
   * Get statistics about the topic index.
   */
  getStats(): {
    clusterCount: number;
    largestCluster: string;
    uncategorizedCount: number;
  } {
    let largestCluster = "";
    let largestSize = 0;

    for (const [topic, entries] of this.clusters) {
      if (entries.length > largestSize) {
        largestSize = entries.length;
        largestCluster = topic;
      }
    }

    const uncategorized = this.clusters.get(UNCATEGORIZED_TOPIC);

    return {
      clusterCount: this.clusters.size,
      largestCluster: largestCluster || "(none)",
      uncategorizedCount: uncategorized?.length ?? 0,
    };
  }

  /** Whether the index has been successfully built (cold start check passed). */
  get isBuilt(): boolean {
    return this._built;
  }
}
