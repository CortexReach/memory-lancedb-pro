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
  provider: "openai-compatible" | "azure-openai";
  apiVersion?: string;
  /** Single API key or array of keys for round-robin rotation with failover. */
  apiKey: string | string[];
  model: string;
  baseURL?: string;
  dimensions?: number;

  /** Optional task type for query embeddings (e.g. "retrieval.query") */
  taskQuery?: string;
  /** Optional task type for passage/document embeddings (e.g. "retrieval.passage") */
  taskPassage?: string;
  /** Optional flag to request normalized embeddings (provider-dependent, e.g. Jina v5) */
  normalized?: boolean;
  /** When true, omit the dimensions parameter from embedding requests even if dimensions is set.
   *  Use this for local models that reject the dimensions parameter with "matryoshka representation" errors. */
  omitDimensions?: boolean;
  /** Enable automatic chunking for documents exceeding context limits (default: true) */
  chunking?: boolean;
}

type EmbeddingProviderProfile =
  | "openai"
  | "azure-openai"
  | "jina"
  | "voyage-compatible"
  | "nvidia"
  | "generic-openai-compatible";

interface EmbeddingCapabilities {
  /** Whether to send encoding_format: "float" */
  encoding_format: boolean;
  /** Whether to send normalized (Jina-style) */
  normalized: boolean;
  /**
   * Field name to use for the task/input-type hint, or null if unsupported.
   * e.g. "task" for Jina, "input_type" for Voyage, null for OpenAI/generic.
   * If a taskValueMap is provided, task values are translated before sending.
   */
  taskField: string | null;
  /** Optional value translation map for taskField (e.g. Voyage needs "retrieval.query" → "query") */
  taskValueMap?: Record<string, string>;
  /**
   * Field name to use for the requested output dimension, or null if unsupported.
   * e.g. "dimensions" for OpenAI, "output_dimension" for Voyage, null if not supported.
   */
  dimensionsField: string | null;
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

  // Voyage recommended models
  "voyage-4": 1024,
  "voyage-4-lite": 1024,
  "voyage-4-large": 1024,

  // Voyage legacy models
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-3-large": 1024,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, any>;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (err.error && typeof err.error === "object") {
    if (typeof err.error.status === "number") return err.error.status;
    if (typeof err.error.statusCode === "number") return err.error.statusCode;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, any>;
  if (typeof err.code === "string") return err.code;
  if (err.error && typeof err.error === "object" && typeof err.error.code === "string") {
    return err.error.code;
  }
  return undefined;
}

function getProviderLabel(baseURL: string | undefined, model: string): string {
  const profile = detectEmbeddingProviderProfile(baseURL, model);
  const base = baseURL || "";

  if (/localhost:11434|127\.0\.0\.1:11434|\/ollama\b/i.test(base)) return "Ollama";

  if (base) {
    if (profile === "jina" && /api\.jina\.ai/i.test(base)) return "Jina";
    if (profile === "voyage-compatible" && /api\.voyageai\.com/i.test(base)) return "Voyage";
    if (profile === "openai" && /api\.openai\.com/i.test(base)) return "OpenAI";
    if (profile === "azure-openai" || /\.openai\.azure\.com/i.test(base)) return "Azure OpenAI";
    if (profile === "nvidia") return "NVIDIA NIM";

    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  }

  switch (profile) {
    case "jina":
      return "Jina";
    case "voyage-compatible":
      return "Voyage";
    case "openai":
    case "azure-openai":
      return "OpenAI";
    case "nvidia":
      return "NVIDIA NIM";
    default:
      return "embedding provider";
  }
}

function detectEmbeddingProviderProfile(
  baseURL: string | undefined,
  model: string,
): EmbeddingProviderProfile {
  const base = baseURL || "";
  let host = "";
  try { host = new URL(base).hostname.toLowerCase(); } catch { /* invalid URL — skip host checks */ }

  // Host-based detection runs first — endpoint owner semantics take precedence
  // over model-name heuristics to avoid misclassifying e.g. a jina-xxx model
  // served from .nvidia.com as Jina instead of NVIDIA.
  // Match on parsed hostname to avoid false positives from proxy URLs that
  // contain provider domains in their path or query string.
  if (host.endsWith("api.openai.com")) return "openai";
  if (host.endsWith(".openai.azure.com")) return "azure-openai";
  if (host.endsWith("api.jina.ai")) return "jina";
  if (host.endsWith("api.voyageai.com")) return "voyage-compatible";
  if (host.endsWith(".nvidia.com") || host === "nvidia.com") return "nvidia";

  // Model-prefix fallback — only when baseURL didn't match a known host
  if (/^jina-/i.test(model)) return "jina";
  if (/^voyage\b/i.test(model)) return "voyage-compatible";
  if (/^nvidia\//i.test(model) || /^nv-embed/i.test(model)) return "nvidia";

  return "generic-openai-compatible";
}

function getEmbeddingCapabilities(profile: EmbeddingProviderProfile): EmbeddingCapabilities {
  switch (profile) {
    case "openai":
      return {
        encoding_format: true,
        normalized: false,
        taskField: null,
        dimensionsField: "dimensions",
      };
    case "jina":
      return {
        encoding_format: true,
        normalized: true,
        taskField: "task",
        dimensionsField: "dimensions",
      };
    case "voyage-compatible":
      return {
        encoding_format: false,
        normalized: false,
        taskField: "input_type",
        taskValueMap: {
          "retrieval.query": "query",
          "retrieval.passage": "document",
          "query": "query",
          "document": "document",
        },
        dimensionsField: "output_dimension",
      };
    case "nvidia":
      return {
        encoding_format: true,
        normalized: false,
        taskField: "input_type",
        taskValueMap: {
          "retrieval.query": "query",
          "retrieval.passage": "passage",
          "query": "query",
          "passage": "passage",
        },
        dimensionsField: "dimensions",
      };
    case "generic-openai-compatible":
    default:
      return {
        encoding_format: true,
        normalized: false,
        taskField: null,
        dimensionsField: "dimensions",
      };
  }
}

function isAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;

  const code = getErrorCode(error);
  if (code && /invalid.*key|auth|forbidden|unauthorized/i.test(code)) return true;

  const msg = getErrorMessage(error);
  return /\b401\b|\b403\b|invalid api key|api key expired|expired api key|forbidden|unauthorized|authentication failed|access denied/i.test(msg);
}

function isNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(code)) {
    return true;
  }

  const msg = getErrorMessage(error);
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|network error|socket hang up|connection refused|getaddrinfo/i.test(msg);
}

export function formatEmbeddingProviderError(
  error: unknown,
  opts: { baseURL?: string; model: string; mode?: "single" | "batch" },
): string {
  const raw = getErrorMessage(error).trim();
  if (
    raw.startsWith("Embedding provider authentication failed") ||
    raw.startsWith("Embedding provider unreachable") ||
    raw.startsWith("Failed to generate embedding from ") ||
    raw.startsWith("Failed to generate batch embeddings from ")
  ) {
    return raw;
  }

  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const provider = getProviderLabel(opts.baseURL, opts.model);
  const detail = raw.length > 0 ? raw : "unknown error";
  const suffix = [status, code].filter(Boolean).join(" ");
  const detailText = suffix ? `${suffix}: ${detail}` : detail;
  const genericPrefix =
    opts.mode === "batch"
      ? `Failed to generate batch embeddings from ${provider}: `
      : `Failed to generate embedding from ${provider}: `;

  if (isAuthError(error)) {
    let hint = `Check embedding.apiKey and endpoint for ${provider}.`;
    // Use profile rather than provider label so Jina-specific hint also fires
    // when model is jina-* but baseURL is a proxy (not api.jina.ai).
    const profile = detectEmbeddingProviderProfile(opts.baseURL, opts.model);
    if (profile === "jina") {
      hint +=
        " If your Jina key expired or lost access, replace the key or switch to a local OpenAI-compatible endpoint such as Ollama (for example baseURL http://127.0.0.1:11434/v1, with a matching model and embedding.dimensions).";
    } else if (provider === "Ollama") {
      hint +=
        " Ollama usually works with a dummy apiKey; verify the local server is running, the model is pulled, and embedding.dimensions matches the model output.";
    }
    return `Embedding provider authentication failed (${detailText}). ${hint}`;
  }

  if (isNetworkError(error)) {
    let hint = `Verify the endpoint is reachable`;
    if (opts.baseURL) {
      hint += ` at ${opts.baseURL}`;
    }
    hint += ` and that model \"${opts.model}\" is available.`;
    return `Embedding provider unreachable (${detailText}). ${hint}`;
  }

  return `${genericPrefix}${detailText}`;
}

// ============================================================================
// Safety Constants
// ============================================================================

/** Maximum recursion depth for embedSingle chunking retries. */
const MAX_EMBED_DEPTH = 3;

/** Global timeout for a single embedding operation (ms). */
const EMBED_TIMEOUT_MS = 10_000;

/**
 * Strictly decreasing character limit for forced truncation.
 * Each recursion level MUST reduce input by this factor to guarantee progress.
 */
const STRICT_REDUCTION_FACTOR = 0.5; // Each retry must be at most 50% of previous

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
  /** Pool of OpenAI clients — one per API key for round-robin rotation. */
  private clients: OpenAI[];
  /** Round-robin index for client rotation. */
  private _clientIndex: number = 0;

  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;

  private readonly _model: string;
  private readonly _baseURL?: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;
  private readonly _capabilities: EmbeddingCapabilities;

  /** Optional requested dimensions to pass through to the embedding provider (OpenAI-compatible). */
  private readonly _requestDimensions?: number;
  /** When true, omit the dimensions parameter even if _requestDimensions is set. */
  private readonly _omitDimensions: boolean;
  /** Enable automatic chunking for long documents (default: true) */
  private readonly _autoChunk: boolean;

  constructor(config: EmbeddingConfig & { chunking?: boolean }) {
    // Normalize apiKey to array and resolve environment variables
    const apiKeys = Array.isArray(config.apiKey) ? config.apiKey : [config.apiKey];
    const resolvedKeys = apiKeys.map(k => resolveEnvVars(k));

    this._model = config.model;
    this._baseURL = config.baseURL;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;
    this._omitDimensions = config.omitDimensions === true;
    // Enable auto-chunking by default for better handling of long documents
    this._autoChunk = config.chunking !== false;
    const profile = detectEmbeddingProviderProfile(this._baseURL, this._model);
    this._capabilities = getEmbeddingCapabilities(profile);

    // Warn if configured fields will be silently ignored by this provider profile
    if (config.normalized !== undefined && !this._capabilities.normalized) {
      console.debug(
        `[memory-lancedb-pro] embedding.normalized is set but provider profile "${profile}" does not support it — value will be ignored`
      );
    }
    if ((config.taskQuery || config.taskPassage) && !this._capabilities.taskField) {
      console.debug(
        `[memory-lancedb-pro] embedding.taskQuery/taskPassage is set but provider profile "${profile}" does not support task hints — values will be ignored`
      );
    }

    // Create a client pool — one OpenAI client per key
    this.clients = resolvedKeys.map(key => {
      let defaultHeaders: Record<string, string> = {};
      let baseURL = config.baseURL;

      if (config.provider === "azure-openai" || profile === "azure-openai") {
        defaultHeaders["api-key"] = key;
        if (baseURL && config.apiVersion) {
          const url = new URL(baseURL);
          url.searchParams.set("api-version", config.apiVersion);
          baseURL = url.toString();
        }
      }

      return new OpenAI({
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
      });
    });

    if (this.clients.length > 1) {
      console.log(`[memory-lancedb-pro] Initialized ${this.clients.length} API keys for round-robin rotation`);
    }

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    this._cache = new EmbeddingCache(256, 30); // 256 entries, 30 min TTL
  }

  // --------------------------------------------------------------------------
  // Multi-key rotation helpers
  // --------------------------------------------------------------------------

  /** Return the next client in round-robin order. */
  private nextClient(): OpenAI {
    const client = this.clients[this._clientIndex % this.clients.length];
    this._clientIndex = (this._clientIndex + 1) % this.clients.length;
    return client;
  }

  /** Check whether an error is a rate-limit / quota-exceeded / overload error. */
  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    const err = error as Record<string, any>;

    // HTTP status: 429 (rate limit) or 503 (service overload)
    if (err.status === 429 || err.status === 503) return true;

    // OpenAI SDK structured error code
    if (err.code === "rate_limit_exceeded" || err.code === "insufficient_quota") return true;

    // Nested error object (some providers)
    const nested = err.error;
    if (nested && typeof nested === "object") {
      if (nested.type === "rate_limit_exceeded" || nested.type === "insufficient_quota") return true;
      if (nested.code === "rate_limit_exceeded" || nested.code === "insufficient_quota") return true;
    }

    // Fallback: message text matching
    const msg = error instanceof Error ? error.message : String(error);
    return /rate.limit|quota|too many requests|insufficient.*credit|429|503.*overload/i.test(msg);
  }

  /**
   * Detect if the configured baseURL points to a local Ollama instance.
   * Ollama's HTTP server does not properly handle AbortController signals through
   * the OpenAI SDK's HTTP client, causing long-lived sockets that don't close
   * when the embedding pipeline times out. For Ollama we use native fetch instead.
   */
  private isOllamaProvider(): boolean {
    if (!this._baseURL) return false;
    return /localhost:11434|127\.0\.0\.1:11434|\/ollama\b/i.test(this._baseURL);
  }

  /**
   * Call embeddings.create using native fetch (bypasses OpenAI SDK).
   * Used exclusively for Ollama endpoints where AbortController must work
   * correctly to avoid long-lived stalled sockets.
   */
  private async embedWithNativeFetch(payload: any, signal?: AbortSignal): Promise<any> {
    if (!this._baseURL) {
      throw new Error("embedWithNativeFetch requires a baseURL");
    }
    // Ollama's embeddings endpoint is at /v1/embeddings (OpenAI-compatible)
    const endpoint = this._baseURL.replace(/\/$/, "") + "/embeddings";

    const apiKey = this.clients[0]?.apiKey ?? "ollama";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText} ??${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return data; // OpenAI-compatible shape: { data: [{ embedding: number[] }] }
  }

  /**
   * Call embeddings.create with automatic key rotation on rate-limit errors.
   * Tries each key in the pool at most once before giving up.
   * Accepts an optional AbortSignal to support true request cancellation.
   *
   * For Ollama endpoints, native fetch is used instead of the OpenAI SDK
   * because AbortController does not reliably abort Ollama's HTTP connections
   * through the SDK's HTTP client on Node.js.
   */
  private async embedWithRetry(payload: any, signal?: AbortSignal): Promise<any> {
    // Use native fetch for Ollama to ensure proper AbortController support
    if (this.isOllamaProvider()) {
      try {
        return await this.embedWithNativeFetch(payload, signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        // Ollama errors bubble up without retry (Ollama doesn't rate-limit locally)
        throw error;
      }
    }

    const maxAttempts = this.clients.length;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = this.nextClient();
      try {
        // Pass signal to OpenAI SDK if provided (SDK v6+ supports this)
        return await client.embeddings.create(payload, signal ? { signal } : undefined);
      } catch (error) {
        // If aborted, re-throw immediately
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.isRateLimitError(error) && attempt < maxAttempts - 1) {
          console.log(
            `[memory-lancedb-pro] Attempt ${attempt + 1}/${maxAttempts} hit rate limit, rotating to next key...`
          );
          continue;
        }

        // Non-rate-limit error → don't retry, let caller handle (e.g. chunking)
        if (!this.isRateLimitError(error)) {
          throw error;
        }
      }
    }

    // All keys exhausted with rate-limit errors
    throw new Error(
      `All ${maxAttempts} API keys exhausted (rate limited). Last error: ${lastError?.message || "unknown"}`,
      { cause: lastError }
    );
  }

  /** Number of API keys in the rotation pool. */
  get keyCount(): number {
    return this.clients.length;
  }

  /** Wrap a single embedding operation with a global timeout via AbortSignal. */
  private withTimeout<T>(promiseFactory: (signal: AbortSignal) => Promise<T>, _label: string, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    // If caller passes an external signal, merge it with the internal timeout controller.
    // Either signal aborting will cancel the promise.
    let unsubscribe: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        return Promise.reject(externalSignal.reason ?? new Error("aborted"));
      }
      const handler = () => {
        controller.abort();
        clearTimeout(timeoutId);
      };
      externalSignal.addEventListener("abort", handler, { once: true });
      unsubscribe = () => externalSignal.removeEventListener("abort", handler);
    }

    return promiseFactory(controller.signal).finally(() => {
      clearTimeout(timeoutId);
      unsubscribe?.();
    });
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

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.withTimeout((sig) => this.embedSingle(text, this._taskQuery, 0, sig), "embedQuery", signal);
  }

  async embedPassage(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.withTimeout((sig) => this.embedSingle(text, this._taskPassage, 0, sig), "embedPassage", signal);
  }

  // Note: embedBatchQuery/embedBatchPassage are NOT wrapped with withTimeout because
  // they handle multiple texts in a single API call. The timeout would fire after
  // EMBED_TIMEOUT_MS regardless of how many texts succeed. Individual text embedding
  // within the batch is protected by the SDK's own timeout handling.
  async embedBatchQuery(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embedMany(texts, this._taskQuery, signal);
  }

  async embedBatchPassage(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embedMany(texts, this._taskPassage, signal);
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
    };

    if (this._capabilities.encoding_format) {
      // Force float output where providers explicitly support OpenAI-style formatting.
      payload.encoding_format = "float";
    }

    if (this._capabilities.normalized && this._normalized !== undefined) {
      payload.normalized = this._normalized;
    }

    // Task hint: only injected when BOTH the provider profile defines a taskField
    // AND the caller passes a task value (from user-configured taskQuery/taskPassage).
    // This means broad provider detection (e.g. any .nvidia.com host) is safe —
    // non-retriever models that don't expect input_type are unaffected unless the
    // user explicitly configures task hints.
    if (this._capabilities.taskField && task) {
      const cap = this._capabilities;
      const value = cap.taskValueMap?.[task] ?? task;
      payload[cap.taskField] = value;
    }

    // Output dimension: field name is provider-defined.
    // Only sent when explicitly configured, unless omitDimensions is enabled for
    // local or provider-compatible models that reject the dimensions field.
    if (!this._omitDimensions && this._capabilities.dimensionsField && this._requestDimensions && this._requestDimensions > 0) {
      payload[this._capabilities.dimensionsField] = this._requestDimensions;
    }

    return payload;
  }

  private async embedSingle(text: string, task?: string, depth: number = 0, signal?: AbortSignal): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    // FR-01: Recursion depth limit — force truncate when too deep
    if (depth >= MAX_EMBED_DEPTH) {
      const safeLimit = Math.floor(text.length * STRICT_REDUCTION_FACTOR);
      console.warn(
        `[memory-lancedb-pro] Recursion depth ${depth} reached MAX_EMBED_DEPTH (${MAX_EMBED_DEPTH}), ` +
        `force-truncating ${text.length} chars → ${safeLimit} chars (strict ${STRICT_REDUCTION_FACTOR * 100}% reduction)`
      );
      if (safeLimit < 100) {
        throw new Error(
          `[memory-lancedb-pro] Failed to embed: input too large for model context after ${MAX_EMBED_DEPTH} retries`
        );
      }
      text = text.slice(0, safeLimit);
    }

    // Check cache first
    const cached = this._cache.get(text, task);
    if (cached) return cached;

    try {
      const response = await this.embedWithRetry(this.buildPayload(text, task), signal);
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

          // FR-03: Single chunk output detection — if smartChunk produced only
          // one chunk that is nearly the same size as the original text, chunking
          // did not actually reduce the problem. Force-truncate with STRICT
          // reduction to guarantee progress.
          if (
            chunkResult.chunks.length === 1 &&
            chunkResult.chunks[0].length > text.length * 0.9
          ) {
            // Use strict reduction factor to guarantee each retry makes progress
            const safeLimit = Math.floor(text.length * STRICT_REDUCTION_FACTOR);
            console.warn(
              `[memory-lancedb-pro] smartChunk produced 1 chunk (${chunkResult.chunks[0].length} chars) ≈ original (${text.length} chars). ` +
              `Force-truncating to ${safeLimit} chars (strict ${STRICT_REDUCTION_FACTOR * 100}% reduction) to avoid infinite recursion.`
            );
            if (safeLimit < 100) {
              throw new Error(
                `[memory-lancedb-pro] Failed to embed: chunking couldn't reduce input size enough for model context`
              );
            }
            const truncated = text.slice(0, safeLimit);
            return this.embedSingle(truncated, task, depth + 1, signal);
          }

          // Embed all chunks in parallel
          console.log(`Split document into ${chunkResult.chunkCount} chunks for embedding`);
          const chunkEmbeddings = await Promise.all(
            chunkResult.chunks.map(async (chunk, idx) => {
              try {
                const embedding = await this.embedSingle(chunk, task, depth + 1, signal);
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
          // Preserve and surface the more specific chunkError
          console.warn(`Chunking failed:`, chunkError);
          throw chunkError;
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "single",
      });
      throw new Error(friendly, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async embedMany(texts: string[], task?: string, signal?: AbortSignal): Promise<number[][]> {
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
      const response = await this.embedWithRetry(
        this.buildPayload(validTexts, task),
        signal,
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
                chunkResult.chunks.map((chunk) => this.embedSingle(chunk, task, 0, signal))
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
          const friendly = formatEmbeddingProviderError(error, {
            baseURL: this._baseURL,
            model: this._model,
            mode: "batch",
          });
          throw new Error(`Failed to embed documents after chunking attempt: ${friendly}`, {
            cause: error instanceof Error ? error : undefined,
          });
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "batch",
      });
      throw new Error(friendly, {
        cause: error instanceof Error ? error : undefined,
      });
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
    return {
      ...this._cache.stats,
      keyCount: this.clients.length,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}
