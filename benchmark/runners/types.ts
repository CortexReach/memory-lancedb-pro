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
  seedMs: number[];
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
    apiVersion?: string;
  };
  rerankApiKey?: string;
  rerankModel?: string;
  rerankEndpoint?: string;
  rerankProvider?: string;
}
