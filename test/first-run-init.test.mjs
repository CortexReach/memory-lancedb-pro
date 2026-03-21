/**
 * Tests for first-run / initialization scaffolding (src/init-check.ts)
 *
 * Covers:
 *   - checkFirstRun: first-run / initialized / needs-upgrade status
 *   - writeInitMarker: creates and overwrites marker
 *   - detectUpgradeCandidates: workspace MEMORY.md / memory/ dir detection
 *   - detectUpgradeCandidates: per-agent SQLite store detection
 *   - detectUpgradeCandidates: openclaw.json config-derived discovery
 *   - detectUpgradeCandidates: discoveryMode reporting
 *   - detectUpgradeCandidates: agentId enrichment on workspace + sqlite sources
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { checkFirstRun, writeInitMarker, detectUpgradeCandidates } = jiti("../src/init-check.ts");

describe("first-run init-check", () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-init-"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // ── checkFirstRun ──────────────────────────────────────────────────────────

  it("returns first-run when no marker file exists", async () => {
    const dbPath = path.join(workDir, "db-new");
    mkdirSync(dbPath, { recursive: true });

    const result = await checkFirstRun(dbPath, "1.1.0");

    assert.equal(result.status, "first-run");
    assert.equal(result.marker, undefined);
  });

  it("returns initialized when marker version matches current version", async () => {
    const dbPath = path.join(workDir, "db-same-version");
    mkdirSync(dbPath, { recursive: true });

    await writeInitMarker(dbPath, "1.1.0");
    const result = await checkFirstRun(dbPath, "1.1.0");

    assert.equal(result.status, "initialized");
    assert.ok(result.marker, "marker should be present");
    assert.equal(result.marker.version, "1.1.0");
    assert.ok(typeof result.marker.initializedAt === "number", "initializedAt should be a number");
  });

  it("returns needs-upgrade when marker version differs from current version", async () => {
    const dbPath = path.join(workDir, "db-old-version");
    mkdirSync(dbPath, { recursive: true });

    await writeInitMarker(dbPath, "1.0.0");
    const result = await checkFirstRun(dbPath, "1.1.0");

    assert.equal(result.status, "needs-upgrade");
    assert.ok(result.marker, "marker should be present");
    assert.equal(result.marker.version, "1.0.0");
  });

  // ── writeInitMarker ────────────────────────────────────────────────────────

  it("creates a valid JSON marker file readable by checkFirstRun", async () => {
    const dbPath = path.join(workDir, "db-write-check");
    mkdirSync(dbPath, { recursive: true });

    const before = Date.now();
    await writeInitMarker(dbPath, "2.0.0");
    const after = Date.now();

    const result = await checkFirstRun(dbPath, "2.0.0");

    assert.equal(result.status, "initialized");
    assert.ok(result.marker);
    assert.ok(result.marker.initializedAt >= before, "initializedAt should be >= before timestamp");
    assert.ok(result.marker.initializedAt <= after, "initializedAt should be <= after timestamp");
  });

  it("overwrites an existing marker when writeInitMarker is called again", async () => {
    const dbPath = path.join(workDir, "db-overwrite");
    mkdirSync(dbPath, { recursive: true });

    await writeInitMarker(dbPath, "1.0.0");
    await writeInitMarker(dbPath, "1.1.0");

    const result = await checkFirstRun(dbPath, "1.1.0");

    assert.equal(result.status, "initialized");
    assert.equal(result.marker?.version, "1.1.0");
  });

  // ── detectUpgradeCandidates — workspace memory sources ─────────────────────

  it("detects workspace with MEMORY.md as a memory source", async () => {
    const wsDir = path.join(workDir, "ws-with-memory-md");
    mkdirSync(wsDir, { recursive: true });
    await writeFile(path.join(wsDir, "MEMORY.md"), "# Memory\n", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite-dir"),
    });

    assert.equal(candidates.workspaceMemorySources.length, 1);
    const src = candidates.workspaceMemorySources[0];
    assert.equal(src.workspacePath, wsDir);
    assert.equal(src.hasMemoryMd, true);
    assert.equal(src.hasMemoryDir, false);
  });

  it("detects workspace with memory/ directory as a memory source", async () => {
    const wsDir = path.join(workDir, "ws-with-memory-dir");
    mkdirSync(path.join(wsDir, "memory"), { recursive: true });

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite-dir"),
    });

    assert.equal(candidates.workspaceMemorySources.length, 1);
    const src = candidates.workspaceMemorySources[0];
    assert.equal(src.hasMemoryDir, true);
    assert.equal(src.hasMemoryMd, false);
  });

  it("lists YYYY-MM-DD.md files found inside memory/ directory", async () => {
    const wsDir = path.join(workDir, "ws-dated-files");
    const memDir = path.join(wsDir, "memory");
    mkdirSync(memDir, { recursive: true });
    await writeFile(path.join(memDir, "2025-01-01.md"), "# Day 1\n", "utf8");
    await writeFile(path.join(memDir, "2025-03-15.md"), "# Day 2\n", "utf8");
    await writeFile(path.join(memDir, "README.md"), "ignored\n", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite-dir"),
    });

    const src = candidates.workspaceMemorySources[0];
    assert.ok(src, "should have a workspace source");
    assert.equal(src.hasMemoryDir, true);
    const files = src.memoryDirDateFiles.slice().sort();
    assert.deepEqual(files, ["2025-01-01.md", "2025-03-15.md"]);
  });

  it("excludes workspace directory that has neither MEMORY.md nor memory/", async () => {
    const wsDir = path.join(workDir, "ws-empty");
    mkdirSync(wsDir, { recursive: true });
    await writeFile(path.join(wsDir, "AGENTS.md"), "# Agents\n", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite-dir"),
    });

    assert.equal(candidates.workspaceMemorySources.length, 0);
  });

  it("scans multiple workspace roots and returns a source per matching root", async () => {
    const ws1 = path.join(workDir, "ws-multi-1");
    const ws2 = path.join(workDir, "ws-multi-2");
    const ws3 = path.join(workDir, "ws-multi-3-empty");
    mkdirSync(ws1, { recursive: true });
    mkdirSync(ws2, { recursive: true });
    mkdirSync(ws3, { recursive: true });
    await writeFile(path.join(ws1, "MEMORY.md"), "# ws1\n", "utf8");
    mkdirSync(path.join(ws2, "memory"), { recursive: true });

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [ws1, ws2, ws3],
      overrideSqliteDir: path.join(workDir, "no-sqlite-dir"),
    });

    assert.equal(candidates.workspaceMemorySources.length, 2);
    const paths = candidates.workspaceMemorySources.map((s) => s.workspacePath).sort();
    assert.deepEqual(paths, [ws1, ws2].sort());
  });

  // ── detectUpgradeCandidates — per-agent SQLite stores ──────────────────────

  it("detects .sqlite files as per-agent memory stores", async () => {
    const sqliteDir = path.join(workDir, "sqlite-present");
    mkdirSync(sqliteDir, { recursive: true });
    await writeFile(path.join(sqliteDir, "main.sqlite"), "", "utf8");
    await writeFile(path.join(sqliteDir, "agent_bot.sqlite"), "", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: sqliteDir,
    });

    assert.equal(candidates.sqliteStores.length, 2);
    const names = candidates.sqliteStores.map((s) => s.basename).sort();
    assert.deepEqual(names, ["agent_bot.sqlite", "main.sqlite"]);
  });

  it("derives agentName from sqlite basename without extension", async () => {
    const sqliteDir = path.join(workDir, "sqlite-agent-name");
    mkdirSync(sqliteDir, { recursive: true });
    await writeFile(path.join(sqliteDir, "paper_writer.sqlite"), "", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: sqliteDir,
    });

    assert.equal(candidates.sqliteStores.length, 1);
    const store = candidates.sqliteStores[0];
    assert.equal(store.agentName, "paper_writer");
    assert.equal(store.basename, "paper_writer.sqlite");
    assert.equal(store.filePath, path.join(sqliteDir, "paper_writer.sqlite"));
  });

  it("excludes non-.sqlite files from sqlite store detection", async () => {
    const sqliteDir = path.join(workDir, "sqlite-mixed");
    mkdirSync(sqliteDir, { recursive: true });
    await writeFile(path.join(sqliteDir, "real.sqlite"), "", "utf8");
    await writeFile(path.join(sqliteDir, "noise.db"), "", "utf8");
    await writeFile(path.join(sqliteDir, "README.txt"), "", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: sqliteDir,
    });

    assert.equal(candidates.sqliteStores.length, 1);
    assert.equal(candidates.sqliteStores[0].basename, "real.sqlite");
  });

  it("returns empty sqliteStores when sqlite directory has no .sqlite files", async () => {
    const sqliteDir = path.join(workDir, "sqlite-empty-dir");
    mkdirSync(sqliteDir, { recursive: true });
    await writeFile(path.join(sqliteDir, "other.db"), "", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: sqliteDir,
    });

    assert.deepEqual(candidates.sqliteStores, []);
  });

  it("returns empty sqliteStores when sqlite directory does not exist", async () => {
    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: path.join(workDir, "nonexistent-sqlite-dir"),
    });

    assert.deepEqual(candidates.sqliteStores, []);
  });

  // ── detectUpgradeCandidates — openclaw.json config-derived discovery ────────

  /**
   * Helper: write a minimal openclaw.json to workDir/<name>.json
   * agents: array of { id, workspace? }
   * defaultWorkspace: string (the fallback workspace path)
   */
  async function writeTestConfig(name, { defaultWorkspace, agents }) {
    const configPath = path.join(workDir, name);
    const content = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: agents,
      },
    };
    await writeFile(configPath, JSON.stringify(content), "utf8");
    return configPath;
  }

  it("sets discoveryMode to config when openclaw.json is readable", async () => {
    const ws = path.join(workDir, "cfg-ws-mode");
    mkdirSync(ws, { recursive: true });
    const configPath = await writeTestConfig("config-mode.json", {
      defaultWorkspace: ws,
      agents: [{ id: "main" }],
    });

    const candidates = await detectUpgradeCandidates({
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: configPath,
    });

    assert.equal(candidates.discoveryMode, "config");
  });

  it("sets discoveryMode to filesystem-fallback when openclaw.json is absent", async () => {
    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: path.join(workDir, "nonexistent-config.json"),
    });

    assert.equal(candidates.discoveryMode, "filesystem-fallback");
  });

  it("derives workspace roots from agent list in openclaw.json", async () => {
    const wsMain = path.join(workDir, "cfg-ws-main");
    const wsBot = path.join(workDir, "cfg-ws-bot");
    mkdirSync(wsMain, { recursive: true });
    mkdirSync(wsBot, { recursive: true });
    await writeFile(path.join(wsMain, "MEMORY.md"), "# main\n", "utf8");
    await writeFile(path.join(wsBot, "MEMORY.md"), "# bot\n", "utf8");

    const configPath = await writeTestConfig("config-ws-roots.json", {
      defaultWorkspace: wsMain,
      agents: [
        { id: "main" },            // no workspace — uses defaultWorkspace
        { id: "bot", workspace: wsBot },
      ],
    });

    const candidates = await detectUpgradeCandidates({
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: configPath,
    });

    assert.equal(candidates.discoveryMode, "config");
    const wsPaths = candidates.workspaceMemorySources.map((s) => s.workspacePath).sort();
    assert.deepEqual(wsPaths, [wsBot, wsMain].sort());
  });

  it("associates agentId with workspaceMemorySource when derived from config", async () => {
    const wsMain = path.join(workDir, "cfg-agentid-ws");
    mkdirSync(wsMain, { recursive: true });
    await writeFile(path.join(wsMain, "MEMORY.md"), "# main\n", "utf8");

    const configPath = await writeTestConfig("config-agentid-ws.json", {
      defaultWorkspace: wsMain,
      agents: [{ id: "main" }],
    });

    const candidates = await detectUpgradeCandidates({
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: configPath,
    });

    assert.equal(candidates.workspaceMemorySources.length, 1);
    assert.equal(candidates.workspaceMemorySources[0].agentId, "main");
  });

  it("uses default workspace for agent without explicit workspace field", async () => {
    const defaultWs = path.join(workDir, "cfg-default-ws");
    mkdirSync(defaultWs, { recursive: true });
    await writeFile(path.join(defaultWs, "MEMORY.md"), "# default\n", "utf8");

    const configPath = await writeTestConfig("config-default-ws.json", {
      defaultWorkspace: defaultWs,
      agents: [{ id: "main" }],  // no workspace → falls back to defaultWorkspace
    });

    const candidates = await detectUpgradeCandidates({
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: configPath,
    });

    assert.equal(candidates.workspaceMemorySources.length, 1);
    assert.equal(candidates.workspaceMemorySources[0].workspacePath, defaultWs);
    assert.equal(candidates.workspaceMemorySources[0].agentId, "main");
  });

  it("associates agentId with sqliteStore when agent id matches sqlite basename", async () => {
    const sqliteDir = path.join(workDir, "cfg-sqlite-agentid");
    mkdirSync(sqliteDir, { recursive: true });
    await writeFile(path.join(sqliteDir, "myagent.sqlite"), "", "utf8");
    await writeFile(path.join(sqliteDir, "unknown.sqlite"), "", "utf8");

    const configPath = await writeTestConfig("config-sqlite-agentid.json", {
      defaultWorkspace: path.join(workDir, "unused-ws"),
      agents: [{ id: "myagent", workspace: path.join(workDir, "unused-ws") }],
    });

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [],
      overrideSqliteDir: sqliteDir,
      overrideConfigPath: configPath,
    });

    const byName = Object.fromEntries(candidates.sqliteStores.map((s) => [s.agentName, s]));
    assert.equal(byName["myagent"].agentId, "myagent", "known agent should have agentId set");
    assert.equal(byName["unknown"].agentId, undefined, "unregistered agent should have no agentId");
  });

  // ── always-detect contract ─────────────────────────────────────────────────
  // detectUpgradeCandidates() must work regardless of what checkFirstRun returns
  // so that newly-added agents are surfaced on every plugin startup, not only
  // on first-run or version-change. These tests verify the two functions are
  // fully decoupled at the module level — orchestration in index.ts must call
  // detectUpgradeCandidates unconditionally (see non-blocking IIFE there).

  it("detectUpgradeCandidates returns results when plugin is already initialized", async () => {
    // Simulate an already-initialized installation by writing a marker first
    const dbPath = path.join(workDir, "db-always-detect");
    mkdirSync(dbPath, { recursive: true });
    await writeInitMarker(dbPath, "1.1.0");

    // checkFirstRun should confirm initialized status
    const initResult = await checkFirstRun(dbPath, "1.1.0");
    assert.equal(initResult.status, "initialized");

    // detectUpgradeCandidates must still run and return a valid result
    // (represents a later startup after a new agent was added)
    const wsDir = path.join(workDir, "always-detect-ws");
    mkdirSync(wsDir, { recursive: true });
    await writeFile(path.join(wsDir, "MEMORY.md"), "# agent\n", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: path.join(workDir, "nonexistent-config.json"),
    });

    assert.ok(candidates, "candidates object must be returned");
    assert.ok("discoveryMode" in candidates, "must have discoveryMode");
    assert.ok("workspaceMemorySources" in candidates, "must have workspaceMemorySources");
    assert.ok("sqliteStores" in candidates, "must have sqliteStores");
    assert.equal(candidates.workspaceMemorySources.length, 1,
      "newly-added agent workspace must be discovered even after initialization");
  });

  it("filesystem-fallback still discovers workspaces via glob when config is absent", async () => {
    // overrideWorkspaceRoots takes priority over both config and glob —
    // verify that filesystem-fallback mode still works via explicit override
    const wsDir = path.join(workDir, "fallback-ws");
    mkdirSync(wsDir, { recursive: true });
    await writeFile(path.join(wsDir, "MEMORY.md"), "# fallback\n", "utf8");

    const candidates = await detectUpgradeCandidates({
      overrideWorkspaceRoots: [wsDir],
      overrideSqliteDir: path.join(workDir, "no-sqlite"),
      overrideConfigPath: path.join(workDir, "nonexistent-config.json"),
    });

    assert.equal(candidates.discoveryMode, "filesystem-fallback");
    assert.equal(candidates.workspaceMemorySources.length, 1);
    assert.equal(candidates.workspaceMemorySources[0].agentId, undefined,
      "filesystem-fallback sources should have no agentId");
  });
});
