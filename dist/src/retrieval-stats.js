/**
 * Retrieval Statistics — Aggregate query metrics
 *
 * Collects per-query traces and produces aggregate statistics
 * for monitoring retrieval quality and performance.
 */
export class RetrievalStatsCollector {
    // Ring buffer: O(1) write, avoids O(n) Array.shift() GC pressure.
    _records = [];
    _head = 0; // next write position
    _count = 0; // number of valid records
    _maxRecords;
    constructor(maxRecords = 1000) {
        this._maxRecords = maxRecords;
        this._records = new Array(maxRecords);
    }
    /**
     * Record a completed query trace.
     * @param trace - The finalized retrieval trace
     * @param source - Query source identifier (e.g. "manual", "auto-recall")
     */
    recordQuery(trace, source) {
        this._records[this._head] = { trace, source };
        this._head = (this._head + 1) % this._maxRecords;
        if (this._count < this._maxRecords) {
            this._count++;
        }
    }
    /** Return records in insertion order (oldest → newest). Used by getStats(). */
    _getRecords() {
        if (this._count === 0)
            return [];
        const result = [];
        const start = this._count < this._maxRecords ? 0 : this._head;
        for (let i = 0; i < this._count; i++) {
            const rec = this._records[(start + i) % this._maxRecords];
            if (rec !== undefined)
                result.push(rec);
        }
        return result;
    }
    /**
     * Compute aggregate statistics from all recorded queries.
     * Iterates ring buffer directly — avoids intermediate array allocation from _getRecords().
     */
    getStats() {
        const n = this._count;
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
        const latencies = [];
        const queriesBySource = {};
        const dropsByStage = {};
        // Iterate ring buffer directly (no intermediate array allocation).
        const start = n < this._maxRecords ? 0 : this._head;
        for (let i = 0; i < n; i++) {
            const rec = this._records[(start + i) % this._maxRecords];
            if (rec === undefined)
                continue;
            const { trace, source } = rec;
            totalLatency += trace.totalMs;
            totalResults += trace.finalCount;
            latencies.push(trace.totalMs);
            if (trace.finalCount === 0)
                zeroResultQueries++;
            queriesBySource[source] = (queriesBySource[source] || 0) + 1;
            for (const stage of trace.stages) {
                const dropped = stage.inputCount - stage.outputCount;
                if (dropped > 0) {
                    dropsByStage[stage.name] = (dropsByStage[stage.name] || 0) + dropped;
                }
                if (stage.name === "rerank")
                    rerankUsed++;
                if (stage.name === "noise_filter" && dropped > 0)
                    noiseFiltered++;
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
    reset() {
        this._records = new Array(this._maxRecords);
        this._head = 0;
        this._count = 0;
    }
    /** Number of recorded queries. */
    get count() {
        return this._count;
    }
}
