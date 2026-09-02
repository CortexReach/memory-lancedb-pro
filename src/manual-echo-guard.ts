/**
 * Manual-store echo guard (class): when the user dictates a memory,
 * the same sentence reaches BOTH the manual store lane (memory_store /
 * memory_update, always-priority, verbatim) and auto-capture extraction,
 * which mints near-twin candidates the dedup layer cannot reliably collide —
 * the manual row may be seconds old (fresh-row vector visibility) or land in
 * a different category. The guard remembers recent manual texts per agent
 * and drops near-identical extraction candidates BEFORE the admission judge:
 * deterministic, string-only, no LLM calls, no vector search.
 *
 * Matching is deliberately conservative: a candidate is an echo only when
 * it asserts NOTHING beyond, and nothing different from, the recorded
 * manual text: an exact match, the manual text containing the candidate
 * verbatim, or the candidate carrying exactly the manual text's content
 * tokens in the same order once reporting glue is stripped. A candidate
 * carrying extra content — a negation ("no longer"), a changed value, a
 * temporal qualifier ("until friday"), or additional facts — is new
 * information and always survives, and so is one that swaps or drops a
 * semantic predicate ("wants" against "has", "prefers Python" against
 * "prefers Go over Python"). The worst case of the guard staying quiet is
 * the pre-guard status quo (one duplicate row for dedup); the worst case of
 * it firing wrongly is a silently lost memory, so every ambiguity resolves
 * toward keeping the candidate.
 *
 * Entries are short-lived and consumed: each recorded manual text expires
 * after MANUAL_ECHO_TTL_MS and suppresses at most ONE candidate (the
 * immediate re-extraction of the same turn). A later identical statement is
 * a deliberate user re-assertion, not an echo. A statement that gets
 * replaced (memory_update, supersede) or forgotten is invalidated at once,
 * so a reversal back to it is never mistaken for an echo of a fact the
 * store no longer holds.
 *
 * Scoped per agent (not per session): the store tool and the auto-capture
 * hook derive their session keys differently, but both resolve the same
 * agent id, and an echo of ANY recent manual text of the same agent is a
 * correct drop regardless of session boundaries. TTL + consumption bound
 * staleness; the ring bounds size.
 *
 * The ledger is in-memory and per process: only the gateway that recorded
 * a text can invalidate it. Deletions made from another process (the
 * memory-pro CLI) are not visible here; the TTL bounds that window to
 * MANUAL_ECHO_TTL_MS, after which the stale entry expires on its own.
 */

export const MANUAL_ECHO_RING_SIZE = 8;
export const MANUAL_ECHO_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_AGENTS = 128;
const MIN_CONTAINMENT_TOKENS = 3;
const MIN_CJK_CONTAINMENT_CHARS = 6;
const MAX_CJK_WRAPPER_RESIDUAL_CHARS = 8;
const DEFAULT_AGENT_BUCKET = "main";

/**
 * Reporting glue the extractor wraps a dictated fact in ("User stated
 * that ..."): articles, copulas, pronouns, prepositions, and reporting
 * verbs. Stripped before token comparison so the canonical wrap echo still
 * collapses. Semantic predicates (has, wants, likes, prefers, ...) are NOT
 * glue: they decide what a sentence asserts, so they stay content tokens.
 * Negation and temporal markers are deliberately not here either.
 */
const ECHO_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "that", "this", "these", "those", "to", "of", "in", "on", "at", "for",
  "with", "and", "or", "as", "by", "from", "it", "its", "their", "they",
  "he", "she", "his", "her", "them", "i", "my", "me", "we", "our", "you",
  "your", "user", "users", "stated", "said", "says", "saying", "mentioned",
  "noted", "also",
]);

/**
 * A marker on exactly one side of the pair means the two texts assert
 * different things (a correction, a retraction, a bounded validity): never
 * treat that as an echo.
 */
const NEGATION_AND_TEMPORAL_MARKERS = new Set([
  "no", "not", "never", "none", "stopped", "stop", "stops", "quit",
  "former", "formerly", "anymore", "longer", "until", "till", "unless",
  "except", "without", "before", "after", "used",
]);

/** Conservative CJK marker fragments (negation / bounded validity). */
const CJK_MARKER_FRAGMENTS = [
  "不", "没", "别", "未", "无", "非", "勿", "直到", "之前", "以前", "除非",
  "ない", "じゃない", "ではない", "まで", "もう",
  "않", "안", "까지", "전에",
];

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalizeEchoText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenList(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length > 0);
}

function orderedContentTokens(normalized: string): string[] {
  const out: string[] = [];
  for (const token of tokenList(normalized)) {
    if (token.length <= 1 && !CJK_RE.test(token)) continue;
    if (ECHO_STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

function contentTokens(normalized: string): Set<string> {
  return new Set(orderedContentTokens(normalized));
}

function markerAsymmetry(aTokens: string[], bTokens: string[]): boolean {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  for (const marker of NEGATION_AND_TEMPORAL_MARKERS) {
    if (a.has(marker) !== b.has(marker)) return true;
  }
  return false;
}

function containsCjkMarker(fragment: string): boolean {
  return CJK_MARKER_FRAGMENTS.some((marker) => fragment.includes(marker));
}

/**
 * The ONLY residual a wrapped CJK echo may carry: reporting glue and
 * particles. Anything else in the residual — a marker, a verb, a new fact
 * like 并养猫 — is substantive content, and "short and marker-free" was
 * provably not enough to exclude it.
 */
const CJK_WRAPPER_GLUE_FRAGMENTS = [
  "用户说", "用户", "说过", "说", "提到", "表示", "了", "的", "是",
  "ユーザーは", "ユーザー", "と言った", "と言いました", "です", "ます",
  "사용자는", "사용자", "라고", "입니다",
];

function isCjkGlueOnly(residual: string): boolean {
  let rest = residual;
  for (let pass = 0; pass < 8 && rest.length > 0; pass++) {
    const before = rest;
    for (const glue of CJK_WRAPPER_GLUE_FRAGMENTS) {
      while (rest.includes(glue)) rest = rest.replace(glue, "");
    }
    if (rest === before) break;
  }
  return rest.length === 0;
}

function isCjkEcho(candidate: string, manual: string): boolean {
  const cand = candidate.replace(/\s+/g, "");
  const man = manual.replace(/\s+/g, "");
  if (cand.length === 0 || man.length === 0) return false;
  if (cand === man) return true;
  // Shortened echo: the candidate re-states a piece of the manual text. The
  // REMOVED part must carry no marker: stripping 用户不 off 用户不喜欢喝茶和咖啡
  // yields the OPPOSITE claim, not an echo of it.
  if (cand.length >= MIN_CJK_CONTAINMENT_CHARS && man.includes(cand)) {
    const removed = man.replace(cand, "");
    return !containsCjkMarker(removed);
  }
  // Wrapped echo: the candidate is the manual text plus reporting glue
  // (用户说…). The residual must consist ONLY of known glue fragments —
  // being short and marker-free is not enough, since a three-character
  // residual can be a brand-new fact (并养猫).
  if (man.length >= MIN_CJK_CONTAINMENT_CHARS && cand.includes(man)) {
    const residual = cand.replace(man, "");
    return residual.length <= MAX_CJK_WRAPPER_RESIDUAL_CHARS && isCjkGlueOnly(residual);
  }
  return false;
}

export function isNearIdenticalEcho(candidateText: string, manualText: string): boolean {
  const candidate = normalizeEchoText(candidateText);
  const manual = normalizeEchoText(manualText);
  if (candidate.length === 0 || manual.length === 0) return false;
  if (candidate === manual) return true;

  if (CJK_RE.test(candidate) || CJK_RE.test(manual)) {
    return isCjkEcho(candidate, manual);
  }

  const manualTokenList = tokenList(manual);
  const candidateTokenList = tokenList(candidate);
  // A correction, retraction, or bounded-validity statement is never an
  // echo, whichever side carries the marker.
  if (markerAsymmetry(manualTokenList, candidateTokenList)) return false;

  // Very short manual texts over-match as substrings ("blue mug" is inside
  // any sentence mentioning it); those only count as echoes when exact.
  const manualContent = contentTokens(manual);
  if (manualContent.size < MIN_CONTAINMENT_TOKENS) return false;

  // Shortened echo: the manual text contains the whole candidate.
  if (manual.includes(candidate)) return true;

  // Wrap echo: the extractor sentence-wraps the dictated fact ("favorite
  // teacup: the red one" -> "User stated their favorite teacup is the red
  // one"). After glue-word stripping, the candidate must carry EXACTLY the
  // manual text's content tokens, in the same order. Adding a token (a
  // changed value, a qualifier, a new fact) is new information; dropping
  // one is a different assertion ("User prefers Python" against "User
  // prefers Go over Python for backend services" reverses the preference),
  // so a subsequence match is not enough. Order matters too: bag-of-words
  // equality would collapse "alice reports to bob" onto "bob reports to
  // alice". The manual-side minimum above doubles as the candidate floor,
  // since equal sequences have equal length.
  const candidateContentList = orderedContentTokens(candidate);
  const manualContentList = orderedContentTokens(manual);
  if (candidateContentList.length !== manualContentList.length) return false;
  return candidateContentList.every((token, i) => token === manualContentList[i]);
}

interface ManualEchoEntry {
  text: string;
  at: number;
}

export class ManualEchoLedger {
  private readonly byAgent = new Map<string, ManualEchoEntry[]>();

  record(agentId: string | undefined, text: string, now: number = Date.now()): void {
    if (typeof text !== "string" || text.trim().length === 0) return;
    const key = agentId?.trim() || DEFAULT_AGENT_BUCKET;
    const ring = (this.byAgent.get(key) ?? []).filter((e) => now - e.at < MANUAL_ECHO_TTL_MS);
    ring.push({ text, at: now });
    while (ring.length > MANUAL_ECHO_RING_SIZE) ring.shift();
    this.byAgent.delete(key);
    this.byAgent.set(key, ring);
    while (this.byAgent.size > MAX_TRACKED_AGENTS) {
      const oldest = this.byAgent.keys().next().value;
      if (oldest === undefined) break;
      this.byAgent.delete(oldest);
    }
  }

  /**
   * Returns the matched manual text, or null when the candidate is no echo.
   * A hit CONSUMES the entry: each manual store suppresses at most one
   * candidate, so a later identical statement (a deliberate re-assertion)
   * is never silently dropped.
   */
  match(agentId: string | undefined, candidateText: string, now: number = Date.now()): string | null {
    const key = agentId?.trim() || DEFAULT_AGENT_BUCKET;
    const ring = this.byAgent.get(key);
    if (!ring || ring.length === 0) return null;
    // `live` is a fresh array, so every outcome below must PERSIST it: an
    // in-place splice of an unpersisted copy would leave the Map holding the
    // matched entry and let one manual store suppress repeated re-statements
    // for its whole TTL (review round 2, finding 1).
    const live = ring.filter((e) => now - e.at < MANUAL_ECHO_TTL_MS);
    if (live.length === 0) {
      this.byAgent.delete(key);
      return null;
    }
    for (let i = live.length - 1; i >= 0; i--) {
      if (isNearIdenticalEcho(candidateText, live[i].text)) {
        const [hit] = live.splice(i, 1);
        if (live.length === 0) this.byAgent.delete(key);
        else this.byAgent.set(key, live);
        return hit.text;
      }
    }
    if (live.length !== ring.length) {
      this.byAgent.set(key, live);
    }
    return null;
  }

  /**
   * Drops entries matching a deleted memory's text, so a forgotten manual
   * fact can never keep suppressing its own re-statement.
   */
  invalidate(agentId: string | undefined, text: string): void {
    if (typeof text !== "string" || text.trim().length === 0) return;
    const key = agentId?.trim() || DEFAULT_AGENT_BUCKET;
    const ring = this.byAgent.get(key);
    if (!ring || ring.length === 0) return;
    const target = normalizeEchoText(text);
    const kept = ring.filter((e) => normalizeEchoText(e.text) !== target);
    if (kept.length === 0) {
      this.byAgent.delete(key);
    } else if (kept.length !== ring.length) {
      this.byAgent.set(key, kept);
    }
  }

  clear(agentId: string | undefined): void {
    this.byAgent.delete(agentId?.trim() || DEFAULT_AGENT_BUCKET);
  }
}
