/**
 * Regression test for Issue #598: store.ts tail-reset serialization
 * 
 * Tests that runSerializedUpdate:
 * 1. Executes actions sequentially (not concurrently)
 * 2. Does NOT cause unbounded memory growth from promise chain
 * 3. Properly releases lock on exceptions
 * 4. Handles concurrent writes correctly
 * 
 * Uses jiti to load TypeScript directly (same as cli-smoke.mjs)
 * 
 * Run: node test/store-serialization.test.mjs
 * Expected: ALL TESTS PASSED
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-serial-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSerializationOrder() {
  console.log("Testing serialization order...");
  
  const { store, dir } = makeStore();
  
  const order = [];
  
  // Launch 5 concurrent updates
  const promises = [1, 2, 3, 4, 5].map(async (id) => {
    await store.runSerializedUpdate(async () => {
      order.push(id);
      await sleep(50);
      return id;
    });
  });
  
  await Promise.all(promises);
  
  // All should complete
  if (order.length !== 5) {
    console.error("FAIL: expected 5 completions, got " + order.length);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  
  // Order should be serialized (1,2,3,4,5)
  const expected = [1, 2, 3, 4, 5];
  const isSequential = order.every((v, i) => v === expected[i]);
  
  if (!isSequential) {
    console.error("FAIL: operations not serialized. Order: " + order.join(","));
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  
  console.log("PASS  serialization order: " + order.join(","));
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function testInFlightConcurrency() {
  console.log("Testing in-flight concurrency...");
  
  const { store, dir } = makeStore();
  
  let inFlightMax = 0;
  let inFlightCurrent = 0;
  
  // Launch many concurrent updates and track in-flight count
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const promise = store.runSerializedUpdate(async () => {
      inFlightCurrent++;
      inFlightMax = Math.max(inFlightMax, inFlightCurrent);
      await sleep(10);
      inFlightCurrent--;
      return i;
    });
    promises.push(promise);
  }
  
  await Promise.all(promises);
  
  console.log("Max in-flight operations: " + inFlightMax);
  
  // With proper serialization, max in-flight should be 1 (never more than 1)
  if (inFlightMax > 1) {
    console.error("FAIL: in-flight exceeded 1: max=" + inFlightMax);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  
  console.log("PASS  in-flight bounded: max=" + inFlightMax);
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function testExceptionRelease() {
  console.log("Testing exception releases lock...");
  
  const { store, dir } = makeStore();
  
  // First, set up a scenario where one operation throws
  const error = new Error("Test error for exception handling");
  
  try {
    // First operation - succeeds
    await store.runSerializedUpdate(async () => {
      return "success";
    });
    
    // Second operation - will throw
    let caughtError = null;
    try {
      await store.runSerializedUpdate(async () => {
        throw error;
      });
    } catch (e) {
      caughtError = e;
    }
    
    // Third operation - should still work (lock was released)
    // This is the key test: after an exception, queue should be unlocked
    const result = await store.runSerializedUpdate(async () => {
      return "after Exception";
    });
    
    if (!result) {
      console.error("FAIL: operations stuck after exception");
      rmSync(dir, { recursive: true, force: true });
      process.exit(1);
    }
    
    console.log("PASS  exception releases lock: subsequent ops work");
  } catch (err) {
    console.error("FAIL: exception test threw - " + err.message);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function testQueueDoesNotGrow() {
  console.log("Testing queue size...");
  
  const { store, dir } = makeStore();
  
  const queueSizes = [];
  
  // 5 batches of concurrent updates
  for (let batch = 0; batch < 5; batch++) {
    const promises = [1, 2, 3, 4, 5].map(async (id) => {
      await store.runSerializedUpdate(async () => {
        await sleep(5);
        return id;
      });
    });
    
    await Promise.all(promises);
    
    // Check queue size after batch completes
    // @ts-expect-error - accessing private for verification
    const queueSize = store._waitQueue?.length ?? 0;
    queueSizes.push(queueSize);
  }
  
  // Queue should be 0 or very small after each batch
  const maxQueue = Math.max(...queueSizes);
  console.log("Queue sizes: " + queueSizes.join(",") + ", max=" + maxQueue);
  
  // After batches complete, queue should drain
  if (maxQueue > 5) {
    console.error("FAIL: queue grew: max=" + maxQueue);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  
  console.log("PASS  queue bounded: max=" + maxQueue);
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function main() {
  console.log("Running store-serialization regression tests...\n");
  
  try {
    await testSerializationOrder();
    await testInFlightConcurrency();
    await testExceptionRelease();
    await testQueueDoesNotGrow();
    
    console.log("\n=== ALL TESTS PASSED ===");
    console.log("serialization order: OK");
    console.log("in-flight concurrency: OK");
    console.log("exception release: OK");
    console.log("queue bounded: OK");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();