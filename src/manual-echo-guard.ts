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
 * Matching is deliberately ONE-SIDED and conservative: a candidate is an
 * echo only when it adds NOTHING substantive beyond the recorded manual
 * text (exact match, the manual text containing the candidate, or every
 * candidate content token already present in the manual text). A candidate
 * carrying extra content — a negation ("no longer"), a changed value, a
 * temporal qualifier ("until friday"), or additional facts — is new
 * information and always survives; the worst case of the guard staying
 * quiet is the pre-guard status quo (one duplicate row for dedup).
 *
 * Entries are short-lived and consumed: each recorded manual text expires
 * after MANUAL_ECHO_TTL_MS and suppresses at most ONE candidate (the
 * immediate re-extraction of the same turn). A later identical statement is
 * a deliberate user re-assertion, not an echo.
 *
 * Scoped per agent (not per session): the store tool and the auto-capture
 * hook derive their session keys differently, but both resolve the same
 * agent id, and an echo of ANY recent manual text of the same agent is a
 * correct drop regardless of session boundaries. TTL + consumption bound
 * staleness; the ring bounds size.
 */

export const MANUAL_ECHO_RING_SIZE = 8;
export const MANUAL_ECHO_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_AGENTS = 128;
const MIN_CONTAINMENT_TOKENS = 3;
const MIN_CJK_CONTAINMENT_CHARS = 6;
const MAX_CJK_WRAPPER_RESIDUAL_CHARS = 8;
const DEFAULT_AGENT_BUCKET = "main";

/**
 * Glue vocabulary the extractor wraps a dictated fact in ("User stated
 * that ..."). Stripped before token containment so the canonical wrap echo
 * still collapses; negation and temporal markers are deliberately NOT here.
 */
const ECHO_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "that", "this", "these", "those", "to", "of", "in", "on", "at", "for",
  "with", "and", "or", "as", "by", "from", "it", "its", "their", "they",
  "he", "she", "his", "her", "them", "i", "my", "me", "we", "our", "you",
  "your", "user", "users", "stated", "said", "says", "saying", "mentioned",
  "noted", "prefers", "prefer", "likes", "like", "wants", "want", "has",
  "have", "had", "also",
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

function contentTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenList(normalized)) {
    if (token.length <= 1 && !CJK_RE.test(token)) continue;
    if (ECHO_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
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

function isCjkEcho(candidate: string, manual: string): boolean {
  const cand = candidate.replace(/\s+/g, "");
  const man = manual.replace(/\s+/g, "");
  if (cand.length === 0 || man.length === 0) return false;
  if (cand === man) return true;
  // Shortened echo: the candidate re-states a piece of the manual text and
  // adds nothing. Length-gated so tiny fragments cannot over-match.
  if (cand.length >= MIN_CJK_CONTAINMENT_CHARS && man.includes(cand)) return true;
  // Wrapped echo: the candidate is the manual text plus a small amount of
  // glue ("用户说…"). Allowed only when the residual is short AND carries no
  // negation/temporal marker, so a qualified or corrected statement
  // ("…直到周五", "不再…") is never treated as an echo.
  if (man.length >= MIN_CJK_CONTAINMENT_CHARS && cand.includes(man)) {
    const residual = cand.replace(man, "");
    return residual.length <= MAX_CJK_WRAPPER_RESIDUAL_CHARS && !containsCjkMarker(residual);
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
  // one"). After glue-word stripping, EVERY candidate content token must
  // already be in the manual text — one-sided by design, so a candidate
  // with any extra content token (changed value, qualifier, added fact) is
  // new information and survives.
  const candidateContent = contentTokens(candidate);
  if (candidateContent.size === 0) return false;
  for (const token of candidateContent) {
    if (!manualContent.has(token)) return false;
  }
  return true;
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
    const live = ring.filter((e) => now - e.at < MANUAL_ECHO_TTL_MS);
    if (live.length !== ring.length) {
      if (live.length === 0) {
        this.byAgent.delete(key);
        return null;
      }
      this.byAgent.set(key, live);
    }
    for (let i = live.length - 1; i >= 0; i--) {
      if (isNearIdenticalEcho(candidateText, live[i].text)) {
        const [hit] = live.splice(i, 1);
        if (live.length === 0) this.byAgent.delete(key);
        return hit.text;
      }
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
