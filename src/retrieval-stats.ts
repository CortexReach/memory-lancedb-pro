/**
 * Retrieval Statistics — Aggregate query metrics
 *
 * Collects per-query traces and produces aggregate statistics
 * for monitoring retrieval quality and performance.
 */

import type { RetrievalTrace } from "./retrieval-trace.js";

// ============================================================================
// Types
// ============================================================================

export interface AggregateStats {
  /** Total number of queries recorded */
  totalQueries: number;
  /** Number of queries that returned zero results */
  zeroResultQueries: number;
  /** Average latency across all queries (ms) */
  avgLatencyMs: number;
  /** 95th percentile latency (ms) */
  p95LatencyMs: number;
  /** Average number of results returned */
  avgResultCount: number;
  /** Number of queries where reranking was applied */
  rerankUsed: number;
  /** Number of queries where noise filter removed results */
  noiseFiltered: number;
  /** Query counts broken down by source */
  queriesBySource: Record<string, number>;
  /** Stages that drop the most entries across all queries */
  topDropStages: { name: string; totalDropped: number }[];
}

// ============================================================================
// RetrievalStatsCollector
// ============================================================================

interface QueryRecord {
  trace: RetrievalTrace;
  source: string;
}

export class RetrievalStatsCollector {
  private _records: QueryRecord[] = [];
  private readonly _maxRecords: number;

  constructor(maxRecords = 1000) {
    this._maxRecords = maxRecords;
  }

  /**
   * Record a completed query trace.
   * @param trace - The finalized retrieval trace
   * @param source - Query source identifier (e.g. "manual", "auto-recall")
   */
  recordQuery(trace: RetrievalTrace, source: string): void {
    this._records.push({ trace, source });
    // Evict oldest if over capacity
    if (this._records.length > this._maxRecords) {
      this._records.shift();
    }
  }

  /**
   * Compute aggregate statistics from all recorded queries.
   */
  getStats(): AggregateStats {
    const n = this._records.length;
    if (n === 0) {
      return {
        totalQueries: 0,
        zeroResultQueries: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        avgResultCount: 0,
        rerankUsed: 0,
        noiseFiltered: 0,
        queriesBySource: {},
        topDropStages: [],
      };
    }

    let totalLatency = 0;
    let totalResults = 0;
    let zeroResultQueries = 0;
    let rerankUsed = 0;
    let noiseFiltered = 0;
    const latencies: number[] = [];
    const queriesBySource: Record<string, number> = {};
    const dropsByStage: Record<string, number> = {};

    for (const { trace, source } of this._records) {
      totalLatency += trace.totalMs;
      totalResults += trace.finalCount;
      latencies.push(trace.totalMs);

      if (trace.finalCount === 0) {
        zeroResultQueries++;
      }

      queriesBySource[source] = (queriesBySource[source] || 0) + 1;

      for (const stage of trace.stages) {
        const dropped = stage.inputCount - stage.outputCount;
        if (dropped > 0) {
          dropsByStage[stage.name] = (dropsByStage[stage.name] || 0) + dropped;
        }
        if (stage.name === "rerank") {
          rerankUsed++;
        }
        if (stage.name === "noise_filter" && dropped > 0) {
          noiseFiltered++;
        }
      }
    }

    // Sort latencies for percentile calculation
    latencies.sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(n * 0.95) - 1, n - 1);

    // Top drop stages sorted by total dropped descending
    const topDropStages = Object.entries(dropsByStage)
      .map(([name, totalDropped]) => ({ name, totalDropped }))
      .sort((a, b) => b.totalDropped - a.totalDropped)
      .slice(0, 5);

    return {
      totalQueries: n,
      zeroResultQueries,
      avgLatencyMs: Math.round(totalLatency / n),
      p95LatencyMs: latencies[p95Index],
      avgResultCount: Math.round((totalResults / n) * 10) / 10,
      rerankUsed,
      noiseFiltered,
      queriesBySource,
      topDropStages,
    };
  }

  /**
   * Reset all collected statistics.
   */
  reset(): void {
    this._records = [];
  }

  /** Number of recorded queries. */
  get count(): number {
    return this._records.length;
  }
}
