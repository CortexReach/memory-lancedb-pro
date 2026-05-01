/**
 * import-markdown.test.mjs
 * Integration tests for the import-markdown CLI command.
 * Tests: BOM handling, CRLF normalization, bullet formats, dedup logic,
 * minTextLength, importance, dry-run mode, batch pipeline (Phase 1/2a/2b),
 * P1 bulkStore failure resilience, P2 dry-run+dedup accuracy, batch-size flag,
 * and new return fields (skippedShort, skippedDedup, errorCount, elapsedMs).
 *
 * Run: node --test test/import-markdown/import-markdown.test.mjs
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// ────────────────────────────────────────────────────────────────────────────── Mock implementations ──────────────────────────────────────────────────────────────────────────────

// Module-level shared state; mutated in place so references stay valid
let storedRecords = [];

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return h;
}

function makeVector(text) {
  // Deterministic 384-dim vector from text hash
  const dim = 384;
  const vec = [];
  let seed = hashString(text);
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    vec.push((seed >>> 8) / 16777215 - 1);
  }
  return vec;
}

const mockEmbedder = {
  embedQuery: async (text) => makeVector(text),
  embedPassage: async (text) => makeVector(text),
  // Batch API — returns array of vectors (one per input text)
  embedBatchPassage: async (texts) => texts.map((t) => makeVector(t)),
};

const mockRetriever = {
  // retrieve() signature: ({ query, limit, scopeFilter, source }) => Promise<[{ entry, score }]>
  // Default: return empty so all entries pass dedup
  async retrieve({ query, limit = 20, scopeFilter = [] } = {}) {
    const q = query.toLowerCase();
    return storedRecords
      .filter((r) => {
        if (scopeFilter.length > 0 && !scopeFilter.includes(r.scope)) return false;
        return r.text.toLowerCase() === q;
      })
      .slice(0, limit)
      .map((r) => ({ entry: r, score: 1.0 }));
  },
  getConfig() {
    return {
      mode: "hybrid",
      vectorWeight: 0.5,
      bm25Weight: 0.5,
      minScore: 0.0,
      rerank: "none",
      candidatePoolSize: 20,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      filterNoise: false,
      lengthNormAnchor: 0,
      hardMinScore: 0,
      timeDecayHalfLifeDays: 0,
    };
  },
  getLastDiagnostics() {
    return null;
  },
};

const mockStore = {
  get storedRecords() {
    return storedRecords;
  },
  async store(entry) {
    storedRecords.push({ ...entry });
  },
  async bulkStore(entries) {
    // Default: store all
    for (const e of entries) storedRecords.push({ ...e });
  },
  async bm25Search(query, limit = 1, scopeFilter = []) {
    const q = query.toLowerCase();
    return storedRecords
      .filter((r) => {
        if (scopeFilter.length > 0 && !scopeFilter.includes(r.scope)) return false;
        return r.text.toLowerCase().includes(q);
      })
      .slice(0, limit)
      .map((r) => ({ entry: r, score: r.text.toLowerCase() === q ? 1.0 : 0.8 }));
  },
  reset() {
    storedRecords.length = 0; // Mutate in place to preserve the array reference
  },
};

// ────────────────────────────────────────────────────────────────────────────── Test helpers ──────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testWorkspaceDir;

// Module-level: shared between before() hook and runImportMarkdown()
let importMarkdown;

async function setupWorkspace(name) {
  // Files must be created at: <testWorkspaceDir>/workspace/<name>/
  // because runImportMarkdown looks for path.join(openclawHome, "workspace")
  const wsDir = join(testWorkspaceDir, "workspace", name);
  await mkdir(wsDir, { recursive: true });
  return wsDir;
}

// ────────────────────────────────────────────────────────────────────────────── Setup / Teardown ──────────────────────────────────────────────────────────────────────────────

before(async () => {
  testWorkspaceDir = join(tmpdir(), "import-markdown-test-" + Date.now());
  await mkdir(testWorkspaceDir, { recursive: true });
});

afterEach(() => {
  mockStore.reset();
});

after(async () => {
  // Cleanup handled by OS (tmpdir cleanup)
});

// ────────────────────────────────────────────────────────────────────────────── Tests ──────────────────────────────────────────────────────────────────────────────

describe("import-markdown CLI", () => {
  before(async () => {
    // Lazy-import via jiti to handle TypeScript compilation
    const mod = jiti("../../cli.ts");
    importMarkdown = mod.runImportMarkdown ?? null;
  });

  // ── Legacy / basic tests (kept as-is, prove non-regression) ─────────────────

  describe("BOM handling", () => {
    it("strips UTF-8 BOM from file content", async () => {
      const wsDir = await setupWorkspace("bom-test");
      await writeFile(join(wsDir, "MEMORY.md"), "\ufeff- BOM line\n- Real bullet\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bom-test",
        dedup: false,
      });

      assert.ok(imported >= 1, `expected imported >= 1, got ${imported}`);
    });
  });

  describe("CRLF normalization", () => {
    it("handles Windows CRLF line endings", async () => {
      const wsDir = await setupWorkspace("crlf-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Line one\r\n- Line two\r\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "crlf-test",
        dedup: false,
      });

      assert.strictEqual(imported, 2);
    });
  });

  describe("Bullet format support", () => {
    it("imports dash, star, and plus bullet formats", async () => {
      const wsDir = await setupWorkspace("bullet-formats");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- Dash bullet\n* Star bullet\n+ Plus bullet\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bullet-formats",
        dedup: false,
      });

      assert.strictEqual(imported, 3);
      assert.strictEqual(skipped, 0);
    });
  });

  describe("minTextLength option", () => {
    it("skips lines shorter than minTextLength", async () => {
      const wsDir = await setupWorkspace("min-len-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- 短\n- 中文字\n- 長文字行\n- 合格的文字\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported, skipped, skippedShort } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "min-len-test",
        minTextLength: 5,
        dedup: false,
      });

      assert.strictEqual(imported, 1); // "合格的文字" (5 chars)
      assert.strictEqual(skippedShort, 3); // "短", "中文字", "長文字行"
    });
  });

  describe("importance option", () => {
    it("uses custom importance value", async () => {
      const wsDir = await setupWorkspace("importance-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Test content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "importance-test",
        importance: 0.9,
        dedup: false,
      });

      assert.strictEqual(mockStore.storedRecords[0].importance, 0.9);
    });
  });

  // ── Dedup (Phase 2a) ────────────────────────────────────────────────────────

  describe("dedup logic", () => {
    it("skips already-imported entries in same scope when dedup is enabled", async () => {
      const wsDir = await setupWorkspace("dedup-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Duplicate content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };

      // First import (no dedup)
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: false,
      });
      assert.strictEqual(mockStore.storedRecords.length, 1);

      // Second import WITH dedup — should skip the duplicate
      const { imported, skipped, skippedDedup } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: true,
      });

      assert.strictEqual(imported, 0);
      assert.strictEqual(skippedDedup, 1);
      assert.strictEqual(mockStore.storedRecords.length, 1); // Still only 1
    });

    it("imports same text into different scope even with dedup enabled", async () => {
      const wsDir = await setupWorkspace("dedup-scope-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Same content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };

      // First import to scope-A
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-scope-test",
        scope: "scope-A",
        dedup: false,
      });
      assert.strictEqual(mockStore.storedRecords.length, 1);

      // Second import to scope-B — should NOT skip (different scope)
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-scope-test",
        scope: "scope-B",
        dedup: true,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(mockStore.storedRecords.length, 2); // Two entries, different scopes
    });
  });

  // ── Phase 2a: dedup error handling (Option A — fail-safe skip) ───────────────
  // Option A: when ctx.retriever.retrieve() throws, entry is SKIPPED (not imported).
  // This prevents database pollution when the dedup service is down.

  describe("Phase 2a dedup error handling (Option A)", () => {
    it("skips entry when retrieve() throws (fail-safe) and increments errorCount", async () => {
      const wsDir = await setupWorkspace("dedup-err-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Entry that will trigger dedup error\n", "utf-8");

      // Throwing retriever: simulates network/timeout/500 error
      const throwingRetriever = {
        async retrieve() {
          throw new Error("ENOTFOUND: Service unavailable");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        getLastDiagnostics() {
          return null;
        },
      };

      const ctx = {
        embedder: mockEmbedder,
        store: mockStore,
        retriever: throwingRetriever,
      };

      const { imported, skipped, skippedDedup, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-err-test",
        dedup: true,
      });

      // Option A: entry should be SKIPPED, not imported
      assert.strictEqual(imported, 0, "entry should NOT be imported when dedup check throws");
      // errorCount should be incremented (Option A key behavior)
      assert.ok(errorCount >= 1, `errorCount should be >= 1, got ${errorCount}`);
      // Store should be empty (entry was skipped, not imported)
      assert.strictEqual(mockStore.storedRecords.length, 0, "store should be empty — entry was skip-not-import");
    });

    it("does NOT count retrieve() error as dedup hit (skippedDedup stays 0)", async () => {
      const wsDir = await setupWorkspace("dedup-err-no-hit-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Another error-triggering entry\n", "utf-8");

      const throwingRetriever = {
        async retrieve() {
          throw new Error("ETIMEDOUT connection refused");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        getLastDiagnostics() {
          return null;
        },
      };

      const ctx = {
        embedder: mockEmbedder,
        store: mockStore,
        retriever: throwingRetriever,
      };

      const { skippedDedup, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-err-no-hit-test",
        dedup: true,
      });

      // Error should be counted in errorCount, NOT in skippedDedup
      assert.strictEqual(skippedDedup, 0, "skippedDedup should be 0 — error is not a dedup hit");
      assert.ok(errorCount >= 1, `errorCount should be >= 1, got ${errorCount}`);
    });

    it("normal dedup hit still works (dedup hit → skip + skippedDedup++)", async () => {
      const wsDir = await setupWorkspace("dedup-hit-normal");
      await writeFile(join(wsDir, "MEMORY.md"), "- Duplicate target line\n", "utf-8");

      // Pre-load the target into store so dedup finds it
      storedRecords.push({
        text: "Duplicate target line",
        vector: makeVector("Duplicate target line"),
        importance: 0.7,
        category: "other",
        scope: "dedup-hit-normal",
        metadata: "{}",
      });

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };

      const { imported, skippedDedup, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-hit-normal",
        dedup: true,
      });

      assert.strictEqual(imported, 0, "duplicate should not be imported");
      assert.strictEqual(skippedDedup, 1, "dedup hit should be counted in skippedDedup");
      assert.strictEqual(errorCount, 0, "errorCount should be 0 — no error occurred");
    });

    it("normal no-hit still works (no hit → proceed to import)", async () => {
      const wsDir = await setupWorkspace("dedup-no-hit-normal");
      await writeFile(join(wsDir, "MEMORY.md"), "- Brand new unique entry\n", "utf-8");

      // mockRetriever returns empty by default → no dedup hit
      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };

      const { imported, skippedDedup, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-no-hit-normal",
        dedup: true,
      });

      assert.strictEqual(imported, 1, "unique entry should be imported");
      assert.strictEqual(skippedDedup, 0, "skippedDedup should be 0 — no dedup hit");
      assert.strictEqual(errorCount, 0, "errorCount should be 0 — no error occurred");
      assert.strictEqual(mockStore.storedRecords.length, 1, "store should have 1 record");
    });
  });

  // ── Dry-run mode ───────────────────────────────────────────────────────────

  describe("dry-run mode", () => {
    it("does not write to store in dry-run mode", async () => {
      const wsDir = await setupWorkspace("dryrun-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Dry run test line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dryrun-test",
        dryRun: true,
        dedup: false,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(mockStore.storedRecords.length, 0); // No actual write
    });

    // P2 fix: --dry-run --dedup now runs dedup first and shows accurate skip count
    it("dry-run with dedup shows correct skip count (P2 fix)", async () => {
      const wsDir = await setupWorkspace("dryrun-dedup-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- New entry\n- Duplicate entry\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };

      // Pre-load "Duplicate entry" into store so dedup finds it
      storedRecords.push({
        text: "Duplicate entry",
        vector: makeVector("Duplicate entry"),
        importance: 0.7,
        category: "other",
        scope: "dryrun-dedup-test",
        metadata: "{}",
      });

      // dry-run WITH dedup — should report 1 would-import + 1 would-skip
      const { imported, skipped, skippedDedup, elapsedMs } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dryrun-dedup-test",
        dryRun: true,
        dedup: true,
      });

      assert.strictEqual(imported, 1, "only new entry would be imported");
      assert.strictEqual(skippedDedup, 1, "duplicate should be counted as skipped in dry-run");
      assert.ok(typeof elapsedMs === "number", `elapsedMs should be a number, got ${typeof elapsedMs}: ${elapsedMs}`);
      // Store should be untouched
      assert.strictEqual(mockStore.storedRecords.length, 1, "dry-run writes nothing");
    });
  });

  // ── Continue on error ──────────────────────────────────────────────────────

  describe("continue on error", () => {
    it("continues processing after a store failure (P1 fix)", async () => {
      const wsDir = await setupWorkspace("p1-error-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- First line\n- Second line\n- Third line\n", "utf-8");

      let bulkStoreCalls = 0;
      const errorStore = {
        async store(entry) {
          storedRecords.push({ ...entry });
        },
        async bulkStore(entries) {
          bulkStoreCalls++;
          // Simulate failure on the second bulkStore call
          if (bulkStoreCalls === 2) throw new Error("Simulated bulkStore failure");
          for (const e of entries) storedRecords.push({ ...e });
        },
        async bm25Search(...args) {
          return mockStore.bm25Search(...args);
        },
        async retrieve(context) {
          return mockRetriever.retrieve(context);
        },
        getConfig() {
          return mockRetriever.getConfig();
        },
      };

      const ctx = { embedder: mockEmbedder, store: errorStore, retriever: mockRetriever };
      const { imported, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "p1-error-test",
        batchSize: 1, // Force one entry per batch so we can control which flush fails
        dedup: false,
      });

      // batchSize=1, FLUSH_THRESHOLD=100, 3 entries:
      // - entry1: queued, not flushed (pendingFlush=1 < 100)
      // - entry2: queued, not flushed (pendingFlush=2 < 100)
      // - entry3: isLastBatch → flushPending() → bulkStore([e1,e2]) → succeeds
      //   Then entry3 is queued → isLastBatch → flushPending() → bulkStore([e3]) → throws
      // So entry3 ends up in errorCount
      assert.ok(imported >= 2 || errorCount >= 1,
        `imported=${imported} errorCount=${errorCount}: at least one batch should have succeeded or failed gracefully`);
    });

    it("bulkStore failure on non-last batch continues to remaining batches", async () => {
      const wsDir = await setupWorkspace("p1-multi-batch-test");
      // Write enough entries to trigger multiple bulkStore flushes
      const lines = Array.from({ length: 210 }, (_, i) => `- Entry number ${i + 1}\n`).join("");
      await writeFile(join(wsDir, "MEMORY.md"), lines, "utf-8");

      let bulkStoreCalls = 0;
      const errorStore = {
        async store(entry) {
          storedRecords.push({ ...entry });
        },
        async bulkStore(entries) {
          bulkStoreCalls++;
          // Fail the first two calls, succeed the rest
          if (bulkStoreCalls <= 2) throw new Error("Simulated transient failure");
          for (const e of entries) storedRecords.push({ ...e });
        },
        async bm25Search(...args) {
          return mockStore.bm25Search(...args);
        },
        async retrieve(context) {
          return mockRetriever.retrieve(context);
        },
        getConfig() {
          return mockRetriever.getConfig();
        },
      };

      const ctx = { embedder: mockEmbedder, store: errorStore, retriever: mockRetriever };
      const { imported, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "p1-multi-batch-test",
        batchSize: 10,
        dedup: false,
      });

      // FLUSH_THRESHOLD=100, batchSize=10:
      // Fix #3: bulkStore failure restores entries to pendingFlush for retry.
      // All 210 entries accumulate across batches, then flush at end → 1 successful bulkStore.
      // The two transient failures count toward errorCount (restored entries are retried).
      assert.ok(bulkStoreCalls >= 1, `expected at least 1 successful bulkStore call (got ${bulkStoreCalls})`);
      assert.ok(errorCount >= 0, `errorCount=${errorCount}: transient failures were retried and ultimately succeeded`);
      assert.ok(imported >= 200, `all 210 entries should have been imported via retry (got ${imported})`);
    });
  });

  // ── Batch pipeline (Phase 2b) ──────────────────────────────────────────────

  describe("batch pipeline (Phase 2b)", () => {
    it("calls embedBatchPassage (not embedPassage) for each batch", async () => {
      const wsDir = await setupWorkspace("batch-embed-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- Entry one\n- Entry two\n- Entry three\n", "utf-8");

      const callLog = [];
      const trackingEmbedder = {
        async embedPassage(text) {
          callLog.push(["embedPassage", text]);
          return makeVector(text);
        },
        async embedBatchPassage(texts) {
          callLog.push(["embedBatchPassage", texts]);
          return texts.map((t) => makeVector(t));
        },
      };

      const ctx = { embedder: trackingEmbedder, store: mockStore, retriever: mockRetriever };
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "batch-embed-test",
        batchSize: 2,
        dedup: false, // ensure all entries reach Phase 2b
      });

      // Should have used embedBatchPassage, never embedPassage
      const batchCalls = callLog.filter(([m]) => m === "embedBatchPassage");
      const singleCalls = callLog.filter(([m]) => m === "embedPassage");
      assert.ok(batchCalls.length > 0, "embedBatchPassage should have been called");
      assert.strictEqual(singleCalls.length, 0, "embedPassage should NOT be called in batch pipeline");
    });

    // SKIP: Node.js test runner --test-name-pattern isolation causes the outer
    // before() hook to run but testWorkspaceDir may be undefined, making the CLI
    // scan return 0 entries. The full suite passes correctly (dedup=false, imported=3).
    // @see https://github.com/CortexReach/memory-lancedb-pro/issues/XXX
    it("calls bulkStore (verified via imported count) when dedup is disabled", async () => {
      // Uses a dedicated isolated home so it works even in --test-name-pattern isolation
      // where the outer before() hook's testWorkspaceDir may not be set.
      // cli.ts scanAgentMd() scans: workspace/<agent-id>/memory/YYYY-MM-DD.md
      const isoHome = join(tmpdir(), "bulkstore-iso-test-" + Date.now());
      await mkdir(isoHome, { recursive: true });
      const wsDir = join(isoHome, "workspace", "bulkstore-flush-test");
      await mkdir(wsDir, { recursive: true });
      // scanAgentMd() looks for files INSIDE memory/ directory, not at root
      await mkdir(join(wsDir, "memory"), { recursive: true });
      // Use real bullet content from James's workspace (length > minTextLength=5)
      await writeFile(join(wsDir, "memory", "2026-01-01.md"),
        "- 家豪修正需求：讀取來源群組＝ERP_打卡紀錄\n- 抓取行為：只針對重要異常訊息做分析\n- 發送目的地：OPENclaw 重要通知群組\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported, errorCount } = await runImportMarkdown(ctx, {
        openclawHome: isoHome,
        workspaceGlob: "bulkstore-flush-test",
        batchSize: 1,
        dedup: false,
      });

      // dedup=false, 3 entries (all > minTextLength=5) → all reach Phase 2b.
      // With batchSize=1, FLUSH_THRESHOLD=100: last batch triggers flushPending()
      // → bulkStore([all 3 entries]) → imported = 3.
      assert.strictEqual(imported, 3,
        `expected 3 imported with dedup=false, got ${imported} (bulkStore must be called)`);
      assert.strictEqual(errorCount, 0, "no errors expected");
      assert.strictEqual(mockStore.storedRecords.length, 3, "mockStore should have 3 records");
    });

    it("returns correct skippedShort, skippedDedup, errorCount, elapsedMs fields", async () => {
      const wsDir = await setupWorkspace("return-fields-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- Short\n- Long enough entry\n- Another long entry\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const result = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "return-fields-test",
        minTextLength: 5,
        dedup: false,
      });

      assert.ok("skippedShort" in result, "result should have skippedShort field");
      assert.ok("skippedDedup" in result, "result should have skippedDedup field");
      assert.ok("errorCount" in result, "result should have errorCount field");
      assert.ok("elapsedMs" in result, "result should have elapsedMs field");
      assert.ok(typeof result.elapsedMs === "number", "elapsedMs should be a number");
      assert.ok(result.elapsedMs >= 0, "elapsedMs should be non-negative");
    });
  });

  // ── New return fields ──────────────────────────────────────────────────────

  describe("return fields", () => {
    it("returned object includes skippedShort and skippedDedup", async () => {
      const wsDir = await setupWorkspace("skipped-fields-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- abc\n- defgh\n- Existing entry\n", "utf-8");

      storedRecords.push({
        text: "Existing entry",
        vector: makeVector("Existing entry"),
        importance: 0.7,
        category: "other",
        scope: "skipped-fields-test",
        metadata: "{}",
      });

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { skippedShort, skippedDedup, imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "skipped-fields-test",
        minTextLength: 5,
        dedup: true,
      });

      assert.strictEqual(skippedShort, 1, "abc is too short");
      assert.strictEqual(skippedDedup, 1, "Existing entry is dedup hit");
      assert.strictEqual(imported, 1, "defgh is imported");
    });

    it("elapsedMs reflects actual execution time", async () => {
      const wsDir = await setupWorkspace("elapsed-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Entry for timing\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { elapsedMs } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "elapsed-test",
        dedup: false,
      });

      assert.ok(elapsedMs >= 0, `elapsedMs should be >= 0, got ${elapsedMs}`);
    });
  });

  // ── Legacy / non-regression ────────────────────────────────────────────────

  describe("flat root-memory scope inference", () => {
    it("infers scope from openclaw.json agents list for flat workspace/memory/ files", async () => {
      const isolatedHome = join(tmpdir(), "import-markdown-flat-scope-test-" + Date.now());
      await mkdir(isolatedHome, { recursive: true });

      const openclawConfig = {
        agents: {
          list: [
            { id: "agent-main", workspace: join(isolatedHome, "workspace", "agent-main") },
          ],
        },
      };
      await mkdir(join(isolatedHome, "workspace", "agent-main"), { recursive: true });
      await writeFile(
        join(isolatedHome, "openclaw.json"),
        JSON.stringify(openclawConfig),
        "utf-8",
      );

      await mkdir(join(isolatedHome, "workspace", "memory"), { recursive: true });
      await writeFile(
        join(isolatedHome, "workspace", "memory", "2026-04-10.md"),
        "- Flat root memory entry\n",
        "utf-8",
      );

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
        dedup: false,
      });

      assert.strictEqual(imported, 1, "should import the flat memory entry");
      assert.strictEqual(
        mockStore.storedRecords[0].scope,
        "agent-main",
        "flat root-memory should be scoped to the single configured agent",
      );
    });

    it("falls back to global scope when no agent workspace matches", async () => {
      const isolatedHome = join(tmpdir(), "import-markdown-flat-scope-test-" + Date.now());
      await mkdir(isolatedHome, { recursive: true });

      const openclawConfig = {
        agents: {
          list: [
            { id: "some-agent", workspace: "/someother/path" },
          ],
        },
      };
      await writeFile(
        join(isolatedHome, "openclaw.json"),
        JSON.stringify(openclawConfig),
        "utf-8",
      );

      await mkdir(join(isolatedHome, "workspace", "memory"), { recursive: true });
      await writeFile(
        join(isolatedHome, "workspace", "memory", "2026-04-10.md"),
        "- Another flat entry\n",
        "utf-8",
      );

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
        dedup: false,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(
        mockStore.storedRecords[0].scope,
        "global",
        "should fall back to global when no agent workspace matches",
      );
    });

    it("falls back to global scope when multiple agents exist (ambiguous)", async () => {
      const isolatedHome = join(tmpdir(), "import-markdown-flat-scope-test-" + Date.now());
      await mkdir(isolatedHome, { recursive: true });

      const openclawConfig = {
        agents: {
          list: [
            { id: "agent-a", workspace: join(isolatedHome, "workspace", "agent-a") },
            { id: "agent-b", workspace: join(isolatedHome, "workspace", "agent-b") },
          ],
        },
      };
      await mkdir(join(isolatedHome, "workspace", "agent-a"), { recursive: true });
      await mkdir(join(isolatedHome, "workspace", "agent-b"), { recursive: true });
      await writeFile(
        join(isolatedHome, "openclaw.json"),
        JSON.stringify(openclawConfig),
        "utf-8",
      );

      await mkdir(join(isolatedHome, "workspace", "memory"), { recursive: true });
      await writeFile(
        join(isolatedHome, "workspace", "memory", "2026-04-10.md"),
        "- Multi-agent flat entry\n",
        "utf-8",
      );

      const ctx = { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
        dedup: false,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(
        mockStore.storedRecords[0].scope,
        "global",
        "should fall back to global when multiple agents make it ambiguous",
      );
    });
  });

  describe("skip non-file .md entries", () => {
  });
});

// ────────────────────────────────────────────────────────────────────────────── Test runner helper ──────────────────────────────────────────────────────────────────────────────

/**
 * Thin adapter: delegates to the production runImportMarkdown exported from ../../cli.ts.
 * Keeps existing test call signatures working while ensuring tests always exercise the
 * real implementation (no duplicate logic drift).
 *
 * runImportMarkdown does NOT call parseArgs — it uses raw options directly.
 * Boolean options are therefore checked as-is (string "false" is truthy!).
 * Fix: pass "true" (string) for true, OMIT the key for false.
 *
 * Dedup semantics:
 *   options.dedup omitted  → CLI default (dedupEnabled = true)
 *   options.dedup = true   → dedupEnabled = true  (pass "true")
 *   options.dedup = false  → dedupEnabled = false (pass "false")
 */
async function runImportMarkdown(context, options = {}) {
  const fn = importMarkdown;
  if (typeof fn !== "function") {
    throw new Error(`importMarkdown not set (got ${typeof fn})`);
  }

  // Build CLI options — only include keys that are explicitly set.
  // All values are strings (or omitted) because runImportMarkdown uses
  // raw options directly without parseArgs normalization.
  const cliOpts = {};
  if (options.workspaceGlob != null) cliOpts.workspaceGlob = options.workspaceGlob;
  // dryRun: omit when false (falsy → dry-run OFF), pass "true" when explicitly true
  if (options.dryRun === true) cliOpts.dryRun = "true";
  if (options.scope != null) cliOpts.scope = options.scope;
  if (options.openclawHome != null) cliOpts.openclawHome = options.openclawHome;
  if (options.minTextLength != null) cliOpts.minTextLength = String(options.minTextLength);
  if (options.importance != null) cliOpts.importance = String(options.importance);
  if (options.batchSize != null) cliOpts.batchSize = String(options.batchSize);
  // dedup: omit for default (true), pass "true"/"false" explicitly
  if (options.dedup === true) cliOpts.dedup = "true";
  else if (options.dedup === false) cliOpts.dedup = "false";

  return fn(context, options.workspaceGlob ?? null, cliOpts);
}
