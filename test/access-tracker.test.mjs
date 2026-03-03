import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  parseAccessMetadata,
  buildUpdatedMetadata,
  computeEffectiveHalfLife,
  AccessTracker,
} = jiti("../src/access-tracker.ts");

// ============================================================================
// Test helpers
// ============================================================================

function createMockStore(entries = new Map()) {
  return {
    /** @type {Array<{id: string}>} */
    getByIdCalls: [],
    /** @type {Array<{id: string, updates: object}>} */
    updateCalls: [],
    async getById(id) {
      this.getByIdCalls.push({ id });
      const entry = entries.get(id);
      if (!entry) return null;
      return { ...entry };
    },
    async update(id, updates) {
      this.updateCalls.push({ id, updates });
      const entry = entries.get(id);
      if (!entry) return null;
      // Simulate store.update: apply updates to entry
      if (updates.metadata) {
        entry.metadata = updates.metadata;
      }
      return { ...entry };
    },
  };
}

function createMockLogger() {
  return {
    /** @type {unknown[][]} */
    warnings: [],
    warn(...args) {
      this.warnings.push(args);
    },
    info() {},
  };
}

function createTracker(overrides = {}) {
  const store = overrides.store || createMockStore();
  const logger = overrides.logger || createMockLogger();
  const debounceMs = overrides.debounceMs ?? 60_000;
  return {
    tracker: new AccessTracker({ store, logger, debounceMs }),
    store,
    logger,
  };
}

// ============================================================================
// parseAccessMetadata
// ============================================================================

describe("parseAccessMetadata", () => {
  it("returns defaults for undefined", () => {
    const result = parseAccessMetadata(undefined);
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("returns defaults for empty string", () => {
    const result = parseAccessMetadata("");
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("returns defaults for malformed JSON", () => {
    const result = parseAccessMetadata("{not valid json");
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("returns defaults for JSON array (non-object)", () => {
    const result = parseAccessMetadata("[1, 2, 3]");
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("returns defaults for JSON null", () => {
    const result = parseAccessMetadata("null");
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("returns defaults for JSON string", () => {
    const result = parseAccessMetadata('"hello"');
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("parses valid metadata with both fields", () => {
    const meta = JSON.stringify({ accessCount: 5, lastAccessedAt: 1700000000000 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 5);
    assert.equal(result.lastAccessedAt, 1700000000000);
  });

  it("defaults missing accessCount to 0", () => {
    const meta = JSON.stringify({ lastAccessedAt: 1700000000000 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 1700000000000);
  });

  it("defaults missing lastAccessedAt to 0", () => {
    const meta = JSON.stringify({ accessCount: 3 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 3);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("clamps negative accessCount to 0", () => {
    const meta = JSON.stringify({ accessCount: -10, lastAccessedAt: 100 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 0);
  });

  it("clamps accessCount above 10000 to 10000", () => {
    const meta = JSON.stringify({ accessCount: 99999, lastAccessedAt: 100 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 10000);
  });

  it("floors fractional accessCount", () => {
    const meta = JSON.stringify({ accessCount: 3.7 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 3);
  });

  it("handles NaN accessCount", () => {
    const meta = JSON.stringify({ accessCount: "not a number" });
    const result = parseAccessMetadata(meta);
    assert.equal(result.accessCount, 0);
  });

  it("handles Infinity accessCount", () => {
    // JSON.stringify converts Infinity to null, so manually craft
    const meta = '{"accessCount": 1e309}';
    const result = parseAccessMetadata(meta);
    // 1e309 parses to Infinity in JS, which is not finite
    assert.equal(result.accessCount, 0);
  });

  it("handles negative lastAccessedAt", () => {
    const meta = JSON.stringify({ accessCount: 1, lastAccessedAt: -500 });
    const result = parseAccessMetadata(meta);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("preserves valid lastAccessedAt", () => {
    const ts = Date.now();
    const meta = JSON.stringify({ lastAccessedAt: ts });
    const result = parseAccessMetadata(meta);
    assert.equal(result.lastAccessedAt, ts);
  });

  it("handles empty JSON object", () => {
    const result = parseAccessMetadata("{}");
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });
});

// ============================================================================
// buildUpdatedMetadata
// ============================================================================

describe("buildUpdatedMetadata", () => {
  it("creates metadata from undefined with delta=1", () => {
    const result = JSON.parse(buildUpdatedMetadata(undefined, 1));
    assert.equal(result.accessCount, 1);
    assert.equal(typeof result.lastAccessedAt, "number");
    assert.ok(result.lastAccessedAt > 0);
  });

  it("creates metadata from empty string with delta=1", () => {
    const result = JSON.parse(buildUpdatedMetadata("", 1));
    assert.equal(result.accessCount, 1);
  });

  it("increments existing accessCount", () => {
    const existing = JSON.stringify({ accessCount: 3, lastAccessedAt: 100 });
    const result = JSON.parse(buildUpdatedMetadata(existing, 2));
    assert.equal(result.accessCount, 5);
  });

  it("preserves all existing fields", () => {
    const existing = JSON.stringify({
      accessCount: 1,
      lastAccessedAt: 100,
      customField: "hello",
      nested: { a: 1 },
    });
    const result = JSON.parse(buildUpdatedMetadata(existing, 1));
    assert.equal(result.accessCount, 2);
    assert.equal(result.customField, "hello");
    assert.deepEqual(result.nested, { a: 1 });
  });

  it("clamps result to max 10000", () => {
    const existing = JSON.stringify({ accessCount: 9999 });
    const result = JSON.parse(buildUpdatedMetadata(existing, 100));
    assert.equal(result.accessCount, 10000);
  });

  it("clamps negative result to 0", () => {
    const existing = JSON.stringify({ accessCount: 2 });
    const result = JSON.parse(buildUpdatedMetadata(existing, -10));
    assert.equal(result.accessCount, 0);
  });

  it("handles malformed existing JSON gracefully", () => {
    const result = JSON.parse(buildUpdatedMetadata("{bad json", 3));
    assert.equal(result.accessCount, 3);
    assert.equal(typeof result.lastAccessedAt, "number");
  });

  it("updates lastAccessedAt to a recent timestamp", () => {
    const before = Date.now();
    const result = JSON.parse(buildUpdatedMetadata(undefined, 1));
    const after = Date.now();
    assert.ok(result.lastAccessedAt >= before);
    assert.ok(result.lastAccessedAt <= after);
  });

  it("returns valid JSON string", () => {
    const output = buildUpdatedMetadata(undefined, 1);
    assert.doesNotThrow(() => JSON.parse(output));
  });

  it("delta of 0 keeps count unchanged", () => {
    const existing = JSON.stringify({ accessCount: 5 });
    const result = JSON.parse(buildUpdatedMetadata(existing, 0));
    assert.equal(result.accessCount, 5);
  });
});

// ============================================================================
// computeEffectiveHalfLife
// ============================================================================

describe("computeEffectiveHalfLife", () => {
  it("returns baseHalfLife when reinforcementFactor is 0", () => {
    const result = computeEffectiveHalfLife(30, 100, Date.now(), 0, 5);
    assert.equal(result, 30);
  });

  it("returns baseHalfLife when accessCount is 0", () => {
    const result = computeEffectiveHalfLife(30, 0, Date.now(), 0.5, 5);
    assert.equal(result, 30);
  });

  it("returns baseHalfLife when accessCount is negative", () => {
    const result = computeEffectiveHalfLife(30, -5, Date.now(), 0.5, 5);
    assert.equal(result, 30);
  });

  it("extends half-life for recent accesses", () => {
    const now = Date.now();
    const result = computeEffectiveHalfLife(30, 10, now, 0.5, 5);
    assert.ok(result > 30, `Expected > 30, got ${result}`);
  });

  it("uses logarithmic scaling (diminishing returns)", () => {
    const now = Date.now();
    const r10 = computeEffectiveHalfLife(30, 10, now, 0.5, 100);
    const r100 = computeEffectiveHalfLife(30, 100, now, 0.5, 100);
    const r1000 = computeEffectiveHalfLife(30, 1000, now, 0.5, 100);

    // Each 10x increase in access count should yield less additional extension
    const delta1 = r100 - r10;
    const delta2 = r1000 - r100;
    assert.ok(delta2 < delta1 * 2, "Logarithmic scaling should show diminishing returns");
  });

  it("caps result at baseHalfLife * maxMultiplier", () => {
    const now = Date.now();
    const result = computeEffectiveHalfLife(30, 10000, now, 10, 3);
    assert.equal(result, 90); // 30 * 3 = 90
  });

  it("decays access freshness for old accesses", () => {
    const now = Date.now();
    const recentResult = computeEffectiveHalfLife(
      30, 10, now, 0.5, 10,
    );
    // 60 days ago
    const oldResult = computeEffectiveHalfLife(
      30, 10, now - 60 * 24 * 60 * 60 * 1000, 0.5, 10,
    );
    assert.ok(
      recentResult > oldResult,
      `Recent (${recentResult}) should be > old (${oldResult})`,
    );
  });

  it("access 30 days ago has roughly half the effect", () => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    // Fresh access
    const freshExtension = computeEffectiveHalfLife(30, 10, now, 0.5, 100) - 30;

    // 30-day-old access (should be approximately half freshness)
    const oldExtension = computeEffectiveHalfLife(30, 10, now - thirtyDaysMs, 0.5, 100) - 30;

    // The extension should be roughly halved (within tolerance)
    // Due to log1p, the ratio won't be exactly 0.5, but the old extension should be smaller
    assert.ok(oldExtension < freshExtension, "30-day-old access should have less extension");
    assert.ok(oldExtension > 0, "30-day-old access should still have some extension");
  });

  it("very old accesses contribute almost no extension", () => {
    const now = Date.now();
    const yearAgoMs = 365 * 24 * 60 * 60 * 1000;
    const result = computeEffectiveHalfLife(30, 10, now - yearAgoMs, 0.5, 10);
    // After 365 days with 30-day decay half-life, freshness is very low
    const extension = result - 30;
    assert.ok(extension < 1, `Year-old access extension (${extension}) should be < 1`);
  });

  it("handles maxMultiplier of 1 (no extension allowed)", () => {
    const result = computeEffectiveHalfLife(30, 100, Date.now(), 1, 1);
    assert.equal(result, 30);
  });

  it("handles baseHalfLife of 0", () => {
    const result = computeEffectiveHalfLife(0, 10, Date.now(), 0.5, 5);
    // 0 + 0 * 0.5 * log1p(x) = 0
    assert.equal(result, 0);
  });
});

// ============================================================================
// AccessTracker class
// ============================================================================

describe("AccessTracker", () => {
  /** @type {InstanceType<typeof AccessTracker>} */
  let tracker;
  let mockStore;
  let mockLogger;

  beforeEach(() => {
    mockStore = createMockStore();
    mockLogger = createMockLogger();
    tracker = new AccessTracker({
      store: mockStore,
      logger: mockLogger,
      debounceMs: 60_000, // long debounce to avoid auto-flush during tests
    });
  });

  afterEach(() => {
    tracker.destroy();
  });

  it("starts with empty pending map", () => {
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.size, 0);
  });

  it("recordAccess increments delta for a single ID", () => {
    tracker.recordAccess(["id-1"]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.get("id-1"), 1);
  });

  it("recordAccess accumulates multiple calls for same ID", () => {
    tracker.recordAccess(["id-1"]);
    tracker.recordAccess(["id-1"]);
    tracker.recordAccess(["id-1"]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.get("id-1"), 3);
  });

  it("recordAccess handles multiple IDs in one call", () => {
    tracker.recordAccess(["id-1", "id-2", "id-3"]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.get("id-1"), 1);
    assert.equal(pending.get("id-2"), 1);
    assert.equal(pending.get("id-3"), 1);
  });

  it("recordAccess handles duplicate IDs in one call", () => {
    tracker.recordAccess(["id-1", "id-1"]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.get("id-1"), 2);
  });

  it("recordAccess handles empty array", () => {
    tracker.recordAccess([]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.size, 0);
  });

  it("getPendingUpdates returns a copy (not the internal map)", () => {
    tracker.recordAccess(["id-1"]);
    const copy = tracker.getPendingUpdates();
    copy.set("id-99", 42);
    // Internal map should not be affected
    const internal = tracker.getPendingUpdates();
    assert.equal(internal.has("id-99"), false);
  });

  it("flush clears all pending updates", async () => {
    tracker.recordAccess(["id-1", "id-2"]);
    assert.equal(tracker.getPendingUpdates().size, 2);
    await tracker.flush();
    assert.equal(tracker.getPendingUpdates().size, 0);
  });

  it("destroy clears all pending updates", () => {
    tracker.recordAccess(["id-1"]);
    tracker.destroy();
    assert.equal(tracker.getPendingUpdates().size, 0);
  });

  it("can record new accesses after flush", async () => {
    tracker.recordAccess(["id-1"]);
    await tracker.flush();
    tracker.recordAccess(["id-2"]);
    const pending = tracker.getPendingUpdates();
    assert.equal(pending.has("id-1"), false);
    assert.equal(pending.get("id-2"), 1);
  });

  it("recordAccess is synchronous (no promise returned)", () => {
    const result = tracker.recordAccess(["id-1"]);
    assert.equal(result, undefined);
  });

  it("tracks independent IDs independently", () => {
    tracker.recordAccess(["a"]);
    tracker.recordAccess(["b"]);
    tracker.recordAccess(["a"]);
    tracker.recordAccess(["c"]);
    tracker.recordAccess(["b"]);
    tracker.recordAccess(["a"]);

    const pending = tracker.getPendingUpdates();
    assert.equal(pending.get("a"), 3);
    assert.equal(pending.get("b"), 2);
    assert.equal(pending.get("c"), 1);
  });

  it("debounce auto-flush fires after configured delay", async () => {
    const fastStore = createMockStore();
    const fastLogger = createMockLogger();
    const fastTracker = new AccessTracker({
      store: fastStore,
      logger: fastLogger,
      debounceMs: 50, // 50ms debounce
    });
    try {
      fastTracker.recordAccess(["id-1"]);
      assert.equal(fastTracker.getPendingUpdates().size, 1);

      // Wait for debounce to fire
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.equal(
        fastTracker.getPendingUpdates().size,
        0,
        "Pending should be empty after debounce",
      );
    } finally {
      fastTracker.destroy();
    }
  });

  it("debounce timer resets on each recordAccess", async () => {
    const fastStore = createMockStore();
    const fastLogger = createMockLogger();
    const fastTracker = new AccessTracker({
      store: fastStore,
      logger: fastLogger,
      debounceMs: 80,
    });
    try {
      fastTracker.recordAccess(["id-1"]);

      // Wait 50ms (less than debounce)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Record again — should reset the 80ms timer
      fastTracker.recordAccess(["id-2"]);

      // Wait 50ms more — total 100ms from first, but only 50ms from last
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still have pending items (timer was reset)
      assert.equal(
        fastTracker.getPendingUpdates().size,
        2,
        "Should still be pending (timer reset)",
      );

      // Wait for full debounce from last recordAccess
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(
        fastTracker.getPendingUpdates().size,
        0,
        "Should be flushed after debounce",
      );
    } finally {
      fastTracker.destroy();
    }
  });
});

// ============================================================================
// AccessTracker flush integration
// ============================================================================

describe("AccessTracker flush integration", () => {
  it("flush calls store.update with merged metadata for each pending ID", async () => {
    const id1 = "aaaaaaaa-1111-2222-3333-444444444444";
    const id2 = "bbbbbbbb-1111-2222-3333-444444444444";

    const entries = new Map([
      [id1, { id: id1, metadata: JSON.stringify({ accessCount: 2, customTag: "keep" }) }],
      [id2, { id: id2, metadata: JSON.stringify({ accessCount: 0 }) }],
    ]);

    const store = createMockStore(entries);
    const logger = createMockLogger();

    const tracker = new AccessTracker({ store, logger, debounceMs: 60_000 });
    try {
      tracker.recordAccess([id1, id1, id1]); // delta=3 for id1
      tracker.recordAccess([id2]);             // delta=1 for id2

      await tracker.flush();

      // Pending should be empty after flush
      assert.equal(tracker.getPendingUpdates().size, 0);

      // getById should be called once per entry (pure read, no delete+add)
      assert.equal(store.getByIdCalls.length, 2);

      // store.update should only have write calls (with metadata), no empty reads
      assert.equal(store.updateCalls.length, 2);

      // All update calls should have metadata (no empty {} reads)
      const writeCalls = store.updateCalls.filter((c) => c.updates.metadata);
      assert.equal(writeCalls.length, 2);

      // Verify id1 metadata merge: accessCount 2 + 3 = 5, customTag preserved
      const id1Write = writeCalls.find((c) => c.id === id1);
      assert.ok(id1Write, "Should have a write call for id1");
      const id1Meta = JSON.parse(id1Write.updates.metadata);
      assert.equal(id1Meta.accessCount, 5);
      assert.equal(id1Meta.customTag, "keep");
      assert.equal(typeof id1Meta.lastAccessedAt, "number");

      // Verify id2 metadata merge: accessCount 0 + 1 = 1
      const id2Write = writeCalls.find((c) => c.id === id2);
      assert.ok(id2Write, "Should have a write call for id2");
      const id2Meta = JSON.parse(id2Write.updates.metadata);
      assert.equal(id2Meta.accessCount, 1);
    } finally {
      tracker.destroy();
    }
  });

  it("flush skips entries not found in store (returns null)", async () => {
    const missingId = "cccccccc-1111-2222-3333-444444444444";

    // Empty store — all lookups return null
    const store = createMockStore(new Map());
    const logger = createMockLogger();

    const tracker = new AccessTracker({ store, logger, debounceMs: 60_000 });
    try {
      tracker.recordAccess([missingId]);
      await tracker.flush();

      // Should have tried getById, but no write-back via update
      assert.equal(store.getByIdCalls.length, 1);
      assert.equal(store.updateCalls.length, 0);

      // No warnings (null return is expected, not an error)
      assert.equal(logger.warnings.length, 0);
    } finally {
      tracker.destroy();
    }
  });

  it("flush logs warning on store error and continues", async () => {
    const id1 = "dddddddd-1111-2222-3333-444444444444";
    const id2 = "eeeeeeee-1111-2222-3333-444444444444";

    let getByIdCallCount = 0;
    const failingStore = {
      async getById(id) {
        getByIdCallCount++;
        if (id === id1) {
          throw new Error("simulated store failure");
        }
        // id2 succeeds
        return { id, metadata: JSON.stringify({ accessCount: 0 }) };
      },
      async update(id, updates) {
        return { id, metadata: updates.metadata || "{}" };
      },
    };

    const logger = createMockLogger();
    const tracker = new AccessTracker({ store: failingStore, logger, debounceMs: 60_000 });
    try {
      tracker.recordAccess([id1, id2]);
      await tracker.flush();

      // Should have warned about id1 failure
      assert.ok(logger.warnings.length >= 1, "Should log at least one warning");
      const warningMsg = String(logger.warnings[0][0]);
      assert.ok(
        warningMsg.includes("access-tracker"),
        `Warning should mention access-tracker, got: ${warningMsg}`,
      );

      // id2 should have been processed (getById was called for it)
      assert.equal(getByIdCallCount, 2, "getById should have been called for both IDs");
    } finally {
      tracker.destroy();
    }
  });

  it("concurrent flush: second flush awaits first then processes accumulated data", async () => {
    const id1 = "ffffffff-1111-2222-3333-444444444444";

    let resolveFirst;
    let getByIdCallCount = 0;
    const slowStore = {
      async getById(id) {
        getByIdCallCount++;
        if (getByIdCallCount === 1) {
          // First getById blocks until we resolve
          await new Promise((resolve) => { resolveFirst = resolve; });
        }
        return { id, metadata: JSON.stringify({ accessCount: 0 }) };
      },
      updateCalls: [],
      async update(id, updates) {
        this.updateCalls.push({ id, updates });
        return { id, metadata: updates.metadata || "{}" };
      },
    };

    const logger = createMockLogger();
    const tracker = new AccessTracker({ store: slowStore, logger, debounceMs: 60_000 });
    try {
      tracker.recordAccess([id1]);

      // Start first flush (will block on first store.getById)
      const flush1 = tracker.flush();

      // Record more while flush is in progress
      tracker.recordAccess([id1]);

      // Second flush should await the first, then process accumulated data
      const flush2 = tracker.flush();

      // Unblock the first flush
      resolveFirst();
      await flush1;
      await flush2;

      // Both flushes should have completed — no pending data left
      assert.equal(tracker.getPendingUpdates().size, 0, "All data should be flushed");

      // store.update should have been called twice (once per flush cycle)
      assert.equal(slowStore.updateCalls.length, 2, "Two write-back cycles should have occurred");
    } finally {
      tracker.destroy();
    }
  });

  it("flush requeues failed write-backs for retry on next flush", async () => {
    const id1 = "gggggggg-1111-2222-3333-444444444444";

    let failCount = 0;
    const flakeyStore = {
      getByIdCalls: [],
      updateCalls: [],
      async getById(id) {
        this.getByIdCalls.push({ id });
        failCount++;
        if (failCount === 1) {
          throw new Error("simulated transient failure");
        }
        return { id, metadata: JSON.stringify({ accessCount: 0 }) };
      },
      async update(id, updates) {
        this.updateCalls.push({ id, updates });
        return { id, metadata: updates.metadata || "{}" };
      },
    };

    const logger = createMockLogger();
    const tracker = new AccessTracker({ store: flakeyStore, logger, debounceMs: 60_000 });
    try {
      tracker.recordAccess([id1]); // delta=1

      // First flush — getById fails, delta should be requeued
      await tracker.flush();
      assert.equal(tracker.getPendingUpdates().size, 1, "Failed delta should be requeued");
      assert.equal(tracker.getPendingUpdates().get(id1), 1, "Requeued delta should be 1");
      assert.ok(logger.warnings.length >= 1, "Should log a warning on failure");

      // Second flush — getById succeeds this time
      await tracker.flush();
      assert.equal(tracker.getPendingUpdates().size, 0, "Requeued data should be flushed");
      assert.equal(flakeyStore.updateCalls.length, 1, "Should have one successful write-back");
    } finally {
      tracker.destroy();
    }
  });

  it("destroy warns when pending writes exist", () => {
    const store = createMockStore();
    const logger = createMockLogger();
    const tracker = new AccessTracker({ store, logger, debounceMs: 60_000 });

    tracker.recordAccess(["id-1", "id-2"]);
    assert.equal(logger.warnings.length, 0);

    tracker.destroy();

    // Should have logged a warning about pending writes
    assert.equal(logger.warnings.length, 1, "Should log one warning");
    const warningMsg = String(logger.warnings[0][0]);
    assert.ok(
      warningMsg.includes("2 pending writes"),
      `Warning should mention pending count, got: ${warningMsg}`,
    );

    // Pending should be cleared after destroy
    assert.equal(tracker.getPendingUpdates().size, 0);
  });

  it("flush is a no-op when pending map is empty", async () => {
    const store = createMockStore();
    const logger = createMockLogger();
    const tracker = new AccessTracker({ store, logger, debounceMs: 60_000 });
    try {
      await tracker.flush();
      assert.equal(store.updateCalls.length, 0);
    } finally {
      tracker.destroy();
    }
  });
});
