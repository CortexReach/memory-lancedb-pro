/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers.
 *
 * Note: Some providers (e.g. Jina) support extra parameters like `task` and
 * `normalized` on the embeddings endpoint. The OpenAI SDK types do not include
 * these fields, so we pass them via a narrow `any` cast.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

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
  /** Optional max chars per embedding input; protects small local embedding servers. */
  maxInputChars?: number;
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
  "all-mpnet-base-v2": 768,

  // Jina v5
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,
};

// ============================================================================
// Utility Functions
// ============================================================================

function defaultMaxInputChars(model: string): number | undefined {
  // Local llama.cpp embedding servers commonly run with small physical batch
  // sizes; nomic-embed-text in particular can reject prompts just over 512
  // tokens. Keep the default conservative for known local models while leaving
  // hosted/OpenAI models unconstrained unless configured.
  const normalized = model.toLowerCase();
  if (normalized.includes("nomic-embed-text")) return 1400;
  return undefined;
}

function truncateForEmbedding(text: string, maxChars?: number): string {
  const trimmed = text.trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 1) return trimmed.slice(0, maxChars);
  return trimmed.slice(0, maxChars - 1).trimEnd() + "…";
}

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
  private readonly _maxInputChars?: number;

  constructor(config: EmbeddingConfig) {
    // Resolve environment variables in API key
    const resolvedApiKey = resolveEnvVars(config.apiKey);

    this._model = config.model;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;
    this._maxInputChars = typeof config.maxInputChars === "number" && config.maxInputChars > 0
      ? Math.floor(config.maxInputChars)
      : defaultMaxInputChars(config.model);

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
    const safeInput = Array.isArray(input)
      ? input.map((item) => truncateForEmbedding(item, this._maxInputChars))
      : truncateForEmbedding(input, this._maxInputChars);

    const payload: any = {
      model: this.model,
      input: safeInput,
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
    const inputText = truncateForEmbedding(text, this._maxInputChars);

    const cached = this._cache.get(inputText, task);
    if (cached) return cached;

    try {
      const response = await this.client.embeddings.create(this.buildPayload(inputText, task) as any);
      const embedding = response.data[0]?.embedding as number[] | undefined;
      if (!embedding) {
        throw new Error("No embedding returned from provider");
      }

      this.validateEmbedding(embedding);
      this._cache.set(inputText, task, embedding);
      return embedding;
    } catch (error) {
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
