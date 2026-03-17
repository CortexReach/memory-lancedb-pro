/**
 * Skill Bridge — Import external learning/instinct data
 *
 * Imports data from:
 * 1. .learnings/ directories (hiveminderbot/self-improving-agent format)
 * 2. instincts JSONL files (continuous-learning-v2 format)
 *
 * Uses store.importEntry() to preserve original timestamps.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { stringifySmartMetadata } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillBridgeContext {
  store: MemoryStore;
  embedder: Embedder;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

// ============================================================================
// Import from .learnings/ directory
// ============================================================================

/**
 * Parse LEARNINGS.md / ERRORS.md files and import entries as skill observations.
 *
 * Expected format:
 * ```
 * [LRN-20260317-001] summary text
 * - details...
 *
 * [ERR-20260317-002] error summary
 * - symptom: ...
 * ```
 */
export async function importLearnings(
  ctx: SkillBridgeContext,
  dir: string,
  scope: string,
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  const files: string[] = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.endsWith(".md")) {
        files.push(join(dir, name));
      }
    }
  } catch {
    return { imported: 0, skipped: 0 };
  }

  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const entries = parseLearningEntries(content);

    for (const entry of entries) {
      const isDuplicate = await checkDuplicate(ctx, entry.text, scope);
      if (isDuplicate) {
        skipped++;
        continue;
      }

      const vector = await ctx.embedder.embed(entry.text);
      const memoryEntry: MemoryEntry = {
        id: randomUUID(),
        text: entry.text,
        vector,
        category: "other",
        scope,
        importance: entry.type === "error" ? 0.8 : 0.6,
        timestamp: entry.timestamp,
        metadata: stringifySmartMetadata({
          skill_obs_type: "observation",
          skill_id: "imported-learning",
          outcome: entry.type === "error" ? "failure" : "partial",
          outcome_signal: entry.type === "error" ? "error" : "user_override",
          trace_summary: entry.text.slice(0, 300),
          source: "learnings-import",
        }),
      };

      await ctx.store.importEntry(memoryEntry);
      imported++;
    }
  }

  return { imported, skipped };
}

// ============================================================================
// Import from instincts JSONL
// ============================================================================

/**
 * Parse instincts JSONL file and import entries as skill observations.
 *
 * Expected format (one JSON object per line):
 * ```
 * {"pattern": "...", "confidence": 0.7, "domain": "...", "evidence": [...], "timestamp": 1710000000000}
 * ```
 */
export async function importInstincts(
  ctx: SkillBridgeContext,
  file: string,
  scope: string,
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch {
    return { imported: 0, skipped: 0 };
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    const text =
      typeof record.pattern === "string"
        ? record.pattern
        : typeof record.description === "string"
          ? record.description
          : typeof record.text === "string"
            ? record.text
            : null;

    if (!text || text.length < 5) {
      skipped++;
      continue;
    }

    const isDuplicate = await checkDuplicate(ctx, text, scope);
    if (isDuplicate) {
      skipped++;
      continue;
    }

    const timestamp =
      typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? record.timestamp
        : typeof record.created_at === "number" &&
            Number.isFinite(record.created_at)
          ? record.created_at
          : Date.now();

    const domain =
      typeof record.domain === "string" ? record.domain : undefined;

    const vector = await ctx.embedder.embed(text);
    const memoryEntry: MemoryEntry = {
      id: randomUUID(),
      text,
      vector,
      category: "other",
      scope,
      importance: 0.6,
      timestamp,
      metadata: stringifySmartMetadata({
        skill_obs_type: "observation",
        skill_id: domain || "imported-instinct",
        outcome: "partial",
        outcome_signal: "user_override",
        trace_summary: text.slice(0, 300),
        source: "instincts-import",
      }),
    };

    await ctx.store.importEntry(memoryEntry);
    imported++;
  }

  return { imported, skipped };
}

// ============================================================================
// Helpers
// ============================================================================

interface ParsedLearningEntry {
  type: "learning" | "error";
  id: string;
  text: string;
  timestamp: number;
}

function parseLearningEntries(content: string): ParsedLearningEntry[] {
  const entries: ParsedLearningEntry[] = [];

  // Match entries like [LRN-20260317-001] or [ERR-20260317-001]
  const entryRegex = /\[(LRN|ERR)-(\d{8})-(\d{3})\]\s*([\s\S]*?)(?=\n\[(LRN|ERR)-\d{8}-\d{3}\]|$)/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(content)) !== null) {
    const type = match[1] === "ERR" ? "error" as const : "learning" as const;
    const dateStr = match[2];
    const id = `${match[1]}-${match[2]}-${match[3]}`;
    const body = match[4].trim();

    if (body.length < 5) continue;

    // Parse date from YYYYMMDD format
    const year = parseInt(dateStr.slice(0, 4), 10);
    const month = parseInt(dateStr.slice(4, 6), 10) - 1;
    const day = parseInt(dateStr.slice(6, 8), 10);
    const timestamp = new Date(year, month, day).getTime();

    entries.push({
      type,
      id,
      text: `[${id}] ${body}`,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
  }

  return entries;
}

async function checkDuplicate(
  ctx: SkillBridgeContext,
  text: string,
  scope: string,
): Promise<boolean> {
  try {
    const vector = await ctx.embedder.embed(text);
    const results = await ctx.store.vectorSearch(vector, 1, 0.95, [scope]);
    return results.length > 0;
  } catch {
    return false;
  }
}
