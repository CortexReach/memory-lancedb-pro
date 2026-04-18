// test/lock-200-concurrent.test.mjs
/**
 * 200 並發測試
 */
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-200-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  return { store, dir };
}

function makeEntry(i) {
  return {
    text: `memory-${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: "{}",
  };
}

describe("200 concurrent operations", () => {
  it("should test 200 concurrent writes", async () => {
    const { store, dir } = makeStore();
    try {
      const count = 200;
      console.log(`[Starting ${count} concurrent writes...]`);
      
      const start = Date.now();
      const ops = Array.from({ length: count }, (_, i) => store.store(makeEntry(i)));
      const settled = await Promise.allSettled(ops);
      const elapsed = Date.now() - start;
      
      const successes = settled.filter(r => r.status === 'fulfilled').length;
      const failures = settled.filter(r => r.status === 'rejected').length;
      
      console.log(`[Result] ${count} concurrent writes:`);
      console.log(`  Success: ${successes} (${(successes/count*100).toFixed(1)}%)`);
      console.log(`  Failed: ${failures} (${(failures/count*100).toFixed(1)}%)`);
      console.log(`  Time: ${elapsed}ms (${(elapsed/1000).toFixed(1)}s)`);
      
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});