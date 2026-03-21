/**
 * First-run / initialization scaffolding
 *
 * Provides non-blocking detection of:
 *   - Whether this is the first time the plugin has run in a given dbPath
 *   - Whether an existing install needs a version upgrade
 *   - Upgrade candidates from OpenClaw's real agent/workspace layout:
 *       • legacy LanceDB paths (pre-pro migration)
 *       • per-agent workspace dirs (MEMORY.md / memory/YYYY-MM-DD.md)
 *       • per-agent SQLite stores (~/.openclaw/memory/{id}.sqlite)
 *
 * Discovery is config-first: reads ~/.openclaw/openclaw.json to enumerate
 * registered agents and their workspace paths.  Falls back to filesystem
 * heuristics (workspace* glob) when the config is absent or unreadable.
 *
 * Non-destructive by design: this module never modifies openclaw.json, never
 * moves SQLite files, and never alters workspace directories.  The plugin
 * acts as an optional management layer; disabling it leaves all existing
 * agent files fully intact and usable.
 *
 * No interactive migration is performed here; detection only.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, access, readdir, stat } from "node:fs/promises";

// ============================================================================
// Types
// ============================================================================

export type InitStatus = "first-run" | "initialized" | "needs-upgrade";

export interface InitMarker {
  /** Plugin semver that wrote this marker */
  version: string;
  /** Unix epoch ms when the marker was written */
  initializedAt: number;
}

export interface InitCheckResult {
  status: InitStatus;
  /** Present when status is 'initialized' or 'needs-upgrade' */
  marker?: InitMarker;
}

/** A workspace directory that contains importable historical memory */
export interface WorkspaceMemorySource {
  /** Absolute path to the workspace root directory */
  workspacePath: string;
  /** Whether a MEMORY.md file was found at the workspace root */
  hasMemoryMd: boolean;
  /** Whether a memory/ subdirectory was found at the workspace root */
  hasMemoryDir: boolean;
  /**
   * Basenames of YYYY-MM-DD.md files found inside memory/ (empty if
   * hasMemoryDir is false or the directory contains no dated files)
   */
  memoryDirDateFiles: string[];
  /**
   * Agent ID this workspace belongs to, when derived from openclaw.json.
   * Undefined in filesystem-fallback mode.
   */
  agentId?: string;
}

/** A per-agent SQLite memory store found under the memory directory */
export interface SqliteMemoryStore {
  /** Absolute path to the .sqlite file */
  filePath: string;
  /** Basename of the file (e.g. "main.sqlite") */
  basename: string;
  /** Agent name derived from basename without the .sqlite extension */
  agentName: string;
  /**
   * Agent ID from openclaw.json whose id matches this file's agentName.
   * Undefined when no matching agent was found in config (unregistered store
   * or filesystem-fallback mode).
   */
  agentId?: string;
}

export interface UpgradeCandidates {
  /**
   * How candidate workspace/sqlite sources were discovered:
   *   - "config": openclaw.json was read and agent list drove workspace roots
   *   - "filesystem-fallback": config absent/unreadable; workspace* glob used
   */
  discoveryMode: "config" | "filesystem-fallback";
  /**
   * Agent workspace directories that contain MEMORY.md or a memory/ dir with
   * dated files — candidate sources for a future historical-memory import flow
   */
  workspaceMemorySources: WorkspaceMemorySource[];
  /**
   * Per-agent SQLite stores found under ~/.openclaw/memory/*.sqlite —
   * candidate sources for a future import flow
   */
  sqliteStores: SqliteMemoryStore[];
}

export interface DetectUpgradeCandidatesOptions {
  /**
   * Override the list of workspace root directories to scan.
   * When provided (even as []), replaces both config-derived and glob-derived roots.
   * (Used in tests to avoid touching real workspace directories.)
   */
  overrideWorkspaceRoots?: string[];
  /**
   * Override the directory scanned for *.sqlite stores.
   * When provided, replaces the default ~/.openclaw/memory path.
   * (Used in tests to avoid touching real memory directories.)
   */
  overrideSqliteDir?: string;
  /**
   * Override the path to openclaw.json.
   * When provided, reads config from this path instead of ~/.openclaw/openclaw.json.
   * (Used in tests to supply fake configs or force filesystem-fallback mode.)
   */
  overrideConfigPath?: string;
}

// ============================================================================
// Internal: OpenClaw config parsing
// ============================================================================

interface OpenClawAgentConfig {
  id: string;
  /** Resolved workspace path: agent.workspace ?? defaults.workspace */
  workspace: string;
}

/**
 * Parse openclaw.json at the given path and return the agent list with
 * resolved workspace paths.  Returns null on any read or parse error.
 */
async function readOpenClawAgents(configPath: string): Promise<OpenClawAgentConfig[] | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;

  const agentsSection = root.agents;
  if (!agentsSection || typeof agentsSection !== "object") return null;
  const agents = agentsSection as Record<string, unknown>;

  const defaults = (agents.defaults && typeof agents.defaults === "object")
    ? agents.defaults as Record<string, unknown>
    : {};
  const defaultWorkspace = typeof defaults.workspace === "string" ? defaults.workspace : "";

  if (!Array.isArray(agents.list)) return null;

  const result: OpenClawAgentConfig[] = [];
  for (const entry of agents.list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id) continue;
    const workspace = typeof e.workspace === "string" ? e.workspace : defaultWorkspace;
    if (!workspace) continue;
    result.push({ id, workspace });
  }

  return result.length > 0 ? result : null;
}

// ============================================================================
// Internal: filesystem helpers
// ============================================================================

const MARKER_FILENAME = ".plugin-initialized";
const DATED_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function markerPath(dbPath: string): string {
  return join(dbPath, MARKER_FILENAME);
}

function getDefaultSqliteDir(): string {
  return join(homedir(), ".openclaw", "memory");
}

function getDefaultConfigPath(): string {
  return join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * Filesystem fallback: scan for entries under ~/.openclaw/ whose names start
 * with "workspace".
 */
async function getFilesystemWorkspaceRoots(): Promise<string[]> {
  const openclawDir = join(homedir(), ".openclaw");

  let entries: string[];
  try {
    entries = await readdir(openclawDir);
  } catch {
    return [];
  }

  const roots: string[] = [];
  await Promise.all(
    entries
      .filter((e) => e.startsWith("workspace"))
      .map(async (e) => {
        const full = join(openclawDir, e);
        try {
          const s = await stat(full);
          if (s.isDirectory()) roots.push(full);
        } catch {
          // ignore inaccessible entries
        }
      }),
  );
  return roots;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect a single workspace root for MEMORY.md and/or a memory/ directory
 * with dated files.  Returns null if neither is present (workspace excluded).
 */
async function inspectWorkspace(wsPath: string): Promise<Omit<WorkspaceMemorySource, "agentId"> | null> {
  const [memoryMdExists, memoryDirExists] = await Promise.all([
    pathExists(join(wsPath, "MEMORY.md")),
    pathExists(join(wsPath, "memory")),
  ]);

  if (!memoryMdExists && !memoryDirExists) {
    return null;
  }

  let memoryDirDateFiles: string[] = [];
  if (memoryDirExists) {
    try {
      const entries = await readdir(join(wsPath, "memory"));
      memoryDirDateFiles = entries.filter((e) => DATED_FILE_RE.test(e));
    } catch {
      // directory unreadable — leave list empty
    }
  }

  return {
    workspacePath: wsPath,
    hasMemoryMd: memoryMdExists,
    hasMemoryDir: memoryDirExists,
    memoryDirDateFiles,
  };
}

/**
 * Scan a directory for *.sqlite files and return one record per file.
 * Returns an empty array if the directory does not exist or is unreadable.
 */
async function scanSqliteFiles(
  sqliteDir: string,
): Promise<Array<Omit<SqliteMemoryStore, "agentId">>> {
  let entries: string[];
  try {
    entries = await readdir(sqliteDir);
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.endsWith(".sqlite"))
    .map((basename) => ({
      filePath: join(sqliteDir, basename),
      basename,
      agentName: basename.slice(0, -".sqlite".length),
    }));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check whether this dbPath has been initialized before, and whether the
 * previously recorded version matches `currentVersion`.
 *
 * Returns:
 *   - 'first-run'      — no marker found; this is a fresh install
 *   - 'initialized'    — marker found, version matches currentVersion
 *   - 'needs-upgrade'  — marker found, version differs from currentVersion
 */
export async function checkFirstRun(
  dbPath: string,
  currentVersion: string,
): Promise<InitCheckResult> {
  const mp = markerPath(dbPath);

  let raw: string;
  try {
    raw = await readFile(mp, "utf8");
  } catch {
    return { status: "first-run" };
  }

  let marker: InitMarker;
  try {
    marker = JSON.parse(raw) as InitMarker;
  } catch {
    // Corrupt marker — treat as first-run so a clean marker is written
    return { status: "first-run" };
  }

  if (marker.version === currentVersion) {
    return { status: "initialized", marker };
  }

  return { status: "needs-upgrade", marker };
}

/**
 * Write (or overwrite) the initialization marker for dbPath.
 * Creates dbPath if it does not exist.
 */
export async function writeInitMarker(
  dbPath: string,
  version: string,
): Promise<void> {
  await mkdir(dbPath, { recursive: true });
  const marker: InitMarker = { version, initializedAt: Date.now() };
  await writeFile(markerPath(dbPath), JSON.stringify(marker, null, 2), "utf8");
}

/**
 * Scan for upgrade candidates from three source types, grounded in the real
 * OpenClaw agent/workspace layout:
 *
 * 1. **Legacy LanceDB paths** — directories from the original memory-lancedb
 *    plugin that may hold importable vector data.
 *
 * 2. **Workspace memory sources** — per-agent workspace directories containing
 *    MEMORY.md and/or a memory/ subdirectory with YYYY-MM-DD.md files.
 *    Discovery is config-first: workspace paths are read from openclaw.json
 *    `agents.list[].workspace` (falling back to `agents.defaults.workspace`
 *    for agents without an explicit workspace field).  When the config is
 *    absent, a filesystem glob of workspace* directories is used instead.
 *
 * 3. **Per-agent SQLite stores** — *.sqlite files under ~/.openclaw/memory/
 *    representing importable legacy agent memory databases.  Each store is
 *    annotated with an `agentId` when its filename matches a registered
 *    agent's `id` in openclaw.json.
 *
 * The result's `discoveryMode` field indicates whether config was used ("config")
 * or whether we fell back to filesystem heuristics ("filesystem-fallback").
 *
 * All I/O is concurrent and all errors are swallowed per-path; a missing or
 * inaccessible path is simply excluded from results.  This function never
 * modifies openclaw.json or any agent files.
 */
export async function detectUpgradeCandidates(
  options: DetectUpgradeCandidatesOptions = {},
): Promise<UpgradeCandidates> {
  // ── Read OpenClaw config ──────────────────────────────────────────────────
  const configPath = options.overrideConfigPath ?? getDefaultConfigPath();
  const agentConfigs = await readOpenClawAgents(configPath);
  const discoveryMode: "config" | "filesystem-fallback" =
    agentConfigs !== null ? "config" : "filesystem-fallback";

  // ── Workspace roots: explicit override > config > filesystem glob ─────────
  let workspaceRoots: string[];
  if (options.overrideWorkspaceRoots !== undefined) {
    workspaceRoots = options.overrideWorkspaceRoots;
  } else if (agentConfigs !== null) {
    workspaceRoots = agentConfigs.map((a) => a.workspace);
  } else {
    workspaceRoots = await getFilesystemWorkspaceRoots();
  }

  // Build workspace→agentId map for enrichment (config mode only)
  const workspaceToAgentId = new Map<string, string>(
    agentConfigs?.map((a) => [a.workspace, a.id]) ?? [],
  );

  const wsResults = await Promise.all(workspaceRoots.map(inspectWorkspace));
  const workspaceMemorySources: WorkspaceMemorySource[] = wsResults
    .filter((r): r is Omit<WorkspaceMemorySource, "agentId"> => r !== null)
    .map((src) => {
      const agentId = workspaceToAgentId.get(src.workspacePath);
      return agentId !== undefined ? { ...src, agentId } : { ...src };
    });

  // ── Per-agent SQLite stores ───────────────────────────────────────────────
  const sqliteDir =
    options.overrideSqliteDir !== undefined ? options.overrideSqliteDir : getDefaultSqliteDir();
  const rawSqliteFiles = await scanSqliteFiles(sqliteDir);

  // Annotate with agentId when the file's agentName matches a registered agent
  const registeredAgentIds = new Set(agentConfigs?.map((a) => a.id) ?? []);
  const sqliteStores: SqliteMemoryStore[] = rawSqliteFiles.map((s) => {
    const isRegistered = registeredAgentIds.has(s.agentName);
    return isRegistered ? { ...s, agentId: s.agentName } : { ...s };
  });

  return { discoveryMode, workspaceMemorySources, sqliteStores };
}
