/**
 * Smart Memory Extractor — LLM-powered extraction pipeline
 * Replaces regex-triggered capture with intelligent 6-category extraction.
 *
 * Pipeline: conversation → LLM extract → candidates → dedup → persist
 *
 */

import type { MemoryStore, MemoryEntry, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { LlmClient } from "./llm-client.js";
import {
  buildExtractionPrompt,
  buildDedupPrompt,
  buildGroundingRejudgePrompt,
  buildMergePrompt,
  buildBatchDedupPrompt,
  buildBatchMergePrompt,
} from "./extraction-prompts.js";
import { formatExistingMemoryEntry } from "./prompt-blocks.js";
import {
  AdmissionController,
  type AdmissionAuditRecord,
  type AdmissionControlConfig,
  type AdmissionEvaluation,
  type AdmissionRejectionAuditEntry,
} from "./admission-control.js";
import {
  type CandidateGrounding,
  type CandidateMemory,
  type ConversationRegister,
  type DedupDecision,
  type DedupResult,
  type ExtractionStats,
  type MemoryCategory,
  ALWAYS_MERGE_CATEGORIES,
  DURABLE_CATEGORIES,
  FICTION_JUDGED_CATEGORIES,
  REGISTER_STRICTNESS,
  getStorageCategoryForMemoryCategory,
  MERGE_SUPPORTED_CATEGORIES,
  MEMORY_CATEGORIES,
  TEMPORAL_VERSIONED_CATEGORIES,
  normalizeCategory,
} from "./memory-categories.js";
import { isMetaFrustrationNoise, isNoise } from "./noise-filter.js";
import type { NoisePrototypeBank } from "./noise-prototypes.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  type MemoryRelation,
  parseSmartMetadata,
  stringifySmartMetadata,
  parseSupportInfo,
  updateSupportStats,
} from "./smart-metadata.js";
import {
  isUserMdExclusiveMemory,
  type WorkspaceBoundaryConfig,
} from "./workspace-boundary.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";
import { inferAtomicBrandItemPreferenceSlot } from "./preference-slots.js";
import { batchDedup } from "./batch-dedup.js";
import {
  type ConversationTurn,
  buildBoundedTranscriptWithStats,
} from "./auto-capture-cleanup.js";

type StoreEntry = Omit<import("./store.js").MemoryEntry, "id" | "timestamp">;
type PendingMergeAddition = {
  candidate: CandidateMemory;
  contextLabel?: string;
  admissionAudit?: AdmissionWriteEvidence;
};

/**
 * The caller's own admission audit, as carried inside an externally-built
 * entry's metadata. Used by the gated-candidate lane so downstream verdict
 * handling persists the real gate record, never a synthetic marker.
 */
type AdmissionFailOpenEvidence = {
  provenance: string;
  failedOpen: true;
  reason?: string;
  error?: string;
};

/**
 * The evidence a mutation may carry to its write site: either the caller's
 * complete gate audit, or a fail-open marker proving the content was never
 * evaluated. The write site (withAdmissionAudit) discriminates: complete
 * audits replace admission_control as before; fail-open markers never touch
 * an existing audit and are appended to admission_bypass_events instead.
 */
type AdmissionWriteEvidence = AdmissionAuditRecord | AdmissionFailOpenEvidence;

const MAX_ADMISSION_BYPASS_EVENTS = 20;
const MAX_ADMISSION_CONTROL_HISTORY = 20;

function isFailOpenEvidence(
  value: AdmissionWriteEvidence,
): value is AdmissionFailOpenEvidence {
  return (
    (value as AdmissionFailOpenEvidence).failedOpen === true &&
    typeof (value as AdmissionFailOpenEvidence).provenance === "string"
  );
}

function parseEntryAdmissionEvidence(
  entry: Omit<import("./store.js").MemoryEntry, "id" | "timestamp">,
): { audit?: AdmissionAuditRecord; failOpen?: AdmissionFailOpenEvidence } {
  const raw = entry.metadata;
  if (typeof raw !== "string" || raw.length === 0) {
    return {};
  }
  try {
    const meta = JSON.parse(raw);
    // Production external builders (the reflection mapped lane) persist the
    // gate record as a nested JSON string under admission_audit.
    const audit = meta.admission_audit;
    const parsed = typeof audit === "string" && audit.length > 0 ? JSON.parse(audit) : audit;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).version === "amac-v1" &&
      typeof (parsed as Record<string, unknown>).decision === "string"
    ) {
      return { audit: parsed as AdmissionAuditRecord };
    }
    // Fail-open gate markers ({provenance, failedOpen, reason, error}) are
    // evidence of a skipped evaluation, not an audit. They must never be
    // adopted as admission_control, but dropping them entirely would leave a
    // mutated target with no trace that unevaluated content became durable —
    // carry them separately so write sites can append bypass evidence.
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).failedOpen === true &&
      typeof (parsed as Record<string, unknown>).provenance === "string"
    ) {
      return { failOpen: parsed as AdmissionFailOpenEvidence };
    }
    return {};
  } catch {
    return {};
  }
}
/**
 * One deferred merge write, queued while candidates are processed and
 * flushed through the single batched merge-writer call afterwards. Multiple
 * candidates merging into the same target row are grouped into one job so a
 * later write can never clobber an earlier one with stale content.
 */
type PendingMergeJob = {
  matchId: string;
  category: MemoryCategory;
  existing: { abstract: string; overview: string; content: string };
  additions: PendingMergeAddition[];
  targetScope: string;
  scopeFilter?: string[];
  agentId?: string;
};
type PendingSupersedeInvalidation = {
  entryIndex: number;
  // The exact queued entry object: bulkStore may filter entries and return a
  // shorter array, shifting positions, so resolution falls back to stable
  // entry identity (text + category + lane) instead of trusting the index.
  entry: StoreEntry;
  matchId: string;
  existing: MemoryEntry;
  factKey: string;
  scopeFilter?: string[];
};

// Discriminates WHY extractCandidates() came back empty, so the caller can
// tell a genuine "LLM found nothing" verdict from a gateway/model failure or
// a malformed response shape — only the former is a real noise signal.
type ExtractCandidatesResult =
  | { status: "ok"; candidates: CandidateMemory[]; rawCandidateCount: number; groundingOrPolicyDropped?: boolean }
  | { status: "llm_failure"; candidates: [] }
  | { status: "malformed"; candidates: [] }
  | { status: "empty_input"; candidates: [] };

// ============================================================================
// Envelope Metadata Stripping
// ============================================================================

/**
 * Strip platform envelope metadata injected by OpenClaw channels before
 * the conversation text reaches the extraction LLM. These envelopes contain
 * message IDs, sender IDs, timestamps, and JSON metadata blocks that have
 * zero informational value for memory extraction but get stored verbatim
 * by weaker LLMs (e.g. qwen) that can't distinguish metadata from content.
 *
 * Targets:
 * - "System: [YYYY-MM-DD HH:MM:SS GMT+N] Channel[account] ..." header lines
 * - "Conversation info (untrusted metadata):" + JSON code blocks
 * - "Sender (untrusted metadata):" + JSON code blocks
 * - "Replied message (untrusted, for context):" + JSON code blocks
 * - Standalone JSON blocks containing message_id/sender_id fields
 *
 * Note: stripLeadingRuntimeWrappers and stripRuntimeWrapperBoilerplate from
 * the old implementation are dead code after this refactor — they are not
 * called anywhere in the pipeline. They have been removed.
 */
export function stripEnvelopeMetadata(text: string): string {
  // Matches wrapper lines: [Subagent Context] or [Subagent Task], possibly with
  // inline content on the same line (e.g. "[Subagent Task] Reply with brief ack.").
  // Also matches when the wrapper prefix is on its own line ("]\n" = no content after ]).
  const WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\](?:\s|$|\n)?/i;
  const BOILERPLATE_RE = /^(?:Results auto-announce to your requester\.?|do not busy-poll for status\.?|Reply with a brief acknowledgment only\.?|Do not use any memory tools\.?)$/im;
  // Anchored inline variant: only strip boilerplate when it starts the wrapper
  // remainder. This avoids erasing legitimate inline payload that merely quotes
  // a boilerplate phrase later in the sentence.
  // Repeat the anchored segment so composite wrappers like "You are running...
  // Results auto-announce..." are fully removed before preserving any payload.
  // The subagent running phrase uses (?<=\.)\s+|$ alternation (same as old
  // RUNTIME_WRAPPER_BOILERPLATE_RE) so that parenthetical depth like "(depth 1/1)."
  // is included before the ending whitespace, correctly stripping the full phrase.
  const INLINE_BOILERPLATE_RE =
    /^(?:(?:You are running as a subagent\b.*?(?:(?<=\.)\s+|$)|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*))+/i;
  // Anchor to start of line — prevents quoted/cited false-positives
  const SUBAGENT_RUNNING_RE = /^You are running as a subagent\b/i;

  const originalLines = text.split("\n");

  // Pre-scan: determine if there are leading wrappers.
  // Needed to decide whether boilerplate in the leading zone should be stripped
  // (boilerplate without a wrapper prefix is preserved — it may be legitimate user text).
  //
  // FIX (Must Fix 2): Only scan the ACTUAL leading zone — lines before the first
  // real user content. Previously scanned ALL lines, causing false positives when
  // a wrapper appeared in the trailing zone (e.g. user-pasted quoted text).
  let foundLeadingWrapper = false;
  for (let i = 0; i < originalLines.length; i++) {
    const trimmed = originalLines[i].trim();
    if (trimmed === "") continue; // blank lines are part of leading zone
    if (WRAPPER_LINE_RE.test(trimmed)) { foundLeadingWrapper = true; continue; }
    if (BOILERPLATE_RE.test(trimmed)) continue;
    // First real user content — stop scanning, this is the leading zone boundary
    break;
  }

  // Single-pass state machine: find leading zone end and build result simultaneously.
  // Key: "You are running as a subagent..." on its own line AFTER a wrapper prefix
  // is wrapper CONTENT (must be stripped), not user content.
  let stillInLeadingZone = true;
  let prevWasWrapper = false;
  let encounteredWrapperYet = false; // FIX (MAJOR): per-line flag, not global
  const result: string[] = [];

  for (let i = 0; i < originalLines.length; i++) {
    const rawLine = originalLines[i];
    const trimmed = rawLine.trim();
    const isWrapper = WRAPPER_LINE_RE.test(trimmed);
    const isBoilerplate = BOILERPLATE_RE.test(trimmed);
    const afterPrefix = trimmed.replace(WRAPPER_LINE_RE, "").trim();
    const isBoilerplateAfterPrefix = BOILERPLATE_RE.test(afterPrefix);
    const isSubagentContent = prevWasWrapper && SUBAGENT_RUNNING_RE.test(trimmed);

    // Strip wrapper lines only when inside the leading zone (N2 fix)
    if (stillInLeadingZone && isWrapper) {
      prevWasWrapper = true;
      encounteredWrapperYet = true;
      // 1. Strip wrapper prefix
      let remainder = afterPrefix;
      // 2. Remove all boilerplate phrases from remainder (handles inline
      //    wrapper+boilerplate like "[Subagent Context] ... Results auto-announce...").
      //    Use INLINE_BOILERPLATE_RE (anchored, includes subagent phrase) so only
      //    leading wrapper boilerplate is removed while quoted user payload remains.
      remainder = remainder.replace(INLINE_BOILERPLATE_RE, "").replace(/\s{2,}/g, " ").trim();
      // 3. Keep remainder if non-empty (non-boilerplate inline content preserved);
      //    strip the whole line if only boilerplate was present
      result.push(remainder);
      continue;
    }

    if (stillInLeadingZone) {
      // Blank line — strip but do NOT exit the leading zone (Must Fix 1 fix)
      if (trimmed === "") {
        result.push("");
        continue;
      }

      // Boilerplate check: use afterPrefix (wrapper-stripped content) so that
      // inline wrapper+boilerplate like "[Subagent Task] Reply with brief ack."
      // is correctly identified as boilerplate and removed.
      const contentForBoilerplateCheck = isWrapper ? afterPrefix : trimmed;
      const isBoilerplateInline = BOILERPLATE_RE.test(contentForBoilerplateCheck);

      if (isBoilerplateInline) {
        // Boilerplate in leading zone — strip only when a wrapper has ALREADY
        // appeared on a PREVIOUS line. This correctly handles the case where
        // boilerplate text appears BEFORE the first wrapper in the leading zone
        // (e.g. legitimate user text matching a boilerplate phrase, followed
        // later by a wrapper).
        result.push(encounteredWrapperYet ? "" : rawLine);
        continue;
      }

      if (isSubagentContent) {
        // Multiline wrapper: "You are running as a subagent..." on its own line
        // after a wrapper prefix — strip it; keep prevWasWrapper true
        result.push(""); // strip
        continue;
      }

      // Real user content — exit the leading zone permanently
      stillInLeadingZone = false;
      prevWasWrapper = false;
      encounteredWrapperYet = false;
      result.push(rawLine); // preserve
      continue;
    }

    // After leaving leading zone — always preserve
    result.push(rawLine);
  }

  let cleaned = result.join("\n");

  // 1. Strip "System: [timestamp] Channel..." lines
  cleaned = cleaned.replace(
    /^System:\s*\[[\d\-: +GMT]+\]\s+\S+\[.*?\].*$/gm,
    "",
  );

  // 2+3. Strip labeled metadata sections and standalone envelope JSON blocks
  //      via a forward fence scan. Every check is scoped to one fenced
  //      block, so cost stays linear in the input; the regexes this replaces
  //      rescanned toward end-of-input for every fence (superlinear on
  //      fence-dense messages) and could strip a keyless block whenever the
  //      envelope keys appeared anywhere later in the text.
  cleaned = stripEnvelopeJsonBlocks(cleaned);

  // 4. Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

// Label immediately preceding a fenced block that marks it as channel
// metadata. Tested against a short bounded tail slice, never the whole text.
const ENVELOPE_SECTION_LABEL_RE =
  /(?:Conversation info|Sender|Replied message)\s*\(untrusted[^)]*\):\s*$/;
const ENVELOPE_LABEL_LOOKBEHIND_CHARS = 160;

/**
 * True when the body is one balanced JSON object. Brace counting skips JSON
 * string literals and their escapes, so an unpaired brace inside a string
 * value (ordinary chat text, an emoticon) cannot shield an envelope block
 * from stripping. A body this check rejects is left in place — for a
 * stripper, the exposure direction — so it stays as permissive as one-object
 * bodies allow.
 */
function isSingleObjectBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && i < trimmed.length - 1) return false;
    }
  }
  return depth === 0 && !inString;
}

function stripEnvelopeJsonBlocks(text: string): string {
  const opener = "```json";
  let out = "";
  let cursor = 0;
  while (true) {
    const fenceStart = text.indexOf(opener, cursor);
    if (fenceStart === -1) break;
    const bodyStart = fenceStart + opener.length;
    const fenceClose = text.indexOf("```", bodyStart);
    if (fenceClose === -1) break;
    const blockEnd = fenceClose + 3;
    const body = text.slice(bodyStart, fenceClose);

    let stripFrom = -1;
    if (isSingleObjectBody(body)) {
      const lookbehindStart = Math.max(cursor, fenceStart - ENVELOPE_LABEL_LOOKBEHIND_CHARS);
      const label = ENVELOPE_SECTION_LABEL_RE.exec(text.slice(lookbehindStart, fenceStart));
      if (label) {
        stripFrom = fenceStart - label[0].length;
      } else if (/"message_id"\s*:/.test(body) && /"sender_id"\s*:/.test(body)) {
        stripFrom = fenceStart;
      }
    }

    out += text.slice(cursor, stripFrom === -1 ? blockEnd : stripFrom);
    cursor = blockEnd;
  }
  out += text.slice(cursor);
  return out;
}

// ============================================================================
// Extraction Policy (Option C — scope-glob knob)
// ============================================================================

/**
 * Operator-facing extraction policy for a scope:
 * - "full" (default): today's behavior, unchanged.
 * - "episodic-only": only "events"-class candidates are kept, regardless of
 *   grounding — a blunt backstop for scopes known to be pure play/roleplay.
 * - "none": extraction is skipped entirely, with zero LLM calls.
 */
export type ExtractionPolicyMode = "full" | "episodic-only" | "none";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Resolve the extraction policy for a scope against a scope-glob -> mode map.
 * Exact-string entries take priority over glob entries; an unmatched scope
 * (or an absent policy map) defaults to "full".
 */
export function resolveExtractionPolicy(
  scope: string,
  policy?: Record<string, ExtractionPolicyMode>,
): ExtractionPolicyMode {
  if (!policy) return "full";
  if (Object.prototype.hasOwnProperty.call(policy, scope)) {
    return policy[scope];
  }
  for (const [glob, mode] of Object.entries(policy)) {
    if (glob.includes("*") && globToRegExp(glob).test(scope)) {
      return mode;
    }
  }
  return "full";
}

/**
 * Reads a rejudge verdict's item index, accepting the strictly-integral
 * numeric string an LLM may emit for a field the prompt shows unquoted.
 * Anything else yields NaN and fails the verdict's validation.
 */
function normalizeVerdictIndex(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

/**
 * Reads a rejudge verdict's grounding as its enum token, tolerating trailing
 * punctuation and a parenthetical qualifier ("real.", "constructed (in-story)")
 * while refusing anything that does not START with the token, so a negated or
 * unrecognized value ("not real", "maybe") still invalidates the verdict.
 */
function normalizeVerdictGrounding(value: unknown): CandidateGrounding | null {
  if (typeof value !== "string") return null;
  const match = /^(real|constructed)\b/.exec(value.toLowerCase().trim());
  return match ? (match[1] as CandidateGrounding) : null;
}

/**
 * Reads a batch register as its enum token on the same terms, so a decorated
 * value ("fiction (roleplay)") keeps its scrutiny level instead of falling
 * through to the laxer default. Returns "" when no token leads the value.
 */
function normalizeRegisterToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(real|fiction|mixed)\b/.exec(value.toLowerCase().trim());
  return match ? match[1] : "";
}

// ============================================================================
// Constants
// ============================================================================

const SIMILARITY_THRESHOLD = 0.7;
const NO_SIMILAR_MEMORIES_REASON = "No similar memories found";

// Burst-lane identity of a row's serialized metadata: the mapped kind wins,
// then the reflection heading; anything else is the shared empty lane.
function laneFromMetadata(rawMeta: unknown): string {
  if (typeof rawMeta === "string" && rawMeta.length > 0) {
    try {
      const meta = JSON.parse(rawMeta) as Record<string, unknown>;
      if (typeof meta.mappedKind === "string" && meta.mappedKind.length > 0) {
        return meta.mappedKind;
      }
      if (typeof meta._reflectionHeading === "string" && meta._reflectionHeading.length > 0) {
        return meta._reflectionHeading;
      }
    } catch {
      // unparseable metadata falls through to the empty lane
    }
  }
  return "";
}
const MAX_SIMILAR_FOR_PROMPT = 3;
const MAX_MEMORIES_PER_EXTRACTION = 5;
/** Max candidates decided in one batched dedup LLM call; larger batches are chunked. */
const DEDUP_BATCH_MAX_SIZE = 10;
/** Max merge jobs written in one batched merge LLM call; larger batches are chunked. */
const MERGE_BATCH_MAX_SIZE = 10;
const VALID_DECISIONS = new Set<string>([
  "create",
  "merge",
  "skip",
  "support",
  "contextualize",
  "contradict",
  "supersede",
]);

// ============================================================================
// Smart Extractor
// ============================================================================

/** Entry data for a memory that was just created or merged, as persisted to the store. */
export interface PersistedMemoryEntry {
  text: string;
  category: string;
  scope: string;
  timestamp: number;
}

/** Context describing which pipeline produced a PersistedMemoryEntry. */
export interface PersistedMemoryMeta {
  source: string;
  agentId?: string;
}

export interface SmartExtractorConfig {
  /** User identifier for extraction prompt. */
  user?: string;
  /** Minimum conversation messages before extraction triggers. */
  extractMinMessages?: number;
  /** Maximum characters of conversation text to process. */
  extractMaxChars?: number;
  /** Per-call chunk bound for the batched dedup decider and merge writer (1-50, default 10). */
  batchChunkSize?: number;
  /** Default scope for new memories. */
  defaultScope?: string;
  /** Logger function. */
  log?: (msg: string) => void;
  /** Debug logger function. */
  debugLog?: (msg: string) => void;
  /** Optional embedding-based noise prototype bank for language-agnostic noise filtering. */
  noiseBank?: NoisePrototypeBank;
  /** Facts reserved for workspace-managed USER.md should never enter LanceDB. */
  workspaceBoundary?: WorkspaceBoundaryConfig;
  /** Optional admission-control governance layer before downstream dedup/persistence. */
  admissionControl?: AdmissionControlConfig;
  /**
   * Pre-built admission controller, constructed independently of the
   * extractor (e.g. by createAdmissionController) so admission gating works
   * the same whether or not smart extraction itself is enabled. When
   * provided, this instance is used as-is; the extractor never builds its
   * own. Null/omitted means admission control is unavailable.
   */
  admissionController?: AdmissionController | null;
  /** Optional scope-glob -> extraction policy map (Option C). Unmatched scopes default to "full". */
  extractionPolicy?: Record<string, ExtractionPolicyMode>;
  /** Optional sink for durable reject-audit logging. */
  onAdmissionRejected?: (entry: AdmissionRejectionAuditEntry) => Promise<void> | void;
  /** Optional sink invoked after a memory is successfully created or merged (e.g. markdown mirror). */
  onPersisted?: (entry: PersistedMemoryEntry, meta: PersistedMemoryMeta) => Promise<void> | void;
  /** Assistant turns are capture-eligible sources (captureAssistant=true): flips the prompt's assistant-block rule. */
  captureAssistantEligible?: boolean;
}

export interface ExtractPersistOptions {
  /** Target scope for newly created memories. */
  scope?: string;
  /**
   * Optional store-layer scope filter override used for dedup/merge reads.
   * - omit the field to default reads to `[scope ?? defaultScope]`
   * - set `undefined` explicitly to preserve trusted full-bypass callers
   * - pass `[]` to force deny-all reads (match nothing)
   * - pass a non-empty array to restrict reads to those scopes
   */
  scopeFilter?: string[];
  /** Agent identifier forwarded to onPersisted, resolved the same way callers resolve it for other sinks. */
  agentId?: string;
  /**
   * This call's conversation as ordered, role-tagged turns. When provided,
   * the extraction prompt renders each turn wholly wrapped in
   * <user_message>/<assistant_message> tags instead of prompting on the flat
   * joined text, so every line has an unambiguous speaker.
   */
  conversationTurns?: ConversationTurn[];
  /**
   * Count of leading `conversationTurns` that carry a referent the caller
   * pulled in deliberately (the remember-this prepend). Those turns are the
   * OLDEST in the transcript, so the budget walk must not sacrifice them
   * first: they are guaranteed a share of `extractMaxChars`.
   */
  protectedPrefixTurns?: number;
}

/**
 * Formats one existing-memory candidate for the dedup prompt's numbered
 * list. Continuation lines of a multi-line overview are indented to match
 * the "Overview: " label so its markdown stays nested under this item
 * instead of landing flush-left and visually escaping the list.
 */
export function formatExistingMemoryForDedupPrompt(
  index: number,
  category: string,
  abstract: string,
  overview: string,
  score: number,
): string {
  const indentedOverview = overview.replace(/\n/g, "\n   ");
  return `${index}. [${category}] ${abstract}\n   Overview: ${indentedOverview}\n   Score: ${score.toFixed(3)}`;
}

export class SmartExtractor {
  private log: (msg: string) => void;
  private debugLog: (msg: string) => void;
  private admissionController: AdmissionController | null;
  private persistAdmissionAudit: boolean;
  private onAdmissionRejected?: (entry: AdmissionRejectionAuditEntry) => Promise<void> | void;
  private onPersisted?: (entry: PersistedMemoryEntry, meta: PersistedMemoryMeta) => Promise<void> | void;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private llm: LlmClient,
    private config: SmartExtractorConfig = {},
  ) {
    this.log = config.log ?? ((msg: string) => console.log(msg));
    this.debugLog = config.debugLog ?? (() => { });
    this.persistAdmissionAudit =
      config.admissionControl?.enabled === true &&
      config.admissionControl.auditMetadata !== false;
    this.onAdmissionRejected = config.onAdmissionRejected;
    this.onPersisted = config.onPersisted;
    this.admissionController = config.admissionController ?? null;
  }

  /**
   * Expose the admission controller so sibling write paths (reflection
   * mapped rows) gate through the same instance and config as extraction
   * candidates. Null when admission control is disabled.
   */
  getAdmissionController(): AdmissionController | null {
    return this.admissionController;
  }

  /** Whether admitted entries should carry the admission audit in metadata. */
  shouldPersistAdmissionAudit(): boolean {
    return this.persistAdmissionAudit;
  }

  /**
   * Notify the onPersisted sink (e.g. markdown mirror) after a successful
   * create or merge. Fire-and-forget from the caller's perspective: awaited
   * here so ordering is deterministic, but errors are swallowed so a sink
   * failure never fails the underlying store operation.
   */
  private async notifyPersisted(
    entry: PersistedMemoryEntry,
    source: string,
    agentId?: string,
  ): Promise<void> {
    if (!this.onPersisted) return;
    try {
      await this.onPersisted(entry, { source, agentId });
    } catch (err) {
      this.log(
        `memory-pro: smart-extractor: onPersisted callback failed for entry "${entry.text.slice(0, 40)}": ${String(err)}`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  /**
   * Extract memories from a conversation text and persist them.
   * Returns extraction statistics.
   */
  async extractAndPersist(
    conversationText: string,
    sessionKey: string = "unknown",
    options: ExtractPersistOptions = {},
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 };
    const targetScope = options.scope ?? this.config.defaultScope ?? "global";
    // Distinguish "no override supplied" from explicit bypass/override values.
    // - omitted `scopeFilter` => default to `[targetScope]`
    // - explicit `undefined` => preserve full-bypass semantics for trusted callers
    // - explicit `[]` or non-empty array => pass through unchanged
    const hasExplicitScopeFilter = "scopeFilter" in options;
    const scopeFilter = hasExplicitScopeFilter
      ? options.scopeFilter
      : [targetScope];
    const agentId = options.agentId;

    // Option C: scope-glob extraction policy — "none" skips extraction
    // entirely, with zero LLM calls, before grounding is ever considered.
    const policyMode = resolveExtractionPolicy(targetScope, this.config.extractionPolicy);
    if (policyMode === "none") {
      this.log(
        `memory-pro: smart-extractor: extraction policy "none" for scope ${targetScope}, skipping extraction`,
      );
      return stats;
    }

    // Step 1: LLM extraction
    const extraction = await this.extractCandidates(
      conversationText,
      policyMode,
      options.conversationTurns,
      options.protectedPrefixTurns,
    );
    const candidates = extraction.candidates;

    if (candidates.length === 0) {
      this.log("memory-pro: smart-extractor: no memories extracted");
      if (extraction.status === "empty_input") {
        // No LLM call was made, so the caller's rate limiter must not be charged.
        stats.skippedNoInput = true;
      }
      if (extraction.status === "ok" && extraction.rawCandidateCount === 0) {
        // LLM genuinely returned zero candidates → strongest noise signal → feedback to noise bank
        this.learnAsNoise(conversationText);
      } else if (extraction.status === "ok") {
        // The model DID emit candidates; validation, grounding, or the batch
        // contradiction check dropped them all. That is a policy verdict about
        // those candidates, not evidence the conversation is noise — learning
        // it as noise would pre-filter similar real content away from future
        // extractions.
        this.log(
          `memory-pro: smart-extractor: skipping noise-bank learning (validation emptied the batch, raw=${extraction.rawCandidateCount})`,
        );
      } else {
        this.debugLog(
          `memory-pro: smart-extractor: skipping noise-bank learning (status=${extraction.status})`,
        );
        stats.extractionFailed = true;
      }
      return stats;
    }

    this.log(
      `memory-pro: smart-extractor: extracted ${candidates.length} candidate(s)`,
    );

    // Step 1b: Batch-internal dedup — embed candidate abstracts and remove near-duplicates
    //          before expensive per-candidate LLM dedup calls (see src/batch-dedup.ts)
    const capped = candidates.slice(0, MAX_MEMORIES_PER_EXTRACTION);
    let survivingCandidates = capped;
    try {
      const abstracts = capped.map((c) => c.abstract);
      const vectors = await this.embedder.embedBatch(abstracts);
      const safeVectors = vectors.map((v) => v || []);
      const dedupResult = batchDedup(abstracts, safeVectors);
      if (dedupResult.duplicateIndices.length > 0) {
        survivingCandidates = dedupResult.survivingIndices.map((i) => capped[i]);
        stats.skipped += dedupResult.duplicateIndices.length;
        this.log(
          `memory-pro: smart-extractor: batchDedup dropped ${dedupResult.duplicateIndices.length} near-duplicate(s), ${survivingCandidates.length} survivor(s)`,
        );
      }
    } catch (err) {
      this.log(
        `memory-pro: smart-extractor: batchDedup failed, proceeding without batch dedup: ${String(err)}`,
      );
    }

    // Step 2: Process each surviving candidate through dedup pipeline.
    //
    // Optimization: filter boundary-excluded candidates BEFORE batch embedding
    // to avoid wasting embed API calls on candidates that will be skipped.
    // See MR1 from code review.
    const processableCandidates: { index: number; candidate: CandidateMemory }[] = [];
    for (let i = 0; i < survivingCandidates.length; i++) {
      const c = survivingCandidates[i];
      if (
        isUserMdExclusiveMemory(
          {
            memoryCategory: c.category,
            abstract: c.abstract,
            content: c.content,
          },
          this.config.workspaceBoundary,
        )
      ) {
        stats.skipped += 1;
        stats.boundarySkipped = (stats.boundarySkipped ?? 0) + 1;
        this.log(
          `memory-pro: smart-extractor: skipped USER.md-exclusive [${c.category}] ${c.abstract.slice(0, 60)}`,
        );
        continue;
      }
      processableCandidates.push({ index: i, candidate: c });
    }

    // Pre-compute vectors for every processable candidate (profile included:
    // its always-merge path consumes the vector too) in a single batch API
    // call to reduce embedding round-trips from N to 1.
    const precomputedVectors = new Map<number, number[]>();
    const candidatesToEmbed: { index: number; text: string }[] = [];
    for (const { index, candidate } of processableCandidates) {
      candidatesToEmbed.push({ index, text: `${candidate.abstract} ${candidate.content}` });
    }
    if (candidatesToEmbed.length > 0) {
      try {
        const batchTexts = candidatesToEmbed.map((e) => e.text);
        const batchVectors = await this.embedder.embedBatch(batchTexts);
        for (let j = 0; j < candidatesToEmbed.length; j++) {
          const vec = batchVectors[j];
          if (vec && vec.length > 0) {
            precomputedVectors.set(candidatesToEmbed[j].index, vec);
          }
        }
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: batch pre-embed failed, will embed individually: ${String(err)}`,
        );
      }
    }

    // When utilityMode is "batch", score admission utility for every
    // candidate in this extraction up front, with one LLM call per chunk of
    // up to 10 candidates, instead of one call per candidate inside the
    // sequential processCandidate loop below. Profile candidates ride the
    // same batched call (one-call-per-stage topology): handleProfileMerge
    // consumes the precomputed verdict instead of issuing its own singular
    // call, falling back to the in-merge evaluation only when no precomputed
    // verdict exists (standalone mode, or a failed batch).
    const precomputedAdmissions = new Map<number, AdmissionEvaluation>();
    if (this.admissionController && this.config.admissionControl?.utilityMode === "batch") {
      // A candidate whose batch embedding came back missing/empty must not
      // enter the batch: an empty vector skips similarity search and records
      // novelty=1, and processCandidate would later reuse that stale verdict
      // even after recovering the individual embedding. Leaving the entry
      // unset keeps the inline evaluation path, which re-runs admission with
      // the recovered vector.
      const batchable = processableCandidates.filter(({ index }) => {
        const vector = precomputedVectors.get(index);
        return Boolean(vector && vector.length > 0);
      });
      if (batchable.length > 0) {
        const batchItems = batchable.map(({ index, candidate }) => ({
          candidate,
          candidateVector: precomputedVectors.get(index) ?? [],
          conversationText,
          scopeFilter: scopeFilter ?? [targetScope],
        }));
        try {
          const evaluations = await this.admissionController.evaluateBatch(batchItems);
          batchable.forEach(({ index }, i) => {
            precomputedAdmissions.set(index, evaluations[i]);
          });
        } catch (err) {
          this.log(
            `memory-pro: smart-extractor: batch admission evaluation failed, falling back to per-candidate: ${String(err)}`,
          );
        }
      }
    }

    // Hoist non-batch admission evaluation ahead of the loop so the admitted
    // set is known before the batched dedup call below — the per-candidate
    // call count is unchanged, only the timing moves. Batch mode already
    // populated precomputedAdmissions above. A failed pre-evaluation leaves
    // the entry unset so processCandidate's inline evaluation still runs.
    if (this.admissionController && this.config.admissionControl?.utilityMode !== "batch") {
      for (const { index, candidate } of processableCandidates) {
        if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) continue;
        const vector = precomputedVectors.get(index);
        if (!vector || vector.length === 0) continue;
        try {
          precomputedAdmissions.set(
            index,
            await this.admissionController.evaluate({
              candidate,
              candidateVector: vector,
              conversationText,
              scopeFilter: scopeFilter ?? [targetScope],
            }),
          );
        } catch (err) {
          this.log(
            `memory-pro: smart-extractor: admission pre-evaluation failed, deferring to inline evaluation: ${String(err)}`,
          );
        }
      }
    }

    // Batched dedup decider: run the free vector pre-filter per admitted
    // non-profile candidate, then decide every candidate that needs an LLM
    // verdict in ONE dedup call (chunked past DEDUP_BATCH_MAX_SIZE). Zero
    // admitted candidates → zero dedup calls. Candidates without a
    // precomputed vector or admission verdict keep the inline single-call
    // path inside processCandidate as their degraded fallback.
    const precomputedDedups = new Map<number, DedupResult>();
    {
      const dedupLlmItems: Array<{
        index: number;
        candidate: CandidateMemory;
        topSimilar: MemorySearchResult[];
      }> = [];
      for (const { index, candidate } of processableCandidates) {
        if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) continue;
        const vector = precomputedVectors.get(index);
        if (!vector || vector.length === 0) continue;
        if (this.admissionController) {
          const admission = precomputedAdmissions.get(index);
          if (!admission || admission.decision === "reject") continue;
        }
        try {
          const prefilter = await this.dedupPrefilter(candidate, vector, scopeFilter);
          if (prefilter.shortCircuit) {
            precomputedDedups.set(index, prefilter.shortCircuit);
          } else {
            dedupLlmItems.push({ index, candidate, topSimilar: prefilter.topSimilar });
          }
        } catch (err) {
          this.log(
            `memory-pro: smart-extractor: dedup pre-filter failed, deferring to inline dedup: ${String(err)}`,
          );
        }
      }
      if (dedupLlmItems.length > 0) {
        const verdicts = await this.llmDedupDecisionBatch(dedupLlmItems);
        dedupLlmItems.forEach((item, i) => {
          precomputedDedups.set(item.index, verdicts[i]);
        });
      }
    }

    const createEntries: StoreEntry[] = [];
    const pendingSupersedeInvalidations: PendingSupersedeInvalidation[] = [];
    const pendingMerges: PendingMergeJob[] = [];

    for (const { index, candidate } of processableCandidates) {
      try {
        await this.processCandidate(
          candidate,
          conversationText,
          sessionKey,
          stats,
          targetScope,
          scopeFilter,
          precomputedVectors.get(index),
          createEntries,
          pendingSupersedeInvalidations,
          agentId,
          precomputedAdmissions.get(index),
          precomputedDedups.get(index),
          pendingMerges,
        );
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: failed to process candidate [${candidate.category}]: ${String(err)}`,
        );
      }
    }

    // Batched merge writer: every merge queued above (dedup verdicts and
    // profile merges alike) is written with ONE merge-memory call, chunked
    // past MERGE_BATCH_MAX_SIZE. Zero queued merges → zero writer calls.
    await this.flushPendingMerges(pendingMerges, stats);

    if (createEntries.length > 0) {
      const createdEntries = await this.bulkStoreAndValidate(createEntries);
      if (createdEntries) {
        await this.applyPendingSupersedeInvalidations(
          createEntries,
          createdEntries,
          pendingSupersedeInvalidations,
          stats,
        );
        for (const created of createdEntries) {
          await this.notifyPersisted(
            {
              text: created.text,
              category: created.category,
              scope: created.scope,
              timestamp: created.timestamp,
            },
            "smart-extraction",
            agentId,
          );
        }
      } else if (pendingSupersedeInvalidations.length > 0) {
        this.log(
          "memory-pro: smart-extractor: supersede invalidation skipped because bulkStore() did not return created entries",
        );
      }
    }

    stats.settledOutcomes =
      stats.created +
        stats.merged +
        stats.skipped +
        (stats.rejected ?? 0) +
        (stats.supported ?? 0) +
        (stats.superseded ?? 0) >
      0;
    return stats;
  }

  /**
   * Uniform-pipeline entry for candidates whose extraction AND admission
   * already happened in another lane (the reflection writer's mapped rows:
   * distilled by the reflection model, gated by gateMappedReflectionEntries).
   * From here on they take exactly the extraction candidates' path --
   * batched dedup decider, verdict handling, batched merge writer, bulk
   * create -- so a duplicate mapped row MERGES into its target instead of
   * landing beside it.
   *
   * Each item supplies its own store-entry builder: a CREATE-shaped verdict
   * persists the caller's entry (reflection metadata intact), while
   * merge/supersede/support/contextualize/contradict operate on existing
   * rows through the shared machinery. Callers own persistence
   * notifications for created rows (the returned entries), keeping their
   * lane-specific journal labels.
   */
  async persistGatedCandidates(
    items: Array<{
      candidate: CandidateMemory;
      vector: number[];
      buildEntry: (vector: number[]) => StoreEntry;
    }>,
    options: {
      sessionKey?: string;
      targetScope: string;
      scopeFilter?: string[];
      agentId?: string;
      conversationText?: string;
    },
  ): Promise<{ stats: ExtractionStats; createdEntries: MemoryEntry[] }> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0, boundarySkipped: 0 };
    const sessionKey = options.sessionKey ?? "reflection";
    const targetScope = options.targetScope;
    const scopeFilter = options.scopeFilter ?? [targetScope];
    const conversationText = options.conversationText ?? "";

    for (const item of items) {
      const prebuilt = item.buildEntry(item.vector);
      this.externalEntryBuilders.set(item.candidate, {
        build: item.buildEntry,
        prebuilt,
        ...parseEntryAdmissionEvidence(prebuilt),
      });
    }

    // Admission already ran in the caller's gate; the evaluation handed to
    // processCandidate only tells it not to score again. Its audit is the
    // CALLER'S OWN record (parsed from the built entry) — never a synthetic
    // stub — so anything persisted downstream carries the real gate audit.
    const preGatedFor = (candidate: CandidateMemory): AdmissionEvaluation =>
      ({
        decision: "pass_to_dedup",
        audit: this.externalEntryBuilders.get(candidate)?.audit,
      }) as unknown as AdmissionEvaluation;

    // Same-burst twin guard: collapse EXACT normalized duplicates within one
    // caller lane. The lane identity comes from the prebuilt entry's mapped
    // kind (its reflection heading as fallback): lessons and decisions share
    // one candidate category while carrying different kinds, headings,
    // importance, and decay, so a category+text key would deterministically
    // drop the later lane's row. Anything short of textual identity within a
    // lane proceeds to the dedup judge.
    const burstLaneOf = (candidate: CandidateMemory): string =>
      laneFromMetadata(this.externalEntryBuilders.get(candidate)?.prebuilt?.metadata);
    const seenBurstKeys = new Set<string>();
    const surviving: typeof items = [];
    for (const item of items) {
      const key = JSON.stringify([
        burstLaneOf(item.candidate),
        item.candidate.category,
        item.candidate.abstract.toLowerCase().replace(/\s+/g, " ").trim(),
      ]);
      if (seenBurstKeys.has(key)) {
        stats.skipped++;
        this.log(
          `memory-pro: smart-extractor: gated-candidate burst twin dropped [${item.candidate.category}]`,
        );
        continue;
      }
      seenBurstKeys.add(key);
      surviving.push(item);
    }

    // Same-lane siblings earlier in one burst act as virtual dedup
    // neighbors: with no similar row in the store yet, two related mapped
    // rows arriving together would otherwise BOTH short-circuit to CREATE
    // and the semantic judge would never see the pair. A verdict against a
    // sibling resolves after bulkStore assigns the sibling's real id, then
    // reuses the normal merge/support machinery.
    const BURST_SIBLING_PREFIX = "burst-sibling:";
    const laneKeyOf = (candidate: CandidateMemory): string =>
      JSON.stringify([burstLaneOf(candidate), candidate.category]);
    const cosineOf = (a: number[], b: number[]): number => {
      if (a.length === 0 || a.length !== b.length) {
        return 0;
      }
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let d = 0; d < a.length; d++) {
        dot += a[d] * b[d];
        normA += a[d] * a[d];
        normB += b[d] * b[d];
      }
      if (normA === 0 || normB === 0) {
        return 0;
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };
    const burstSiblingsFor = (index: number): MemorySearchResult[] => {
      const { candidate, vector } = surviving[index];
      if (!vector || vector.length === 0) {
        return [];
      }
      const lane = laneKeyOf(candidate);
      const out: MemorySearchResult[] = [];
      for (let j = 0; j < index; j++) {
        const sibling = surviving[j];
        if (laneKeyOf(sibling.candidate) !== lane) {
          continue;
        }
        const score = cosineOf(vector, sibling.vector || []);
        if (score < SIMILARITY_THRESHOLD) {
          continue;
        }
        const prebuilt = this.externalEntryBuilders.get(sibling.candidate)?.prebuilt;
        const entryCategory =
          typeof prebuilt?.category === "string"
            ? (prebuilt.category as import("./store.js").MemoryEntry["category"])
            : this.mapToStoreCategory(sibling.candidate.category);
        out.push({
          entry: {
            id: `${BURST_SIBLING_PREFIX}${j}`,
            text: sibling.candidate.abstract,
            vector: [],
            category: entryCategory,
            scope: typeof prebuilt?.scope === "string" ? prebuilt.scope : targetScope,
            importance: typeof prebuilt?.importance === "number" ? prebuilt.importance : 0.8,
            timestamp: Date.now(),
            metadata: typeof prebuilt?.metadata === "string" ? prebuilt.metadata : "{}",
          },
          score,
        });
      }
      return out;
    };

    const precomputedDedups = new Map<number, DedupResult>();
    const dedupLlmItems: Array<{
      index: number;
      candidate: CandidateMemory;
      topSimilar: MemorySearchResult[];
    }> = [];
    for (let i = 0; i < surviving.length; i++) {
      const { candidate, vector } = surviving[i];
      const siblings = burstSiblingsFor(i);
      try {
        const prefilter = await this.dedupPrefilter(candidate, vector, scopeFilter);
        const yieldsToSiblings = prefilter.shortCircuit?.decision === "create" && siblings.length > 0;
        if (prefilter.shortCircuit && !yieldsToSiblings) {
          // A create-decision short-circuit is authoritative about STORED
          // rows only (nothing similar stored yet, or the preference guard
          // ruled every stored row a different item slot) — it says nothing
          // about burst siblings, so eligible siblings still get
          // adjudicated, alone: the short circuit carries no stored rows.
          // Non-create short-circuits resolve the candidate and stand.
          precomputedDedups.set(i, prefilter.shortCircuit);
        } else {
          const topSimilar = [...prefilter.topSimilar, ...siblings]
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          dedupLlmItems.push({ index: i, candidate, topSimilar });
        }
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: gated-candidate dedup pre-filter failed, deferring to inline dedup: ${String(err)}`,
        );
      }
    }
    if (dedupLlmItems.length > 0) {
      const verdicts = await this.llmDedupDecisionBatch(dedupLlmItems);
      dedupLlmItems.forEach((item, i) => {
        precomputedDedups.set(item.index, verdicts[i]);
      });
    }

    const createEntries: StoreEntry[] = [];
    const pendingSupersedeInvalidations: PendingSupersedeInvalidation[] = [];
    const pendingMerges: PendingMergeJob[] = [];
    const pendingSiblingVerdicts: Array<{
      candidate: CandidateMemory;
      vector: number[];
      siblingIndex: number;
      decision: "merge" | "support";
      reason: string;
      contextLabel?: string;
    }> = [];
    const createSlotBySurviving = new Map<number, number>();
    // Durable-anchor bookkeeping for deferred verdict chains: a survivor
    // that itself merged/supported/skipped into an earlier sibling anchors
    // at that sibling (chased transitively at resolution time), and one
    // whose verdict targeted an existing stored row anchors at that row.
    const anchorSiblingBySurviving = new Map<number, number>();
    const anchorStoredIdBySurviving = new Map<number, string>();

    for (let i = 0; i < surviving.length; i++) {
      const { candidate, vector } = surviving[i];
      const pre = precomputedDedups.get(i);
      if (pre?.matchId && pre.matchId.startsWith(BURST_SIBLING_PREFIX)) {
        const siblingIndex = Number(pre.matchId.slice(BURST_SIBLING_PREFIX.length));
        const resolvable = Number.isInteger(siblingIndex) && siblingIndex >= 0 && siblingIndex < i;
        if (pre.decision === "skip" && resolvable) {
          anchorSiblingBySurviving.set(i, siblingIndex);
          stats.skipped++;
          this.log(
            `memory-pro: smart-extractor: gated candidate judged same-burst duplicate of an earlier sibling [${candidate.category}]`,
          );
          continue;
        }
        if ((pre.decision === "merge" || pre.decision === "support") && resolvable) {
          anchorSiblingBySurviving.set(i, siblingIndex);
          pendingSiblingVerdicts.push({
            candidate,
            vector,
            siblingIndex,
            decision: pre.decision,
            reason: pre.reason,
            contextLabel: pre.contextLabel,
          });
          continue;
        }
        // Any other verdict against a not-yet-persisted sibling row keeps
        // the caller's entry: fail open to a plain create.
        precomputedDedups.set(i, {
          decision: "create",
          reason: "sibling verdict fallback (unsupported decision for a pending row)",
        });
      }
      if (
        pre?.matchId &&
        !pre.matchId.startsWith(BURST_SIBLING_PREFIX) &&
        (pre.decision === "merge" || pre.decision === "support" || pre.decision === "skip")
      ) {
        anchorStoredIdBySurviving.set(i, pre.matchId);
      }
      const createCountBefore = createEntries.length;
      try {
        await this.processCandidate(
          candidate,
          conversationText,
          sessionKey,
          stats,
          targetScope,
          scopeFilter,
          vector,
          createEntries,
          pendingSupersedeInvalidations,
          options.agentId,
          preGatedFor(candidate),
          precomputedDedups.get(i),
          pendingMerges,
        );
        if (createEntries.length === createCountBefore + 1) {
          createSlotBySurviving.set(i, createCountBefore);
        }
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: failed to process gated candidate [${candidate.category}]: ${String(err)}`,
        );
        // Fail open: this candidate already passed the caller's admission
        // gate, so a processing failure (dedup search, verdict handling)
        // must not silently drop it — store the caller-built row as-is.
        const ext = this.externalEntryBuilders.get(candidate);
        if (ext) {
          createEntries.push(ext.prebuilt ?? ext.build(vector));
          createSlotBySurviving.set(i, createEntries.length - 1);
          stats.created++;
          this.log(
            `memory-pro: smart-extractor: fail-open create for gated candidate after processing failure [${candidate.category}]`,
          );
        }
      }
    }

    await this.flushPendingMerges(pendingMerges, stats, createEntries);

    let createdEntries: MemoryEntry[] = [];
    if (createEntries.length > 0) {
      const stored = await this.bulkStoreAndValidate(createEntries);
      if (stored) {
        createdEntries = stored;
        await this.applyPendingSupersedeInvalidations(createEntries, stored, pendingSupersedeInvalidations, stats);
      } else if (pendingSupersedeInvalidations.length > 0) {
        this.log(
          "memory-pro: smart-extractor: gated-candidate supersede invalidation skipped because bulkStore() did not return created entries",
        );
      }
    }

    // Deferred same-burst verdicts: the sibling's row now has a real id, so
    // merge/support resolve through the normal machinery. Anything that
    // cannot be resolved keeps the caller's row (fail open to create).
    if (pendingSiblingVerdicts.length > 0) {
      const claimedIds = new Set<string>();
      const resolvedIdBySurviving = new Map<number, string | undefined>();
      const resolveSlotId = (slot: number): string | undefined => {
        if (createdEntries.length === createEntries.length) {
          return createdEntries[slot]?.id;
        }
        // bulkStore may filter entries, shifting positions: fall back to the
        // first unclaimed row with the same text AND the same lane/category
        // identity — identical text is legal across lanes, so a text-only
        // match could bind the verdict to another lane's row.
        const want = createEntries[slot];
        const hit = want
          ? createdEntries.find(
              (e) =>
                e.text === want.text &&
                e.category === want.category &&
                laneFromMetadata(e.metadata) === laneFromMetadata(want.metadata) &&
                !claimedIds.has(e.id),
            )
          : undefined;
        return hit?.id;
      };
      const storedIdForSurviving = (survivingIndex: number): string | undefined => {
        // Verdicts may share one surviving anchor: the first resolution is
        // cached per index so every later verdict reuses the same row.
        // claimedIds only keeps DISTINCT surviving entries apart in the
        // filtered-result fallback — it must never exclude the row an index
        // already resolved. A survivor without its own create slot resolves
        // through its durable anchor: sibling chains are chased transitively
        // (indices strictly decrease, so chains terminate) and may end at a
        // created row or at an existing stored row.
        if (resolvedIdBySurviving.has(survivingIndex)) {
          return resolvedIdBySurviving.get(survivingIndex);
        }
        const resolve = (): string | undefined => {
          let index = survivingIndex;
          for (let hops = 0; hops <= surviving.length; hops++) {
            if (index !== survivingIndex && resolvedIdBySurviving.has(index)) {
              return resolvedIdBySurviving.get(index);
            }
            const slot = createSlotBySurviving.get(index);
            if (slot !== undefined) {
              const id = resolveSlotId(slot);
              if (index !== survivingIndex) {
                // A chain terminal is a shared anchor: cache and claim it
                // under its own index so other chains landing here reuse
                // the row instead of consuming another twin.
                if (id) {
                  claimedIds.add(id);
                }
                resolvedIdBySurviving.set(index, id);
              }
              return id;
            }
            const storedId = anchorStoredIdBySurviving.get(index);
            if (storedId) {
              return storedId;
            }
            const next = anchorSiblingBySurviving.get(index);
            if (next === undefined) {
              return undefined;
            }
            index = next;
          }
          return undefined;
        };
        const id = resolve();
        if (id) {
          claimedIds.add(id);
        }
        resolvedIdBySurviving.set(survivingIndex, id);
        return id;
      };
      const followupMerges: PendingMergeJob[] = [];
      const followupCreates: StoreEntry[] = [];
      for (const pending of pendingSiblingVerdicts) {
        const ext = this.externalEntryBuilders.get(pending.candidate);
        const audit: AdmissionWriteEvidence | undefined = ext?.audit ?? ext?.failOpen;
        const failOpenCreate = async (why: string) => {
          followupCreates.push(
            await this.externalOrBuiltFallbackEntry(pending.candidate, targetScope, sessionKey, pending.vector, audit),
          );
          stats.created++;
          this.log(
            `memory-pro: smart-extractor: ${why}, storing gated candidate as new [${pending.candidate.category}]`,
          );
        };
        try {
          const targetId = storedIdForSurviving(pending.siblingIndex);
          if (!targetId) {
            await failOpenCreate("same-burst sibling row not persisted");
            continue;
          }
          if (pending.decision === "support") {
            const outcome = await this.handleSupport(
              targetId,
              { session: sessionKey, timestamp: Date.now() },
              pending.reason,
              pending.contextLabel,
              scopeFilter,
              audit,
            );
            if (outcome === "supported") {
              stats.supported = (stats.supported ?? 0) + 1;
            } else {
              await failOpenCreate("same-burst support target vanished");
            }
            continue;
          }
          const queued = await this.queueMergeJob(
            followupMerges,
            pending.candidate,
            targetId,
            targetScope,
            scopeFilter,
            pending.contextLabel,
            audit,
            followupCreates,
            options.agentId,
          );
          if (queued === "created") {
            stats.created++;
          }
        } catch (err) {
          // A deferred verdict degrades ALONE: the candidate already passed
          // the caller's admission gate, so a throwing store read/write on
          // one resolution must fall open to that candidate's own create —
          // never reject the whole persistence call, discard follow-up work
          // queued by earlier verdicts, or skip the verdicts still pending.
          // Push paths above enqueue only after their awaits resolve, so a
          // caught verdict has enqueued nothing yet and the fallback row
          // lands exactly once.
          this.log(
            `memory-pro: smart-extractor: deferred sibling ${pending.decision} failed: ${String(err)}`,
          );
          try {
            await failOpenCreate(`deferred sibling ${pending.decision} unresolved`);
          } catch (fallbackErr) {
            this.log(
              `memory-pro: smart-extractor: fail-open create failed for a deferred sibling verdict [${pending.candidate.category}]: ${String(fallbackErr)}`,
            );
          }
        }
      }
      if (followupMerges.length > 0) {
        await this.flushPendingMerges(followupMerges, stats, followupCreates);
      }
      if (followupCreates.length > 0) {
        const extra = await this.bulkStoreAndValidate(followupCreates);
        if (extra) {
          createdEntries = createdEntries.concat(extra);
        }
      }
    }

    return { stats, createdEntries };
  }

  // --------------------------------------------------------------------------
  // Embedding Noise Pre-Filter
  // --------------------------------------------------------------------------

  private async bulkStoreAndValidate(entries: StoreEntry[]): Promise<MemoryEntry[] | undefined> {
    const beforeCount = await this.readStoreCount("before bulkStore");
    const storedEntries = await this.store.bulkStore(entries);

    if (!Array.isArray(storedEntries)) {
      this.debugLog(
        "memory-pro: smart-extractor: skipping bulkStore persistence validation: bulkStore() did not return stored entries",
      );
      return undefined;
    }

    if (storedEntries.length !== entries.length) {
      this.log(
        `memory-pro: smart-extractor: bulkStore validation warning: queued ${entries.length} create(s) but bulkStore accepted ${storedEntries.length}`,
      );
    }

    if (storedEntries.length === 0) {
      return storedEntries;
    }

    const afterCount = await this.readStoreCount("after bulkStore");
    if (beforeCount === null || afterCount === null) {
      return storedEntries;
    }

    const observedDelta = afterCount - beforeCount;
    if (observedDelta >= storedEntries.length) {
      return storedEntries;
    }

    const missingIds = await this.findMissingStoredIds(storedEntries);
    if (missingIds.length === 0) {
      this.debugLog(
        `memory-pro: smart-extractor: bulkStore row-count delta ${observedDelta}/${storedEntries.length} but all returned IDs are readable; likely concurrent delete/compaction`,
      );
      return storedEntries;
    }

    const sample = missingIds.slice(0, 3).map((id) => id.slice(0, 8)).join(", ");
    this.log(
      `memory-pro: smart-extractor: bulkStore validation warning: expected row delta >= ${storedEntries.length}, observed ${observedDelta} (before=${beforeCount}, after=${afterCount}); missing returned IDs=${missingIds.length}${sample ? ` sample=${sample}` : ""}`,
    );
    return storedEntries;
  }

  private async readStoreCount(context: string): Promise<number | null> {
    const count = (this.store as unknown as { count?: () => Promise<number> }).count;
    if (typeof count !== "function") {
      this.debugLog(
        `memory-pro: smart-extractor: skipping bulkStore row-count validation (${context}): count() unavailable`,
      );
      return null;
    }

    try {
      const value = await count.call(this.store);
      if (Number.isFinite(value)) {
        return value;
      }
      this.debugLog(
        `memory-pro: smart-extractor: skipping bulkStore row-count validation (${context}): non-finite count ${String(value)}`,
      );
    } catch (err) {
      this.debugLog(
        `memory-pro: smart-extractor: skipping bulkStore row-count validation (${context}): ${String(err)}`,
      );
    }
    return null;
  }

  private async findMissingStoredIds(entries: import("./store.js").MemoryEntry[]): Promise<string[]> {
    const hasId = (this.store as unknown as { hasId?: (id: string) => Promise<boolean> }).hasId;
    if (typeof hasId !== "function") {
      return entries.map((entry) => entry.id);
    }

    const missing: string[] = [];
    for (const entry of entries) {
      try {
        if (!await hasId.call(this.store, entry.id)) {
          missing.push(entry.id);
        }
      } catch {
        missing.push(entry.id);
      }
    }
    return missing;
  }

  /**
   * Filter out texts that match cheap static noise patterns first, then
   * filter remaining texts that match noise prototypes by embedding similarity.
   * Long texts (>300 chars) are passed through without embedding checks.
   * Embedding checks are only active when noiseBank is configured and initialized.
   *
   * Uses batch embedding to reduce API round-trips from N to 1.
   */
  async filterNoiseByEmbedding(texts: string[]): Promise<string[]> {
    return (await this.filterNoiseByEmbeddingWithIndices(texts)).texts;
  }

  /**
   * Same filter, but also reports which input positions survived, so callers
   * that track per-text provenance (turn attribution) can follow a surviving
   * text back to the exact copy it came from.
   */
  async filterNoiseByEmbeddingWithIndices(
    texts: string[],
  ): Promise<{ texts: string[]; keptIndices: number[] }> {
    const staticFiltered: string[] = [];
    const staticKeptIndices: number[] = [];
    for (let inputIndex = 0; inputIndex < texts.length; inputIndex++) {
      const text = texts[inputIndex];
      if (isMetaFrustrationNoise(text)) {
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: static noise filtered: ${text.slice(0, 80)}`,
        );
        continue;
      }
      staticFiltered.push(text);
      staticKeptIndices.push(inputIndex);
    }

    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) {
      return { texts: staticFiltered, keptIndices: staticKeptIndices };
    }

    // Partition: short/long texts bypass noise check; mid-length need embedding
    const SHORT_THRESHOLD = 8;
    const LONG_THRESHOLD = 300;
    const bypassFlags: boolean[] = staticFiltered.map(
      (t) => t.length <= SHORT_THRESHOLD || t.length > LONG_THRESHOLD,
    );

    const needsEmbedIndices: number[] = [];
    const needsEmbedTexts: string[] = [];
    for (let i = 0; i < staticFiltered.length; i++) {
      if (!bypassFlags[i]) {
        needsEmbedIndices.push(i);
        needsEmbedTexts.push(staticFiltered[i]);
      }
    }

    // Batch embed all mid-length texts in a single API call
    let vectors: number[][] = [];
    if (needsEmbedTexts.length > 0) {
      try {
        vectors = await this.embedder.embedBatch(needsEmbedTexts);
      } catch {
        // Batch failed — pass all through
        return { texts: staticFiltered.slice(), keptIndices: staticKeptIndices.slice() };
      }
    }

    const result: string[] = new Array(staticFiltered.length);
    // First, fill in bypass texts (always kept)
    for (let i = 0; i < staticFiltered.length; i++) {
      if (bypassFlags[i]) {
        result[i] = staticFiltered[i];
      }
    }

    // Then, check noise for embedded texts
    for (let j = 0; j < needsEmbedIndices.length; j++) {
      const idx = needsEmbedIndices[j];
      const vec = vectors[j];
      if (!vec || vec.length === 0) {
        result[idx] = staticFiltered[idx];
        continue;
      }
      if (noiseBank.isNoise(vec)) {
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: embedding noise filtered: ${staticFiltered[idx].slice(0, 80)}`,
        );
        // Leave result[idx] as undefined — will be compacted below
      } else {
        result[idx] = staticFiltered[idx];
      }
    }

    // Compact: remove undefined slots (filtered-out entries).
    // Use explicit undefined check rather than filter(Boolean) to preserve
    // empty strings that were legitimately in bypass slots.
    const keptTexts: string[] = [];
    const keptIndices: number[] = [];
    for (let slot = 0; slot < result.length; slot++) {
      const survivor = result[slot];
      if (survivor !== undefined) {
        keptTexts.push(survivor);
        keptIndices.push(staticKeptIndices[slot]);
      }
    }
    return { texts: keptTexts, keptIndices };
  }

  /**
   * Feed back conversation text to the noise prototype bank.
   * Called when LLM extraction returns zero candidates (strongest noise signal).
   */
  private async learnAsNoise(conversationText: string): Promise<void> {
    const noiseBank = this.config.noiseBank;
    if (!noiseBank || !noiseBank.initialized) return;

    try {
      const tail = conversationText.slice(-300);
      const vec = await this.embedder.embed(tail);
      if (vec && vec.length > 0) {
        noiseBank.learn(vec);
        this.debugLog("memory-lancedb-pro: smart-extractor: learned noise from zero-extraction");
      }
    } catch {
      // Non-critical — silently skip
    }
  }

  // --------------------------------------------------------------------------
  // Step 1: LLM Extraction
  // --------------------------------------------------------------------------

  /**
   * Call LLM to extract candidate memories from conversation text.
   */
  private async extractCandidates(
    conversationText: string,
    policyMode: ExtractionPolicyMode = "full",
    conversationTurns?: ConversationTurn[],
    protectedPrefixTurns?: number,
  ): Promise<ExtractCandidatesResult> {
    const maxChars = this.config.extractMaxChars ?? 8000;
    const user = this.config.user ?? "User";

    // Strip platform envelope metadata injected by OpenClaw channels
    // (e.g. "System: [2026-03-18 14:21:36 GMT+8] Feishu[default] DM | ou_...")
    // These pollute extraction if treated as conversation content. Callers
    // without per-message turns fall back to one user block over the flat
    // joined text.
    const strippedTurns: ConversationTurn[] = conversationTurns?.length
      ? conversationTurns.map((turn) => ({ ...turn, text: stripEnvelopeMetadata(turn.text) }))
      : [{ role: "user", text: stripEnvelopeMetadata(conversationText) }];
    // A turn may consist of nothing but channel envelope; its stripped text
    // is empty, and rendering it would show the model a contentless speaker
    // block while spending transcript budget. Re-apply the upstream
    // emptiness contract: drop empty turns, skip the call if none survive.
    const protectedInputTurns = Math.min(
      Math.max(Math.trunc(protectedPrefixTurns ?? 0), 0),
      conversationTurns?.length ? strippedTurns.length : 0,
    );
    const turns: ConversationTurn[] = [];
    let protectedKeptTurns = 0;
    for (let i = 0; i < strippedTurns.length; i++) {
      if (strippedTurns[i].text.trim().length === 0) continue;
      turns.push(strippedTurns[i]);
      if (i < protectedInputTurns) protectedKeptTurns++;
    }
    if (turns.length === 0) {
      this.debugLog(
        "memory-lancedb-pro: smart-extractor: every turn stripped to envelope metadata; skipping extraction",
      );
      return { status: "empty_input", candidates: [] };
    }

    // extractMaxChars is an absolute ceiling on the transcript, exactly as it
    // was for the flat-text path's slice(-maxChars). The turn-aware walk
    // keeps whole recent turns and tail-slices only the oldest partial one,
    // so truncation preserves attribution without ever exceeding the cap.
    // One pass renders the turns and reports the untruncated length, so the
    // over-budget case does not render the whole delta a second time.
    const { transcript, fullLength, protectedPrefixKept } = buildBoundedTranscriptWithStats(
      turns,
      maxChars,
      { protectedPrefixTurns: protectedKeptTurns },
    );
    if (transcript.length < fullLength) {
      this.debugLog(
        `memory-lancedb-pro: smart-extractor: transcript bounded to extractMaxChars=${maxChars} (${fullLength - transcript.length} of ${fullLength} rendered chars dropped)`,
      );
    }
    if (protectedKeptTurns > 0 && !protectedPrefixKept) {
      this.log(
        `memory-lancedb-pro: smart-extractor: extractMaxChars=${maxChars} is too small to carry the prepended referent; extracting without it`,
      );
    }
    // Bounding can drop every turn when the budget sits below one turn's tag
    // envelope; prompting on an empty transcript wastes the call and its
    // zero-candidate reply would mistrain the noise bank.
    if (transcript.trim().length === 0) {
      this.debugLog(
        "memory-lancedb-pro: smart-extractor: transcript empty after bounding; skipping extraction",
      );
      return { status: "empty_input", candidates: [] };
    }

    const { system, user: userPrompt } = buildExtractionPrompt(transcript, user, {
      assistantEligible: this.config.captureAssistantEligible === true,
    });

    const result = await this.llm.completeJson<{
      conversation_register?: string;
      memories: Array<{
        category: string;
        abstract: string;
        overview: string;
        content: string;
        grounding?: string;
      }>;
    }>(userPrompt, "extract-candidates", system);

    if (!result) {
      this.debugLog(
        "memory-lancedb-pro: smart-extractor: extract-candidates returned null",
      );
      return { status: "llm_failure", candidates: [] };
    }
    if (!result.memories || !Array.isArray(result.memories)) {
      this.debugLog(
        `memory-lancedb-pro: smart-extractor: extract-candidates returned unexpected shape keys=${Object.keys(result).join(",") || "(none)"}`,
      );
      return { status: "malformed", candidates: [] };
    }

    this.debugLog(
      `memory-lancedb-pro: smart-extractor: extract-candidates raw memories=${result.memories.length}`,
    );

    // Batch-level register signal, judged once per extraction. The model
    // classifies whole sessions far more reliably than it self-tags single
    // items, so the register deterministically overrides per-item grounding
    // wobble below. Missing/unrecognized values fail toward scrutiny
    // ("mixed"), never toward open.
    // Read with token boundaries: exact equality let a decorated value such as
    // "fiction (roleplay)" fall through to "mixed", which relaxed the strictest
    // gate rather than tightening it.
    const rawRegister = normalizeRegisterToken(result.conversation_register);
    let conversationRegister: ConversationRegister =
      rawRegister === "real" || rawRegister === "fiction" ? rawRegister : "mixed";

    // Grounding rejudge: a scoped second pass, fired at most once per
    // extraction, only when the register verdict and the per-item tags are
    // incoherent (register asserts fiction exists but nothing is tagged
    // constructed, or the mirror shape), or when real-tagged durables sit
    // beside constructed siblings. Its per-item verdict is FINAL and replaces
    // the retired batch-wide contradiction wipe; on judge failure the batch
    // fails closed (suspect durables demoted below, never stored-as-real).
    const rawItems = result.memories.filter(
      (m): m is (typeof result.memories)[number] => !!m && typeof m === "object",
    );
    // Verdicts are held HERE, never written back into the LLM response. The
    // response object graph belongs to the client and may outlive the call
    // (any caching or fixture-returning client shares it across invocations),
    // so mutating it leaks one extraction's verdict into the next.
    const rawItemIndex = new Map<object, number>();
    rawItems.forEach((m, i) => rawItemIndex.set(m, i));
    const judgedGrounding: Array<CandidateGrounding | undefined> = new Array(rawItems.length);
    // First-pass tags are read on the same terms as the rejudge verdict: exact
    // equality let "constructed (in-story)" read as real and persist. Values
    // carrying no recognizable token at all ("unsure", a number) keep the
    // documented legacy-payload contract and fail open to real.
    const isRawConstructed = (m: { grounding?: string }): boolean =>
      typeof m.grounding === "string" && normalizeVerdictGrounding(m.grounding) === "constructed";
    const rawConstructedCount = rawItems.filter(isRawConstructed).length;
    const rawRealCount = rawItems.length - rawConstructedCount;
    const hasRealTaggedDurable = rawItems.some((m) => {
      if (isRawConstructed(m)) return false;
      const cat = normalizeCategory(m.category ?? "");
      return !!cat && DURABLE_CATEGORIES.has(cat);
    });
    // Judge-gated categories are not durable, so a contradiction cell keyed on
    // durables alone never fired for them: a constructed sibling beside a
    // real-tagged in-story event persisted the event with no adjudication at
    // all. They now arm the contradiction cells too, and the persistence gate
    // below requires a positive verdict for them wherever such a cell fired.
    const hasRealTaggedJudgeGated = rawItems.some((m) => {
      if (isRawConstructed(m)) return false;
      const cat = normalizeCategory(m.category ?? "");
      return !!cat && FICTION_JUDGED_CATEGORIES.has(cat);
    });

    // Most cells are defined on the register the model ASSERTED — a missing or
    // unrecognized register is no assertion, so legacy payloads stay on the
    // deterministic path. The one exception is the constructed-sibling shape:
    // there the deterministic path is the batch-wide durable wipe, which
    // deletes independently-supported real facts alongside the suspect ones —
    // exactly the over-drop the per-item rejudge exists to replace. Attempting
    // the judge there strictly dominates: it can only rescue rows, and a
    // failed or malformed verdict still falls through to the same wipe.
    const registerAsserted =
      rawRegister === "real" || rawRegister === "fiction" || rawRegister === "mixed";
    let rejudgeCell: string | null = null;
    if (rawItems.length > 0) {
      if (!registerAsserted) {
        if (rawConstructedCount > 0 && (hasRealTaggedDurable || hasRealTaggedJudgeGated)) {
          rejudgeCell = "unasserted-constructed-sibling-durables";
        }
      } else if (conversationRegister === "real" && rawRealCount === 0) {
        rejudgeCell = "real-zero-real";
      } else if (
        conversationRegister === "real" &&
        rawConstructedCount > 0 &&
        (hasRealTaggedDurable || hasRealTaggedJudgeGated)
      ) {
        // An asserted-real batch that also carries a constructed tag contradicts
        // itself: the register claims ordinary conversation while an item is
        // marked true only inside a fiction. A durable that can persist beside
        // that sibling gets adjudicated rather than trusted on the assertion.
        rejudgeCell = "real-constructed-sibling-durables";
      } else if (conversationRegister === "mixed" && rawConstructedCount === 0) {
        rejudgeCell = "mixed-zero-constructed";
      } else if (conversationRegister === "fiction" && rawConstructedCount === 0) {
        rejudgeCell = "fiction-zero-constructed";
      } else if (
        conversationRegister !== "real" &&
        rawConstructedCount > 0 &&
        (hasRealTaggedDurable ||
          (conversationRegister === "fiction" && hasRealTaggedJudgeGated))
      ) {
        // NOTE: a real-tagged judge-gated candidate arms this cell only under
        // fiction, deliberately. An asserted "mixed" register means both kinds
        // of content are present, so a constructed sibling there is coherent
        // rather than contradictory, and the suite pins that a coherent mixed
        // batch must not spend a rejudge call. That leaves a real-tagged
        // in-story event unadjudicated under "mixed"; widening it is a cost
        // decision (one extra call per mixed batch carrying an event) raised
        // with the reviewer rather than taken here.
        rejudgeCell = "constructed-sibling-durables";
      }
    }

    // Item indices the grounding judge positively confirmed as "real". Only a
    // confirmed item may pass the fiction-register gate for judge-gated
    // categories below: absence of a verdict is never confirmation.
    const judgeConfirmedReal = new Set<number>();
    let rejudgeFailedClosed = false;
    if (rejudgeCell) {
      this.debugLog(
        `memory-lancedb-pro: smart-extractor: grounding-rejudge fired cell=${rejudgeCell} register=${conversationRegister} candidates=${rawItems.length}`,
      );
      const rejudgePrompt = buildGroundingRejudgePrompt(
        transcript,
        conversationRegister,
        rawItems.map((m, i) => ({
          index: i + 1,
          category: String(m.category ?? ""),
          abstract: String(m.abstract ?? "").trim().slice(0, 200),
          content: String(m.content ?? "").trim().slice(0, 400),
          grounding: isRawConstructed(m) ? "constructed" : "real",
        })),
      );
      const verdict = await this.llm.completeJson<{
        conversation_register?: string;
        results?: Array<{ index?: number; grounding?: string; reason?: string }>;
      }>(rejudgePrompt, "grounding-rejudge");
      const verdictResults =
        verdict && Array.isArray(verdict.results) ? verdict.results : null;
      if (!verdictResults) {
        rejudgeFailedClosed = true;
        // Logged at info: this path discards every durable in the batch, and a
        // silent judge (a transient gateway failure looks identical to an
        // unusable answer here) should be visible when it does that.
        this.log(
          `memory-lancedb-pro: smart-extractor: grounding-rejudge returned no usable verdict — failing closed, real-tagged durables will be demoted`,
        );
      } else {
        // The ENTIRE response is validated before any of it is applied:
        // exactly one row per candidate, unique integral in-range indices, one
        // usable grounding each. A response failing any of those is applied in
        // NO part, so every item stays unadjudicated, the register cannot be
        // relaxed, and the quarantine below still sees untrusted first-pass
        // tags. Applying rows as they arrived let a duplicate index overwrite
        // an earlier verdict while still counting toward coverage.
        // Rows are NORMALIZED before the gate judges them, so ordinary value
        // variance (an index the model quoted, a grounding it decorated) does
        // not turn a semantically complete verdict into a rejected one. With
        // whole-response rejection, pedantry about representation would
        // discard every confirmation and rescue in the response.
        const staged = new Map<number, CandidateGrounding>();
        let verdictWellFormed = verdictResults.length === rawItems.length;
        if (verdictWellFormed) {
          for (const r of verdictResults) {
            const index = normalizeVerdictIndex(r?.index);
            const g = normalizeVerdictGrounding(r?.grounding);
            if (
              !Number.isInteger(index) ||
              index < 1 ||
              index > rawItems.length ||
              g === null ||
              staged.has(index - 1)
            ) {
              verdictWellFormed = false;
              break;
            }
            staged.set(index - 1, g);
          }
        }
        let retagged = 0;
        const adjudicated = new Set<number>();
        if (verdictWellFormed) {
          for (const [itemIndex, g] of staged) {
            if ((isRawConstructed(rawItems[itemIndex]) ? "constructed" : "real") !== g) {
              retagged++;
            }
            judgedGrounding[itemIndex] = g;
            adjudicated.add(itemIndex);
            if (g === "real") judgeConfirmedReal.add(itemIndex);
            else judgeConfirmedReal.delete(itemIndex);
          }
        } else {
          this.debugLog(
            `memory-lancedb-pro: smart-extractor: grounding-rejudge verdict malformed (${verdictResults.length} row(s) for ${rawItems.length} candidate(s), or a duplicate/out-of-range index or invalid grounding) — applying none and failing closed on the asserted register`,
          );
        }
        const coverageComplete = verdictWellFormed && adjudicated.size === rawItems.length;
        const verdictRegister =
          typeof verdict.conversation_register === "string"
            ? verdict.conversation_register.toLowerCase().trim()
            : "";
        const registerBefore = conversationRegister;
        if (
          verdictRegister === "real" ||
          verdictRegister === "fiction" ||
          verdictRegister === "mixed"
        ) {
          // On incomplete coverage the asserted register stands, except that a
          // STRICTER verdict register is always honoured: refusing to relax is
          // the fail-closed property, refusing to tighten would be the reverse.
          if (coverageComplete || REGISTER_STRICTNESS[verdictRegister] > REGISTER_STRICTNESS[conversationRegister]) {
            conversationRegister = verdictRegister;
          } else {
            this.debugLog(
              `memory-lancedb-pro: smart-extractor: grounding-rejudge verdict coverage incomplete (${adjudicated.size}/${rawItems.length}) — refusing register relax ${conversationRegister}->${verdictRegister}`,
            );
          }
        }
        // Coverage check: the judge is instructed to adjudicate every index.
        // An index it omitted (or answered with an unusable grounding) keeps
        // an UNTRUSTED first-pass tag, so an empty or partial verdict must not
        // count as a clean bill. Per-item fail-closed: in a non-real register,
        // an unadjudicated real-tagged durable is quarantined to "constructed"
        // rather than stored on a tag the judge never confirmed.
        // The asserted-real constructed-sibling cell quarantines as well: its
        // premise is that a real register is not trustworthy when the model
        // also tagged part of the same batch constructed.
        let uncoveredDemoted = 0;
        if (
          conversationRegister !== "real" ||
          rejudgeCell === "real-constructed-sibling-durables"
        ) {
          for (let i = 0; i < rawItems.length; i++) {
            if (adjudicated.has(i)) continue;
            const item = rawItems[i];
            if (isRawConstructed(item)) continue;
            const cat = normalizeCategory(item.category ?? "");
            if (!cat || !DURABLE_CATEGORIES.has(cat)) continue;
            judgedGrounding[i] = "constructed";
            uncoveredDemoted++;
          }
        }
        if (uncoveredDemoted > 0) {
          this.debugLog(
            `memory-lancedb-pro: smart-extractor: grounding-rejudge verdict incomplete (${adjudicated.size}/${rawItems.length} adjudicated) — quarantining ${uncoveredDemoted} unadjudicated real-tagged durable(s)`,
          );
        }
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: grounding-rejudge verdict register=${registerBefore}->${conversationRegister} retagged=${retagged}/${rawItems.length}`,
        );
      }
    }

    // A constructed sibling makes the batch's own self-tagging untrustworthy,
    // so judge-gated candidates need a positive verdict in these cells too,
    // not only in a fiction register.
    const constructedSiblingCellFired =
      rejudgeCell === "real-constructed-sibling-durables" ||
      rejudgeCell === "unasserted-constructed-sibling-durables" ||
      rejudgeCell === "constructed-sibling-durables";

    // Validate and normalize candidates
    const candidates: CandidateMemory[] = [];
    let invalidCategoryCount = 0;
    let shortAbstractCount = 0;
    let noiseAbstractCount = 0;
    let policyDroppedCount = 0;
    let constructedDroppedCount = 0;
    let fictionRegisterDroppedCount = 0;
    for (const raw of result.memories) {
      if (!raw || typeof raw !== "object") {
        invalidCategoryCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping null/invalid candidate entry`,
        );
        continue;
      }
      const category = normalizeCategory(raw.category ?? "");
      if (!category) {
        invalidCategoryCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to invalid category rawCategory=${JSON.stringify(raw.category ?? "")} abstract=${JSON.stringify((raw.abstract ?? "").trim().slice(0, 120))}`,
        );
        continue;
      }

      const abstract = (raw.abstract ?? "").trim();
      const overview = (raw.overview ?? "").trim();
      const content = (raw.content ?? "").trim();

      // Skip empty or noise
      if (!abstract || abstract.length < 5) {
        shortAbstractCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to short abstract category=${category} abstract=${JSON.stringify(abstract)}`,
        );
        continue;
      }
      if (isNoise(abstract)) {
        noiseAbstractCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to noise abstract category=${category} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      // Option C: scope policy restricts extraction to episodic-only,
      // independent of grounding — checked before the grounding filter below.
      if (policyMode === "episodic-only" && category !== "events") {
        policyDroppedCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping candidate due to episodic-only extraction policy category=${category} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      // Option A / v3: grounding-aware filter. Missing/non-string/unrecognized
      // per-item values fail open to "real" so a model that ignores the field
      // can't break extraction. Grounding describes the truth-grounding of the
      // ASSERTION itself: "real" includes an assertion ABOUT a fiction/game
      // session (e.g. that it happened); "constructed" is a claim true only
      // WITHIN the fiction. A constructed-tagged candidate is never stored,
      // in any category or register — there is no per-extraction cap anymore.
      // A grounding-judge verdict, when one exists for this item, is final and
      // supersedes the self-tag; it is held out-of-band rather than written
      // back into the response object.
      const rawItemPosition = rawItemIndex.get(raw);
      const grounding: CandidateGrounding =
        (rawItemPosition === undefined ? undefined : judgedGrounding[rawItemPosition]) ??
        // Same token-boundary read as the cell predicate and the rejudge
        // verdict: exact equality here let "constructed (in-story)" persist as
        // a real memory. A value with no recognizable token still fails open.
        (normalizeVerdictGrounding(raw.grounding) === "constructed" ? "constructed" : "real");

      // Register enforcement: an in-fiction batch can never produce durable
      // memories, whatever the per-item self-tags claim (the per-item tags
      // are exactly the wobble the batch register exists to override).
      if (conversationRegister === "fiction" && DURABLE_CATEGORIES.has(category)) {
        fictionRegisterDroppedCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping durable candidate from fiction-register batch category=${category} grounding=${grounding} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      // Judge-gated categories: an event may be an assertion ABOUT a fiction
      // session ("we played for three hours", legitimately real) or an event
      // from WITHIN it ("boarded the train", constructed). The per-item
      // self-tag cannot be trusted to tell those apart wherever the batch is
      // internally contradictory, so the candidate survives only on a positive
      // grounding-judge confirmation. No verdict, an omitted index, or a failed
      // judge all fail closed here. The gate covers a fiction register AND any
      // constructed-sibling cell: a constructed tag beside a real-tagged
      // in-story event is the same untrustworthy self-tagging, whatever
      // register the batch claimed.
      if (
        (conversationRegister === "fiction" || constructedSiblingCellFired) &&
        FICTION_JUDGED_CATEGORIES.has(category) &&
        !(rawItemPosition !== undefined && judgeConfirmedReal.has(rawItemPosition))
      ) {
        fictionRegisterDroppedCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping unconfirmed judge-gated candidate (register=${conversationRegister}, cell=${rejudgeCell ?? "none"}) category=${category} grounding=${grounding} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      // Grounding enforcement: a constructed assertion is true only within
      // the fiction, never about the real world — never stored, regardless
      // of category or register.
      if (grounding === "constructed") {
        constructedDroppedCount++;
        this.debugLog(
          `memory-lancedb-pro: smart-extractor: dropping constructed-grounding candidate category=${category} abstract=${JSON.stringify(abstract.slice(0, 120))}`,
        );
        continue;
      }

      candidates.push({ category, abstract, overview, content, grounding, conversationRegister });
    }

    // Fail-closed fallback: the per-item rejudge above replaces the retired
    // batch-wide contradiction wipe for asserted registers, so incoherent
    // shapes normally resolve to a final per-item verdict. The deterministic
    // quarantine — demote surviving real-tagged durables — remains for two
    // shapes only: the rejudge itself failed, or a legacy payload asserted no
    // register at all while tagging constructed siblings.
    // Only the shapes the judge was never asked about land here; the
    // unasserted constructed-sibling shape now goes to the judge first and
    // falls back through rejudgeFailedClosed when that judge cannot answer.
    const legacyContradiction =
      !registerAsserted &&
      !rejudgeCell &&
      conversationRegister !== "real" &&
      rawConstructedCount > 0;
    let contradictionDemotedCount = 0;
    if (rejudgeFailedClosed || legacyContradiction) {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (DURABLE_CATEGORIES.has(candidate.category)) {
          contradictionDemotedCount++;
          this.debugLog(
            `memory-lancedb-pro: smart-extractor: grounding-rejudge failure fallback — demoting real-tagged durable from ${conversationRegister}-register batch category=${candidate.category} abstract=${JSON.stringify(candidate.abstract.slice(0, 120))}`,
          );
          candidates.splice(i, 1);
        }
      }
    }

    if (contradictionDemotedCount > 0) {
      // At the standard log level so a fully-demoted batch is distinguishable
      // from "model found nothing" without debug logging (mirrors the
      // admission-rejection lines).
      this.log(
        `memory-lancedb-pro: smart-extractor: batch contradiction demoted ${contradictionDemotedCount} real-tagged durable candidate(s) (register=${conversationRegister}, constructed siblings present)`,
      );
    }

    this.debugLog(
      `memory-lancedb-pro: smart-extractor: validation summary register=${conversationRegister}, accepted=${candidates.length}, invalidCategory=${invalidCategoryCount}, shortAbstract=${shortAbstractCount}, noiseAbstract=${noiseAbstractCount}, policyDropped=${policyDroppedCount}, constructedDropped=${constructedDroppedCount}, fictionRegisterDropped=${fictionRegisterDroppedCount}, contradictionDemoted=${contradictionDemotedCount}`,
    );

    return {
      status: "ok",
      candidates,
      rawCandidateCount: result.memories.length,
      // A batch emptied by grounding, register, or policy drops is NOT a
      // "the LLM found nothing here" signal — the LLM found plenty and the
      // filters excluded it — so the caller must not train the noise bank
      // on it. Quality drops (short/noise abstracts) keep the existing
      // noise-learning contract.
      groundingOrPolicyDropped:
        policyDroppedCount +
          fictionRegisterDroppedCount +
          constructedDroppedCount +
          contradictionDemotedCount >
        0,
    };
  }

  // --------------------------------------------------------------------------
  // Step 2: Dedup + Persist
  // --------------------------------------------------------------------------

  /**
   * Process a single candidate memory: dedup → merge/create → store
   *
   * @param precomputedVector - Optional pre-embedded vector for the candidate.
   *   When provided (from batch pre-embedding), skips the per-candidate embed
   *   call to reduce API round-trips.
   * @param precomputedAdmission - Optional pre-scored admission evaluation
   *   (from batch utility mode). When provided, skips the per-candidate
   *   admissionController.evaluate() call below.
   * @param precomputedDedup - Optional pre-decided dedup verdict (from the
   *   batched dedup decider). When provided, skips the per-candidate
   *   deduplicate() call below.
   * @param pendingMerges - Optional deferred-merge queue. When provided,
   *   merge verdicts are queued for the single batched merge-writer call
   *   instead of issuing one merge-memory call inline.
   */
  private async processCandidate(
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    stats: ExtractionStats,
    targetScope: string,
    scopeFilter?: string[],
    precomputedVector?: number[],
    createEntries?: Omit<import("./store.js").MemoryEntry, "id" | "timestamp">[],
    pendingSupersedeInvalidations?: PendingSupersedeInvalidation[],
    agentId?: string,
    precomputedAdmission?: AdmissionEvaluation,
    precomputedDedup?: DedupResult,
    pendingMerges?: PendingMergeJob[],
  ): Promise<void> {
    // Profile always merges (skip dedup — admission control still applies)
    if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
      const profileResult = await this.handleProfileMerge(
        candidate,
        conversationText,
        sessionKey,
        targetScope,
        scopeFilter,
        undefined,
        createEntries,
        agentId,
        pendingMerges,
        precomputedVector,
        precomputedAdmission,
      );
      if (profileResult === "rejected") {
        stats.rejected = (stats.rejected ?? 0) + 1;
      } else if (profileResult === "created") {
        stats.created++;
      } else if (profileResult === "merged") {
        stats.merged++;
      }
      // "llm-failed": nothing was persisted (handleMerge already logged
      // it) — don't count it as either a merge or a create.
      // "queued": accounted when the batched merge writer flushes.
      return;
    }

    // Use pre-computed vector if available (batch embed optimization),
    // otherwise fall back to per-candidate embed call.
    const vector = precomputedVector ?? await this.embedder.embed(`${candidate.abstract} ${candidate.content}`);
    if (!vector || vector.length === 0) {
      this.log("memory-pro: smart-extractor: embedding failed, storing as-is");
      createEntries?.push(this.buildStoreEntry(candidate, vector || [], sessionKey, targetScope));
      stats.created++;
      return;
    }

    // Admission control gate (before dedup). Reuse the batch-mode evaluation
    // computed up front for this candidate when available, instead of
    // issuing another per-candidate call.
    const admission =
      precomputedAdmission ??
      (this.admissionController
        ? await this.admissionController.evaluate({
            candidate,
            candidateVector: vector,
            conversationText,
            scopeFilter: scopeFilter ?? [targetScope],
          })
        : undefined);

    if (admission?.decision === "reject") {
      stats.rejected = (stats.rejected ?? 0) + 1;
      this.log(
        `memory-pro: smart-extractor: admission rejected [${candidate.category}] ${candidate.abstract.slice(0, 60)} — ${admission.audit.reason}`,
      );
      await this.recordRejectedAdmission(
        candidate,
        conversationText,
        sessionKey,
        targetScope,
        scopeFilter ?? [targetScope],
        admission.audit as AdmissionAuditRecord & { decision: "reject" },
      );
      return;
    }

    // Dedup pipeline — reuse the batched verdict computed up front when
    // available, instead of issuing another per-candidate call.
    const dedupResult = precomputedDedup ?? await this.deduplicate(candidate, vector, scopeFilter);

    switch (dedupResult.decision) {
      case "create":
        createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
        stats.created++;
        break;

      case "merge":
        if (
          dedupResult.matchId &&
          MERGE_SUPPORTED_CATEGORIES.has(candidate.category)
        ) {
          const mergeOutcome = pendingMerges
            ? await this.queueMergeJob(
                pendingMerges,
                candidate,
                dedupResult.matchId,
                targetScope,
                scopeFilter,
                dedupResult.contextLabel,
                this.admissionWriteEvidenceFor(candidate, admission),
                createEntries,
                agentId,
              )
            : await this.handleMerge(
                candidate,
                dedupResult.matchId,
                targetScope,
                scopeFilter,
                dedupResult.contextLabel,
                this.admissionWriteEvidenceFor(candidate, admission),
                createEntries,
                agentId,
              );
          if (mergeOutcome === "merged") {
            stats.merged++;
          } else if (mergeOutcome === "created") {
            stats.created++;
          }
          // "llm-failed": nothing was persisted (handleMerge already logged
          // it) — don't count it as either a merge or a create.
          // "queued": accounted when the batched merge writer flushes.
        } else {
          // Category doesn't support merge → create instead
          createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
          stats.created++;
        }
        break;

      case "skip":
        this.log(
          `memory-pro: smart-extractor: skipped [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
        );
        stats.skipped++;
        break;

      case "supersede":
        if (
          dedupResult.matchId &&
          TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category)
        ) {
          const supersedeOutcome = await this.handleSupersede(
            candidate,
            vector,
            dedupResult.matchId,
            sessionKey,
            targetScope,
            scopeFilter,
            this.admissionWriteEvidenceFor(candidate, admission),
            createEntries,
            pendingSupersedeInvalidations,
            agentId,
          );
          stats.created++;
          // Deferred invalidations count only after they are CONFIRMED in
          // applyPendingSupersedeInvalidations; a failed/downgraded supersede
          // is a plain create and must not inflate the superseded stat.
          if (supersedeOutcome === "superseded") {
            stats.superseded = (stats.superseded ?? 0) + 1;
          }
        } else {
          createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
          stats.created++;
        }
        break;

      case "support":
        if (dedupResult.matchId) {
          const supportOutcome = await this.handleSupport(dedupResult.matchId, { session: sessionKey, timestamp: Date.now() }, dedupResult.reason, dedupResult.contextLabel, scopeFilter, this.admissionWriteEvidenceFor(candidate, admission));
          if (supportOutcome === "supported") {
            stats.supported = (stats.supported ?? 0) + 1;
          } else {
            // Target vanished mid-flight: same semantics as a support verdict
            // with no target — the candidate lands as a new row.
            createEntries?.push(await this.externalOrBuiltFallbackEntry(candidate, targetScope, sessionKey, vector, this.admissionWriteEvidenceFor(candidate, admission)));
            stats.created++;
          }
        } else {
          createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
          stats.created++;
        }
        break;

      case "contextualize":
        if (dedupResult.matchId) {
          await this.handleContextualize(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, this.admissionWriteEvidenceFor(candidate, admission), createEntries, agentId);
          stats.created++;
        } else {
          createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
          stats.created++;
        }
        break;

      case "contradict":
        if (dedupResult.matchId) {
          if (
            TEMPORAL_VERSIONED_CATEGORIES.has(candidate.category) &&
            dedupResult.contextLabel === "general"
          ) {
            const contradictSupersede = await this.handleSupersede(
              candidate,
              vector,
              dedupResult.matchId,
              sessionKey,
              targetScope,
              scopeFilter,
              this.admissionWriteEvidenceFor(candidate, admission),
              createEntries,
              pendingSupersedeInvalidations,
              agentId,
            );
            stats.created++;
            if (contradictSupersede === "superseded") {
              stats.superseded = (stats.superseded ?? 0) + 1;
            }
          } else {
            await this.handleContradict(candidate, vector, dedupResult.matchId, sessionKey, targetScope, scopeFilter, dedupResult.contextLabel, this.admissionWriteEvidenceFor(candidate, admission), createEntries, agentId);
            stats.created++;
          }
        } else {
          createEntries?.push(this.buildStoreEntry(candidate, vector, sessionKey, targetScope, this.admissionWriteEvidenceFor(candidate, admission)));
          stats.created++;
        }
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Dedup Pipeline (vector pre-filter + LLM decision)
  // --------------------------------------------------------------------------

  /**
   * Two-stage dedup: vector similarity search → LLM decision.
   */
  private async deduplicate(
    candidate: CandidateMemory,
    candidateVector: number[],
    scopeFilter?: string[],
  ): Promise<DedupResult> {
    const prefilter = await this.dedupPrefilter(candidate, candidateVector, scopeFilter);
    if (prefilter.shortCircuit) {
      return prefilter.shortCircuit;
    }
    // Stage 2: LLM decision
    return this.llmDedupDecision(candidate, prefilter.topSimilar);
  }

  /**
   * The free (non-LLM) stages of dedup: vector similarity search plus the
   * preference-slot guard. Returns either a short-circuit verdict (no LLM
   * needed) or the similar rows the LLM decision should consider. Shared by
   * the inline single-call path and the batched decider so the two can
   * never diverge.
   */
  private async dedupPrefilter(
    candidate: CandidateMemory,
    candidateVector: number[],
    scopeFilter?: string[],
  ): Promise<{ shortCircuit?: DedupResult; topSimilar: MemorySearchResult[] }> {
    // Stage 1: Vector pre-filter — find similar active memories.
    // excludeInactive ensures the store over-fetches to fill N active slots,
    // preventing superseded history from crowding out the current fact.
    const activeSimilar = await this.store.vectorSearch(
      candidateVector,
      5,
      SIMILARITY_THRESHOLD,
      scopeFilter,
      { excludeInactive: true },
    );

    if (activeSimilar.length === 0) {
      return {
        shortCircuit: { decision: "create", reason: NO_SIMILAR_MEMORIES_REASON },
        topSimilar: [],
      };
    }

    // Stage 1.5: Preference slot guard — same brand but different item
    // should always be stored as a new memory, not merged/skipped.
    // Example: "喜欢麦当劳的板烧鸡腿堡" and "喜欢麦当劳的麦辣鸡翅" are
    // different preferences even though they share the same brand.
    if (candidate.category === "preferences") {
      const candidateSlot = inferAtomicBrandItemPreferenceSlot(candidate.content);
      if (candidateSlot) {
        const allDifferentItem = activeSimilar.every((r) => {
          const existingSlot = inferAtomicBrandItemPreferenceSlot(r.entry.text);
          // If existing is not a brand-item preference, let LLM decide
          if (!existingSlot) return false;
          // Same brand, different item → should not be deduped
          return existingSlot.brand === candidateSlot.brand && existingSlot.item !== candidateSlot.item;
        });
        if (allDifferentItem) {
          return {
            shortCircuit: { decision: "create", reason: "Same brand but different item-level preference (preference-slot guard)" },
            topSimilar: [],
          };
        }
      }
    }

    return { topSimilar: activeSimilar };
  }

  /** Renders one candidate's similar rows the way both dedup prompts embed them. */
  private formatExistingMemoriesForDedup(topSimilar: MemorySearchResult[]): string {
    return topSimilar
      .map((r, i) => {
        // Extract L0 abstract from metadata if available, fallback to text
        let metaObj: Record<string, unknown> = {};
        try {
          metaObj = JSON.parse(r.entry.metadata || "{}");
        } catch { }
        const abstract = (metaObj.l0_abstract as string) || r.entry.text;
        return formatExistingMemoryEntry(
          i + 1,
          (metaObj.memory_category as string) || r.entry.category,
          abstract,
          r.score,
        );
      })
      .join("\n");
  }

  /**
   * Batched dedup decider: one dedup-decision LLM call per chunk of up to
   * DEDUP_BATCH_MAX_SIZE candidates, each candidate carrying its own
   * retrieved-neighbor context. Never throws and never fans back out into
   * per-candidate calls: a response entry that is missing or malformed
   * degrades ONLY that candidate to the same CREATE default the single-call
   * path uses for an unparseable response, and a chunk whose call itself
   * fails degrades every candidate in that chunk to the same CREATE default
   * the single-call path uses for a thrown call.
   */
  /** Per-call chunk bound for the batched dedup decider and merge writer. */
  private batchChunkSize(): number {
    const raw = (this.config as { batchChunkSize?: number }).batchChunkSize;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
      ? Math.min(50, Math.floor(raw))
      : DEDUP_BATCH_MAX_SIZE;
  }

  private async llmDedupDecisionBatch(
    items: Array<{ candidate: CandidateMemory; topSimilar: MemorySearchResult[] }>,
    llm: LlmClient = this.llm,
  ): Promise<DedupResult[]> {
    const out: DedupResult[] = new Array(items.length);
    for (let chunkStart = 0; chunkStart < items.length; chunkStart += this.batchChunkSize()) {
      const chunk = items.slice(chunkStart, chunkStart + this.batchChunkSize());
      const sliced = chunk.map((item) => item.topSimilar.slice(0, MAX_SIMILAR_FOR_PROMPT));
      const { system, user } = buildBatchDedupPrompt(
        chunk.map((item, i) => ({
          candidate: item.candidate,
          existingMemories: this.formatExistingMemoriesForDedup(sliced[i]),
        })),
      );
      try {
        const response = await this.llm.completeJson<{
          results?: Array<{
            index?: number;
            decision?: string;
            reason?: string;
            match_index?: number;
            context_label?: string;
          }>;
        }>(user, "dedup-decision-batch", system);

        const byIndex = new Map<number, {
          decision?: string;
          reason?: string;
          match_index?: number;
          context_label?: string;
        }>();
        for (const entry of response && Array.isArray(response.results) ? response.results : []) {
          if (!entry || typeof entry.index !== "number") continue;
          byIndex.set(entry.index, entry);
        }
        chunk.forEach((_, i) => {
          out[chunkStart + i] = this.interpretDedupVerdict(byIndex.get(i + 1) ?? null, sliced[i]);
        });
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: dedup LLM failed: ${String(err)}`,
        );
        chunk.forEach((_, i) => {
          out[chunkStart + i] = { decision: "create", reason: `LLM failed: ${String(err)}` };
        });
      }
    }
    return out;
  }

  private async llmDedupDecision(
    candidate: CandidateMemory,
    similar: MemorySearchResult[],
  ): Promise<DedupResult> {
    const topSimilar = similar.slice(0, MAX_SIMILAR_FOR_PROMPT);
    const existingFormatted = this.formatExistingMemoriesForDedup(topSimilar);

    const { system, user: userPrompt } = buildDedupPrompt(candidate, existingFormatted);

    try {
      const data = await this.llm.completeJson<{
        decision: string;
        reason: string;
        match_index?: number;
      }>(userPrompt, "dedup-decision", system);

      return this.interpretDedupVerdict(data ?? null, topSimilar);
    } catch (err) {
      this.log(
        `memory-pro: smart-extractor: dedup LLM failed: ${String(err)}`,
      );
      return { decision: "create", reason: `LLM failed: ${String(err)}` };
    }
  }

  /**
   * Maps one raw dedup verdict (from either the single-call or the batched
   * prompt) to a DedupResult, applying the exact validation the single-call
   * path always applied: unparseable → CREATE, unknown decision → CREATE,
   * destructive decisions without a valid match_index degrade to CREATE.
   * Shared so the batched decider's per-item semantics can never drift from
   * the single-call path's.
   */
  private interpretDedupVerdict(
    data: {
      decision?: string;
      reason?: string;
      match_index?: number;
      context_label?: string;
    } | null,
    topSimilar: MemorySearchResult[],
  ): DedupResult {
    if (!data) {
      this.log(
        "memory-pro: smart-extractor: dedup LLM returned unparseable response, defaulting to CREATE",
      );
      return { decision: "create", reason: "LLM response unparseable" };
    }

    const decision = (data.decision?.toLowerCase() ??
      "create") as DedupDecision;
    if (!VALID_DECISIONS.has(decision)) {
      return {
        decision: "create",
        reason: `Unknown decision: ${data.decision}`,
      };
    }

    // Resolve merge target from LLM's match_index (1-based)
    const idx = data.match_index;
    const hasValidIndex = typeof idx === "number" && idx >= 1 && idx <= topSimilar.length;
    const matchEntry = hasValidIndex
      ? topSimilar[idx - 1]
      : topSimilar[0];

    // For destructive decisions (supersede), missing match_index is
    // unsafe — we could invalidate the wrong memory. Degrade to create.
    const destructiveDecisions = new Set(["supersede", "contradict"]);
    if (destructiveDecisions.has(decision) && !hasValidIndex) {
      this.log(
        `memory-pro: smart-extractor: ${decision} decision has missing/invalid match_index (${idx}), degrading to create`,
      );
      return {
        decision: "create",
        reason: `${decision} degraded: missing match_index`,
      };
    }

    return {
      decision,
      reason: data.reason ?? "",
      // skip carries its target too: a same-burst SKIP anchors the skipped
      // survivor at its duplicate, and later sibling verdicts must be able
      // to resolve through that anchor (the skip handler itself ignores it).
      matchId: ["merge", "support", "contextualize", "contradict", "supersede", "skip"].includes(decision) ? matchEntry?.entry.id : undefined,
      contextLabel: typeof data.context_label === "string" ? data.context_label : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Merge Logic
  // --------------------------------------------------------------------------

  /**
   * Profile always-merge: read existing profile, merge with LLM, upsert.
   */
  private async handleProfileMerge(
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter?: string[],
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    agentId?: string,
    pendingMerges?: PendingMergeJob[],
    precomputedVector?: number[],
    precomputedAdmission?: AdmissionEvaluation,
  ): Promise<"merged" | "created" | "rejected" | "llm-failed" | "queued"> {
    // Find existing profile memory by category
    const embeddingText = `${candidate.abstract} ${candidate.content}`;
    const vector =
      precomputedVector && precomputedVector.length > 0
        ? precomputedVector
        : await this.embedder.embed(embeddingText);

    // Run admission control for profile candidates (they skip the main dedup
    // path). A precomputed verdict from the batched hoist wins: profile rides
    // the same one-call-per-stage batch as every other candidate, and this
    // in-merge evaluation is the fallback for standalone mode or a failed
    // batch call.
    if (!admissionAudit && precomputedAdmission) {
      if (precomputedAdmission.decision === "reject") {
        this.log(
          `memory-pro: smart-extractor: admission rejected profile [${candidate.abstract.slice(0, 60)}] — ${precomputedAdmission.audit.reason}`,
        );
        await this.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter ?? [targetScope], precomputedAdmission.audit as AdmissionAuditRecord & { decision: "reject" });
        return "rejected";
      }
      admissionAudit = precomputedAdmission.audit;
    } else if (!admissionAudit && this.admissionController && vector && vector.length > 0) {
      const profileAdmission = await this.admissionController.evaluate({
        candidate,
        candidateVector: vector,
        conversationText,
        scopeFilter: scopeFilter ?? [targetScope],
      });
      if (profileAdmission.decision === "reject") {
        this.log(
          `memory-pro: smart-extractor: admission rejected profile [${candidate.abstract.slice(0, 60)}] — ${profileAdmission.audit.reason}`,
        );
        await this.recordRejectedAdmission(candidate, conversationText, sessionKey, targetScope, scopeFilter ?? [targetScope], profileAdmission.audit as AdmissionAuditRecord & { decision: "reject" });
        return "rejected";
      }
      admissionAudit = profileAdmission.audit;
    }

    // Search for existing profile memories
    const existing = await this.store.vectorSearch(
      vector || [],
      1,
      0.3,
      scopeFilter,
    );
    const profileMatch = existing.find((r) => {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        return meta.memory_category === "profile";
      } catch {
        return false;
      }
    });

    if (profileMatch) {
      if (pendingMerges) {
        return this.queueMergeJob(
          pendingMerges,
          candidate,
          profileMatch.entry.id,
          targetScope,
          scopeFilter,
          undefined,
          admissionAudit,
          createEntries,
          agentId,
        );
      }
      const mergeOutcome = await this.handleMerge(
        candidate,
        profileMatch.entry.id,
        targetScope,
        scopeFilter,
        undefined,
        admissionAudit,
        createEntries,
        agentId,
      );
      return mergeOutcome;
    } else {
      // No existing profile — create new
      createEntries?.push(this.buildStoreEntry(candidate, vector || [], sessionKey, targetScope, admissionAudit));
      return "created";
    }
  }

  /**
   * Merge a candidate into an existing memory using LLM.
   */
  /**
   * Attempts to merge `candidate` into the existing memory at `matchId`.
   * Returns which outcome actually happened so the caller can account for
   * it truthfully:
   * - "merged": store.update() persisted the merged content.
   * - "created": the existing row couldn't be read, so the candidate was
   *   queued as a new entry instead — a create, not a merge.
   * - "llm-failed": the merge-memory completion came back null/unparseable;
   *   nothing was persisted and the existing row is untouched.
   */
  private async handleMerge(
    candidate: CandidateMemory,
    matchId: string,
    targetScope: string,
    scopeFilter?: string[],
    contextLabel?: string,
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    agentId?: string,
  ): Promise<"merged" | "created" | "llm-failed"> {
    const target = await this.readMergeTarget(candidate, matchId, targetScope, scopeFilter, createEntries);
    if (!target) {
      return "created";
    }

    // Call LLM to merge
    const { system, user: userPrompt } = buildMergePrompt(
      { abstract: target.abstract, overview: target.overview, content: target.content },
      candidate,
    );

    const merged = await this.llm.completeJson<{
      abstract: string;
      overview: string;
      content: string;
    }>(userPrompt, "merge-memory", system);

    if (!merged) {
      this.log("memory-pro: smart-extractor: merge LLM failed, skipping merge");
      return "llm-failed";
    }

    const applied = await this.applyMergedContent(
      matchId,
      candidate.category,
      merged,
      targetScope,
      scopeFilter,
      [contextLabel],
      [admissionAudit],
      agentId,
    );
    if (applied === "target-missing") {
      createEntries?.push(
        await this.externalOrBuiltFallbackEntry(candidate, targetScope, "merge-fallback", undefined, admissionAudit),
      );
      return "created";
    }
    return "merged";
  }

  /**
   * Reads the three-level content of a merge target. On a failed read the
   * candidate is queued as a NEW entry instead (a create, not a merge —
   * exactly the fallback the inline merge path always used) and null is
   * returned so the caller can account for it as "created".
   */
  /**
   * The CREATE row a candidate falls back to when its verdict target cannot
   * be mutated: the caller's own prebuilt entry for externally gated
   * candidates (shape, provenance, and audit stay the caller's), the
   * standard auto-capture entry otherwise.
   */
  private async externalOrBuiltFallbackEntry(
    candidate: CandidateMemory,
    targetScope: string,
    sessionLabel: string,
    vector?: number[],
    admissionAudit?: AdmissionWriteEvidence,
  ): Promise<StoreEntry> {
    const ext = this.externalEntryBuilders.get(candidate);
    if (ext?.prebuilt) {
      return ext.prebuilt;
    }
    const v =
      vector && vector.length > 0
        ? vector
        : (await this.embedder.embed(`${candidate.abstract} ${candidate.content}`)) || [];
    return this.buildStoreEntry(candidate, v, sessionLabel, targetScope, admissionAudit);
  }

  private async readMergeTarget(
    candidate: CandidateMemory,
    matchId: string,
    targetScope: string,
    scopeFilter?: string[],
    createEntries?: StoreEntry[],
  ): Promise<{ abstract: string; overview: string; content: string } | null> {
    try {
      const existing = await this.store.getById(matchId, scopeFilter);
      if (!existing) {
        // Target vanished between dedup and read: merging into a missing row
        // would silently drop the candidate, so store it as new instead.
        this.log(
          `memory-pro: smart-extractor: merge target ${matchId.slice(0, 8)} no longer exists, storing as new`,
        );
        createEntries?.push(
          await this.externalOrBuiltFallbackEntry(candidate, targetScope, "merge-fallback"),
        );
        return null;
      }
      const meta = parseSmartMetadata(existing.metadata, existing);
      return {
        abstract: meta.l0_abstract || existing.text,
        overview: meta.l1_overview || "",
        content: meta.l2_content || existing.text,
      };
    } catch {
      // Fallback: store as new
      this.log(
        `memory-pro: smart-extractor: could not read existing memory ${matchId}, storing as new`,
      );
      createEntries?.push(
        await this.externalOrBuiltFallbackEntry(candidate, targetScope, "merge-fallback"),
      );
      return null;
    }
  }

  /**
   * Queues one candidate's merge for the batched merge writer. Candidates
   * merging into a target that already has a queued job are grouped into
   * that job (one write per target, so a later batched write can never
   * clobber an earlier one with stale content). Returns "created" when the
   * target could not be read and the candidate fell back to a new entry.
   */
  private async queueMergeJob(
    pendingMerges: PendingMergeJob[],
    candidate: CandidateMemory,
    matchId: string,
    targetScope: string,
    scopeFilter?: string[],
    contextLabel?: string,
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    agentId?: string,
  ): Promise<"queued" | "created"> {
    const addition: PendingMergeAddition = { candidate, contextLabel, admissionAudit };
    const existingJob = pendingMerges.find((job) => job.matchId === matchId);
    if (existingJob) {
      existingJob.additions.push(addition);
      return "queued";
    }
    const target = await this.readMergeTarget(candidate, matchId, targetScope, scopeFilter, createEntries);
    if (!target) {
      return "created";
    }
    pendingMerges.push({
      matchId,
      category: candidate.category,
      existing: target,
      additions: [addition],
      targetScope,
      scopeFilter,
      agentId,
    });
    return "queued";
  }

  /**
   * Batched merge writer: generates merged content for every queued job
   * with one merge-memory LLM call per chunk of up to MERGE_BATCH_MAX_SIZE
   * jobs, then applies each job's content. A response entry that is missing
   * or malformed degrades ONLY that job, exactly like the single-call
   * merge-memory failure path: nothing is persisted for it, the target row
   * stays untouched, and it never counts as merged. A chunk whose call
   * itself fails degrades every job in that chunk the same way. Never
   * throws, never fans back out into per-job LLM calls.
   */
  private async flushPendingMerges(
    pendingMerges: PendingMergeJob[],
    stats: ExtractionStats,
    createEntries?: StoreEntry[],
  ): Promise<void> {
    if (pendingMerges.length === 0) {
      return;
    }
    // Extraction-lane additions degrade like the single-call merge failure
    // path (nothing persisted, target untouched). Externally-gated additions
    // must NOT disappear on a degraded merge: they already passed the
    // caller's admission gate and were previously direct-stored, so they
    // fall back to a create built from the caller's own entry.
    const failOpenAdditions = (job: PendingMergeJob, why: string) => {
      if (!createEntries) {
        return;
      }
      for (const addition of job.additions) {
        const ext = this.externalEntryBuilders.get(addition.candidate);
        if (ext?.prebuilt) {
          createEntries.push(ext.prebuilt);
          stats.created++;
          this.log(
            `memory-pro: smart-extractor: merge ${why} — falling back to create for gated candidate [${addition.candidate.category}]`,
          );
        }
      }
    };
    // A job carrying an externally gated addition mirrors under the caller's
    // reflection provenance instead of the generic extraction label.
    const mirrorSourceFor = (job: PendingMergeJob): string | undefined => {
      for (const addition of job.additions) {
        const ext = this.externalEntryBuilders.get(addition.candidate);
        if (ext?.prebuilt) {
          try {
            const rawMeta = ext.prebuilt.metadata;
            const meta =
              typeof rawMeta === "string" && rawMeta.length > 0
                ? (JSON.parse(rawMeta) as Record<string, unknown>)
                : {};
            const heading = (meta as Record<string, unknown>)._reflectionHeading;
            return `reflection:${typeof heading === "string" && heading.length > 0 ? heading : "unknown"}`;
          } catch {
            return "reflection:unknown";
          }
        }
      }
      return undefined;
    };
    const contents = await this.llmMergeContentBatch(pendingMerges);
    for (let i = 0; i < pendingMerges.length; i++) {
      const job = pendingMerges[i];
      const merged = contents[i];
      if (!merged) {
        this.log("memory-pro: smart-extractor: merge LLM failed, skipping merge");
        failOpenAdditions(job, "generation failed");
        continue;
      }
      try {
        const applied = await this.applyMergedContent(
          job.matchId,
          job.category,
          merged,
          job.targetScope,
          job.scopeFilter,
          job.additions.map((a) => a.contextLabel),
          job.additions.map((a) => a.admissionAudit),
          job.agentId,
          mirrorSourceFor(job),
        );
        if (applied === "target-missing") {
          failOpenAdditions(job, "target vanished");
          continue;
        }
        stats.merged += job.additions.length;
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: failed to apply merged content for ${job.matchId.slice(0, 8)}: ${String(err)}`,
        );
        failOpenAdditions(job, "apply failed");
      }
    }
  }

  /**
   * One merge-memory LLM call per chunk of jobs. Returns one merged-content
   * record (or null) per job, in input order; validation requires all three
   * levels as strings with a non-empty abstract, so a malformed entry can
   * never write garbage over an existing row.
   */
  private async llmMergeContentBatch(
    jobs: PendingMergeJob[],
  ): Promise<Array<{ abstract: string; overview: string; content: string } | null>> {
    const out: Array<{ abstract: string; overview: string; content: string } | null> =
      new Array(jobs.length).fill(null);
    for (let chunkStart = 0; chunkStart < jobs.length; chunkStart += this.batchChunkSize()) {
      const chunk = jobs.slice(chunkStart, chunkStart + this.batchChunkSize());
      const { system, user } = buildBatchMergePrompt(
        chunk.map((job) => ({
          category: job.category,
          existing: job.existing,
          additions: job.additions.map((a) => ({
            abstract: a.candidate.abstract,
            overview: a.candidate.overview,
            content: a.candidate.content,
          })),
        })),
      );
      try {
        const response = await this.llm.completeJson<{
          results?: Array<{ index?: number; abstract?: string; overview?: string; content?: string }>;
        }>(user, "merge-memory-batch", system);

        const byIndex = new Map<number, { abstract?: string; overview?: string; content?: string }>();
        for (const entry of response && Array.isArray(response.results) ? response.results : []) {
          if (!entry || typeof entry.index !== "number") continue;
          byIndex.set(entry.index, entry);
        }
        chunk.forEach((_, i) => {
          const entry = byIndex.get(i + 1);
          if (
            entry &&
            typeof entry.abstract === "string" &&
            entry.abstract.trim().length > 0 &&
            typeof entry.overview === "string" &&
            typeof entry.content === "string"
          ) {
            out[chunkStart + i] = {
              abstract: entry.abstract,
              overview: entry.overview,
              content: entry.content,
            };
          }
        });
      } catch (err) {
        this.log(
          `memory-pro: smart-extractor: merge LLM failed: ${String(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * Applies already-generated merged content to the target row: re-embed,
   * store.update, persistence notification, then the best-effort support
   * stats update once per merged-in candidate. Shared by the inline
   * single-call merge path and the batched merge writer.
   */
  private async applyMergedContent(
    matchId: string,
    category: MemoryCategory,
    merged: { abstract: string; overview: string; content: string },
    targetScope: string,
    scopeFilter: string[] | undefined,
    contextLabels: Array<string | undefined>,
    admissionEvidence: Array<AdmissionWriteEvidence | undefined> | undefined,
    agentId: string | undefined,
    mirrorSource: string = "smart-extraction",
  ): Promise<"updated" | "target-missing"> {
    // Re-embed the merged content
    const mergedText = `${merged.abstract} ${merged.content}`;
    const newVector = await this.embedder.embed(mergedText);

    // Update existing memory via store.update(). A target that vanished
    // between dedup and this write must surface as "target-missing" so the
    // caller can fall back — reporting success here would silently drop the
    // candidate and emit a persistence notification for a write that never
    // durably landed.
    const existing = await this.store.getById(matchId, scopeFilter);
    if (!existing) {
      this.log(
        `memory-pro: smart-extractor: merge target ${matchId.slice(0, 8)} vanished before update`,
      );
      return "target-missing";
    }
    // A merge enriches the target's content; it never reclassifies the row.
    // Stamping the incoming candidate's category would desync the metadata
    // from the legacy category column, and list()'s two stages (column
    // SQL-prefilter, then metadata validation) would drop the row from BOTH
    // category views on a cross-category merge.
    const existingMeta = parseSmartMetadata(existing.metadata, existing);
    const targetCategory = (existingMeta.memory_category as MemoryCategory) || category;
    // A grouped merge folds N additions into one write: the first addition
    // keeps the historical single-evidence semantics, and every later
    // addition's audit/fail-open evidence is appended to the capped
    // append-only field so no row's admission provenance is dropped.
    const metadata = stringifySmartMetadata(
      this.appendAdditionalAdmissionEvidence(
        this.withAdmissionAudit(
          buildSmartMetadata(existing, {
            l0_abstract: merged.abstract,
            l1_overview: merged.overview,
            l2_content: merged.content,
            memory_category: targetCategory,
            tier: "working",
            confidence: 0.8,
          }),
          admissionEvidence?.[0],
        ),
        admissionEvidence?.slice(1) ?? [],
      ),
    );

    const updated = await this.store.update(
      matchId,
      {
        text: merged.abstract,
        vector: newVector,
        metadata,
      },
      scopeFilter,
    );
    if (!updated) {
      this.log(
        `memory-pro: smart-extractor: merge target ${matchId.slice(0, 8)} vanished during update`,
      );
      return "target-missing";
    }

    await this.notifyPersisted(
      {
        text: merged.abstract,
        category: this.mapToStoreCategory(targetCategory),
        scope: targetScope,
        timestamp: Date.now(),
      },
      mirrorSource,
      agentId,
    );

    for (const contextLabel of contextLabels) {
      // Update support stats on the merged memory
      try {
        const updatedEntry = await this.store.getById(matchId, scopeFilter);
        if (updatedEntry) {
          const meta = parseSmartMetadata(updatedEntry.metadata, updatedEntry);
          const supportInfo = parseSupportInfo(meta.support_info);
          const updated = updateSupportStats(supportInfo, contextLabel, "support");
          const finalMetadata = stringifySmartMetadata({ ...meta, support_info: updated });
          await this.store.update(matchId, { metadata: finalMetadata }, scopeFilter);
        }
      } catch {
        // Non-critical: merge succeeded, support stats update is best-effort
      }

      this.log(
        `memory-pro: smart-extractor: merged [${targetCategory}]${contextLabel ? ` [${contextLabel}]` : ""} into ${matchId.slice(0, 8)}`,
      );
    }
    return "updated";
  }

  /**
   * Handle SUPERSEDE: preserve the old record as historical but mark it as no
   * longer current, then create the new active fact.
   */
  private async handleSupersede(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter?: string[],
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    pendingSupersedeInvalidations?: PendingSupersedeInvalidation[],
    agentId?: string,
  ): Promise<"deferred" | "superseded" | "create-only"> {
    const existing = await this.store.getById(matchId, scopeFilter);
    if (!existing) {
      createEntries?.push(
        await this.externalOrBuiltFallbackEntry(candidate, targetScope, sessionKey, vector, admissionAudit),
      );
      return "create-only";
    }

    const now = Date.now();
    const existingMeta = parseSmartMetadata(existing.metadata, existing);
    const factKey =
      existingMeta.fact_key ?? deriveFactKey(candidate.category, candidate.abstract);
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const supersedeClassifyText = candidate.content || candidate.abstract;
    const entry: StoreEntry = this.externalVerdictEntry(candidate, {
      state: "confirmed",
      valid_from: now,
      fact_key: factKey,
      supersedes: matchId,
      relations: appendRelation([], { type: "supersedes", targetId: matchId }),
      memory_temporal_type: classifyTemporal(supersedeClassifyText),
      valid_until: inferExpiry(supersedeClassifyText),
    }) ?? {
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata: stringifySmartMetadata(
        buildSmartMetadata(
          {
            text: candidate.abstract,
            category: storeCategory,
          },
          {
            l0_abstract: candidate.abstract,
            l1_overview: candidate.overview,
            l2_content: candidate.content,
            memory_category: candidate.category,
            tier: "working",
            access_count: 0,
            confidence: 0.7,
            source_session: sessionKey,
            source: "auto-capture",
            state: "confirmed", // #350: write confirmed to unblock auto-recall
            memory_layer: "working",
            injected_count: 0,
            bad_recall_count: 0,
            suppressed_until_turn: 0,
            valid_from: now,
            fact_key: factKey,
            supersedes: matchId,
            relations: appendRelation([], {
              type: "supersedes",
              targetId: matchId,
            }),
            memory_temporal_type: classifyTemporal(supersedeClassifyText),
            valid_until: inferExpiry(supersedeClassifyText),
          },
        ),
      ),
    };

    if (createEntries && pendingSupersedeInvalidations) {
      const entryIndex = createEntries.length;
      createEntries.push(entry);
      pendingSupersedeInvalidations.push({
        entryIndex,
        entry,
        matchId,
        existing,
        factKey,
        scopeFilter,
      });
      return "deferred";
    }

    const created = await this.store.store(entry);
    const invalidated = await this.invalidateSupersededMemory(
      matchId,
      existing,
      factKey,
      created,
      scopeFilter,
    );
    await this.notifyPersisted(
      { text: created.text, category: created.category, scope: created.scope, timestamp: created.timestamp },
      "smart-extraction",
      agentId,
    );

    if (invalidated) {
      this.log(
        `memory-pro: smart-extractor: superseded [${candidate.category}] ${matchId.slice(0, 8)} -> ${created.id.slice(0, 8)}`,
      );
      return "superseded";
    }
    return "create-only";
  }

  private async applyPendingSupersedeInvalidations(
    queuedEntries: StoreEntry[],
    createdEntries: MemoryEntry[],
    pendingSupersedeInvalidations: PendingSupersedeInvalidation[],
    stats?: { superseded?: number },
  ): Promise<void> {
    const claimedIds = new Set<string>();
    const resolveCreated = (
      pending: PendingSupersedeInvalidation,
    ): MemoryEntry | undefined => {
      if (createdEntries.length === queuedEntries.length) {
        return createdEntries[pending.entryIndex];
      }
      // bulkStore accepted fewer entries than were queued, so positions have
      // shifted: bind by stable entry identity (the same fallback the
      // sibling-verdict resolver uses) and never invalidate unless the exact
      // replacement row is found — a positional read here could point the
      // old row's superseded_by at an unrelated create.
      const want = pending.entry;
      return createdEntries.find(
        (e) =>
          e.text === want.text &&
          e.category === want.category &&
          laneFromMetadata(e.metadata) === laneFromMetadata(want.metadata) &&
          !claimedIds.has(e.id),
      );
    };
    for (const pending of pendingSupersedeInvalidations) {
      const created = resolveCreated(pending);
      if (!created) {
        this.log(
          `memory-pro: smart-extractor: supersede invalidation skipped for ${pending.matchId.slice(0, 8)} because batch create returned no matching replacement entry`,
        );
        continue;
      }
      claimedIds.add(created.id);
      const invalidated = await this.invalidateSupersededMemory(
        pending.matchId,
        pending.existing,
        pending.factKey,
        created,
        pending.scopeFilter,
      );
      if (invalidated) {
        if (stats) {
          stats.superseded = (stats.superseded ?? 0) + 1;
        }
        this.log(
          `memory-pro: smart-extractor: superseded ${pending.matchId.slice(0, 8)} -> ${created.id.slice(0, 8)}`,
        );
      }
    }
  }

  /**
   * Invalidate the superseded row AFTER its replacement is committed. The
   * replacement commit is irrevocable by this point, so this step must never
   * reject past it: any failure (thrown read/update, or an update that
   * reports nothing written) is isolated per row, the outcome downgrades to
   * a plain CREATE, and the replacement's supersedes claim is stripped
   * best-effort so the pair never reports a supersede that did not happen.
   * Returns true only when the old row was actually invalidated.
   */
  private async invalidateSupersededMemory(
    matchId: string,
    existing: MemoryEntry,
    factKey: string,
    created: MemoryEntry,
    scopeFilter?: string[],
  ): Promise<boolean> {
    try {
      const existingMeta = parseSmartMetadata(existing.metadata, existing);
      const invalidatedMetadata = buildSmartMetadata(existing, {
        fact_key: factKey,
        invalidated_at: Date.now(),
        superseded_by: created.id,
        relations: appendRelation(existingMeta.relations, {
          type: "superseded_by",
          targetId: created.id,
        }),
      });

      const written = await this.store.update(
        matchId,
        { metadata: stringifySmartMetadata(invalidatedMetadata) },
        scopeFilter,
      );
      if (written) {
        return true;
      }
      await this.downgradeSupersedeToCreate(matchId, created, scopeFilter, "update wrote nothing");
      return false;
    } catch (err) {
      await this.downgradeSupersedeToCreate(matchId, created, scopeFilter, String(err));
      return false;
    }
  }

  private async downgradeSupersedeToCreate(
    matchId: string,
    created: MemoryEntry,
    scopeFilter: string[] | undefined,
    cause: string,
  ): Promise<void> {
    let stripped = false;
    try {
      const createdMeta = parseSmartMetadata(created.metadata, created);
      delete (createdMeta as Record<string, unknown>).supersedes;
      createdMeta.relations = (createdMeta.relations ?? []).filter(
        (r) => !(r.type === "supersedes" && r.targetId === matchId),
      );
      stripped = Boolean(
        await this.store.update(
          created.id,
          { metadata: stringifySmartMetadata(createdMeta) },
          scopeFilter,
        ),
      );
    } catch (stripErr) {
      this.log(
        `memory-pro: smart-extractor: supersede-claim strip failed for ${created.id.slice(0, 8)}: ${String(stripErr)}`,
      );
    }
    if (stripped) {
      this.log(
        `memory-pro: smart-extractor: supersede invalidation failed for ${matchId.slice(0, 8)} (${cause}) — outcome downgraded to plain CREATE, old row remains active`,
      );
    } else {
      // The downgrade itself could not be confirmed: the old row is still
      // active AND the replacement still carries a durable supersedes claim.
      // Surface the unresolved repair state instead of a success-style log.
      this.log(
        `memory-pro: smart-extractor: UNRESOLVED supersede repair for ${matchId.slice(0, 8)} (${cause}) — old row remains active and replacement ${created.id.slice(0, 8)} still carries its supersedes claim (strip unconfirmed)`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Context-Aware Handlers (support / contextualize / contradict)
  // --------------------------------------------------------------------------

  /**
   * Handle SUPPORT: update support stats on existing memory for a specific context.
   */
  private async handleSupport(
    matchId: string,
    source: { session: string; timestamp: number },
    reason: string,
    contextLabel?: string,
    scopeFilter?: string[],
    admissionAudit?: AdmissionWriteEvidence,
  ): Promise<"supported" | "target-missing"> {
    const existing = await this.store.getById(matchId, scopeFilter);
    if (!existing) {
      this.log(
        `memory-pro: smart-extractor: support target ${matchId.slice(0, 8)} no longer exists`,
      );
      return "target-missing";
    }

    const meta = parseSmartMetadata(existing.metadata, existing);
    const supportInfo = parseSupportInfo(meta.support_info);
    const updated = updateSupportStats(supportInfo, contextLabel, "support");
    meta.support_info = updated;

    const written = await this.store.update(
      matchId,
      { metadata: stringifySmartMetadata(this.withAdmissionAudit(meta, admissionAudit)) },
      scopeFilter,
    );
    if (!written) {
      this.log(
        `memory-pro: smart-extractor: support target ${matchId.slice(0, 8)} vanished during update`,
      );
      return "target-missing";
    }

    this.log(
      `memory-pro: smart-extractor: support [${contextLabel || "general"}] on ${matchId.slice(0, 8)} — ${reason}`,
    );
    return "supported";
  }

  /**
   * Handle CONTEXTUALIZE: create a new entry that adds situational nuance,
   * linked to the original via a relation in metadata.
   */
  private async handleContextualize(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter?: string[],
    contextLabel?: string,
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    agentId?: string,
  ): Promise<void> {
    // A vanished target downgrades to an ordinary create: never persist a
    // relation to a row that no longer exists. A THROWING read gets the same
    // treatment — dropping an admitted candidate over a transient store
    // failure would silently lose it.
    let targetExists = false;
    try {
      targetExists = Boolean(await this.store.getById(matchId, scopeFilter));
      if (!targetExists) {
        this.log(
          `memory-pro: smart-extractor: contextualize target ${matchId.slice(0, 8)} no longer exists — storing as ordinary create without a relation`,
        );
      }
    } catch (readErr) {
      this.log(
        `memory-pro: smart-extractor: contextualize target read failed for ${matchId.slice(0, 8)} (${String(readErr)}) — storing as ordinary create without a relation`,
      );
    }
    const contextualizeRelations = targetExists
      ? [{ type: "contextualizes", targetId: matchId }]
      : [];
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const metadata = stringifySmartMetadata(this.withAdmissionAudit({
      l0_abstract: candidate.abstract,
      l1_overview: candidate.overview,
      l2_content: candidate.content,
      memory_category: candidate.category,
      tier: "working" as const,
      access_count: 0,
      confidence: 0.7,
      last_accessed_at: Date.now(),
      source_session: sessionKey,
      source: "auto-capture" as const,
      state: "confirmed" as const, // #350: write confirmed to unblock auto-recall
      memory_layer: "working" as const,
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
      contexts: contextLabel ? [contextLabel] : [],
      relations: contextualizeRelations,
    }, admissionAudit));

    const entry_c: StoreEntry = this.externalVerdictEntry(candidate, {
      state: "confirmed",
      contexts: contextLabel ? [contextLabel] : [],
      relations: contextualizeRelations,
    }) ?? {
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    };
    if (createEntries) {
      createEntries.push(entry_c);
    } else {
      const created = await this.store.store(entry_c);
      await this.notifyPersisted(
        { text: created.text, category: created.category, scope: created.scope, timestamp: created.timestamp },
        "smart-extraction",
        agentId,
      );
    }

    this.log(
      `memory-pro: smart-extractor: contextualize [${contextLabel || "general"}] new entry linked to ${matchId.slice(0, 8)}`,
    );
  }

  /**
   * Handle CONTRADICT: create contradicting entry + record contradiction evidence
   * on the original memory's support stats.
   */
  private async handleContradict(
    candidate: CandidateMemory,
    vector: number[],
    matchId: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter?: string[],
    contextLabel?: string,
    admissionAudit?: AdmissionWriteEvidence,
    createEntries?: StoreEntry[],
    agentId?: string,
  ): Promise<void> {
    // 1. Record contradiction on the existing memory. The relation below is
    // persisted only when this evidence write CONFIRMS the target still
    // exists — a read/update that throws or reports nothing written means
    // the target is gone (or unprovable), and a relation to it would dangle.
    let targetLinked = false;
    try {
      const existing = await this.store.getById(matchId, scopeFilter);
      if (existing) {
        const meta = parseSmartMetadata(existing.metadata, existing);
        const supportInfo = parseSupportInfo(meta.support_info);
        const updated = updateSupportStats(supportInfo, contextLabel, "contradict");
        meta.support_info = updated;
        const written = await this.store.update(
          matchId,
          { metadata: stringifySmartMetadata(meta) },
          scopeFilter,
        );
        if (written) {
          targetLinked = true;
        } else {
          this.log(
            `memory-pro: smart-extractor: contradict target ${matchId.slice(0, 8)} vanished during update — storing as ordinary create without a relation`,
          );
        }
      } else {
        this.log(
          `memory-pro: smart-extractor: contradict target ${matchId.slice(0, 8)} no longer exists — storing as ordinary create without a relation`,
        );
      }
    } catch (evidenceErr) {
      this.log(
        `memory-pro: smart-extractor: contradict target read/update failed for ${matchId.slice(0, 8)} (${String(evidenceErr)}) — storing as ordinary create without a relation`,
      );
    }

    // 2. Store the contradicting entry as a new memory.
    const contradictRelations = targetLinked ? [{ type: "contradicts", targetId: matchId }] : [];
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const metadata = stringifySmartMetadata(this.withAdmissionAudit({
      l0_abstract: candidate.abstract,
      l1_overview: candidate.overview,
      l2_content: candidate.content,
      memory_category: candidate.category,
      tier: "working" as const,
      access_count: 0,
      confidence: 0.7,
      last_accessed_at: Date.now(),
      source_session: sessionKey,
      source: "auto-capture" as const,
      state: "confirmed" as const, // #350: write confirmed to unblock auto-recall
      memory_layer: "working" as const,
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
      contexts: contextLabel ? [contextLabel] : [],
      relations: contradictRelations,
    }, admissionAudit));

    const entry_d: StoreEntry = this.externalVerdictEntry(candidate, {
      state: "confirmed",
      contexts: contextLabel ? [contextLabel] : [],
      relations: contradictRelations,
    }) ?? {
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    };
    if (createEntries) {
      createEntries.push(entry_d);
    } else {
      const created = await this.store.store(entry_d);
      await this.notifyPersisted(
        { text: created.text, category: created.category, scope: created.scope, timestamp: created.timestamp },
        "smart-extraction",
        agentId,
      );
    }

    this.log(
      `memory-pro: smart-extractor: contradict [${contextLabel || "general"}] on ${matchId.slice(0, 8)}, new entry created`,
    );
  }

  // --------------------------------------------------------------------------
  // Store Helper
  // --------------------------------------------------------------------------

  /**
   * Entry-shape overrides for candidates persisted on behalf of another
   * lane (persistGatedCandidates): the reflection writer supplies its own
   * store entry (reflection metadata, decay model, importance) while the
   * dedup/merge pipeline stays byte-identical to extraction's. Keyed by
   * candidate object identity, so extraction's own candidates can never
   * collide with an external lane's builders.
   */
  private readonly externalEntryBuilders = new WeakMap<
    CandidateMemory,
    {
      build: (vector: number[]) => StoreEntry;
      prebuilt?: StoreEntry;
      audit?: AdmissionAuditRecord;
      failOpen?: AdmissionFailOpenEvidence;
    }
  >();

  /**
   * Verdict rows for externally-gated candidates must originate from the
   * caller's own entry — reflection provenance, heading, mapped kind, decay
   * model, importance, and admission audit all live there — with only the
   * verdict-specific fields layered on top. Returns null for ordinary
   * extraction candidates, which keep the auto-capture shape.
   */
  private externalVerdictEntry(
    candidate: CandidateMemory,
    overlay: Record<string, unknown>,
  ): StoreEntry | null {
    const ext = this.externalEntryBuilders.get(candidate);
    if (!ext?.prebuilt) {
      return null;
    }
    const base = ext.prebuilt;
    let meta: Record<string, unknown> = {};
    if (typeof base.metadata === "string" && base.metadata.length > 0) {
      try {
        meta = JSON.parse(base.metadata);
      } catch {
        meta = {};
      }
    }
    return { ...base, metadata: JSON.stringify({ ...meta, ...overlay }) };
  }

  /**
   * Build a memory entry from candidate data (without writing).
   * Used by batch creation to reduce lock acquisitions.
   */
  private buildStoreEntry(
    candidate: CandidateMemory,
    vector: number[],
    sessionKey: string,
    targetScope: string,
    admissionAudit?: AdmissionWriteEvidence,
  ): Omit<import("./store.js").MemoryEntry, "id" | "timestamp"> {
    const external = this.externalEntryBuilders.get(candidate);
    if (external) {
      return external.prebuilt ?? external.build(vector);
    }
    const storeCategory = this.mapToStoreCategory(candidate.category);
    const classifyText = candidate.content || candidate.abstract;
    const metadata = stringifySmartMetadata(
      buildSmartMetadata(
        {
          text: candidate.abstract,
          category: storeCategory,
        },
        {
          l0_abstract: candidate.abstract,
          l1_overview: candidate.overview,
          l2_content: candidate.content,
          memory_category: candidate.category,
          tier: "working",
          access_count: 0,
          confidence: 0.7,
          source_session: sessionKey,
          source: "auto-capture",
          state: "confirmed", // #350: write confirmed to unblock auto-recall
          memory_layer: "working",
          injected_count: 0,
          bad_recall_count: 0,
          suppressed_until_turn: 0,
          memory_temporal_type: classifyTemporal(classifyText),
          valid_until: inferExpiry(classifyText),
          // Grounding audit trail: the tag and register this memory was
          // admitted under — the DERIVED values that governed filtering
          // (legacy payloads without the fields normalize to real/"mixed").
          ...(candidate.grounding ? { grounding: candidate.grounding } : {}),
          ...(candidate.conversationRegister
            ? { conversation_register: candidate.conversationRegister }
            : {}),
          ...(admissionAudit ? { admission_audit: JSON.stringify(admissionAudit) } : {}),
        },
      ),
    );

    return {
      text: candidate.abstract,
      vector,
      category: storeCategory,
      scope: targetScope,
      importance: this.getDefaultImportance(candidate.category),
      metadata,
    };
  }

  /**
   * Store a candidate memory as a new entry with L0/L1/L2 metadata.
   */
  private async storeCandidate(
    candidate: CandidateMemory,
    vector: number[],
    sessionKey: string,
    targetScope: string,
    admissionAudit?: AdmissionWriteEvidence,
  ): Promise<void> {
    const entry = this.buildStoreEntry(candidate, vector, sessionKey, targetScope, admissionAudit);
    await this.store.store(entry);

    this.log(
      `memory-pro: smart-extractor: created [${candidate.category}] ${candidate.abstract.slice(0, 60)}`,
    );
  }

  /**
   * Map 6-category to existing 5-category store type for backward compatibility.
   */
  /**
   * Map a smart register onto its legacy storage category, delegating to the
   * shared SMART_TO_STORAGE_CATEGORY constant (memory-categories) so the
   * mapping has a single source of truth. Note: "reflection" is a legacy
   * storage category minted only by the reflection writer and is deliberately
   * absent from this map; smart extraction never produces reflection rows.
   * The "other" fallback covers non-union values arriving from untyped
   * callers at runtime, matching the old switch's default arm.
   */
  private mapToStoreCategory(
    category: MemoryCategory,
  ): "preference" | "fact" | "decision" | "entity" | "other" {
    return getStorageCategoryForMemoryCategory(category) ?? "other";
  }

  /**
   * Get default importance score by category.
   */
  private getDefaultImportance(category: MemoryCategory): number {
    switch (category) {
      case "profile":
        return 0.9; // Identity is very important
      case "preferences":
        return 0.8;
      case "entities":
        return 0.7;
      case "events":
        return 0.6;
      case "cases":
        return 0.8; // Problem-solution pairs are high value
      case "patterns":
        return 0.85; // Reusable processes are high value
      default:
        return 0.5;
    }
  }

  // --------------------------------------------------------------------------
  // Admission Control Helpers
  // --------------------------------------------------------------------------

  /**
   * Embed admission audit record into metadata if audit persistence is enabled.
   */
  private admissionWriteEvidenceFor(
    candidate: CandidateMemory,
    admission?: { audit?: AdmissionAuditRecord },
  ): AdmissionWriteEvidence | undefined {
    return admission?.audit ?? this.externalEntryBuilders.get(candidate)?.failOpen;
  }

  private withAdmissionAudit<T extends Record<string, unknown>>(
    metadata: T,
    admissionAudit?: AdmissionWriteEvidence,
  ): T & { admission_control?: AdmissionAuditRecord } {
    if (!admissionAudit || !this.persistAdmissionAudit) {
      return metadata as T & { admission_control?: AdmissionAuditRecord };
    }
    if (isFailOpenEvidence(admissionAudit)) {
      // A fail-open marker proves this mutation carried unevaluated content.
      // Preserve whatever complete audit the target already has and append
      // the marker as bypass evidence (append-only, capped to the newest).
      const prior = Array.isArray((metadata as Record<string, unknown>).admission_bypass_events)
        ? ((metadata as Record<string, unknown>).admission_bypass_events as unknown[])
        : [];
      const events = [...prior, { at: Date.now(), ...admissionAudit }].slice(
        -MAX_ADMISSION_BYPASS_EVENTS,
      );
      return {
        ...metadata,
        admission_bypass_events: events,
      } as T & { admission_control?: AdmissionAuditRecord };
    }
    return { ...metadata, admission_control: admissionAudit };
  }

  /**
   * Append every non-first addition's evidence from a grouped mutation to a
   * capped append-only history, so no addition loses its admission
   * provenance. The two evidence kinds stay in separate fields:
   * admission_bypass_events remains exclusive to fail-open markers
   * (unevaluated content), while complete audits append to
   * admission_control_history — a pass audit must never consume the bypass
   * cap and evict genuine fail-open evidence.
   */
  private appendAdditionalAdmissionEvidence<T extends Record<string, unknown>>(
    metadata: T,
    evidence: Array<AdmissionWriteEvidence | undefined>,
  ): T {
    const additional = evidence.filter((e): e is AdmissionWriteEvidence => Boolean(e));
    if (additional.length === 0 || !this.persistAdmissionAudit) {
      return metadata;
    }
    const now = Date.now();
    const priorOf = (field: string): unknown[] =>
      Array.isArray((metadata as Record<string, unknown>)[field])
        ? ((metadata as Record<string, unknown>)[field] as unknown[])
        : [];
    const stamped = (records: AdmissionWriteEvidence[]) => records.map((e) => ({ at: now, ...e }));
    const bypassMarkers = additional.filter((e) => isFailOpenEvidence(e));
    const completeAudits = additional.filter((e) => !isFailOpenEvidence(e));
    const next: Record<string, unknown> = { ...metadata };
    if (bypassMarkers.length > 0) {
      next.admission_bypass_events = [...priorOf("admission_bypass_events"), ...stamped(bypassMarkers)].slice(
        -MAX_ADMISSION_BYPASS_EVENTS,
      );
    }
    if (completeAudits.length > 0) {
      next.admission_control_history = [...priorOf("admission_control_history"), ...stamped(completeAudits)].slice(
        -MAX_ADMISSION_CONTROL_HISTORY,
      );
    }
    return next as T;
  }

  /**
   * Record a rejected admission to the durable audit log.
   */
  private async recordRejectedAdmission(
    candidate: CandidateMemory,
    conversationText: string,
    sessionKey: string,
    targetScope: string,
    scopeFilter: string[],
    audit: AdmissionAuditRecord & { decision: "reject" },
  ): Promise<void> {
    if (!this.onAdmissionRejected) {
      return;
    }
    try {
      await this.onAdmissionRejected({
        version: "amac-v1",
        rejected_at: Date.now(),
        session_key: sessionKey,
        target_scope: targetScope,
        scope_filter: scopeFilter,
        candidate,
        audit,
        conversation_excerpt: conversationText.slice(-1200),
      });
    } catch (err) {
      this.log(
        `memory-lancedb-pro: smart-extractor: rejected admission audit write failed: ${String(err)}`,
      );
    }
  }
}

// ============================================================================
// Extraction Rate Limiter (Feature 7: Adaptive Extraction Throttling)
// ============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ExtractionRateLimiterOptions {
  /** Maximum number of extractions allowed per hour (default: 30) */
  maxExtractionsPerHour?: number;
}

export interface ExtractionRateLimiter {
  /** Check whether the current rate would exceed the limit */
  isRateLimited(): boolean;
  /** Record a new extraction timestamp */
  recordExtraction(): void;
  /** Get the number of extractions in the current window */
  getRecentCount(): number;
}

/**
 * Create an extraction rate limiter that tracks timestamps in a sliding
 * one-hour window.
 */
export function createExtractionRateLimiter(
  options: ExtractionRateLimiterOptions = {},
): ExtractionRateLimiter {
  const maxPerHour = options.maxExtractionsPerHour ?? 30;
  const timestamps: number[] = [];

  function pruneOld(): void {
    const cutoff = Date.now() - ONE_HOUR_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  return {
    isRateLimited(): boolean {
      pruneOld();
      return timestamps.length >= maxPerHour;
    },

    recordExtraction(): void {
      pruneOld();
      timestamps.push(Date.now());
    },

    getRecentCount(): number {
      pruneOld();
      return timestamps.length;
    },
  };
}
