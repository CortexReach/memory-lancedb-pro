import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { MemoryStore, validateStoragePath } from "../../src/store.js";
import { createEmbedder } from "../../src/embedder.js";
import { createRetriever } from "../../src/retriever.js";
import { MAX_RECALL_PROFILE } from "../profiles/max-recall.js";
import type { BenchmarkMemory, BenchmarkQuery } from "../datasets/types.js";
import type {
  BenchmarkRunner,
  QueryResult,
  FallbackEvent,
  RunnerTimings,
  RunnerConfig,
} from "./types.js";

export class ProVectorOnlyRunner implements BenchmarkRunner {
  readonly name = "pro-vector-only";
  timings: RunnerTimings = { seedMs: [], queryMs: [] };
  fallbackEvents: FallbackEvent[] = [];

  private config: RunnerConfig;
  private dbPath: string;
  private store: MemoryStore | null = null;
  private embedder: ReturnType<typeof createEmbedder> | null = null;
  private retriever: ReturnType<typeof createRetriever> | null = null;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.dbPath = join(tmpdir(), `bench-vector-only-${randomUUID()}`);
  }

  async seed(memories: BenchmarkMemory[]): Promise<void> {
    const start = Date.now();
    // Generate fresh dbPath for each seed to avoid stale state after teardown
    this.dbPath = join(tmpdir(), `bench-vector-only-${randomUUID()}`);
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

    const vectorOnlyProfile = {
      ...MAX_RECALL_PROFILE,
      mode: "vector" as const,
      rerank: "none" as const,
    };

    this.retriever = createRetriever(
      this.store,
      this.embedder,
      vectorOnlyProfile,
      {
        decayEngine: null,
      },
    );

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
