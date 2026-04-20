/**
 * import-markdown.test.mjs
 * Integration tests for the import-markdown CLI command.
 * Tests: BOM handling, CRLF normalization, bullet formats, dedup logic,
 * minTextLength, importance, and dry-run mode.
 *
 * Run: node --test test/import-markdown/import-markdown.test.mjs
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// ────────────────────────────────────────────────────────────────────────────── Mock implementations ──────────────────────────────────────────────────────────────────────────────

let storedRecords = [];

const mockEmbedder = {
  embedQuery: async (text) => {
    // Return a deterministic 384-dim fake vector
    const dim = 384;
    const vec = [];
    let seed = hashString(text);
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      vec.push((seed >>> 8) / 16777215 - 1);
    }
    return vec;
  },
  embedPassage: async (text) => {
    // Same deterministic vector as embedQuery for test consistency
    const dim = 384;
    const vec = [];
    let seed = hashString(text);
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      vec.push((seed >>> 8) / 16777215 - 1);
    }
    return vec;
  },
};

const mockStore = {
  get storedRecords() {
    return storedRecords;
  },
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
    storedRecords.length = 0; // Mutate in place to preserve the array reference
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

  describe("BOM handling", () => {
    it("strips UTF-8 BOM from file content", async () => {
      const wsDir = await setupWorkspace("bom-test");
      // UTF-8 BOM (\ufeff) followed by a valid bullet line; BOM-only line should be skipped
      await writeFile(join(wsDir, "MEMORY.md"), "\ufeff- BOM line\n- Real bullet\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bom-test",
      });

      assert.ok(imported >= 1, `expected imported >= 1, got ${imported}`);
    });
  });

  describe("CRLF normalization", () => {
    it("handles Windows CRLF line endings", async () => {
      const wsDir = await setupWorkspace("crlf-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Line one\r\n- Line two\r\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "crlf-test",
      });

      assert.strictEqual(imported, 2);
    });
  });

  describe("Bullet format support", () => {
    it("imports dash, star, and plus bullet formats", async () => {
      const wsDir = await setupWorkspace("bullet-formats");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- Dash bullet\n* Star bullet\n+ Plus bullet\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "bullet-formats",
      });

      assert.strictEqual(imported, 3);
      assert.strictEqual(skipped, 0);
    });
  });

  describe("minTextLength option", () => {
    it("skips lines shorter than minTextLength", async () => {
      const wsDir = await setupWorkspace("min-len-test");
      // Lines: "短"=1 char, "中文字"=3 chars, "長文字行"=4 chars, "合格的文字"=5 chars
      await writeFile(join(wsDir, "MEMORY.md"),
        "- 短\n- 中文字\n- 長文字行\n- 合格的文字\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "min-len-test",
        minTextLength: 5,
      });

      assert.strictEqual(imported, 1); // "合格的文字" (5 chars)
      assert.strictEqual(skipped, 3); // "短", "中文字", "長文字行"
    });
  });

  describe("importance option", () => {
    it("uses custom importance value", async () => {
      const wsDir = await setupWorkspace("importance-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Test content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "importance-test",
        importance: 0.9,
      });

      assert.strictEqual(mockStore.storedRecords[0].importance, 0.9);
    });
  });

  describe("dedup logic", () => {
    it("skips already-imported entries in same scope when dedup is enabled", async () => {
      const wsDir = await setupWorkspace("dedup-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Duplicate content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };

      // First import (no dedup)
      await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: false,
      });
      assert.strictEqual(mockStore.storedRecords.length, 1);

      // Second import WITH dedup — should skip the duplicate
      const { imported, skipped } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dedup-test",
        dedup: true,
      });

      assert.strictEqual(imported, 0);
      assert.strictEqual(skipped, 1);
      assert.strictEqual(mockStore.storedRecords.length, 1); // Still only 1
    });

    it("imports same text into different scope even with dedup enabled", async () => {
      const wsDir = await setupWorkspace("dedup-scope-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Same content line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };

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

  describe("dry-run mode", () => {
    it("does not write to store in dry-run mode", async () => {
      const wsDir = await setupWorkspace("dryrun-test");
      await writeFile(join(wsDir, "MEMORY.md"), "- Dry run test line\n", "utf-8");

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: testWorkspaceDir,
        workspaceGlob: "dryrun-test",
        dryRun: true,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(mockStore.storedRecords.length, 0); // No actual write
    });
  });

  describe("continue on error", () => {
    it("continues processing after a store failure", async () => {
      const wsDir = await setupWorkspace("error-test");
      await writeFile(join(wsDir, "MEMORY.md"),
        "- First line\n- Second line\n- Third line\n", "utf-8");

      let callCount = 0;
      const errorStore = {
        async store(entry) {
          callCount++;
          if (callCount === 2) throw new Error("Simulated failure");
          storedRecords.push({ ...entry }); // Use outer storedRecords directly
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

      // Second call threw, but first and third should have succeeded
      assert.ok(imported >= 2, `expected imported >= 2, got ${imported}`);
      assert.ok(skipped >= 0);
    });
  });

  describe("flat root-memory scope inference", () => {
    it("infers scope from openclaw.json agents list for flat workspace/memory/ files", async () => {
      // Use isolated temp dir to avoid pollution from other tests' workspaces
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

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
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

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
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

      const ctx = { embedder: mockEmbedder, store: mockStore };
      const { imported } = await runImportMarkdown(ctx, {
        openclawHome: isolatedHome,
      });

      assert.strictEqual(imported, 1);
      assert.strictEqual(
        mockStore.storedRecords[0].scope,
        "global",
        "should fall back to global when multiple agents make it ambiguous",
      );
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────── Test runner helper ──────────────────────────────────────────────────────────────────────────────

/**
 * Thin adapter: delegates to the production runImportMarkdown exported from ../../cli.ts.
 * Keeps existing test call signatures working while ensuring tests always exercise the
 * real implementation (no duplicate logic drift).
 */
async function runImportMarkdown(context, options = {}) {
  if (typeof importMarkdown === "function") {
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
  throw new Error(`importMarkdown not set (got ${typeof importMarkdown})`);
}
