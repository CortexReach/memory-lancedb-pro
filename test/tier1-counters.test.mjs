import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import fs from "node:fs";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  parseSmartMetadata,
  buildSmartMetadata,
} = jiti("../src/smart-metadata.ts");
const {
  computeTier1Patch,
  isSuppressed,
} = jiti("../src/auto-recall-tier1.ts");

describe("Tier 1: suppressed_until_ms field presence semantics", () => {
  it("returns undefined when raw JSON does not include the key (sentinel for 'never touched by Tier 1')", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ l0_abstract: "legacy", bad_recall_count: 5 }),
      { text: "legacy", category: "fact" },
    );
    assert.equal(meta.suppressed_until_ms, undefined);
  });

  it("clamps to non-negative integer when raw JSON includes a numeric value", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ l0_abstract: "tier1-touched", suppressed_until_ms: 1713700000000 }),
      { text: "tier1-touched", category: "fact" },
    );
    assert.equal(meta.suppressed_until_ms, 1713700000000);
  });

  it("coerces negative or NaN to 0", () => {
    const negMeta = parseSmartMetadata(
      JSON.stringify({ l0_abstract: "x", suppressed_until_ms: -100 }),
      { text: "x", category: "fact" },
    );
    assert.equal(negMeta.suppressed_until_ms, 0);

    const nanMeta = parseSmartMetadata(
      JSON.stringify({ l0_abstract: "x", suppressed_until_ms: "not-a-number" }),
      { text: "x", category: "fact" },
    );
    assert.equal(nanMeta.suppressed_until_ms, 0);
  });

  it("preserves 0 explicitly (not coerced to undefined)", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ l0_abstract: "explicit-zero", suppressed_until_ms: 0 }),
      { text: "explicit-zero", category: "fact" },
    );
    assert.equal(meta.suppressed_until_ms, 0);
  });
});

describe("Tier 1: plugin config schema", () => {
  it("openclaw.plugin.json declares autoRecallBadRecallDecayMs and autoRecallSuppressionDurationMs", () => {
    const pluginJsonPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../openclaw.plugin.json",
    );
    const raw = fs.readFileSync(pluginJsonPath, "utf8");
    const schema = JSON.parse(raw);
    // Tolerate either top-level "properties" or nested config object — search recursively.
    function findProperty(obj, key) {
      if (!obj || typeof obj !== "object") return null;
      if (obj.properties && Object.prototype.hasOwnProperty.call(obj.properties, key)) {
        return obj.properties[key];
      }
      for (const v of Object.values(obj)) {
        const found = findProperty(v, key);
        if (found) return found;
      }
      return null;
    }
    const decay = findProperty(schema, "autoRecallBadRecallDecayMs");
    const suppress = findProperty(schema, "autoRecallSuppressionDurationMs");
    assert.ok(decay, "autoRecallBadRecallDecayMs missing from schema");
    assert.ok(suppress, "autoRecallSuppressionDurationMs missing from schema");
    assert.equal(decay.default, 86400000);
    assert.equal(suppress.default, 1800000);
    assert.equal(decay.minimum, 0);
    assert.equal(suppress.minimum, 0);
  });
});

describe("Tier 1: governance filter reads suppressed_until_ms", () => {
  // Drives the production isSuppressed predicate (imported above). The same
  // function is consumed by the governance filter in index.ts, so a regression
  // in either place surfaces here.

  it("suppresses when nowMs < suppressed_until_ms", () => {
    const future = Date.now() + 60_000;
    assert.equal(isSuppressed({ suppressed_until_ms: future }, Date.now()), true);
  });

  it("does not suppress when nowMs >= suppressed_until_ms", () => {
    const past = Date.now() - 60_000;
    assert.equal(isSuppressed({ suppressed_until_ms: past }, Date.now()), false);
  });

  it("does not suppress when suppressed_until_ms is undefined (legacy memory)", () => {
    assert.equal(isSuppressed({ suppressed_until_ms: undefined }, Date.now()), false);
  });

  it("does not suppress when suppressed_until_ms is 0 (Tier 1 touched, no active suppression)", () => {
    assert.equal(isSuppressed({ suppressed_until_ms: 0 }, Date.now()), false);
  });

  it("ignores legacy suppressed_until_turn field entirely", () => {
    // A memory with only legacy turn-based suppression: Tier 1 filter does not
    // look at it. The legacy turn field is retired in the Tier 1 read path.
    const meta = { suppressed_until_turn: 9999, suppressed_until_ms: undefined };
    assert.equal(isSuppressed(meta, Date.now()), false);
  });
});

describe("Tier 1: bad_recall_count decay and patch shape (Option C)", () => {
  // Drives the production computeTier1Patch (imported above). Tests that
  // assert on suppression firing pass minRepeated explicitly; tests that only
  // care about counter shape rely on minRepeated=0 default (no suppression).

  it("T1 access_count: accumulates 0 → 1 on first injection", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      { access_count: 0, bad_recall_count: 0, injected_count: 0 },
      { injectedAt: now },
    );
    assert.equal(patch.access_count, 1);
    assert.equal(patch.last_accessed_at, now);
  });

  it("T1 access_count: 1 → 2 on repeated injection", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      { access_count: 1, bad_recall_count: 0, injected_count: 1, last_injected_at: now - 60_000 },
      { injectedAt: now },
    );
    assert.equal(patch.access_count, 2);
  });

  it("T2 decay: gap > decay window resets bad_recall before staleInjected increment", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 5,
        bad_recall_count: 2,
        injected_count: 3,
        last_injected_at: now - 25 * 3600 * 1000,  // 25h ago
        suppressed_until_ms: 0,
      },
      { injectedAt: now, badRecallDecayMs: 86_400_000 },
    );
    // gap=25h > 24h → decayedBadRecall=0, staleInjected=true → next=1
    assert.equal(patch.bad_recall_count, 1);
  });

  it("T2 no-decay: gap < decay window keeps bad_recall accumulating", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 5,
        bad_recall_count: 2,
        injected_count: 3,
        last_injected_at: now - 3600 * 1000,  // 1h ago
        suppressed_until_ms: 0,
      },
      { injectedAt: now, badRecallDecayMs: 86_400_000 },
    );
    // gap=1h < 24h → no decay, staleInjected=true → next=3
    assert.equal(patch.bad_recall_count, 3);
  });

  it("T2 first-ever injection: gap=Infinity, staleInjected=false", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      { access_count: 0, bad_recall_count: 0, injected_count: 0 },
      { injectedAt: now },
    );
    // last_injected_at undefined → staleInjected=false → next=0
    assert.equal(patch.bad_recall_count, 0);
  });

  it("T2 badRecallDecayMs=0: decay disabled", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 5,
        bad_recall_count: 2,
        injected_count: 3,
        last_injected_at: now - 100 * 24 * 3600 * 1000,  // 100 days ago
        suppressed_until_ms: 0,  // Tier-1 touched already; no lazy heal
      },
      { injectedAt: now, badRecallDecayMs: 0 },
    );
    // decay disabled → baseBadRecall=2, staleInjected=true → next=3
    assert.equal(patch.bad_recall_count, 3);
  });

  it("T3 shouldSuppress=true writes suppressed_until_ms ≈ injectedAt + duration", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 5,
        bad_recall_count: 2,
        injected_count: 3,
        last_injected_at: now - 3600 * 1000,
        suppressed_until_ms: 0,  // Tier-1 touched already; no lazy heal
      },
      { injectedAt: now, suppressionDurationMs: 1_800_000, minRepeated: 8 },
    );
    // next=3, suppress → until = now + 30min
    assert.equal(patch.bad_recall_count, 3);
    assert.equal(patch.suppressed_until_ms, now + 1_800_000);
    assert.equal(patch.suppressed_until_turn, 0);
  });

  it("T3 shouldSuppress extends existing suppression (Math.max)", () => {
    const now = Date.now();
    const farFuture = now + 7_200_000;  // 2h from now
    const patch = computeTier1Patch(
      {
        access_count: 5,
        bad_recall_count: 2,
        injected_count: 3,
        last_injected_at: now - 3600 * 1000,
        suppressed_until_ms: farFuture,
      },
      { injectedAt: now, suppressionDurationMs: 1_800_000, minRepeated: 8 },
    );
    // next=3, suppress: Math.max(farFuture, now + 30min) = farFuture
    assert.equal(patch.suppressed_until_ms, farFuture);
  });

  it("T3 always zeroes suppressed_until_turn even when not suppressing", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 1,
        bad_recall_count: 0,
        injected_count: 1,
        last_injected_at: now - 60_000,
        suppressed_until_turn: 999,
      },
      { injectedAt: now },
    );
    assert.equal(patch.suppressed_until_turn, 0);
  });

  it("T4 lazy heal: memory with legacy bad_recall_count > 0 and no suppressed_until_ms", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 0,
        bad_recall_count: 5,
        injected_count: 0,
        // no last_injected_at, no suppressed_until_ms → legacy-shaped record
      },
      { injectedAt: now },
    );
    // Lazy heal: baseBadRecall=0 (was 5). No last_injected → staleInjected=false → next=0
    assert.equal(patch.bad_recall_count, 0);
  });

  it("T4 lazy heal: memory with legacy suppressed_until_turn > 0", () => {
    const now = Date.now();
    const patch = computeTier1Patch(
      {
        access_count: 0,
        bad_recall_count: 0,
        injected_count: 1,
        suppressed_until_turn: 9999,
        // suppressed_until_ms missing
        last_injected_at: now - 60_000,
      },
      { injectedAt: now },
    );
    // Lazy heal triggers because suppressed_until_turn > 0. staleInjected=true → next=1
    assert.equal(patch.bad_recall_count, 1);
    assert.equal(patch.suppressed_until_turn, 0);
  });

  it("T4 heal fires once: after first Tier 1 touch, future patches do not re-trigger heal", () => {
    const now = Date.now();
    const tierOneTouched = {
      access_count: 1,
      bad_recall_count: 2,
      injected_count: 1,
      last_injected_at: now - 3600 * 1000,
      suppressed_until_ms: 0,  // present, means Tier 1 touched it before
    };
    const patch = computeTier1Patch(tierOneTouched, { injectedAt: now });
    // No heal (suppressed_until_ms !== undefined); Option C: gap=1h < 24h → no decay
    // staleInjected=true → next=3 (not reset)
    assert.equal(patch.bad_recall_count, 3);
  });
});
