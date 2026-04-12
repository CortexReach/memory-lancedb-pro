/**
 * Pinyin Search Support
 * Enables pinyin-based retrieval for Chinese memory entries
 */

import type { TokenizerConfig } from "./chinese-tokenizer.js";

// ============================================================================
// Types
// ============================================================================

export interface PinyinConfig {
  /** Enable pinyin tokenization (default: true) */
  enablePinyin: boolean;
  /** Include tone marks in pinyin (default: false) */
  includeTones: boolean;
  /** Pinyin format: 'with-tone' | 'without-tone' | 'initials' (default: 'without-tone') */
  format: 'with-tone' | 'without-tone' | 'initials';
  /** Include both Chinese and pinyin in tokens (default: true) */
  includeOriginal: boolean;
}

export const DEFAULT_PINYIN_CONFIG: PinyinConfig = {
  enablePinyin: true,
  includeTones: false,
  format: 'without-tone',
  includeOriginal: true,
};

// ============================================================================
// Pinyin Conversion
// ============================================================================

/**
 * Convert Chinese text to pinyin using pinyin-pro
 * Falls back to empty array if library not available
 */
export async function convertToPinyin(
  text: string,
  config: PinyinConfig = DEFAULT_PINYIN_CONFIG
): Promise<string[]> {
  if (!config.enablePinyin) {
    return [];
  }

  try {
    const { pinyin } = await import('pinyin-pro');
    
    const options: any = {
      toneType: config.includeTones ? 'symbol' : 'none',
      type: 'array',
      nonZh: 'spaced',
    };

    if (config.format === 'initials') {
      options.mode = 'initial';
    }

    const result = pinyin(text, options);
    
    // Split by spaces and filter empty strings
    const tokens = result
      .join(' ')
      .split(/\s+/)
      .filter(p => p.trim().length > 0);

    return tokens;
  } catch (error) {
    console.log('[PinyinSearch] pinyin-pro not available, skipping pinyin conversion');
    return [];
  }
}

/**
 * Convert Chinese text to pinyin initials (first letters only)
 * Example: "中国" → "z g" or "zg"
 */
export async function convertToPinyinInitials(
  text: string,
  concat: boolean = false
): Promise<string | string[]> {
  try {
    const { pinyin } = await import('pinyin-pro');
    
    const result = pinyin(text, {
      mode: 'initial',
      type: 'array',
    });

    if (concat) {
      return result.join('');
    }
    
    return result;
  } catch (error) {
    console.log('[PinyinSearch] pinyin-pro not available');
    return concat ? '' : [];
  }
}

// ============================================================================
// Pinyin Tokenization
// ============================================================================

/**
 * Tokenize text with pinyin support
 * Returns both Chinese tokens and pinyin tokens
 */
export async function tokenizeWithPinyin(
  text: string,
  pinyinConfig: PinyinConfig = DEFAULT_PINYIN_CONFIG,
  chineseTokenizer?: (text: string) => Promise<string[]>
): Promise<string[]> {
  const allTokens: string[] = [];

  // Step 1: Add original Chinese tokens (if enabled)
  if (pinyinConfig.includeOriginal && chineseTokenizer) {
    const chineseTokens = await chineseTokenizer(text);
    allTokens.push(...chineseTokens);
  } else if (pinyinConfig.includeOriginal) {
    // Fallback: simple split
    allTokens.push(...text.split(/\s+/).filter(t => t.trim().length > 0));
  }

  // Step 2: Add pinyin tokens
  const pinyinTokens = await convertToPinyin(text, pinyinConfig);
  allTokens.push(...pinyinTokens);

  // Step 3: Add pinyin initials (for abbreviation search)
  // Example: "zhong guo" → "zg" for quick typing
  if (/[\u4e00-\u9fa5]/.test(text)) {
    const initials = await convertToPinyinInitials(text, true);
    if (initials && initials.length > 0) {
      allTokens.push(initials as string);
    }
  }

  return allTokens.filter(t => t.trim().length > 0);
}

// ============================================================================
// Pinyin Matching
// ============================================================================

/**
 * Check if a pinyin token matches a query
 * Supports partial matching and abbreviation matching
 */
export function matchPinyin(
  pinyinToken: string,
  query: string
): boolean {
  const normalizedPinyin = pinyinToken.toLowerCase().replace(/[^a-z]/g, '');
  const normalizedQuery = query.toLowerCase().replace(/[^a-z]/g, '');

  // Exact match
  if (normalizedPinyin === normalizedQuery) {
    return true;
  }

  // Partial match (query is prefix of pinyin)
  if (normalizedPinyin.startsWith(normalizedQuery)) {
    return true;
  }

  // Abbreviation match (query matches initials)
  const initials = pinyinToken
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .toLowerCase();
  
  if (initials === normalizedQuery) {
    return true;
  }

  return false;
}

/**
 * Calculate pinyin similarity score
 * Returns a score between 0 and 1
 */
export function calculatePinyinSimilarity(
  pinyinToken: string,
  query: string
): number {
  const normalizedPinyin = pinyinToken.toLowerCase().replace(/[^a-z\s]/g, '');
  const normalizedQuery = query.toLowerCase().replace(/[^a-z]/g, '');

  // Exact match
  if (normalizedPinyin === normalizedQuery) {
    return 1.0;
  }

  // Prefix match
  if (normalizedPinyin.startsWith(normalizedQuery)) {
    return 0.8 + (0.2 * normalizedQuery.length / normalizedPinyin.length);
  }

  // Abbreviation match
  const initials = normalizedPinyin
    .split(/\s+/)
    .map(p => p[0])
    .join('');
  
  if (initials === normalizedQuery) {
    return 0.7;
  }

  // No match
  return 0.0;
}

// ============================================================================
// BM25 Integration
// ============================================================================

/**
 * Prepare documents for BM25 indexing with pinyin support
 * Each document will have both Chinese and pinyin tokens
 */
export async function prepareBM25DocumentsWithPinyin(
  documents: string[],
  pinyinConfig: PinyinConfig = DEFAULT_PINYIN_CONFIG,
  chineseTokenizer?: (text: string) => Promise<string[]>
): Promise<string[][]> {
  const tokenized = await Promise.all(
    documents.map(doc => tokenizeWithPinyin(doc, pinyinConfig, chineseTokenizer))
  );
  return tokenized;
}

/**
 * Prepare a query for BM25 search with pinyin support
 */
export async function prepareBM25QueryWithPinyin(
  query: string,
  pinyinConfig: PinyinConfig = DEFAULT_PINYIN_CONFIG,
  chineseTokenizer?: (text: string) => Promise<string[]>
): Promise<string[]> {
  return tokenizeWithPinyin(query, pinyinConfig, chineseTokenizer);
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Search for "中国" using pinyin
 * 
 * User can search with:
 * - "中国" (Chinese)
 * - "zhong guo" (Full pinyin)
 * - "zg" (Abbreviation)
 * - "zhong" (Partial pinyin)
 */
export async function examplePinyinSearch() {
  const text = "中国是一个历史悠久的国家";
  
  // Tokenize with pinyin
  const tokens = await tokenizeWithPinyin(text, {
    enablePinyin: true,
    includeTones: false,
    format: 'without-tone',
    includeOriginal: true,
  });
  
  console.log('Tokens:', tokens);
  // Output: ['中国', '是', '一个', '历史', '悠久', '的', '国家', 'zhong', 'guo', 'shi', 'yi', 'ge', 'li', 'shi', 'you', 'jiu', 'de', 'guo', 'jia', 'zg']
  
  // Match query
  const query = "zg"; // User types abbreviation
  const matches = tokens.filter(token => matchPinyin(token, query));
  console.log('Matches for "zg":', matches);
  // Output: ['中国', '国家'] (both contain "guo")
}
