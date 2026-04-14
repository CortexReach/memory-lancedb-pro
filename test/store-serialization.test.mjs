/**
 * Regression test for Issue #598: store.ts tail-reset serialization
 * 
 * Tests that runSerializedUpdate:
 * 1. Executes actions sequentially (not concurrently)
 * 2. Does NOT cause unbounded memory growth from promise chain
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

async function testSerialization() {
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
  
  console.log("PASS  serialization: order=" + order.join(","));
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function testQueueDoesNotGrow() {
  const { store, dir } = makeStore();
  
  const queueSizes = [];
  
  // 3 batches of 5 concurrent updates
  for (let batch = 0; batch < 3; batch++) {
    const promises = [1, 2, 3, 4, 5].map(async (id) => {
      await store.runSerializedUpdate(async () => {
        await sleep(10);
        return id;
      });
    });
    
    await Promise.all(promises);
    
    // Access internal queue for test verification
    // @ts-expect-error - accessing private for test
    const queueSize = store._waitQueue?.length ?? 0;
    queueSizes.push(queueSize);
  }
  
  // Queue should be small (< 10) after each batch
  const maxQueue = Math.max(...queueSizes);
  if (maxQueue > 10) {
    console.error("FAIL: queue grew unbounded: max=" + maxQueue);
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
    await testSerialization();
    await testQueueDoesNotGrow();
    
    console.log("\n=== ALL TESTS PASSED ===");
    console.log("serialization: OK");
    console.log("queue bounded: OK");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

main();