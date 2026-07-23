import type {
  ManualRecallMetadataUpdate,
  MemoryBulkUpdateResult,
  MemoryStore,
} from "./store.js";

type ManualRecallMetadataWriter = Pick<MemoryStore, "applyManualRecallMetadataBatch">;

interface PendingUpdate extends ManualRecallMetadataUpdate {
  attempts: number;
}

interface ManualRecallMetadataQueueOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  warn?: (message: string) => void;
  onActive?: () => void;
  onIdle?: () => void;
}

const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_MAX_WAIT_MS = 500;
const DEFAULT_MAX_RETRIES = 3;

export class ManualRecallMetadataBatchSettledError extends Error {
  constructor(
    message: string,
    readonly results: MemoryBulkUpdateResult[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManualRecallMetadataBatchSettledError";
  }
}

function updateKey(update: Pick<ManualRecallMetadataUpdate, "id" | "expectedScope">): string {
  return `${update.id}\u0000${update.expectedScope}`;
}

function mergePending(
  current: PendingUpdate | undefined,
  incoming: ManualRecallMetadataUpdate,
  attempts = 0,
): PendingUpdate {
  const latestGovernanceSnapshot = !current || incoming.accessedAt >= current.accessedAt
    ? incoming.governanceSnapshot
    : current.governanceSnapshot;
  return {
    id: incoming.id,
    expectedScope: incoming.expectedScope,
    accessCountDelta: (current?.accessCountDelta ?? 0) + incoming.accessCountDelta,
    accessedAt: Math.max(current?.accessedAt ?? 0, incoming.accessedAt),
    governanceSnapshot: latestGovernanceSnapshot,
    attempts: current ? Math.min(current.attempts, attempts) : attempts,
  };
}

/**
 * Coalesces manual-recall metadata events and writes them behind the response
 * path in one exact-ID store batch.
 */
export class ManualRecallMetadataQueue {
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly warn: (message: string) => void;
  private readonly onActive: () => void;
  private readonly onIdle: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private firstPendingAt: number | null = null;
  private retryNotBeforeAt = 0;
  private closed = false;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private settlePromise: Promise<void> | null = null;

  constructor(
    private readonly writer: ManualRecallMetadataWriter,
    options: ManualRecallMetadataQueueOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => 100 * (2 ** (attempt - 1)));
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.onActive = options.onActive ?? (() => {});
    this.onIdle = options.onIdle ?? (() => {});
  }

  enqueue(updates: ManualRecallMetadataUpdate[]): void {
    if (this.closed) {
      const dropped = updates.filter((update) => update.accessCountDelta > 0).length;
      if (dropped > 0) {
        this.warn(
          `[memory-lancedb-pro] manual recall metadata queue is closed; dropped ${dropped} update(s)`,
        );
      }
      return;
    }

    let added = false;
    for (const update of updates) {
      if (update.accessCountDelta <= 0) continue;
      const key = updateKey(update);
      this.pending.set(key, mergePending(this.pending.get(key), update));
      added = true;
    }
    if (!added) return;
    this.onActive();
    this.firstPendingAt ??= Date.now();
    this.schedulePending(this.debounceMs);
  }

  getPendingUpdates(): ManualRecallMetadataUpdate[] {
    return [...this.pending.values()].map(({ attempts: _attempts, ...update }) => update);
  }

  async flush(): Promise<void> {
    await this.flushPending(true);
  }

  private async flushPending(force: boolean): Promise<void> {
    this.clearTimer();
    if (force) this.retryNotBeforeAt = 0;
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.pending.size > 0) {
        if (force) {
          await this.flushPending(true);
        } else {
          this.schedulePending(this.debounceMs);
        }
      }
      return;
    }
    if (this.pending.size === 0) return;
    if (!force && Date.now() < this.retryNotBeforeAt) {
      this.schedulePending(this.debounceMs);
      return;
    }
    this.retryNotBeforeAt = 0;

    this.flushPromise = this.flushOnce();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
      if (this.pending.size === 0) this.onIdle();
    }
  }

  async drain(): Promise<void> {
    this.drainPromise ??= this.drainOnce();
    await this.drainPromise;
  }

  async settle(): Promise<void> {
    const pendingSettle = this.settlePromise ?? this.settlePending();
    this.settlePromise = pendingSettle;
    try {
      await pendingSettle;
    } finally {
      if (this.settlePromise === pendingSettle) this.settlePromise = null;
    }
  }

  private async settlePending(): Promise<void> {
    this.clearTimer();
    this.retryNotBeforeAt = 0;
    while (this.flushPromise || this.pending.size > 0) {
      await this.flush();
    }
  }

  private async drainOnce(): Promise<void> {
    this.closed = true;
    this.draining = true;
    try {
      await this.settle();
    } finally {
      this.draining = false;
      this.onIdle();
    }
  }

  private async flushOnce(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.firstPendingAt = null;

    let results: MemoryBulkUpdateResult[];
    try {
      results = await this.writer.applyManualRecallMetadataBatch(
        batch.map(({ attempts: _attempts, ...update }) => update),
      );
    } catch (error) {
      if (!(error instanceof ManualRecallMetadataBatchSettledError)) {
        this.requeueFailures(batch, undefined, error);
        return;
      }
      results = error.results;
      this.warn(
        `[memory-lancedb-pro] manual recall metadata lock failed after the batch settled; ` +
        `using per-row outcomes without retrying committed rows: ${error.message}`,
      );
    }

    const errorsByUpdate = new Map<PendingUpdate, string>();
    const failed = batch.filter((update, index) => {
      const result = results[index];
      if (!result) {
        errorsByUpdate.set(update, "missing batch result");
        return true;
      }
      if (result.error) {
        if (result.retryable === false) {
          this.warn(
            `[memory-lancedb-pro] manual recall metadata dropped id=${update.id.slice(0, 8)} ` +
            `without retry: ${result.error}`,
          );
          return false;
        }
        errorsByUpdate.set(update, result.error);
        return true;
      }
      return false;
    });
    if (failed.length > 0) {
      this.requeueFailures(failed, errorsByUpdate);
    }
  }

  private requeueFailures(
    failed: PendingUpdate[],
    errorsByUpdate?: Map<PendingUpdate, string>,
    thrownError?: unknown,
  ): void {
    let nextDelay = 0;
    const now = Date.now();
    for (const update of failed) {
      const attempt = update.attempts + 1;
      const resultError = errorsByUpdate?.get(update);
      const reason = resultError ?? (thrownError instanceof Error ? thrownError.message : String(thrownError));
      if (attempt > this.maxRetries) {
        this.warn(
          `[memory-lancedb-pro] manual recall metadata dropped id=${update.id.slice(0, 8)} ` +
          `after ${this.maxRetries} retries: ${reason}`,
        );
        continue;
      }

      const key = updateKey(update);
      const current = this.pending.get(key);
      this.pending.set(
        key,
        mergePending(current, update, attempt),
      );
      nextDelay = Math.max(nextDelay, this.retryDelayMs(attempt));
      this.warn(
        `[memory-lancedb-pro] manual recall metadata retry id=${update.id.slice(0, 8)} ` +
        `attempt=${attempt}/${this.maxRetries}: ${reason}`,
      );
    }

    if (this.pending.size > 0) {
      this.firstPendingAt ??= now;
      this.retryNotBeforeAt = Math.max(this.retryNotBeforeAt, now + nextDelay);
      this.schedulePending(this.debounceMs);
    }
  }

  private schedulePending(delayMs: number): void {
    if (this.pending.size === 0 || this.draining || this.closed) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    const debounceAt = now + Math.max(0, delayMs);
    const maxWaitAt = this.firstPendingAt + Math.max(0, this.maxWaitMs);
    const dueAt = Math.max(this.retryNotBeforeAt, Math.min(debounceAt, maxWaitAt));
    this.scheduleAt(dueAt);
  }

  private scheduleAt(dueAt: number): void {
    if (this.timer && this.timerDueAt === dueAt) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      void this.flushPending(false).catch((error) => {
        this.warn(
          `[memory-lancedb-pro] manual recall metadata flush crashed: ${String(error)}`,
        );
      });
    }, Math.max(0, dueAt - Date.now()));
    this.timerDueAt = dueAt;
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = null;
  }
}

const queues = new WeakMap<object, ManualRecallMetadataQueue>();
const activeQueues = new Set<ManualRecallMetadataQueue>();
let exitDrainInstalled = false;
let exitDrainArmed = false;
let exitProbeScheduled = false;

async function drainQueue(queue: ManualRecallMetadataQueue): Promise<void> {
  try {
    await queue.drain();
  } finally {
    activeQueues.delete(queue);
  }
}

async function settleQueue(queue: ManualRecallMetadataQueue): Promise<void> {
  await queue.settle();
}

function scheduleExitProbe(): void {
  if (exitProbeScheduled || activeQueues.size === 0) return;
  exitProbeScheduled = true;
  setImmediate(() => {
    const pending = [...activeQueues];
    void Promise.allSettled(pending.map((queue) => settleQueue(queue))).then((results) => {
      const rejected = results.filter((result) => result.status === "rejected");
      if (rejected.length > 0) {
        console.warn(
          `[memory-lancedb-pro] failed to drain ${rejected.length} manual recall metadata queue(s) before exit`,
        );
      }
    }).finally(() => {
      exitProbeScheduled = false;
      if (activeQueues.size > 0) scheduleExitProbe();
    });
  });
}

function installExitDrain(): void {
  if (exitDrainInstalled) return;
  exitDrainInstalled = true;
  process.on("beforeExit", () => {
    exitDrainArmed = true;
    scheduleExitProbe();
  });
}

function queueFor(writer: ManualRecallMetadataWriter): ManualRecallMetadataQueue {
  const key = writer as object;
  let queue = queues.get(key);
  if (!queue) {
    queue = new ManualRecallMetadataQueue(writer, {
      onActive: () => {
        activeQueues.add(queue!);
        if (exitDrainArmed) scheduleExitProbe();
      },
      onIdle: () => activeQueues.delete(queue!),
    });
    queues.set(key, queue);
    installExitDrain();
  }
  return queue;
}

export function enqueueManualRecallMetadata(
  writer: ManualRecallMetadataWriter,
  updates: ManualRecallMetadataUpdate[],
): void {
  queueFor(writer).enqueue(updates);
}

export async function flushManualRecallMetadataForTest(
  writer: ManualRecallMetadataWriter,
): Promise<void> {
  await queueFor(writer).flush();
}

export async function drainManualRecallMetadata(
  writer: ManualRecallMetadataWriter,
): Promise<void> {
  const queue = queues.get(writer as object);
  if (queue) await drainQueue(queue);
}
