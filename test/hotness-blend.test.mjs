import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHotnessScore } from "../src/access-tracker.js";

describe("computeHotnessScore", () => {
  it("returns 0 for zero accesses", () => {
    assert.equal(computeHotnessScore(0, Date.now()), 0);
  });

  it("returns positive score for accessed memories", () => {
    const score = computeHotnessScore(5, Date.now());
    assert.ok(score > 0);
    assert.ok(score <= 1);
  });

  it("higher access count yields higher score", () => {
    const now = Date.now();
    const low = computeHotnessScore(1, now);
    const mid = computeHotnessScore(5, now);
    const high = computeHotnessScore(50, now);
    assert.ok(low < mid, `low(${low}) should be < mid(${mid})`);
    assert.ok(mid < high, `mid(${mid}) should be < high(${high})`);
  });

  it("recent access yields higher score than old access", () => {
    const now = Date.now();
    const recent = computeHotnessScore(5, now);
    const weekAgo = computeHotnessScore(5, now - 7 * 86_400_000);
    const monthAgo = computeHotnessScore(5, now - 30 * 86_400_000);
    assert.ok(recent > weekAgo, `recent(${recent}) > weekAgo(${weekAgo})`);
    assert.ok(weekAgo > monthAgo, `weekAgo(${weekAgo}) > monthAgo(${monthAgo})`);
  });

  it("decays to near-zero for very old accesses", () => {
    const score = computeHotnessScore(5, Date.now() - 365 * 86_400_000);
    assert.ok(score < 0.01, `score(${score}) should be near zero for year-old access`);
  });

  it("caps at 1.0 even with extreme access counts", () => {
    const score = computeHotnessScore(10_000, Date.now());
    assert.ok(score <= 1.0);
  });

  it("respects custom decay rate", () => {
    const now = Date.now();
    const fast = computeHotnessScore(5, now - 7 * 86_400_000, 0.5); // fast decay
    const slow = computeHotnessScore(5, now - 7 * 86_400_000, 0.01); // slow decay
    assert.ok(slow > fast, `slow decay(${slow}) > fast decay(${fast})`);
  });
});
