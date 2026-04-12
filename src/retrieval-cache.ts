/**
 * Retrieval Cache Layer
 * Caches retrieval results to reduce duplicate queries and improve performance
 */

import type { RetrievalResult } from "./retriever.js";

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  results: RetrievalResult[];
  timestamp: number;
  ttlMs: number;
}

export interface RetrievalCacheConfig {
  /** Default TTL in milliseconds (default: 5 minutes) */
  defaultTtlMs: number;
  /** Maximum number of cached entries (default: 1000) */
  maxEntries: number;
  /** Cleanup interval in milliseconds (default: 1 minute) */
  cleanupIntervalMs: number;
}

export const DEFAULT_CACHE_CONFIG: RetrievalCacheConfig = {
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  maxEntries: 1000,
  cleanupIntervalMs: 60 * 1000, // 1 minute
};

// ============================================================================
// Cache Key Builder
// ============================================================================

export interface CacheKeyParams {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
}

/**
 * Build a cache key from retrieval parameters
 * Ensures consistent hashing for identical queries
 */
export function buildCacheKey(params: CacheKeyParams): string {
  const parts = [
    params.query.toLowerCase().trim(),
    params.limit.toString(),
    params.scopeFilter ? params.scopeFilter.sort().join(",") : "*",
    params.category || "*",
  ];
  return parts.join("|");
}

// ============================================================================
// Retrieval Cache
// ============================================================================

export class RetrievalCache {
  private cache: Map<string, CacheEntry>;
  private config: RetrievalCacheConfig;
  private cleanupTimer?: NodeJS.Timeout;
  
  constructor(config: RetrievalCacheConfig = DEFAULT_CACHE_CONFIG) {
    this.cache = new Map();
    this.config = config;
    this.startCleanupTimer();
  }

  /**
   * Get cached results if available and not expired
   */
  get(key: string): RetrievalResult[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    const now = Date.now();
    if (now - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.results;
  }

  /**
   * Cache retrieval results with TTL
   */
  set(key: string, results: RetrievalResult[], ttlMs?: number): void {
    // Enforce max entries (LRU-style: remove oldest)
    if (this.cache.size >= this.config.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      results,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.config.defaultTtlMs,
    });
  }

  /**
   * Remove a specific cache entry
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxEntries: number;
    defaultTtlMs: number;
  } {
    return {
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
      defaultTtlMs: this.config.defaultTtlMs,
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let deleted = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const deleted = this.cleanup();
      if (deleted > 0) {
        console.log(`[RetrievalCache] Cleaned up ${deleted} expired entries`);
      }
    }, this.config.cleanupIntervalMs);

    // Prevent timer from keeping process alive
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop cleanup timer
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalCache: RetrievalCache | null = null;

/**
 * Get or create the global retrieval cache instance
 */
export function getGlobalCache(): RetrievalCache {
  if (!globalCache) {
    globalCache = new RetrievalCache(DEFAULT_CACHE_CONFIG);
  }
  return globalCache;
}

/**
 * Reset global cache (useful for testing)
 */
export function resetGlobalCache(): void {
  if (globalCache) {
    globalCache.stop();
    globalCache.clear();
    globalCache = null;
  }
}
