/**
 * Regression test for Issue #598: access-tracker.ts retry behavior
 * 
 * Tests that access-tracker:
 * 1. Does NOT amplify delta on retry (separate _retryCount map)
 * 2. Drops writes after maxRetries exceeded
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
  const mockStore = new MockStore(999); // Always fail
  const tracker = new AccessTracker({
    store: mockStore,
    logger: { warn: () => {} }
  });
  
  // Record 3 accesses for same ID
  tracker.recordAccess(["mem1", "mem1", "mem1"]);
  
  // Flush - will fail and retry
  await tracker.flush();
  await sleep(100);
  await tracker.flush();
  await tracker.flush();
  
  // Get pending updates
  const pending = tracker.getPendingUpdates();
  const delta = pending.get("mem1") ?? 0;
  
  // With old code: delta would grow (accumulating on each retry)
  // With fix: delta should be at most 1 (original delta, not accumulated)
  if (delta > 1) {
    console.error("FAIL: delta amplified: expected 1, got " + delta);
    process.exit(1);
  }
  
  console.log("PASS  retry delta not amplified: delta=" + delta);
  tracker.destroy();
  return true;
}

async function testMaxRetriesDrops() {
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
    await testMaxRetriesDrops();
    
    console.log("\n=== ALL TESTS PASSED ===");
    console.log("retry delta: OK");
    console.log("max retries: OK");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();