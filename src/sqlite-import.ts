/**
 * SQLite Preview Reader — Phase 2 Wave 1 (P2-W3)
 *
 * Read-only inspection of legacy per-agent SQLite stores under
 * ~/.openclaw/memory/*.sqlite.
 *
 * IMPORTANT: This module is preview/dry-run only.
 * - No LanceDB writes
 * - No import writes
 * - No runtime sync changes
 */

import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";

// ============================================================================
// Types
// ============================================================================

/** Compact reference returned by discoverSqliteStores */
export interface SqliteStoreRef {
  filePath: string;
  agentName: string;
}

/** Detailed inspection result for a single SQLite store */
export interface SqliteStoreInfo extends SqliteStoreRef {
  readable: boolean;
  error?: string;
  /** Row count in `chunks` table */
  chunkCount: number;
  /** Row count in `files` table */
  fileCount: number;
  isEmpty: boolean;
  /** Value of meta key `agent_id`, or null if absent */
  metaAgentId: string | null;
  /** Distinct file paths from the `files` table */
  sourcePaths: string[];
  /** Up to 5 sample texts from `chunks` */
  sampleTexts: string[];
}

/** Single entry in the preview output matching the Phase 2 design schema */
export interface SqlitePreviewEntry extends SqliteStoreInfo {
  basename: string;
  agentId: string | null;
  /** "high" | "medium" | "low" */
  importPriority: "high" | "medium" | "low";
  overlapWithWorkspaceMarkdown: boolean;
  warnings: string[];
}

/** Full preview result returned by buildSqlitePreview */
export interface SqlitePreviewResult {
  sqliteStores: SqlitePreviewEntry[];
  summary: {
    sqliteSourceCount: number;
    totalChunkCount: number;
    emptyStoreCount: number;
  };
}

/** Options for buildSqlitePreview */
export interface SqlitePreviewOptions {
  /** Directory to scan for *.sqlite files. Defaults to ~/.openclaw/memory */
  storeDir?: string;
  /** Known workspace root paths; used for overlap detection */
  workspacePaths?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

function defaultStoreDir(): string {
  return join(homedir(), ".openclaw", "memory");
}

/**
 * Run a single SQL statement against a SQLite file using the system sqlite3
 * CLI (JSON output mode, SQL passed via stdin for safety).
 */
function querySqlite(filePath: string, sql: string): Record<string, unknown>[] {
  const output = execSync(
    `sqlite3 -json ${JSON.stringify(filePath)}`,
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();

  if (!output) return [];
  return JSON.parse(output) as Record<string, unknown>[];
}

/**
 * Run a COUNT(*) query and return the integer result.
 */
function countRows(filePath: string, table: string): number {
  const rows = querySqlite(filePath, `SELECT COUNT(*) AS n FROM ${table};`);
  return rows.length > 0 ? Number(rows[0]["n"]) : 0;
}

/**
 * Derive agentName from a SQLite filename: strip the `.sqlite` extension.
 */
function basenameFromPath(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function agentNameFromPath(filePath: string): string {
  const base = basenameFromPath(filePath);
  return base.endsWith(".sqlite") ? base.slice(0, -7) : base;
}

/**
 * Determine import priority based on chunk count.
 */
function importPriority(chunkCount: number): "high" | "medium" | "low" {
  if (chunkCount === 0) return "low";
  if (chunkCount >= 10) return "high";
  return "medium";
}

/**
 * Return true when any source path from the store begins with one of the
 * given workspace paths.
 */
function hasWorkspaceOverlap(sourcePaths: string[], workspacePaths: string[]): boolean {
  if (workspacePaths.length === 0) return false;
  return sourcePaths.some((sp) =>
    workspacePaths.some((wp) => sp.startsWith(wp))
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Enumerate *.sqlite files in the given directory.
 * Returns a lightweight reference for each file found.
 * Returns [] if the directory does not exist.
 */
export async function discoverSqliteStores(storeDir: string): Promise<SqliteStoreRef[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(storeDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => ({
      filePath: join(storeDir, name),
      agentName: agentNameFromPath(name),
    }));
}

/**
 * Inspect a single SQLite store: read schema row counts, meta, source paths,
 * and sample texts. No writes are performed.
 */
export async function inspectSqliteStore(filePath: string): Promise<SqliteStoreInfo> {
  const agentName = agentNameFromPath(filePath);
  const base: SqliteStoreInfo = {
    filePath,
    agentName,
    readable: false,
    chunkCount: 0,
    fileCount: 0,
    isEmpty: true,
    metaAgentId: null,
    sourcePaths: [],
    sampleTexts: [],
  };

  try {
    // Verify the file is accessible
    await fs.access(filePath);

    const chunkCount = countRows(filePath, "chunks");
    const fileCount = countRows(filePath, "files");

    // Read agent_id from meta table
    let metaAgentId: string | null = null;
    const metaRows = querySqlite(filePath, "SELECT value FROM meta WHERE key = 'agent_id' LIMIT 1;");
    if (metaRows.length > 0) {
      metaAgentId = String(metaRows[0]["value"]);
    }

    // Distinct source file paths
    const pathRows = querySqlite(filePath, "SELECT DISTINCT path FROM files LIMIT 50;");
    const sourcePaths = pathRows.map((r) => String(r["path"]));

    // Sample texts (up to 5 most recent)
    const textRows = querySqlite(
      filePath,
      "SELECT text FROM chunks ORDER BY updated_at DESC LIMIT 5;"
    );
    const sampleTexts = textRows.map((r) => String(r["text"]));

    return {
      ...base,
      readable: true,
      chunkCount,
      fileCount,
      isEmpty: chunkCount === 0,
      metaAgentId,
      sourcePaths,
      sampleTexts,
    };
  } catch (err) {
    return {
      ...base,
      readable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build a full preview of all SQLite stores in the given directory.
 * Combines discovery + inspection + overlap detection + priority assignment.
 * This is the primary entry point for P2-W3 preview output.
 */
export async function buildSqlitePreview(
  options: SqlitePreviewOptions = {}
): Promise<SqlitePreviewResult> {
  const storeDir = options.storeDir ?? defaultStoreDir();
  const workspacePaths = options.workspacePaths ?? [];

  const refs = await discoverSqliteStores(storeDir);

  const entries: SqlitePreviewEntry[] = await Promise.all(
    refs.map(async (ref): Promise<SqlitePreviewEntry> => {
      const info = await inspectSqliteStore(ref.filePath);
      const warnings: string[] = [];

      if (!info.readable) {
        warnings.push(`Cannot read store: ${info.error ?? "unknown error"}`);
      }

      const agentId = info.metaAgentId ?? null;
      const overlap = hasWorkspaceOverlap(info.sourcePaths, workspacePaths);

      if (overlap) {
        warnings.push(
          "Source paths overlap with workspace Markdown — prefer Markdown import to avoid duplication"
        );
      }

      return {
        ...info,
        basename: basenameFromPath(info.filePath),
        agentId,
        importPriority: info.readable ? importPriority(info.chunkCount) : "low",
        overlapWithWorkspaceMarkdown: overlap,
        warnings,
      };
    })
  );

  const totalChunkCount = entries.reduce((sum, e) => sum + e.chunkCount, 0);
  const emptyStoreCount = entries.filter((e) => e.isEmpty).length;

  return {
    sqliteStores: entries,
    summary: {
      sqliteSourceCount: entries.length,
      totalChunkCount,
      emptyStoreCount,
    },
  };
}

/**
 * Render a compact human-readable preview report for CLI / logs.
 */
export function formatSqlitePreviewReport(result: SqlitePreviewResult): string {
  const lines: string[] = [];
  lines.push("SQLite Preview Report");
  lines.push("");

  if (result.sqliteStores.length === 0) {
    lines.push("No SQLite stores discovered.");
  } else {
    for (const entry of result.sqliteStores) {
      lines.push(`- ${entry.agentName} (${entry.basename})`);
      lines.push(
        `  priority=${entry.importPriority} chunks=${entry.chunkCount} files=${entry.fileCount} readable=${entry.readable ? "yes" : "no"}`
      );
      if (entry.agentId) {
        lines.push(`  agentId=${entry.agentId}`);
      }
      if (entry.overlapWithWorkspaceMarkdown) {
        lines.push("  warning=workspace-markdown-overlap");
      }
      for (const warning of entry.warnings) {
        lines.push(`  warning: ${warning}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `Summary: stores=${result.summary.sqliteSourceCount} totalChunks=${result.summary.totalChunkCount} emptyStores=${result.summary.emptyStoreCount}`
  );

  return lines.join("\n");
}
