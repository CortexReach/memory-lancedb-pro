/**
 * Tests for the `memory-pro upgrade-scan` CLI command
 *
 * Covers:
 *   - command is registered and completes without error
 *   - human-readable output mentions workspace path
 *   - --json flag outputs valid JSON with required fields
 *   - JSON output contains correct importPriority for MEMORY.md workspace
 *   - empty scan produces valid JSON with zero counts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function makeMinimalContext() {
  return {
    store: {},
    retriever: {
      retrieve: async () => [],
      getConfig: () => ({}),
    },
    scopeManager: { getDefaultScope: () => "global" },
    migrator: {},
    embedder: { embedPassage: async () => [0, 0, 0, 0] },
  };
}

describe("memory-pro upgrade-scan CLI", () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(
      path.join(tmpdir(), "memory-lancedb-pro-upgrade-scan-cli-"),
    );
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("produces human-readable output mentioning the workspace path", async () => {
    const { createMemoryCLI } = jiti("../cli.ts");
    const { Command } = jiti("commander");
    const program = new Command();
    program.exitOverride();
    createMemoryCLI(makeMinimalContext())({ program });

    const ws = path.join(workDir, "ws-human-1");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "MEMORY.md"), "# test memory");
    const sqliteDir = path.join(workDir, "sqlite-human-1");
    mkdirSync(sqliteDir, { recursive: true });

    const output = await captureLogs(() =>
      program.parseAsync([
        "node", "openclaw", "memory-pro", "upgrade-scan",
        "--workspace-roots", ws,
        "--sqlite-dir", sqliteDir,
      ]),
    );

    assert.ok(output.length > 0, "Should produce output");
    assert.ok(
      output.includes(ws),
      `Expected workspace path "${ws}" in output, got:\n${output}`,
    );
  });

  it("produces valid JSON output when --json flag is passed", async () => {
    const { createMemoryCLI } = jiti("../cli.ts");
    const { Command } = jiti("commander");
    const program = new Command();
    program.exitOverride();
    createMemoryCLI(makeMinimalContext())({ program });

    const ws = path.join(workDir, "ws-json-1");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "MEMORY.md"), "# test memory");
    const sqliteDir = path.join(workDir, "sqlite-json-1");
    mkdirSync(sqliteDir, { recursive: true });

    const output = await captureLogs(() =>
      program.parseAsync([
        "node", "openclaw", "memory-pro", "upgrade-scan",
        "--workspace-roots", ws,
        "--sqlite-dir", sqliteDir,
        "--json",
      ]),
    );

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      assert.fail(`Expected valid JSON, got:\n${output}`);
    }

    assert.ok(Array.isArray(parsed.workspaceMemorySources), "should have workspaceMemorySources array");
    assert.ok(Array.isArray(parsed.sqliteStores), "should have sqliteStores array");
    assert.ok(typeof parsed.discoveryMode === "string", "should have discoveryMode string");
    assert.ok(parsed.summary && typeof parsed.summary === "object", "should have summary object");
    assert.ok(typeof parsed.summary.workspaceSourceCount === "number", "should have workspaceSourceCount");
    assert.ok(typeof parsed.summary.sqliteSourceCount === "number", "should have sqliteSourceCount");
    assert.ok(typeof parsed.summary.ambiguousSourceCount === "number", "should have ambiguousSourceCount");
  });

  it("reports high importPriority for workspace with MEMORY.md in JSON output", async () => {
    const { createMemoryCLI } = jiti("../cli.ts");
    const { Command } = jiti("commander");
    const program = new Command();
    program.exitOverride();
    createMemoryCLI(makeMinimalContext())({ program });

    const ws = path.join(workDir, "ws-priority-1");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "MEMORY.md"), "# test memory");
    const sqliteDir = path.join(workDir, "sqlite-priority-1");
    mkdirSync(sqliteDir, { recursive: true });

    const output = await captureLogs(() =>
      program.parseAsync([
        "node", "openclaw", "memory-pro", "upgrade-scan",
        "--workspace-roots", ws,
        "--sqlite-dir", sqliteDir,
        "--json",
      ]),
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.workspaceMemorySources.length, 1, "should find exactly 1 workspace source");
    const src = parsed.workspaceMemorySources[0];
    assert.equal(src.importPriority, "high", `Expected high priority, got ${src.importPriority}`);
    assert.equal(src.hasMemoryMd, true);
  });

  it("returns zero counts and empty arrays when no sources found", async () => {
    const { createMemoryCLI } = jiti("../cli.ts");
    const { Command } = jiti("commander");
    const program = new Command();
    program.exitOverride();
    createMemoryCLI(makeMinimalContext())({ program });

    const emptyWs = path.join(workDir, "ws-empty-1");
    mkdirSync(emptyWs, { recursive: true }); // dir exists but no MEMORY.md or memory/
    const sqliteDir = path.join(workDir, "sqlite-empty-1");
    mkdirSync(sqliteDir, { recursive: true }); // dir exists but no *.sqlite files

    const output = await captureLogs(() =>
      program.parseAsync([
        "node", "openclaw", "memory-pro", "upgrade-scan",
        "--workspace-roots", emptyWs,
        "--sqlite-dir", sqliteDir,
        "--json",
      ]),
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.workspaceMemorySources.length, 0);
    assert.equal(parsed.sqliteStores.length, 0);
    assert.equal(parsed.summary.workspaceSourceCount, 0);
    assert.equal(parsed.summary.sqliteSourceCount, 0);
    assert.equal(parsed.summary.ambiguousSourceCount, 0);
  });
});
