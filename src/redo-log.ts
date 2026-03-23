/**
 * Redo Log — Crash Recovery via Redo Markers
 *
 * Prevents silent memory loss when the process dies mid-extraction.
 * Each extraction task writes a redo marker before starting and deletes it
 * on success. Orphaned markers are recovered on next plugin init.
 *
 * Storage: {dbPath}/_redo/{taskId}.json
 */

import { writeFile, unlink, readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface RedoMarker {
  taskId: string;             // crypto.randomUUID()
  sessionKey: string;
  conversationText: string;
  scope: string;
  scopeFilter?: string[];
  agentId: string;
  createdAt: number;
  version: 1;
}

// ============================================================================
// Redo Log Operations
// ============================================================================

/**
 * Resolve the _redo directory path and ensure it exists.
 */
async function ensureRedoDir(dbPath: string): Promise<string> {
  const redoDir = join(dbPath, "_redo");
  await mkdir(redoDir, { recursive: true });
  return redoDir;
}

/**
 * Write a redo marker atomically using exclusive-create flag.
 * Throws if the file already exists (shouldn't happen with UUIDs).
 */
export async function writeRedoMarker(
  dbPath: string,
  marker: RedoMarker,
): Promise<void> {
  const redoDir = await ensureRedoDir(dbPath);
  const filePath = join(redoDir, `${marker.taskId}.json`);
  const content = JSON.stringify(marker, null, 2);
  await writeFile(filePath, content, { flag: "wx" });
}

/**
 * Delete a redo marker after successful extraction.
 */
export async function deleteRedoMarker(
  dbPath: string,
  taskId: string,
): Promise<void> {
  const redoDir = join(dbPath, "_redo");
  const filePath = join(redoDir, `${taskId}.json`);
  try {
    await unlink(filePath);
  } catch (err: any) {
    // Silently ignore if file already deleted (e.g. concurrent cleanup)
    if (err?.code !== "ENOENT") throw err;
  }
}

/**
 * Scan for orphaned redo markers in the _redo directory.
 * Returns all valid markers sorted by createdAt ascending.
 */
export async function scanRedoMarkers(
  dbPath: string,
): Promise<RedoMarker[]> {
  const redoDir = join(dbPath, "_redo");
  let files: string[];
  try {
    files = await readdir(redoDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const markers: RedoMarker[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(redoDir, file), "utf-8");
      const parsed = JSON.parse(content);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.taskId === "string" &&
        typeof parsed.sessionKey === "string" &&
        typeof parsed.conversationText === "string" &&
        typeof parsed.scope === "string" &&
        typeof parsed.agentId === "string" &&
        typeof parsed.createdAt === "number" &&
        parsed.version === 1
      ) {
        markers.push(parsed as RedoMarker);
      }
    } catch {
      // Skip corrupted marker files
    }
  }

  // Sort oldest first for sequential recovery
  markers.sort((a, b) => a.createdAt - b.createdAt);
  return markers;
}

/**
 * Check if a marker is stale (older than maxAgeMs).
 */
export function isStale(marker: RedoMarker, maxAgeMs: number): boolean {
  return Date.now() - marker.createdAt > maxAgeMs;
}

/**
 * Create a new redo marker with a fresh UUID.
 */
export function createRedoMarker(params: {
  sessionKey: string;
  conversationText: string;
  scope: string;
  scopeFilter?: string[];
  agentId: string;
}): RedoMarker {
  return {
    taskId: randomUUID(),
    sessionKey: params.sessionKey,
    conversationText: params.conversationText,
    scope: params.scope,
    scopeFilter: params.scopeFilter,
    agentId: params.agentId,
    createdAt: Date.now(),
    version: 1,
  };
}
