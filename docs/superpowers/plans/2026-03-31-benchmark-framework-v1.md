# Benchmark Framework V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular benchmark framework that runs LoCoMo end-to-end evaluation, proving memory-lancedb-pro's retrieval quality and raising LoCoMo from 0.318 to 0.55+.

**Architecture:** Modular framework with runners (retrieval configs), profiles (parameter presets), metrics (Recall@K, MRR, LLM-Judge), and reporters (CLI/Markdown/JSON). LoCoMo adapter wraps the retrieval engine with LLM extraction + generation layers. All seeding via `importEntry()` to preserve timestamps.

**Tech Stack:** TypeScript (via jiti), LanceDB, OpenAI SDK (embedding + LLM), node:test for tests.

**Spec:** `docs/superpowers/specs/2026-03-30-benchmark-framework-design.md`

---

## File Map

| File | Responsibility | Task |
|------|---------------|------|
| `src/store.ts` | Raise search limit clamp from 20→50 | Task 1 |
| `src/retriever.ts` | Widen rerank window; rename RRF→weighted_fusion | Task 1 |
| `src/retrieval-trace.ts` | Add fallback event field to RetrievalTrace | Task 2 |
| `benchmark/datasets/types.ts` | BenchmarkMemory, BenchmarkQuery, BenchmarkDataset types | Task 3 |
| `benchmark/profiles/max-recall.ts` | Max-recall profile config export | Task 3 |
| `benchmark/runners/types.ts` | BenchmarkRunner interface, QueryResult, FallbackEvent | Task 4 |
| `benchmark/runners/pro-hybrid.ts` | Hybrid+rerank runner implementation | Task 4 |
| `benchmark/runners/pro-vector-only.ts` | Vector-only runner implementation | Task 4 |
| `benchmark/metrics/retrieval-metrics.ts` | Recall@K, MRR computation | Task 5 |
| `benchmark/metrics/end-to-end.ts` | LLM-Judge accuracy, token-level F1 | Task 6 |
| `benchmark/metrics/performance.ts` | Latency percentile computation | Task 5 |
| `benchmark/adapters/locomo-adapter.ts` | LoCoMo conversation→extract→store→retrieve→generate | Task 7 |
| `benchmark/report/cli.ts` | Terminal table output | Task 8 |
| `benchmark/report/markdown.ts` | Markdown report generation | Task 8 |
| `benchmark/report/json.ts` | JSON data output | Task 8 |
| `benchmark/run.ts` | CLI entry point, orchestration | Task 9 |

---

### Task 1: P0 Code Fixes — Search Limit Cap + Fusion Naming

**Files:**
- Modify: `src/store.ts:484`, `src/store.ts:555`
- Modify: `src/retriever.ts:660`
- Modify: `src/retriever.ts:3`, `src/retriever.ts:643`, `src/retriever.ts:647`, `src/retriever.ts:769`
- Test: `test/benchmark-limit-cap.test.mjs`

- [ ] **Step 1: Write failing test for store limit > 20**

```javascript
// test/benchmark-limit-cap.test.mjs
import { describe, it, assert } from "node:test";

describe("search limit cap", () => {
  it("clampInt should allow values up to 50 for store searches", async () => {
    // The store uses clampInt(limit, 1, 50) after the fix.
    // We import and test the clamp behavior directly via the store module.
    // Since clampInt is not exported, we verify the contract by reading
    // the source and asserting the constant was changed.
    const { readFileSync } = await import("node:fs");
    const storeSource = readFileSync("src/store.ts", "utf-8");
    // After fix, vectorSearch and bm25Search should clamp to 50, not 20
    const matches = storeSource.match(/clampInt\(limit,\s*1,\s*(\d+)\)/g);
    assert.ok(matches, "should find clampInt calls in store.ts");
    for (const match of matches) {
      const cap = parseInt(match.match(/\d+$/)?.[0] ?? "0");
      assert.ok(cap >= 50, `Expected clamp cap >= 50, got ${cap} in: ${match}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify baseline**

Run: `node --test test/benchmark-limit-cap.test.mjs`

- [ ] **Step 3: Raise store search limit clamp from 20 to 50**

In `src/store.ts` line 484, change:
```typescript
// BEFORE
const safeLimit = clampInt(limit, 1, 20);
// AFTER
const safeLimit = clampInt(limit, 1, 50);
```

In `src/store.ts` line 555, same change:
```typescript
// BEFORE
const safeLimit = clampInt(limit, 1, 20);
// AFTER
const safeLimit = clampInt(limit, 1, 50);
```

- [ ] **Step 4: Widen rerank window in retriever**

In `src/retriever.ts` line 660, change:
```typescript
// BEFORE
reranked = await this.rerankResults(query, queryVector, filtered.slice(0, limit * 2));
// AFTER
reranked = await this.rerankResults(query, queryVector, filtered.slice(0, candidatePoolSize));
```

- [ ] **Step 5: Rename RRF to weighted_fusion**

In `src/retriever.ts`, make these replacements:
- Line 3: `RRF fusion` → `weighted score fusion`
- Line 643: `// Fuse results using RRF` → `// Fuse results using weighted score blending`
- Line 647: `"rrf_fusion"` → `"weighted_fusion"`
- Line 769: `// Calculate RRF scores` → `// Calculate weighted fusion scores`

- [ ] **Step 6: Update existing retrieval-trace test**

In `test/retrieval-trace.test.mjs`, replace all references to `"rrf_fusion"` with `"weighted_fusion"`.

- [ ] **Step 7: Run existing test suite to verify no regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/store.ts src/retriever.ts test/benchmark-limit-cap.test.mjs test/retrieval-trace.test.mjs
git commit -m "fix: raise search limit cap to 50, widen rerank window, rename rrf to weighted_fusion

Raises store vectorSearch/bm25Search limit from 20→50 for benchmark candidate pool.
Widens rerank window from limit*2 to candidatePoolSize.
Renames misleading RRF references to weighted_fusion (actual implementation)."
```

---

### Task 2: P1 Code Fix — Fallback Event Logging in Trace

**Files:**
- Modify: `src/retrieval-trace.ts:27-40`
- Modify: `src/retriever.ts` (rerankResults method)
- Test: `test/retrieval-trace.test.mjs` (update existing)

- [ ] **Step 1: Add fallback field to RetrievalTrace interface**

In `src/retrieval-trace.ts`, add to the `RetrievalTrace` interface (after line 39):

```typescript
export interface FallbackEvent {
  stage: string;
  type: "rerank-to-cosine" | "fts-to-lexical";
  reason: string;
}

export interface RetrievalTrace {
  query: string;
  mode: "hybrid" | "vector" | "bm25";
  startedAt: number;
  stages: RetrievalStageResult[];
  /** Fallback events (rerank degradation, FTS unavailable, etc.) */
  fallbacks: FallbackEvent[];
  finalCount: number;
  totalMs: number;
}
```

- [ ] **Step 2: Add fallback recording to TraceCollector**

Add method to `TraceCollector` class:

```typescript
recordFallback(stage: string, type: FallbackEvent["type"], reason: string): void {
  this._fallbacks.push({ stage, type, reason });
}
```

Add `private readonly _fallbacks: FallbackEvent[] = [];` field. Update `finalize()` method to include `fallbacks: this._fallbacks` in the returned `RetrievalTrace` object.

- [ ] **Step 3: Record rerank fallback in retriever**

In `src/retriever.ts` `rerankResults()` method, when falling back to cosine, add:
```typescript
// After the console.warn for timeout/failure:
trace?.recordFallback("rerank", "rerank-to-cosine", "timeout" /* or error message */);
```

Note: `rerankResults` currently does not receive `trace`. Add `trace?: TraceCollector` parameter and pass it from `hybridRetrieval`.

- [ ] **Step 4: Run existing trace tests**

Run: `node --test test/retrieval-trace.test.mjs`
Update any assertions that check the shape of `RetrievalTrace` to include the new `fallbacks` field.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval-trace.ts src/retriever.ts test/retrieval-trace.test.mjs
git commit -m "feat: add structured fallback events to RetrievalTrace

Adds FallbackEvent type and fallbacks array to RetrievalTrace.
Records rerank-to-cosine degradation events in trace instead of
only console.warn. Enables benchmark framework to detect and report
silent degradations."
```

---

### Task 3: Dataset Types + Profile Config

**Files:**
- Create: `benchmark/datasets/types.ts`
- Create: `benchmark/profiles/max-recall.ts`
- Test: `test/benchmark-types.test.mjs`

- [ ] **Step 1: Write test for types and profile**

```javascript
// test/benchmark-types.test.mjs
import { describe, it, assert } from "node:test";

describe("benchmark types", () => {
  it("max-recall profile should have expected fields", async () => {
    const { MAX_RECALL_PROFILE } = await import("../benchmark/profiles/max-recall.js");
    assert.strictEqual(MAX_RECALL_PROFILE.mode, "hybrid");
    assert.strictEqual(MAX_RECALL_PROFILE.hardMinScore, 0.15);
    assert.strictEqual(MAX_RECALL_PROFILE.timeDecayHalfLifeDays, 0);
    assert.strictEqual(MAX_RECALL_PROFILE.recencyHalfLifeDays, 0);
    assert.strictEqual(MAX_RECALL_PROFILE.filterNoise, false);
    assert.strictEqual(MAX_RECALL_PROFILE.candidatePoolSize, 40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-types.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Create dataset types**

```typescript
// benchmark/datasets/types.ts

export interface BenchmarkMemory {
  id: string;
  text: string;
  category: "preference" | "fact" | "decision" | "entity" | "other";
  scope: string;
  importance: number;
  /** Relative to "now", negative = past (e.g., -30 means 30 days ago) */
  ageDays: number;
  tags: string[];
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  /** Ordered list of relevant memory IDs (most relevant first) */
  relevantMemoryIds: string[];
  /** Source conversation turn numbers (for extraction recall) */
  sourceConversationTurns?: number[];
  /** Gold answer text (for end-to-end LLM-Judge evaluation) */
  goldAnswer?: string;
  intent: "exact-recall" | "semantic" | "temporal" | "cross-lingual" | "noisy";
}

export interface BenchmarkDataset {
  name: string;
  lang: "en" | "zh" | "mixed";
  memories: BenchmarkMemory[];
  queries: BenchmarkQuery[];
}
```

- [ ] **Step 4: Create max-recall profile**

```typescript
// benchmark/profiles/max-recall.ts

import type { RetrievalConfig } from "../../src/retriever.js";

export const MAX_RECALL_PROFILE: Partial<RetrievalConfig> = {
  mode: "hybrid",
  rerank: "cross-encoder",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  hardMinScore: 0.15,
  minScore: 0.15,
  timeDecayHalfLifeDays: 0,
  recencyHalfLifeDays: 0,
  recencyWeight: 0,
  lengthNormAnchor: 0,
  candidatePoolSize: 40,
  filterNoise: false,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/benchmark-types.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add benchmark/datasets/types.ts benchmark/profiles/max-recall.ts test/benchmark-types.test.mjs
git commit -m "feat(bench): add dataset types and max-recall profile"
```

---

### Task 4: Runner Interface + Implementations

**Files:**
- Create: `benchmark/runners/types.ts`
- Create: `benchmark/runners/pro-hybrid.ts`
- Create: `benchmark/runners/pro-vector-only.ts`
- Test: `test/benchmark-runner.test.mjs`

- [ ] **Step 1: Write test for runner seed + query contract**

```javascript
// test/benchmark-runner.test.mjs
import { describe, it, assert } from "node:test";

describe("benchmark runner", () => {
  it("ProHybridRunner should implement BenchmarkRunner interface", async () => {
    const { ProHybridRunner } = await import("../benchmark/runners/pro-hybrid.js");
    const runner = new ProHybridRunner({
      embeddingConfig: {
        provider: "openai-compatible",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        baseURL: "http://localhost:11434/v1",
      },
    });
    assert.ok(runner.name, "should have a name");
    assert.strictEqual(typeof runner.seed, "function");
    assert.strictEqual(typeof runner.query, "function");
    assert.strictEqual(typeof runner.teardown, "function");
    assert.ok(Array.isArray(runner.fallbackEvents));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-runner.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Create runner types**

```typescript
// benchmark/runners/types.ts

import type { BenchmarkMemory, BenchmarkQuery } from "../datasets/types.js";

export interface QueryResult {
  id: string;
  score: number;
  rank: number;
}

export interface FallbackEvent {
  queryId: string;
  type: "rerank-to-cosine" | "fts-to-lexical";
  reason: string;
}

export interface RunnerTimings {
  seedMs: number[];   // Array: one entry per seed() call (accumulates across conversations)
  queryMs: number[];
}

export interface BenchmarkRunner {
  readonly name: string;
  seed(memories: BenchmarkMemory[]): Promise<void>;
  query(q: BenchmarkQuery): Promise<QueryResult[]>;
  teardown(): Promise<void>;
  timings: RunnerTimings;
  fallbackEvents: FallbackEvent[];
}

export interface RunnerConfig {
  embeddingConfig: {
    provider: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    dimensions?: number;
  };
  rerankApiKey?: string;
  rerankModel?: string;
  rerankEndpoint?: string;
}
```

- [ ] **Step 4: Create ProHybridRunner**

```typescript
// benchmark/runners/pro-hybrid.ts

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { MemoryStore, validateStoragePath } from "../../src/store.js";
import { createEmbedder } from "../../src/embedder.js";
import { createRetriever } from "../../src/retriever.js";
import { MAX_RECALL_PROFILE } from "../profiles/max-recall.js";
import type { BenchmarkMemory, BenchmarkQuery } from "../datasets/types.js";
import type { BenchmarkRunner, QueryResult, FallbackEvent, RunnerTimings, RunnerConfig } from "./types.js";

export class ProHybridRunner implements BenchmarkRunner {
  readonly name = "pro-hybrid";
  timings: RunnerTimings = { seedMs: [], queryMs: [] };
  fallbackEvents: FallbackEvent[] = [];

  private dbPath: string;
  private store: MemoryStore | null = null;
  private embedder: ReturnType<typeof createEmbedder> | null = null;
  private retriever: ReturnType<typeof createRetriever> | null = null;

  constructor(private config: RunnerConfig) {
    this.dbPath = join(tmpdir(), `bench-pro-hybrid-${randomUUID()}`);
  }

  async seed(memories: BenchmarkMemory[]): Promise<void> {
    const start = Date.now();
    const resolvedPath = validateStoragePath(this.dbPath);

    this.embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: this.config.embeddingConfig.apiKey,
      model: this.config.embeddingConfig.model,
      baseURL: this.config.embeddingConfig.baseURL,
      dimensions: this.config.embeddingConfig.dimensions,
    });

    this.store = new MemoryStore({
      dbPath: resolvedPath,
      vectorDim: this.embedder.dimensions,
    });

    // Merge rerank config from runner config into profile
    const profileWithRerank = {
      ...MAX_RECALL_PROFILE,
      rerankApiKey: this.config.rerankApiKey,
      rerankModel: this.config.rerankModel,
      rerankEndpoint: this.config.rerankEndpoint,
    };

    this.retriever = createRetriever(this.store, this.embedder, profileWithRerank, {
      decayEngine: null, // Intentionally disabled for benchmark
    });

    // Embed and import each memory
    const now = Date.now();
    for (const mem of memories) {
      const vector = await this.embedder.embedPassage(mem.text);
      const timestamp = now + mem.ageDays * 86_400_000;
      await this.store.importEntry({
        id: mem.id,
        text: mem.text,
        vector,
        category: mem.category,
        scope: mem.scope,
        importance: mem.importance,
        timestamp,
        metadata: JSON.stringify({ tags: mem.tags }),
      });
    }

    this.timings.seedMs.push(Date.now() - start);
  }

  async query(q: BenchmarkQuery): Promise<QueryResult[]> {
    if (!this.retriever) throw new Error("Runner not seeded");
    const start = Date.now();

    const results = await this.retriever.retrieve({
      query: q.text,
      limit: 10,
      source: "manual",
    });

    this.timings.queryMs.push(Date.now() - start);

    return results.map((r, i) => ({
      id: r.entry.id,
      score: r.score,
      rank: i + 1,
    }));
  }

  async teardown(): Promise<void> {
    this.store = null;
    this.embedder = null;
    this.retriever = null;
    try {
      rmSync(this.dbPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
```

- [ ] **Step 5: Create ProVectorOnlyRunner**

```typescript
// benchmark/runners/pro-vector-only.ts

// Same structure as pro-hybrid.ts but with vector-only config
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { MemoryStore, validateStoragePath } from "../../src/store.js";
import { createEmbedder } from "../../src/embedder.js";
import { createRetriever } from "../../src/retriever.js";
import { MAX_RECALL_PROFILE } from "../profiles/max-recall.js";
import type { BenchmarkMemory, BenchmarkQuery } from "../datasets/types.js";
import type { BenchmarkRunner, QueryResult, FallbackEvent, RunnerTimings, RunnerConfig } from "./types.js";

export class ProVectorOnlyRunner implements BenchmarkRunner {
  readonly name = "pro-vector-only";
  timings: RunnerTimings = { seedMs: [], queryMs: [] };
  fallbackEvents: FallbackEvent[] = [];

  private dbPath: string;
  private store: MemoryStore | null = null;
  private embedder: ReturnType<typeof createEmbedder> | null = null;
  private retriever: ReturnType<typeof createRetriever> | null = null;

  constructor(private config: RunnerConfig) {
    this.dbPath = join(tmpdir(), `bench-vector-only-${randomUUID()}`);
  }

  async seed(memories: BenchmarkMemory[]): Promise<void> {
    const start = Date.now();
    const resolvedPath = validateStoragePath(this.dbPath);

    this.embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: this.config.embeddingConfig.apiKey,
      model: this.config.embeddingConfig.model,
      baseURL: this.config.embeddingConfig.baseURL,
      dimensions: this.config.embeddingConfig.dimensions,
    });

    this.store = new MemoryStore({
      dbPath: resolvedPath,
      vectorDim: this.embedder.dimensions,
    });

    // Vector-only: override mode to "vector", disable rerank
    const vectorOnlyProfile = {
      ...MAX_RECALL_PROFILE,
      mode: "vector" as const,
      rerank: "none" as const,
    };

    this.retriever = createRetriever(this.store, this.embedder, vectorOnlyProfile, {
      decayEngine: null,
    });

    const now = Date.now();
    for (const mem of memories) {
      const vector = await this.embedder.embedPassage(mem.text);
      const timestamp = now + mem.ageDays * 86_400_000;
      await this.store.importEntry({
        id: mem.id,
        text: mem.text,
        vector,
        category: mem.category,
        scope: mem.scope,
        importance: mem.importance,
        timestamp,
        metadata: JSON.stringify({ tags: mem.tags }),
      });
    }

    this.timings.seedMs.push(Date.now() - start);
  }

  async query(q: BenchmarkQuery): Promise<QueryResult[]> {
    if (!this.retriever) throw new Error("Runner not seeded");
    const start = Date.now();

    const results = await this.retriever.retrieve({
      query: q.text,
      limit: 10,
      source: "manual",
    });

    this.timings.queryMs.push(Date.now() - start);

    return results.map((r, i) => ({
      id: r.entry.id,
      score: r.score,
      rank: i + 1,
    }));
  }

  async teardown(): Promise<void> {
    this.store = null;
    this.embedder = null;
    this.retriever = null;
    try {
      rmSync(this.dbPath, { recursive: true, force: true });
    } catch {}
  }
}
```

- [ ] **Step 6: Run test**

Run: `node --test test/benchmark-runner.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add benchmark/runners/
git commit -m "feat(bench): add runner types and pro-hybrid/pro-vector-only implementations"
```

---

### Task 5: Retrieval Metrics + Performance Metrics

**Files:**
- Create: `benchmark/metrics/retrieval-metrics.ts`
- Create: `benchmark/metrics/performance.ts`
- Test: `test/benchmark-metrics.test.mjs`

- [ ] **Step 1: Write tests for metric calculations**

```javascript
// test/benchmark-metrics.test.mjs
import { describe, it, assert } from "node:test";

describe("retrieval metrics", () => {
  it("recallAtK should compute correctly", async () => {
    const { recallAtK } = await import("../benchmark/metrics/retrieval-metrics.js");
    const retrieved = ["a", "b", "c", "d", "e"];
    const relevant = ["a", "c", "f"];
    // At K=5: found a,c out of a,c,f → 2/3
    assert.strictEqual(recallAtK(retrieved, relevant, 5), 2 / 3);
    // At K=1: found a out of a,c,f → 1/3
    assert.strictEqual(recallAtK(retrieved, relevant, 1), 1 / 3);
  });

  it("mrr should compute correctly", async () => {
    const { mrr } = await import("../benchmark/metrics/retrieval-metrics.js");
    // First relevant at rank 1 → 1/1
    assert.strictEqual(mrr(["a", "b"], ["a"]), 1.0);
    // First relevant at rank 3 → 1/3
    assert.strictEqual(mrr(["x", "y", "a"], ["a"]), 1 / 3);
    // No relevant found → 0
    assert.strictEqual(mrr(["x", "y"], ["a"]), 0);
  });

  it("computePercentiles should compute p50/p95/p99", async () => {
    const { computePercentiles } = await import("../benchmark/metrics/performance.js");
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = computePercentiles(values);
    assert.strictEqual(p.p50, 50);
    assert.strictEqual(p.p95, 95);
    assert.strictEqual(p.p99, 99);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-metrics.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement retrieval metrics**

```typescript
// benchmark/metrics/retrieval-metrics.ts

export function recallAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = retrievedIds.slice(0, k);
  const hits = topK.filter((id) => relevantIds.includes(id)).length;
  return hits / relevantIds.length;
}

export function mrr(retrievedIds: string[], relevantIds: string[]): number {
  const relevantSet = new Set(relevantIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (relevantSet.has(retrievedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function ndcgAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  const topK = retrievedIds.slice(0, k);

  // DCG: relevance = position in relevantIds (higher = more relevant)
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const relIdx = relevantIds.indexOf(topK[i]);
    if (relIdx >= 0) {
      const relevance = relevantIds.length - relIdx; // higher rank = higher relevance
      dcg += relevance / Math.log2(i + 2);
    }
  }

  // Ideal DCG
  let idcg = 0;
  const idealK = Math.min(k, relevantIds.length);
  for (let i = 0; i < idealK; i++) {
    const relevance = relevantIds.length - i;
    idcg += relevance / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export interface RetrievalMetricResult {
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
}

export function computeRetrievalMetrics(
  retrievedIds: string[],
  relevantIds: string[],
): RetrievalMetricResult {
  return {
    recallAt5: recallAtK(retrievedIds, relevantIds, 5),
    mrr: mrr(retrievedIds, relevantIds),
    ndcgAt5: ndcgAtK(retrievedIds, relevantIds, 5),
  };
}
```

- [ ] **Step 4: Implement performance metrics**

```typescript
// benchmark/metrics/performance.ts

export interface PercentileResult {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

export function computePercentiles(values: number[]): PercentileResult {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };

  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    mean: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/benchmark-metrics.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add benchmark/metrics/ test/benchmark-metrics.test.mjs
git commit -m "feat(bench): add retrieval metrics (Recall@K, MRR, NDCG) and performance percentiles"
```

---

### Task 6: End-to-End Metrics (LLM-Judge + F1)

**Files:**
- Create: `benchmark/metrics/end-to-end.ts`
- Test: `test/benchmark-e2e-metrics.test.mjs`

- [ ] **Step 1: Write test for token-level F1**

```javascript
// test/benchmark-e2e-metrics.test.mjs
import { describe, it, assert } from "node:test";

describe("end-to-end metrics", () => {
  it("tokenF1 should compute correctly", async () => {
    const { tokenF1 } = await import("../benchmark/metrics/end-to-end.js");
    // Exact match → 1.0
    assert.strictEqual(tokenF1("the cat sat", "the cat sat"), 1.0);
    // Partial overlap
    const score = tokenF1("the cat sat on the mat", "the cat is here");
    assert.ok(score > 0 && score < 1, `Expected partial F1, got ${score}`);
    // No overlap → 0
    assert.strictEqual(tokenF1("hello world", "foo bar"), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-e2e-metrics.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement end-to-end metrics**

```typescript
// benchmark/metrics/end-to-end.ts

import OpenAI from "openai";

/** Token-level F1 score between predicted and gold answer (SQuAD-style multiset) */
export function tokenF1(predicted: string, gold: string): number {
  const predTokens = predicted.toLowerCase().split(/\s+/).filter(Boolean);
  const goldTokens = gold.toLowerCase().split(/\s+/).filter(Boolean);

  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;

  // Multiset intersection: count each token up to its frequency in gold
  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);

  let truePositives = 0;
  const usedCounts = new Map<string, number>();
  for (const t of predTokens) {
    const available = (goldCounts.get(t) ?? 0) - (usedCounts.get(t) ?? 0);
    if (available > 0) {
      truePositives++;
      usedCounts.set(t, (usedCounts.get(t) ?? 0) + 1);
    }
  }

  const precision = truePositives / predTokens.length;
  const recall = truePositives / goldTokens.length;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** LLM-Judge: binary CORRECT/WRONG via GPT-4o-mini */
export async function llmJudge(
  question: string,
  predicted: string,
  gold: string,
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<{ correct: boolean; raw: string }> {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are evaluating whether an AI assistant's answer is correct. " +
          "Compare the predicted answer with the gold answer. " +
          "Reply with exactly CORRECT or WRONG. " +
          "Be generous: if the predicted answer captures the key facts from the gold answer, mark it CORRECT even if wording differs.",
      },
      {
        role: "user",
        content: `Question: ${question}\n\nGold Answer: ${gold}\n\nPredicted Answer: ${predicted}\n\nVerdict:`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const correct = raw.toUpperCase().startsWith("CORRECT");
  return { correct, raw };
}

export interface EndToEndResult {
  llmJudgeAccuracy: number;
  f1: number;
  totalQueries: number;
  correctCount: number;
}
```

- [ ] **Step 4: Run test**

Run: `node --test test/benchmark-e2e-metrics.test.mjs`
Expected: PASS (only testing tokenF1, not llmJudge which needs live API)

- [ ] **Step 5: Commit**

```bash
git add benchmark/metrics/end-to-end.ts test/benchmark-e2e-metrics.test.mjs
git commit -m "feat(bench): add end-to-end metrics (token F1, LLM-Judge)"
```

---

### Task 7: LoCoMo Adapter

**Files:**
- Create: `benchmark/adapters/locomo-adapter.ts`
- Test: `test/benchmark-locomo-adapter.test.mjs`

- [ ] **Step 1: Write test for extraction prompt parsing**

```javascript
// test/benchmark-locomo-adapter.test.mjs
import { describe, it, assert } from "node:test";

describe("locomo adapter", () => {
  it("parseExtractionResponse should extract facts", async () => {
    const { parseExtractionResponse } = await import("../benchmark/adapters/locomo-adapter.js");
    const response = "1. User's name is Alice\n2. User lives in New York\n3. User prefers dark theme";
    const facts = parseExtractionResponse(response);
    assert.strictEqual(facts.length, 3);
    assert.ok(facts[0].includes("Alice"));
  });

  it("buildGenerationPrompt should format correctly", async () => {
    const { buildGenerationPrompt } = await import("../benchmark/adapters/locomo-adapter.js");
    const prompt = buildGenerationPrompt(
      [{ text: "User lives in NYC", score: 0.9 }],
      "Where does the user live?",
    );
    assert.ok(prompt.includes("NYC"));
    assert.ok(prompt.includes("Where does the user live?"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-locomo-adapter.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement LoCoMo adapter**

```typescript
// benchmark/adapters/locomo-adapter.ts

import OpenAI from "openai";
import type { BenchmarkMemory } from "../datasets/types.js";

// ============================================================================
// Extraction Layer
// ============================================================================

const EXTRACTION_PROMPT = `Extract ALL factual information from this conversation turn.
Return each fact on its own numbered line.
Preserve the original wording as much as possible.
Include: names, preferences, locations, dates, decisions, relationships, opinions.
If no factual information is present, return "NONE".`;

export async function extractFacts(
  turn: { speaker: string; text: string; turnIndex: number },
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<Array<{ text: string; turnIndex: number }>> {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: `[Turn ${turn.turnIndex}] ${turn.speaker}: ${turn.text}` },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (content === "NONE" || !content) return [];

  return parseExtractionResponse(content).map((text) => ({
    text,
    turnIndex: turn.turnIndex,
  }));
}

export function parseExtractionResponse(response: string): string[] {
  return response
    .split("\n")
    .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "NONE");
}

// ============================================================================
// Generation Layer
// ============================================================================

export function buildGenerationPrompt(
  memories: Array<{ text: string; score: number }>,
  question: string,
): string {
  const memoryBlock = memories
    .map((m, i) => `${i + 1}. ${m.text}`)
    .join("\n");

  return `Given these memory entries:
${memoryBlock}

Answer this question based ONLY on the information above.
If the information is not available, say "I don't know."

Question: ${question}`;
}

export async function generateAnswer(
  memories: Array<{ text: string; score: number }>,
  question: string,
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<string> {
  const prompt = buildGenerationPrompt(memories, question);

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ============================================================================
// LoCoMo Data Loader
// ============================================================================

export interface LoCoMoConversation {
  conversation_id: string;
  sessions: Array<{
    session_id: string;
    turns: Array<{
      speaker: string;
      text: string;
    }>;
  }>;
  qa_pairs: Array<{
    question: string;
    answer: string;
    category: number;
  }>;
}

export function flattenTurns(
  conv: LoCoMoConversation,
): Array<{ speaker: string; text: string; turnIndex: number }> {
  const turns: Array<{ speaker: string; text: string; turnIndex: number }> = [];
  let idx = 0;
  for (const session of conv.sessions) {
    for (const turn of session.turns) {
      turns.push({ ...turn, turnIndex: idx++ });
    }
  }
  return turns;
}

export function factsToMemories(
  facts: Array<{ text: string; turnIndex: number }>,
  conversationId: string,
): BenchmarkMemory[] {
  return facts.map((fact, i) => ({
    id: `${conversationId}-fact-${i}`,
    text: fact.text,
    category: "fact" as const,
    scope: "global",
    importance: 0.7,
    ageDays: -(facts.length - i), // older facts get earlier timestamps
    tags: [`turn:${fact.turnIndex}`],
  }));
}
```

- [ ] **Step 4: Run test**

Run: `node --test test/benchmark-locomo-adapter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/adapters/locomo-adapter.ts test/benchmark-locomo-adapter.test.mjs
git commit -m "feat(bench): add LoCoMo adapter with extraction and generation layers"
```

---

### Task 8: Report Generators (CLI + Markdown + JSON)

**Files:**
- Create: `benchmark/report/cli.ts`
- Create: `benchmark/report/markdown.ts`
- Create: `benchmark/report/json.ts`
- Test: `test/benchmark-report.test.mjs`

- [ ] **Step 1: Write test for report generation**

```javascript
// test/benchmark-report.test.mjs
import { describe, it, assert } from "node:test";

describe("report generators", () => {
  const mockScores = [
    {
      runner: "pro-hybrid",
      overall: { recallAt5: 0.82, mrr: 0.76, ndcgAt5: 0.79, llmJudgeAccuracy: 0.65, f1: 0.58 },
      performance: { p50: 120, p95: 250, p99: 400, mean: 140, min: 50, max: 500 },
    },
    {
      runner: "pro-vector-only",
      overall: { recallAt5: 0.65, mrr: 0.60, ndcgAt5: 0.63, llmJudgeAccuracy: 0.52, f1: 0.45 },
      performance: { p50: 85, p95: 180, p99: 300, mean: 95, min: 40, max: 350 },
    },
  ];

  it("formatCliTable should produce table string", async () => {
    const { formatCliTable } = await import("../benchmark/report/cli.js");
    const output = formatCliTable(mockScores);
    assert.ok(output.includes("pro-hybrid"));
    assert.ok(output.includes("pro-vector-only"));
  });

  it("generateJson should produce valid JSON structure", async () => {
    const { generateJson } = await import("../benchmark/report/json.js");
    const json = generateJson(mockScores, { embeddingModel: "text-embedding-3-small" });
    const parsed = JSON.parse(json);
    assert.ok(parsed.timestamp);
    assert.strictEqual(parsed.scores.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-report.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement CLI report**

```typescript
// benchmark/report/cli.ts

export interface ScoreRow {
  runner: string;
  overall: {
    recallAt5: number;
    mrr: number;
    ndcgAt5: number;
    llmJudgeAccuracy: number;
    f1: number;
  };
  performance: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    min: number;
    max: number;
  };
}

export function formatCliTable(scores: ScoreRow[]): string {
  const header = `| Runner          | LLM-Judge | F1    | Recall@5 | MRR   | p50 (ms) |`;
  const sep = `|-----------------|-----------|-------|----------|-------|----------|`;
  const rows = scores.map(
    (s) =>
      `| ${s.runner.padEnd(15)} | ${s.overall.llmJudgeAccuracy.toFixed(3).padStart(9)} | ${s.overall.f1.toFixed(3).padStart(5)} | ${s.overall.recallAt5.toFixed(3).padStart(8)} | ${s.overall.mrr.toFixed(3).padStart(5)} | ${String(s.performance.p50).padStart(8)} |`,
  );

  const lines = [header, sep, ...rows];

  // Stage gains
  if (scores.length >= 2) {
    const hybrid = scores.find((s) => s.runner.includes("hybrid"));
    const vector = scores.find((s) => s.runner.includes("vector"));
    if (hybrid && vector) {
      const delta = ((hybrid.overall.llmJudgeAccuracy - vector.overall.llmJudgeAccuracy) * 100).toFixed(0);
      lines.push("");
      lines.push(`Pipeline Contribution: +BM25 + Rerank: LLM-Judge +${delta}pp (vector-only → hybrid)`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Implement JSON report**

```typescript
// benchmark/report/json.ts

import type { ScoreRow } from "./cli.js";

export interface ReportEnvironment {
  embeddingModel: string;
  rerankModel?: string;
  llmModel?: string;
  nodeVersion?: string;
  platform?: string;
}

export function generateJson(
  scores: ScoreRow[],
  env: ReportEnvironment,
): string {
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      ...env,
      nodeVersion: env.nodeVersion ?? process.version,
      platform: env.platform ?? process.platform,
    },
    scores,
  };

  return JSON.stringify(report, null, 2);
}
```

- [ ] **Step 5: Implement Markdown report**

```typescript
// benchmark/report/markdown.ts

import type { ScoreRow } from "./cli.js";
import type { ReportEnvironment } from "./json.js";
import { formatCliTable } from "./cli.js";

export function generateMarkdown(
  scores: ScoreRow[],
  env: ReportEnvironment,
): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `# Benchmark Report — ${date}`,
    "",
    "## Environment",
    `- Embedding: ${env.embeddingModel}`,
    env.rerankModel ? `- Rerank: ${env.rerankModel}` : "",
    env.llmModel ? `- LLM Judge: ${env.llmModel}` : "",
    `- Node: ${env.nodeVersion ?? process.version}`,
    `- Platform: ${env.platform ?? process.platform}`,
    "",
    "## Results",
    "",
    formatCliTable(scores),
    "",
    "## Methodology",
    "",
    "- Dataset: LoCoMo (categories 1-4)",
    "- Extraction: Per-turn LLM fact extraction (GPT-4o-mini, temperature=0)",
    "- Generation: Minimal prompt, GPT-4o-mini, temperature=0",
    "- Judge: GPT-4o-mini binary CORRECT/WRONG",
    "",
    `> Generated by memory-lancedb-pro benchmark framework on ${date}`,
  ];

  return lines.filter((l) => l !== undefined).join("\n");
}
```

- [ ] **Step 6: Run tests**

Run: `node --test test/benchmark-report.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add benchmark/report/ test/benchmark-report.test.mjs
git commit -m "feat(bench): add report generators (CLI table, Markdown, JSON)"
```

---

### Task 9: Entry Point — run.ts + Package Integration

**Files:**
- Create: `benchmark/run.ts`
- Modify: `package.json` (add bench scripts)
- Modify: `.gitignore` (add benchmark/results/)

- [ ] **Step 1: Create entry point**

```typescript
// benchmark/run.ts

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";

import { ProHybridRunner } from "./runners/pro-hybrid.js";
import { ProVectorOnlyRunner } from "./runners/pro-vector-only.js";
import type { BenchmarkRunner } from "./runners/types.js";
import type { RunnerConfig } from "./runners/types.js";
import { computeRetrievalMetrics } from "./metrics/retrieval-metrics.js";
import { computePercentiles } from "./metrics/performance.js";
import { tokenF1, llmJudge } from "./metrics/end-to-end.js";
import { formatCliTable, type ScoreRow } from "./report/cli.js";
import { generateJson } from "./report/json.js";
import { generateMarkdown } from "./report/markdown.js";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const { values: args } = parseArgs({
  options: {
    runner: { type: "string" },
    benchmark: { type: "string", default: "locomo" },
    profile: { type: "string", default: "max-recall" },
  },
});

// ============================================================================
// Environment Validation
// ============================================================================

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const EMBEDDING_API_KEY = requireEnv("EMBEDDING_API_KEY");
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL;
const LLM_API_KEY = requireEnv("LLM_API_KEY");
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const RERANK_API_KEY = process.env.RERANK_API_KEY;
const RERANK_MODEL = process.env.RERANK_MODEL;
const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT;

// ============================================================================
// Runner Setup
// ============================================================================

const runnerConfig: RunnerConfig = {
  embeddingConfig: {
    provider: "openai-compatible",
    apiKey: EMBEDDING_API_KEY,
    model: EMBEDDING_MODEL,
    baseURL: EMBEDDING_BASE_URL,
  },
  rerankApiKey: RERANK_API_KEY,
  rerankModel: RERANK_MODEL,
  rerankEndpoint: RERANK_ENDPOINT,
};

function createRunners(): BenchmarkRunner[] {
  const all: BenchmarkRunner[] = [
    new ProHybridRunner(runnerConfig),
    new ProVectorOnlyRunner(runnerConfig),
  ];

  if (args.runner) {
    const filtered = all.filter((r) => r.name === args.runner);
    if (filtered.length === 0) {
      console.error(`Unknown runner: ${args.runner}. Available: ${all.map((r) => r.name).join(", ")}`);
      process.exit(1);
    }
    return filtered;
  }

  return all;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("memory-lancedb-pro benchmark framework v1");
  console.log(`Benchmark: ${args.benchmark} | Profile: ${args.profile}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} | LLM: ${LLM_MODEL}`);
  console.log("---");

  // TODO: In V1, load LoCoMo data from locomo10.json
  // For now, this is the orchestration skeleton
  console.error(
    "LoCoMo data loading not yet implemented. " +
    "Download locomo10.json from snap-research/locomo and place in benchmark/data/locomo10.json"
  );

  const runners = createRunners();
  const scores: ScoreRow[] = [];

  for (const runner of runners) {
    console.log(`\nRunning: ${runner.name}...`);

    // TODO: seed + query loop (depends on LoCoMo data loader)
    // Skeleton for score collection:
    scores.push({
      runner: runner.name,
      overall: { recallAt5: 0, mrr: 0, ndcgAt5: 0, llmJudgeAccuracy: 0, f1: 0 },
      performance: { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
    });

    await runner.teardown();
  }

  // Output reports
  console.log("\n" + formatCliTable(scores));

  // Save reports
  const resultsDir = join(import.meta.dirname ?? ".", "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  const env = { embeddingModel: EMBEDDING_MODEL, rerankModel: RERANK_MODEL, llmModel: LLM_MODEL };

  writeFileSync(join(resultsDir, `${date}-results.json`), generateJson(scores, env));
  writeFileSync(join(resultsDir, `${date}-report.md`), generateMarkdown(scores, env));
  console.log(`\nReports saved to ${resultsDir}/`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Add bench scripts to package.json**

Add to `scripts` in `package.json`:
```json
"bench": "jiti benchmark/run.ts",
"bench:locomo": "jiti benchmark/run.ts --benchmark locomo"
```

- [ ] **Step 3: Add benchmark/results/ to .gitignore**

Append to `.gitignore`:
```
benchmark/results/
```

- [ ] **Step 4: Verify the entry point loads without error**

Run: `npx jiti benchmark/run.ts --help 2>&1 || true`
Expected: Should parse args or show usage (may error about missing env vars — that's fine)

- [ ] **Step 5: Commit**

```bash
git add benchmark/run.ts package.json .gitignore
git commit -m "feat(bench): add benchmark entry point and package.json scripts

Orchestration skeleton with CLI arg parsing, runner setup,
report generation. LoCoMo data loading is TODO for next task."
```

---

### Task 10: LoCoMo Data Loader + Full Integration

**Files:**
- Create: `benchmark/data/.gitkeep` (placeholder for locomo10.json)
- Modify: `benchmark/run.ts` (wire up full pipeline)

- [ ] **Step 1: Create data directory**

```bash
mkdir -p benchmark/data
touch benchmark/data/.gitkeep
echo "benchmark/data/locomo10.json" >> .gitignore
```

- [ ] **Step 2: Implement LoCoMo data loading in run.ts**

Add to `benchmark/run.ts` the full pipeline:

```typescript
import { readFileSync } from "node:fs";
import {
  extractFacts,
  flattenTurns,
  factsToMemories,
  generateAnswer,
  type LoCoMoConversation,
} from "./adapters/locomo-adapter.js";

async function runLoComoBenchmark(runners: BenchmarkRunner[]): Promise<ScoreRow[]> {
  const dataPath = join(import.meta.dirname ?? ".", "data", "locomo10.json");
  if (!existsSync(dataPath)) {
    console.error(`LoCoMo data not found at ${dataPath}`);
    console.error("Download from: https://github.com/snap-research/locomo");
    process.exit(1);
  }

  const conversations: LoCoMoConversation[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const llmClient = new OpenAI({ apiKey: LLM_API_KEY });
  const scores: ScoreRow[] = [];

  for (const runner of runners) {
    console.log(`\n=== Runner: ${runner.name} ===`);

    // Process each conversation
    let totalCorrect = 0;
    let totalF1 = 0;
    let totalQueries = 0;

    for (const conv of conversations) {
      console.log(`  Processing conversation ${conv.conversation_id}...`);

      // 1. Extract facts from conversation
      const turns = flattenTurns(conv);
      const allFacts: Array<{ text: string; turnIndex: number }> = [];
      for (const turn of turns) {
        const facts = await extractFacts(turn, llmClient, LLM_MODEL);
        allFacts.push(...facts);
      }
      console.log(`    Extracted ${allFacts.length} facts from ${turns.length} turns`);

      // 2. Convert to memories and seed
      const memories = factsToMemories(allFacts, conv.conversation_id);
      await runner.seed(memories);

      // 3. Run QA pairs (categories 1-4 only)
      const qaPairs = conv.qa_pairs.filter((qa) => qa.category >= 1 && qa.category <= 4);

      for (const qa of qaPairs) {
        // Retrieve
        const results = await runner.query({
          id: `${conv.conversation_id}-q-${totalQueries}`,
          text: qa.question,
          relevantMemoryIds: [], // LoCoMo doesn't provide memory-level ground truth
          intent: "semantic",
          goldAnswer: qa.answer,
        });

        // Generate answer
        const memoryTexts = results.map((r) => {
          // Look up the full text from seeded memories
          const mem = memories.find((m) => m.id === r.id);
          return { text: mem?.text ?? "", score: r.score };
        });

        const predicted = await generateAnswer(memoryTexts, qa.question, llmClient, LLM_MODEL);

        // Judge
        const judgment = await llmJudge(qa.question, predicted, qa.answer, llmClient, LLM_MODEL);
        const f1 = tokenF1(predicted, qa.answer);

        if (judgment.correct) totalCorrect++;
        totalF1 += f1;
        totalQueries++;
      }

      // Teardown for this conversation (re-seed fresh for next)
      await runner.teardown();
    }

    // Compute aggregate scores
    const latency = computePercentiles(runner.timings.queryMs);

    scores.push({
      runner: runner.name,
      overall: {
        recallAt5: 0, // Not applicable for LoCoMo (no memory-level ground truth)
        mrr: 0,
        ndcgAt5: 0,
        llmJudgeAccuracy: totalQueries > 0 ? totalCorrect / totalQueries : 0,
        f1: totalQueries > 0 ? totalF1 / totalQueries : 0,
      },
      performance: latency,
    });

    console.log(
      `  Results: LLM-Judge=${(totalCorrect / totalQueries).toFixed(3)}, ` +
      `F1=${(totalF1 / totalQueries).toFixed(3)}, ` +
      `Queries=${totalQueries}`,
    );
  }

  return scores;
}
```

Replace the TODO in `main()` with:
```typescript
const scores = await runLoComoBenchmark(runners);
```

- [ ] **Step 3: Test with a dry run (no LoCoMo data)**

Run: `EMBEDDING_API_KEY=test LLM_API_KEY=test npx jiti benchmark/run.ts 2>&1 | head -5`
Expected: Error about locomo10.json not found (correct behavior)

- [ ] **Step 4: Commit**

```bash
git add benchmark/data/.gitkeep benchmark/run.ts .gitignore
git commit -m "feat(bench): wire up full LoCoMo benchmark pipeline

Complete end-to-end flow: load LoCoMo data → extract facts per turn →
seed runner → retrieve + generate answer → LLM-Judge → aggregate scores.
Requires locomo10.json in benchmark/data/ (not committed)."
```

---

### Task 11: LongMemEval Adapter + Integration

**Files:**
- Create: `benchmark/adapters/longmemeval-adapter.ts`
- Modify: `benchmark/run.ts` (add --benchmark longmemeval option)
- Test: `test/benchmark-longmemeval-adapter.test.mjs`

LongMemEval has a different data format than LoCoMo. It provides chat histories with 500 curated questions testing 5 memory abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. We use `LongMemEval_s` (115K tokens) for V1.

- [ ] **Step 1: Write test for LongMemEval data parsing**

```javascript
// test/benchmark-longmemeval-adapter.test.mjs
import { describe, it, assert } from "node:test";

describe("longmemeval adapter", () => {
  it("parseLongMemEvalData should extract sessions and questions", async () => {
    const { parseLongMemEvalData } = await import("../benchmark/adapters/longmemeval-adapter.js");

    // Mock data matching LongMemEval schema
    const mockData = {
      user_id: "user_1",
      sessions: [
        {
          session_id: "s1",
          messages: [
            { role: "user", content: "My name is Alice" },
            { role: "assistant", content: "Nice to meet you, Alice!" },
          ],
        },
      ],
      questions: [
        {
          question_id: "q1",
          question: "What is the user's name?",
          answer: "Alice",
          category: "information_extraction",
        },
      ],
    };

    const parsed = parseLongMemEvalData(mockData);
    assert.ok(parsed.turns.length > 0);
    assert.strictEqual(parsed.questions.length, 1);
    assert.strictEqual(parsed.questions[0].goldAnswer, "Alice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/benchmark-longmemeval-adapter.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement LongMemEval adapter**

```typescript
// benchmark/adapters/longmemeval-adapter.ts

import OpenAI from "openai";
import type { BenchmarkMemory } from "../datasets/types.js";

// ============================================================================
// LongMemEval Data Types
// ============================================================================

export interface LongMemEvalSession {
  session_id: string;
  messages: Array<{ role: string; content: string }>;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  answer: string;
  category: string;
}

export interface LongMemEvalUser {
  user_id: string;
  sessions: LongMemEvalSession[];
  questions: LongMemEvalQuestion[];
}

export interface ParsedLongMemEval {
  userId: string;
  turns: Array<{ speaker: string; text: string; turnIndex: number; sessionId: string }>;
  questions: Array<{
    id: string;
    text: string;
    goldAnswer: string;
    category: string;
  }>;
}

// ============================================================================
// Data Parsing
// ============================================================================

export function parseLongMemEvalData(data: LongMemEvalUser): ParsedLongMemEval {
  const turns: ParsedLongMemEval["turns"] = [];
  let turnIndex = 0;

  for (const session of data.sessions) {
    for (const msg of session.messages) {
      turns.push({
        speaker: msg.role,
        text: msg.content,
        turnIndex: turnIndex++,
        sessionId: session.session_id,
      });
    }
  }

  const questions = data.questions.map((q) => ({
    id: q.question_id,
    text: q.question,
    goldAnswer: q.answer,
    category: q.category,
  }));

  return { userId: data.user_id, turns, questions };
}

// ============================================================================
// Fact Extraction (reuses LoCoMo extraction prompt)
// ============================================================================

const EXTRACTION_PROMPT = `Extract ALL factual information from this conversation turn.
Return each fact on its own numbered line.
Preserve the original wording as much as possible.
Include: names, preferences, locations, dates, decisions, relationships, opinions.
If no factual information is present, return "NONE".`;

export async function extractFactsFromTurn(
  turn: { speaker: string; text: string; turnIndex: number },
  client: OpenAI,
  model = "gpt-4o-mini",
): Promise<Array<{ text: string; turnIndex: number }>> {
  // Skip assistant turns — they don't contain user facts
  if (turn.speaker === "assistant") return [];

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: `[Turn ${turn.turnIndex}] ${turn.speaker}: ${turn.text}` },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (content === "NONE" || !content) return [];

  return content
    .split("\n")
    .map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "NONE")
    .map((text) => ({ text, turnIndex: turn.turnIndex }));
}

export function factsToMemories(
  facts: Array<{ text: string; turnIndex: number }>,
  userId: string,
): BenchmarkMemory[] {
  return facts.map((fact, i) => ({
    id: `${userId}-fact-${i}`,
    text: fact.text,
    category: "fact" as const,
    scope: "global",
    importance: 0.7,
    ageDays: -(facts.length - i),
    tags: [`turn:${fact.turnIndex}`],
  }));
}
```

- [ ] **Step 4: Add LongMemEval to run.ts**

Add to `benchmark/run.ts`:

```typescript
import {
  parseLongMemEvalData,
  extractFactsFromTurn,
  factsToMemories as lmeFacts,
  type LongMemEvalUser,
} from "./adapters/longmemeval-adapter.js";
import { generateAnswer } from "./adapters/locomo-adapter.js";

async function runLongMemEvalBenchmark(runners: BenchmarkRunner[]): Promise<ScoreRow[]> {
  const dataPath = join(import.meta.dirname ?? ".", "data", "longmemeval_s.json");
  if (!existsSync(dataPath)) {
    console.error(`LongMemEval data not found at ${dataPath}`);
    console.error("Download from: https://huggingface.co/datasets/xiaowu0162/LongMemEval");
    process.exit(1);
  }

  const rawData: LongMemEvalUser[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const llmClient = new OpenAI({ apiKey: LLM_API_KEY });
  const scores: ScoreRow[] = [];

  for (const runner of runners) {
    console.log(`\n=== Runner: ${runner.name} (LongMemEval) ===`);

    let totalCorrect = 0;
    let totalF1 = 0;
    let totalQueries = 0;

    for (const userData of rawData) {
      const parsed = parseLongMemEvalData(userData);
      console.log(`  Processing user ${parsed.userId} (${parsed.turns.length} turns, ${parsed.questions.length} questions)...`);

      // Extract facts
      const allFacts: Array<{ text: string; turnIndex: number }> = [];
      for (const turn of parsed.turns) {
        const facts = await extractFactsFromTurn(turn, llmClient, LLM_MODEL);
        allFacts.push(...facts);
      }
      console.log(`    Extracted ${allFacts.length} facts`);

      // Seed
      const memories = lmeFacts(allFacts, parsed.userId);
      await runner.seed(memories);

      // Run questions
      for (const q of parsed.questions) {
        const results = await runner.query({
          id: q.id,
          text: q.text,
          relevantMemoryIds: [],
          intent: "semantic",
          goldAnswer: q.goldAnswer,
        });

        const memoryTexts = results.map((r) => {
          const mem = memories.find((m) => m.id === r.id);
          return { text: mem?.text ?? "", score: r.score };
        });

        const predicted = await generateAnswer(memoryTexts, q.text, llmClient, LLM_MODEL);
        const judgment = await llmJudge(q.text, predicted, q.goldAnswer, llmClient, LLM_MODEL);
        const f1 = tokenF1(predicted, q.goldAnswer);

        if (judgment.correct) totalCorrect++;
        totalF1 += f1;
        totalQueries++;
      }

      await runner.teardown();
    }

    const latency = computePercentiles(runner.timings.queryMs);
    scores.push({
      runner: runner.name,
      overall: {
        recallAt5: 0,
        mrr: 0,
        ndcgAt5: 0,
        llmJudgeAccuracy: totalQueries > 0 ? totalCorrect / totalQueries : 0,
        f1: totalQueries > 0 ? totalF1 / totalQueries : 0,
      },
      performance: latency,
    });

    console.log(
      `  Results: LLM-Judge=${(totalCorrect / totalQueries).toFixed(3)}, ` +
      `F1=${(totalF1 / totalQueries).toFixed(3)}, Queries=${totalQueries}`,
    );
  }

  return scores;
}
```

Update `main()` to support `--benchmark longmemeval`:

```typescript
// In main(), replace the single benchmark call with:
let scores: ScoreRow[];
if (args.benchmark === "longmemeval") {
  scores = await runLongMemEvalBenchmark(runners);
} else {
  scores = await runLoComoBenchmark(runners);
}
```

- [ ] **Step 5: Add data download instructions to .gitignore**

Append to `.gitignore`:
```
benchmark/data/longmemeval_s.json
```

- [ ] **Step 6: Update package.json bench scripts**

Add to `scripts`:
```json
"bench:longmemeval": "jiti benchmark/run.ts --benchmark longmemeval"
```

- [ ] **Step 7: Run test**

Run: `node --test test/benchmark-longmemeval-adapter.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add benchmark/adapters/longmemeval-adapter.ts benchmark/run.ts test/benchmark-longmemeval-adapter.test.mjs package.json .gitignore
git commit -m "feat(bench): add LongMemEval adapter and benchmark integration

500 questions across 5 memory abilities (extraction, reasoning,
temporal, knowledge updates, abstention). Uses LongMemEval_s (115K tokens).
Download from HuggingFace: xiaowu0162/LongMemEval"
```

---

## Summary

| Task | Description | Files | Estimated Steps |
|------|-------------|-------|-----------------|
| 1 | P0 code fixes (limit cap + fusion naming) | store.ts, retriever.ts | 8 |
| 2 | P1 fallback event logging | retrieval-trace.ts, retriever.ts | 5 |
| 3 | Dataset types + profile config | benchmark/datasets/, benchmark/profiles/ | 6 |
| 4 | Runner interface + implementations | benchmark/runners/ | 7 |
| 5 | Retrieval + performance metrics | benchmark/metrics/ | 6 |
| 6 | End-to-end metrics (LLM-Judge + F1) | benchmark/metrics/end-to-end.ts | 5 |
| 7 | LoCoMo adapter | benchmark/adapters/ | 5 |
| 8 | Report generators | benchmark/report/ | 7 |
| 9 | Entry point + package integration | benchmark/run.ts, package.json | 5 |
| 10 | LoCoMo data loader + full integration | benchmark/run.ts | 4 |
| 11 | LongMemEval adapter + integration | benchmark/adapters/, benchmark/run.ts | 8 |

**Total: 11 tasks, ~66 steps**

Dependencies: Task 1 → Tasks 4,5. Task 2 → Task 4. Task 3 → Tasks 4,7. Tasks 4,5,6,7 → Task 9. Task 8 → Task 9. Task 9 → Task 10. Task 10 → Task 11 (shares adapter patterns and run.ts integration).
