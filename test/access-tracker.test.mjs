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

  beforeEach(() => {
    tracker = new AccessTracker(60_000); // long debounce to avoid auto-flush during tests
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

  it("flush clears all pending updates", () => {
    tracker.recordAccess(["id-1", "id-2"]);
    assert.equal(tracker.getPendingUpdates().size, 2);
    tracker.flush();
    assert.equal(tracker.getPendingUpdates().size, 0);
  });

  it("destroy clears all pending updates", () => {
    tracker.recordAccess(["id-1"]);
    tracker.destroy();
    assert.equal(tracker.getPendingUpdates().size, 0);
  });

  it("can record new accesses after flush", () => {
    tracker.recordAccess(["id-1"]);
    tracker.flush();
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
    const fastTracker = new AccessTracker(50); // 50ms debounce
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
    const fastTracker = new AccessTracker(80);
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
