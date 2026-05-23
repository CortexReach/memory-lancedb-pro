import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readdir } from "node:fs/promises";

type MemorySource = "memory" | "sessions";

type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

type MemorySearchManager = {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      sources?: MemorySource[];
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): Record<string, unknown>;
  sync?(params?: { reason?: string; force?: boolean; sessionFiles?: string[] }): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
};

type MemoryRuntimeStatus = {
  embeddingAvailable: boolean;
  retrievalAvailable: boolean;
  embeddingError?: string;
  retrievalError?: string;
  files?: number;
  chunks?: number;
};

type MemoryCapabilityParams = {
  dbPath: string;
  vectorDim: number;
  embeddingProvider: string;
  embeddingModel: string;
  workspaceDir: string;
  getRuntimeStatus: () => MemoryRuntimeStatus;
  probeEmbeddingAvailability: () => Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability: () => Promise<boolean>;
};

type MemoryPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: "markdown" | "json" | "text";
};

type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

type OpenClawConfigLike = Record<string, unknown>;

const DEFAULT_FLUSH_SOFT_THRESHOLD_TOKENS = 4000;
const DEFAULT_FLUSH_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLUSH_RESERVE_TOKENS_FLOOR = 20000;

const MEMORY_FLUSH_TARGET_HINT =
  "Store durable memories through memory_store and, when file-backed notes are available, append only to memory/YYYY-MM-DD.md.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only reference files during this flush.";
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "Do not overwrite or replace existing memory files; append new facts, decisions, preferences, and open loops only.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function parseByteSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier =
    unit === "gb" || unit === "gib" ? 1024 * 1024 * 1024 :
    unit === "mb" || unit === "mib" ? 1024 * 1024 :
    unit === "kb" || unit === "kib" ? 1024 :
    1;
  return Math.floor(amount * multiplier);
}

function formatDateStamp(nowMs: number, timezone?: string): string {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(nowMs));
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      const day = parts.find((part) => part.type === "day")?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // Fall back to UTC below.
    }
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function resolveTimezone(cfg: OpenClawConfigLike | undefined): string | undefined {
  const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
  const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
  return asString(defaults?.userTimezone);
}

function resolveMemoryFlushConfig(cfg: OpenClawConfigLike | undefined): Record<string, unknown> | undefined {
  const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
  const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
  const compaction = isRecord(defaults?.compaction) ? defaults.compaction : undefined;
  return isRecord(compaction?.memoryFlush) ? compaction.memoryFlush : undefined;
}

function ensureFlushHint(text: string, hint: string): string {
  return text.includes(hint) ? text : `${text.trim()}\n\n${hint}`.trim();
}

function buildMemoryFlushText(raw: unknown, fallback: string): string {
  let text = asString(raw) ?? fallback;
  text = ensureFlushHint(text, MEMORY_FLUSH_TARGET_HINT);
  text = ensureFlushHint(text, MEMORY_FLUSH_READ_ONLY_HINT);
  text = ensureFlushHint(text, MEMORY_FLUSH_APPEND_ONLY_HINT);
  return text;
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveWorkspacePath(value: string): string {
  return resolve(expandUserPath(value));
}

function defaultWorkspaceDir(): string {
  return join(homedir(), ".openclaw", "workspace");
}

function collectConfiguredWorkspaces(cfg: OpenClawConfigLike | undefined): Array<{ workspaceDir: string; agentIds: string[] }> {
  const byWorkspace = new Map<string, Set<string>>();
  const add = (workspaceValue: unknown, agentValue: unknown) => {
    const workspace = asString(workspaceValue);
    if (!workspace) return;
    const agentId = asString(agentValue) ?? "main";
    const workspaceDir = resolveWorkspacePath(workspace);
    const agents = byWorkspace.get(workspaceDir) ?? new Set<string>();
    agents.add(agentId);
    byWorkspace.set(workspaceDir, agents);
  };

  const agents = isRecord(cfg?.agents) ? cfg.agents : undefined;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    add(entry.workspace ?? entry.workspaceDir ?? entry.cwd, entry.id);
  }

  const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
  add(defaults?.workspace ?? defaults?.workspaceDir ?? defaults?.cwd, "main");

  if (byWorkspace.size === 0) byWorkspace.set(defaultWorkspaceDir(), new Set(["main"]));

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

function classifyArtifactKind(relativePath: string): string {
  if (relativePath === "MEMORY.md") return "memory-root";
  if (relativePath.startsWith("memory/dreaming/")) return "dream-report";
  if (relativePath.startsWith("memory/short-term-promotion/")) return "short-term-promotion";
  if (relativePath.startsWith("memory/")) return "daily-note";
  return "memory-artifact";
}

async function collectPublicArtifactsForWorkspace(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPublicArtifact[]> {
  const artifacts: MemoryPublicArtifact[] = [];
  const rootEntries = new Set(
    (await readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  if (rootEntries.has("MEMORY.md")) {
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath: join(params.workspaceDir, "MEMORY.md"),
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  for (const absolutePath of await listMarkdownFilesRecursive(join(params.workspaceDir, "memory"))) {
    const relativePath = relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      kind: classifyArtifactKind(relativePath),
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  return artifacts;
}

function createBootstrapMemoryManager(params: MemoryCapabilityParams): MemorySearchManager {
  return {
    async search() {
      return [];
    },
    async readFile(readParams) {
      return { text: "", path: readParams.relPath };
    },
    status() {
      const status = params.getRuntimeStatus();
      return {
        backend: "builtin",
        provider: "memory-lancedb-pro",
        requestedProvider: params.embeddingProvider,
        model: params.embeddingModel,
        files: status.files,
        chunks: status.chunks,
        dirty: false,
        workspaceDir: params.workspaceDir,
        dbPath: params.dbPath,
        sources: ["memory"],
        fts: {
          enabled: true,
          available: status.retrievalAvailable,
          ...(status.retrievalError ? { error: status.retrievalError } : {}),
        },
        vector: {
          enabled: true,
          available: status.retrievalAvailable,
          semanticAvailable: status.embeddingAvailable,
          dims: params.vectorDim,
          ...(status.retrievalError ? { loadError: status.retrievalError } : {}),
        },
        custom: {
          plugin: "memory-lancedb-pro",
          embeddingError: status.embeddingError,
          capabilityPhase: "bootstrap",
        },
      };
    },
    getCachedEmbeddingAvailability() {
      const status = params.getRuntimeStatus();
      return {
        ok: status.embeddingAvailable,
        ...(status.embeddingError ? { error: status.embeddingError } : {}),
        cached: true,
      };
    },
    async probeEmbeddingAvailability() {
      return await params.probeEmbeddingAvailability();
    },
    async probeVectorStoreAvailability() {
      return await params.probeVectorAvailability();
    },
    async probeVectorAvailability() {
      return await params.probeVectorAvailability();
    },
    async close() {},
  };
}

export function buildMemoryLancePromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: "off" | string;
}): string[] {
  const hasRecall = params.availableTools.has("memory_recall") || params.availableTools.has("memory_search");
  const hasStore = params.availableTools.has("memory_store");
  if (!hasRecall && !hasStore) return [];

  const lines = ["## Memory Recall"];
  if (hasRecall) {
    lines.push(
      "Before answering questions about prior work, decisions, dates, people, preferences, or todos, query memory-lancedb-pro and ground the answer in retrieved memories when confidence is high.",
    );
  }
  if (hasStore) {
    lines.push(
      "When the user gives durable preferences, decisions, facts, corrections, or reusable project context, store them with memory_store.",
    );
  }
  if (params.citationsMode === "off") {
    lines.push("Citations are disabled: do not mention memory paths or line numbers unless the user explicitly asks.");
  } else {
    lines.push("When grounded file-backed memory results are available, include concise source references when they help verification.");
  }
  lines.push("");
  return lines;
}

export function buildMemoryLanceFlushPlan(params: {
  cfg?: OpenClawConfigLike;
  nowMs?: number;
} = {}): MemoryFlushPlan | null {
  const flushConfig = resolveMemoryFlushConfig(params.cfg);
  if (flushConfig?.enabled === false) return null;

  const nowMs = Number.isFinite(params.nowMs) ? params.nowMs! : Date.now();
  const dateStamp = formatDateStamp(nowMs, resolveTimezone(params.cfg));
  const relativePath = `memory/${dateStamp}.md`;
  const prompt = buildMemoryFlushText(
    flushConfig?.prompt,
    [
      "Pre-compaction memory flush.",
      MEMORY_FLUSH_TARGET_HINT,
      MEMORY_FLUSH_READ_ONLY_HINT,
      MEMORY_FLUSH_APPEND_ONLY_HINT,
      "If there is nothing durable to store, reply with NO_REPLY.",
    ].join(" "),
  ).replaceAll("YYYY-MM-DD", dateStamp);
  const systemPrompt = buildMemoryFlushText(
    flushConfig?.systemPrompt,
    [
      "Pre-compaction memory flush turn.",
      "Capture only durable memories before the session compacts.",
      MEMORY_FLUSH_TARGET_HINT,
      MEMORY_FLUSH_READ_ONLY_HINT,
      MEMORY_FLUSH_APPEND_ONLY_HINT,
      "Usually NO_REPLY is correct when no new durable memory exists.",
    ].join(" "),
  ).replaceAll("YYYY-MM-DD", dateStamp);

  return {
    softThresholdTokens: asPositiveInt(flushConfig?.softThresholdTokens) ?? DEFAULT_FLUSH_SOFT_THRESHOLD_TOKENS,
    forceFlushTranscriptBytes: parseByteSize(flushConfig?.forceFlushTranscriptBytes) ?? DEFAULT_FLUSH_TRANSCRIPT_BYTES,
    reserveTokensFloor: asPositiveInt(
      isRecord(params.cfg?.agents) && isRecord(params.cfg.agents.defaults) && isRecord(params.cfg.agents.defaults.compaction)
        ? params.cfg.agents.defaults.compaction.reserveTokensFloor
        : undefined,
    ) ?? DEFAULT_FLUSH_RESERVE_TOKENS_FLOOR,
    model: asString(flushConfig?.model),
    prompt,
    systemPrompt,
    relativePath,
  };
}

export function createMemoryLancePublicArtifactsProvider() {
  return {
    async listArtifacts(params: { cfg?: OpenClawConfigLike }): Promise<MemoryPublicArtifact[]> {
      const artifacts: MemoryPublicArtifact[] = [];
      for (const workspace of collectConfiguredWorkspaces(params.cfg)) {
        artifacts.push(...await collectPublicArtifactsForWorkspace(workspace));
      }

      const seen = new Set<string>();
      return artifacts
        .filter((artifact) => {
          const key = `${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((left, right) =>
          left.workspaceDir.localeCompare(right.workspaceDir) ||
          left.relativePath.localeCompare(right.relativePath) ||
          left.kind.localeCompare(right.kind),
        );
    },
  };
}

export function createOpenClawMemoryCapability(params: MemoryCapabilityParams) {
  const manager = createBootstrapMemoryManager(params);
  return {
    promptBuilder: buildMemoryLancePromptSection,
    flushPlanResolver: buildMemoryLanceFlushPlan,
    runtime: {
      async getMemorySearchManager() {
        return { manager };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
      async closeAllMemorySearchManagers() {
        await manager.close?.();
      },
    },
    publicArtifacts: createMemoryLancePublicArtifactsProvider(),
  };
}
