import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { MemoryEntry } from "./store.js";

type ImportableMemory = Omit<MemoryEntry, "vector" | "scope">;

interface CollectOptions {
  since?: string;
}

function normalizeText(text: string): string {
  return text.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
}

function stableId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

function isDailyFile(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

function parseDateMs(name: string): number | undefined {
  const base = basename(name, ".md");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return undefined;
  const ms = new Date(`${base}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function classify(text: string, section: string, source: string): { category: ImportableMemory["category"]; importance: number } {
  const content = `${section} ${text}`.toLowerCase();
  if (
    source.endsWith("MEMORY.md") ||
    /user preferences|偏好|铁律|prefer|prefers|wants the assistant|requires strict|must|喜欢|要求/.test(content)
  ) {
    return { category: "preference", importance: 1.0 };
  }
  if (
    /decid|agreed|updated|enabled|disabled|removed|installed|implemented|fixed|positioning|改成|启用|移除|安装|修复|实现|决定|同意/.test(content)
  ) {
    return { category: "decision", importance: 0.84 };
  }
  return { category: "fact", importance: 0.76 };
}

function parseBullets(content: string, source: string, timestamp: number): ImportableMemory[] {
  const memories: ImportableMemory[] = [];
  let section = "root";
  let inCode = false;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)/);
    if (!bullet) continue;
    const text = normalizeText(bullet[1]);
    if (text.length < 8) continue;

    const { category, importance } = classify(text, section, source);
    const id = stableId([source, section, text]);
    memories.push({
      id,
      text,
      category,
      importance,
      timestamp,
      metadata: JSON.stringify({ source, section, line: index + 1 }),
    });
  }

  return memories;
}

export function collectOpenClawMemories(workspace: string, options: CollectOptions = {}): ImportableMemory[] {
  const results: ImportableMemory[] = [];
  const memoryFile = join(workspace, "MEMORY.md");
  if (existsSync(memoryFile)) {
    const stat = statSync(memoryFile);
    results.push(...parseBullets(readFileSync(memoryFile, "utf8"), "MEMORY.md", Math.trunc(stat.mtimeMs)));
  }

  const memoryDir = join(workspace, "memory");
  if (!existsSync(memoryDir)) return results;
  const sinceMs = options.since ? parseDateMs(`${options.since}.md`) : undefined;

  for (const file of readdirSync(memoryDir).filter(isDailyFile).sort()) {
    const fileDate = parseDateMs(file);
    if (sinceMs && fileDate && fileDate < sinceMs) continue;
    const full = join(memoryDir, file);
    const timestamp = fileDate ?? Math.trunc(statSync(full).mtimeMs);
    results.push(...parseBullets(readFileSync(full, "utf8"), `memory/${file}`, timestamp));
  }

  return results;
}
