/**
 * Unit coverage for capUnknownWatermarkWindow -- the bounding function that
 * keeps a genuinely-unknown watermark (first-ever run, or persisted state
 * lost) from ingesting an entire history-carrying transcript in one
 * extraction call. See test/autocapture-unknown-watermark-injection.test.mjs
 * for the full hook-level behavior this unblocks.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { capUnknownWatermarkWindow } = jiti(path.resolve(testDir, "..", "src", "auto-capture-cleanup.ts"));

describe("capUnknownWatermarkWindow", () => {
  it("caps a large history down to the most recent batchSize texts", () => {
    const texts = Array.from({ length: 40 }, (_, i) => `synthetic turn ${i + 1}`);
    const result = capUnknownWatermarkWindow(texts, 2, 8000);
    assert.deepEqual(result, ["synthetic turn 39", "synthetic turn 40"]);
  });

  it("leaves a short history untouched when it already fits within batchSize", () => {
    const texts = ["alpha", "bravo"];
    const result = capUnknownWatermarkWindow(texts, 4, 8000);
    assert.deepEqual(result, ["alpha", "bravo"]);
  });

  it("trims further from the front of the window when even batchSize texts exceed maxChars", () => {
    const texts = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)];
    // batchSize=3 would include all three (9000 chars), but maxChars=5000
    // only leaves room for the last two (6000 -- still over) then just the
    // last one (3000, under budget).
    const result = capUnknownWatermarkWindow(texts, 3, 5000);
    assert.deepEqual(result, ["c".repeat(3000)]);
  });

  it("never returns an empty window, even if the single most recent text alone exceeds maxChars", () => {
    const texts = ["short one", "x".repeat(20000)];
    const result = capUnknownWatermarkWindow(texts, 2, 100);
    assert.deepEqual(result, ["x".repeat(20000)]);
  });

  it("treats a batchSize smaller than 1 as 1 (always keeps at least the latest text)", () => {
    const texts = ["alpha", "bravo", "charlie"];
    const result = capUnknownWatermarkWindow(texts, 0, 8000);
    assert.deepEqual(result, ["charlie"]);
  });
});
