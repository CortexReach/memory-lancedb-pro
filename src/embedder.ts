/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers.
 * Supports automatic chunking for documents exceeding embedding context limits.
 *
 * Note: Some providers (e.g. Jina) support extra parameters like `task` and
 * `normalized` on the embeddings endpoint. The OpenAI SDK types do not include
 * these fields, so we pass them via a narrow `any` cast.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { smartChunk } from "./chunker.js";

// ============================================================================
// Embedding Cache (LRU with TTL)
// ============================================================================

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private key(text: string, task?: string): string {
    const hash = createHash("sha256").update(`${task || ""}:${text}`).digest("hex").slice(0, 24);
    return hash;
  }

  get(text: string, task?: string): number[] | undefined {
    const k = this.key(text, task);
    const entry = this.cache.get(k);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const k = this.key(text, task);
    // Evict oldest if full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get size(): number { return this.cache.size; }
  get stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: "openai-compatible";
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;

  /** Optional task type for query embeddings (e.g. "retrieval.query") */
  taskQuery?: string;
  /** Optional task type for passage/document embeddings (e.g. "retrieval.passage") */
  taskPassage?: string;
  /** Optional flag to request normalized embeddings (provider-dependent, e.g. Jina v5) */
  normalized?: boolean;
  /** Enable automatic chunking for documents exceeding context limits (default: true) */
  chunking?: boolean;
}

// Known embedding model dimensions
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "BAAI/bge-m3": 1024,
  "all-MiniLM-L6-v2": 384,
  "all-mpnet-base-v2": 512,

  // Jina v5
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,
};

// ============================================================================
// Utility Functions
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }

  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Either add it to EMBEDDING_DIMENSIONS or set embedding.dimensions in config.`
    );
  }

  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  private client: OpenAI;
  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;

  private readonly _model: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;

  /** Optional requested dimensions to pass through to the embedding provider (OpenAI-compatible). */
  private readonly _requestDimensions?: number;
  /** Enable automatic chunking for long documents (default: true) */
  private readonly _autoChunk: boolean;

  constructor(config: EmbeddingConfig & { chunking?: boolean }) {
    // Resolve environment variables in API key
    const resolvedApiKey = resolveEnvVars(config.apiKey);

    this._model = config.model;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;
    // Enable auto-chunking by default for better handling of long documents
    this._autoChunk = config.chunking !== false;

    this.client = new OpenAI({
      apiKey: resolvedApiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    this._cache = new EmbeddingCache(256, 30); // 256 entries, 30 min TTL
  }

  // --------------------------------------------------------------------------
  // Backward-compatible API
  // --------------------------------------------------------------------------

  /**
   * Backward-compatible embedding API.
   *
   * Historically the plugin used a single `embed()` method for both query and
   * passage embeddings. With task-aware providers we treat this as passage.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedPassage(text);
  }

  /** Backward-compatible batch embedding API (treated as passage). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedBatchPassage(texts);
  }

  // --------------------------------------------------------------------------
  // Task-aware API
  // --------------------------------------------------------------------------

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskQuery);
  }

  async embedPassage(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskPassage);
  }

  async embedBatchQuery(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskQuery);
  }

  async embedBatchPassage(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskPassage);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private validateEmbedding(embedding: number[]): void {
    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding is not an array (got ${typeof embedding})`);
    }
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }
  }

  private buildPayload(input: string | string[], task?: string): any {
    const payload: any = {
      model: this.model,
      input,
      // Force float output to avoid SDK default base64 decoding path.
      encoding_format: "float",
    };

    if (task) payload.task = task;
    if (this._normalized !== undefined) payload.normalized = this._normalized;

    // Some OpenAI-compatible providers support requesting a specific vector size.
    // We only pass it through when explicitly configured to avoid breaking providers
    // that reject unknown fields.
    if (this._requestDimensions && this._requestDimensions > 0) {
      payload.dimensions = this._requestDimensions;
    }

    return payload;
  }

  private async embedSingle(text: string, task?: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    // Check cache first
    const cached = this._cache.get(text, task);
    if (cached) return cached;

    try {
      const response = await this.client.embeddings.create(this.buildPayload(text, task) as any);
      const embedding = response.data[0]?.embedding as number[] | undefined;
      if (!embedding) {
        throw new Error("No embedding returned from provider");
      }

      this.validateEmbedding(embedding);
      this._cache.set(text, task, embedding);
      return embedding;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk) {
        try {
          console.log(`Document exceeded context limit (${errorMsg}), attempting chunking...`);
          const chunkResult = smartChunk(text, this._model);
          
          if (chunkResult.chunks.length === 0) {
            throw new Error(`Failed to chunk document: ${errorMsg}`);
          }

          // Embed all chunks in parallel
          console.log(`Split document into ${chunkResult.chunkCount} chunks for embedding`);
          const chunkEmbeddings = await Promise.all(
            chunkResult.chunks.map(async (chunk, idx) => {
              try {
                const embedding = await this.embedSingle(chunk, task);
                return { embedding };
              } catch (chunkError) {
                console.warn(`Failed to embed chunk ${idx}:`, chunkError);
                throw chunkError;
              }
            })
          );

          // Compute average embedding across chunks
          const avgEmbedding = chunkEmbeddings.reduce(
            (sum, { embedding }) => {
              for (let i = 0; i < embedding.length; i++) {
                sum[i] += embedding[i];
              }
              return sum;
            },
            new Array(this.dimensions).fill(0)
          );

          const finalEmbedding = avgEmbedding.map(v => v / chunkEmbeddings.length);
          
          // Cache the result for the original text (using its hash)
          this._cache.set(text, task, finalEmbedding);
          console.log(`Successfully embedded long document as ${chunkEmbeddings.length} averaged chunks`);
          
          return finalEmbedding;
        } catch (chunkError) {
          // If chunking fails, throw the original error
          console.warn(`Chunking failed, using original error:`, chunkError);
          throw new Error(`Failed to generate embedding: ${errorMsg}`, { cause: error });
        }
      }

      if (error instanceof Error) {
        throw new Error(`Failed to generate embedding: ${error.message}`, { cause: error });
      }
      throw new Error(`Failed to generate embedding: ${String(error)}`);
    }
  }

  private async embedMany(texts: string[], task?: string): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track indices
    const validTexts: string[] = [];
    const validIndices: number[] = [];

    texts.forEach((text, index) => {
      if (text && text.trim().length > 0) {
        validTexts.push(text);
        validIndices.push(index);
      }
    });

    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    try {
      const response = await this.client.embeddings.create(
        this.buildPayload(validTexts, task) as any
      );

      // Create result array with proper length
      const results: number[][] = new Array(texts.length);

      // Fill in embeddings for valid texts
      response.data.forEach((item, idx) => {
        const originalIndex = validIndices[idx];
        const embedding = item.embedding as number[];

        this.validateEmbedding(embedding);
        results[originalIndex] = embedding;
      });

      // Fill empty arrays for invalid texts
      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) {
          results[i] = [];
        }
      }

      return results;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking each text
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk) {
        try {
          console.log(`Batch embedding failed with context error, attempting chunking...`);
          
          const chunkResults = await Promise.all(
            validTexts.map(async (text, idx) => {
              const chunkResult = smartChunk(text, this._model);
              if (chunkResult.chunks.length === 0) {
                throw new Error("Chunker produced no chunks");
              }

              // Embed all chunks in parallel, then average.
              const embeddings = await Promise.all(
                chunkResult.chunks.map((chunk) => this.embedSingle(chunk, task))
              );

              const avgEmbedding = embeddings.reduce(
                (sum, emb) => {
                  for (let i = 0; i < emb.length; i++) {
                    sum[i] += emb[i];
                  }
                  return sum;
                },
                new Array(this.dimensions).fill(0)
              );

              const finalEmbedding = avgEmbedding.map((v) => v / embeddings.length);

              // Cache the averaged embedding for the original (long) text.
              this._cache.set(text, task, finalEmbedding);

              return { embedding: finalEmbedding, index: validIndices[idx] };
            })
          );

          console.log(`Successfully chunked and embedded ${chunkResults.length} long documents`);

          // Build results array
          const results: number[][] = new Array(texts.length);
          chunkResults.forEach(({ embedding, index }) => {
            if (embedding.length > 0) {
              this.validateEmbedding(embedding);
              results[index] = embedding;
            } else {
              results[index] = [];
            }
          });

          // Fill empty arrays for invalid texts
          for (let i = 0; i < texts.length; i++) {
            if (!results[i]) {
              results[i] = [];
            }
          }

          return results;
        } catch (chunkError) {
          throw new Error(`Failed to embed documents after chunking attempt: ${errorMsg}`);
        }
      }

      if (error instanceof Error) {
        throw new Error(`Failed to generate batch embeddings: ${error.message}`, { cause: error });
      }
      throw new Error(`Failed to generate batch embeddings: ${String(error)}`);
    }
  }

  get model(): string {
    return this._model;
  }

  // Test connection and validate configuration
  async test(): Promise<{ success: boolean; error?: string; dimensions?: number }> {
    try {
      const testEmbedding = await this.embedPassage("test");
      return {
        success: true,
        dimensions: testEmbedding.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  get cacheStats() {
    return this._cache.stats;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}
