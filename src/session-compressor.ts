/**
 * Session Compressor
 *
 * Scores and compresses conversation texts before memory extraction.
 * Prioritizes high-signal content (tool calls, corrections, decisions) over
 * low-signal content (greetings, acknowledgments) so that the fixed extraction
 * budget captures the most important parts of a conversation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoredText {
  /** Original index in the texts array */
  index: number;
  /** The text content */
  text: string;
  /** Score from 0.0 (noise) to 1.0 (high value) */
  score: number;
  /** Human-readable reason for the score */
  reason: string;
}

export interface CompressResult {
  /** Selected texts in chronological order */
  texts: string[];
  /** Detailed scoring for all input texts */
  scored: ScoredText[];
  /** Number of texts dropped */
  dropped: number;
  /** Total chars in output */
  totalChars: number;
}

// ---------------------------------------------------------------------------
// Indicator patterns
// ---------------------------------------------------------------------------

const TOOL_CALL_INDICATORS = [
  /\btool_use\b/i,
  /\btool_result\b/i,
  /\bfunction_call\b/i,
  /\b(memory_store|memory_recall|memory_forget|memory_update)\b/i,
  // Removed over-broad patterns: fenced code blocks and "$ " matched normal pasted code
];

const CORRECTION_INDICATORS = [
  /^no[,.\s]/i,
  /\bactually\b/i,
  /\binstead\b/i,
  /\bwrong\b/i,
  /\bcorrect(ion)?\b/i,
  /\bfix\b/i,
  /不对/,
  /应该是/,
  /應該是/,
  /错了/,
  /錯了/,
  /改成/,
  /不是.*而是/,
];

const DECISION_INDICATORS = [
  /\blet'?s go with\b/i,
  /\bconfirmed?\b/i,
  /\bapproved?\b/i,
  /\bdecided?\b/i,
  /\bwe'?ll use\b/i,
  /\bgoing forward\b/i,
  /\bfrom now on\b/i,
  /\bagreed\b/i,
  /决定/,
  /決定/,
  /确认/,
  /確認/,
  /选择了/,
  /選擇了/,
  /就这样/,
  /就這樣/,
];

const ACKNOWLEDGMENT_PATTERNS = [
  /^(ok|okay|k|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome|alright|yep|yup|yeah|right)\s*[.!]?$/i,
  /^好的?\s*[。！]?$/,
  /^嗯\s*[。]?$/,
  /^收到\s*[。！]?$/,
  /^了解\s*[。！]?$/,
  /^明白\s*[。！]?$/,
  /^谢谢\s*[。！]?$/,
  /^感谢\s*[。！]?$/,
  /^👍\s*$/,
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single text segment by its information density.
 */
export function scoreText(text: string, index: number): ScoredText {
  const trimmed = text.trim();

  // Empty / whitespace-only
  if (trimmed.length === 0) {
    return { index, text, score: 0.0, reason: "empty" };
  }

  // Tool call indicators → highest value
  if (TOOL_CALL_INDICATORS.some((p) => p.test(trimmed))) {
    return { index, text, score: 1.0, reason: "tool_call" };
  }

  // Corrections → very high value (user correcting agent = strong signal)
  if (CORRECTION_INDICATORS.some((p) => p.test(trimmed))) {
    return { index, text, score: 0.95, reason: "correction" };
  }

  // Decisions / confirmations → high value
  if (DECISION_INDICATORS.some((p) => p.test(trimmed))) {
    return { index, text, score: 0.85, reason: "decision" };
  }

  // Acknowledgments → very low value
  if (ACKNOWLEDGMENT_PATTERNS.some((p) => p.test(trimmed))) {
    return { index, text, score: 0.1, reason: "acknowledgment" };
  }

  // Substantive content vs short questions
  // CJK characters carry ~2-3x more meaning per character, so use a lower
  // threshold (same approach as adaptive-retrieval.ts).
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
  const substantiveMinLength = hasCJK ? 30 : 80;
  if (trimmed.length > substantiveMinLength) {
    // Check for boilerplate (XML tags, system messages)
    if (/^<[a-z-]+>/.test(trimmed) && /<\/[a-z-]+>\s*$/.test(trimmed)) {
      return { index, text, score: 0.3, reason: "system_xml" };
    }
    return { index, text, score: 0.7, reason: "substantive" };
  }

  // Short questions
  if (trimmed.includes("?") || trimmed.includes("\uff1f")) {
    return { index, text, score: 0.5, reason: "short_question" };
  }

  // Short but not a question and not an acknowledgment
  return { index, text, score: 0.4, reason: "short_statement" };
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/** Default minimum texts to keep even if all score low */
const DEFAULT_MIN_TEXTS = 3;

/**
 * Compress an array of text segments to fit within a character budget.
 *
 * Strategy:
 * 1. Score all texts
 * 2. Always include first and last text (session boundaries)
 * 3. Sort remaining by score descending
 * 4. Greedily select until budget exhausted
 * 5. Handle paired texts (tool call + result: indices i, i+1)
 * 6. Re-sort selected by original index
 * 7. If all texts score < threshold, keep at least minTexts
 */
export function compressTexts(
  texts: string[],
  maxChars: number,
  options: { minTexts?: number; minScoreToKeep?: number } = {},
): CompressResult {
  const minTexts = options.minTexts ?? DEFAULT_MIN_TEXTS;
  const minScoreToKeep = options.minScoreToKeep ?? 0.3;

  if (texts.length === 0) {
    return { texts: [], scored: [], dropped: 0, totalChars: 0 };
  }

  // Score everything
  const scored = texts.map((t, i) => scoreText(t, i));

  // Total chars of all texts
  const allChars = texts.reduce((sum, t) => sum + t.length, 0);

  // If already within budget, return all
  if (allChars <= maxChars) {
    return {
      texts: [...texts],
      scored,
      dropped: 0,
      totalChars: allChars,
    };
  }

  // Build selected set starting with first and last
  const selectedIndices = new Set<number>();
  let usedChars = 0;

  const addIndex = (idx: number): boolean => {
    if (selectedIndices.has(idx) || idx < 0 || idx >= texts.length) return false;
    const len = texts[idx].length;
    if (usedChars + len > maxChars) {
      // Hard cap: even the first/last text cannot exceed budget
      return false;
    }
    selectedIndices.add(idx);
    usedChars += len;
    return true;
  };

  // Always keep first and last
  addIndex(0);
  if (texts.length > 1) {
    addIndex(texts.length - 1);
  }

  // Build candidate list excluding first/last, sorted by score desc (stable by index asc on tie)
  const candidates = scored
    .filter((s) => s.index !== 0 && s.index !== texts.length - 1)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Identify paired indices (tool call at i → result at i+1).
  // Only pair from a tool_call line, NOT from tool_result — a result line
  // should not pull in the next unrelated line as its "partner".
  const pairedWith = new Map<number, number>();
  for (const s of scored) {
    if (
      s.reason === "tool_call" &&
      s.index + 1 < texts.length &&
      !pairedWith.has(s.index) && // not already claimed
      !pairedWith.has(s.index + 1) // partner not already claimed
    ) {
      pairedWith.set(s.index, s.index + 1);
      pairedWith.set(s.index + 1, s.index);
    }
  }

  // Greedily add candidates
  for (const candidate of candidates) {
    if (usedChars >= maxChars) break;

    const added = addIndex(candidate.index);
    if (added) {
      // If this is part of a pair, try to add the partner
      const partner = pairedWith.get(candidate.index);
      if (partner !== undefined) {
        addIndex(partner);
      }
    }
  }

  // All-low-score fallback: if everything scored below threshold, ensure
  // we keep at least minTexts (the last N by original order)
  const allLow = scored.every((s) => s.score < minScoreToKeep);
  if (allLow && selectedIndices.size < Math.min(minTexts, texts.length)) {
    // Add from the end (most recent = most relevant for low-value sessions)
    for (let i = texts.length - 1; i >= 0 && selectedIndices.size < Math.min(minTexts, texts.length); i--) {
      addIndex(i);
    }
  }

  // Re-sort selected by original index to preserve chronological order
  const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
  const resultTexts = sortedIndices.map((i) => texts[i]);
  const totalChars = resultTexts.reduce((sum, t) => sum + t.length, 0);

  return {
    texts: resultTexts,
    scored,
    dropped: texts.length - sortedIndices.length,
    totalChars,
  };
}

// ---------------------------------------------------------------------------
// Conversation Value Estimation (for Feature 7: Adaptive Throttling)
// ---------------------------------------------------------------------------

/**
 * Estimate the overall value of a conversation for memory extraction.
 * Returns a number between 0.0 and 1.0.
 *
 * Used by the adaptive extraction throttle to skip low-value conversations.
 */
export function estimateConversationValue(texts: string[]): number {
  if (texts.length === 0) return 0;

  let value = 0;

  const joined = texts.join(" ");

  // Has explicit memory intent? (e.g. "remember this", "记住") +0.5
  // These should NEVER be skipped by the low-value gate.
  const MEMORY_INTENT = /\b(remember|recall|don'?t forget|note that|keep in mind)\b/i;
  const MEMORY_INTENT_CJK = /(记住|記住|别忘|不要忘|记一下|記一下)/;
  if (MEMORY_INTENT.test(joined) || MEMORY_INTENT_CJK.test(joined)) {
    value += 0.5;
  }

  // Has tool calls? +0.4
  if (TOOL_CALL_INDICATORS.some((p) => p.test(joined))) {
    value += 0.4;
  }

  // Has corrections or decisions? +0.3
  const hasCorrectionOrDecision =
    CORRECTION_INDICATORS.some((p) => p.test(joined)) ||
    DECISION_INDICATORS.some((p) => p.test(joined));
  if (hasCorrectionOrDecision) {
    value += 0.3;
  }

  // Total substantive text > 200 chars? +0.2
  const substantiveChars = texts
    .filter((t) => t.trim().length > 20) // skip very short lines
    .reduce((sum, t) => sum + t.length, 0);
  if (substantiveChars > 200) {
    value += 0.2;
  }

  // Has multi-turn exchanges (>6 texts)? +0.1
  if (texts.length > 6) {
    value += 0.1;
  }

  return Math.min(value, 1.0);
}
