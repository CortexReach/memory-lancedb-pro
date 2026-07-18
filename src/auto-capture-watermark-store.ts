import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const AUTO_CAPTURE_WATERMARK_FILE_NAME = ".auto-capture-watermark.json";

/**
 * Sidecar file lives next to the LanceDB dir (dirname of dbPath), matching
 * the existing .compaction-state.json convention -- not inside dbPath itself,
 * so a stray file never confuses LanceDB's own directory scanning.
 */
function watermarkFilePath(dbPath: string): string {
  return join(dirname(dbPath), AUTO_CAPTURE_WATERMARK_FILE_NAME);
}

/**
 * Rehydrate the auto-capture seen-text watermark from disk. Synchronous
 * (called once, at plugin init, alongside other startup-time sync fs reads)
 * and fail-open: a missing or malformed file yields an empty map, which is
 * exactly a genuinely fresh session's starting state.
 */
export function loadAutoCaptureWatermarks(dbPath: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = readFileSync(watermarkFilePath(dbPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          map.set(key, value);
        }
      }
    }
  } catch {
    // Missing or malformed file -- treat as a fresh watermark.
  }
  return map;
}

/**
 * Persist a full snapshot of the auto-capture seen-text watermark to disk.
 * Async and best-effort: never throws, so a write failure (disk full,
 * permissions) cannot crash or block the auto-capture hook that calls it.
 * `onWarning` receives a message on failure so the caller can log it.
 *
 * Callers are expected to prune the map to its bounded size (see
 * pruneMapIfOver / AUTO_CAPTURE_MAP_MAX_ENTRIES in index.ts) before calling
 * this, so the persisted file inherits the same unbounded-growth guard as
 * the in-memory Map.
 */
export async function saveAutoCaptureWatermarks(
  dbPath: string,
  map: Map<string, number>,
  onWarning?: (message: string) => void,
): Promise<void> {
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const file = watermarkFilePath(dbPath);
    await mkdir(dirname(file), { recursive: true });
    const snapshot: Record<string, number> = {};
    for (const [key, value] of map) snapshot[key] = value;
    await writeFile(file, JSON.stringify(snapshot), "utf8");
  } catch (err) {
    onWarning?.(`memory-lancedb-pro: auto-capture watermark persistence failed: ${String(err)}`);
  }
}
