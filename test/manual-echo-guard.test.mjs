/**
 * Manual-store echo guard: deterministic pre-judge drop of extraction
 * candidates that near-duplicate a recent manual memory_store/memory_update
 * text.
 *
 * Mechanism (design ruling 2026-07-21): when the user dictates a memory
 * ("remember this: ..."), the same sentence flows through BOTH the manual
 * store lane and auto-capture extraction, minting near-twin rows the dedup
 * layer cannot reliably collide (fresh-row vector visibility, category
 * splits). The guard keeps an in-memory per-agent ring of recent manual
 * texts and drops near-identical extraction candidates BEFORE the admission
 * judge — string-only comparison, no LLM, no vector search.
 *
 * Match test: normalized containment (either direction, min token guard) or
 * token-set Jaccard >= 0.75 on the candidate content.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  ManualEchoLedger,
  isNearIdenticalEcho,
  normalizeEchoText,
  MANUAL_ECHO_JACCARD_THRESHOLD,
  MANUAL_ECHO_RING_SIZE,
} = jiti("../src/manual-echo-guard.ts");

describe("normalizeEchoText", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    assert.equal(
      normalizeEchoText("  Favorite Teacup:   the RED one!  "),
      "favorite teacup the red one",
    );
  });

  it("keeps unicode letters and digits", () => {
    assert.equal(normalizeEchoText("Çay saati 15:30'da"), "çay saati 15 30 da");
  });
});

describe("isNearIdenticalEcho", () => {
  const manual = "the office plant needs watering every friday";

  it("matches exact text", () => {
    assert.equal(isNearIdenticalEcho(manual, manual), true);
  });

  it("matches when the candidate contains the manual text", () => {
    assert.equal(
      isNearIdenticalEcho(
        `User stated that the office plant needs watering every Friday.`,
        manual,
      ),
      true,
    );
  });

  it("matches when the manual text contains the candidate", () => {
    assert.equal(
      isNearIdenticalEcho("office plant needs watering", manual),
      true,
    );
  });

  it("matches high token overlap above the Jaccard threshold", () => {
    assert.equal(
      isNearIdenticalEcho(
        "office plant needs deep watering every friday morning",
        "the office plant needs watering every friday morning",
      ),
      true,
    );
  });

  it("matches the sentence-wrapped echo shape via token-subset containment", () => {
    assert.equal(
      isNearIdenticalEcho(
        "User's favorite teacup is the red one",
        "favorite teacup: the red one",
      ),
      true,
    );
  });

  it("rejects unrelated candidates", () => {
    assert.equal(
      isNearIdenticalEcho("user's dog is named Biscuit", manual),
      false,
    );
  });

  it("rejects low-overlap candidates sharing a few tokens", () => {
    assert.equal(
      isNearIdenticalEcho(
        "user waters the garden on weekends with a hose",
        manual,
      ),
      false,
    );
  });

  it("requires exact match for very short manual texts", () => {
    assert.equal(isNearIdenticalEcho("blue mug", "blue mug"), true);
    assert.equal(
      isNearIdenticalEcho("user owns a blue mug from portugal", "blue mug"),
      false,
    );
  });

  it("exposes the documented threshold", () => {
    assert.equal(MANUAL_ECHO_JACCARD_THRESHOLD, 0.75);
  });
});

describe("ManualEchoLedger", () => {
  it("records and matches per agent", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    assert.ok(
      ledger.match("agent-one", "User's favorite teacup is the red one"),
    );
    assert.equal(
      ledger.match("agent-two", "User's favorite teacup is the red one"),
      null,
    );
  });

  it("returns null when nothing recorded", () => {
    const ledger = new ManualEchoLedger();
    assert.equal(ledger.match("agent-one", "anything at all"), null);
  });

  it("buckets undefined agent ids together", () => {
    const ledger = new ManualEchoLedger();
    ledger.record(undefined, "standing desk height is 104cm");
    assert.ok(ledger.match(undefined, "the standing desk height is 104cm"));
  });

  it("caps the ring and evicts the oldest entry", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "the very first manual fact about topic zero");
    for (let i = 1; i <= MANUAL_ECHO_RING_SIZE; i++) {
      ledger.record("agent-one", `distinct manual fact number ${i} about topic ${i}`);
    }
    assert.equal(
      ledger.match("agent-one", "the very first manual fact about topic zero"),
      null,
    );
    assert.ok(
      ledger.match("agent-one", `distinct manual fact number ${MANUAL_ECHO_RING_SIZE} about topic ${MANUAL_ECHO_RING_SIZE}`),
    );
  });

  it("ignores empty and whitespace-only records", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "   ");
    assert.equal(ledger.match("agent-one", "   "), null);
  });

  it("clear() empties one agent's ring only", () => {
    const ledger = new ManualEchoLedger();
    ledger.record("agent-one", "favorite teacup: the red one");
    ledger.record("agent-two", "favorite teacup: the red one");
    ledger.clear("agent-one");
    assert.equal(ledger.match("agent-one", "favorite teacup: the red one"), null);
    assert.ok(ledger.match("agent-two", "favorite teacup: the red one"));
  });
});
