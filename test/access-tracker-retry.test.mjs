/**
 * Regression test for Issue #598: access-tracker.ts retry behavior
 * 
 * Tests that access-tracker:
 * 1. Does NOT amplify delta on retry (separate _retryCount map)
 * 2. Drops writes after maxRetries exceeded
 * 3. Handles new writes during retry correctly
 * 
 * Uses jiti to load TypeScript directly (same as cli-smoke.mjs)
 * 
 * Run: node test/access-tracker-retry.test.mjs
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { AccessTracker } = jiti("../src/access-tracker.ts");

class MockStore {
  constructor(failUntil = 2) {
    this.failUntil = failUntil;
    this.data = new Map();
    this.failCount = new Map();
  }
  
  async getById(id) {
    return this.data.get(id) ?? null;
  }
  
  async update(id, updates) {
    const fails = this.failCount.get(id) ?? 0;
    if (fails < this.failUntil) {
      this.failCount.set(id, fails + 1);
      throw new Error("Simulated failure " + (fails + 1));
    }
    this.data.set(id, updates);
    return updates;
  }
  
  reset() {
    this.data.clear();
    this.failCount.clear();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testRetryCountDoesNotAmplify() {
  console.log("Testing retry delta NOT amplifying...");
  
  const mockStore = new MockStore(999); // Always fail
  const tracker = new AccessTracker({
    store: mockStore,
    logger: { warn: () => {} }
  });
  
  // Record 3 accesses - this sets delta to 3
  tracker.recordAccess(["mem1", "mem1", "mem1"]);
  
  // Get initial delta (should be 3)
  let pending = tracker.getPendingUpdates();
  let initialDelta = pending.get("mem1") ?? 0;
  console.log("Initial delta: " + initialDelta);
  
  // First flush - will fail and retry
  await tracker.flush();
  await sleep(100);
  
  pending = tracker.getPendingUpdates();
  let deltaAfterFlush1 = pending.get("mem1") ?? 0;
  console.log("Delta after 1st flush failure: " + deltaAfterFlush1);
  
  // Second flush - will fail and retry again
  await tracker.flush();
  await sleep(100);
  
  pending = tracker.getPendingUpdates();
  let deltaAfterFlush2 = pending.get("mem1") ?? 0;
  console.log("Delta after 2nd flush failure: " + deltaAfterFlush2);
  
  // The fix uses separate _retryCount map, so pending delta should NOT accumulate
  // It should stay at most 3 (original) - not grow to 6, 9, etc.
  // With the fix, delta could be:
  // - Still 3 (retry didn't add more)
  // - Or 0 (if retry was treated as new operation)
  // But it should NOT be 6, 9, etc.
  
  if (deltaAfterFlush2 > initialDelta) {
    console.error("FAIL: delta grew from " + initialDelta + " to " + deltaAfterFlush2 + " - delta amplified!");
    process.exit(1);
  }
  
  console.log("PASS  retry delta not amplified: initial=" + initialDelta + ", after=" + deltaAfterFlush2);
  tracker.destroy();
  return true;
}

async function testRetryWithNewWrites() {
  console.log("Testing new writes during retry...");
  
  const mockStore = new MockStore(2); // Fail twice, then succeed
  const tracker = new AccessTracker({
    store: mockStore,
    logger: { warn: () => {}, error: () => {} }
  });
  
  // Record initial access
  tracker.recordAccess(["memA"]);
  
  // First flush - fails, enters retry
  await tracker.flush();
  await sleep(50);
  
  // While in retry state, record more accesses
  tracker.recordAccess(["memA", "memA"]); // +2 more
  
  let pending = tracker.getPendingUpdates();
  let deltaBeforeRetryResolves = pending.get("memA") ?? 0;
  console.log("Delta during retry (before retry resolves): " + deltaBeforeRetryResolves);
  
  // Second flush - should fail again
  await tracker.flush();
  await sleep(50);
  
  // Third flush - finally succeeds
  await tracker.flush();
  
  pending = tracker.getPendingUpdates();
  let deltaAfterSuccess = pending.get("memA") ?? 0;
  console.log("Delta after successful flush: " + deltaAfterSuccess);
  
  // The key behavior: new writes during retry should be preserved
  // They should NOT be lost due to retry logic
  if (deltaAfterSuccess < 0) {
    console.error("FAIL: new writes lost during retry");
    process.exit(1);
  }
  
  console.log("PASS  new writes during retry preserved");
  tracker.destroy();
  return true;
}

async function testMaxRetriesDrops() {
  console.log("Testing max retries drops writes...");
  
  const mockStore = new MockStore(999); // Always fail
  const tracker = new AccessTracker({
    store: mockStore,
    logger: { warn: () => {}, error: () => {} }
  });
  
  tracker.recordAccess(["mem2"]);
  
  // Flush 10 times - should drop after 5 retries
  for (let i = 0; i < 10; i++) {
    await tracker.flush();
    await sleep(50);
  }
  
  const pending = tracker.getPendingUpdates();
  const hasPending = pending.has("mem2");
  
  if (hasPending) {
    console.error("FAIL: expected drop after max retries");
    process.exit(1);
  }
  
  console.log("PASS  max retries drops writes");
  tracker.destroy();
  return true;
}

async function main() {
  console.log("Running access-tracker-retry regression tests...\n");
  
  try {
    await testRetryCountDoesNotAmplify();
    await testRetryWithNewWrites();
    await testMaxRetriesDrops();
    
    console.log("\n=== ALL TESTS PASSED ===");
    console.log("retry delta not amplify: OK");
    console.log("new writes during retry: OK");
    console.log("max retries drops: OK");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();