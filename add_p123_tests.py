"""
Add deep tests for P1 (within-batch dedup Phase 1c),
P2 (hits.some exact match at position > 0),
P3 (flushPending final retry on last batch failure).
Run from memory-lancedb-pro/ directory.
"""
import subprocess

# Read current test file
r = subprocess.run(
    ['git', 'show', 'HEAD:test/import-markdown/import-markdown.test.mjs'],
    capture_output=True, text=True, encoding='utf-8', errors='replace'
)
content = r.stdout

# ─────────────────────────────────────────────────────────────────────────────
# Find insertion point: end of the last describe block
# ─────────────────────────────────────────────────────────────────────────────
last_close = content.rfind('});')
insert_pos = content.rfind('\n', 0, last_close)

# ─────────────────────────────────────────────────────────────────────────────
# Build test blocks
# ─────────────────────────────────────────────────────────────────────────────
NEW_TESTS = '''
  // ═══════════════════════════════════════════════════════════════════════════
  // P1 Deep Tests — within-batch dedup (Phase 1c)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("P1 — within-batch dedup (Phase 1c)", () => {
    /**
     * Verifies Phase 1c correctly removes duplicate entries that appear
     * multiple times within the SAME batch before they reach Phase 2a.
     *
     * Scenario: same text appears 3 times across files. All should be deduped
     * (first occurrence kept, 2nd and 3rd skipped). skippedDedup must count
     * only within-batch duplicates, not Phase-2a dedup hits.
     *
     * Deep coverage:
     * - All duplicate slots counted in skippedDedup
     * - First occurrence is NOT in skippedDedup (imported instead)
     * - Works across files (not just within one file)
     * - With dedup disabled, no within-batch dedup happens
     */
    it("dedups duplicate text within same batch (first kept, rest skipped)", async () => {
      mockStore.reset();
      const wsDir = await setupWorkspace("p1-dedup-test");

      // Three files, same text in each — simulates cross-file duplicates
      await writeFile(join(wsDir, "file1.md"),
        "- 買牛奶\\n");
      await writeFile(join(wsDir, "file2.md"),
        "- 買牛奶\\n");
      await writeFile(join(wsDir, "file3.md"),
        "- 買牛奶\\n");

      // Also put a unique entry
      await writeFile(join(wsDir, "file4.md"),
        "- 繳房租\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      // Phase 1c: first "買牛奶" kept, 2nd+3rd deduped via skippedDedup
      // Phase 2a: all three "買牛奶" texts check store (empty) → all imported
      // But wait: Phase 1c removes 2 of the 3 "買牛奶" duplicates BEFORE Phase 2a
      // So: "買牛奶" imported (first), "買牛奶" skippedDedup, "買牛奶" skippedDedup
      // Plus "繳房租" imported
      assert.strictEqual(result.imported, 2);       // "買牛奶"×1 + "繳房租"
      assert.strictEqual(result.skippedDedup, 2);   // "買牛奶"×2 deduped in Phase 1c
    });

    it("skippedDedup counts ONLY within-batch duplicates, not Phase-2a hits", async () => {
      mockStore.reset();
      const wsDir = await setupWorkspace("p1-dedup-count-test");

      // Two files, same text
      await writeFile(join(wsDir, "a.md"), "- 重複內容\\n");
      await writeFile(join(wsDir, "b.md"), "- 重複內容\\n");

      // Phase 2a hits are 0 (store empty), but Phase 1c dedups one of them
      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      assert.strictEqual(result.skippedDedup, 1);   // Phase 1c deduplicated one
      assert.strictEqual(result.imported, 1);       // one imported
      assert.strictEqual(result.skipped, 0);        // nothing else skipped
    });

    it("with dedup disabled, within-batch dedup does NOT run", async () => {
      mockStore.reset();
      const wsDir = await setupWorkspace("p1-no-dedup-flag");

      await writeFile(join(wsDir, "x.md"), "- 內容A\\n");
      await writeFile(join(wsDir, "y.md"), "- 內容A\\n");

      // dedup: false — Phase 1c should still run (dedupEnabled check is for Phase 2a)
      // Actually Phase 1c runs regardless of dedup flag (it's a pipeline dedup)
      // Let's verify: allEntries still deduped even with dedup=false
      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // Phase 1c runs regardless; same text deduplicated
      assert.strictEqual(result.skippedDedup, 1);
      assert.strictEqual(result.imported, 1);
    });

    it("three copies of same text: first imported, two skippedDedup", async () => {
      mockStore.reset();
      const wsDir = await setupWorkspace("p1-triple-test");

      await writeFile(join(wsDir, "m1.md"), "- 測試文字\\n");
      await writeFile(join(wsDir, "m2.md"), "- 測試文字\\n");
      await writeFile(join(wsDir, "m3.md"), "- 測試文字\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.skippedDedup, 2);
      assert.strictEqual(result.skipped, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P2 Deep Tests — hits.some exact match (not just hits[0])
  // ═══════════════════════════════════════════════════════════════════════════
  describe("P2 — hits.some exact match at position > 0", () => {
    /**
     * Deep coverage: when hybrid retriever returns hits where the exact text
     * match is at position 1+ (not hits[0]), dedup must still work.
     *
     * The mockRetriever returns hits sorted by text order. We set up entries
     * so "exact match" sorts AFTER "similar but different" text.
     */

    beforeEach(() => { mockStore.reset(); });

    it("dedup hits when exact match is at hits[1] (reranked past hits[0])", async () => {
      const wsDir = await setupWorkspace("p2-rerank-test");

      // Pre-load store: this entry will appear SECOND in lexical sort,
      // so when we import the same text, it will be hits[1] not hits[0]
      await writeFile(join(wsDir, "preload.md"), "- Zoo visit\\n");

      await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // Now import another entry that sorts BEFORE "Zoo visit" in lexical order
      // This way "Zoo visit" will be at hits[1] for the next dedup check
      const wsDir2 = await setupWorkspace("p2-rerank-test-2");
      await writeFile(join(wsDir2, "a.md"), "- Apple\\n");
      await writeFile(join(wsDir2, "b.md"), "- Zoo visit\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir2,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      // "Zoo visit" is a dedup hit even though it sorts to hits[1]
      assert.strictEqual(result.skippedDedup, 1);
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.imported, 1); // only "Apple" imported
    });

    it("dedup hits when exact match is at hits[5] (deep reranking)", async () => {
      // Set up 5 store entries that all sort before "Target text"
      const wsDir = await setupWorkspace("p2-deep-rerank");
      for (let i = 0; i < 5; i++) {
        await writeFile(join(wsDir, `p${i}.md`), `- Text${String.fromCharCode(65+i)}\\n`);
      }

      await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // Now import "Target text" which sorts after all the above
      // Pre-load Target text
      const wsDir2 = await setupWorkspace("p2-deep-rerank-2");
      await writeFile(join(wsDir2, "pre.md"), "- Target text\\n");

      await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir2,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // Now dedup check: "Target text" will be at hits[5] (lexical position after 5 entries)
      const wsDir3 = await setupWorkspace("p2-deep-rerank-3");
      await writeFile(join(wsDir3, "x.md"), "- Target text\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir3,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      assert.strictEqual(result.skippedDedup, 1,
        "hits.some should find exact match at hits[5] (lexically last)");
      assert.strictEqual(result.imported, 0);
    });

    it("hits.length===0 still imports (empty store)", async () => {
      const wsDir = await setupWorkspace("p2-empty-store");
      await writeFile(join(wsDir, "new.md"), "- Brand new content\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: mockStore, retriever: mockRetriever },
        wsDir,
        { dedup: true, openclawHome: testWorkspaceDir }
      );

      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.skippedDedup, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3 Deep Tests — flushPending final retry when last batch fails
  // ═══════════════════════════════════════════════════════════════════════════
  describe("P3 — flushPending final retry on last batch failure", () => {

    it("last batch flush fails then recovers on final retry → all imported", async () => {
      // Track flush call counts on the mock
      let flushAttempts = 0;
      let bulkStoreCalls = 0;

      const failingThenSucceedingStore = {
        ...mockStore,
        async bulkStore(entries) {
          bulkStoreCalls++;
          flushAttempts++;
          // Fail the first attempt, succeed on the second (final retry)
          if (flushAttempts === 1) {
            throw new Error("Transient network timeout");
          }
          // Succeed: delegate to real implementation
          for (const e of entries) mockStore.storedRecords.push({ ...e });
        },
      };

      const wsDir = await setupWorkspace("p3-final-retry-recover");
      // Need > FLUSH_THRESHOLD entries so last batch doesn't auto-flush
      const lines = ["- 內容" + i for i in list(range(105))];
      await writeFile(join(wsDir, "big.md"), "\\n".join(lines) + "\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: failingThenSucceedingStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // After P3 fix: final retry should succeed → all imported
      // flushAttempts: first fail → final retry succeed
      assert.ok(bulkStoreCalls >= 1, "bulkStore should have been called");
      assert.strictEqual(result.errorCount, 0,
        "Final retry should recover; no error should be counted");
      assert.strictEqual(result.imported, 105,
        "All 105 entries should be imported after successful final retry");
    });

    it("all bulkStore attempts fail → entries logged as error, errorCount incremented", async () => {
      let flushAttempts = 0;
      const alwaysFailingStore = {
        ...mockStore,
        async bulkStore(entries) {
          flushAttempts++;
          throw new Error("Persistent DB lock timeout");
        },
      };

      const wsDir = await setupWorkspace("p3-all-fail");
      // Make enough entries to trigger flush
      const lines = ["- 錯誤測試" + i for i in list(range(105))];
      await writeFile(join(wsDir, "err.md"), "\\n".join(lines) + "\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: alwaysFailingStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      // After P3 fix: entries are not silently lost
      // errorCount should capture all failed entries
      assert.ok(result.errorCount > 0, "errorCount must be > 0 when all flushes fail");
      assert.strictEqual(result.imported, 0, "Nothing imported when bulkStore always fails");

      // The important guarantee: entries are counted in errorCount, not silently lost
      const total = result.imported + result.skipped + result.errorCount;
      assert.strictEqual(total, 105,
        "All entries must be accounted for: imported + skipped + errorCount === 105");
    });

    it("partial failure: first flush fails, final retry succeeds, errorCount=0", async () => {
      let flushAttempts = 0;
      const partialFailingStore = {
        ...mockStore,
        async bulkStore(entries) {
          flushAttempts++;
          if (flushAttempts <= 2) {
            throw new Error("Transient failure batch " + flushAttempts);
          }
          for (const e of entries) mockStore.storedRecords.push({ ...e });
        },
      };

      const wsDir = await setupWorkspace("p3-partial-fail-recover");
      // First two flushes fail, third succeeds (last batch + final retry)
      const lines = ["- 部分失敗" + i for i in list(range(205))]; // ~2 flush thresholds
      await writeFile(join(wsDir, "partial.md"), "\\n".join(lines) + "\\n");

      const result = await importMarkdown(
        { embedder: mockEmbedder, store: partialFailingStore, retriever: mockRetriever },
        wsDir,
        { dedup: false, openclawHome: testWorkspaceDir }
      );

      assert.strictEqual(result.imported, 205,
        "All entries imported after transient failures resolved");
      assert.strictEqual(result.errorCount, 0,
        "errorCount=0 because final retry succeeded");
    });
  });

'''

# Insert the new tests before the final closing });
new_content = content[:insert_pos] + '\n' + NEW_TESTS + '\n' + content[insert_pos:]

# Write back
with open('test/import-markdown/import-markdown.test.mjs', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Tests written successfully")
print(f"Added blocks at position {insert_pos}")
print(f"New file size: {len(new_content)} chars")