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
  /** Use AST-aware splitting for code blocks (default: true). */
  astAwareCodeSplit?: boolean;
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

// ============================================================================
// AST-aware Code Chunking
// ============================================================================

export type CodeLanguage = 'javascript' | 'typescript' | 'python' | 'go' | 'rust';

const CODE_LANGUAGE_PATTERNS: Array<{ pattern: RegExp; lang: CodeLanguage }> = [
  // Python: must check before JS (def/class are specific)
  {
    pattern: /\b(def\s|class\s|import\s|from\s|async\s+def\s|print\()/,
    lang: 'python',
  },
  // Go: func and package keywords
  {
    pattern: /\b(func\s|package\s|import\s")/,
    lang: 'go',
  },
  // Rust: fn/impl/pub are distinct
  {
    pattern: /\bfn\s|impl\s|pub\s|let\s+mut\s/,
    lang: 'rust',
  },
  // TypeScript: interface / type alias / : type annotations (check before JS 'function')
  {
    pattern: /\b(interface\s|type\s+|:\s*(?:string|number|boolean|unknown|never|any|void|object|Error|Promise|Record|Array|Map|Set)\b)/,
    lang: 'typescript',
  },
  // JavaScript / TypeScript: function, const/let/var, arrow, import/export, class
  {
    pattern: /\b(function|const\s|let\s|var\s|=>|import\s|export\s|class\s)/,
    lang: 'javascript',
  },
];

/**
 * Detect if text is code and return the language, or null if not code.
 * Uses only the first 200 chars to avoid being misled by comments.
 */
export function detectCodeLanguage(text: string): CodeLanguage | null {
  const sample = text.slice(0, 400);
  for (const { pattern, lang } of CODE_LANGUAGE_PATTERNS) {
    if (pattern.test(sample)) return lang;
  }
  return null;
}

// Supported top-level declaration node types per language
const JS_DECLARATION_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'method_definition',
  'arrow_function',
  'export_statement',
  'export_default_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'lexical_declaration', // const/let declarations
  'variable_declaration',
]);

const PYTHON_DECLARATION_TYPES = new Set([
  'function_definition',
  'class_definition',
  'decorated_definition',
]);

function isDeclarationNode(node: { type: string }, lang: CodeLanguage): boolean {
  if (lang === 'javascript' || lang === 'typescript') {
    return JS_DECLARATION_TYPES.has(node.type);
  }
  if (lang === 'python') return PYTHON_DECLARATION_TYPES.has(node.type);
  return false;
}

/**
 * Sub-split an oversized declaration at the statement level.
 * Falls back to chunkDocument for the sub-split logic.
 */
function subChunk(text: string, config: ChunkerConfig): ChunkResult {
  // For now, fall back to the character-based chunker within an oversized declaration.
  // This preserves the existing behavior for sub-chunks while ensuring top-level
  // declarations (functions/classes) are kept intact.
  return chunkDocument(text, config);
}

/**
 * AST-aware chunker for code. Parses the code with tree-sitter and splits
 * on top-level declaration boundaries (function, class, etc.) instead of
 * arbitrary character positions.
 *
 * NOTE: This function is synchronous to match the sync signature of smartChunk.
 * tree-sitter is loaded via require() with a try-catch fallback.
 */
export function astChunk(
  code: string,
  language: CodeLanguage,
  config: ChunkerConfig
): ChunkResult {
  // Attempt to load tree-sitter and language grammars
  let LanguageMap: Record<string, any>;
  // tree-sitter exports Parser as the default export (module.exports = Parser)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let TreeSitterParser: any;

  try {
    TreeSitterParser = require('tree-sitter');

    if (language === 'javascript' || language === 'typescript') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const JavaScript = require('tree-sitter-javascript');
      LanguageMap = { javascript: JavaScript, typescript: JavaScript };
    } else if (language === 'python') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Python = require('tree-sitter-python');
      LanguageMap = { python: Python };
    } else {
      // Unsupported language — fall back
      return chunkDocument(code, config);
    }
  } catch {
    // tree-sitter not installed — fall back to character-based chunking
    return chunkDocument(code, config);
  }

  const parser = new TreeSitterParser();
  const chunks: string[] = [];
  const metadatas: ChunkMetadata[] = [];

  // Set language on the parser
  let languageSet = false;
  for (const [, langModule] of Object.entries(LanguageMap)) {
    try {
      parser.setLanguage(langModule);
      languageSet = true;
      break;
    } catch {
      // try next language
    }
  }

  if (!languageSet) {
    return chunkDocument(code, config);
  }

  let tree: any;
  try {
    tree = parser.parse(code);
  } catch {
    return chunkDocument(code, config);
  }

  const root = tree.rootNode;

  // If there are ERROR nodes at the top level, the language parser likely does not
  // support this syntax (e.g., TypeScript interface parsed by tree-sitter-javascript).
  // Fall back to chunkDocument to avoid producing broken/incomplete chunks.
  const hasErrorNodes = root.children.some(c => c.type === 'ERROR');
  if (hasErrorNodes) {
    return chunkDocument(code, config);
  }

  // Collect non-declaration content (comments, imports, etc.) that would otherwise be lost.
  // These are prepended to the next declaration chunk to preserve no-content-left-behind semantics.
  let pendingNonDecl = '';

  // Walk top-level children
  for (const child of root.children) {
    // Skip non-named nodes and ERROR nodes
    if (!child.type || child.type === 'ERROR') continue;

    if (!isDeclarationNode(child, language)) {
      // Collect non-declaration content (comments, imports, exports, etc.)
      const text = code.slice(child.startIndex, child.endIndex);
      if (text.length > 0) {
        pendingNonDecl += (pendingNonDecl.length > 0 ? '\n' : '') + text;
      }
      continue;
    }

    const text = code.slice(child.startIndex, child.endIndex);

    if (text.length === 0) continue;

    // Prepend any pending non-declaration content to this declaration chunk
    const fullText = pendingNonDecl.length > 0 ? pendingNonDecl + '\n' + text : text;
    pendingNonDecl = ''; // reset

    if (fullText.length <= config.maxChunkSize) {
      chunks.push(fullText);
      metadatas.push({
        startIndex: child.startIndex,
        endIndex: child.endIndex,
        length: fullText.length,
      });
    } else {
      // Oversized declaration with prepended content.
      // We accept that this chunk may exceed maxChunkSize — splitting
      // mid-declaration would break { } balance (Issue #692).
      // Sub-splitting at statement level is Phase 2 work.
      chunks.push(fullText);
      metadatas.push({
        startIndex: child.startIndex,
        endIndex: child.endIndex,
        length: fullText.length,
      });
    }
  }

  // If there is trailing non-declaration content (e.g., trailing comments with no following decl),
  // emit it as its own chunk (fall back to chunkDocument to handle sizing).
  if (pendingNonDecl.length > 0) {
    const trailing = chunkDocument(pendingNonDecl, config);
    for (let i = 0; i < trailing.chunks.length; i++) {
      chunks.push(trailing.chunks[i]);
      metadatas.push(trailing.metadatas[i]);
    }
  }

  // If we got nothing (e.g. empty file, parse error), fall back
  if (chunks.length === 0) {
    return chunkDocument(code, config);
  }

  return {
    chunks,
    metadatas,
    totalOriginalLength: code.length,
    chunkCount: chunks.length,
  };
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

/**
 * Smart chunker that adapts to model context limits.
 *
 * We intentionally pick conservative char limits (70% of the reported limit)
 * since token/char ratios vary.
 */
export function smartChunk(text: string, embedderModel?: string): ChunkResult {
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
    astAwareCodeSplit: true,
  };

  // AST-aware code path: only activate when explicitly enabled
  if (config.astAwareCodeSplit === true) {
    const lang = detectCodeLanguage(text);
    if (lang !== null) {
      return astChunk(text, lang, config);
    }
  }

  return chunkDocument(text, config);
}

export default chunkDocument;
