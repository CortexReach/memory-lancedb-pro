/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */
import { computeEffectiveHalfLife, parseAccessMetadata, } from "./access-tracker.js";
import { filterNoise } from "./noise-filter.js";
import { expandQuery } from "./query-expander.js";
import { getDecayableFromEntry, isMemoryExpired, parseSmartMetadata, toLifecycleMemory, } from "./smart-metadata.js";
import { TraceCollector } from "./retrieval-trace.js";
// ============================================================================
// Default Configuration
// ============================================================================
export const DEFAULT_RETRIEVAL_CONFIG = {
    mode: "hybrid",
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    queryExpansion: true,
    minScore: 0.3,
    rerank: "cross-encoder",
    candidatePoolSize: 20,
    recencyHalfLifeDays: 14,
    recencyWeight: 0.1,
    filterNoise: true,
    rerankModel: "jina-reranker-v3",
    rerankEndpoint: "https://api.jina.ai/v1/rerank",
    rerankTimeoutMs: 5000,
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
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function clamp01(value, fallback) {
    if (!Number.isFinite(value))
        return Number.isFinite(fallback) ? fallback : 0;
    return Math.min(1, Math.max(0, value));
}
function clamp01WithFloor(value, floor) {
    const safeFloor = clamp01(floor, 0);
    return Math.max(safeFloor, clamp01(value, safeFloor));
}
function attachFailureStage(error, stage) {
    const tagged = error instanceof Error ? error : new Error(String(error));
    tagged.retrievalFailureStage = stage;
    return tagged;
}
function extractFailureStage(error) {
    return error instanceof Error
        ? error.retrievalFailureStage
        : undefined;
}
function buildDropSummary(diagnostics) {
    const stageDrops = [
        {
            order: 0,
            stage: "minScore",
            before: diagnostics.mode === "vector"
                ? diagnostics.vectorResultCount
                : diagnostics.fusedResultCount,
            after: diagnostics.stageCounts.afterMinScore,
        },
        {
            order: 1,
            stage: "rerankWindow",
            before: diagnostics.stageCounts.afterMinScore,
            after: diagnostics.stageCounts.rerankInput,
        },
        {
            order: 2,
            stage: "rerank",
            before: diagnostics.stageCounts.rerankInput,
            after: diagnostics.stageCounts.afterRerank,
        },
        {
            order: 3,
            stage: "recencyBoost",
            before: diagnostics.stageCounts.afterRerank,
            after: diagnostics.stageCounts.afterRecency,
        },
        {
            order: 4,
            stage: "importanceWeight",
            before: diagnostics.stageCounts.afterRecency,
            after: diagnostics.stageCounts.afterImportance,
        },
        {
            order: 5,
            stage: "lengthNorm",
            before: diagnostics.stageCounts.afterImportance,
            after: diagnostics.stageCounts.afterLengthNorm,
        },
        {
            order: 6,
            stage: "hardMinScore",
            before: diagnostics.stageCounts.afterLengthNorm,
            after: diagnostics.stageCounts.afterHardMinScore,
        },
        {
            order: 7,
            stage: "timeDecay",
            before: diagnostics.stageCounts.afterHardMinScore,
            after: diagnostics.stageCounts.afterTimeDecay,
        },
        {
            order: 8,
            stage: "noiseFilter",
            before: diagnostics.stageCounts.afterTimeDecay,
            after: diagnostics.stageCounts.afterNoiseFilter,
        },
        {
            order: 9,
            stage: "diversity",
            before: diagnostics.stageCounts.afterNoiseFilter,
            after: diagnostics.stageCounts.afterDiversity,
        },
        {
            order: 10,
            stage: "limit",
            before: diagnostics.stageCounts.afterDiversity,
            after: diagnostics.finalResultCount,
        },
    ];
    return stageDrops
        .map(({ order, stage, before, after }) => ({
        order,
        stage,
        before,
        after,
        dropped: Math.max(0, before - after),
    }))
        .filter((drop) => drop.dropped > 0)
        .sort((a, b) => b.dropped - a.dropped || a.order - b.order)
        .map(({ order: _order, ...drop }) => drop);
}
/** Build provider-specific request headers and body */
function buildRerankRequest(provider, apiKey, model, query, candidates, topN) {
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
function parseRerankResponse(provider, data) {
    const parseItems = (items, scoreKeys) => {
        if (!Array.isArray(items))
            return null;
        const parsed = [];
        for (const raw of items) {
            const index = typeof raw?.index === "number" ? raw.index : Number(raw?.index);
            if (!Number.isFinite(index))
                continue;
            let score = null;
            for (const key of scoreKeys) {
                const value = raw?.[key];
                const n = typeof value === "number" ? value : Number(value);
                if (Number.isFinite(n)) {
                    score = n;
                    break;
                }
            }
            if (score === null)
                continue;
            parsed.push({ index, score });
        }
        return parsed.length > 0 ? parsed : null;
    };
    const objectData = data && typeof data === "object" && !Array.isArray(data)
        ? data
        : undefined;
    switch (provider) {
        case "tei":
            return (parseItems(data, ["score", "relevance_score"]) ??
                parseItems(objectData?.results, ["score", "relevance_score"]) ??
                parseItems(objectData?.data, ["score", "relevance_score"]));
        case "dashscope": {
            // DashScope: { output: { results: [{ index, relevance_score }] } }
            const output = objectData?.output;
            if (output) {
                return parseItems(output.results, ["relevance_score", "score"]);
            }
            // Fallback: try top-level results in case API format changes
            return parseItems(objectData?.results, ["relevance_score", "score"]);
        }
        case "pinecone": {
            // Pinecone: usually { data: [{ index, score, ... }] }
            // Also tolerate results[] with score/relevance_score for robustness.
            return (parseItems(objectData?.data, ["score", "relevance_score"]) ??
                parseItems(objectData?.results, ["score", "relevance_score"]));
        }
        case "voyage": {
            // Voyage: usually { data: [{ index, relevance_score }] }
            // Also tolerate results[] for compatibility across gateways.
            return (parseItems(objectData?.data, ["relevance_score", "score"]) ??
                parseItems(objectData?.results, ["relevance_score", "score"]));
        }
        case "siliconflow":
        case "jina":
        default: {
            // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
            // Also tolerate data[] for compatibility across gateways.
            return (parseItems(objectData?.results, ["relevance_score", "score"]) ??
                parseItems(objectData?.data, ["relevance_score", "score"]));
        }
    }
}
// Cosine similarity for reranking fallback
function cosineSimilarity(a, b) {
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
    store;
    embedder;
    config;
    decayEngine;
    accessTracker = null;
    lastDiagnostics = null;
    tierManager = null;
    _statsCollector = null;
    constructor(store, embedder, config = DEFAULT_RETRIEVAL_CONFIG, decayEngine = null) {
        this.store = store;
        this.embedder = embedder;
        this.config = config;
        this.decayEngine = decayEngine;
    }
    setAccessTracker(tracker) {
        this.accessTracker = tracker;
    }
    /** Enable aggregate retrieval statistics collection. */
    setStatsCollector(collector) {
        this._statsCollector = collector;
    }
    /** Get the stats collector (if set). */
    getStatsCollector() {
        return this._statsCollector;
    }
    async retrieve(context) {
        const { query, limit, scopeFilter, category, source } = context;
        const safeLimit = clampInt(limit, 1, 20);
        this.lastDiagnostics = null;
        const diagnostics = {
            source,
            mode: this.config.mode,
            originalQuery: query,
            bm25Query: this.config.mode === "vector" ? null : query,
            queryExpanded: false,
            limit: safeLimit,
            scopeFilter: scopeFilter ? [...scopeFilter] : undefined,
            category,
            vectorResultCount: 0,
            bm25ResultCount: 0,
            fusedResultCount: 0,
            finalResultCount: 0,
            stageCounts: {
                afterMinScore: 0,
                rerankInput: 0,
                afterRerank: 0,
                afterRecency: 0,
                afterImportance: 0,
                afterLengthNorm: 0,
                afterTimeDecay: 0,
                afterHardMinScore: 0,
                afterNoiseFilter: 0,
                afterDiversity: 0,
            },
            dropSummary: [],
        };
        try {
            // Create trace only when stats collector is active (zero overhead otherwise)
            const trace = this._statsCollector ? new TraceCollector() : undefined;
            // Check if query contains tag prefixes -> use BM25-only + mustContain
            const tagTokens = this.extractTagTokens(query);
            let results;
            if (tagTokens.length > 0) {
                results = await this.bm25OnlyRetrieval(query, tagTokens, safeLimit, scopeFilter, category, trace, diagnostics);
            }
            else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
                results = await this.vectorOnlyRetrieval(query, safeLimit, scopeFilter, category, trace, diagnostics);
            }
            else {
                results = await this.hybridRetrieval(query, safeLimit, scopeFilter, category, trace, source, diagnostics);
            }
            diagnostics.finalResultCount = results.length;
            diagnostics.dropSummary = buildDropSummary(diagnostics);
            this.lastDiagnostics = diagnostics;
            if (trace && this._statsCollector) {
                const mode = tagTokens.length > 0
                    ? "bm25"
                    : (this.config.mode === "vector" || !this.store.hasFtsSupport)
                        ? "vector"
                        : "hybrid";
                const finalTrace = trace.finalize(query, mode);
                this._statsCollector.recordQuery(finalTrace, source || "unknown");
            }
            // Record access for reinforcement (manual recall only)
            if (this.accessTracker && source === "manual" && results.length > 0) {
                this.accessTracker.recordAccess(results.map((r) => r.entry.id));
            }
            return results;
        }
        catch (error) {
            diagnostics.finalResultCount = 0;
            diagnostics.dropSummary = buildDropSummary(diagnostics);
            diagnostics.errorMessage =
                error instanceof Error ? error.message : String(error);
            this.lastDiagnostics = diagnostics;
            throw error;
        }
    }
    /**
     * Retrieve with full trace, used by the memory_debug tool.
     * Always collects a trace regardless of stats collector state.
     */
    async retrieveWithTrace(context) {
        const { query, limit, scopeFilter, category, source } = context;
        const safeLimit = clampInt(limit, 1, 20);
        const trace = new TraceCollector();
        const tagTokens = this.extractTagTokens(query);
        let results;
        if (tagTokens.length > 0) {
            results = await this.bm25OnlyRetrieval(query, tagTokens, safeLimit, scopeFilter, category, trace);
        }
        else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
            results = await this.vectorOnlyRetrieval(query, safeLimit, scopeFilter, category, trace);
        }
        else {
            results = await this.hybridRetrieval(query, safeLimit, scopeFilter, category, trace);
        }
        const mode = tagTokens.length > 0 ? "bm25"
            : (this.config.mode === "vector" || !this.store.hasFtsSupport) ? "vector" : "hybrid";
        const finalTrace = trace.finalize(query, mode);
        if (this._statsCollector) {
            this._statsCollector.recordQuery(finalTrace, source || "debug");
        }
        if (this.accessTracker && source === "manual" && results.length > 0) {
            this.accessTracker.recordAccess(results.map((r) => r.entry.id));
        }
        return { results, trace: finalTrace };
    }
    extractTagTokens(query) {
        if (!this.config.tagPrefixes?.length)
            return [];
        const pattern = this.config.tagPrefixes.join("|");
        const regex = new RegExp(`(?:${pattern}):[\\w-]+`, "gi");
        const matches = query.match(regex);
        return matches || [];
    }
    async vectorOnlyRetrieval(query, limit, scopeFilter, category, trace, diagnostics) {
        let failureStage = "vector.embedQuery";
        try {
            const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);
            const queryVector = await this.embedder.embedQuery(query);
            failureStage = "vector.vectorSearch";
            const results = await this.store.vectorSearch(queryVector, candidatePoolSize, this.config.minScore, scopeFilter, { excludeInactive: true });
            const filtered = category
                ? results.filter((r) => r.entry.category === category)
                : results;
            // Filter expired memories early — before scoring — so they don't
            // occupy candidate slots that should go to live memories.
            const unexpired = filtered.filter((r) => {
                const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
                return !isMemoryExpired(metadata);
            });
            if (diagnostics) {
                diagnostics.vectorResultCount = unexpired.length;
                diagnostics.fusedResultCount = unexpired.length;
                diagnostics.stageCounts.afterMinScore = unexpired.length;
                diagnostics.stageCounts.rerankInput = unexpired.length;
            }
            const mapped = unexpired.map((result, index) => ({
                ...result,
                sources: {
                    vector: { score: result.score, rank: index + 1 },
                },
            }));
            failureStage = "vector.postProcess";
            // Bug 7 fix: when decayEngine is active, skip applyRecencyBoost here because
            // decayEngine already handles temporal scoring; avoid double-boost.
            const recencyBoosted = this.decayEngine
                ? mapped
                : this.applyRecencyBoost(mapped);
            if (diagnostics)
                diagnostics.stageCounts.afterRecency = recencyBoosted.length;
            const weighted = this.decayEngine
                ? recencyBoosted
                : this.applyImportanceWeight(recencyBoosted);
            if (diagnostics)
                diagnostics.stageCounts.afterImportance = weighted.length;
            const lengthNormalized = this.applyLengthNormalization(weighted);
            if (diagnostics)
                diagnostics.stageCounts.afterLengthNorm = lengthNormalized.length;
            const hardFiltered = lengthNormalized.filter((r) => r.score >= this.config.hardMinScore);
            if (diagnostics)
                diagnostics.stageCounts.afterHardMinScore = hardFiltered.length;
            const timeOrDecayRanked = this.decayEngine
                ? this.applyDecayBoost(hardFiltered)
                : this.applyTimeDecay(hardFiltered);
            if (diagnostics)
                diagnostics.stageCounts.afterTimeDecay = timeOrDecayRanked.length;
            const denoised = this.config.filterNoise
                ? filterNoise(timeOrDecayRanked, (r) => r.entry.text)
                : timeOrDecayRanked;
            if (diagnostics)
                diagnostics.stageCounts.afterNoiseFilter = denoised.length;
            const deduplicated = this.applyMMRDiversity(denoised);
            if (diagnostics) {
                diagnostics.stageCounts.afterRerank = mapped.length;
                diagnostics.stageCounts.afterDiversity = deduplicated.length;
            }
            return deduplicated.slice(0, limit);
        }
        catch (error) {
            if (diagnostics) {
                diagnostics.failureStage = extractFailureStage(error) ?? failureStage;
            }
            throw error;
        }
    }
    async bm25OnlyRetrieval(query, tagTokens, limit, scopeFilter, category, trace, diagnostics) {
        const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);
        trace?.startStage("bm25_search", []);
        const bm25Results = await this.store.bm25Search(query, candidatePoolSize, scopeFilter, { excludeInactive: true });
        const categoryFiltered = category
            ? bm25Results.filter((r) => r.entry.category === category)
            : bm25Results;
        const mustContainFiltered = categoryFiltered.filter((r) => {
            const textLower = r.entry.text.toLowerCase();
            return tagTokens.every((t) => textLower.includes(t.toLowerCase()));
        });
        // Filter expired memories early — before scoring
        const unexpiredResults = mustContainFiltered.filter((r) => {
            const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
            return !isMemoryExpired(metadata);
        });
        const mapped = unexpiredResults.map((result, index) => ({
            ...result,
            sources: { bm25: { score: result.score, rank: index + 1 } },
        }));
        trace?.endStage(mapped.map((r) => r.entry.id), mapped.map((r) => r.score));
        if (diagnostics) {
            diagnostics.bm25Query = query;
            diagnostics.bm25ResultCount = mapped.length;
            diagnostics.fusedResultCount = mapped.length;
            diagnostics.stageCounts.afterMinScore = mapped.length;
            diagnostics.stageCounts.rerankInput = mapped.length;
            diagnostics.stageCounts.afterRerank = mapped.length;
        }
        let temporallyRanked;
        if (this.decayEngine) {
            temporallyRanked = mapped;
            if (diagnostics) {
                diagnostics.stageCounts.afterRecency = mapped.length;
                diagnostics.stageCounts.afterImportance = mapped.length;
            }
        }
        else {
            trace?.startStage("recency_boost", mapped.map((r) => r.entry.id));
            const boosted = this.applyRecencyBoost(mapped);
            trace?.endStage(boosted.map((r) => r.entry.id), boosted.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterRecency = boosted.length;
            trace?.startStage("importance_weight", boosted.map((r) => r.entry.id));
            temporallyRanked = this.applyImportanceWeight(boosted);
            trace?.endStage(temporallyRanked.map((r) => r.entry.id), temporallyRanked.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterImportance = temporallyRanked.length;
        }
        trace?.startStage("length_normalization", temporallyRanked.map((r) => r.entry.id));
        const lengthNormalized = this.applyLengthNormalization(temporallyRanked);
        trace?.endStage(lengthNormalized.map((r) => r.entry.id), lengthNormalized.map((r) => r.score));
        if (diagnostics)
            diagnostics.stageCounts.afterLengthNorm = lengthNormalized.length;
        trace?.startStage("hard_cutoff", lengthNormalized.map((r) => r.entry.id));
        const hardFiltered = lengthNormalized.filter((r) => r.score >= this.config.hardMinScore);
        trace?.endStage(hardFiltered.map((r) => r.entry.id), hardFiltered.map((r) => r.score));
        if (diagnostics)
            diagnostics.stageCounts.afterHardMinScore = hardFiltered.length;
        const decayStageName = this.decayEngine ? "decay_boost" : "time_decay";
        trace?.startStage(decayStageName, hardFiltered.map((r) => r.entry.id));
        const lifecycleRanked = this.decayEngine
            ? this.applyDecayBoost(hardFiltered)
            : this.applyTimeDecay(hardFiltered);
        trace?.endStage(lifecycleRanked.map((r) => r.entry.id), lifecycleRanked.map((r) => r.score));
        if (diagnostics)
            diagnostics.stageCounts.afterTimeDecay = lifecycleRanked.length;
        trace?.startStage("noise_filter", lifecycleRanked.map((r) => r.entry.id));
        const denoised = this.config.filterNoise
            ? filterNoise(lifecycleRanked, (r) => r.entry.text)
            : lifecycleRanked;
        trace?.endStage(denoised.map((r) => r.entry.id), denoised.map((r) => r.score));
        if (diagnostics)
            diagnostics.stageCounts.afterNoiseFilter = denoised.length;
        trace?.startStage("mmr_diversity", denoised.map((r) => r.entry.id));
        const deduplicated = this.applyMMRDiversity(denoised);
        const finalResults = deduplicated.slice(0, limit);
        trace?.endStage(finalResults.map((r) => r.entry.id), finalResults.map((r) => r.score));
        if (diagnostics)
            diagnostics.stageCounts.afterDiversity = deduplicated.length;
        return finalResults;
    }
    async hybridRetrieval(query, limit, scopeFilter, category, trace, source, diagnostics) {
        let failureStage = "hybrid.embedQuery";
        try {
            const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);
            const queryVector = await this.embedder.embedQuery(query);
            const bm25Query = this.buildBM25Query(query, source);
            if (diagnostics) {
                diagnostics.bm25Query = bm25Query;
                diagnostics.queryExpanded = bm25Query !== query;
            }
            trace?.startStage("parallel_search", []);
            failureStage = "hybrid.parallelSearch";
            const settledResults = await Promise.allSettled([
                this.runVectorSearch(queryVector, candidatePoolSize, scopeFilter, category),
                this.runBM25Search(bm25Query, candidatePoolSize, scopeFilter, category),
            ]);
            const vectorResult_ = settledResults[0];
            const bm25Result_ = settledResults[1];
            let vectorResults;
            let bm25Results;
            if (vectorResult_.status === "rejected") {
                const error = attachFailureStage(vectorResult_.reason, "hybrid.vectorSearch");
                console.warn(`[Retriever] vector search failed: ${error.message}`);
                vectorResults = [];
            }
            else {
                vectorResults = vectorResult_.value;
            }
            if (bm25Result_.status === "rejected") {
                const error = attachFailureStage(bm25Result_.reason, "hybrid.bm25Search");
                console.warn(`[Retriever] bm25 search failed: ${error.message}`);
                bm25Results = [];
            }
            else {
                bm25Results = bm25Result_.value;
            }
            // Check if BOTH backends failed (rejected), not just empty results
            // Empty result sets are valid; only throw when both promises reject
            const bothFailed = vectorResult_.status === "rejected" && bm25Result_.status === "rejected";
            if (bothFailed) {
                const vectorError = vectorResult_.reason?.message || "unknown";
                const bm25Error = bm25Result_.reason?.message || "unknown";
                throw attachFailureStage(new Error(`both vector and BM25 search failed: ${vectorError}, ${bm25Error}`), "hybrid.parallelSearch");
            }
            if (diagnostics) {
                diagnostics.vectorResultCount = vectorResults.length;
                diagnostics.bm25ResultCount = bm25Results.length;
            }
            if (trace) {
                const allSearchIds = [
                    ...new Set([
                        ...vectorResults.map((r) => r.entry.id),
                        ...bm25Results.map((r) => r.entry.id),
                    ]),
                ];
                const allScores = [
                    ...vectorResults.map((r) => r.score),
                    ...bm25Results.map((r) => r.score),
                ];
                trace.endStage(allSearchIds, allScores);
            }
            failureStage = "hybrid.fuseResults";
            const allInputIds = [
                ...new Set([
                    ...vectorResults.map((r) => r.entry.id),
                    ...bm25Results.map((r) => r.entry.id),
                ]),
            ];
            trace?.startStage("rrf_fusion", allInputIds);
            const fusedResults = await this.fuseResults(vectorResults, bm25Results);
            trace?.endStage(fusedResults.map((r) => r.entry.id), fusedResults.map((r) => r.score));
            if (diagnostics)
                diagnostics.fusedResultCount = fusedResults.length;
            trace?.startStage("min_score_filter", fusedResults.map((r) => r.entry.id));
            const scoreFiltered = fusedResults.filter((r) => r.score >= this.config.minScore);
            trace?.endStage(scoreFiltered.map((r) => r.entry.id), scoreFiltered.map((r) => r.score));
            // Filter expired memories early — before rerank/scoring
            const filtered = scoreFiltered.filter((r) => {
                const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
                return !isMemoryExpired(metadata);
            });
            if (diagnostics)
                diagnostics.stageCounts.afterMinScore = filtered.length;
            const rerankInput = this.config.rerank !== "none" ? filtered.slice(0, limit * 2) : filtered;
            if (diagnostics)
                diagnostics.stageCounts.rerankInput = rerankInput.length;
            let reranked;
            failureStage = "hybrid.rerank";
            if (this.config.rerank !== "none") {
                trace?.startStage("rerank", filtered.map((r) => r.entry.id));
                reranked = await this.rerankResults(query, queryVector, rerankInput);
                trace?.endStage(reranked.map((r) => r.entry.id), reranked.map((r) => r.score));
            }
            else {
                reranked = filtered;
            }
            if (diagnostics)
                diagnostics.stageCounts.afterRerank = reranked.length;
            let temporallyRanked;
            failureStage = "hybrid.postProcess";
            if (this.decayEngine) {
                temporallyRanked = reranked;
                if (diagnostics) {
                    diagnostics.stageCounts.afterRecency = reranked.length;
                    diagnostics.stageCounts.afterImportance = reranked.length;
                }
            }
            else {
                trace?.startStage("recency_boost", reranked.map((r) => r.entry.id));
                const boosted = this.applyRecencyBoost(reranked);
                trace?.endStage(boosted.map((r) => r.entry.id), boosted.map((r) => r.score));
                if (diagnostics)
                    diagnostics.stageCounts.afterRecency = boosted.length;
                trace?.startStage("importance_weight", boosted.map((r) => r.entry.id));
                temporallyRanked = this.applyImportanceWeight(boosted);
                trace?.endStage(temporallyRanked.map((r) => r.entry.id), temporallyRanked.map((r) => r.score));
                if (diagnostics)
                    diagnostics.stageCounts.afterImportance = temporallyRanked.length;
            }
            trace?.startStage("length_normalization", temporallyRanked.map((r) => r.entry.id));
            const lengthNormalized = this.applyLengthNormalization(temporallyRanked);
            trace?.endStage(lengthNormalized.map((r) => r.entry.id), lengthNormalized.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterLengthNorm = lengthNormalized.length;
            trace?.startStage("hard_cutoff", lengthNormalized.map((r) => r.entry.id));
            const hardFiltered = lengthNormalized.filter((r) => r.score >= this.config.hardMinScore);
            trace?.endStage(hardFiltered.map((r) => r.entry.id), hardFiltered.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterHardMinScore = hardFiltered.length;
            const decayStageName = this.decayEngine ? "decay_boost" : "time_decay";
            trace?.startStage(decayStageName, hardFiltered.map((r) => r.entry.id));
            const lifecycleRanked = this.decayEngine
                ? this.applyDecayBoost(hardFiltered)
                : this.applyTimeDecay(hardFiltered);
            trace?.endStage(lifecycleRanked.map((r) => r.entry.id), lifecycleRanked.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterTimeDecay = lifecycleRanked.length;
            trace?.startStage("noise_filter", lifecycleRanked.map((r) => r.entry.id));
            const denoised = this.config.filterNoise
                ? filterNoise(lifecycleRanked, (r) => r.entry.text)
                : lifecycleRanked;
            trace?.endStage(denoised.map((r) => r.entry.id), denoised.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterNoiseFilter = denoised.length;
            trace?.startStage("mmr_diversity", denoised.map((r) => r.entry.id));
            const deduplicated = this.applyMMRDiversity(denoised);
            const finalResults = deduplicated.slice(0, limit);
            trace?.endStage(finalResults.map((r) => r.entry.id), finalResults.map((r) => r.score));
            if (diagnostics)
                diagnostics.stageCounts.afterDiversity = deduplicated.length;
            return finalResults;
        }
        catch (error) {
            if (diagnostics) {
                diagnostics.failureStage = extractFailureStage(error) ?? failureStage;
            }
            throw error;
        }
    }
    async runVectorSearch(queryVector, limit, scopeFilter, category) {
        const results = await this.store.vectorSearch(queryVector, limit, 0.1, scopeFilter, { excludeInactive: true });
        // Filter by category if specified
        const filtered = category
            ? results.filter((r) => r.entry.category === category)
            : results;
        return filtered.map((result, index) => ({
            ...result,
            rank: index + 1,
        }));
    }
    async runBM25Search(query, limit, scopeFilter, category) {
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
    buildBM25Query(query, source) {
        if (!this.config.queryExpansion)
            return query;
        if (source !== "manual" && source !== "cli")
            return query;
        return expandQuery(query);
    }
    async fuseResults(vectorResults, bm25Results) {
        // Create maps for quick lookup
        const vectorMap = new Map();
        const bm25Map = new Map();
        vectorResults.forEach((result) => {
            vectorMap.set(result.entry.id, result);
        });
        bm25Results.forEach((result) => {
            bm25Map.set(result.entry.id, result);
        });
        // Get all unique document IDs
        const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);
        // Calculate RRF scores
        const fusedResults = [];
        for (const id of allIds) {
            const vectorResult = vectorMap.get(id);
            const bm25Result = bm25Map.get(id);
            // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
            // deleted but whose FTS index entry lingers until the next index rebuild.
            // Validate that the entry actually exists in the store before including it.
            if (!vectorResult && bm25Result) {
                try {
                    const exists = await this.store.hasId(id);
                    if (!exists)
                        continue; // Skip ghost entry
                }
                catch {
                    // If hasId fails, keep the result (fail-open)
                }
            }
            // Use the result with more complete data (prefer vector result if both exist)
            const baseResult = vectorResult || bm25Result;
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
                ? clamp01(Math.max(weightedFusion, bm25Score >= 0.75 ? bm25Score * 0.92 : 0), 0.1)
                : clamp01(bm25Result.score, 0.1);
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
    async rerankResults(query, queryVector, results) {
        if (results.length === 0) {
            return results;
        }
        // Try cross-encoder rerank via configured provider API
        const provider = this.config.rerankProvider || "jina";
        const hasApiKey = !!this.config.rerankApiKey;
        if (this.config.rerank === "cross-encoder" && hasApiKey) {
            try {
                const model = this.config.rerankModel || "jina-reranker-v3";
                const endpoint = this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
                const documents = results.map((r) => r.entry.text);
                // Build provider-specific request
                const { headers, body } = buildRerankRequest(provider, this.config.rerankApiKey || "", model, query, documents, results.length);
                // Timeout: configurable via rerankTimeoutMs (default: 5000ms)
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.config.rerankTimeoutMs ?? 5000);
                let response;
                try {
                    response = await fetch(endpoint, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                }
                finally {
                    clearTimeout(timeout);
                }
                if (response.ok) {
                    const data = await response.json();
                    // Parse provider-specific response into unified format
                    const parsed = parseRerankResponse(provider, data);
                    if (!parsed) {
                        console.warn("Rerank API: invalid response shape, falling back to cosine");
                    }
                    else {
                        // Build a Set of returned indices to identify unreturned candidates
                        const returnedIndices = new Set(parsed.map((r) => r.index));
                        const reranked = parsed
                            .filter((item) => item.index >= 0 && item.index < results.length)
                            .map((item) => {
                            const original = results[item.index];
                            const floor = this.getRerankPreservationFloor(original, false);
                            // Blend: 60% cross-encoder score + 40% original fused score
                            const blendedScore = clamp01WithFloor(item.score * 0.6 + original.score * 0.4, floor);
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
                            score: clamp01WithFloor(r.score * 0.8, this.getRerankPreservationFloor(r, true)),
                        }));
                        return [...reranked, ...unreturned].sort((a, b) => b.score - a.score);
                    }
                }
                else {
                    const errText = await response.text().catch(() => "");
                    console.warn(`Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`);
                }
            }
            catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    console.warn(`Rerank API timed out (${this.config.rerankTimeoutMs ?? 5000}ms), falling back to cosine`);
                }
                else {
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
        }
        catch (error) {
            console.warn("Reranking failed, returning original results:", error);
            return results;
        }
    }
    getRerankPreservationFloor(result, unreturned) {
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
    applyRecencyBoost(results) {
        const { recencyHalfLifeDays, recencyWeight } = this.config;
        if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
            return results;
        }
        const now = Date.now();
        const boosted = results.map((r) => {
            const ts = r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
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
    applyImportanceWeight(results) {
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
    applyDecayBoost(results) {
        if (!this.decayEngine || results.length === 0)
            return results;
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
    applyLengthNormalization(results) {
        const anchor = this.config.lengthNormAnchor;
        if (!anchor || anchor <= 0)
            return results;
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
    applyTimeDecay(results) {
        const halfLife = this.config.timeDecayHalfLifeDays;
        if (!halfLife || halfLife <= 0)
            return results;
        const now = Date.now();
        const decayed = results.map((r) => {
            const ts = r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
            const ageDays = (now - ts) / 86_400_000;
            // Access reinforcement: frequently recalled memories decay slower
            const { accessCount, lastAccessedAt } = parseAccessMetadata(r.entry.metadata);
            // Dynamic memories decay 3x faster than static ones
            const meta = parseSmartMetadata(r.entry.metadata, r.entry);
            const baseHL = meta.memory_temporal_type === "dynamic" ? halfLife / 3 : halfLife;
            const effectiveHL = computeEffectiveHalfLife(baseHL, accessCount, lastAccessedAt, this.config.reinforcementFactor, this.config.maxHalfLifeMultiplier);
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
    applyLifecycleBoost(results) {
        if (!this.decayEngine)
            return results;
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
    async recordAccessAndMaybeTransition(results) {
        if (!this.decayEngine && !this.tierManager)
            return;
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
            const updatedMemory = {
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
            }
            catch {
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
    applyMMRDiversity(results, similarityThreshold = 0.85) {
        if (results.length <= 1)
            return results;
        const selected = [];
        const deferred = [];
        for (const candidate of results) {
            // Check if this candidate is too similar to any already-selected result
            const tooSimilar = selected.some((s) => {
                // Both must have vectors to compare.
                // LanceDB returns Arrow Vector objects (not plain arrays),
                // so use .length directly and Array.from() for conversion.
                const sVec = s.entry.vector;
                const cVec = candidate.entry.vector;
                if (!sVec?.length || !cVec?.length)
                    return false;
                const sArr = Array.from(sVec);
                const cArr = Array.from(cVec);
                const sim = cosineSimilarity(sArr, cArr);
                return sim > similarityThreshold;
            });
            if (tooSimilar) {
                deferred.push(candidate);
            }
            else {
                selected.push(candidate);
            }
        }
        // Append deferred results at the end (available but deprioritized)
        return [...selected, ...deferred];
    }
    // Update configuration
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    // Get current configuration
    getConfig() {
        return { ...this.config };
    }
    getLastDiagnostics() {
        if (!this.lastDiagnostics)
            return null;
        return {
            ...this.lastDiagnostics,
            scopeFilter: this.lastDiagnostics.scopeFilter
                ? [...this.lastDiagnostics.scopeFilter]
                : undefined,
            stageCounts: { ...this.lastDiagnostics.stageCounts },
            dropSummary: this.lastDiagnostics.dropSummary.map((drop) => ({
                ...drop,
            })),
        };
    }
    // Test retrieval system
    async test(query = "test query") {
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
        }
        catch (error) {
            return {
                success: false,
                mode: this.config.mode,
                hasFtsSupport: this.store.hasFtsSupport,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
export function createRetriever(store, embedder, config, options) {
    const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    return new MemoryRetriever(store, embedder, fullConfig, options?.decayEngine ?? null);
}
