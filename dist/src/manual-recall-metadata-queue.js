const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_MAX_RETRIES = 3;
function updateKey(update) {
    return `${update.id}\u0000${update.expectedScope}`;
}
function mergePending(current, incoming, attempts = 0) {
    return {
        id: incoming.id,
        expectedScope: incoming.expectedScope,
        accessCountDelta: (current?.accessCountDelta ?? 0) + incoming.accessCountDelta,
        accessedAt: Math.max(current?.accessedAt ?? 0, incoming.accessedAt),
        attempts: Math.max(current?.attempts ?? 0, attempts),
    };
}
/**
 * Coalesces manual-recall metadata events and writes them behind the response
 * path in one exact-ID store batch.
 */
export class ManualRecallMetadataQueue {
    writer;
    pending = new Map();
    debounceMs;
    maxRetries;
    retryDelayMs;
    warn;
    timer = null;
    flushPromise = null;
    constructor(writer, options = {}) {
        this.writer = writer;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.retryDelayMs = options.retryDelayMs ?? ((attempt) => 100 * (2 ** (attempt - 1)));
        this.warn = options.warn ?? ((message) => console.warn(message));
    }
    enqueue(updates) {
        for (const update of updates) {
            if (update.accessCountDelta <= 0)
                continue;
            const key = updateKey(update);
            this.pending.set(key, mergePending(this.pending.get(key), update));
        }
        this.schedule(this.debounceMs);
    }
    getPendingUpdates() {
        return [...this.pending.values()].map(({ attempts: _attempts, ...update }) => update);
    }
    async flush() {
        this.clearTimer();
        if (this.flushPromise) {
            await this.flushPromise;
            if (this.pending.size > 0)
                await this.flush();
            return;
        }
        if (this.pending.size === 0)
            return;
        this.flushPromise = this.flushOnce();
        try {
            await this.flushPromise;
        }
        finally {
            this.flushPromise = null;
        }
    }
    async flushOnce() {
        const batch = [...this.pending.values()];
        this.pending.clear();
        let results;
        try {
            results = await this.writer.applyManualRecallMetadataBatch(batch.map(({ attempts: _attempts, ...update }) => update));
        }
        catch (error) {
            this.requeueFailures(batch, undefined, error);
            return;
        }
        const errorsByUpdate = new Map();
        const failed = batch.filter((update, index) => {
            const result = results[index];
            if (!result) {
                errorsByUpdate.set(update, "missing batch result");
                return true;
            }
            if (result.error) {
                errorsByUpdate.set(update, result.error);
                return true;
            }
            return false;
        });
        if (failed.length > 0) {
            this.requeueFailures(failed, errorsByUpdate);
        }
    }
    requeueFailures(failed, errorsByUpdate, thrownError) {
        let nextDelay = 0;
        for (const update of failed) {
            const attempt = update.attempts + 1;
            const resultError = errorsByUpdate?.get(update);
            const reason = resultError ?? (thrownError instanceof Error ? thrownError.message : String(thrownError));
            if (attempt > this.maxRetries) {
                this.warn(`[memory-lancedb-pro] manual recall metadata dropped id=${update.id.slice(0, 8)} ` +
                    `after ${this.maxRetries} retries: ${reason}`);
                continue;
            }
            const key = updateKey(update);
            const current = this.pending.get(key);
            this.pending.set(key, mergePending(current, update, attempt));
            nextDelay = Math.max(nextDelay, this.retryDelayMs(attempt));
            this.warn(`[memory-lancedb-pro] manual recall metadata retry id=${update.id.slice(0, 8)} ` +
                `attempt=${attempt}/${this.maxRetries}: ${reason}`);
        }
        if (this.pending.size > 0)
            this.schedule(nextDelay || this.debounceMs);
    }
    schedule(delayMs) {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().catch((error) => {
                this.warn(`[memory-lancedb-pro] manual recall metadata flush crashed: ${String(error)}`);
            });
        }, delayMs);
        this.timer.unref?.();
    }
    clearTimer() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
}
const queues = new WeakMap();
function queueFor(writer) {
    const key = writer;
    let queue = queues.get(key);
    if (!queue) {
        queue = new ManualRecallMetadataQueue(writer);
        queues.set(key, queue);
    }
    return queue;
}
export function enqueueManualRecallMetadata(writer, updates) {
    queueFor(writer).enqueue(updates);
}
export async function flushManualRecallMetadataForTest(writer) {
    await queueFor(writer).flush();
}
