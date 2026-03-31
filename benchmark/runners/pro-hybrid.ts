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

export class ProHybridRunner implements BenchmarkRunner {
  readonly name = "pro-hybrid";
  timings: RunnerTimings = { seedMs: [], queryMs: [] };
  fallbackEvents: FallbackEvent[] = [];

  private config: RunnerConfig;
  private dbPath: string;
  private store: MemoryStore | null = null;
  private embedder: ReturnType<typeof createEmbedder> | null = null;
  private retriever: ReturnType<typeof createRetriever> | null = null;

  constructor(config: RunnerConfig) {
    this.config = config;
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

    // Merge rerank config into profile
    const profileWithRerank = {
      ...MAX_RECALL_PROFILE,
      rerankApiKey: this.config.rerankApiKey,
      rerankModel: this.config.rerankModel,
      rerankEndpoint: this.config.rerankEndpoint,
    };

    this.retriever = createRetriever(
      this.store,
      this.embedder,
      profileWithRerank,
      {
        decayEngine: null, // Intentionally disabled for benchmark
      },
    );

    // Embed and import each memory, preserving timestamps
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
