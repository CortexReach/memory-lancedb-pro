import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { MemoryEntry, MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";

export type CanonicalCorpusSource = "memory" | "sessions";

export type CanonicalCorpusDocument = {
  workspaceDir: string;
  agentId: string;
  source: CanonicalCorpusSource;
  kind: string;
  relativePath: string;
  absolutePath: string;
  content: string;
  mtimeMs: number;
};

export type CanonicalCorpusConfig = {
  enabled: boolean;
  syncOnSearch: boolean;
  syncIntervalMs: number;
  includeMemoryDir: boolean;
  includeSessionTranscripts: boolean;
  includeDreamingArtifacts: boolean;
  maxSessionFilesPerAgent: number;
  maxFileBytes: number;
};

export type CanonicalCorpusReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

export type CorpusIndexStats = {
  documents: number;
  indexed: number;
  skipped: number;
  errors: string[];
};

type WorkspaceRef = {
  workspaceDir: string;
  agentIds: string[];
};

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const SESSION_INDEX_PREFIX = "sessions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return fallback;
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolvePath(value: string): string {
  return resolve(expandUserPath(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRelativePath(workspaceDir: string, absolutePath: string): string {
  return relative(workspaceDir, absolutePath).replace(/\\/g, "/");
}

function classifyMemoryArtifact(relativePath: string): string {
  if (relativePath === "MEMORY.md") return "memory-root";
  if (relativePath.startsWith("memory/dreaming/")) return "dream-report";
  if (relativePath.startsWith("memory/short-term-promotion/")) return "short-term-promotion";
  if (relativePath.startsWith("memory/")) return "daily-note";
  return "memory-artifact";
}

function memoryScopeForAgent(agentId: string): string {
  return agentId === "main" ? "global" : `agent:${agentId}`;
}

function buildCorpusId(doc: CanonicalCorpusDocument): string {
  return `corpus:${sha256(`${doc.agentId}\0${doc.source}\0${doc.workspaceDir}\0${doc.relativePath}`).slice(0, 48)}`;
}

export function parseCanonicalCorpusConfig(raw: unknown): CanonicalCorpusConfig {
  const cfg = isRecord(raw) ? raw : {};
  return {
    enabled: cfg.enabled !== false,
    syncOnSearch: cfg.syncOnSearch !== false,
    syncIntervalMs: asNonNegativeInt(cfg.syncIntervalMs, 60_000),
    includeMemoryDir: cfg.includeMemoryDir !== false,
    includeSessionTranscripts: cfg.includeSessionTranscripts !== false,
    includeDreamingArtifacts: cfg.includeDreamingArtifacts !== false,
    maxSessionFilesPerAgent: asNonNegativeInt(cfg.maxSessionFilesPerAgent, 25),
    maxFileBytes: asPositiveInt(cfg.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
  };
}

export function resolveCanonicalCorpusWorkspaces(cfg: unknown, homeDir = homedir()): WorkspaceRef[] {
  const byWorkspace = new Map<string, Set<string>>();
  const add = (workspaceValue: unknown, agentValue: unknown) => {
    const workspace = asString(workspaceValue);
    if (!workspace) return;
    const agentId = asString(agentValue) ?? "main";
    const workspaceDir = resolvePath(workspace);
    const agents = byWorkspace.get(workspaceDir) ?? new Set<string>();
    agents.add(agentId);
    byWorkspace.set(workspaceDir, agents);
  };

  const root = isRecord(cfg) ? cfg : {};
  const agents = isRecord(root.agents) ? root.agents : undefined;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    add(entry.workspace ?? entry.workspaceDir ?? entry.cwd, entry.id);
  }

  const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
  add(defaults?.workspace ?? defaults?.workspaceDir ?? defaults?.cwd, "main");

  if (byWorkspace.size === 0) {
    byWorkspace.set(join(homeDir, ".openclaw", "workspace"), new Set(["main"]));
  }

  return [...byWorkspace.entries()].map(([workspaceDir, agentIds]) => ({
    workspaceDir,
    agentIds: [...agentIds].sort((left, right) => left.localeCompare(right)),
  }));
}

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFilesRecursive(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function readBoundedText(filePath: string, maxFileBytes: number): Promise<{ content: string; mtimeMs: number } | null> {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile() || info.size > maxFileBytes) return null;
  return {
    content: await readFile(filePath, "utf8"),
    mtimeMs: info.mtimeMs,
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderSessionTranscript(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const message = isRecord(parsed?.message) ? parsed.message : undefined;
      const role = asString(message?.role);
      const text = extractTextContent(message?.content).trim();
      if (role && text) lines.push(`## ${role}\n${text}`);
    } catch {
      // Ignore non-JSONL fragments.
    }
  }
  return lines.join("\n\n");
}

async function discoverMemoryDocuments(workspace: WorkspaceRef, config: CanonicalCorpusConfig): Promise<CanonicalCorpusDocument[]> {
  if (!config.includeMemoryDir) return [];
  const docs: CanonicalCorpusDocument[] = [];
  const rootMemory = await readBoundedText(join(workspace.workspaceDir, "MEMORY.md"), config.maxFileBytes);
  for (const agentId of workspace.agentIds) {
    if (rootMemory) {
      docs.push({
        workspaceDir: workspace.workspaceDir,
        agentId,
        source: "memory",
        kind: "memory-root",
        relativePath: "MEMORY.md",
        absolutePath: join(workspace.workspaceDir, "MEMORY.md"),
        content: rootMemory.content,
        mtimeMs: rootMemory.mtimeMs,
      });
    }
  }

  const memoryFiles = await listMarkdownFilesRecursive(join(workspace.workspaceDir, "memory"));
  for (const absolutePath of memoryFiles) {
    const relativePath = normalizeRelativePath(workspace.workspaceDir, absolutePath);
    const kind = classifyMemoryArtifact(relativePath);
    if (kind === "dream-report" && !config.includeDreamingArtifacts) continue;
    const read = await readBoundedText(absolutePath, config.maxFileBytes);
    if (!read) continue;
    for (const agentId of workspace.agentIds) {
      docs.push({
        workspaceDir: workspace.workspaceDir,
        agentId,
        source: "memory",
        kind,
        relativePath,
        absolutePath,
        content: read.content,
        mtimeMs: read.mtimeMs,
      });
    }
  }
  return docs;
}

async function discoverSessionDocuments(
  workspace: WorkspaceRef,
  config: CanonicalCorpusConfig,
  homeDir = homedir(),
): Promise<CanonicalCorpusDocument[]> {
  if (!config.includeSessionTranscripts || config.maxSessionFilesPerAgent === 0) return [];
  const docs: CanonicalCorpusDocument[] = [];
  for (const agentId of workspace.agentIds) {
    const sessionsDir = join(homeDir, ".openclaw", "agents", agentId, "sessions");
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const absolutePath = join(sessionsDir, entry.name);
          const info = await stat(absolutePath).catch(() => null);
          return info && info.isFile() ? { absolutePath, name: entry.name, mtimeMs: info.mtimeMs, size: info.size } : null;
        }),
    );
    const recent = candidates
      .filter((entry): entry is { absolutePath: string; name: string; mtimeMs: number; size: number } => entry !== null)
      .filter((entry) => entry.size <= config.maxFileBytes)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, config.maxSessionFilesPerAgent);

    for (const entry of recent) {
      const raw = await readFile(entry.absolutePath, "utf8").catch(() => "");
      const rendered = renderSessionTranscript(raw);
      if (!rendered.trim()) continue;
      docs.push({
        workspaceDir: workspace.workspaceDir,
        agentId,
        source: "sessions",
        kind: "session-transcript",
        relativePath: `${SESSION_INDEX_PREFIX}/${agentId}/${basename(entry.name)}`,
        absolutePath: entry.absolutePath,
        content: rendered,
        mtimeMs: entry.mtimeMs,
      });
    }
  }
  return docs;
}

function countLines(text: string): number {
  return Math.max(1, text.split(/\r?\n/).length);
}

function toMemoryEntry(doc: CanonicalCorpusDocument, vector: number[]): MemoryEntry {
  const metadata = {
    openclaw_corpus: true,
    corpus_source: doc.source,
    corpus_kind: doc.kind,
    corpus_path: doc.relativePath,
    corpus_absolute_path: doc.absolutePath,
    corpus_workspace_dir: doc.workspaceDir,
    corpus_agent_id: doc.agentId,
    corpus_start_line: 1,
    corpus_end_line: countLines(doc.content),
    corpus_content_sha256: sha256(doc.content),
    corpus_mtime_ms: doc.mtimeMs,
    corpus_indexed_at: Date.now(),
  };
  return {
    id: buildCorpusId(doc),
    text: doc.content,
    vector,
    category: doc.kind === "dream-report" ? "reflection" : "other",
    scope: memoryScopeForAgent(doc.agentId),
    importance: doc.source === "memory" ? 0.7 : 0.45,
    timestamp: doc.mtimeMs,
    metadata: JSON.stringify(metadata),
  };
}

function sliceText(text: string, from?: number, lines?: number): CanonicalCorpusReadResult {
  const allLines = text.split(/\r?\n/);
  const start = Math.max(1, Math.floor(from ?? 1));
  const lineCount = Math.max(1, Math.floor(lines ?? allLines.length));
  const selected = allLines.slice(start - 1, start - 1 + lineCount);
  const moreRemain = start - 1 + lineCount < allLines.length;
  return {
    text: selected.join("\n"),
    path: "",
    from: start,
    lines: selected.length,
    ...(moreRemain ? { truncated: true, nextFrom: start + selected.length } : {}),
  };
}

export class CanonicalCorpusIndexer {
  private lastSyncAt = 0;
  private syncPromise: Promise<CorpusIndexStats> | null = null;
  private pathCache = new Map<string, { absolutePath: string; source: CanonicalCorpusSource }>();

  constructor(
    private readonly params: {
      store: Pick<MemoryStore, "upsert">;
      embedder: Pick<Embedder, "embedPassage">;
      getConfig: () => CanonicalCorpusConfig;
      getOpenClawConfig: () => unknown;
      homeDir?: string;
      log?: (message: string) => void;
      warn?: (message: string) => void;
    },
  ) {}

  async discover(): Promise<CanonicalCorpusDocument[]> {
    const config = this.params.getConfig();
    if (!config.enabled) return [];
    const docs: CanonicalCorpusDocument[] = [];
    const homeDir = this.params.homeDir ?? homedir();
    for (const workspace of resolveCanonicalCorpusWorkspaces(this.params.getOpenClawConfig(), homeDir)) {
      docs.push(...await discoverMemoryDocuments(workspace, config));
      docs.push(...await discoverSessionDocuments(workspace, config, homeDir));
    }
    return docs;
  }

  async sync(options: { reason?: string; force?: boolean } = {}): Promise<CorpusIndexStats> {
    const config = this.params.getConfig();
    if (!config.enabled) return { documents: 0, indexed: 0, skipped: 0, errors: [] };
    const now = Date.now();
    if (!options.force && this.lastSyncAt > 0 && now - this.lastSyncAt < config.syncIntervalMs) {
      return { documents: 0, indexed: 0, skipped: 0, errors: [] };
    }
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSync(options.reason ?? "manual").finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runSync(reason: string): Promise<CorpusIndexStats> {
    const docs = await this.discover();
    const stats: CorpusIndexStats = { documents: docs.length, indexed: 0, skipped: 0, errors: [] };
    for (const doc of docs) {
      try {
        const vector = await this.params.embedder.embedPassage(doc.content);
        await this.params.store.upsert(toMemoryEntry(doc, vector));
        this.pathCache.set(doc.relativePath, { absolutePath: doc.absolutePath, source: doc.source });
        stats.indexed++;
      } catch (err) {
        stats.skipped++;
        stats.errors.push(`${doc.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.lastSyncAt = Date.now();
    if (stats.indexed > 0) {
      this.params.log?.(`memory-lancedb-pro: indexed ${stats.indexed}/${stats.documents} canonical corpus document(s) (${reason})`);
    }
    if (stats.errors.length > 0) {
      this.params.warn?.(`memory-lancedb-pro: canonical corpus indexing skipped ${stats.skipped} document(s): ${stats.errors.slice(0, 3).join(" | ")}`);
    }
    return stats;
  }

  async readFile(relPath: string, from?: number, lines?: number): Promise<CanonicalCorpusReadResult | null> {
    const cached = this.pathCache.get(relPath);
    let absolutePath = cached?.absolutePath;
    let content: string | null = null;

    if (absolutePath) {
      if (cached?.source === "sessions") {
        const raw = await readFile(absolutePath, "utf8").catch(() => "");
        content = renderSessionTranscript(raw);
      } else {
        content = await readFile(absolutePath, "utf8").catch(() => "");
      }
    } else if (relPath === "MEMORY.md" || relPath.startsWith("memory/")) {
      for (const workspace of resolveCanonicalCorpusWorkspaces(
        this.params.getOpenClawConfig(),
        this.params.homeDir ?? homedir(),
      )) {
        const candidate = join(workspace.workspaceDir, relPath);
        const raw = await readFile(candidate, "utf8").catch(() => null);
        if (raw != null) {
          absolutePath = candidate;
          content = raw;
          this.pathCache.set(relPath, { absolutePath, source: "memory" });
          break;
        }
      }
    } else if (relPath.startsWith(`${SESSION_INDEX_PREFIX}/`)) {
      const parts = relPath.split("/");
      if (parts.length === 3 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")) {
        absolutePath = join(
          this.params.homeDir ?? homedir(),
          ".openclaw",
          "agents",
          parts[1],
          "sessions",
          parts[2],
        );
        const raw = await readFile(absolutePath, "utf8").catch(() => null);
        if (raw != null) {
          content = renderSessionTranscript(raw);
          this.pathCache.set(relPath, { absolutePath, source: "sessions" });
        }
      }
    }

    if (content == null) return null;
    const result = sliceText(content, from, lines);
    return { ...result, path: relPath };
  }
}

export function parseCanonicalCorpusMetadata(value: unknown): null | {
  source: CanonicalCorpusSource;
  kind: string;
  path: string;
  absolutePath?: string;
  workspaceDir?: string;
  agentId?: string;
  startLine: number;
  endLine: number;
  contentSha256?: string;
  mtimeMs?: number;
} {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed) || parsed.openclaw_corpus !== true) return null;
    const source = parsed.corpus_source === "sessions" ? "sessions" : parsed.corpus_source === "memory" ? "memory" : null;
    const path = asString(parsed.corpus_path);
    if (!source || !path) return null;
    return {
      source,
      kind: asString(parsed.corpus_kind) ?? "memory-artifact",
      path,
      absolutePath: asString(parsed.corpus_absolute_path),
      workspaceDir: asString(parsed.corpus_workspace_dir),
      agentId: asString(parsed.corpus_agent_id),
      startLine: asPositiveInt(parsed.corpus_start_line, 1),
      endLine: asPositiveInt(parsed.corpus_end_line, 1),
      contentSha256: asString(parsed.corpus_content_sha256),
      mtimeMs: typeof parsed.corpus_mtime_ms === "number" ? parsed.corpus_mtime_ms : undefined,
    };
  } catch {
    return null;
  }
}
