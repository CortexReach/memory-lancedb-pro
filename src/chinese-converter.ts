/**
 * Traditional-Simplified Chinese Conversion
 * Enables seamless search across traditional and simplified Chinese characters
 */

// ============================================================================
// Types
// ============================================================================

export interface ConversionConfig {
  /** Enable conversion (default: true) */
  enableConversion: boolean;
  /** Target script: 'simplified' | 'traditional' (default: 'simplified') */
  targetScript: 'simplified' | 'traditional';
  /** Auto-detect script and normalize (default: true) */
  autoDetect: boolean;
}

export const DEFAULT_CONVERSION_CONFIG: ConversionConfig = {
  enableConversion: true,
  targetScript: 'simplified',
  autoDetect: true,
};

// ============================================================================
// Script Detection
// ============================================================================

/**
 * Detect if text contains traditional Chinese characters
 * Uses common traditional-only characters as heuristic
 */
export function detectTraditional(text: string): boolean {
  // Common traditional-only characters (not in simplified)
  const traditionalOnlyChars = [
    '麼', '裡', '後', '個', '時', '會', '說', '國', '過', '來',
    '電', '車', '東', '門', '間', '頭', '馬', '高', '體', '長',
    '麼', '為', '們', '化', '與', '著', '製', '複', '麼', '麼'
  ];
  
  for (const char of traditionalOnlyChars) {
    if (text.includes(char)) {
      return true;
    }
  }
  
  // More sophisticated detection: count traditional-specific characters
  const traditionalPattern = /[\u3100-\u312F\u4E00-\u9FFF]/g;
  const matches = text.match(traditionalPattern);
  
  if (!matches) return false;
  
  // This is a simplified heuristic - in production, use opencc-js
  return false;
}

/**
 * Detect if text contains simplified Chinese characters
 */
export function detectSimplified(text: string): boolean {
  // Simplified Chinese is more common in modern text
  // If it has Chinese chars but not traditional markers, assume simplified
  const hasChinese = /[\u4e00-\u9fa5]/.test(text);
  const isTraditional = detectTraditional(text);
  
  return hasChinese && !isTraditional;
}

// ============================================================================
// Conversion Functions (with opencc-js)
// ============================================================================

/**
 * Convert traditional Chinese to simplified
 * Uses opencc-js library if available
 */
export async function toSimplified(text: string): Promise<string> {
  try {
    const { convert } = await import('opencc-js');
    const converter = convert({ from: 'tw', to: 'cn' });
    return converter(text);
  } catch (error) {
    console.log('[ChineseConverter] opencc-js not available, using fallback');
    return toSimplifiedFallback(text);
  }
}

/**
 * Convert simplified Chinese to traditional
 * Uses opencc-js library if available
 */
export async function toTraditional(text: string): Promise<string> {
  try {
    const { convert } = await import('opencc-js');
    const converter = convert({ from: 'cn', to: 'tw' });
    return converter(text);
  } catch (error) {
    console.log('[ChineseConverter] opencc-js not available, using fallback');
    return toTraditionalFallback(text);
  }
}

/**
 * Fallback: Simple traditional to simplified mapping
 * Limited character set - use opencc-js for production
 */
export function toSimplifiedFallback(text: string): string {
  const charMap: Record<string, string> = {
    '麼': '么', '裡': '里', '後': '后', '個': '个', '時': '时',
    '會': '会', '說': '说', '國': '国', '過': '过', '來': '来',
    '電': '电', '車': '车', '東': '东', '門': '门', '間': '间',
    '頭': '头', '馬': '马', '高': '高', '體': '体', '長': '长',
    '為': '为', '們': '们', '化': '化', '與': '与', '著': '着',
    '製': '制', '複': '复', '麼': '么', '麼': '么', '麼': '么'
  };
  
  let result = text;
  for (const [trad, simp] of Object.entries(charMap)) {
    result = result.replace(new RegExp(trad, 'g'), simp);
  }
  
  return result;
}

/**
 * Fallback: Simple simplified to traditional mapping
 * Limited character set - use opencc-js for production
 */
export function toTraditionalFallback(text: string): string {
  const charMap: Record<string, string> = {
    '么': '麼', '里': '裡', '后': '後', '个': '個', '时': '時',
    '会': '會', '说': '說', '国': '國', '过': '過', '来': '來',
    '电': '電', '车': '車', '东': '東', '门': '門', '间': '間',
    '头': '頭', '马': '馬', '高': '高', '体': '體', '长': '長',
    '为': '為', '们': '們', '化': '化', '与': '與', '着': '著',
    '制': '製', '复': '複'
  };
  
  let result = text;
  for (const [simp, trad] of Object.entries(charMap)) {
    result = result.replace(new RegExp(simp, 'g'), trad);
  }
  
  return result;
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize Chinese text to target script
 * Auto-detects source script and converts if needed
 */
export async function normalizeChinese(
  text: string,
  config: ConversionConfig = DEFAULT_CONVERSION_CONFIG
): Promise<string> {
  if (!config.enableConversion) {
    return text;
  }
  
  // Auto-detect and normalize
  if (config.autoDetect) {
    const isTraditional = detectTraditional(text);
    const isSimplified = detectSimplified(text);
    
    if (config.targetScript === 'simplified' && isTraditional) {
      return await toSimplified(text);
    }
    
    if (config.targetScript === 'traditional' && isSimplified) {
      return await toTraditional(text);
    }
    
    // Already in target script or mixed
    return text;
  }
  
  // Force conversion to target script
  if (config.targetScript === 'simplified') {
    return await toSimplified(text);
  } else {
    return await toTraditional(text);
  }
}

/**
 * Normalize text for indexing
 * Always converts to simplified for consistent storage
 */
export async function normalizeForIndexing(
  text: string
): Promise<string> {
  return normalizeChinese(text, {
    enableConversion: true,
    targetScript: 'simplified',
    autoDetect: true,
  });
}

/**
 * Normalize query for search
 * Converts query to same script as indexed data
 */
export async function normalizeForSearch(
  query: string,
  targetScript: 'simplified' | 'traditional' = 'simplified'
): Promise<string> {
  return normalizeChinese(query, {
    enableConversion: true,
    targetScript,
    autoDetect: true,
  });
}

// ============================================================================
// Bidirectional Search Support
// ============================================================================

/**
 * Generate search variants for bidirectional search
 * Returns both simplified and traditional versions
 */
export async function generateSearchVariants(
  query: string
): Promise<{
  simplified: string;
  traditional: string;
  variants: string[];
}> {
  const simplified = await toSimplified(query);
  const traditional = await toTraditional(query);
  
  const variants = [simplified, traditional].filter(
    (v, i, arr) => arr.indexOf(v) === i // Remove duplicates
  );
  
  return { simplified, traditional, variants };
}

/**
 * Check if two texts are equivalent (ignoring script differences)
 */
export async function areEquivalent(
  text1: string,
  text2: string
): Promise<boolean> {
  const simp1 = await toSimplified(text1);
  const simp2 = await toSimplified(text2);
  
  return simp1 === simp2;
}

// ============================================================================
// BM25 Integration
// ============================================================================

/**
 * Prepare documents for BM25 indexing with script normalization
 * All documents are normalized to simplified Chinese
 */
export async function prepareBM25DocumentsWithConversion(
  documents: string[],
  config: ConversionConfig = DEFAULT_CONVERSION_CONFIG
): Promise<string[]> {
  const normalized = await Promise.all(
    documents.map(doc => normalizeChinese(doc, config))
  );
  return normalized;
}

/**
 * Prepare a query for BM25 search with script normalization
 */
export async function prepareBM25QueryWithConversion(
  query: string,
  config: ConversionConfig = DEFAULT_CONVERSION_CONFIG
): Promise<string> {
  return normalizeChinese(query, config);
}

// ============================================================================
// Usage Examples
// ============================================================================

/**
 * Example: Search across traditional and simplified
 * 
 * User searches: "中國" (traditional)
 * Indexed data: "中国" (simplified)
 * Result: Match! ✅
 */
export async function exampleBidirectionalSearch() {
  const query = "中國"; // Traditional
  const indexedText = "中国是一个历史悠久的国家"; // Simplified
  
  // Normalize query to simplified
  const normalizedQuery = await normalizeForSearch(query, 'simplified');
  
  console.log('Query:', query);
  console.log('Normalized:', normalizedQuery);
  // Output: 中国
  
  // Now search with normalized query
  const matches = indexedText.includes(normalizedQuery);
  console.log('Matches:', matches);
  // Output: true ✅
}

/**
 * Example: Generate search variants
 */
export async function exampleSearchVariants() {
  const query = "中国";
  const variants = await generateSearchVariants(query);
  
  console.log('Variants:', variants);
  // Output: {
  //   simplified: "中国",
  //   traditional: "中國",
  //   variants: ["中国", "中國"]
  // }
}
