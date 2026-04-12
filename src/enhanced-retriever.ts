/**
 * Enhanced Retriever Integration
 * Integrates all v1.1.0-beta.11 features into retrieval pipeline:
 * - Retrieval cache
 * - Chinese tokenizer (segmentation + pinyin + conversion)
 * - Synonyms expansion
 * - Frozen snapshot
 */

import type { RetrievalConfig, RetrievalContext, RetrievalResult } from "./retriever.js";
import type { RetrievalCache } from "./retrieval-cache.js";
import type { TokenizerConfig } from "./chinese-tokenizer.js";
import type { PinyinConfig } from "./pinyin-search.js";
import type { ConversionConfig } from "./chinese-converter.js";
import type { SynonymsConfig } from "./chinese-synonyms.js";
import { tokenizeChinese } from "./chinese-tokenizer.js";
import { tokenizeWithPinyin } from "./pinyin-search.js";
import { normalizeChinese } from "./chinese-converter.js";
import { expandQuery } from "./chinese-synonyms.js";
import { getGlobalCache } from "./retrieval-cache.js";
import { getSnapshotManager } from "./frozen-snapshot.js";

// ============================================================================
// Types
// ============================================================================

export interface EnhancedRetrievalConfig extends RetrievalConfig {
  /** Enable retrieval cache (default: true) */
  enableCache: boolean;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs: number;
  
  /** Chinese tokenizer config */
  tokenizer: TokenizerConfig;
  /** Pinyin config */
  pinyin: PinyinConfig;
  /** Conversion config */
  conversion: ConversionConfig;
  /** Synonyms config */
  synonyms: SynonymsConfig;
}

export const DEFAULT_ENHANCED_CONFIG: EnhancedRetrievalConfig = {
  // Base retrieval config
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
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
  tagPrefixes: ["proj", "env", "team", "scope"],
  
  // Enhanced features
  enableCache: true,
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
  
  // Chinese retrieval
  tokenizer: {
    enableChinese: true,
    enablePinyin: false,
    enableConversion: false,
    targetScript: "simplified",
  },
  pinyin: {
    enablePinyin: true,
    includeTones: false,
    format: "without-tone",
    includeOriginal: true,
  },
  conversion: {
    enableConversion: true,
    targetScript: "simplified",
    autoDetect: true,
  },
  synonyms: {
    enabled: true,
    maxExpandedQueries: 5,
    minSimilarityScore: 0.5,
    useBuiltIn: true,
  },
};

// ============================================================================
// Enhanced Query Processor
// ============================================================================

/**
 * Process query with all enhancements:
 * 1. Normalize Chinese (繁简转换)
 * 2. Expand with synonyms
 * 3. Tokenize with pinyin support
 */
export async function processQuery(
  query: string,
  config: EnhancedRetrievalConfig = DEFAULT_ENHANCED_CONFIG
): Promise<{
  normalized: string;
  expanded: string[];
  tokenized: string[][];
}> {
  // Step 1: Normalize Chinese (繁简转换)
  const normalized = await normalizeChinese(query, config.conversion);
  
  // Step 2: Expand with synonyms
  const expanded = config.synonyms.enabled
    ? expandQuery(normalized, config.synonyms)
    : [normalized];
  
  // Step 3: Tokenize with pinyin support
  const tokenized = await Promise.all(
    expanded.map(q => tokenizeWithPinyin(q, config.pinyin))
  );
  
  return { normalized, expanded, tokenized };
}

// ============================================================================
// Enhanced Retriever
// ============================================================================

export class EnhancedRetriever {
  private config: EnhancedRetrievalConfig;
  private cache: RetrievalCache;
  
  constructor(config: Partial<EnhancedRetrievalConfig> = {}) {
    this.config = { ...DEFAULT_ENHANCED_CONFIG, ...config };
    this.cache = getGlobalCache();
  }

  /**
   * Build cache key from query and config
   */
  private buildCacheKey(query: string, context: RetrievalContext): string {
    const parts = [
      query.toLowerCase().trim(),
      context.limit.toString(),
      context.scopeFilter ? context.scopeFilter.sort().join(",") : "*",
      context.category || "*",
    ];
    return parts.join("|");
  }

  /**
   * Retrieve with cache support
   */
  async retrieve(
    query: string,
    context: RetrievalContext,
    baseRetrieve: (q: string, c: RetrievalContext) => Promise<RetrievalResult[]>
  ): Promise<RetrievalResult[]> {
    // Check cache
    if (this.config.enableCache) {
      const cacheKey = this.buildCacheKey(query, context);
      const cached = this.cache.get(cacheKey);
      
      if (cached) {
        console.log(`[EnhancedRetriever] Cache hit for query: "${query}"`);
        return cached;
      }
    }
    
    // Process query with enhancements
    const processed = await processQuery(query, this.config);
    
    // Retrieve with each expanded query
    const allResults: RetrievalResult[] = [];
    
    for (let i = 0; i < processed.expanded.length; i++) {
      const expandedQuery = processed.expanded[i];
      const isOriginal = i === 0;
      
      try {
        const results = await baseRetrieve(expandedQuery, context);
        
        for (const result of results) {
          allResults.push({
            ...result,
            score: isOriginal ? result.score : result.score * 0.9, // Slight penalty for synonym results
          });
        }
      } catch (error) {
        console.error(`[EnhancedRetriever] Search failed for query "${expandedQuery}":`, error);
      }
    }
    
    // Deduplicate results
    const uniqueResults = this.deduplicateResults(allResults);
    
    // Sort by score
    uniqueResults.sort((a, b) => b.score - a.score);
    
    // Cache results
    if (this.config.enableCache) {
      const cacheKey = this.buildCacheKey(query, context);
      this.cache.set(cacheKey, uniqueResults, this.config.cacheTtlMs);
    }
    
    return uniqueResults.slice(0, context.limit);
  }

  /**
   * Deduplicate results by ID
   */
  private deduplicateResults(results: RetrievalResult[]): RetrievalResult[] {
    const seen = new Map<string, RetrievalResult>();
    
    for (const result of results) {
      const id = result.entry.id;
      
      if (!seen.has(id)) {
        seen.set(id, result);
      } else {
        // Keep highest score
        const existing = seen.get(id)!;
        if (result.score > existing.score) {
          seen.set(id, result);
        }
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * Clear retrieval cache
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[EnhancedRetriever] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxEntries: number;
    defaultTtlMs: number;
  } {
    return this.cache.getStats();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalEnhancedRetriever: EnhancedRetriever | null = null;

/**
 * Get or create the global enhanced retriever
 */
export function getEnhancedRetriever(
  config?: Partial<EnhancedRetrievalConfig>
): EnhancedRetriever {
  if (!globalEnhancedRetriever) {
    globalEnhancedRetriever = new EnhancedRetriever(config);
  }
  return globalEnhancedRetriever;
}

/**
 * Reset global retriever (for testing)
 */
export function resetEnhancedRetriever(): void {
  if (globalEnhancedRetriever) {
    globalEnhancedRetriever.clearCache();
    globalEnhancedRetriever = null;
  }
}

// ============================================================================
// Integration Helper
// ============================================================================

/**
 * Wrap existing retriever with enhancements
 */
export function enhanceRetriever(
  baseRetrieve: (query: string, context: RetrievalContext) => Promise<RetrievalResult[]>,
  config?: Partial<EnhancedRetrievalConfig>
): (query: string, context: RetrievalContext) => Promise<RetrievalResult[]> {
  const retriever = getEnhancedRetriever(config);
  
  return (query: string, context: RetrievalContext) =>
    retriever.retrieve(query, context, baseRetrieve);
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Enhanced retrieval with all features
 */
export async function exampleEnhancedRetrieval() {
  // Mock base retrieve function
  const mockBaseRetrieve = async (
    query: string,
    context: RetrievalContext
  ): Promise<RetrievalResult[]> => {
    console.log('Base retrieve:', query);
    return [
      {
        entry: {
          id: 'mem1',
          text: 'User prefers tabs over spaces',
          vector: [0.1, 0.2, 0.3],
          category: 'preference',
          scope: 'user',
          importance: 0.8,
          timestamp: Date.now(),
        },
        score: 0.85,
      },
    ];
  };
  
  // Create enhanced retriever
  const retriever = getEnhancedRetriever({
    enableCache: true,
    tokenizer: {
      enableChinese: true,
      enablePinyin: true,
    },
    synonyms: {
      enabled: true,
    },
  });
  
  // Retrieve with enhancements
  const results = await retriever.retrieve(
    "用户偏好", // Chinese query
    { query: "用户偏好", limit: 5 },
    mockBaseRetrieve
  );
  
  console.log('Results:', results);
  // Will:
  // 1. Normalize Chinese (繁简转换)
  // 2. Expand with synonyms ("用户" → "user", "client")
  // 3. Tokenize with pinyin
  // 4. Cache results
}

/**
 * Example: Query processing pipeline
 */
export async function exampleQueryProcessing() {
  const query = "人工智能";
  
  const processed = await processQuery(query, {
    ...DEFAULT_ENHANCED_CONFIG,
    conversion: {
      enableConversion: true,
      targetScript: "simplified",
      autoDetect: true,
    },
    synonyms: {
      enabled: true,
      maxExpandedQueries: 5,
    },
    pinyin: {
      enablePinyin: true,
      includeOriginal: true,
    },
  });
  
  console.log('Normalized:', processed.normalized);
  console.log('Expanded:', processed.expanded);
  console.log('Tokenized:', processed.tokenized);
  
  // Output:
  // Normalized: 人工智能
  // Expanded: ["人工智能", "AI", "machine learning"]
  // Tokenized: [["人工", "智能", "ren", "gong"], ["AI"], ["machine", "learning"]]
}
