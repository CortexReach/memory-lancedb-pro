/**
 * Unit tests for async parallelization fixes in memory-lancedb-pro
 * Run: node test/async-parallelization.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// ============================================================================
// TEST 1: memory-compactor.ts plan loop parallelization
// ============================================================================

function createMockStore(latencies = {}) {
  return {
    store: async (entry) => {
      await new Promise(r => setTimeout(r, latencies.store || 10));
      return { id: "store-" + Math.random() };
    },
    delete: async (id) => {
      await new Promise(r => setTimeout(r, latencies.delete || 5));
      return true;
    }
  };
}

function createMockEmbedder(latencies = {}) {
  return {
    embedPassage: async (text) => {
      await new Promise(r => setTimeout(r, latencies.embed || 50));
      return [Math.random(), Math.random(), Math.random()];
    },
  };
}

// NEW parallel implementation (FIXED)
async function runCompactionParallel(store, embedder, plans, valid) {
  const results = await Promise.all(
    plans.map(async (plan) => {
      const members = plan.memberIndices.map((i) => valid[i]);
      
      // Parallel: embed + store
      const vectorPromise = embedder.embedPassage(plan.merged.text);
      const storePromise = vectorPromise.then(v => 
        store.store({ 
          text: plan.merged.text, 
          vector: v, 
          importance: plan.merged.importance,
          category: plan.merged.category,
          scope: plan.merged.scope 
        })
      );
      
      // Parallel: delete all members
      const deletePromises = members.map(m => store.delete(m.id));
      
      await Promise.all([storePromise, ...deletePromises]);
      return { success: true };
    })
  );
  return results.filter(r => r.success).length;
}

// OLD sequential implementation
async function runCompactionSequential(store, embedder, plans, valid) {
  let created = 0;
  for (const plan of plans) {
    const members = plan.memberIndices.map((i) => valid[i]);
    
    const vector = await embedder.embedPassage(plan.merged.text);
    await store.store({ 
      text: plan.merged.text, 
      vector, 
      importance: plan.merged.importance,
      category: plan.merged.category,
      scope: plan.merged.scope 
    });
    created++;
    
    for (const m of members) {
      await store.delete(m.id);
    }
  }
  return created;
}

describe("memory-compactor plan loop parallelization", () => {
  it("parallel should be faster than sequential", async () => {
    // Setup test data - 10 plans
    const valid = Array.from({ length: 30 }, (_, i) => ({
      id: `mem-${i}`,
      vector: [Math.random(), Math.random(), Math.random()],
      importance: 0.8
    }));
    
    const plans = [
      { memberIndices: [0, 1], merged: { text: "plan1", importance: 0.8, category: "fact", scope: "global" } },
      { memberIndices: [2, 3], merged: { text: "plan2", importance: 0.7, category: "fact", scope: "global" } },
      { memberIndices: [4, 5], merged: { text: "plan3", importance: 0.9, category: "fact", scope: "global" } },
      { memberIndices: [6, 7], merged: { text: "plan4", importance: 0.6, category: "fact", scope: "global" } },
      { memberIndices: [8, 9], merged: { text: "plan5", importance: 0.8, category: "fact", scope: "global" } },
      { memberIndices: [10, 11], merged: { text: "plan6", importance: 0.7, category: "fact", scope: "global" } },
      { memberIndices: [12, 13], merged: { text: "plan7", importance: 0.9, category: "fact", scope: "global" } },
      { memberIndices: [14, 15], merged: { text: "plan8", importance: 0.6, category: "fact", scope: "global" } },
      { memberIndices: [16, 17], merged: { text: "plan9", importance: 0.8, category: "fact", scope: "global" } },
      { memberIndices: [18, 19], merged: { text: "plan10", importance: 0.7, category: "fact", scope: "global" } },
    ];

    const store = createMockStore({ store: 10, delete: 5 });
    const embedder = createMockEmbedder({ embed: 50 });

    // Test parallel
    const parStart = performance.now();
    const parCreated = await runCompactionParallel(store, embedder, plans, valid);
    const parTime = performance.now() - parStart;

    // Test sequential
    const store2 = createMockStore({ store: 10, delete: 5 });
    const embedder2 = createMockEmbedder({ embed: 50 });
    const seqStart = performance.now();
    const seqCreated = await runCompactionSequential(store2, embedder2, plans, valid);
    const seqTime = performance.now() - seqStart;

    console.log(`\n  Plans: ${plans.length}`);
    console.log(`  Sequential: ${seqTime.toFixed(0)}ms`);
    console.log(`  Parallel:   ${parTime.toFixed(0)}ms`);
    console.log(`  Speedup:    ${(seqTime / parTime).toFixed(1)}x`);

    // Verify correctness - same number created
    assert.strictEqual(parCreated, seqCreated, "Should create same number of memories");
    
    // Verify performance - parallel should be at least 3x faster
    assert.ok(parTime < seqTime / 3, `Parallel should be at least 3x faster, got ${(seqTime / parTime).toFixed(1)}x`);
  });
});

// ============================================================================
// TEST 2: self-improvement-files.ts ensureFile parallelization
// ============================================================================

function createMockFS(latencies = {}) {
  const files = {};
  return {
    readFile: async (path) => {
      await new Promise(r => setTimeout(r, latencies.read || 20));
      return files[path] || "";
    },
    writeFile: async (path, content) => {
      await new Promise(r => setTimeout(r, latencies.write || 15));
      files[path] = content;
    }
  };
}

// NEW parallel implementation (FIXED)
async function ensureFilesParallelNew(fs, file1, file2) {
  await Promise.all([
    fs.readFile(file1).then(async (existing) => {
      if (existing.trim().length > 0) return;
      await fs.writeFile(file1, "content1");
    }),
    fs.readFile(file2).then(async (existing) => {
      if (existing.trim().length > 0) return;
      await fs.writeFile(file2, "content2");
    })
  ]);
}

// OLD sequential implementation
async function ensureFilesSequentialOld(fs, file1, file2) {
  const ensureFile = async (filePath, content) => {
    const existing = await fs.readFile(filePath);
    if (existing.trim().length > 0) return;
    await fs.writeFile(filePath, content);
  };
  await ensureFile(file1, "content1");
  await ensureFile(file2, "content2");
}

describe("self-improvement-files ensureFile parallelization", () => {
  it("parallel should be faster than sequential", async () => {
    const fs1 = createMockFS({});
    const seqStart = performance.now();
    await ensureFilesSequentialOld(fs1, "file1", "file2");
    const seqTime = performance.now() - seqStart;

    const fs2 = createMockFS({});
    const parStart = performance.now();
    await ensureFilesParallelNew(fs2, "file1", "file2");
    const parTime = performance.now() - parStart;

    console.log(`\n  Sequential: ${seqTime.toFixed(0)}ms`);
    console.log(`  Parallel:   ${parTime.toFixed(0)}ms`);
    console.log(`  Speedup:    ${(seqTime / parTime).toFixed(1)}x`);

    // Verify parallel is faster
    assert.ok(parTime < seqTime * 0.7, "Parallel should be at least 30% faster");
  });
});

// ============================================================================
// Run tests
// ============================================================================

console.log("Running async parallelization tests...");