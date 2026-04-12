/**
 * Chinese Tokenizer for BM25
 * Supports Chinese word segmentation (jieba-style) + English tokenization
 */

// ============================================================================
// Types
// ============================================================================

export interface TokenizerConfig {
  /** Enable Chinese segmentation (default: true) */
  enableChinese: boolean;
  /** Enable pinyin support (default: false) */
  enablePinyin: boolean;
  /** Enable traditional-simplified conversion (default: false) */
  enableConversion: boolean;
  /** Target script for conversion: 'simplified' | 'traditional' (default: 'simplified') */
  targetScript: "simplified" | "traditional";
}

export const DEFAULT_TOKENIZER_CONFIG: TokenizerConfig = {
  enableChinese: true,
  enablePinyin: false,
  enableConversion: false,
  targetScript: "simplified",
};

// ============================================================================
// Chinese Character Detection
// ============================================================================

/**
 * Check if text contains Chinese characters
 */
export function hasChineseChars(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/**
 * Check if text is primarily Chinese (>50% Chinese chars)
 */
export function isPrimarilyChinese(text: string): boolean {
  const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return chineseCount / text.length > 0.5;
}

// ============================================================================
// Chinese Segmentation (Fallback Implementation)
// ============================================================================

/**
 * Simple Chinese character segmentation (fallback when node-segmentit not available)
 * Splits Chinese text into individual characters
 * 
 * Note: For production use, install node-segmentit for better word-level segmentation:
 * npm install node-segmentit
 */
export function segmentChineseSimple(text: string): string[] {
  // Match Chinese characters, numbers, letters, and common symbols
  const chinesePattern = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9\s]+/g;
  const matches = text.match(chinesePattern);
  
  if (!matches) return [];
  
  // Further split long Chinese sequences into characters
  const tokens: string[] = [];
  for (const match of matches) {
    if (/^[\u4e00-\u9fa5]+$/.test(match) && match.length > 2) {
      // Split long Chinese sequences into bi-grams for better retrieval
      for (let i = 0; i < match.length - 1; i++) {
        tokens.push(match.slice(i, i + 2));
      }
    } else {
      tokens.push(match);
    }
  }
  
  return tokens;
}

/**
 * Advanced Chinese segmentation using node-segmentit (if available)
 * Falls back to simple segmentation if not installed
 */
export async function segmentChineseAdvanced(text: string): Promise<string[]> {
  try {
    // Try to load node-segmentit (optional dependency)
    const { Segment, useDefault } = await import('node-segmentit');
    const segmentit = useDefault(new Segment());
    const segments = segmentit.doSegment(text, { simple: true });
    return segments.filter(s => s.trim().length > 0);
  } catch (error) {
    // Fallback to simple segmentation
    console.log('[ChineseTokenizer] node-segmentit not available, using simple segmentation');
    return segmentChineseSimple(text);
  }
}

// ============================================================================
// Pinyin Support (Optional)
// ============================================================================

/**
 * Convert Chinese text to pinyin (if pinyin-pro available)
 * Falls back to empty array if not installed
 */
export async function convertToPinyin(text: string): Promise<string[]> {
  try {
    const { pinyin } = await import('pinyin-pro');
    const result = pinyin(text, { 
      toneType: 'none',
      type: 'array',
      nonZh: 'spaced'
    });
    return result.split(' ').filter(p => p.trim().length > 0);
  } catch (error) {
    console.log('[ChineseTokenizer] pinyin-pro not available, skipping pinyin conversion');
    return [];
  }
}

// ============================================================================
// Traditional-Simplified Conversion (Optional)
// ============================================================================

/**
 * Convert traditional Chinese to simplified (if opencc-js available)
 * Falls back to original text if not installed
 */
export async function toSimplified(text: string): Promise<string> {
  try {
    const { convert } = await import('opencc-js');
    const converter = convert({ from: 'tw', to: 'cn' });
    return converter(text);
  } catch (error) {
    console.log('[ChineseTokenizer] opencc-js not available, skipping conversion');
    return text;
  }
}

/**
 * Convert simplified Chinese to traditional (if opencc-js available)
 * Falls back to original text if not installed
 */
export async function toTraditional(text: string): Promise<string> {
  try {
    const { convert } = await import('opencc-js');
    const converter = convert({ from: 'cn', to: 'tw' });
    return converter(text);
  } catch (error) {
    console.log('[ChineseTokenizer] opencc-js not available, skipping conversion');
    return text;
  }
}

// ============================================================================
// Main Tokenizer
// ============================================================================

/**
 * Tokenize text with Chinese support
 * 
 * Features:
 * - Chinese word segmentation (bi-gram fallback)
 * - Optional pinyin support
 * - Optional traditional-simplified conversion
 * - English tokenization (whitespace)
 */
export async function tokenizeChinese(
  text: string,
  config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG
): Promise<string[]> {
  let processedText = text;
  
  // Step 1: Traditional-Simplified conversion
  if (config.enableConversion) {
    processedText = config.targetScript === 'simplified'
      ? await toSimplified(processedText)
      : await toTraditional(processedText);
  }
  
  // Step 2: Check if text has Chinese characters
  if (!hasChineseChars(processedText)) {
    // Pure English/numbers - simple whitespace tokenization
    return processedText.split(/\s+/).filter(t => t.trim().length > 0);
  }
  
  // Step 3: Chinese segmentation
  const tokens = config.enableChinese
    ? await segmentChineseAdvanced(processedText)
    : segmentChineseSimple(processedText);
  
  // Step 4: Add pinyin (if enabled)
  if (config.enablePinyin) {
    const pinyinTokens = await convertToPinyin(processedText);
    tokens.push(...pinyinTokens);
  }
  
  return tokens.filter(t => t.trim().length > 0);
}

/**
 * Synchronous version (uses only simple segmentation)
 * Use this for performance-critical paths
 */
export function tokenizeChineseSync(
  text: string,
  config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG
): string[] {
  let processedText = text;
  
  // Skip conversion in sync version (requires async import)
  
  // Check if text has Chinese characters
  if (!hasChineseChars(processedText)) {
    return processedText.split(/\s+/).filter(t => t.trim().length > 0);
  }
  
  // Use simple segmentation
  const tokens = config.enableChinese
    ? segmentChineseSimple(processedText)
    : [processedText];
  
  return tokens.filter(t => t.trim().length > 0);
}

// ============================================================================
// BM25 Integration Helper
// ============================================================================

/**
 * Prepare documents for BM25 indexing with Chinese support
 */
export async function prepareBM25Documents(
  documents: string[],
  config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG
): Promise<string[][]> {
  const tokenized = await Promise.all(
    documents.map(doc => tokenizeChinese(doc, config))
  );
  return tokenized;
}

/**
 * Prepare a single query for BM25 search with Chinese support
 */
export async function prepareBM25Query(
  query: string,
  config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG
): Promise<string[]> {
  return tokenizeChinese(query, config);
}
