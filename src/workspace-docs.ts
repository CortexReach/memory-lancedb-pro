import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryEntry, MemoryStore } from "./store.js";
import { applyPromotionPolicy } from "./promotion-policy.js";

interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface WorkspaceDocsMaterializerOptions {
  store: MemoryStore;
  workspaceDir: string;
  markerPrefix?: string;
  logger?: LoggerLike;
}

interface RefreshOptions {
  reason?: string;
}

const MANAGED_FILES = [
  "USER.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "HEARTBEAT.md",
  "TOOLS.md",
] as const;

const writeQueues = new Map<string, Promise<void>>();

export class WorkspaceDocsMaterializer {
  private readonly markerPrefix: string;

  constructor(private readonly options: WorkspaceDocsMaterializerOptions) {
    this.markerPrefix = options.markerPrefix || "memory-lancedb-pro";
  }

  async refresh(options: RefreshOptions = {}): Promise<void> {
    const entries = await this.options.store.list(undefined, undefined, 400, 0);
    const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
    const now = new Date().toISOString();
    const reason = options.reason || "scheduled";

    const docs = buildDocs({
      entries: sorted,
      generatedAt: now,
      reason,
    });

    await Promise.all(
      MANAGED_FILES.map(async (fileName) => {
        const key = fileName.replace(/\.md$/i, "");
        const content = docs[key] || defaultSection({ key, generatedAt: now, reason });
        await this.writeManagedSection(fileName, key, content);
      }),
    );

    this.options.logger?.info?.(
      `workspace-docs: refreshed ${MANAGED_FILES.length} files (reason=${reason})`,
    );
  }

  private async writeManagedSection(fileName: string, sectionKey: string, body: string): Promise<void> {
    const filePath = join(this.options.workspaceDir, fileName);
    const begin = `<!-- ${this.markerPrefix}:begin ${sectionKey} -->`;
    const end = `<!-- ${this.markerPrefix}:end ${sectionKey} -->`;
    const managedBlock = `${begin}\n${body.trimEnd()}\n${end}`;

    await withFileWriteQueue(filePath, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      let existing = "";
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        existing = `# ${sectionKey}\n\n`;
      }

      const next = upsertManagedBlock(existing, managedBlock, begin, end);
      await writeFile(filePath, next, "utf-8");
    });
  }
}

export function createWorkspaceDocsMaterializer(
  options: WorkspaceDocsMaterializerOptions,
): WorkspaceDocsMaterializer {
  return new WorkspaceDocsMaterializer(options);
}

function defaultSection(input: { key: string; generatedAt: string; reason: string }): string {
  return [
    `Generated: ${input.generatedAt}`,
    `Reason: ${input.reason}`,
    "",
    "No promoted entries yet.",
  ].join("\n");
}

function buildDocs(input: {
  entries: MemoryEntry[];
  generatedAt: string;
  reason: string;
}): Record<string, string> {
  const policy = applyPromotionPolicy(input.entries);

  const recent = input.entries.slice(0, 30);
  const prefs = policy.promotedByTarget.USER
    .filter((entry) => entry.category === "preference")
    .slice(0, 12);
  const decisions = policy.promotedByTarget.AGENTS
    .filter((entry) => entry.category === "decision")
    .slice(0, 12);
  const entities = policy.promotedByTarget.USER
    .filter((entry) => entry.category === "entity")
    .slice(0, 12);
  const identityRows = policy.promotedByTarget.IDENTITY.slice(0, 12);
  const soulRows = policy.promotedByTarget.SOUL.slice(0, 12);

  const durableForMemory = input.entries
    .filter((e) => e.category !== "reflection")
    .slice(0, 40);
  const inferredCandidates = policy.inferredCandidates.slice(0, 16);
  const queueRows = policy.queue.slice(0, 16);

  const lines = (rows: MemoryEntry[], maxText = 160) =>
    rows.map((row) => `- [${new Date(row.timestamp).toISOString()}] [${row.category}:${row.scope}] ${row.text.replace(/\s+/g, " ").slice(0, maxText)}`);

  return {
    USER: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "Mode: conservative (promoted preferences/entities only)",
      "",
      "## Stable Preferences",
      ...(prefs.length > 0 ? lines(prefs, 140) : ["- No promoted preferences yet."]),
      "",
      "## User Entities",
      ...(entities.length > 0 ? lines(entities, 140) : ["- No promoted entities yet."]),
    ].join("\n"),
    AGENTS: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "Mode: conservative (durable decisions only)",
      "",
      "## Durable Decisions",
      ...(decisions.length > 0 ? lines(decisions, 150) : ["- No promoted decisions yet."]),
    ].join("\n"),
    IDENTITY: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "Mode: conservative",
      "",
      "## Identity Notes",
      ...(identityRows.length > 0
        ? lines(identityRows, 140)
        : ["- Identity promotions are reserved for asserted, high-confidence entries.", "- No identity-level promotions yet."]),
    ].join("\n"),
    MEMORY: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "",
      "## Durable Memory Summary",
      ...(durableForMemory.length > 0 ? lines(durableForMemory) : ["- No durable memories available."]),
      "",
      "## Inferred Candidates",
      ...(inferredCandidates.length > 0 ? lines(inferredCandidates, 150) : ["- No inferred candidates yet."]),
    ].join("\n"),
    SOUL: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "Mode: conservative",
      "",
      "## Long-Term Principles",
      ...(soulRows.length > 0
        ? lines(soulRows, 150)
        : ["- Soul-level principles require repeated high-confidence evidence.", "- No soul-level promotions yet."]),
    ].join("\n"),
    HEARTBEAT: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "",
      "## Recent Activity",
      ...(recent.length > 0 ? lines(recent, 120) : ["- No recent memory activity."]),
      "",
      "## Pending Verification",
      ...(inferredCandidates.length > 0 ? lines(inferredCandidates.slice(0, 10), 120) : ["- No pending inferred candidates."]),
      "",
      "## Promotion Queue",
      ...(queueRows.length > 0
        ? queueRows.map((item) => `- [${item.target}] ${item.entry.text.replace(/\s+/g, " ").slice(0, 120)} (reason=${item.reason}, confidence=${item.confidence.toFixed(2)}, repeat=${item.repeatCount})`)
        : ["- Promotion queue is empty."]),
      "",
      "## Queue Reason Stats",
      ...(Object.keys(policy.reasonStats).length > 0
        ? Object.entries(policy.reasonStats)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `- ${reason}: ${count}`)
        : ["- No queue reason stats available."]),
      "",
      "## Contradictions",
      ...(policy.contradictions.length > 0
        ? policy.contradictions.slice(0, 8).map((item) => `- ${item.positive.slice(0, 80)} <-> ${item.negative.slice(0, 80)}`)
        : ["- No contradictions detected."]),
    ].join("\n"),
    TOOLS: [
      `Generated: ${input.generatedAt}`,
      `Reason: ${input.reason}`,
      "Mode: conservative",
      "",
      "## Verified Tool Notes",
      "- Tool guidance is only promoted from verified, repeated evidence.",
      "- No promoted tool governance notes yet.",
    ].join("\n"),
  };
}

function upsertManagedBlock(content: string, managedBlock: string, begin: string, end: string): string {
  const beginEscaped = escapeRegExp(begin);
  const endEscaped = escapeRegExp(end);
  const blockRegex = new RegExp(`${beginEscaped}[\\s\\S]*?${endEscaped}`, "m");

  if (blockRegex.test(content)) {
    return content.replace(blockRegex, managedBlock);
  }

  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  return `${normalized}\n${managedBlock}\n`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  writeQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}
