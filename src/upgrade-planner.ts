/**
 * Upgrade Planner — Phase 2 Wave 1
 *
 * Enriches raw UpgradeCandidates from init-check.ts with import priority,
 * overlap detection, warnings, and a summary. Read-only: no filesystem I/O.
 */

import type {
  UpgradeCandidates,
  WorkspaceMemorySource,
  SqliteMemoryStore,
} from "./init-check.js";

// ============================================================================
// Types
// ============================================================================

export type ImportPriority = "high" | "medium" | "low";

export interface WorkspaceMemorySourceReport extends WorkspaceMemorySource {
  importPriority: ImportPriority;
  warnings: string[];
}

export interface SqliteMemoryStoreReport extends SqliteMemoryStore {
  importPriority: ImportPriority;
  /** True when the same agentId has a workspace MEMORY.md — prefer Markdown import first */
  overlapWithWorkspaceMarkdown: boolean;
  warnings: string[];
}

export interface UpgradeScanSummary {
  workspaceSourceCount: number;
  sqliteSourceCount: number;
  pluginCompatibilityWorkspaceCount: number;
  pluginCompatibilityFileCount: number;
  /** Sources that carry at least one warning (unresolved agent, overlap risk, etc.) */
  ambiguousSourceCount: number;
}

export interface UpgradeScanReport {
  discoveryMode: "config" | "filesystem-fallback";
  workspaceMemorySources: WorkspaceMemorySourceReport[];
  sqliteStores: SqliteMemoryStoreReport[];
  summary: UpgradeScanSummary;
}

// ============================================================================
// Priority rules (pure, no I/O)
// ============================================================================

function workspacePriority(src: WorkspaceMemorySource): ImportPriority {
  if (src.hasMemoryMd) return "high";
  if (
    src.hasMemoryDir &&
    (src.memoryDirDateFiles.length > 0 || src.pluginCompatibilityDateFiles.length > 0)
  ) return "medium";
  return "low";
}

function workspaceWarnings(src: WorkspaceMemorySource): string[] {
  const warnings: string[] = [];
  if (src.agentId === undefined) {
    warnings.push(
      "unresolved agent mapping — workspace not linked to a known agent; confirm scope before import",
    );
  }
  return warnings;
}

function sqlitePriority(hasOverlap: boolean): ImportPriority {
  return hasOverlap ? "low" : "medium";
}

function sqliteWarnings(store: SqliteMemoryStore, hasOverlap: boolean): string[] {
  const warnings: string[] = [];
  if (store.agentId === undefined) {
    warnings.push(
      "unregistered SQLite store — agent not found in openclaw.json; confirm agent identity before import",
    );
  }
  if (hasOverlap) {
    warnings.push(
      "overlaps with workspace Markdown — prefer Markdown import first to avoid duplicate facts",
    );
  }
  return warnings;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Enrich UpgradeCandidates with import priorities, overlap detection,
 * warnings, and a summary. Pure function — no filesystem I/O.
 */
export function buildUpgradeScanReport(candidates: UpgradeCandidates): UpgradeScanReport {
  // Build set of agentIds that already have legacy-compatible Markdown sources.
  const agentsWithMarkdown = new Set<string>(
    candidates.workspaceMemorySources
      .filter(
        (s) =>
          s.agentId !== undefined &&
          (s.hasMemoryMd || s.memoryDirDateFiles.length > 0 || s.pluginCompatibilityDateFiles.length > 0),
      )
      .map((s) => s.agentId as string),
  );

  const workspaceMemorySources: WorkspaceMemorySourceReport[] =
    candidates.workspaceMemorySources.map((src) => ({
      ...src,
      importPriority: workspacePriority(src),
      warnings: workspaceWarnings(src),
    }));

  const sqliteStores: SqliteMemoryStoreReport[] = candidates.sqliteStores.map((store) => {
    const overlap =
      store.agentId !== undefined && agentsWithMarkdown.has(store.agentId);
    return {
      ...store,
      importPriority: sqlitePriority(overlap),
      overlapWithWorkspaceMarkdown: overlap,
      warnings: sqliteWarnings(store, overlap),
    };
  });

  const ambiguousSourceCount =
    workspaceMemorySources.filter((s) => s.warnings.length > 0).length +
    sqliteStores.filter((s) => s.warnings.length > 0).length;
  const pluginCompatibilityWorkspaceCount = workspaceMemorySources.filter(
    (s) => s.pluginCompatibilityDateFiles.length > 0,
  ).length;
  const pluginCompatibilityFileCount = workspaceMemorySources.reduce(
    (sum, s) => sum + s.pluginCompatibilityDateFiles.length,
    0,
  );

  return {
    discoveryMode: candidates.discoveryMode,
    workspaceMemorySources,
    sqliteStores,
    summary: {
      workspaceSourceCount: workspaceMemorySources.length,
      sqliteSourceCount: sqliteStores.length,
      pluginCompatibilityWorkspaceCount,
      pluginCompatibilityFileCount,
      ambiguousSourceCount,
    },
  };
}
