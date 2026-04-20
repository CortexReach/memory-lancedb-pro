// test/auto-capture-bulkstore-complete-design.test.mjs
/**
 * Auto-Capture bulkStore Complete Design vs Claude
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("Auto-Capture Complete Design", () => {
  
  it("PLAN A: Current behavior (individual store)", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "plan-a-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    
    const toCapture = ["Fact A", "Fact B", "Fact C"];
    const defaultScope = "agent:test";
    let storeCallCount = 0;
    const start = Date.now();
    
    for (const text of toCapture.slice(0, 2)) {
      const category = "fact";
      const vector = new Array(4).fill(0.1).map(() => Math.random());
      const existing = await store.vectorSearch(vector, 1, 0.9, [defaultScope]);
      if (existing.length > 0 && existing[0].score > 0.90) continue;
      await store.store({ text, vector, category, scope: defaultScope, importance: 0.7, metadata: "{}" });
      storeCallCount++;
    }
    
    console.log(`[Plan A] ${storeCallCount} stores, ${Date.now() - start}ms, Lock: N`);
  });

  it("PLAN B: Collect then bulkStore", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "plan-b-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    
    const toCapture = ["Fact A", "Fact B", "Fact C"];
    const defaultScope = "agent:test";
    const start = Date.now();
    
    const entries = toCapture.slice(0, 2).map(text => ({
      text,
      vector: new Array(4).fill(0.1).map(() => Math.random()),
      category: "fact",
      scope: defaultScope,
      importance: 0.7,
      metadata: "{}",
    }));
    
    const result = await store.bulkStore(entries);
    console.log(`[Plan B] ${result.length} stores, ${Date.now() - start}ms, Lock: 1`);
    console.log(`[Plan B] WARNING: No duplicate check!`);
  });

  it("PLAN C: Dedup then bulkStore", async () => {
    const { MemoryStore } = jiti("../src/store.ts");
    const dir = mkdtempSync(join(tmpdir(), "plan-c-"));
    const store = new MemoryStore({ dbPath: dir, vectorDim: 4 });
    
    await store.store({
      text: "Existing",
      vector: [0.5, 0.5, 0.5, 0.5],
      category: "fact",
      scope: "agent:test",
      importance: 0.7,
      metadata: "{}",
    });
    
    const toCapture = ["A", "B", "Existing"];
    const defaultScope = "agent:test";
    const start = Date.now();
    
    const entries = [];
    for (const text of toCapture.slice(0, 2)) {
      const vector = [Math.random(), Math.random(), Math.random(), Math.random()];
      const existing = await store.vectorSearch(vector, 1, 0.9, [defaultScope]);
      if (existing.length > 0) {
        console.log(`[Plan C] Skipped: ${text}`);
        continue;
      }
      entries.push({ text, vector, category: "fact", scope: defaultScope, importance: 0.7, metadata: "{}" });
    }
    
    const result = await store.bulkStore(entries);
    console.log(`[Plan C] ${result.length} stores, ${Date.now() - start}ms, Lock: N+1`);
    console.log(`[Plan C] WARNING: No time saved!`);
  });

  it("CONCLUSION", async () => {
    console.log("\n=== FINAL ANALYSIS ===");
    console.log("Plan A (Current): N locks, has dedup");
    console.log("Plan B (Simple): 1 lock, NO dedup");
    console.log("Plan C (Claude): N+1 locks, has dedup");
    console.log("");
    console.log("Auto-capture uses fail-open dedup (PR comments)");
    console.log("=> Plan B is CORRECT direction");
  });
});

console.log("=== Complete Design Test ===");