import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryEntry } from "./store.js";
import {
  parseSmartMetadata,
  buildSmartMetadata,
  stringifySmartMetadata,
  appendRelation,
  deriveFactKey,
  isMemoryActiveAt,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { APPEND_ONLY_CATEGORIES, type MemoryCategory } from "./memory-categories.js";
import {
  buildConsolidateBatchPrompt,
  buildConsolidateBatchMergePrompt,
  type ConsolidateBatchCluster,
} from "./extraction-prompts.js";

export type ConsolidateVerdict = "skip" | "merge" | "supersede" | "contradict";

export interface ConsolidateVerdictResult {
  verdict: ConsolidateVerdict;
  reason: string;
  survivorIndex?: number;
  absorbedIndices?: number[];
}

export interface ConsolidateCandidate {
  entry: MemoryEntry;
  memoryCategory?: MemoryCategory;
  abstract: string;
  overview: string;
  content: string;
  factKey?: string;
  source?: string;
  validFrom?: number;
  /** Memoized at build time: clustering compares every pair, so per-pair recomputation is O(n^2) waste. */
  topicTokens: Set<string>;
  reversal: boolean;
  topicLinkEligible: boolean;
  /** Unit-normalized vector (null when the row has none): pairwise cosine reduces to a dot product. */
  unitVector: number[] | null;
}

const REVERSAL_SIGNAL_PATTERN =
  /\b(no longer|not anymore|any ?more|stopped|quit|used to|former|discontinued|doesn'?t|don'?t|isn'?t|wasn'?t)\b/i;

const TOPIC_TOKEN_STOPWORDS = new Set([
  "user", "users", "prefer", "prefers", "preferred", "preference", "preferences",
  "favorite", "favourite", "likes", "liked", "like", "dislikes", "dislike",
  "drinking", "drinks", "drink", "drank", "still", "always", "anymore", "any",
  "more", "longer", "stopped", "quit", "used", "no", "not", "the", "a", "an",
  "of", "to", "and", "with", "their", "they", "was", "is", "are", "were",
  "has", "have", "had", "will", "would", "their", "for", "at", "in", "on",
  // Generic life-update narration: these appear across many unrelated life
  // events/decisions and would otherwise let a single multi-topic narrative
  // row bridge several unrelated topic clusters via incidental overlap.
  "decided", "decide", "redesign", "redesigning", "relocate",
  "relocating", "moved", "move", "moving", "changed", "change", "changing",
  "switched", "switch", "started", "start", "starting", "continuing",
  "continues", "testing", "tested", "experiment", "experimenting", "after",
  "before", "now", "previously", "recently", "incident", "productivity",
  "better", "correctly", "confirmed", "offered", "each", "record", "records",
  "distinct", "fact", "facts", "note", "notes", "update", "updates", "updated",
  "from", "into", "this", "that", "these", "those", "it", "its", "them",
]);

function looksLikeReversal(text: string): boolean {
  return REVERSAL_SIGNAL_PATTERN.test(text);
}

function extractTopicTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  return new Set(words.filter((w) => !TOPIC_TOKEN_STOPWORDS.has(w)));
}

// Reversal statements are typically short ("User will no longer drink
// cola"); a long multi-fact narrative recap can mention almost every topic
// in a scope at once and would otherwise bridge unrelated clusters through
// incidental keyword overlap. Only short, single-topic-looking statements
// participate in the topic-overlap fallback.
const REVERSAL_TOPIC_LINK_MAX_LENGTH = 120;

function isEligibleForTopicLink(abstract: string): boolean {
  return abstract.length <= REVERSAL_TOPIC_LINK_MAX_LENGTH;
}

// Tokens match on exact equality or containment (one is a substring of the
// other, e.g. "cola" inside "coca-cola"), since brand/product names are
// routinely abbreviated across lanes. The shorter token must still be long
// enough (>= 4 chars) to keep an accidental short-token containment match
// from firing.
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 4) return false;
  // Containment only at compound-token boundaries: "cola" matches
  // "coca-cola" because it is a delimiter-separated PART of it, while raw
  // substring matching let "port" match "support" and "report" and bridge
  // unrelated rows.
  if (!longer.includes("-") && !longer.includes("'")) return false;
  return longer.split(/[-']/).some((part) => part === shorter);
}

function shareSignificantTopicToken(tokensA: Set<string>, tokensB: Set<string>): boolean {
  for (const tokenA of tokensA) {
    for (const tokenB of tokensB) {
      if (tokensMatch(tokenA, tokenB)) return true;
    }
  }
  return false;
}

// Fraction of the SMALLER topic-token set that matches the other set
// (0 when either side has no topic tokens at all). Two short statements
// about the same narrow fact typically share MOST of their significant
// words even when phrased completely differently across write lanes
// (e.g. "Favorite drink: cola" vs "Cola is what gets ordered most
// evenings" both reduce to essentially {"cola"}); two short statements
// about DIFFERENT facts rarely do, which is what keeps this fallback from
// bridging unrelated rows the way a single-shared-token check would.
function topicTokenOverlapCounts(
  tokensA: Set<string>,
  tokensB: Set<string>,
): { matches: number; minSize: number; maxSize: number } {
  let matches = 0;
  for (const tokenA of tokensA) {
    for (const tokenB of tokensB) {
      if (tokensMatch(tokenA, tokenB)) {
        matches += 1;
        break;
      }
    }
  }
  return { matches, minSize: Math.min(tokensA.size, tokensB.size), maxSize: Math.max(tokensA.size, tokensB.size) };
}

const NEAR_DUPLICATE_TOKEN_OVERLAP_RATIO = 0.6;
// Two-sided guard: the smaller-set ratio alone lets ONE shared token bridge
// a single-token row onto any larger row mentioning that word. The larger
// set must also be mostly covered before two rows count as the same fact.
const NEAR_DUPLICATE_MAJOR_OVERLAP_RATIO = 0.5;

function topicTokensNearDuplicate(tokensA: Set<string>, tokensB: Set<string>): boolean {
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const smaller = tokensA.size <= tokensB.size ? tokensA : tokensB;
  const larger = tokensA.size <= tokensB.size ? tokensB : tokensA;
  if (smaller.size === 1) {
    // Single-topic-token rows are the motivating cross-lane case ("Favorite
    // drink: cola" against a paraphrase whose only content token is cola).
    // The lone anchor must match a WHOLE token (equality, or a
    // delimiter-separated compound part like cola in coca-cola) -- a raw
    // substring fragment can never be the entire bridge -- and clustering
    // only nominates the pair; the decider and the append-only shield still
    // adjudicate it.
    const [only] = smaller;
    for (const token of larger) {
      if (tokensMatch(only, token)) return true;
    }
    return false;
  }
  const { matches, minSize, maxSize } = topicTokenOverlapCounts(tokensA, tokensB);
  return matches / minSize >= NEAR_DUPLICATE_TOKEN_OVERLAP_RATIO && matches / maxSize >= NEAR_DUPLICATE_MAJOR_OVERLAP_RATIO;
}

function normalizeVector(v: number[]): number[] | null {
  if (v.length === 0) return null;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function unitDot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function buildConsolidateCandidate(entry: MemoryEntry): ConsolidateCandidate {
  const meta: SmartMemoryMetadata = parseSmartMetadata(entry.metadata, entry);
  const abstract = meta.l0_abstract || entry.text;
  const factKey = meta.fact_key || deriveFactKey(meta.memory_category, abstract);
  return {
    entry,
    memoryCategory: meta.memory_category,
    abstract,
    overview: meta.l1_overview || "",
    content: meta.l2_content || entry.text,
    factKey,
    source: meta.source,
    validFrom: meta.valid_from,
    topicTokens: extractTopicTokens(abstract),
    reversal: looksLikeReversal(abstract),
    topicLinkEligible: isEligibleForTopicLink(abstract),
    unitVector: normalizeVector(entry.vector),
  };
}

function isDirectlyLinked(
  a: ConsolidateCandidate,
  b: ConsolidateCandidate,
  similarityThreshold: number
): boolean {
  if (a.unitVector && b.unitVector && unitDot(a.unitVector, b.unitVector) >= similarityThreshold) {
    return true;
  }
  if (a.factKey && a.factKey === b.factKey) {
    return true;
  }
  // Reflection-mapped rows carry no stored fact_key, and a naturally phrased
  // reversal rarely follows the "[Merge key]: text" convention that
  // deriveFactKey needs to align across lanes, so its derived key is
  // effectively unique. Gate a topic-word-overlap fallback to rows that look
  // like a reversal, in the same category, and short enough to plausibly be
  // about one topic, so it only widens linking for the exact case cosine +
  // fact_key miss, not for arbitrary unrelated or multi-topic narrative rows.
  if (
    (a.reversal || b.reversal) &&
    a.memoryCategory &&
    a.memoryCategory === b.memoryCategory &&
    a.topicLinkEligible &&
    b.topicLinkEligible &&
    shareSignificantTopicToken(a.topicTokens, b.topicTokens)
  ) {
    return true;
  }
  // Cross-lane near-duplicate fallback: two short, same-category rows that
  // are NOT reversal-shaped can still be the same fact stated by different
  // write lanes (manual/auto-capture/reflection*), whose differing
  // tokenization keeps cosine and fact_key from matching. Unlike the
  // reversal fallback above (which only needs ONE shared token, since a
  // reversal is inherently pointed at a specific fact), this case requires
  // a MAJORITY of the smaller row's topic tokens to overlap, so two short
  // but topically different statements don't bridge on a single
  // incidental shared word.
  if (
    a.memoryCategory &&
    a.memoryCategory === b.memoryCategory &&
    a.topicLinkEligible &&
    b.topicLinkEligible &&
    topicTokensNearDuplicate(a.topicTokens, b.topicTokens)
  ) {
    return true;
  }
  return false;
}

/**
 * Seed-based clustering: for each not-yet-assigned row (in order), it
 * becomes the seed of a new cluster, and every OTHER unassigned row joins
 * that cluster only if it is DIRECTLY linked to the seed itself (cosine,
 * fact_key, or the topic-overlap fallback) -- never transitively through
 * another cluster member. Plain union-find (transitive closure) chains
 * unrelated rows together whenever a series of only-moderately-similar
 * pairs bridges them (row A links to B, B links to C, so A and C end up in
 * one cluster even though A and C are never themselves similar); seed-based
 * grouping caps that at a single hop from the seed, which is what keeps a
 * handful of distinct topics from collapsing into one grab-bag cluster.
 */
export function clusterConsolidateCandidates(
  candidates: ConsolidateCandidate[],
  similarityThreshold: number
): number[][] {
  const n = candidates.length;
  const assigned = new Array<boolean>(n).fill(false);
  const clusters: number[][] = [];

  for (let seedIdx = 0; seedIdx < n; seedIdx++) {
    if (assigned[seedIdx]) continue;
    assigned[seedIdx] = true;
    const cluster = [seedIdx];

    for (let j = 0; j < n; j++) {
      if (assigned[j]) continue;
      if (isDirectlyLinked(candidates[seedIdx], candidates[j], similarityThreshold)) {
        assigned[j] = true;
        cluster.push(j);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

export function chunkCluster(indices: number[], maxSize: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < indices.length; i += maxSize) {
    chunks.push(indices.slice(i, i + maxSize));
  }
  return chunks;
}

export function parseConsolidateVerdict(raw: unknown, memberCount: number): ConsolidateVerdictResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "skip" && verdict !== "merge" && verdict !== "supersede" && verdict !== "contradict") {
    return null;
  }
  const reason = typeof obj.reason === "string" ? obj.reason : "";

  if (verdict === "skip" || verdict === "contradict") {
    return { verdict, reason };
  }

  const survivorIndex = Number(obj.survivor_index);
  if (!Number.isInteger(survivorIndex) || survivorIndex < 1 || survivorIndex > memberCount) return null;

  const absorbedRaw = obj.absorbed_indices;
  if (!Array.isArray(absorbedRaw) || absorbedRaw.length === 0) return null;
  const absorbedIndices = absorbedRaw.map((v) => Number(v));
  if (
    absorbedIndices.some(
      (i) => !Number.isInteger(i) || i < 1 || i > memberCount || i === survivorIndex
    )
  ) {
    return null;
  }
  // A duplicated absorbed index would issue duplicate invalidation writes
  // for the same row; treat the verdict as malformed instead.
  if (new Set(absorbedIndices).size !== absorbedIndices.length) {
    return null;
  }

  return { verdict, reason, survivorIndex, absorbedIndices };
}

// Parses the batched decider's `{ verdicts: [...] }` response into a
// clusterIndex -> verdict map. Fails closed PER CLUSTER: an entry with an
// unrecognized/duplicate cluster_index, or a malformed verdict shape for its
// own member count, is simply dropped rather than discarding the whole
// batch -- callers treat a missing clusterIndex as "skip this cluster" the
// same way a single malformed per-cluster response was already handled.
export function parseConsolidateBatchVerdicts(
  raw: unknown,
  units: Array<{ clusterIndex: number; memberCount: number }>
): Map<number, ConsolidateVerdictResult> {
  const result = new Map<number, ConsolidateVerdictResult>();
  if (!raw || typeof raw !== "object") return result;

  const verdictsRaw = (raw as Record<string, unknown>).verdicts;
  if (!Array.isArray(verdictsRaw)) return result;

  const memberCountByCluster = new Map(units.map((u) => [u.clusterIndex, u.memberCount]));

  for (const entry of verdictsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const clusterIndex = Number((entry as Record<string, unknown>).cluster_index);
    if (!Number.isInteger(clusterIndex) || !memberCountByCluster.has(clusterIndex)) continue;
    if (result.has(clusterIndex)) continue;

    const verdict = parseConsolidateVerdict(entry, memberCountByCluster.get(clusterIndex)!);
    if (!verdict) continue;

    result.set(clusterIndex, verdict);
  }

  return result;
}

export interface ConsolidateAuditEntry {
  action: "merge" | "supersede";
  survivorId: string;
  absorbedIds: string[];
  reason: string;
  scope: string;
  /**
   * Writes that failed inside an otherwise-applied cluster. The write order
   * makes every partial state safe (merge: survivor carries the merged
   * superset before any absorption; supersede: the survivor was never the
   * row being invalidated), and a failed row simply stays ACTIVE — the
   * pre-consolidate status quo — so a rerun re-clusters and retries it
   * idempotently. Non-empty = the operator must be told, never silently
   * counted as fully applied.
   */
  partialFailures?: Array<{ id: string; step: "invalidate-absorbed" | "annotate-survivor"; error: string }>;
}

// ============================================================================
// Item 7: LLM-cost gate. Clustering is free (local cosine + fact_key/topic
// linking); the only paid calls are the one batched decider call and one
// batched merge-content call (chunked past CONSOLIDATE_MERGE_BATCH_MAX_SIZE)
// covering every unit that MIGHT turn out to be a merge verdict, since item 8
// moves merge-content generation into the plan phase. Both are knowable from
// clustering alone, before any LLM call is made -- which is what lets the
// gate sit ahead of the decide call and cover dry-runs as well as --apply.
// ============================================================================

/** Max merge jobs written in one batched merge-content LLM call; larger batches are chunked. */
export const CONSOLIDATE_MERGE_BATCH_MAX_SIZE = 10;

export interface ConsolidateCostPreview {
  clusterCount: number;
  /** Every unit might turn out to be a merge verdict: at most one merge job each. */
  maxMergeJobs: number;
  /** ceil(maxMergeJobs / CONSOLIDATE_MERGE_BATCH_MAX_SIZE) batched merge-content calls. */
  maxMergeContentCalls: number;
}

export function computeConsolidateCostPreview(
  units: Array<{ members: unknown[] }>
): ConsolidateCostPreview {
  const maxMergeJobs = units.length;
  return {
    clusterCount: units.length,
    maxMergeJobs,
    maxMergeContentCalls: Math.ceil(maxMergeJobs / CONSOLIDATE_MERGE_BATCH_MAX_SIZE),
  };
}

export function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatConsolidateCostPreview(preview: ConsolidateCostPreview): string {
  const base = `${pluralCount(preview.clusterCount, "cluster")} -> 1 batched decider call`;
  if (preview.maxMergeJobs === 0) return base;
  return `${base} + worst case ${pluralCount(preview.maxMergeContentCalls, "batched merge-content call")} covering ${pluralCount(preview.maxMergeJobs, "merge job")}`;
}

export function formatConsolidatePlanForDisplay(clusters: ClusterPlanReport[]): string {
  const actionable = clusters.filter((c) => c.action);
  const blocked = clusters.filter((c) => c.blocked === "append-only-shield");
  const noAction = clusters.filter((c) => !c.action && !c.blocked && !c.malformed && c.verdict);
  if (actionable.length === 0 && blocked.length === 0 && noAction.length === 0) {
    return "No actionable clusters in this plan.";
  }
  const lines: string[] = [
    `Plan: ${pluralCount(actionable.length, "actionable cluster")}, ${blocked.length} blocked, ${pluralCount(noAction.length, "skip")}`,
  ];
  for (const cluster of actionable) {
    lines.push(`  [${cluster.action}] cluster ${cluster.clusterIndex} — ${cluster.verdict!.reason}`);
    lines.push(`    members: ${cluster.memberIds.join(", ")}`);
    lines.push(`    survivor: ${cluster.survivorId}`);
    if (cluster.absorbedIds?.length) {
      lines.push(`    absorbed: ${cluster.absorbedIds.join(", ")}`);
    }
    if (cluster.action === "merge" && cluster.mergedContent) {
      lines.push(`    merged abstract: ${cluster.mergedContent.abstract}`);
      lines.push(`    merged overview: ${cluster.mergedContent.overview}`);
      lines.push(`    merged content: ${cluster.mergedContent.content}`);
    }
  }
  for (const cluster of blocked) {
    lines.push(
      `  [${cluster.verdict!.verdict} — BLOCKED by append-only shield, will NOT be applied] cluster ${cluster.clusterIndex} — ${cluster.verdict!.reason}`,
    );
    lines.push(`    members: ${cluster.memberIds.join(", ")}`);
    for (const text of cluster.memberTexts) {
      lines.push(`    - "${text}"`);
    }
  }
  for (const cluster of noAction) {
    lines.push(`  [${cluster.verdict!.verdict}] cluster ${cluster.clusterIndex} — ${cluster.verdict!.reason}`);
    for (const text of cluster.memberTexts) {
      lines.push(`    - "${text}"`);
    }
  }
  return lines.join("\n");
}

// No `delete` method: no LLM verdict path may hard-delete a row. Both
// ============================================================================
// Settled-fingerprint ledger persistence (crash- and concurrency-safe)
// ============================================================================

export type SettledLedger = Record<string, Array<{ fp: string; at: number }>>;

export const SETTLED_LEDGER_MAX_PER_SCOPE = 5000;
export const SETTLED_LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const SETTLED_LEDGER_LOCK_STALE_MS = 60_000;

export function normalizeSettledLedger(parsed: unknown, now: number): SettledLedger {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SettledLedger = {};
  for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const entries: Array<{ fp: string; at: number }> = [];
    for (const item of value) {
      if (typeof item === "string") {
        // Legacy format: bare fingerprint strings, stamped "now" so pruning
        // ages them out from this run forward instead of dropping them cold.
        entries.push({ fp: item, at: now });
      } else if (item && typeof item === "object" && typeof (item as { fp?: unknown }).fp === "string") {
        const at = typeof (item as { at?: unknown }).at === "number" ? (item as { at: number }).at : now;
        entries.push({ fp: (item as { fp: string }).fp, at });
      }
    }
    if (entries.length > 0) out[scope] = entries;
  }
  return out;
}

export function pruneSettledLedger(ledger: SettledLedger, now: number): void {
  for (const scope of Object.keys(ledger)) {
    const kept = ledger[scope]
      .filter((e) => now - e.at <= SETTLED_LEDGER_MAX_AGE_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, SETTLED_LEDGER_MAX_PER_SCOPE);
    if (kept.length === 0) delete ledger[scope];
    else ledger[scope] = kept;
  }
}

export async function loadConsolidateSettledLedger(ledgerPath: string): Promise<SettledLedger> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    console.warn(`consolidate: could not read settled ledger (${String(err)}); continuing with an empty ledger`);
    return {};
  }
  try {
    return normalizeSettledLedger(JSON.parse(raw), Date.now());
  } catch (err) {
    // A corrupt ledger must be REPORTED, not silently treated as empty: the
    // damaged file is set aside (so the evidence survives and the next write
    // starts clean) and every previously settled cluster will be re-decided.
    const asidePath = `${ledgerPath}.corrupt-${Date.now()}`;
    try {
      await rename(ledgerPath, asidePath);
      console.warn(
        `consolidate: settled ledger is corrupt (${String(err)}); moved it aside to ${asidePath}. Previously settled clusters will be re-decided.`,
      );
    } catch {
      console.warn(`consolidate: settled ledger is corrupt (${String(err)}) and could not be moved aside; previously settled clusters will be re-decided.`);
    }
    return {};
  }
}

/**
 * Persist newly settled fingerprints with concurrency and crash safety:
 * a mkdir-based lock (with stale takeover) serializes writers, the CURRENT
 * file is re-read and merged under the lock so a concurrent agent's
 * fingerprints are never lost, pruning bounds the ledger (per-scope cap +
 * max age), and the write lands via temp file + atomic rename so a crash
 * can truncate only the temp file, never the ledger itself.
 */
export async function saveConsolidateSettledLedger(
  ledgerPath: string,
  scope: string,
  newlySettled: string[],
): Promise<void> {
  if (newlySettled.length === 0) return;
  const lockPath = `${ledgerPath}.lock`;
  const now = Date.now();
  let locked = false;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await mkdir(lockPath);
        locked = true;
        break;
      } catch {
        try {
          // Recomputed per attempt: the loop can sit in 100ms waits for
          // seconds, and a stale-age judged from the initial timestamp would
          // takeover a lock that is actually fresh.
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > SETTLED_LEDGER_LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!locked) {
      console.warn(`consolidate: could not acquire settled-ledger lock at ${lockPath}; skipping persist (fingerprints will be re-derived next run)`);
      return;
    }
    const current = await loadConsolidateSettledLedger(ledgerPath);
    const merged = new Map((current[scope] ?? []).map((e) => [e.fp, e] as const));
    for (const fp of newlySettled) merged.set(fp, { fp, at: now });
    current[scope] = [...merged.values()];
    pruneSettledLedger(current, now);
    await sweepAbandonedLedgerTemps(ledgerPath, now);
    const tmpPath = `${ledgerPath}.tmp-${process.pid}`;
    try {
      await writeFile(tmpPath, JSON.stringify(current, null, 2), "utf-8");
      await rename(tmpPath, ledgerPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    console.warn(`consolidate: could not persist settled ledger: ${String(err)}`);
  } finally {
    if (locked) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * A writer that died between its temp write and the rename leaves
 * `<ledger>.tmp-<pid>` behind for good. Swept under the ledger lock; a temp
 * younger than the lock-stale window may belong to a live writer and is kept.
 */
async function sweepAbandonedLedgerTemps(ledgerPath: string, now: number): Promise<void> {
  const dir = dirname(ledgerPath);
  const prefix = `${basename(ledgerPath)}.tmp-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tmpPath = join(dir, name);
    try {
      if (now - (await stat(tmpPath)).mtimeMs > SETTLED_LEDGER_LOCK_STALE_MS) {
        await rm(tmpPath, { force: true });
      }
    } catch {
      // raced with its owner or already gone
    }
  }
}

/**
 * consolidation_audit is an append-only ARRAY of audit events. Rows written
 * by earlier consolidate versions may carry a single scalar object; it is
 * wrapped, never overwritten, so no prior audit event is ever lost.
 */
export function appendConsolidationAudit(
  existingMeta: object | undefined,
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const prior = (existingMeta as { consolidation_audit?: unknown } | undefined)?.consolidation_audit;
  const priorEntries = Array.isArray(prior)
    ? prior
    : prior && typeof prior === "object"
      ? [prior as Record<string, unknown>]
      : [];
  return [...priorEntries, event];
}

// applyMergeVerdict and applySupersedeVerdict soft-invalidate absorbed rows
// via `update` only. Hard delete stays an operator-only CLI command, wired
// through a completely separate code path outside this pipeline.
export interface ConsolidateWriteDeps {
  update: (
    id: string,
    patch: { text?: string; vector?: number[]; metadata: string },
    scopeFilter?: string[]
  ) => Promise<unknown>;
  embed: (text: string) => Promise<number[]>;
  completeJson: <T>(prompt: string, label?: string, system?: string, temperature?: number) => Promise<T | null>;
}

export interface ConsolidateMergedContent {
  abstract: string;
  overview: string;
  content: string;
  vector: number[];
}

/**
 * Item 8: pure content generation for merge verdicts -- one batched
 * `consolidate-merge-batch` completion per chunk of up to
 * CONSOLIDATE_MERGE_BATCH_MAX_SIZE merge verdicts (each job folds ALL of a
 * verdict's absorbed members into its survivor in one output), plus one
 * re-embed per job, with NO store writes. Called at PLAN-BUILD time (dry-run
 * or --apply alike), so execution later can be pure store operations that
 * never regenerate content and never call the LLM again.
 *
 * Per-item fail-closed: a response entry that is missing or malformed
 * degrades ONLY that job to the survivor's own unmodified content -- exactly
 * what the sequential per-member fold produced when its completions came
 * back null -- and a chunk whose call itself fails degrades every job in
 * that chunk the same way. Never throws, never fans back out into per-member
 * LLM calls.
 */
async function buildMergePlanContentsBatch(
  deps: Pick<ConsolidateWriteDeps, "embed" | "completeJson">,
  jobs: Array<{ members: ConsolidateCandidate[]; verdict: ConsolidateVerdictResult }>,
  log?: (msg: string) => void
): Promise<ConsolidateMergedContent[]> {
  const out: ConsolidateMergedContent[] = new Array(jobs.length);
  for (let chunkStart = 0; chunkStart < jobs.length; chunkStart += CONSOLIDATE_MERGE_BATCH_MAX_SIZE) {
    const chunk = jobs.slice(chunkStart, chunkStart + CONSOLIDATE_MERGE_BATCH_MAX_SIZE);
    const prompt = buildConsolidateBatchMergePrompt(
      chunk.map(({ members, verdict }) => {
        const survivor = members[verdict.survivorIndex! - 1];
        return {
          category: survivor.memoryCategory || "preferences",
          existing: {
            abstract: survivor.abstract,
            overview: survivor.overview,
            content: survivor.content,
          },
          additions: verdict.absorbedIndices!.map((idx) => {
            const absorbed = members[idx - 1];
            return {
              abstract: absorbed.abstract,
              overview: absorbed.overview,
              content: absorbed.content,
            };
          }),
        };
      })
    );

    const byIndex = new Map<number, { abstract?: string; overview?: string; content?: string }>();
    try {
      const raw = await deps.completeJson<{
        results?: Array<{ index?: number; abstract?: string; overview?: string; content?: string }>;
      }>(prompt.user, "consolidate-merge-batch", prompt.system);
      for (const entry of raw && Array.isArray(raw.results) ? raw.results : []) {
        if (!entry || typeof entry.index !== "number") continue;
        byIndex.set(entry.index, entry);
      }
    } catch (err) {
      log?.(
        `memory-consolidate: batched merge-content call failed, keeping survivor content for ${chunk.length} job(s): ${String(err)}`
      );
    }

    for (let i = 0; i < chunk.length; i++) {
      const { members, verdict } = chunk[i];
      const survivor = members[verdict.survivorIndex! - 1];
      const entry = byIndex.get(i + 1);
      const usable =
        entry &&
        typeof entry.abstract === "string" &&
        entry.abstract.trim().length > 0 &&
        typeof entry.overview === "string" &&
        typeof entry.content === "string";
      if (!usable) {
        log?.(
          "memory-consolidate: missing or malformed merge-content entry, keeping survivor content for this job"
        );
      }
      const abstract = usable ? (entry!.abstract as string) : survivor.abstract;
      const overview = usable ? (entry!.overview as string) : survivor.overview;
      const content = usable ? (entry!.content as string) : survivor.content;
      const vector = await deps.embed(`${abstract} ${content}`);
      out[chunkStart + i] = { abstract, overview, content, vector };
    }
  }
  return out;
}

/**
 * Item 8: pure store write for an already-planned merge verdict. Applies
 * EXACTLY the precomputed content from `buildMergePlanContentsBatch` -- no LLM
 * call, no regeneration, "apply exactly what was presented."
 */
async function writeMergeVerdict(
  deps: Pick<ConsolidateWriteDeps, "update">,
  members: ConsolidateCandidate[],
  verdict: ConsolidateVerdictResult,
  mergedContent: ConsolidateMergedContent,
  scopeFilter: string[] | undefined,
  now: number
): Promise<ConsolidateAuditEntry> {
  const survivor = members[verdict.survivorIndex! - 1];
  const { abstract, overview, content, vector } = mergedContent;

  const absorbedIds: string[] = [];
  for (const idx of verdict.absorbedIndices!) {
    absorbedIds.push(members[idx - 1].entry.id);
  }

  const survivorExistingMeta = parseSmartMetadata(survivor.entry.metadata, survivor.entry);
  const patchedMeta = buildSmartMetadata(survivor.entry, {
    l0_abstract: abstract,
    l1_overview: overview,
    l2_content: content,
  });
  const auditedMeta = {
    ...patchedMeta,
    consolidation_audit: appendConsolidationAudit(survivorExistingMeta, {
      action: "merge", absorbedIds, reason: verdict.reason, at: now,
    }),
  };
  await deps.update(
    survivor.entry.id,
    { text: abstract, vector, metadata: stringifySmartMetadata(auditedMeta) },
    scopeFilter
  );

  // Non-destructive: absorbed rows are soft-invalidated with the same
  // primitive applySupersedeVerdict uses (invalidated_at + superseded_by +
  // relations), not hard-deleted. Each absorbed row also gets its own
  // consolidation_audit pointing back at the survivor, so its history is
  // independently inspectable without cross-referencing the survivor's
  // audit. No LLM verdict path may call a hard delete; hard delete stays an
  // operator-only CLI command.
  // Ordered for failure-safety: the survivor above now carries the merged
  // SUPERSET, so an absorbed row whose invalidation fails below merely stays
  // active as a duplicate — the pre-consolidate status quo. Each invalidation
  // is attempted independently (one failure never abandons the rest), the
  // failures ride the audit entry for operator-visible reporting, and a rerun
  // re-clusters the still-active rows and retries idempotently.
  const partialFailures: NonNullable<ConsolidateAuditEntry["partialFailures"]> = [];
  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    try {
      const existingMeta = parseSmartMetadata(absorbed.entry.metadata, absorbed.entry);
      const invalidatedMeta = buildSmartMetadata(absorbed.entry, {
        invalidated_at: now,
        superseded_by: survivor.entry.id,
        relations: appendRelation(existingMeta.relations, { type: "superseded_by", targetId: survivor.entry.id }),
      });
      const auditedAbsorbedMeta = {
        ...invalidatedMeta,
        consolidation_audit: appendConsolidationAudit(existingMeta, {
          action: "merge", survivorId: survivor.entry.id, reason: verdict.reason, at: now,
        }),
      };
      await deps.update(absorbed.entry.id, { metadata: stringifySmartMetadata(auditedAbsorbedMeta) }, scopeFilter);
    } catch (err) {
      partialFailures.push({ id: absorbed.entry.id, step: "invalidate-absorbed", error: String(err) });
    }
  }

  return {
    action: "merge",
    survivorId: survivor.entry.id,
    absorbedIds,
    reason: verdict.reason,
    scope: survivor.entry.scope,
    ...(partialFailures.length > 0 ? { partialFailures } : {}),
  };
}

async function applySupersedeVerdict(
  deps: Pick<ConsolidateWriteDeps, "update">,
  members: ConsolidateCandidate[],
  verdict: ConsolidateVerdictResult,
  scopeFilter: string[] | undefined,
  now: number
): Promise<ConsolidateAuditEntry> {
  const survivor = members[verdict.survivorIndex! - 1];
  const factKey = survivor.factKey || members[verdict.absorbedIndices![0] - 1].factKey || "";
  const absorbedIds: string[] = [];
  // Failure-safety mirror of the merge path: the survivor is never the row
  // being invalidated, so a failed absorbed write leaves that row active (a
  // surviving duplicate, the status quo) while the rest still proceed. A
  // cluster where EVERY absorbed write failed applied nothing and throws so
  // the caller reports it as a failed cluster rather than an applied one.
  const partialFailures: NonNullable<ConsolidateAuditEntry["partialFailures"]> = [];

  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    try {
      const existingMeta = parseSmartMetadata(absorbed.entry.metadata, absorbed.entry);
      const invalidatedMetadata = buildSmartMetadata(absorbed.entry, {
        fact_key: factKey || existingMeta.fact_key,
        invalidated_at: now,
        superseded_by: survivor.entry.id,
        relations: appendRelation(existingMeta.relations, { type: "superseded_by", targetId: survivor.entry.id }),
      });
      await deps.update(absorbed.entry.id, { metadata: stringifySmartMetadata(invalidatedMetadata) }, scopeFilter);
      absorbedIds.push(absorbed.entry.id);
    } catch (err) {
      partialFailures.push({ id: absorbed.entry.id, step: "invalidate-absorbed", error: String(err) });
    }
  }
  if (absorbedIds.length === 0 && partialFailures.length > 0) {
    throw new Error(
      `supersede applied nothing: every absorbed invalidation failed (${partialFailures.map((f) => f.error).join("; ")})`,
    );
  }

  // An append-only (events/cases) survivor is left byte-untouched: the shield
  // admits it only because nothing gets written to it, so even the fact_key
  // patch and audit annotation are skipped (the audit still lands in the plan
  // report and journal mirror).
  const survivorIsAppendOnly = Boolean(
    survivor.memoryCategory && APPEND_ONLY_CATEGORIES.has(survivor.memoryCategory),
  );
  if (!survivorIsAppendOnly) {
    try {
      const survivorMeta = parseSmartMetadata(survivor.entry.metadata, survivor.entry);
      const patchedSurvivorMeta = buildSmartMetadata(survivor.entry, {
        fact_key: factKey || survivorMeta.fact_key,
      });
      const auditedMeta = {
        ...patchedSurvivorMeta,
        consolidation_audit: appendConsolidationAudit(survivorMeta, {
          action: "supersede", absorbedIds, reason: verdict.reason, at: now,
        }),
      };
      await deps.update(survivor.entry.id, { metadata: stringifySmartMetadata(auditedMeta) }, scopeFilter);
    } catch (err) {
      // Cosmetic annotation only: the invalidations above are what change
      // retrieval, so a failed survivor patch degrades to a reported partial,
      // never to unwinding the applied invalidations.
      partialFailures.push({ id: survivor.entry.id, step: "annotate-survivor", error: String(err) });
    }
  }

  return {
    action: "supersede",
    survivorId: survivor.entry.id,
    absorbedIds,
    reason: verdict.reason,
    scope: survivor.entry.scope,
    ...(partialFailures.length > 0 ? { partialFailures } : {}),
  };
}

export interface ClusterPlanReport {
  clusterIndex: number;
  memberIds: string[];
  memberTexts: string[];
  verdict: ConsolidateVerdictResult | null;
  malformed: boolean;
  /**
   * Why an undecided cluster is undecided: the whole decide call returned
   * nothing (provider error/timeout) vs. the call succeeded but this
   * cluster's verdict was missing or unparseable. Only set when malformed.
   */
  failure?: "call-failed" | "malformed-verdict";
  /** Set when a decided verdict was withheld by the append-only shield. */
  blocked?: "append-only-shield";
  /** Stable identity of this cluster's member set + content, for the settled ledger. */
  fingerprint?: string;
  /** null for skip/contradict/malformed/append-only-blocked units -- nothing to execute. */
  action: "merge" | "supersede" | null;
  survivorId?: string;
  absorbedIds?: string[];
  /** Item 8: precomputed at plan-build time, applied verbatim at execution. */
  mergedContent?: ConsolidateMergedContent;
  /** Snapshot used by the item-8 staleness guard: each member's id + exact text + exact metadata string at plan-build time. */
  staleness: Array<{ id: string; text: string; metadata: string | undefined }>;
}

export interface RunConsolidateOptions {
  scope: string;
  scopeFilter?: string[];
  category?: MemoryCategory;
  sinceMs?: number;
  includeReflectionSlices?: boolean;
  similarityThreshold?: number;
  clusterCap?: number;
  apply: boolean;
  now?: number;
  /** --yes: bypasses the item-7 cost gate without ever calling confirmCost. */
  autoConfirm?: boolean;
  /**
   * Row-scan bound (default DEFAULT_SCAN_LIMIT). The clustering pass is
   * O(n^2) in the candidate count, so an unbounded scan over a huge scope
   * gets pathologically expensive before the first LLM call; a truncated
   * scan is reported via scanTruncated and the operator can raise the bound
   * explicitly (--scan-limit) when a full pass is genuinely wanted.
   */
  scanLimit?: number;
  /**
   * Fingerprints of clusters settled by previous runs (skip verdicts and
   * shield-blocked verdicts; a contradiction never settles). Matching clusters are dropped
   * before the cost gate and never reach the decider, so repeated runs
   * converge to zero clusters. A fingerprint covers each member's exact
   * metadata, so any member change re-opens its cluster automatically.
   */
  settledFingerprints?: Set<string>;
}

export interface RunConsolidateDeps extends ConsolidateWriteDeps {
  fetchRows: (scopeFilter: string[] | undefined, maxTimestamp: number, limit: number) => Promise<MemoryEntry[]>;
  /** Re-fetches a row by id for the item-8 staleness guard. Omit to skip the guard (all clusters treated as fresh). */
  getById?: (id: string, scopeFilter?: string[]) => Promise<MemoryEntry | null>;
  /**
   * Item 7 cost gate: called with a preview message before any LLM call,
   * unless options.autoConfirm is set. A declined or missing confirmCost
   * (and !autoConfirm) is a safe abort -- fail closed, never assume consent.
   */
  confirmCost?: (message: string) => Promise<boolean>;
  /**
   * Item 8 apply gate: called with the fully-built plan (message + per-
   * cluster detail) when options.apply is false, so the user can review
   * before anything is written. Never called when options.apply is true
   * (direct --apply executes immediately, no second prompt). A declined or
   * missing confirmApply is a safe no-op -- nothing gets written.
   */
  confirmApply?: (message: string, clusters: ClusterPlanReport[]) => Promise<boolean>;
  onAudit?: (audit: ConsolidateAuditEntry) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface RunConsolidateResult {
  /** "aborted": the item-7 cost gate was declined (or unavailable) -- zero LLM calls were made. */
  status: "aborted" | "completed";
  abortReason?: string;
  scanned: number;
  eligible: number;
  costPreview?: ConsolidateCostPreview;
  clusters: ClusterPlanReport[];
  applied: ConsolidateAuditEntry[];
  /** True iff the plan (or the fresh subset of it) was actually written to the store. */
  executed: boolean;
  /** Clusters withheld at execution time because a member row changed or disappeared since the plan was built. */
  staleSkipped: Array<{ clusterIndex: number; memberIds: string[] }>;
  /** Clusters whose apply wrote NOTHING (first write failed); unsettled, retried by the next run. */
  applyFailed: Array<{ clusterIndex: number; memberIds: string[]; action: "merge" | "supersede"; error: string }>;
  /** True when fetchRows returned more rows than the scan limit: the scan was truncated to the limit. */
  scanTruncated: boolean;
  /** Clusters whose verdict was missing/unparseable while the decide call itself succeeded. */
  skippedMalformed: number;
  /** Clusters left undecided because the decide call returned no response at all. */
  undecidedCallFailed: number;
  /** Clusters dropped before the decider because a previous run already settled them. */
  settledSkipped: number;
  /**
   * Fingerprints this run JUDGED settled (skip and shield-blocked outcomes).
   * Reported for every run; callers persist them only after a commit
   * (`executed` is true), so a dry-run never mutates the settled ledger.
   */
  newlySettled: string[];
  apply: boolean;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.86;
const DEFAULT_CLUSTER_CAP = 8;
/**
 * Default row-scan bound. Clustering is O(n^2) pairwise (dot products over
 * unit vectors plus memoized token overlap), so the default keeps a worst
 * case in the low millions of cheap pair checks; operators consolidating a
 * genuinely larger scope raise it explicitly per run (--scan-limit).
 */
export const DEFAULT_SCAN_LIMIT = 2_500;
/** Max clusters judged in one consolidate-decide LLM call; larger plans are chunked. */
export const CONSOLIDATE_DECIDE_BATCH_MAX_SIZE = 10;

function abortedResult(
  reason: string,
  scanned: number,
  eligible: number,
  costPreview: ConsolidateCostPreview | undefined,
  apply: boolean
): RunConsolidateResult {
  return {
    status: "aborted",
    abortReason: reason,
    scanned,
    eligible,
    costPreview,
    clusters: [],
    applied: [],
    executed: false,
    staleSkipped: [],
    applyFailed: [],
    scanTruncated: false,
    skippedMalformed: 0,
    undecidedCallFailed: 0,
    settledSkipped: 0,
    newlySettled: [],
    apply,
  };
}

/**
 * Stable identity for a cluster in the settled ledger: the sorted member
 * ids with each member's exact metadata string. Any member change (edit,
 * merge, invalidation) or any membership change produces a different
 * fingerprint, so a settled entry can never suppress a cluster whose
 * content moved on.
 */
export function computeClusterFingerprint(
  members: Array<{ id: string; text: string; metadata: string | undefined }>,
): string {
  // The text rides the fingerprint alongside the metadata: a text-only
  // update (which also re-embeds, so the vector follows the text) must
  // re-open a settled cluster, and metadata alone does not see it.
  const parts = members
    .map((m) => `${m.id}\n${m.text}\n${m.metadata ?? ""}`)
    .sort()
    .join("\u0000");
  return createHash("sha256").update(parts).digest("hex");
}

/**
 * Item 8 staleness guard: re-fetches every member of a plan entry and
 * compares its metadata string against the plan-build-time snapshot.
 * Missing row (disappeared) or changed metadata (mutated by someone else)
 * both count as stale. Skips the check entirely (treats as fresh) when
 * deps.getById isn't provided -- an opt-in safety net, not a hard
 * requirement, so callers that don't need it don't have to wire it up.
 */
async function isClusterFresh(
  deps: Pick<RunConsolidateDeps, "getById">,
  entry: ClusterPlanReport,
  scopeFilter: string[] | undefined
): Promise<boolean> {
  if (!deps.getById) return true;
  for (const snapshot of entry.staleness) {
    const current = await deps.getById(snapshot.id, scopeFilter);
    if (!current) return false;
    if (current.text !== snapshot.text) return false;
    if (current.metadata !== snapshot.metadata) return false;
  }
  return true;
}

async function executePlan(
  deps: RunConsolidateDeps,
  clusters: ClusterPlanReport[],
  membersByCluster: Map<number, ConsolidateCandidate[]>,
  scopeFilter: string[] | undefined,
  now: number
): Promise<{
  applied: ConsolidateAuditEntry[];
  staleSkipped: Array<{ clusterIndex: number; memberIds: string[] }>;
  applyFailed: Array<{ clusterIndex: number; memberIds: string[]; action: "merge" | "supersede"; error: string }>;
}> {
  const applied: ConsolidateAuditEntry[] = [];
  const staleSkipped: Array<{ clusterIndex: number; memberIds: string[] }> = [];
  const applyFailed: Array<{ clusterIndex: number; memberIds: string[]; action: "merge" | "supersede"; error: string }> = [];

  for (const entry of clusters) {
    if (!entry.action || !entry.verdict) continue;
    const members = membersByCluster.get(entry.clusterIndex);
    if (!members) continue;

    const fresh = await isClusterFresh(deps, entry, scopeFilter);
    if (!fresh) {
      staleSkipped.push({ clusterIndex: entry.clusterIndex, memberIds: entry.memberIds });
      deps.log?.(
        `memory-consolidate: cluster ${entry.clusterIndex} changed since the plan was built (stale); skipping, never partially applied`
      );
      continue;
    }

    let audit: ConsolidateAuditEntry;
    try {
      audit =
        entry.action === "merge"
          ? await writeMergeVerdict(deps, members, entry.verdict, entry.mergedContent!, scopeFilter, now)
          : await applySupersedeVerdict(deps, members, entry.verdict, scopeFilter, now);
    } catch (err) {
      // The write functions throw only when NOTHING was applied for the
      // cluster (merge: the survivor rewrite itself failed before any
      // absorption; supersede: every absorbed invalidation failed), so a
      // thrown cluster is reported as failed-not-applied and left unsettled
      // for the next run to retry.
      applyFailed.push({
        clusterIndex: entry.clusterIndex,
        memberIds: entry.memberIds,
        action: entry.action,
        error: String(err),
      });
      deps.log?.(`memory-consolidate: cluster ${entry.clusterIndex} FAILED to apply ${entry.action} (nothing written): ${String(err)}`);
      continue;
    }
    applied.push(audit);
    if (audit.partialFailures?.length) {
      deps.log?.(
        `memory-consolidate: cluster ${entry.clusterIndex} PARTIALLY applied: ${audit.partialFailures.length} write(s) failed (${audit.partialFailures.map((f) => `${f.step} ${f.id.slice(0, 8)}: ${f.error}`).join("; ")}); failed rows stay active and a rerun retries them`
      );
    }
    // The store writes above are already applied and classified: a failing
    // audit MIRROR (markdown journal etc.) is its own problem and must never
    // re-classify the cluster as an apply failure.
    try {
      await deps.onAudit?.(audit);
    } catch (err) {
      deps.log?.(
        `memory-consolidate: audit mirror failed for cluster ${entry.clusterIndex} (store writes already applied): ${String(err)}`
      );
    }
  }

  return { applied, staleSkipped, applyFailed };
}

export async function runConsolidate(
  deps: RunConsolidateDeps,
  options: RunConsolidateOptions
): Promise<RunConsolidateResult> {
  const now = options.now ?? Date.now();
  const scopeFilter = options.scopeFilter ?? [options.scope];

  const scanLimit = Math.max(1, Math.trunc(options.scanLimit ?? DEFAULT_SCAN_LIMIT));
  // Fetch one past the limit purely to DETECT truncation; the extra row
  // never participates in the scan.
  const fetchedEntries = await deps.fetchRows(scopeFilter, now, scanLimit + 1);
  const scanTruncated = fetchedEntries.length > scanLimit;
  const rawEntries = scanTruncated ? fetchedEntries.slice(0, scanLimit) : fetchedEntries;
  if (scanTruncated) {
    deps.log?.(
      `memory-consolidate: scan truncated at ${scanLimit} rows (scope holds more); rerun with a higher --scan-limit to cover the rest`
    );
  }

  const filtered = rawEntries.filter((entry) => {
    if (entry.category === "reflection" && !options.includeReflectionSlices) return false;
    if (options.sinceMs !== undefined && entry.timestamp < options.sinceMs) return false;
    return true;
  });

  const candidates = filtered
    .map(buildConsolidateCandidate)
    .filter((candidate) => {
      const meta = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
      if (!isMemoryActiveAt(meta, now)) return false;
      if (options.category && candidate.memoryCategory !== options.category) return false;
      return true;
    })
    // Sort by row id (a stable key) before clustering, not just before
    // building the prompt: clusterConsolidateCandidates' seed-based scan
    // always picks the lowest surviving array index as the next seed, so a
    // pre-sorted candidate array makes both which rows end up in the same
    // cluster AND their order within it a pure function of the candidate
    // SET -- independent of whatever order fetchRows happened to return
    // this call, which store/DB internals don't guarantee is stable.
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));

  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const clusterCap = options.clusterCap ?? DEFAULT_CLUSTER_CAP;
  const clusterIndexGroups = clusterConsolidateCandidates(candidates, similarityThreshold);

  const byId = (a: ConsolidateCandidate, b: ConsolidateCandidate) =>
    a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;

  // Flatten every cluster (and any cluster chunked past clusterCap) into a
  // single ordered list of decision units first, so the decider can be
  // asked about all of them in ONE completeJson call instead of one call
  // per cluster. Members within a unit, and units themselves, are
  // explicitly re-sorted by row id here too (belt-and-suspenders on top of
  // the pre-clustering sort above) so prompt assembly never depends on
  // clusterConsolidateCandidates' internal grouping order.
  const units: Array<{ clusterIndex: number; members: ConsolidateCandidate[] }> = [];
  for (const group of clusterIndexGroups) {
    const sortedGroup = [...group].sort((a, b) => byId(candidates[a], candidates[b]));
    const chunks = chunkCluster(sortedGroup, clusterCap);
    for (const chunkIndices of chunks) {
      if (chunkIndices.length < 2) continue;
      units.push({ clusterIndex: units.length + 1, members: chunkIndices.map((i) => candidates[i]) });
    }
  }
  units.sort((a, b) => byId(a.members[0], b.members[0]));

  // Convergence: clusters settled by a previous run (same members, same
  // content) are dropped before the cost gate and the decider ever see
  // them, so repeated runs over an unchanged store reach zero clusters.
  const fingerprintByUnit = new Map<(typeof units)[number], string>();
  for (const unit of units) {
    fingerprintByUnit.set(
      unit,
      computeClusterFingerprint(
        unit.members.map((m) => ({ id: m.entry.id, text: m.entry.text, metadata: m.entry.metadata })),
      ),
    );
  }
  let settledSkipped = 0;
  const activeUnits = units.filter((unit) => {
    if (options.settledFingerprints?.has(fingerprintByUnit.get(unit)!)) {
      settledSkipped += 1;
      return false;
    }
    return true;
  });
  units.length = 0;
  units.push(...activeUnits);
  units.forEach((unit, i) => {
    unit.clusterIndex = i + 1;
  });

  // Item 7: the cost gate sits here -- clustering above is free (local
  // cosine + fact_key/topic linking), and everything below this point is
  // the first LLM call onward. Skipped entirely when there's nothing to
  // decide (nothing to confirm), and bypassed without ever calling
  // confirmCost when autoConfirm (--yes) is set. A declined OR missing
  // confirmCost is treated identically: a safe abort, never assumed consent.
  let costPreview: ConsolidateCostPreview | undefined;
  if (units.length > 0) {
    costPreview = computeConsolidateCostPreview(units);
    if (!options.autoConfirm) {
      const message = formatConsolidateCostPreview(costPreview);
      const proceed = deps.confirmCost ? await deps.confirmCost(message) : false;
      if (!proceed) {
        return abortedResult(
          "cost gate declined (or no confirmCost dep and --yes not set): no LLM call was made",
          rawEntries.length,
          candidates.length,
          costPreview,
          options.apply
        );
      }
    }
  }

  const clusters: ClusterPlanReport[] = [];
  const membersByCluster = new Map<number, ConsolidateCandidate[]>();
  const pendingMergeContent: Array<{
    cluster: ClusterPlanReport;
    members: ConsolidateCandidate[];
    verdict: ConsolidateVerdictResult;
  }> = [];
  let skippedMalformed = 0;
  let undecidedCallFailed = 0;
  const newlySettled: string[] = [];

  const callFailedUnits = new Set<number>();
  if (units.length > 0) {
    // The decide prompt is CHUNKED (CONSOLIDATE_DECIDE_BATCH_MAX_SIZE
    // clusters per call): a plan-sized single prompt grows without bound and
    // a single provider rejection would strand every cluster at once. Each
    // chunk's call is also caught: a thrown completion (provider rejection,
    // network error) degrades exactly that chunk's clusters to call-failed,
    // identical to the null-response path.
    const verdictMap = new Map<number, ConsolidateVerdictResult>();
    for (let chunkStart = 0; chunkStart < units.length; chunkStart += CONSOLIDATE_DECIDE_BATCH_MAX_SIZE) {
      const chunkUnits = units.slice(chunkStart, chunkStart + CONSOLIDATE_DECIDE_BATCH_MAX_SIZE);
      const batchClusters: ConsolidateBatchCluster[] = chunkUnits.map((unit) => ({
        clusterIndex: unit.clusterIndex,
        members: unit.members.map((m, i) => ({
          index: i + 1,
          category: m.memoryCategory || "preferences",
          abstract: m.abstract,
          overview: m.overview,
          content: m.content,
          source: m.source,
          timestamp: m.entry.timestamp,
          validFrom: m.validFrom,
        })),
      }));
      const prompt = buildConsolidateBatchPrompt(batchClusters);
      let raw: Record<string, unknown> | null = null;
      try {
        raw = await deps.completeJson<Record<string, unknown>>(prompt.user, "consolidate-decide", prompt.system, 0);
      } catch (err) {
        deps.log?.(`memory-consolidate: consolidate-decide call threw (${String(err)}); treating this chunk as undecided`);
        raw = null;
      }
      if (raw === null || raw === undefined) {
        for (const unit of chunkUnits) callFailedUnits.add(unit.clusterIndex);
        deps.log?.(
          `memory-consolidate: consolidate-decide call returned no response (provider error or timeout); ${chunkUnits.length} cluster(s) left undecided`
        );
        continue;
      }
      const chunkVerdicts = parseConsolidateBatchVerdicts(
        raw,
        chunkUnits.map((u) => ({ clusterIndex: u.clusterIndex, memberCount: u.members.length }))
      );
      for (const [clusterIndex, verdict] of chunkVerdicts) verdictMap.set(clusterIndex, verdict);
    }

    // Build the COMPLETE plan now, regardless of apply/dry-run --
    // every merge verdict gets its content generated here (moved from
    // apply time), so execution later is pure store writes with zero
    // further LLM calls.
    for (const unit of units) {
      const members = unit.members;
      const verdict = verdictMap.get(unit.clusterIndex) ?? null;
      const fingerprint = fingerprintByUnit.get(unit)!;
      membersByCluster.set(unit.clusterIndex, members);

      if (!verdict) {
        if (callFailedUnits.has(unit.clusterIndex)) {
          undecidedCallFailed += 1;
        } else {
          skippedMalformed += 1;
          deps.log?.(
            `memory-consolidate: missing or malformed verdict for a cluster of ${members.length} rows, skipping`
          );
        }
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict: null,
          malformed: true,
          failure: callFailedUnits.has(unit.clusterIndex) ? "call-failed" : "malformed-verdict",
          fingerprint,
          action: null,
          staleness: members.map((m) => ({ id: m.entry.id, text: m.entry.text, metadata: m.entry.metadata })),
        });
        continue;
      }

      const staleness = members.map((m) => ({ id: m.entry.id, text: m.entry.text, metadata: m.entry.metadata }));

      if (verdict.verdict === "skip" || verdict.verdict === "contradict") {
        // Only SKIP settles: a contradiction is an unresolved live conflict,
        // and settling it would hide it from every later run for the ledger's
        // whole retention. Leaving it unsettled IS the retry workflow -- each
        // run re-surfaces it in the plan output until the operator resolves
        // the underlying rows.
        if (verdict.verdict === "skip") {
          newlySettled.push(fingerprint);
        }
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict,
          malformed: false,
          fingerprint,
          action: null,
          staleness,
        });
        continue;
      }

      const survivorCategory = members[verdict.survivorIndex! - 1].memoryCategory;
      const absorbedCategories = verdict.absorbedIndices!.map((idx) => members[idx - 1].memoryCategory);
      const survivorIsAppendOnly = Boolean(survivorCategory && APPEND_ONLY_CATEGORIES.has(survivorCategory));
      const absorbedTouchesAppendOnly = absorbedCategories.some(
        (category) => category && APPEND_ONLY_CATEGORIES.has(category),
      );
      // Append-only means invalidation-protection, not merge-immunity, and
      // the protection is directional: absorbed rows are what get invalidated
      // (and merge additionally rewrites the survivor's content), so an
      // append-only row may never be absorbed, and may only be a merge
      // survivor when every acted-upon row shares the identical append-only
      // category (a genuine same-category duplicate). A supersede survivor is
      // never written at all when it is append-only (applySupersedeVerdict
      // skips even the audit annotation), so an append-only row superseding
      // stale mutable rows leaves the append-only guarantee intact.
      const isSameCategoryAppendOnlyMerge =
        verdict.verdict === "merge" &&
        survivorIsAppendOnly &&
        absorbedCategories.every((category) => category === survivorCategory);
      const blockedByShield =
        verdict.verdict === "merge"
          ? (survivorIsAppendOnly || absorbedTouchesAppendOnly) && !isSameCategoryAppendOnlyMerge
          : absorbedTouchesAppendOnly;
      if (blockedByShield) {
        deps.log?.(
          `memory-consolidate: refusing to ${verdict.verdict} an append-only row (events/cases) outside a same-category duplicate merge; skipping this verdict`
        );
        // A shield-blocked verdict is as settled as a skip: re-running the
        // decider over the same unchanged members can only produce another
        // blocked verdict.
        newlySettled.push(fingerprint);
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict,
          malformed: false,
          blocked: "append-only-shield",
          fingerprint,
          action: null,
          staleness,
        });
        continue;
      }

      const survivor = members[verdict.survivorIndex! - 1];
      const absorbedIds = verdict.absorbedIndices!.map((idx) => members[idx - 1].entry.id);

      const cluster: ClusterPlanReport = {
        clusterIndex: unit.clusterIndex,
        memberIds: members.map((m) => m.entry.id),
        memberTexts: members.map((m) => m.abstract),
        verdict,
        malformed: false,
        fingerprint,
        action: verdict.verdict === "merge" ? "merge" : "supersede",
        survivorId: survivor.entry.id,
        absorbedIds,
        staleness,
      };
      clusters.push(cluster);
      if (verdict.verdict === "merge") {
        pendingMergeContent.push({ cluster, members, verdict });
      }
    }

    // One batched merge-content call (chunk-capped) covers every merge
    // verdict's plan content, moved out of the per-unit loop so the plan
    // build spends ceil(M/CONSOLIDATE_MERGE_BATCH_MAX_SIZE) LLM calls
    // instead of one call per absorbed member.
    if (pendingMergeContent.length > 0) {
      const contents = await buildMergePlanContentsBatch(deps, pendingMergeContent, deps.log);
      pendingMergeContent.forEach((pending, i) => {
        pending.cluster.mergedContent = contents[i];
      });
    }
  }

  const actionable = clusters.filter((c) => c.action);

  // Item 8: direct --apply executes the plan immediately, no second prompt.
  if (options.apply) {
    const { applied, staleSkipped, applyFailed } = await executePlan(deps, actionable, membersByCluster, scopeFilter, now);
    return {
      status: "completed",
      scanned: rawEntries.length,
      eligible: candidates.length,
      costPreview,
      clusters,
      applied,
      executed: true,
      staleSkipped,
      applyFailed,
      scanTruncated,
      skippedMalformed,
      undecidedCallFailed,
      settledSkipped,
      newlySettled,
      apply: true,
    };
  }

  // Dry-run / interactive path: present the full plan, ask once, execute
  // only on an explicit affirmative. A declined or missing confirmApply is
  // a safe no-op -- the plan was built (and its LLM calls already spent),
  // but nothing is written.
  if (actionable.length > 0) {
    const message = `${pluralCount(actionable.length, "cluster")} ready to apply. Apply these now? (YES/no)`;
    const proceed = deps.confirmApply ? await deps.confirmApply(message, clusters) : false;
    if (proceed) {
      const { applied, staleSkipped, applyFailed } = await executePlan(deps, actionable, membersByCluster, scopeFilter, now);
      return {
        status: "completed",
        scanned: rawEntries.length,
        eligible: candidates.length,
        costPreview,
        clusters,
        applied,
        executed: true,
        staleSkipped,
        applyFailed,
        scanTruncated,
        skippedMalformed,
        undecidedCallFailed,
        settledSkipped,
        newlySettled,
        apply: false,
      };
    }
  }

  return {
    status: "completed",
    scanned: rawEntries.length,
    eligible: candidates.length,
    costPreview,
    clusters,
    applied: [],
    executed: false,
    staleSkipped: [],
    applyFailed: [],
    scanTruncated,
    skippedMalformed,
    undecidedCallFailed,
    settledSkipped,
    newlySettled,
    apply: false,
  };
}
