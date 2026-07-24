/**
 * Transient-retry for reflection-lane persistence embeds.
 *
 * Motivating incident: a session reset ran the distiller and wrote the
 * reflection md, but a single transient embedding abort ("Failed to generate
 * embedding from Jina: Request was aborted.") in the persistence path failed
 * the whole hook, so the cycle's mapped rows never reached storage. The
 * GENERATION path already retries transient upstream failures once; the
 * persistence-path embeds now share that policy, and the abort class the
 * incident surfaced is classified transient.
 *
 * Fixtures are synthetic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  embedWithReflectionTransientRetry,
  isTransientReflectionUpstreamError,
} = jiti("../src/reflection-retry.ts");

const ABORT_ERROR = new Error("Failed to generate embedding from Jina: Request was aborted.");
const instantSleep = async () => {};

describe("abort classification", () => {
  it("classifies the incident's request-abort error as transient", () => {
    assert.equal(isTransientReflectionUpstreamError(ABORT_ERROR), true);
  });

  it("classifies AbortError-named failures as transient", () => {
    assert.equal(isTransientReflectionUpstreamError(new Error("AbortError: signal is aborted without reason")), true);
  });

  it("keeps auth failures non-transient", () => {
    assert.equal(isTransientReflectionUpstreamError(new Error("invalid api key")), false);
  });
});

describe("embedWithReflectionTransientRetry", () => {
  it("retries once on a transient abort and returns the healed vector", async () => {
    let calls = 0;
    const logs = [];
    const embed = async () => {
      calls += 1;
      if (calls === 1) throw ABORT_ERROR;
      return [0.1, 0.2, 0.3];
    };

    const vector = await embedWithReflectionTransientRetry(
      embed,
      "synthetic mapped row text",
      "mapped-row-embedding",
      (level, message) => logs.push(`${level}: ${message}`),
      instantSleep,
    );

    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(calls, 2, "exactly one retry may fire");
    assert.ok(logs.some((line) => line.includes("retrying once")), "the retry must be logged");
    assert.ok(logs.some((line) => line.includes("retry succeeded")));
  });

  it("gives up after the single retry and rethrows the last error", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw ABORT_ERROR;
    };

    await assert.rejects(
      () => embedWithReflectionTransientRetry(embed, "text", "mapped-row-embedding", undefined, instantSleep),
      /Request was aborted/,
    );
    assert.equal(calls, 2, "one attempt plus one retry, never more");
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      throw new Error("invalid api key");
    };

    await assert.rejects(
      () => embedWithReflectionTransientRetry(embed, "text", "mapped-row-embedding", undefined, instantSleep),
      /invalid api key/,
    );
    assert.equal(calls, 1, "non-transient failures must fail fast");
  });

  it("gives each call its own retry budget (one healed abort does not spend later rows' budgets)", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const flakyOnce = async () => {
      firstCalls += 1;
      if (firstCalls === 1) throw ABORT_ERROR;
      return [1];
    };
    const flakyOnceToo = async () => {
      secondCalls += 1;
      if (secondCalls === 1) throw ABORT_ERROR;
      return [2];
    };

    assert.deepEqual(await embedWithReflectionTransientRetry(flakyOnce, "row one", "mapped-row-embedding", undefined, instantSleep), [1]);
    assert.deepEqual(await embedWithReflectionTransientRetry(flakyOnceToo, "row two", "mapped-row-embedding", undefined, instantSleep), [2]);
    assert.equal(firstCalls, 2);
    assert.equal(secondCalls, 2);
  });
});
