import assert from "node:assert/strict";
import { test } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ManualRecallMetadataQueue } = jiti("../src/manual-recall-metadata-queue.ts");
const EMPTY_GOVERNANCE_SNAPSHOT = {
  badRecallCount: 0,
  suppressedUntilTurn: 0,
};

function waitFor(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

test("sustained enqueue traffic flushes by the production max-wait timer", async () => {
  let resolveFirstBatch;
  const firstBatch = new Promise((resolve) => {
    resolveFirstBatch = resolve;
  });
  const calls = [];
  const queue = new ManualRecallMetadataQueue({
    async applyManualRecallMetadataBatch(updates) {
      calls.push({ at: Date.now(), updates });
      resolveFirstBatch(calls[0]);
      return updates.map((update) => ({ id: update.id, entry: { id: update.id } }));
    },
  }, {
    debounceMs: 30,
    maxWaitMs: 80,
    warn: () => {},
  });

  const startedAt = Date.now();
  let sequence = 0;
  const interval = setInterval(() => {
    sequence += 1;
    queue.enqueue([{
      id: `memory-${sequence}`,
      expectedScope: "global",
      accessCountDelta: 1,
      accessedAt: Date.now(),
      governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
    }]);
  }, 10);

  try {
    const first = await waitFor(
      firstBatch,
      250,
      "continuous enqueue traffic should not postpone the flush indefinitely",
    );
    assert.ok(sequence >= 5, `expected sustained traffic, got ${sequence} enqueue calls`);
    assert.ok(
      first.at - startedAt < 180,
      `expected max-wait flush before 180ms, got ${first.at - startedAt}ms`,
    );
    assert.ok(first.updates.length > 0);
  } finally {
    clearInterval(interval);
    await queue.drain();
  }
});

test("fresh enqueue traffic does not bypass retry backoff", async () => {
  let resolveFirstAttempt;
  let resolveSecondAttempt;
  let releaseFirstAttempt;
  const firstAttempt = new Promise((resolve) => {
    resolveFirstAttempt = resolve;
  });
  const secondAttempt = new Promise((resolve) => {
    resolveSecondAttempt = resolve;
  });
  const firstAttemptGate = new Promise((resolve) => {
    releaseFirstAttempt = resolve;
  });
  const calls = [];
  let firstFailureAt = 0;
  const queue = new ManualRecallMetadataQueue({
    async applyManualRecallMetadataBatch(updates) {
      calls.push({ at: Date.now(), updates });
      if (calls.length === 1) {
        resolveFirstAttempt(calls[0]);
        await firstAttemptGate;
        firstFailureAt = Date.now();
        return updates.map((update) => ({
          id: update.id,
          entry: null,
          error: "simulated lock timeout",
        }));
      }
      resolveSecondAttempt(calls[1]);
      return updates.map((update) => ({ id: update.id, entry: { id: update.id } }));
    },
  }, {
    debounceMs: 10,
    maxWaitMs: 50,
    retryDelayMs: () => 80,
    warn: () => {},
  });

  queue.enqueue([{
    id: "retrying-memory",
    expectedScope: "global",
    accessCountDelta: 1,
    accessedAt: Date.now(),
    governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
  }]);
  await waitFor(firstAttempt, 200, "first production timer attempt did not run");

  queue.enqueue([{
    id: "fresh-memory",
    expectedScope: "global",
    accessCountDelta: 1,
    accessedAt: Date.now(),
    governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
  }]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseFirstAttempt();
  const second = await waitFor(secondAttempt, 250, "retry production timer did not run");

  assert.ok(
    second.at - firstFailureAt >= 60,
    `configured 80ms retry backoff was shortened to ${second.at - firstFailureAt}ms`,
  );
  assert.deepEqual(
    second.updates.map(({ id }) => id).sort(),
    ["fresh-memory", "retrying-memory"],
  );
  await queue.drain();
});
