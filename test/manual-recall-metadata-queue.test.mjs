import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ManualRecallMetadataQueue } = jiti("../src/manual-recall-metadata-queue.ts");
const { MemoryStore } = jiti("../src/store.ts");
const execFileAsync = promisify(execFile);
const queueModulePath = new URL("../src/manual-recall-metadata-queue.ts", import.meta.url).pathname;
const storeModulePath = new URL("../src/store.ts", import.meta.url).pathname;
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

test("fresh enqueue traffic keeps an independent retry budget", async () => {
  const calls = [];
  const warnings = [];
  const queue = new ManualRecallMetadataQueue({
    async applyManualRecallMetadataBatch(updates) {
      calls.push(updates.map(({ accessCountDelta }) => accessCountDelta));
      return updates.map((update) => ({
        id: update.id,
        entry: null,
        error: "simulated repeated failure",
      }));
    },
  }, {
    debounceMs: 60_000,
    maxRetries: 1,
    retryDelayMs: () => 60_000,
    warn: (message) => warnings.push(message),
  });

  queue.enqueue([{
    id: "same-memory",
    expectedScope: "global",
    accessCountDelta: 1,
    accessedAt: 100,
    governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
  }]);
  await queue.flush();
  assert.deepEqual(queue.getPendingUpdates().map(({ accessCountDelta }) => accessCountDelta), [1]);

  queue.enqueue([{
    id: "same-memory",
    expectedScope: "global",
    accessCountDelta: 1,
    accessedAt: 200,
    governanceSnapshot: EMPTY_GOVERNANCE_SNAPSHOT,
  }]);
  await queue.flush();

  assert.deepEqual(calls, [[1], [2]]);
  assert.deepEqual(
    queue.getPendingUpdates().map(({ accessCountDelta }) => accessCountDelta),
    [2],
    "the fresh merged delta should not be dropped on the older delta's final attempt",
  );
  assert.equal(warnings.filter((message) => /after 1 retries/.test(message)).length, 0);
  await queue.drain();
});

test("process beforeExit catches same-store work across repeated later-listener microtasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-exit-drain-"));
  const childScript = `
    import jitiFactory from "jiti";
    const jiti = jitiFactory(import.meta.url, { interopDefault: true });
    const { MemoryStore } = jiti(${JSON.stringify(storeModulePath)});
    const {
      enqueueManualRecallMetadata,
      flushManualRecallMetadataForTest,
    } = jiti(${JSON.stringify(queueModulePath)});
    const makeEntry = (text) => ({
      text,
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    });
    const store = new MemoryStore({ dbPath: process.env.TEST_DB_PATH, vectorDim: 3 });
    const first = await store.store(makeEntry("first exit-drain memory"));
    const second = await store.store(makeEntry("later exit-drain memory"));
    const third = await store.store(makeEntry("repeated exit-drain memory"));
    enqueueManualRecallMetadata(store, [{
      id: first.id,
      expectedScope: "global",
      accessCountDelta: 1,
      accessedAt: Date.now(),
      governanceSnapshot: { badRecallCount: 0, suppressedUntilTurn: 0 },
    }]);
    await flushManualRecallMetadataForTest(store);
    const laterIds = [second.id, third.id];
    let laterCycle = 0;
    process.on("beforeExit", () => {
      const id = laterIds[laterCycle++];
      if (!id) return;
      queueMicrotask(() => {
        enqueueManualRecallMetadata(store, [{
          id,
          expectedScope: "global",
          accessCountDelta: 1,
          accessedAt: Date.now(),
          governanceSnapshot: { badRecallCount: 0, suppressedUntilTurn: 0 },
        }]);
      });
    });
    process.stdout.write(first.id + "," + second.id + "," + third.id);
  `;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_DB_PATH: dir },
        timeout: 10_000,
      },
    );
    const [firstId, secondId, thirdId] = stdout.trim().split(",");
    const reopened = new MemoryStore({ dbPath: dir, vectorDim: 3 });
    try {
      const firstMetadata = JSON.parse((await reopened.getById(firstId)).metadata);
      const secondMetadata = JSON.parse((await reopened.getById(secondId)).metadata);
      const thirdMetadata = JSON.parse((await reopened.getById(thirdId)).metadata);
      assert.equal(firstMetadata.access_count, 1);
      assert.equal(secondMetadata.access_count, 1);
      assert.equal(thirdMetadata.access_count, 1);
    } finally {
      await reopened.destroy();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
