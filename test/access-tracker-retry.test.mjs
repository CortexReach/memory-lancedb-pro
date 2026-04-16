/**
 * Regression test for Issue #598: access-tracker.ts retry behavior
 * 
 * Tests that access-tracker:
 * 1. Does NOT amplify delta on retry (separate _retryCount map)
 * 2. Drops writes after maxRetries exceeded
 * 3. Handles new writes during retry correctly
 * 
 * Precise delta verification: verifies final stored accessCount matches expected value.
 * Formula: buildUpdatedMetadata adds delta to prev.accessCount (line 132 in access-tracker.ts)
 * 
 * Run: node test/access-tracker-retry.test.mjs
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { AccessTracker, parseAccessMetadata } = jiti("../src/access-tracker.ts");

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
  
  // Record 3 accesses - delta = 3
  tracker.recordAccess(["mem1", "mem1", "mem1"]);
  
  let pending = tracker.getPendingUpdates();
  let initialDelta = pending.get("mem1") ?? 0;
  console.log("Initial delta: " + initialDelta);
  
  await tracker.flush();
  await sleep(100);
  
  pending = tracker.getPendingUpdates();
  let deltaAfterFlush1 = pending.get("mem1") ?? 0;
  console.log("Delta after 1st flush failure: " + deltaAfterFlush1);
  
  await tracker.flush();
  await sleep(100);
  
  pending = tracker.getPendingUpdates();
  let deltaAfterFlush2 = pending.get("mem1") ?? 0;
  console.log("Delta after 2nd flush failure: " + deltaAfterFlush2);
  
  // Key assertion: delta should NOT grow beyond initial
  if (deltaAfterFlush2 > initialDelta) {
    console.error("FAIL: delta grew from " + initialDelta + " to " + deltaAfterFlush2 + " - delta amplified!");
    process.exit(1);
  }
  
  console.log("PASS  retry delta not amplified: initial=" + initialDelta + ", after=" + deltaAfterFlush2);
  tracker.destroy();
  return true;
}

async function testRetryWithNewWrites_PreciseCount() {
  console.log("Testing new writes during retry with PRECISE metadata count...");
  
  // MockStore that fails twice then succeeds
  const mockStore = new MockStore(2);
  const tracker = new AccessTracker({
    store: mockStore,
    logger: { warn: () => {}, error: () => {} }
  });
  
  // Pre-seed the memory so getById returns data (not null)
  // This is required: access-tracker drops writes when memory doesn't exist yet
  mockStore.data.set("memA", { metadata: JSON.stringify({ accessCount: 0, lastAccessedAt: 0 }) });
  
  // Step 1: Record 1 access
  tracker.recordAccess(["memA"]);
  
  // Step 2: First flush fails (failUntil=2, first failure)
  await tracker.flush();
  await sleep(50);
  
  // Step 3: Second flush fails (second failure)
  await tracker.flush();
  await sleep(50);
  
  // Step 4: While in retry state, record 2 more accesses
  tracker.recordAccess(["memA", "memA"]);
  
  // Step 5: Third flush succeeds (failUntil exhausted)
  await tracker.flush();
  await sleep(50);
  
  // Step 6: Fourth flush (no new writes, verify stable)
  await tracker.flush();
  
  // Key verification: Check final stored metadata accessCount
  // Formula: newCount = prev.accessCount + accessDelta (access-tracker.ts:132)
  // Initial: accessCount = 0
  // Step 1: delta=1, accessCount = 0 + 1 = 1
  // Step 4: delta=2, accessCount = 1 + 2 = 3
  const stored = mockStore.data.get("memA");
  if (!stored) {
    console.error("FAIL: no data stored for memA");
    process.exit(1);
  }
  
  const metadata = typeof stored.metadata === "string" ? JSON.parse(stored.metadata) : stored.metadata;
  const parsed = parseAccessMetadata(JSON.stringify(metadata));
  const finalCount = parsed.accessCount;
  
  console.log("Final stored accessCount: " + finalCount);
  
  // Expected: 1 + 2 = 3
  if (finalCount !== 3) {
    console.error("FAIL: expected accessCount=3, got " + finalCount);
    process.exit(1);
  }
  
  console.log("PASS  precise metadata count verified: accessCount=3");
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
    await testRetryWithNewWrites_PreciseCount();
    await testMaxRetriesDrops();
    
    console.log("\n=== ALL TESTS PASSED ===");
    console.log("retry delta not amplify: OK");
    console.log("precise metadata count: OK");
    console.log("max retries drops: OK");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();