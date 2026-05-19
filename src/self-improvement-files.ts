import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LEARNINGS_TEMPLATE = `# Learnings

Append structured entries:
- LRN-YYYYMMDD-XXX for corrections / best practices / knowledge gaps
- Include summary, details, suggested action, metadata, and status`;

export const DEFAULT_ERRORS_TEMPLATE = `# Errors

Append structured entries:
- ERR-YYYYMMDD-XXX for command/tool/integration failures
- Include symptom, context, probable cause, and prevention`;

const fileWriteQueues = new Map<string, Promise<void>>();
export const DEFAULT_SELF_IMPROVEMENT_MAX_ENTRIES = 500;

async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  fileWriteQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  }
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function nextLearningIdFromContent(content: string, prefix: "LRN" | "ERR", date = todayYmd()): string {
  const matches = content.match(new RegExp(`\\[${prefix}-${date}-\\d{3}\\]`, "g"));
  const count = matches?.length ?? 0;
  return `${prefix}-${date}-${String(count + 1).padStart(3, "0")}`;
}

export function countSelfImprovementEntries(content: string, prefix?: "LRN" | "ERR"): number {
  const pattern = prefix
    ? new RegExp(`^## \\[${prefix}-\\d{8}-\\d{3}\\]`, "gm")
    : /^## \[(?:LRN|ERR)-\d{8}-\d{3}\]/gm;
  return (content.match(pattern) || []).length;
}

function normalizeMaxEntries(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SELF_IMPROVEMENT_MAX_ENTRIES;
  }
  return Math.floor(parsed);
}

export async function ensureSelfImprovementLearningFiles(baseDir: string): Promise<void> {
  const learningsDir = join(baseDir, ".learnings");
  await mkdir(learningsDir, { recursive: true });

  const ensureFile = async (filePath: string, content: string) => {
    try {
      const existing = await readFile(filePath, "utf-8");
      if (existing.trim().length > 0) return;
    } catch {
      // write default below
    }
    await writeFile(filePath, `${content.trim()}\n`, "utf-8");
  };

  await ensureFile(join(learningsDir, "LEARNINGS.md"), DEFAULT_LEARNINGS_TEMPLATE);
  await ensureFile(join(learningsDir, "ERRORS.md"), DEFAULT_ERRORS_TEMPLATE);
}

export interface AppendSelfImprovementEntryParams {
  baseDir: string;
  type: "learning" | "error";
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
  maxEntries?: number;
}

export async function appendSelfImprovementEntry(params: AppendSelfImprovementEntryParams): Promise<{
  id: string;
  filePath: string;
  skipped: boolean;
  entryCount: number;
  maxEntries: number;
}> {
  const {
    baseDir,
    type,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    status = "pending",
    source = "memory-lancedb-pro/self_improvement_log",
    maxEntries,
  } = params;

  await ensureSelfImprovementLearningFiles(baseDir);
  const learningsDir = join(baseDir, ".learnings");
  const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
  const filePath = join(learningsDir, fileName);
  const idPrefix = type === "learning" ? "LRN" : "ERR";
  const effectiveMaxEntries = normalizeMaxEntries(maxEntries);

  const result = await withFileWriteQueue(filePath, async () => {
    const prev = await readFile(filePath, "utf-8").catch(() => "");
    const entryCount = countSelfImprovementEntries(prev, idPrefix);
    if (entryCount >= effectiveMaxEntries) {
      return {
        id: "",
        skipped: true,
        entryCount,
      };
    }

    const entryId = nextLearningIdFromContent(prev, idPrefix);
    const nowIso = new Date().toISOString();
    const titleSuffix = type === "learning" ? ` ${category}` : "";
    const entry = [
      `## [${entryId}]${titleSuffix}`,
      "",
      `**Logged**: ${nowIso}`,
      `**Priority**: ${priority}`,
      `**Status**: ${status}`,
      `**Area**: ${area}`,
      "",
      "### Summary",
      summary.trim(),
      "",
      "### Details",
      details.trim() || "-",
      "",
      "### Suggested Action",
      suggestedAction.trim() || "-",
      "",
      "### Metadata",
      `- Source: ${source}`,
      "---",
      "",
    ].join("\n");
    const separator = prev.trimEnd().length > 0 ? "\n\n" : "";
    await appendFile(filePath, `${separator}${entry}`, "utf-8");
    return {
      id: entryId,
      skipped: false,
      entryCount: entryCount + 1,
    };
  });

  return { ...result, filePath, maxEntries: effectiveMaxEntries };
}
