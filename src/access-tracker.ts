/**
 * Access Tracker
 *
 * Tracks memory access patterns to support reinforcement-based decay.
 * Frequently accessed memories decay more slowly (longer effective half-life).
 *
 * Key exports:
 * - parseAccessMetadata   — extract accessCount/lastAccessedAt from metadata JSON
 * - buildUpdatedMetadata  — merge access fields into existing metadata JSON
 * - computeEffectiveHalfLife — compute reinforced half-life from access history
 * - AccessTracker         — debounced write-back tracker for batch metadata updates
 */

import type { MemoryStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface AccessMetadata {
  readonly accessCount: number;
  readonly lastAccessedAt: number;
}

export interface AccessTrackerOptions {
  readonly store: MemoryStore;
  readonly logger: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
  };
  readonly debounceMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const MIN_ACCESS_COUNT = 0;
const MAX_ACCESS_COUNT = 10_000;

/** Access count itself decays with a 30-day half-life */
const ACCESS_DECAY_HALF_LIFE_DAYS = 30;

// ============================================================================
// Utility
// ============================================================================

function clampAccessCount(value: number): number {
  if (!Number.isFinite(value)) return MIN_ACCESS_COUNT;
  return Math.min(
    MAX_ACCESS_COUNT,
    Math.max(MIN_ACCESS_COUNT, Math.floor(value)),
  );
}

// ============================================================================
// Metadata Parsing
// ============================================================================

/**
 * Parse access-related fields from a metadata JSON string.
 *
 * Handles: undefined, empty string, malformed JSON, negative numbers,
 * numbers exceeding 10000. Always returns a valid AccessMetadata.
 */
export function parseAccessMetadata(
  metadata: string | undefined,
): AccessMetadata {
  if (metadata === undefined || metadata === "") {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  const obj = parsed as Record<string, unknown>;

  // Support both camelCase and snake_case keys (beta smart-memory uses snake_case).
  const rawCountAny = obj.accessCount ?? obj.access_count;
  const rawCount =
    typeof rawCountAny === "number" ? rawCountAny : Number(rawCountAny ?? 0);

  const rawLastAny = obj.lastAccessedAt ?? obj.last_accessed_at;
  const rawLastAccessed =
    typeof rawLastAny === "number" ? rawLastAny : Number(rawLastAny ?? 0);

  return {
    accessCount: clampAccessCount(rawCount),
    lastAccessedAt:
      Number.isFinite(rawLastAccessed) && rawLastAccessed >= 0
        ? rawLastAccessed
        : 0,
  };
}

// ============================================================================
// Metadata Building
// ============================================================================

/**
 * Merge an access-count increment into existing metadata JSON.
 *
 * Preserves ALL existing fields in the metadata object — only overwrites
 * `accessCount` and `lastAccessedAt`. Returns a new JSON string.
 */
export function buildUpdatedMetadata(
  existingMetadata: string | undefined,
  accessDelta: number,
): string {
  let existing: Record<string, unknown> = {};

  if (existingMetadata !== undefined && existingMetadata !== "") {
    try {
      const parsed = JSON.parse(existingMetadata);
      if (typeof parsed === "object" && parsed !== null) {
        existing = { ...parsed };
      }
    } catch {
      // malformed JSON — start fresh but preserve nothing
    }
  }

  const prev = parseAccessMetadata(existingMetadata);
  const newCount = clampAccessCount(prev.accessCount + accessDelta);

  const now = Date.now();

  return JSON.stringify({
    ...existing,
    // Write both camelCase and snake_case for compatibility.
    accessCount: newCount,
    lastAccessedAt: now,
    access_count: newCount,
    last_accessed_at: now,
  });
}

// ============================================================================
// Effective Half-Life Computation
// ============================================================================

/**
 * Compute the effective half-life for a memory based on its access history.
 *
 * The access count itself decays over time (30-day half-life for access
 * freshness), so stale accesses contribute less reinforcement. The extension
 * uses a logarithmic curve (`Math.log1p`) to provide diminishing returns.
 *
 * @param baseHalfLife        - Base half-life in days (e.g. 30)
 * @param accessCount         - Raw number of times the memory was accessed
 * @param lastAccessedAt      - Timestamp (ms) of last access
 * @param reinforcementFactor - Scaling factor for reinforcement (0 = disabled)
 * @param maxMultiplier       - Hard cap: result <= baseHalfLife * maxMultiplier
 * @returns Effective half-life in days
 */
export function computeEffectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  lastAccessedAt: number,
  reinforcementFactor: number,
  maxMultiplier: number,
): number {
  // Short-circuit: no reinforcement or no accesses
  if (reinforcementFactor === 0 || accessCount <= 0) {
    return baseHalfLife;
  }

  const now = Date.now();
  const daysSinceLastAccess = Math.max(
    0,
    (now - lastAccessedAt) / (1000 * 60 * 60 * 24),
  );

  // Access freshness decays exponentially with 30-day half-life
  const accessFreshness = Math.exp(
    -daysSinceLastAccess * (Math.LN2 / ACCESS_DECAY_HALF_LIFE_DAYS),
  );

  // Effective access count after freshness decay
  const effectiveAccessCount = accessCount * accessFreshness;

  // Logarithmic extension for diminishing returns
  const extension =
    baseHalfLife * reinforcementFactor * Math.log1p(effectiveAccessCount);

  const result = baseHalfLife + extension;

  // Hard cap
  const cap = baseHalfLife * maxMultiplier;
  return Math.min(result, cap);
}

// ============================================================================
// AccessTracker Class
// ============================================================================

/**
 * Debounced write-back tracker for memory access events.
 *
 * `recordAccess()` is synchronous (Map update only, no I/O). Pending deltas
 * accumulate until `flush()` is called (or by a future scheduled callback).
 * On flush, each pending entry is read via `store.getById()`, its metadata
 * is merged with the accumulated access delta, and written back via
 * `store.update()`.
 */
export class AccessTracker {
  private readonly pending: Map<string, number> = new Map();
  // Tracks retry count per ID so that delta is never amplified across failures.
  private readonly _retryCount = new Map<string, number>();
  private readonly _maxRetries = 5;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly debounceMs: number;
  private readonly store: MemoryStore;
  private readonly logger: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
  };

  constructor(options: AccessTrackerOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 5_000;
  }

  /**
   * Record one access for each of the given memory IDs.
   * Synchronous — only updates the in-memory pending map.
   */
  recordAccess(ids: readonly string[]): void {
    for (const id of ids) {
      const current = this.pending.get(id) ?? 0;
      this.pending.set(id, current + 1);
    }

    // Reset debounce timer
    this.resetTimer();
  }

  /**
   * Return a snapshot of all pending (id -> delta) entries.
   */
  getPendingUpdates(): Map<string, number> {
    return new Map(this.pending);
  }

  /**
   * Flush pending access deltas to the store.
   *
   * If a flush is already in progress, awaits the current flush to complete.
   * If new pending data accumulated during the in-flight flush, a follow-up
   * flush is automatically triggered.
   */
  async flush(): Promise<void> {
    this.clearTimer();

    // If a flush is in progress, wait for it to finish
    if (this.flushPromise) {
      await this.flushPromise;
      // After the in-flight flush completes, check if new data accumulated
      if (this.pending.size > 0) {
        return this.flush();
      }
      return;
    }

    if (this.pending.size === 0) return;

    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }

    // If new data accumulated during flush, schedule a follow-up
    if (this.pending.size > 0) {
      this.resetTimer();
    }
  }

  /**
   * Tear down the tracker — cancel timers and clear pending state.
   */
  destroy(): void {
    this.clearTimer();
    if (this.pending.size > 0) {
      this.logger.warn(
        `access-tracker: destroying with ${this.pending.size} pending writes — attempting final flush (3s timeout)`,
      );
      // Clear synchronously BEFORE returning — async flush is best-effort.
      this.pending.clear();
      this._retryCount.clear();
      // Fire-and-forget final flush with a hard 3s timeout.
      // Route through flush() to avoid concurrent write-backs with any in-flight flush.
      const flushWithTimeout = Promise.race([
        this.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      void flushWithTimeout.catch(() => {
        // Suppress unhandled rejection during shutdown.
      });
    } else {
      this.pending.clear();
      this._retryCount.clear();
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async doFlush(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();

    for (const [id, delta] of batch) {
      try {
        const current = await this.store.getById(id);
        if (!current) {
          // ID not found — memory was deleted or outside current scope.
          // Do NOT retry or warn; just drop silently and clear any retry counter.
          this._retryCount.delete(id);
          continue;
        }

        const updatedMeta = buildUpdatedMetadata(current.metadata, delta);
        await this.store.update(id, { metadata: updatedMeta });
        this._retryCount.delete(id); // success — clear retry counter
      } catch (err) {
        const retryCount = (this._retryCount.get(id) ?? 0) + 1;
        if (retryCount > this._maxRetries) {
          // Exceeded max retries — drop and log error.
          this._retryCount.delete(id);
          this.logger.error?.(
            `access-tracker: dropping ${id.slice(0, 8)} after ${retryCount} failed retries`,
          );
        } else {
          this._retryCount.set(id, retryCount);
          // Requeue: merge new delta with pending (safe because _retryCount is now independent,
          // so delta represents "unflushed retry" only, not accumulated retry amplification).
          this.pending.set(id, (this.pending.get(id) ?? 0) + delta);
          this.logger.warn(
            `access-tracker: write-back failed for ${id.slice(0, 8)} (attempt ${retryCount}/${this._maxRetries}):`,
            err,
          );
        }
      }
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
