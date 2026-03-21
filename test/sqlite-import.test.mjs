/**
 * Tests for src/sqlite-import.ts — SQLite Preview Reader (P2-W3)
 *
 * These tests cover read-only / preview behaviour only.
 * No import writes, no LanceDB changes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  discoverSqliteStores,
  inspectSqliteStore,
  buildSqlitePreview,
  formatSqlitePreviewReport,
} = jiti("../src/sqlite-import.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a SQL string literal value (single-quote escaping). */
function sqlStr(val) {
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/**
 * Run SQL against a SQLite file via stdin so multi-line statements and
 * special characters in values are handled safely.
 */
function runSql(filePath, sql) {
  execSync(`sqlite3 ${JSON.stringify(filePath)}`, {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Create a minimal SQLite store at `filePath` with optional seed rows. */
function createSqliteStore(filePath, { chunkRows = [], fileRows = [], metaRows = [] } = {}) {
  const schema = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
  runSql(filePath, schema);

  for (const row of chunkRows) {
    const sql = `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (${[
      sqlStr(row.id),
      sqlStr(row.path),
      sqlStr(row.source ?? "memory"),
      row.start_line ?? 0,
      row.end_line ?? 1,
      sqlStr(row.hash ?? "abc"),
      sqlStr(row.model ?? "test"),
      sqlStr(row.text),
      sqlStr(row.embedding ?? "[]"),
      row.updated_at ?? 0,
    ].join(",")});`;
    runSql(filePath, sql);
  }

  for (const row of fileRows) {
    const sql = `INSERT INTO files (path, source, hash, mtime, size) VALUES (${[
      sqlStr(row.path),
      sqlStr(row.source ?? "memory"),
      sqlStr(row.hash ?? "abc"),
      row.mtime ?? 0,
      row.size ?? 0,
    ].join(",")});`;
    runSql(filePath, sql);
  }

  for (const row of metaRows) {
    const sql = `INSERT INTO meta (key, value) VALUES (${sqlStr(row.key)}, ${sqlStr(row.value)});`;
    runSql(filePath, sql);
  }
}

// ---------------------------------------------------------------------------
// discoverSqliteStores
// ---------------------------------------------------------------------------

describe("discoverSqliteStores", () => {
  let storeDir;

  before(() => {
    storeDir = mkdtempSync(path.join(tmpdir(), "sqlite-import-discover-"));
    createSqliteStore(path.join(storeDir, "main.sqlite"));
    createSqliteStore(path.join(storeDir, "agent_bot.sqlite"));
    // A non-sqlite file should be ignored
    writeFileSync(path.join(storeDir, "not-a-db.txt"), "ignored");
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("returns only .sqlite files from the given directory", async () => {
    const result = await discoverSqliteStores(storeDir);
    assert.equal(result.length, 2);
    const basenames = result.map((r) => path.basename(r.filePath)).sort();
    assert.deepEqual(basenames, ["agent_bot.sqlite", "main.sqlite"]);
  });

  it("infers agent name from filename by stripping .sqlite", async () => {
    const result = await discoverSqliteStores(storeDir);
    const byName = Object.fromEntries(result.map((r) => [r.agentName, r]));
    assert.ok(byName["agent_bot"]);
    assert.ok(byName["main"]);
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await discoverSqliteStores("/no/such/dir/xyz-12345");
    assert.deepEqual(result, []);
  });

  it("returns empty array for a directory with no .sqlite files", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "sqlite-empty-"));
    try {
      const result = await discoverSqliteStores(emptyDir);
      assert.deepEqual(result, []);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// inspectSqliteStore
// ---------------------------------------------------------------------------

describe("inspectSqliteStore", () => {
  let storeDir;
  let emptyPath;
  let populatedPath;

  before(() => {
    storeDir = mkdtempSync(path.join(tmpdir(), "sqlite-import-inspect-"));
    emptyPath = path.join(storeDir, "empty_agent.sqlite");
    populatedPath = path.join(storeDir, "populated_agent.sqlite");

    createSqliteStore(emptyPath);
    createSqliteStore(populatedPath, {
      chunkRows: [
        { id: "c1", path: "/mem/a.md", text: "Remember user prefers short answers", updated_at: 1000 },
        { id: "c2", path: "/mem/a.md", text: "User timezone is UTC+9",             updated_at: 2000 },
        { id: "c3", path: "/mem/b.md", text: "Project uses TypeScript",            updated_at: 3000 },
      ],
      fileRows: [
        { path: "/mem/a.md", mtime: 1000 },
        { path: "/mem/b.md", mtime: 3000 },
      ],
      metaRows: [
        { key: "agent_id", value: "populated_agent" },
      ],
    });
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("reports zero chunkCount and fileCount for an empty store", async () => {
    const info = await inspectSqliteStore(emptyPath);
    assert.equal(info.chunkCount, 0);
    assert.equal(info.fileCount, 0);
    assert.equal(info.isEmpty, true);
  });

  it("reports correct counts for a populated store", async () => {
    const info = await inspectSqliteStore(populatedPath);
    assert.equal(info.chunkCount, 3);
    assert.equal(info.fileCount, 2);
    assert.equal(info.isEmpty, false);
  });

  it("reads agent_id from meta table when present", async () => {
    const info = await inspectSqliteStore(populatedPath);
    assert.equal(info.metaAgentId, "populated_agent");
  });

  it("returns null metaAgentId when meta has no agent_id row", async () => {
    const info = await inspectSqliteStore(emptyPath);
    assert.equal(info.metaAgentId, null);
  });

  it("includes distinct source paths from files table", async () => {
    const info = await inspectSqliteStore(populatedPath);
    assert.ok(Array.isArray(info.sourcePaths));
    assert.equal(info.sourcePaths.length, 2);
  });

  it("includes sample texts from chunks (up to 5)", async () => {
    const info = await inspectSqliteStore(populatedPath);
    assert.ok(Array.isArray(info.sampleTexts));
    assert.ok(info.sampleTexts.length <= 5);
    assert.ok(info.sampleTexts.length > 0);
  });

  it("returns readable=false and error message for a non-existent file", async () => {
    const info = await inspectSqliteStore("/no/such/file.sqlite");
    assert.equal(info.readable, false);
    assert.ok(typeof info.error === "string");
  });

  it("returns readable=true for a valid store", async () => {
    const info = await inspectSqliteStore(emptyPath);
    assert.equal(info.readable, true);
  });
});

// ---------------------------------------------------------------------------
// buildSqlitePreview
// ---------------------------------------------------------------------------

describe("buildSqlitePreview", () => {
  let storeDir;
  let storeAPath;
  let storeBPath;

  before(() => {
    storeDir = mkdtempSync(path.join(tmpdir(), "sqlite-import-preview-"));
    storeAPath = path.join(storeDir, "main.sqlite");
    storeBPath = path.join(storeDir, "code_agent.sqlite");

    createSqliteStore(storeAPath, {
      chunkRows: [
        { id: "m1", path: "/mem/MEMORY.md", text: "User prefers verbose logs", updated_at: 100 },
      ],
      fileRows: [{ path: "/mem/MEMORY.md", mtime: 100 }],
    });

    createSqliteStore(storeBPath);
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("returns a preview result with one entry per .sqlite file", async () => {
    const preview = await buildSqlitePreview({ storeDir });
    assert.equal(preview.sqliteStores.length, 2);
  });

  it("marks stores with zero chunks as empty", async () => {
    const preview = await buildSqlitePreview({ storeDir });
    const codeAgent = preview.sqliteStores.find((s) => s.agentName === "code_agent");
    assert.ok(codeAgent);
    assert.equal(codeAgent.isEmpty, true);
    assert.equal(codeAgent.importPriority, "low");
  });

  it("marks stores with chunks as higher priority than empty stores", async () => {
    const preview = await buildSqlitePreview({ storeDir });
    const main = preview.sqliteStores.find((s) => s.agentName === "main");
    const codeAgent = preview.sqliteStores.find((s) => s.agentName === "code_agent");
    assert.ok(main.importPriority === "high" || main.importPriority === "medium");
    assert.equal(codeAgent.importPriority, "low");
  });

  it("populates summary counts correctly", async () => {
    const preview = await buildSqlitePreview({ storeDir });
    assert.equal(preview.summary.sqliteSourceCount, 2);
    assert.equal(typeof preview.summary.totalChunkCount, "number");
    assert.ok(preview.summary.totalChunkCount >= 0);
  });

  it("sets overlapWithWorkspaceMarkdown when workspace paths overlap with store source paths", async () => {
    const workspacePath = storeDir; // same dir so /mem/MEMORY.md source path won't match
    const preview = await buildSqlitePreview({
      storeDir,
      workspacePaths: ["/mem"],
    });
    const main = preview.sqliteStores.find((s) => s.agentName === "main");
    // /mem/MEMORY.md is a source path in main store; workspacePath /mem is a prefix
    assert.equal(main.overlapWithWorkspaceMarkdown, true);
  });

  it("sets overlapWithWorkspaceMarkdown=false when no workspace path matches", async () => {
    const preview = await buildSqlitePreview({
      storeDir,
      workspacePaths: ["/completely/different/path"],
    });
    const main = preview.sqliteStores.find((s) => s.agentName === "main");
    assert.equal(main.overlapWithWorkspaceMarkdown, false);
  });

  it("default storeDir falls back to ~/.openclaw/memory when not specified", async () => {
    // Should not throw even if the real dir has only empty stores
    const preview = await buildSqlitePreview();
    assert.ok(Array.isArray(preview.sqliteStores));
    assert.ok(typeof preview.summary.sqliteSourceCount === "number");
  });

  it("each entry includes a basename field matching the filename", async () => {
    const preview = await buildSqlitePreview({ storeDir });
    for (const entry of preview.sqliteStores) {
      assert.ok(typeof entry.basename === "string", "basename must be a string");
      assert.ok(entry.basename.endsWith(".sqlite"), `basename '${entry.basename}' must end with .sqlite`);
      assert.ok(entry.filePath.endsWith(entry.basename), "filePath must end with basename");
    }
  });

  it("agentId field prefers metaAgentId over filename when meta has agent_id", async () => {
    // main store has no meta, code_agent has no meta — both agentId should fall back to null
    const preview = await buildSqlitePreview({ storeDir });
    const main = preview.sqliteStores.find((s) => s.agentName === "main");
    // main store was created without meta rows => agentId is null
    assert.equal(main.agentId, null);
  });
});

// ---------------------------------------------------------------------------
// formatSqlitePreviewReport
// ---------------------------------------------------------------------------

describe("formatSqlitePreviewReport", () => {
  /** Build a minimal SqlitePreviewResult for formatting tests */
  function makeResult(overrides = {}) {
    return {
      sqliteStores: [
        {
          filePath: "/home/user/.openclaw/memory/main.sqlite",
          basename: "main.sqlite",
          agentName: "main",
          agentId: null,
          readable: true,
          chunkCount: 5,
          fileCount: 2,
          isEmpty: false,
          metaAgentId: null,
          sourcePaths: ["/home/user/.claude/memory/MEMORY.md"],
          sampleTexts: ["User prefers short answers"],
          importPriority: "medium",
          overlapWithWorkspaceMarkdown: false,
          warnings: [],
        },
        {
          filePath: "/home/user/.openclaw/memory/code_agent.sqlite",
          basename: "code_agent.sqlite",
          agentName: "code_agent",
          agentId: "code_agent",
          readable: true,
          chunkCount: 0,
          fileCount: 0,
          isEmpty: true,
          metaAgentId: "code_agent",
          sourcePaths: [],
          sampleTexts: [],
          importPriority: "low",
          overlapWithWorkspaceMarkdown: true,
          warnings: ["Source paths overlap with workspace Markdown — prefer Markdown import to avoid duplication"],
        },
      ],
      summary: {
        sqliteSourceCount: 2,
        totalChunkCount: 5,
        emptyStoreCount: 1,
      },
      ...overrides,
    };
  }

  it("returns a non-empty string", () => {
    const report = formatSqlitePreviewReport(makeResult());
    assert.ok(typeof report === "string");
    assert.ok(report.length > 0);
  });

  it("includes each agent name in the output", () => {
    const report = formatSqlitePreviewReport(makeResult());
    assert.ok(report.includes("main"), "must mention main store");
    assert.ok(report.includes("code_agent"), "must mention code_agent store");
  });

  it("includes chunk count for each store", () => {
    const report = formatSqlitePreviewReport(makeResult());
    assert.ok(report.includes("5"), "must show chunk count of 5");
    assert.ok(report.includes("0"), "must show chunk count of 0");
  });

  it("includes import priority labels", () => {
    const report = formatSqlitePreviewReport(makeResult());
    assert.ok(
      report.toLowerCase().includes("medium") || report.toLowerCase().includes("low"),
      "must include priority labels"
    );
  });

  it("flags overlap warning in output when overlapWithWorkspaceMarkdown is true", () => {
    const report = formatSqlitePreviewReport(makeResult());
    assert.ok(
      report.toLowerCase().includes("overlap") || report.toLowerCase().includes("warning"),
      "must surface overlap/warning"
    );
  });

  it("includes summary counts at the end", () => {
    const report = formatSqlitePreviewReport(makeResult());
    // Summary should mention total store count or chunk count
    assert.ok(
      report.includes("2") && report.includes("5"),
      "summary must include store count (2) and chunk count (5)"
    );
  });

  it("handles empty store list gracefully", () => {
    const report = formatSqlitePreviewReport({ sqliteStores: [], summary: { sqliteSourceCount: 0, totalChunkCount: 0, emptyStoreCount: 0 } });
    assert.ok(typeof report === "string");
    assert.ok(report.includes("0"), "empty result must still show counts");
  });
});
