import type { SmartMemoryMetadata } from "./smart-metadata.ts";

// Suppression fires when bad_recall_count reaches this value (and the recall
// dedup window is active). Hardcoded by Tier 1 design; if this becomes
// configurable, expose via opts on computeTier1Patch.
export const TIER1_BAD_RECALL_SUPPRESSION_THRESHOLD = 3;

// Default values for the two plugin config fields. Kept here so the
// production code path and tests share a single source of truth.
export const TIER1_DEFAULT_BAD_RECALL_DECAY_MS = 86_400_000;        // 24h
export const TIER1_DEFAULT_SUPPRESSION_DURATION_MS = 1_800_000;     // 30min

// Subset of SmartMemoryMetadata that Tier 1 actually reads. Using a structural
// type lets unit tests pass partial objects without losing type safety in
// production (where the full SmartMemoryMetadata is supplied).
export interface Tier1MetaInput {
  access_count?: number;
  injected_count?: number;
  bad_recall_count?: number;
  last_injected_at?: number;
  last_confirmed_use_at?: number;
  suppressed_until_turn?: number;
  // Presence semantics: `undefined` = never touched by Tier 1 (lazy-heal
  // sentinel); `0` = touched, no active suppression; `> 0` = suppressed.
  suppressed_until_ms?: number;
}

export interface ComputeTier1PatchOpts {
  injectedAt: number;
  badRecallDecayMs?: number;
  suppressionDurationMs?: number;
  // Recall-dedup window. When 0, suppression cannot fire even if the threshold
  // is reached — there is no per-session repeat-injection mechanism in play.
  minRepeated?: number;
}

// Patch shape produced by Tier 1 for an auto-recall injection. The keys are
// a subset of SmartMemoryMetadata so the result can be passed directly to
// store.patchMetadata().
export interface Tier1Patch {
  access_count: number;
  last_accessed_at: number;
  injected_count: number;
  last_injected_at: number;
  bad_recall_count: number;
  suppressed_until_ms: number;
  suppressed_until_turn: 0;
}

// Tier 1 governance predicate: is this memory currently suppressed from
// auto-recall? Reads only the ms-based field; the legacy turn field is
// retired in the read path.
export function isSuppressed(meta: Tier1MetaInput, nowMs: number): boolean {
  const until = meta.suppressed_until_ms ?? 0;
  return until > 0 && nowMs < until;
}

// Tier 1 staleInjected judgment — whether the previous injection of this
// memory ever got confirmed by user behavior. Preserved verbatim from the
// pre-Tier-1 path: PR #597 / Proposal A owns any future change to this rule.
function isStaleInjection(meta: Tier1MetaInput): boolean {
  return (
    typeof meta.last_injected_at === "number" &&
    meta.last_injected_at > 0 &&
    (typeof meta.last_confirmed_use_at !== "number" ||
      meta.last_confirmed_use_at < meta.last_injected_at)
  );
}

// Compute the metadata patch to apply to a memory after Tier 1 auto-recall
// injects it. Pure function — caller persists the patch.
export function computeTier1Patch(
  meta: Tier1MetaInput,
  opts: ComputeTier1PatchOpts,
): Tier1Patch {
  const {
    injectedAt,
    badRecallDecayMs = TIER1_DEFAULT_BAD_RECALL_DECAY_MS,
    suppressionDurationMs = TIER1_DEFAULT_SUPPRESSION_DURATION_MS,
    minRepeated = 0,
  } = opts;

  const accessCount = meta.access_count ?? 0;
  const injectedCount = meta.injected_count ?? 0;
  const rawBadRecall = meta.bad_recall_count ?? 0;
  const turnLegacy = meta.suppressed_until_turn ?? 0;

  // Lazy heal: a memory has never been touched by Tier 1 if
  // `suppressed_until_ms` is undefined. If it still carries legacy pollution,
  // reset before any new logic runs.
  let baseBadRecall = rawBadRecall;
  if (
    meta.suppressed_until_ms === undefined &&
    (rawBadRecall > 0 || turnLegacy > 0)
  ) {
    baseBadRecall = 0;
  }

  // Option C decay: if the gap since the last injection exceeds the decay
  // window, reset bad_recall_count — "this memory is being needed again".
  // Negative gap (clock skew, e.g. NTP resync) falls through as "no decay":
  // never falsely reset due to apparent time travel.
  const gapSinceLastInjection =
    typeof meta.last_injected_at === "number"
      ? injectedAt - meta.last_injected_at
      : Infinity;
  const decayedBadRecall =
    badRecallDecayMs > 0 && gapSinceLastInjection > badRecallDecayMs
      ? 0
      : baseBadRecall;

  const staleInjected = isStaleInjection(meta);
  const nextBadRecallCount = staleInjected
    ? decayedBadRecall + 1
    : decayedBadRecall;
  const shouldSuppress =
    nextBadRecallCount >= TIER1_BAD_RECALL_SUPPRESSION_THRESHOLD &&
    minRepeated > 0;

  return {
    access_count: accessCount + 1,
    last_accessed_at: injectedAt,
    injected_count: injectedCount + 1,
    last_injected_at: injectedAt,
    bad_recall_count: nextBadRecallCount,
    suppressed_until_ms: shouldSuppress
      ? Math.max(meta.suppressed_until_ms ?? 0, injectedAt + suppressionDurationMs)
      : (meta.suppressed_until_ms ?? 0),
    // Always zero the legacy turn field on any Tier-1-era patch so stale
    // numbers cannot leak through.
    suppressed_until_turn: 0,
  };
}

// Re-export the SmartMemoryMetadata type alias used here so callers don't
// need a second import for the patch input.
export type { SmartMemoryMetadata };
