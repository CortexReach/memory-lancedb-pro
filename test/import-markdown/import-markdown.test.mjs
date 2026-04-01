/**
 * import-markdown.test.mjs
 * Integration tests for the import-markdown CLI command.
 * Tests: BOM handling, CRLF normalization, bullet formats, dedup logic,
 * minTextLength, importance, and dry-run mode.
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest test/import-markdown.test.mjs
 */
import { jest } from "@jest/globals";

// ??? Mock implementations ???????????????????????????????????????????????????????

const storedRecords = [];
const mockEmbedder = {
  embedQuery: jest.fn(async (text) => {
    // Return a deterministic 384-dim fake vector
    const dim = 384;
    const vec = [];
    let seed = hashString(text);
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      vec.push((seed >>> 8) / 16777215 - 1);
    }
    return vec;
  }),
  embedPassage: jest.fn(async (text) => {
    // Use same deterministic vector as embedQuery for test consistency
    const dim = 384;
    const vec = [];
    let seed = hashString(text);
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      vec.push((seed >>> 8) / 16777215 - 1);
    }
    return vec;
  }),
};

const mockStore = {
  storedRecords,
  async store(entry) {
    storedRecords.push({ ...entry });
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
    storedRecords.length = 0;
  },
};

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return h;
}

// ??? Test helpers ?????????????????????????????????????????????????????????????

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testWorkspaceDir;

async function setupWorkspace(name) {
  // Files must be created at: <testWorkspaceDir>/workspace/<name>/
  // because runImportMarkdown looks for path.join(openclawHome, "workspace")
  const wsDir = join(testWorkspaceDir, "workspace", name);
  await mkdir(wsDir, { recursive: true });
  return wsDir;
}

async function writeMem(wsDir, content) {
  await writeFile(join(wsDir, "MEMORY.md"), content, "utf-8");
}

// ??? Setup / Teardown ?????????????????????????????????????????????????????????

beforeAll(async () => {
  testWorkspaceDir = join(tmpdir(), "import-markdown-test-" + Date.now());
  await mkdir(testWorkspaceDir, { recursive: true });
});

afterEach(async () => {
  mockStore.reset();
  mockEmbedder.embedQuery.mockClear();
  mockEmbedder.embedPassage.mockClear();
});

afterAll(async () => {
  // Cleanup is handled by OS (tmpdir cleanup)
});

// ??? Tests ????????????????????????????????????????????????????????????????????

describe("import-markdown CLI", () => {
  // Lazy-import to avoid hoisting issues
  let importMarkdown;

  beforeAll(async () => {
    // We test the core logic directly instead of via CLI to avoid complex setup
    const mod = await import("../cli.ts");
    importMarkdown = mod.runImportMarkdown ?? null;
  });

  describe("BOM handling", () => {
    it("strips UTF-8 BOM from file content", async () => {
      // UTF-8 BOM: bytes EF BB BF
      const wsDir = await setupWorkspace("bom-test");
      // BOM byte followed by a valid bullet line
      const bomHex = "\ufeff";
      await writeFile(join(wsDir, "MEMORY.md"), bomHex + "- 甇?虜閮??批捆\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bom-test",
      });

      // Second line should be imported; BOM line should be skipped (not "- " prefix)
      expect(imported).toBeGreaterThanOrEqual(1);
    });
  });

  describe("CRLF normalization", () => {
    it("handles Windows CRLF line endings", async () => {
      const wsDir = await setupWorkspace("crlf-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Windows CRLF 閮\r\n- 蝚砌?蝑?\r\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "crlf-test",
      });

      expect(imported).toBe(2);
    });
  });

  describe("Bullet format support", () => {
    it("imports dash, star, and plus bullet formats", async () => {
      const wsDir = await setupWorkspace("bullet-formats");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- Dash format bullet\n" +
        "* Star format bullet\n" +
        "+ Plus format bullet\n",
        "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bullet-formats",
      });

      expect(imported).toBe(3);
      expect(skipped).toBe(0);
    });
  });

  describe("minTextLength option", () => {
    it("skips lines shorter than minTextLength", async () => {
      const wsDir = await setupWorkspace("min-len-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- 憟穀n- 皜祈岫\n- 甇?虜?瑕漲???園??娉n",
        "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "min-len-test",
        minTextLength: 5,
      });

      expect(imported).toBe(1); // "甇?虜?瑕漲???園???
      expect(skipped).toBe(2); // "憟?, "皜祈岫"
    });
  });

  describe("importance option", () => {
    it("uses custom importance value", async () => {
      const wsDir = await setupWorkspace("importance-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- ???扳葫閰西??跚n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "importance-test",
        importance: 0.9,
      });

      expect(mockStore.storedRecords[0].importance).toBe(0.9);
    });
  });

  describe("dedup logic", () => {
    it("skips already-imported entries in same scope when dedup is enabled", async () => {
      const wsDir = await setupWorkspace("dedup-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- 蝚砌?甈∪?亦?閮\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };

      // First import
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: false,
      });
      expect(mockStore.storedRecords.length).toBe(1);

      // Second import WITH dedup ??should skip the duplicate
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: true,
      });

      expect(imported).toBe(0);
      expect(skipped).toBe(1);
      expect(mockStore.storedRecords.length).toBe(1); // Still only 1
    });

    it("imports same text into different scope even with dedup enabled", async () => {
      const wsDir = await setupWorkspace("dedup-scope-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- 頝?scope 皜祈岫閮\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };

      // First import to scope-A
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-scope-test",
        scope: "scope-A",
        dedup: false,
      });
      expect(mockStore.storedRecords.length).toBe(1);

      // Second import to scope-B ??should NOT skip (different scope)
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-scope-test",
        scope: "scope-B",
        dedup: true,
      });

      expect(imported).toBe(1);
      expect(mockStore.storedRecords.length).toBe(2); // Two entries, different scopes
    });
  });

  describe("dry-run mode", () => {
    it("does not write to store in dry-run mode", async () => {
      const wsDir = await setupWorkspace("dryrun-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- 銋曄頝葫閰西??跚n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dryrun-test",
        dryRun: true,
      });

      expect(imported).toBe(1);
      expect(mockStore.storedRecords.length).toBe(0); // No actual write
    });
  });

  describe("continue on error", () => {
    it("continues processing after a store failure", async () => {
      const wsDir = await setupWorkspace("error-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- 蝚砌?蝑?\n- 蝚砌?蝑?\n- 蝚砌?蝑?\n",
        "utf-8");

      let callCount = 0;
      const errorStore = {
        async store(entry) {
          callCount++;
          if (callCount === 2) throw new Error("Simulated failure");
          mockStore.storedRecords.push({ ...entry });
        },
        async bm25Search(...args) {
          return mockStore.bm25Search(...args);
        },
      };

      const ctx = { embedder: mockEmbedder, store: errorStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "error-test",
      });

      // One failed (the second call), two should have succeeded
      expect(imported).toBeGreaterThanOrEqual(2);
      expect(skipped).toBeGreaterThanOrEqual(1);
    });
  });
});

// ??? Test runner helper ????????????????????????????????????????????????????????
// This is a simplified version that calls the CLI logic directly.
// In a full integration test, you would use the actual CLI entry point.

/**
 * Run the import-markdown logic for testing.
 * This simulates the CLI action without requiring the full plugin context.
 */
/**
 * Thin adapter: delegates to the production runImportMarkdown exported from ../cli.ts.
 * Keeps existing test call signatures working while ensuring tests always exercise the
 * real implementation (no duplicate logic drift).
 */
async function runImportMarkdown(context, options = {}) {
  if (typeof importMarkdown === "function") {
    // Production signature: runImportMarkdown(ctx, workspaceGlob, options)
    // Test passes workspaceGlob as options.workspaceGlob
    return importMarkdown(
      context,
      options.workspaceGlob ?? null,
      {
        dryRun: !!options.dryRun,
        scope: options.scope,
        openclawHome: options.openclawHome,
        dedup: !!options.dedup,
        minTextLength: String(options.minTextLength ?? 5),
        importance: String(options.importance ?? 0.7),
      },
    );
  }
  return { imported: 0, skipped: 0, foundFiles: 0 };
}

