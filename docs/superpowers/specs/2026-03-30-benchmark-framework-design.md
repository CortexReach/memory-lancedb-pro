# Benchmark Framework Design

**Date:** 2026-03-30
**Status:** Draft
**Author:** pope + Claude

## 1. Purpose

Quantify and showcase memory-lancedb-pro's retrieval quality with industry-standard benchmarks, enabling credible comparison against Mem0 (0.669), Zep (0.751), Engram (0.80) on LoCoMo.

### Current Scores (baseline)

| Benchmark | Score | Assessment |
|-----------|-------|------------|
| MemBench | accuracy 0.96, avg_recall 1.0 | Excellent — proves core retrieval works |
| LongMemEval | accuracy 0.44 | Mediocre — missing end-to-end pipeline |
| LoCoMo | accuracy 0.318 | Poor — same root cause |
| MemoryAgentBench | F1 9.41, EM 0 | Poor — likely format + pipeline issue |

### Core Insight

MemBench 0.96 proves the retrieval engine is strong. Low LoCoMo/LongMemEval scores are caused by **missing end-to-end pipeline** (extraction + generation layers), not retrieval quality. The benchmark framework must add these layers while keeping their impact measurable and transparent.

## 2. Architecture

### Directory Structure

```
benchmark/
  adapters/
    locomo-adapter.ts        # conversation → extract → store → retrieve → generate
    memorybench-provider.ts  # Supermemory memorybench provider interface
  profiles/
    max-recall.ts            # disable decay, lower thresholds
    production-legacy.ts     # legacy temporal path (no decayEngine, see §4)
  runners/
    types.ts                 # BenchmarkRunner interface
    pro-hybrid.ts            # full pipeline (hybrid + rerank)
    pro-vector-only.ts       # vector only (ablation)
  datasets/
    types.ts                 # BenchmarkMemory, BenchmarkQuery, BenchmarkDataset
    synthetic-en.ts          # English synthetic (pipeline ablation)
    synthetic-zh.ts          # Chinese synthetic (CJK optimization)
  metrics/
    types.ts                 # MetricResult, PerformanceResult, BenchmarkScore
    extraction-recall.ts     # extraction layer quality measurement
    retrieval-metrics.ts     # Recall@K, MRR, NDCG, Precision@K
    end-to-end.ts            # LLM-Judge accuracy, F1, answer-support
    performance.ts           # latency percentiles
  report/
    cli.ts                   # terminal table output
    markdown.ts              # Markdown report generation
    json.ts                  # structured JSON output
  results/                   # generated reports (gitignored)
  run.ts                     # entry point
```

### Entry Point Flow

```
1. Parse CLI args (--runner, --dataset, --profile, --benchmark)
2. Load dataset / connect to LoCoMo data
3. For each runner:
   a. Initialize with profile config (NO decayEngine, NO tierManager)
   b. Embed each memory text via embedder, then seed via importEntry() (preserve timestamps + vectors)
   c. For each query:
      - Execute retrieval, capture trace via RetrievalStatsCollector
      - Record latency, fallback events, result count
   d. Compute metrics
   e. Teardown (delete temp DB)
4. Compute cross-runner stage gains
5. Output reports (CLI + Markdown + JSON)
```

## 3. Runner Interface

```typescript
interface BenchmarkRunner {
  readonly name: string;
  seed(memories: BenchmarkMemory[]): Promise<void>;
  query(q: BenchmarkQuery): Promise<QueryResult[]>;
  teardown(): Promise<void>;
  timings: RunnerTimings;
  /** Fallback events recorded during run */
  fallbackEvents: FallbackEvent[];
}

interface QueryResult {
  id: string;
  score: number;
  rank: number;
}

interface FallbackEvent {
  queryId: string;
  type: "rerank-to-cosine" | "fts-to-lexical";
  /** Distinguishes timeout, HTTP error, invalid response, missing API key, etc. */
  reason: string;
}
```

## 3.5. Dataset Schema

Ground truth linking is critical for metric computation. All datasets must conform to this schema:

```typescript
interface BenchmarkMemory {
  id: string;
  text: string;
  category: "preference" | "fact" | "decision" | "entity" | "other";
  scope: string;              // must be explicit, never null
  importance: number;
  ageDays: number;            // relative to "now", negative = past
  tags: string[];             // for ground truth association
}

interface BenchmarkQuery {
  id: string;
  text: string;
  /** Ordered list of relevant memory IDs (most relevant first) */
  relevantMemoryIds: string[];
  /** Source conversation turn numbers (for extraction recall) */
  sourceConversationTurns?: number[];
  /** Gold answer text (for end-to-end LLM-Judge evaluation) */
  goldAnswer?: string;
  /** Query intent classification */
  intent: "exact-recall" | "semantic" | "temporal" | "cross-lingual" | "noisy";
}

interface BenchmarkDataset {
  name: string;
  lang: "en" | "zh" | "mixed";
  memories: BenchmarkMemory[];
  queries: BenchmarkQuery[];
}
```

**Metric computation relies on:**
- `relevantMemoryIds` → Recall@K, MRR, NDCG (compare retrieved IDs against this list)
- `sourceConversationTurns` → Extraction recall (check if turns were extracted into memories)
- `goldAnswer` → LLM-Judge accuracy, F1 (compare generated answer against gold)

**For LoCoMo adapter:** LoCoMo provides its own QA pairs with gold answers. The adapter maps these to the schema above: `goldAnswer` comes from LoCoMo directly, `relevantMemoryIds` are computed by matching gold answer content against extracted memories, and `sourceConversationTurns` are the turn indices where relevant facts appear.

### Runners (V1 — narrowed scope)

| Runner | Config | Purpose |
|--------|--------|---------|
| **pro-hybrid** | hybrid + rerank, max-recall profile | Showcase full pipeline |
| **pro-vector-only** | vector only, max-recall profile | Ablation baseline |

Additional runners (V2): pro-no-rerank, vanilla-lancedb, pro-production.

### Critical Implementation Details

**importEntry() not store():** All runners MUST use `importEntry()` to preserve original timestamps. `store()` overwrites with `Date.now()`, destroying temporal signal. Note: `importEntry()` requires a valid vector with correct dimension — the seed step must embed each memory text before calling it.

**No decayEngine or tierManager:** Benchmark runners construct retriever via `createRetriever(store, embedder, config, { decayEngine: null })`. This also leaves `tierManager` as `null` (not accepted by `createRetriever`). Both are intentionally disabled so that profile parameters (recencyHalfLifeDays, timeDecayHalfLifeDays, etc.) take effect via the legacy code paths (`applyRecencyBoost`, `applyImportanceWeight`, `applyTimeDecay`) instead of the lifecycle-aware `applyDecayBoost`.

**Use existing trace infrastructure:**
- `retrieveWithTrace()` — method on `MemoryRetriever` in `src/retriever.ts`
- `RetrievalTrace` / `TraceCollector` — types from `src/retrieval-trace.ts`
- `RetrievalStatsCollector` — aggregation from `src/retrieval-stats.ts`

These provide per-stage drop-off, rerank usage, zero-result rates, and latency.

## 4. Profiles

### max-recall (for static benchmarks — LoCoMo, LongMemEval)

```typescript
{
  mode: "hybrid",
  rerank: "cross-encoder",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  hardMinScore: 0.15,        // lowered from 0.35
  minScore: 0.15,            // lowered from 0.3
  timeDecayHalfLifeDays: 0,  // disabled
  recencyHalfLifeDays: 0,    // disabled
  recencyWeight: 0,
  lengthNormAnchor: 0,       // disabled
  candidatePoolSize: 40,     // requires limit cap fix (see §8)
  filterNoise: false,        // disabled for benchmark
}
// Note: unspecified fields inherit from DEFAULT_RETRIEVAL_CONFIG
// (e.g., reinforcementFactor: 0.5, maxHalfLifeMultiplier: 3)
```

### production-legacy (for temporal-correctness tests)

**Important:** This profile approximates production behavior using the legacy code path (no `decayEngine`). The real production path uses `decayEngine` + `applyDecayBoost()` which is a different algorithm. This profile is useful for testing the impact of temporal parameters (recency, time decay) but it is NOT identical to deployed production behavior. A true production-faithful benchmark would require injecting the actual `decayEngine` — this is deferred to V2.

```typescript
{
  mode: "hybrid",
  rerank: "cross-encoder",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  hardMinScore: 0.35,
  minScore: 0.3,
  timeDecayHalfLifeDays: 60,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.1,
  lengthNormAnchor: 500,
  candidatePoolSize: 20,
  filterNoise: true,
}
// Note: NOT identical to production. Production uses decayEngine which
// replaces applyRecencyBoost/applyImportanceWeight/applyTimeDecay with
// applyDecayBoost. See §8 DecayEngine documentation.
```

## 5. Benchmarks

### Layer 1: Industry Standard (V1)

**LoCoMo** — de facto industry standard, 10 conversations, ~300 turns each.
- Source: snap-research/locomo on GitHub
- Question categories 1-4 (skip category 5 adversarial, per industry convention)
- Primary metric: LLM-Judge accuracy (GPT-4o-mini, CORRECT/WRONG)
- Secondary: F1, latency, token count

**MemBench** — already scoring 0.96, include to showcase strength.

### Layer 2: Custom (V2)

Self-built datasets for pipeline ablation and differential value:

| Scenario | Tests | Lang |
|----------|-------|------|
| exact-recall | BM25 contribution | EN + ZH |
| semantic | Vector search quality | EN + ZH |
| temporal-correction | Time decay value (new overwrites old) | EN + ZH |
| cross-lingual | CJK optimization | Mixed |

### Layer 3: Third-party (V2)

memorybench integration for independent verification and side-by-side comparison.

## 6. LoCoMo Adapter

End-to-end pipeline wrapping memory-lancedb-pro for LoCoMo evaluation.

### Pipeline

```
LoCoMo conversation → Extraction Layer → importEntry() → Retrieval → Generation Layer → Answer → Judge
```

### Extraction Layer (minimize information loss)

```
- Process conversation turn-by-turn (not whole conversation at once)
- Extract ALL factual information, prefer over-extraction
- Preserve original wording (protect BM25 keyword matching)
- Tag each fact with source turn number
- Use same LLM as competitors: GPT-4o-mini
- Temperature: 0
```

### Generation Layer (standardize to minimum)

```
Given these memory entries:
{retrieved_memories}

Answer this question based ONLY on the information above.
If the information is not available, say "I don't know."

Question: {question}
```

- Same LLM: GPT-4o-mini, temperature: 0
- No chain-of-thought (minimize LLM "improvisation")

### Three-Layer Measurement

Report each layer's quality independently:

| Layer | Metric | What it proves |
|-------|--------|---------------|
| Extraction | Extraction Recall (% of ground-truth-relevant facts extracted) | Adapter quality |
| Retrieval | Recall@5, MRR (retrieved facts vs ground truth) | Core engine quality |
| End-to-end | LLM-Judge accuracy, F1 | Final benchmark score |

This lets readers see where the bottleneck is. If extraction recall is 95% and retrieval recall is 87% but end-to-end is 63%, the bottleneck is generation, not retrieval.

## 7. Metrics

### Primary (V1)

| Metric | Type | Used for |
|--------|------|----------|
| LLM-Judge accuracy | End-to-end | LoCoMo comparison with competitors |
| F1 (token-level) | End-to-end | Secondary LoCoMo metric |
| Recall@5 | Retrieval | Core retrieval quality |
| MRR | Retrieval | Ranking quality |
| p50/p95 latency | Performance | Speed comparison |

### Secondary (V2)

| Metric | Type | Used for |
|--------|------|----------|
| NDCG@5 | Retrieval | Ranking quality (weighted) |
| Precision@3 | Retrieval | Result precision |
| Answer-support score | End-to-end | Is answer grounded in retrieved memories? |
| Fallback rate | Diagnostic | % of queries where rerank/FTS degraded |
| Extraction recall | Diagnostic | Adapter layer quality |

### Retrieval Metrics Measurement Point

Retrieval metrics (Recall@5, MRR, etc.) are computed against the **final output** of `retrieve()` / `retrieveWithTrace()` — post all stages including noise filter and MMR diversity. This is a conservative measurement: MMR may drop relevant-but-similar results, and noise filter may drop low-quality matches. This is intentional — it measures what the downstream consumer (LLM generation layer) actually sees.

### Note on BLEU

Do NOT use BLEU as a primary metric. For memory QA, answer-support (is the answer grounded in retrieved facts?) is more meaningful than n-gram overlap. Include F1 for LoCoMo comparability only.

## 8. Required Code Changes (Pre-Benchmark)

### P0: Search limit cap

**Problem:** `store.ts` clamps search result count to 20 via `clampInt(limit, 1, 20)` at two locations: `vectorSearch()` (line ~484) and `bm25Search()` (line ~555). Additionally, `retriever.ts` clamps the top-level user-facing `limit` at lines ~395 and ~442 (`retrieve()` and `retrieveWithTrace()`).

Note: the store's over-fetch multiplier (`safeLimit * 20` when `excludeInactive: true`, up to 200) means LanceDB actually fetches up to 200 rows internally — the 20 cap only limits how many are **returned** after filtering. The `candidatePoolSize` flows from the retriever into the store's `limit` parameter, where it gets clamped.

Additionally, the rerank window in `hybridRetrieval` is `filtered.slice(0, limit * 2)` (retriever.ts ~line 624). With a benchmark `limit=5`, rerank only sees 10 candidates regardless of candidatePoolSize. This window must also be widened or made configurable.

**Fix (three locations):**
1. **Store clamp:** Raise `clampInt(limit, 1, 20)` → `clampInt(limit, 1, 50)` in `vectorSearch()` and `bm25Search()`, or add a benchmark-specific uncapped search API.
2. **Rerank window:** Change `filtered.slice(0, limit * 2)` to use `candidatePoolSize` or a dedicated rerank window config.
3. **Retriever final clamp** at 20 can remain — it only affects user-facing output count.

**Files:** `src/store.ts` (~lines 484, 555), `src/retriever.ts` (~lines 395, 442, 624)

### P0: Fusion naming accuracy

**Problem:** Code comments and documentation say "RRF fusion" but implementation is weighted score blending (`vectorScore × weight + bm25Score × weight`) with a BM25 floor. Not reciprocal-rank fusion. The trace stage is also named `"rrf_fusion"` programmatically.

**Fix:** Update documentation, benchmark report, AND the trace stage name in `retriever.ts` (rename `"rrf_fusion"` to `"weighted_fusion"`) to say "weighted score fusion with BM25 floor preservation."

### P1: Fallback event logging

**Problem:** Rerank timeout/failure silently falls back to cosine. FTS failure silently falls back to substring matching. Benchmark can't tell what actually ran. Current `RetrievalTrace` and `RetrievalStatsCollector` only record stage counts/timing — they have no structured fallback event surface. Fallbacks are currently `console.warn` side effects only.

**Fix (requires code changes):**
1. Add a `fallbacks` array field to `RetrievalTrace` in `src/retrieval-trace.ts`
2. In `rerankResults()` (retriever.ts ~line 842), push a fallback event to the trace when cross-encoder fails and cosine is used
3. In `bm25Search()` (store.ts ~line 560), push a fallback event when FTS falls back to `lexicalFallbackSearch()`
4. Benchmark runner reads fallback events from the trace, not from console output

**Files:** `src/retrieval-trace.ts`, `src/retriever.ts` (~lines 842-930), `src/store.ts` (~line 560)

### P1: DecayEngine documentation

**Problem:** When `decayEngine` is injected (production path via `index.ts`), the retriever skips `applyRecencyBoost()`, `applyImportanceWeight()`, and `applyTimeDecay()`, using `applyDecayBoost()` instead. Profile parameters for these stages are ignored.

**Fix:** Document that benchmark runners must use `createRetriever(..., { decayEngine: null })` for profile parameters to take effect. Add assertion in benchmark runner initialization.

## 9. Output Format

### CLI Table

```
┌─────────────────┬──────────────┬───────┬──────────┐
│ Runner          │ LLM-Judge    │ F1    │ p50 (ms) │
├─────────────────┼──────────────┼───────┼──────────┤
│ pro-hybrid      │ 0.65         │ 0.58  │ 120      │
│ pro-vector-only │ 0.52         │ 0.45  │ 85       │
└─────────────────┴──────────────┴───────┴──────────┘

Pipeline Contribution:
  +BM25 + Rerank: LLM-Judge +13pp (vector-only → hybrid)

Fallback Events: 0 rerank degradations, 0 FTS degradations
```

### Markdown Report

`benchmark/results/YYYY-MM-DD-report.md`:
- Environment (embedding model, rerank model, LLM judge, Node version)
- Overall results table
- Pipeline stage gains
- Three-layer breakdown (extraction / retrieval / end-to-end)
- Fallback event summary
- Per-language breakdown (if bilingual)
- Methodology description

### JSON Data

`benchmark/results/YYYY-MM-DD-results.json`:
- Full structured data for all metrics, all runners
- Environment snapshot
- Stage gains computed automatically
- Suitable for trend tracking and visualization

### README Badge Snippet

Auto-generated Markdown for README inclusion:

```markdown
| Metric | memory-lancedb-pro | Mem0 | Zep |
|--------|-------------------|------|-----|
| LoCoMo (LLM-Judge) | **0.65** | 0.67 | 0.75 |
| MemBench (accuracy) | **0.96** | — | — |
```

## 10. Run Commands

```bash
# V1: Run LoCoMo benchmark
npx jiti benchmark/run.ts --benchmark locomo --profile max-recall

# Run with specific runner only
npx jiti benchmark/run.ts --benchmark locomo --runner pro-hybrid

# Run custom synthetic dataset
npx jiti benchmark/run.ts --dataset synthetic-en --profile max-recall

# package.json scripts
npm run bench              # full benchmark suite
npm run bench:locomo       # LoCoMo only
npm run bench:synthetic    # synthetic datasets only
```

### Environment Variables

```bash
# Required — embedding
EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=...          # optional, supports Azure OpenAI

# Required — LLM judge + extraction + generation
LLM_API_KEY=...                 # GPT-4o-mini for LoCoMo adapter
LLM_MODEL=gpt-4o-mini

# Optional — rerank
RERANK_API_KEY=...
RERANK_MODEL=jina-reranker-v3
RERANK_ENDPOINT=...
```

## 11. Phasing

### V1 (MVP — prove the concept)

- 2 runners: pro-hybrid, pro-vector-only
- 1 profile: max-recall
- 2 industry benchmarks: LoCoMo (with adapter, 80 questions) + LongMemEval_s (500 questions)
- 1 existing benchmark: MemBench (already 0.96)
- Core metrics: LLM-Judge accuracy, F1, Recall@5, MRR, p50/p95 latency
- Three-layer reporting
- P0 code fixes (limit cap, importEntry, fusion naming)
- Output: CLI + Markdown + JSON

**Goal:** Get LoCoMo score from 0.318 to 0.55+ with max-recall profile + proper adapter.

### V2 (Expand)

- Additional runners: pro-no-rerank, vanilla-lancedb
- Additional profile: production
- Additional benchmarks: DMR
- Custom synthetic datasets (EN + ZH, 4 scenarios: exact-recall, semantic, temporal-correction, cross-lingual)
- memorybench integration
- Per-language reporting
- Secondary metrics (NDCG, answer-support, fallback rate)

### V3 (Polish)

- Third-party runners (mem0, if feasible)
- Temporal-correction showcase dataset
- Trend tracking across runs
- CI integration (optional)

## 12. Narrative Strategy

The benchmark results should tell this story:

> **memory-lancedb-pro is a high-quality retrieval engine (MemBench 0.96) that also provides production-ready features (temporal decay, scope isolation, CJK optimization) absent from competitors.**
>
> On industry-standard benchmarks (LoCoMo), it achieves competitive scores when wrapped in a standard end-to-end pipeline. Its three-layer reporting transparently shows where each percentage point comes from.
>
> Unlike competing systems that optimize purely for static benchmark scores, memory-lancedb-pro's configurable profiles let you choose: max-recall for raw retrieval power, or production mode for real-world temporal awareness.

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| LoCoMo score still low after adapter | Can't claim competitive | Three-layer reporting shows retrieval layer IS strong; investigate extraction quality first |
| Rerank API instability during benchmark | Inconsistent results | Log fallback events, reject runs with >5% fallback rate |
| LLM extraction quality varies | Unreproducible scores | Pin LLM model + temperature, log extraction recall separately |
| Competitor scores from different conditions | Unfair comparison | Use memorybench (V2) for standardized comparison; cite competitor methodology |
| candidatePoolSize fix changes production behavior | Regression risk | Benchmark-only code path, do not change production clamp |
