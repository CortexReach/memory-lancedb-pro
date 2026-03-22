/**
 * Tests for src/upgrade-planner.ts
 *
 * Covers:
 *   - buildUpgradeScanReport: workspace importPriority rules
 *   - buildUpgradeScanReport: workspace agentId warning
 *   - buildUpgradeScanReport: sqlite importPriority rules
 *   - buildUpgradeScanReport: sqlite overlap detection and warning
 *   - buildUpgradeScanReport: sqlite unregistered warning
 *   - buildUpgradeScanReport: summary counts
 *   - buildUpgradeScanReport: discoveryMode pass-through
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildUpgradeScanReport } = jiti("../src/upgrade-planner.ts");

// ── Workspace priority rules ──────────────────────────────────────────────────

describe("buildUpgradeScanReport — workspace importPriority", () => {
  it("assigns high priority when hasMemoryMd is true", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/a",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.workspaceMemorySources[0].importPriority, "high");
  });

  it("assigns medium priority when hasMemoryDir with dated files (no MEMORY.md)", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/b",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: ["2024-01-01.md", "2024-01-02.md"],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.workspaceMemorySources[0].importPriority, "medium");
  });

  it("assigns low priority when hasMemoryDir with no dated files (no MEMORY.md)", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/c",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.workspaceMemorySources[0].importPriority, "low");
  });

  it("assigns high priority even when memory dir is also present (MEMORY.md takes precedence)", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/d",
          hasMemoryMd: true,
          hasMemoryDir: true,
          memoryDirDateFiles: ["2024-01-01.md"],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.workspaceMemorySources[0].importPriority, "high");
  });
});

// ── Workspace warning rules ───────────────────────────────────────────────────

describe("buildUpgradeScanReport — workspace warnings", () => {
  it("produces no warnings when agentId is resolved", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/a",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.deepEqual(report.workspaceMemorySources[0].warnings, []);
  });

  it("warns when workspace agentId is unresolved (filesystem-fallback)", () => {
    const candidates = {
      discoveryMode: "filesystem-fallback",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/unknown",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          // no agentId
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    const src = report.workspaceMemorySources[0];
    assert.ok(src.warnings.length > 0, "should have at least one warning");
    assert.ok(
      src.warnings.some((w) => w.includes("unresolved")),
      `Expected warning about unresolved mapping, got: ${src.warnings}`,
    );
  });
});

// ── SQLite priority rules ─────────────────────────────────────────────────────

describe("buildUpgradeScanReport — sqlite importPriority", () => {
  it("assigns medium priority to sqlite store with no workspace overlap", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [],
      sqliteStores: [
        {
          filePath: "/mem/main.sqlite",
          basename: "main.sqlite",
          agentName: "main",
          agentId: "main",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.equal(sq.importPriority, "medium");
    assert.equal(sq.overlapWithWorkspaceMarkdown, false);
  });

  it("assigns low priority to sqlite store when same agent has MEMORY.md", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/main",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [
        {
          filePath: "/mem/main.sqlite",
          basename: "main.sqlite",
          agentName: "main",
          agentId: "main",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.equal(sq.importPriority, "low");
    assert.equal(sq.overlapWithWorkspaceMarkdown, true);
  });

  it("flags overlap when workspace already has dated memory Markdown for the same agent", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/agent2",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: ["2024-01-01.md"],
          pluginCompatibilityDateFiles: [],
          agentId: "agent2",
        },
      ],
      sqliteStores: [
        {
          filePath: "/mem/agent2.sqlite",
          basename: "agent2.sqlite",
          agentName: "agent2",
          agentId: "agent2",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.equal(sq.overlapWithWorkspaceMarkdown, true);
    assert.equal(sq.importPriority, "low");
  });

  it("flags overlap when workspace only has plugin compatibility Markdown for the same agent", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/plugin-agent",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: ["2026-03-22.md"],
          agentId: "plugin-agent",
        },
      ],
      sqliteStores: [
        {
          filePath: "/mem/plugin-agent.sqlite",
          basename: "plugin-agent.sqlite",
          agentName: "plugin-agent",
          agentId: "plugin-agent",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.equal(sq.overlapWithWorkspaceMarkdown, true);
    assert.equal(sq.importPriority, "low");
  });
});

// ── SQLite warning rules ──────────────────────────────────────────────────────

describe("buildUpgradeScanReport — sqlite warnings", () => {
  it("warns about overlap when sqlite has same agentId as workspace with MEMORY.md", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/main",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "main",
        },
      ],
      sqliteStores: [
        {
          filePath: "/mem/main.sqlite",
          basename: "main.sqlite",
          agentName: "main",
          agentId: "main",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.ok(
      sq.warnings.some((w) => w.toLowerCase().includes("markdown")),
      `Expected Markdown overlap warning, got: ${sq.warnings}`,
    );
  });

  it("warns about unregistered sqlite store (no agentId)", () => {
    const candidates = {
      discoveryMode: "filesystem-fallback",
      workspaceMemorySources: [],
      sqliteStores: [
        {
          filePath: "/mem/unknown.sqlite",
          basename: "unknown.sqlite",
          agentName: "unknown",
          // no agentId
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    const sq = report.sqliteStores[0];
    assert.ok(
      sq.warnings.some((w) => w.includes("unregistered")),
      `Expected unregistered warning, got: ${sq.warnings}`,
    );
  });

  it("produces no warnings for fully resolved sqlite store with no overlap", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [],
      sqliteStores: [
        {
          filePath: "/mem/agent3.sqlite",
          basename: "agent3.sqlite",
          agentName: "agent3",
          agentId: "agent3",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.deepEqual(report.sqliteStores[0].warnings, []);
  });
});

// ── Summary counts ────────────────────────────────────────────────────────────

describe("buildUpgradeScanReport — summary", () => {
  it("counts workspace sources, sqlite stores, and ambiguous sources correctly", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        // resolved
        {
          workspacePath: "/ws/a",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
          agentId: "a",
        },
        // unresolved → ambiguous
        {
          workspacePath: "/ws/b",
          hasMemoryMd: true,
          hasMemoryDir: false,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: [],
        },
      ],
      sqliteStores: [
        // resolved, no overlap (different agentId from workspace sources)
        {
          filePath: "/m/c.sqlite",
          basename: "c.sqlite",
          agentName: "c",
          agentId: "c",
        },
        // unregistered → ambiguous
        {
          filePath: "/m/z.sqlite",
          basename: "z.sqlite",
          agentName: "z",
        },
      ],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.summary.workspaceSourceCount, 2);
    assert.equal(report.summary.sqliteSourceCount, 2);
    assert.equal(report.summary.pluginCompatibilityWorkspaceCount, 0);
    assert.equal(report.summary.pluginCompatibilityFileCount, 0);
    assert.equal(report.summary.ambiguousSourceCount, 2); // /ws/b (no agentId) and z.sqlite (unregistered)
  });

  it("returns zero counts for empty candidates", () => {
    const candidates = {
      discoveryMode: "filesystem-fallback",
      workspaceMemorySources: [],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.summary.workspaceSourceCount, 0);
    assert.equal(report.summary.sqliteSourceCount, 0);
    assert.equal(report.summary.pluginCompatibilityWorkspaceCount, 0);
    assert.equal(report.summary.pluginCompatibilityFileCount, 0);
    assert.equal(report.summary.ambiguousSourceCount, 0);
  });

  it("counts plugin compatibility workspaces and files in summary", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [
        {
          workspacePath: "/ws/plugin-a",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: [],
          pluginCompatibilityDateFiles: ["2026-03-22.md", "2026-03-23.md"],
          agentId: "a",
        },
        {
          workspacePath: "/ws/plugin-b",
          hasMemoryMd: false,
          hasMemoryDir: true,
          memoryDirDateFiles: ["2026-03-20.md"],
          pluginCompatibilityDateFiles: ["2026-03-24.md"],
          agentId: "b",
        },
      ],
      sqliteStores: [],
    };
    const report = buildUpgradeScanReport(candidates);
    assert.equal(report.summary.pluginCompatibilityWorkspaceCount, 2);
    assert.equal(report.summary.pluginCompatibilityFileCount, 3);
  });
});

// ── discoveryMode pass-through ────────────────────────────────────────────────

describe("buildUpgradeScanReport — discoveryMode", () => {
  it("passes through config discoveryMode unchanged", () => {
    const candidates = {
      discoveryMode: "config",
      workspaceMemorySources: [],
      sqliteStores: [],
    };
    assert.equal(buildUpgradeScanReport(candidates).discoveryMode, "config");
  });

  it("passes through filesystem-fallback discoveryMode unchanged", () => {
    const candidates = {
      discoveryMode: "filesystem-fallback",
      workspaceMemorySources: [],
      sqliteStores: [],
    };
    assert.equal(
      buildUpgradeScanReport(candidates).discoveryMode,
      "filesystem-fallback",
    );
  });
});
