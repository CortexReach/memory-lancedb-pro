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
  buildMergePrompt,
  buildConsolidateBatchPrompt,
  CONSOLIDATE_MERGE_SYSTEM_PROMPT,
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
  return shorter.length >= 4 && longer.includes(shorter);
}

function shareSignificantTopicToken(a: string, b: string): boolean {
  const tokensA = extractTopicTokens(a);
  const tokensB = extractTopicTokens(b);
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
function topicTokenOverlapRatio(a: string, b: string): number {
  const tokensA = extractTopicTokens(a);
  const tokensB = extractTopicTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let matches = 0;
  for (const tokenA of tokensA) {
    for (const tokenB of tokensB) {
      if (tokensMatch(tokenA, tokenB)) {
        matches += 1;
        break;
      }
    }
  }
  return matches / Math.min(tokensA.size, tokensB.size);
}

const NEAR_DUPLICATE_TOKEN_OVERLAP_RATIO = 0.6;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
  };
}

function isDirectlyLinked(
  a: ConsolidateCandidate,
  b: ConsolidateCandidate,
  similarityThreshold: number
): boolean {
  const va = a.entry.vector;
  const vb = b.entry.vector;
  if (va.length > 0 && vb.length > 0 && cosineSimilarity(va, vb) >= similarityThreshold) {
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
    (looksLikeReversal(a.abstract) || looksLikeReversal(b.abstract)) &&
    a.memoryCategory &&
    a.memoryCategory === b.memoryCategory &&
    isEligibleForTopicLink(a.abstract) &&
    isEligibleForTopicLink(b.abstract) &&
    shareSignificantTopicToken(a.abstract, b.abstract)
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
    isEligibleForTopicLink(a.abstract) &&
    isEligibleForTopicLink(b.abstract) &&
    topicTokenOverlapRatio(a.abstract, b.abstract) >= NEAR_DUPLICATE_TOKEN_OVERLAP_RATIO
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
}

// ============================================================================
// Item 7: LLM-cost gate. Clustering is free (local cosine + fact_key/topic
// linking); the only paid calls are the one batched decider call and, since
// item 8 moves merge-content generation into the plan phase, up to one
// merge-content generation per absorbed member of every unit that MIGHT turn
// out to be a merge verdict. Both are knowable from clustering alone, before
// any LLM call is made -- which is what lets the gate sit ahead of the
// decide call and cover dry-runs as well as --apply.
// ============================================================================

export interface ConsolidateCostPreview {
  clusterCount: number;
  maxMergeGenerations: number;
}

export function computeConsolidateCostPreview(
  units: Array<{ members: unknown[] }>
): ConsolidateCostPreview {
  return {
    clusterCount: units.length,
    maxMergeGenerations: units.reduce((sum, u) => sum + Math.max(0, u.members.length - 1), 0),
  };
}

export function formatConsolidateCostPreview(preview: ConsolidateCostPreview): string {
  const lines = [`${preview.clusterCount} cluster(s) -> 1 batched decider call`];
  if (preview.maxMergeGenerations > 0) {
    lines.push(`+ up to ${preview.maxMergeGenerations} merge-content generation(s)`);
  }
  return lines.join("\n");
}

// No `delete` method: no LLM verdict path may hard-delete a row. Both
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
 * Item 8: pure content generation for a merge verdict -- every
 * `consolidate-merge` completion plus the final re-embed, with NO store
 * writes. Called once per merge verdict at PLAN-BUILD time (dry-run or
 * --apply alike), so execution later can be pure store operations that
 * never regenerate content and never call the LLM again.
 */
async function buildMergePlanContent(
  deps: Pick<ConsolidateWriteDeps, "embed" | "completeJson">,
  members: ConsolidateCandidate[],
  verdict: ConsolidateVerdictResult
): Promise<ConsolidateMergedContent> {
  const survivor = members[verdict.survivorIndex! - 1];
  let abstract = survivor.abstract;
  let overview = survivor.overview;
  let content = survivor.content;

  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    const prompt = buildMergePrompt(
      abstract,
      overview,
      content,
      absorbed.abstract,
      absorbed.overview,
      absorbed.content,
      survivor.memoryCategory || "preferences"
    );
    const merged = await deps.completeJson<{ abstract: string; overview: string; content: string }>(
      prompt,
      "consolidate-merge",
      CONSOLIDATE_MERGE_SYSTEM_PROMPT
    );
    if (merged) {
      abstract = merged.abstract;
      overview = merged.overview;
      content = merged.content;
    }
  }

  const vector = await deps.embed(`${abstract} ${content}`);
  return { abstract, overview, content, vector };
}

/**
 * Item 8: pure store write for an already-planned merge verdict. Applies
 * EXACTLY the precomputed content from `buildMergePlanContent` -- no LLM
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

  const patchedMeta = buildSmartMetadata(survivor.entry, {
    l0_abstract: abstract,
    l1_overview: overview,
    l2_content: content,
  });
  const auditedMeta = {
    ...patchedMeta,
    consolidation_audit: { action: "merge", absorbedIds, reason: verdict.reason, at: now },
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
  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    const existingMeta = parseSmartMetadata(absorbed.entry.metadata, absorbed.entry);
    const invalidatedMeta = buildSmartMetadata(absorbed.entry, {
      invalidated_at: now,
      superseded_by: survivor.entry.id,
      relations: appendRelation(existingMeta.relations, { type: "superseded_by", targetId: survivor.entry.id }),
    });
    const auditedAbsorbedMeta = {
      ...invalidatedMeta,
      consolidation_audit: { action: "merge", survivorId: survivor.entry.id, reason: verdict.reason, at: now },
    };
    await deps.update(absorbed.entry.id, { metadata: stringifySmartMetadata(auditedAbsorbedMeta) }, scopeFilter);
  }

  return { action: "merge", survivorId: survivor.entry.id, absorbedIds, reason: verdict.reason, scope: survivor.entry.scope };
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

  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    const existingMeta = parseSmartMetadata(absorbed.entry.metadata, absorbed.entry);
    const invalidatedMetadata = buildSmartMetadata(absorbed.entry, {
      fact_key: factKey || existingMeta.fact_key,
      invalidated_at: now,
      superseded_by: survivor.entry.id,
      relations: appendRelation(existingMeta.relations, { type: "superseded_by", targetId: survivor.entry.id }),
    });
    await deps.update(absorbed.entry.id, { metadata: stringifySmartMetadata(invalidatedMetadata) }, scopeFilter);
    absorbedIds.push(absorbed.entry.id);
  }

  const survivorMeta = parseSmartMetadata(survivor.entry.metadata, survivor.entry);
  const patchedSurvivorMeta = buildSmartMetadata(survivor.entry, {
    fact_key: factKey || survivorMeta.fact_key,
  });
  const auditedMeta = {
    ...patchedSurvivorMeta,
    consolidation_audit: { action: "supersede", absorbedIds, reason: verdict.reason, at: now },
  };
  await deps.update(survivor.entry.id, { metadata: stringifySmartMetadata(auditedMeta) }, scopeFilter);

  return { action: "supersede", survivorId: survivor.entry.id, absorbedIds, reason: verdict.reason, scope: survivor.entry.scope };
}

export interface ClusterPlanReport {
  clusterIndex: number;
  memberIds: string[];
  memberTexts: string[];
  verdict: ConsolidateVerdictResult | null;
  malformed: boolean;
  /** null for skip/contradict/malformed/append-only-blocked units -- nothing to execute. */
  action: "merge" | "supersede" | null;
  survivorId?: string;
  absorbedIds?: string[];
  /** Item 8: precomputed at plan-build time, applied verbatim at execution. */
  mergedContent?: ConsolidateMergedContent;
  /** Snapshot used by the item-8 staleness guard: each member's id + exact metadata string at plan-build time. */
  staleness: Array<{ id: string; metadata: string | undefined }>;
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
  skippedMalformed: number;
  apply: boolean;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.86;
const DEFAULT_CLUSTER_CAP = 8;
const DEFAULT_SCAN_LIMIT = 100_000;

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
    skippedMalformed: 0,
    apply,
  };
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
): Promise<{ applied: ConsolidateAuditEntry[]; staleSkipped: Array<{ clusterIndex: number; memberIds: string[] }> }> {
  const applied: ConsolidateAuditEntry[] = [];
  const staleSkipped: Array<{ clusterIndex: number; memberIds: string[] }> = [];

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

    try {
      const audit =
        entry.action === "merge"
          ? await writeMergeVerdict(deps, members, entry.verdict, entry.mergedContent!, scopeFilter, now)
          : await applySupersedeVerdict(deps, members, entry.verdict, scopeFilter, now);
      applied.push(audit);
      await deps.onAudit?.(audit);
    } catch (err) {
      deps.log?.(`memory-consolidate: failed to apply ${entry.action} verdict: ${String(err)}`);
    }
  }

  return { applied, staleSkipped };
}

export async function runConsolidate(
  deps: RunConsolidateDeps,
  options: RunConsolidateOptions
): Promise<RunConsolidateResult> {
  const now = options.now ?? Date.now();
  const scopeFilter = options.scopeFilter ?? [options.scope];

  const rawEntries = await deps.fetchRows(scopeFilter, now, DEFAULT_SCAN_LIMIT);

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
  let skippedMalformed = 0;

  if (units.length > 0) {
    const batchClusters: ConsolidateBatchCluster[] = units.map((unit) => ({
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
    const raw = await deps.completeJson<Record<string, unknown>>(prompt.user, "consolidate-decide", prompt.system, 0);
    const verdictMap = raw
      ? parseConsolidateBatchVerdicts(
          raw,
          units.map((u) => ({ clusterIndex: u.clusterIndex, memberCount: u.members.length }))
        )
      : new Map<number, ConsolidateVerdictResult>();

    // Item 8: build the COMPLETE plan now, regardless of apply/dry-run --
    // every merge verdict gets its content generated here (moved from
    // apply time), so execution later is pure store writes with zero
    // further LLM calls.
    for (const unit of units) {
      const members = unit.members;
      const verdict = verdictMap.get(unit.clusterIndex) ?? null;
      membersByCluster.set(unit.clusterIndex, members);

      if (!verdict) {
        skippedMalformed += 1;
        deps.log?.(
          `memory-consolidate: missing or malformed verdict for a cluster of ${members.length} rows, skipping`
        );
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict: null,
          malformed: true,
          action: null,
          staleness: members.map((m) => ({ id: m.entry.id, metadata: m.entry.metadata })),
        });
        continue;
      }

      const staleness = members.map((m) => ({ id: m.entry.id, metadata: m.entry.metadata }));

      if (verdict.verdict === "skip" || verdict.verdict === "contradict") {
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict,
          malformed: false,
          action: null,
          staleness,
        });
        continue;
      }

      const actedUponIndices = [verdict.survivorIndex!, ...verdict.absorbedIndices!];
      if (
        actedUponIndices.some((idx) => {
          const category = members[idx - 1].memoryCategory;
          return category && APPEND_ONLY_CATEGORIES.has(category);
        })
      ) {
        deps.log?.(
          `memory-consolidate: refusing to ${verdict.verdict} an append-only row (events/cases); skipping this verdict`
        );
        clusters.push({
          clusterIndex: unit.clusterIndex,
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict,
          malformed: false,
          action: null,
          staleness,
        });
        continue;
      }

      const survivor = members[verdict.survivorIndex! - 1];
      const absorbedIds = verdict.absorbedIndices!.map((idx) => members[idx - 1].entry.id);

      let mergedContent: ConsolidateMergedContent | undefined;
      if (verdict.verdict === "merge") {
        mergedContent = await buildMergePlanContent(deps, members, verdict);
      }

      clusters.push({
        clusterIndex: unit.clusterIndex,
        memberIds: members.map((m) => m.entry.id),
        memberTexts: members.map((m) => m.abstract),
        verdict,
        malformed: false,
        action: verdict.verdict === "merge" ? "merge" : "supersede",
        survivorId: survivor.entry.id,
        absorbedIds,
        mergedContent,
        staleness,
      });
    }
  }

  const actionable = clusters.filter((c) => c.action);

  // Item 8: direct --apply executes the plan immediately, no second prompt.
  if (options.apply) {
    const { applied, staleSkipped } = await executePlan(deps, actionable, membersByCluster, scopeFilter, now);
    return {
      status: "completed",
      scanned: rawEntries.length,
      eligible: candidates.length,
      costPreview,
      clusters,
      applied,
      executed: true,
      staleSkipped,
      skippedMalformed,
      apply: true,
    };
  }

  // Dry-run / interactive path: present the full plan, ask once, execute
  // only on an explicit affirmative. A declined or missing confirmApply is
  // a safe no-op -- the plan was built (and its LLM calls already spent),
  // but nothing is written.
  if (actionable.length > 0) {
    const message = `${actionable.length} cluster(s) ready to apply. Apply these now? (YES/no)`;
    const proceed = deps.confirmApply ? await deps.confirmApply(message, clusters) : false;
    if (proceed) {
      const { applied, staleSkipped } = await executePlan(deps, actionable, membersByCluster, scopeFilter, now);
      return {
        status: "completed",
        scanned: rawEntries.length,
        eligible: candidates.length,
        costPreview,
        clusters,
        applied,
        executed: true,
        staleSkipped,
        skippedMalformed,
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
    skippedMalformed,
    apply: false,
  };
}
