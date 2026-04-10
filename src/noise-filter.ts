/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate)
 * Inspired by openclaw-plugin-continuity's noise filtering approach.
 */

// Agent-side denial patterns
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /it looks like i don'?t/i,
  /i wasn'?t able to find/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
];

// User-side meta-question patterns (about memory itself, not content)
const META_QUESTION_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bdid i (tell|mention|say|share)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /\bwhat did i (tell|say|mention)\b/i,
  /如果你知道.+只回复/i,
  /如果不知道.+只回复\s*none/i,
  /只回复精确代号/i,
  /只回复\s*none/i,
  // Chinese recall / meta-question patterns
  /你还?记得/,
  /记不记得/,
  /还记得.*吗/,
  /你[知晓]道.+吗/,
  /我(?:之前|上次|以前)(?:说|提|讲).*(?:吗|呢|？|\?)/,
];

// Session boilerplate
const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)/i,
  /^fresh session/i,
  /^new session/i,
  /^HEARTBEAT/i,
];

// Extractor artifacts from validation prompts / synthetic summaries
const DIAGNOSTIC_ARTIFACT_PATTERNS = [
  /\bquery\s*->\s*(none|no explicit solution|unknown|not found)\b/i,
  /\buser asked for\b.*\b(none|no explicit solution|unknown|not found)\b/i,
  /\bno explicit solution\b/i,
];

/**
 * Envelope noise patterns — Discord/channel metadata headers and blocks
 * that have zero informational value for memory extraction.
 * Used as a fast pre-filter before embedding-based noise checks.
 */
export const ENVELOPE_NOISE_PATTERNS: RegExp[] = [
  /^<<<EXTERNAL_UNTRUSTED_CONTENT\b/im,
  /^<<<END_EXTERNAL_UNTRUSTED_CONTENT\b/im,
  /^Sender\s*\(untrusted metadata\):/im,
  /^Conversation info\s*\(untrusted metadata\):/im,
  /^Thread starter\s*\(untrusted, for context\):/im,
  /^Forwarded message context\s*\(untrusted metadata\):/im,
  /^\[Queued messages while agent was busy\]/im,
  /^System:\s*\[[\d\-: +GMT]+\]/im,  // precise: must match timestamp format
];

export interface NoiseFilterOptions {
  /** Filter agent denial responses (default: true) */
  filterDenials?: boolean;
  /** Filter meta-questions about memory (default: true) */
  filterMetaQuestions?: boolean;
  /** Filter session boilerplate (default: true) */
  filterBoilerplate?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
  filterDenials: true,
  filterMetaQuestions: true,
  filterBoilerplate: true,
};

/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();

  if (trimmed.length < 5) return true;

  if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;
  if (DIAGNOSTIC_ARTIFACT_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
}

/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise<T>(
  items: T[],
  getText: (item: T) => string,
  options?: NoiseFilterOptions
): T[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return items.filter(item => !isNoise(getText(item), opts));
}
