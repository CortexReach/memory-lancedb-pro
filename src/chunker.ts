/**
 * Long Context Chunking System
 *
 * Goal: split documents that exceed embedding model context limits into smaller,
 * semantically coherent chunks with overlap.
 *
 * Notes:
 * - We use *character counts* as a conservative proxy for tokens.
 * - The embedder triggers this only after a provider throws a context-length error.
 */

// ============================================================================
// Types & Constants
// ============================================================================

export interface ChunkMetadata {
  startIndex: number;
  endIndex: number;
  length: number;
}

export interface ChunkResult {
  chunks: string[];
  metadatas: ChunkMetadata[];
  totalOriginalLength: number;
  chunkCount: number;
}

export type CodeChunkLanguage = "javascript" | "typescript" | "python";

export interface ChunkerAstConfig {
  /** Enable code-boundary-aware chunking for supported languages. Default: false. */
  enabled?: boolean;
  /** Supported language whitelist. Defaults to JS/TS/Python. */
  languages?: CodeChunkLanguage[];
}

export interface ChunkerConfig {
  /** Maximum characters per chunk. */
  maxChunkSize: number;
  /** Overlap between chunks in characters. */
  overlapSize: number;
  /** Minimum chunk size (except the final chunk). */
  minChunkSize: number;
  /** Attempt to split on sentence boundaries for better semantic coherence. */
  semanticSplit: boolean;
  /** Max lines per chunk before we try to split earlier on a line boundary. */
  maxLinesPerChunk: number;
}

// Common embedding context limits (provider/model specific). These are typically
// token limits, but we treat them as inputs to a conservative char-based heuristic.
export const EMBEDDING_CONTEXT_LIMITS: Record<string, number> = {
  // Jina v5
  "jina-embeddings-v5-text-small": 8192,
  "jina-embeddings-v5-text-nano": 8192,

  // OpenAI
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,

  // Google
  "text-embedding-004": 8192,
  "gemini-embedding-001": 2048,

  // Local/common
  "nomic-embed-text": 8192,
  "all-MiniLM-L6-v2": 512,
  "all-mpnet-base-v2": 512,
};

export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  maxChunkSize: 4000,
  overlapSize: 200,
  minChunkSize: 200,
  semanticSplit: true,
  maxLinesPerChunk: 50,
};

// Sentence ending patterns (English + CJK-ish punctuation)
const SENTENCE_ENDING = /[.!?。！？]/;

// ============================================================================
// Helpers
// ============================================================================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function countLines(s: string): number {
  // Count \n (treat CRLF as one line break)
  return s.split(/\r\n|\n|\r/).length;
}

function findLastIndexWithin(text: string, re: RegExp, start: number, end: number): number {
  // Find last match start index for regex within [start, end).
  // NOTE: `re` must NOT be global; we will scan manually.
  let last = -1;
  for (let i = end - 1; i >= start; i--) {
    if (re.test(text[i])) return i;
  }
  return last;
}

function findSplitEnd(text: string, start: number, maxEnd: number, minEnd: number, config: ChunkerConfig): number {
  const safeMinEnd = clamp(minEnd, start + 1, maxEnd);
  const safeMaxEnd = clamp(maxEnd, safeMinEnd, text.length);

  // Respect line limit: if we exceed maxLinesPerChunk, force earlier split at a line break.
  if (config.maxLinesPerChunk > 0) {
    const candidate = text.slice(start, safeMaxEnd);
    if (countLines(candidate) > config.maxLinesPerChunk) {
      // Find the position of the Nth line break.
      let breaks = 0;
      for (let i = start; i < safeMaxEnd; i++) {
        const ch = text[i];
        if (ch === "\n") {
          breaks++;
          if (breaks >= config.maxLinesPerChunk) {
            // Split right after this newline.
            return Math.max(i + 1, safeMinEnd);
          }
        }
      }
    }
  }

  if (config.semanticSplit) {
    // Prefer a sentence boundary near the end.
    // Scan backward from safeMaxEnd to safeMinEnd.
    for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
      if (SENTENCE_ENDING.test(text[i])) {
        // Include trailing whitespace after punctuation.
        let j = i + 1;
        while (j < safeMaxEnd && /\s/.test(text[j])) j++;
        return j;
      }
    }

    // Next best: newline boundary.
    for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
      if (text[i] === "\n") return i + 1;
    }
  }

  // Fallback: last whitespace boundary.
  for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
    if (/\s/.test(text[i])) return i;
  }

  return safeMaxEnd;
}

function sliceTrimWithIndices(text: string, start: number, end: number): { chunk: string; meta: ChunkMetadata } {
  const raw = text.slice(start, end);
  const leading = raw.match(/^\s*/)?.[0]?.length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0]?.length ?? 0;
  const chunk = raw.trim();

  const trimmedStart = start + leading;
  const trimmedEnd = end - trailing;

  return {
    chunk,
    meta: {
      startIndex: trimmedStart,
      endIndex: Math.max(trimmedStart, trimmedEnd),
      length: chunk.length,
    },
  };
}

// ============================================================================
// CJK Detection
// ============================================================================

// CJK Unicode ranges: Unified Ideographs, Extension A, Compatibility,
// Hangul Syllables, Katakana, Hiragana
const CJK_RE =
  /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

/** Ratio of CJK characters to total non-whitespace characters. */
function getCjkRatio(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    if (CJK_RE.test(ch)) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

// CJK chars are ~2-3 tokens each. When text is predominantly CJK, we divide
// char limits by this factor to stay within the model's token budget.
const CJK_CHAR_TOKEN_DIVISOR = 2.5;
const CJK_RATIO_THRESHOLD = 0.3;

const DEFAULT_AST_LANGUAGES: CodeChunkLanguage[] = ["javascript", "typescript", "python"];

interface CodeUnit {
  start: number;
  end: number;
}

// ============================================================================
// Chunking Core
// ============================================================================

export function chunkDocument(text: string, config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG): ChunkResult {
  if (!text || text.trim().length === 0) {
    return { chunks: [], metadatas: [], totalOriginalLength: 0, chunkCount: 0 };
  }

  const totalOriginalLength = text.length;
  const chunks: string[] = [];
  const metadatas: ChunkMetadata[] = [];

  let pos = 0;
  const maxGuard = Math.max(4, Math.ceil(text.length / Math.max(1, config.maxChunkSize - config.overlapSize)) + 5);
  let guard = 0;

  while (pos < text.length && guard < maxGuard) {
    guard++;

    const remaining = text.length - pos;
    if (remaining <= config.maxChunkSize) {
      const { chunk, meta } = sliceTrimWithIndices(text, pos, text.length);
      if (chunk.length > 0) {
        chunks.push(chunk);
        metadatas.push(meta);
      }
      break;
    }

    const maxEnd = Math.min(pos + config.maxChunkSize, text.length);
    const minEnd = Math.min(pos + config.minChunkSize, maxEnd);

    const end = findSplitEnd(text, pos, maxEnd, minEnd, config);
    const { chunk, meta } = sliceTrimWithIndices(text, pos, end);

    // If trimming made it too small, fall back to a hard split.
    if (chunk.length < config.minChunkSize) {
      const hardEnd = Math.min(pos + config.maxChunkSize, text.length);
      const hard = sliceTrimWithIndices(text, pos, hardEnd);
      if (hard.chunk.length > 0) {
        chunks.push(hard.chunk);
        metadatas.push(hard.meta);
      }
      if (hardEnd >= text.length) break;
      pos = Math.max(hardEnd - config.overlapSize, pos + 1);
      continue;
    }

    chunks.push(chunk);
    metadatas.push(meta);

    if (end >= text.length) break;

    // Move forward with overlap.
    const nextPos = Math.max(end - config.overlapSize, pos + 1);
    pos = nextPos;
  }

  return {
    chunks,
    metadatas,
    totalOriginalLength,
    chunkCount: chunks.length,
  };
}

// ============================================================================
// Code-Boundary Chunking
// ============================================================================

function getAstLanguages(config?: ChunkerAstConfig): Set<CodeChunkLanguage> {
  const languages = config?.languages?.length ? config.languages : DEFAULT_AST_LANGUAGES;
  return new Set(languages);
}

export function detectCodeLanguage(text: string): CodeChunkLanguage | null {
  const tsIndicators = [
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+\w+/m,
    /:\s*(?:string|number|boolean|unknown|any)\b/,
    /\bPromise<[^>]+>/,
  ].filter((pattern) => pattern.test(text)).length;

  const jsIndicators = [
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\w+\s*\(/m,
    /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+\w+/m,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=/m,
    /\bimport\s+[^;]+?\s+from\s+["'][^"']+["']/,
    /=>/,
  ].filter((pattern) => pattern.test(text)).length;

  const pythonIndicators = [
    /^\s*(?:async\s+)?def\s+\w+\s*\(/m,
    /^\s*class\s+\w+.*:/m,
    /^\s*(?:from\s+\w+(?:\.\w+)*\s+import|import\s+\w+)/m,
    /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m,
  ].filter((pattern) => pattern.test(text)).length;

  if (pythonIndicators >= 2 || (pythonIndicators >= 1 && jsIndicators === 0 && tsIndicators === 0)) {
    return "python";
  }

  if (tsIndicators > 0 && jsIndicators > 0) return "typescript";
  if (jsIndicators >= 2 || (jsIndicators >= 1 && pythonIndicators === 0)) return "javascript";
  return null;
}

function getLineStart(text: string, index: number): number {
  const prevNewline = text.lastIndexOf("\n", Math.max(0, index - 1));
  return prevNewline === -1 ? 0 : prevNewline + 1;
}

function getLineEnd(text: string, index: number): number {
  const nextNewline = text.indexOf("\n", index);
  return nextNewline === -1 ? text.length : nextNewline + 1;
}

function jsBraceDepthAt(text: string, end: number): number {
  let depth = 0;
  let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
  let escaped = false;

  for (let i = 0; i < end; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? "\"" : "`";
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        state = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "lineComment";
      i++;
    } else if (ch === "/" && next === "*") {
      state = "blockComment";
      i++;
    } else if (ch === "'") {
      state = "single";
    } else if (ch === "\"") {
      state = "double";
    } else if (ch === "`") {
      state = "template";
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth;
}

function findMatchingJsBrace(text: string, openIndex: number): number {
  let depth = 0;
  let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? "\"" : "`";
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        state = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "lineComment";
      i++;
    } else if (ch === "/" && next === "*") {
      state = "blockComment";
      i++;
    } else if (ch === "'") {
      state = "single";
    } else if (ch === "\"") {
      state = "double";
    } else if (ch === "`") {
      state = "template";
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function findOpeningJsBrace(text: string, start: number): number {
  let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? "\"" : "`";
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        state = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "lineComment";
      i++;
    } else if (ch === "/" && next === "*") {
      state = "blockComment";
      i++;
    } else if (ch === "'") {
      state = "single";
    } else if (ch === "\"") {
      state = "double";
    } else if (ch === "`") {
      state = "template";
    } else if (ch === "{") {
      return i;
    } else if (ch === "\n" && text.slice(start, i).includes(";")) {
      return -1;
    }
  }

  return -1;
}

function findJsCodeUnits(text: string): CodeUnit[] | null {
  const units: CodeUnit[] = [];
  const declarationPattern =
    /^[ \t]*(?:(?:export|declare)\s+)*(?:default\s+)?(?:(?:abstract\s+)?class\s+[$A-Z_a-z][$\w]*|(?:async\s+)?function\s+[$A-Z_a-z][$\w]*|(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>)/gm;

  for (const match of text.matchAll(declarationPattern)) {
    const matchIndex = match.index ?? 0;
    const lineStart = getLineStart(text, matchIndex);
    if (jsBraceDepthAt(text, matchIndex) !== 0) continue;

    const openBrace = findOpeningJsBrace(text, matchIndex);
    if (openBrace === -1) return null;

    const closeBrace = findMatchingJsBrace(text, openBrace);
    if (closeBrace === -1) return null;

    let end = getLineEnd(text, closeBrace + 1);
    if (text[end] === ";") end = getLineEnd(text, end + 1);

    const previous = units[units.length - 1];
    if (!previous || lineStart >= previous.end) {
      units.push({ start: lineStart, end });
    }
  }

  return units.length > 0 ? units : null;
}

function getBaseIndent(text: string): number {
  let min = Number.POSITIVE_INFINITY;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    min = Math.min(min, indent);
  }
  return Number.isFinite(min) ? min : 0;
}

function findPythonCodeUnits(text: string): CodeUnit[] | null {
  const units: CodeUnit[] = [];
  const baseIndent = getBaseIndent(text);
  const lines = text.matchAll(/^([ \t]*)(.*)(?:\r?\n|$)/gm);
  const candidates: number[] = [];

  for (const match of lines) {
    const start = match.index ?? 0;
    const indent = match[1] ?? "";
    const body = match[2] ?? "";
    if (indent.length === baseIndent && /^(?:async\s+def|def|class)\s+\w+/.test(body.trimStart())) {
      let adjustedStart = start;
      let cursor = start;
      while (cursor > 0) {
        const prevEnd = cursor - 1;
        const prevStart = getLineStart(text, prevEnd);
        const prevLine = text.slice(prevStart, cursor).trim();
        if (!prevLine.startsWith("@")) break;
        adjustedStart = prevStart;
        cursor = prevStart;
      }
      candidates.push(adjustedStart);
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const start = candidates[i];
    const end = i + 1 < candidates.length ? candidates[i + 1] : text.length;
    units.push({ start, end });
  }

  return units.length > 0 ? units : null;
}

function buildBoundaryChunks(text: string, units: CodeUnit[], config: ChunkerConfig): ChunkResult | null {
  const spans: CodeUnit[] = [];
  let previousEnd = 0;

  for (const unit of units) {
    const start = previousEnd;
    const end = unit.end;
    if (end <= start) continue;
    spans.push({ start, end });
    previousEnd = end;
  }

  if (previousEnd < text.length) {
    spans.push({ start: previousEnd, end: text.length });
  }

  const chunks: string[] = [];
  const metadatas: ChunkMetadata[] = [];
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  const flush = () => {
    if (currentStart === null || currentEnd === null) return;
    const { chunk, meta } = sliceTrimWithIndices(text, currentStart, currentEnd);
    if (chunk.length > 0) {
      chunks.push(chunk);
      metadatas.push(meta);
    }
    currentStart = null;
    currentEnd = null;
  };

  for (const span of spans) {
    const trimmed = sliceTrimWithIndices(text, span.start, span.end);
    if (trimmed.chunk.length === 0) continue;
    if (trimmed.chunk.length > config.maxChunkSize) return null;

    if (currentStart === null || currentEnd === null) {
      currentStart = span.start;
      currentEnd = span.end;
      continue;
    }

    const candidate = sliceTrimWithIndices(text, currentStart, span.end);
    if (candidate.chunk.length <= config.maxChunkSize) {
      currentEnd = span.end;
      continue;
    }

    flush();
    currentStart = span.start;
    currentEnd = span.end;
  }

  flush();

  if (chunks.length === 0) return null;
  return {
    chunks,
    metadatas,
    totalOriginalLength: text.length,
    chunkCount: chunks.length,
  };
}

export function chunkCodeByBoundaries(
  text: string,
  config: ChunkerConfig,
  astConfig: ChunkerAstConfig,
): ChunkResult | null {
  if (!astConfig.enabled) return null;

  const language = detectCodeLanguage(text);
  if (!language || !getAstLanguages(astConfig).has(language)) return null;

  const units = language === "python" ? findPythonCodeUnits(text) : findJsCodeUnits(text);
  if (!units) return null;

  return buildBoundaryChunks(text, units, config);
}

/**
 * Smart chunker that adapts to model context limits.
 *
 * We intentionally pick conservative char limits (70% of the reported limit)
 * since token/char ratios vary.
 */
export function smartChunk(text: string, embedderModel?: string, astConfig?: ChunkerAstConfig): ChunkResult {
  const limit = embedderModel ? EMBEDDING_CONTEXT_LIMITS[embedderModel] : undefined;
  const base = limit ?? 8192;

  // CJK characters consume ~2-3 tokens each, so a char-based limit that works
  // for Latin text will vastly overshoot the token budget for CJK-heavy text.
  const cjkHeavy = getCjkRatio(text) > CJK_RATIO_THRESHOLD;
  const divisor = cjkHeavy ? CJK_CHAR_TOKEN_DIVISOR : 1;

  const config: ChunkerConfig = {
    maxChunkSize: Math.max(200, Math.floor(base * 0.7 / divisor)),
    overlapSize: Math.max(0, Math.floor(base * 0.05 / divisor)),
    minChunkSize: Math.max(100, Math.floor(base * 0.1 / divisor)),
    semanticSplit: true,
    maxLinesPerChunk: 50,
  };

  if (astConfig?.enabled) {
    try {
      const astResult = chunkCodeByBoundaries(text, config, astConfig);
      if (astResult) return astResult;
    } catch {
      // Hard fallback: AST/code-boundary splitting must never break existing chunking.
    }
  }

  return chunkDocument(text, config);
}

export default chunkDocument;
