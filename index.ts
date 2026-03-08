/**
 * Memory LanceDB Pro Plugin
 * Enhanced LanceDB-backed long-term memory with hybrid retrieval and multi-scope isolation
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { readFile, readdir, writeFile, mkdir, appendFile, unlink, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// Import core components
import { MemoryStore, validateStoragePath } from "./src/store.js";
import { createEmbedder, getVectorDimensions } from "./src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG, type RetrievalResult } from "./src/retriever.js";
import { createScopeManager } from "./src/scopes.js";
import { createMigrator } from "./src/migrate.js";
import { registerAllMemoryTools } from "./src/tools.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./src/self-improvement-files.js";
import type { MdMirrorWriter } from "./src/tools.js";
import { AccessTracker } from "./src/access-tracker.js";
import { runWithReflectionTransientRetryOnce } from "./src/reflection-retry.js";
import { resolveReflectionSessionSearchDirs, stripResetSuffix } from "./src/session-recovery.js";
import {
  storeReflectionToLanceDB,
  loadAgentReflectionSlicesFromEntries,
  loadAgentDerivedFocusRowsForHandoffFromEntries,
  DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
  DEFAULT_REFLECTION_DERIVED_FINAL_LIMIT,
  DEFAULT_REFLECTION_DERIVED_SHORTLIST_LIMIT,
} from "./src/reflection-store.js";
import {
  extractReflectionLearningGovernanceCandidates,
  extractReflectionMappedMemoryItems,
  extractReflectionOpenLoops,
} from "./src/reflection-slices.js";
import { createReflectionEventId } from "./src/reflection-event-store.js";
import { buildReflectionMappedMetadata } from "./src/reflection-mapped-metadata.js";
import { createMemoryCLI } from "./cli.js";
import {
  createDynamicRecallSessionState,
  clearDynamicRecallSessionState,
  normalizeRecallTextKey,
  orchestrateDynamicRecall,
  filterByMaxAge,
  keepMostRecentPerNormalizedKey,
} from "./src/recall-engine.js";
import { rankDynamicReflectionRecallFromEntries } from "./src/reflection-recall.js";

// ============================================================================
// Configuration & Types
// ============================================================================

interface PluginConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMinRepeated?: number;
  autoRecallTopK?: number;
  autoRecallCategories?: MemoryCategory[];
  autoRecallExcludeReflection?: boolean;
  autoRecallMaxAgeDays?: number;
  autoRecallMaxEntriesPerKey?: number;
  captureAssistant?: boolean;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
  };
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionMemory?: { enabled?: boolean; messageCount?: number };
  selfImprovement?: {
    enabled?: boolean;
    beforeResetNote?: boolean;
    skipSubagentBootstrap?: boolean;
    ensureLearningFiles?: boolean;
  };
  memoryReflection?: {
    enabled?: boolean;
    storeToLanceDB?: boolean;
    injectMode?: ReflectionInjectMode;
    agentId?: string;
    messageCount?: number;
    maxInputChars?: number;
    timeoutMs?: number;
    thinkLevel?: ReflectionThinkLevel;
    errorReminderMaxEntries?: number;
    dedupeErrorSignals?: boolean;
    recall?: {
      mode?: ReflectionRecallMode;
      topK?: number;
      includeKinds?: ReflectionRecallKind[];
      maxAgeDays?: number;
      maxEntriesPerKey?: number;
      minRepeated?: number;
      minScore?: number;
      minPromptLength?: number;
    };
  };
  mdMirror?: { enabled?: boolean; dir?: string };
}

type ReflectionThinkLevel = "off" | "minimal" | "low" | "medium" | "high";
type SessionStrategy = "memoryReflection" | "systemSessionMemory" | "none";
type ReflectionInjectMode = "inheritance-only" | "inheritance+derived";
type ReflectionRecallMode = "fixed" | "dynamic";
type ReflectionRecallKind = "invariant" | "derived";
type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";

// ============================================================================
// Default Configuration
// ============================================================================

function getDefaultDbPath(): string {
  const home = homedir();
  return join(home, ".openclaw", "memory", "lancedb-pro");
}

function getDefaultWorkspaceDir(): string {
  const home = homedir();
  return join(home, ".openclaw", "workspace");
}

function resolveWorkspaceDirFromContext(context: Record<string, unknown> | undefined): string {
  const runtimePath = typeof context?.workspaceDir === "string" ? context.workspaceDir.trim() : "";
  return runtimePath || getDefaultWorkspaceDir();
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    const resolved = resolveEnvVars(s);
    const n = Number(resolved);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    const resolved = resolveEnvVars(s);
    const n = Number(resolved);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function parseMemoryCategories(value: unknown, fallback: MemoryCategory[]): MemoryCategory[] {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is MemoryCategory =>
      item === "preference" ||
      item === "fact" ||
      item === "decision" ||
      item === "entity" ||
      item === "other" ||
      item === "reflection"
    );
  return parsed.length > 0 ? [...new Set(parsed)] : [...fallback];
}

function parseReflectionRecallKinds(value: unknown, fallback: ReflectionRecallKind[]): ReflectionRecallKind[] {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item): item is ReflectionRecallKind => item === "invariant" || item === "derived");
  return parsed.length > 0 ? [...new Set(parsed)] : [...fallback];
}

function daysToMs(days: number | undefined): number | undefined {
  if (!Number.isFinite(days) || Number(days) <= 0) return undefined;
  return Number(days) * 24 * 60 * 60 * 1000;
}

const DEFAULT_SELF_IMPROVEMENT_REMINDER = `## Self-Improvement Reminder

After completing tasks, evaluate if any learnings should be captured:

**Log when:**
- User corrects you -> .learnings/LEARNINGS.md
- Command/operation fails -> .learnings/ERRORS.md
- You discover your knowledge was wrong -> .learnings/LEARNINGS.md
- You find a better approach -> .learnings/LEARNINGS.md

**Promote when pattern is proven:**
- Behavioral patterns -> SOUL.md
- Workflow improvements -> AGENTS.md
- Tool gotchas -> TOOLS.md

Keep entries simple: date, title, what happened, what to do differently.`;

const SELF_IMPROVEMENT_NOTE_PREFIX = "/note self-improvement (before reset):";
const DEFAULT_REFLECTION_MESSAGE_COUNT = 120;
const DEFAULT_REFLECTION_MAX_INPUT_CHARS = 24_000;
const DEFAULT_REFLECTION_TIMEOUT_MS = 20_000;
const DEFAULT_REFLECTION_THINK_LEVEL: ReflectionThinkLevel = "medium";
const DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES = 3;
const DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS = true;
const DEFAULT_REFLECTION_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS = 200;
const DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS = 8_000;
const DEFAULT_AUTO_RECALL_TOP_K = 3;
const DEFAULT_AUTO_RECALL_EXCLUDE_REFLECTION = true;
const DEFAULT_AUTO_RECALL_MAX_AGE_DAYS = 30;
const DEFAULT_AUTO_RECALL_MAX_ENTRIES_PER_KEY = 10;
const DEFAULT_AUTO_RECALL_CATEGORIES: MemoryCategory[] = ["preference", "fact", "decision", "entity", "other"];
const DEFAULT_REFLECTION_RECALL_MODE: ReflectionRecallMode = "fixed";
const DEFAULT_REFLECTION_RECALL_TOP_K = 6;
const DEFAULT_REFLECTION_RECALL_INCLUDE_KINDS: ReflectionRecallKind[] = ["invariant"];
const DEFAULT_REFLECTION_RECALL_MAX_AGE_DAYS = 45;
const DEFAULT_REFLECTION_RECALL_MAX_ENTRIES_PER_KEY = 10;
const DEFAULT_REFLECTION_RECALL_MIN_REPEATED = 2;
const DEFAULT_REFLECTION_RECALL_MIN_SCORE = 0.18;
const DEFAULT_REFLECTION_RECALL_MIN_PROMPT_LENGTH = 8;
// Rendering safety guard only; ranking/store layer owns the semantic final-13 cap.
const DERIVED_FOCUS_RENDER_HARD_LIMIT = 64;
const REFLECTION_FALLBACK_MARKER = "(fallback) Reflection generation failed; storing minimal pointer only.";
const DIAG_BUILD_TAG = "memory-lancedb-pro-diag-20260308-0058";

function buildReflectionDerivedFocusBlock(derivedLines: string[]): string {
  const trimmed = derivedLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, DERIVED_FOCUS_RENDER_HARD_LIMIT);
  if (trimmed.length === 0) return "";
  return [
    "<derived-focus>",
    "Weighted recent derived execution deltas from reflection memory:",
    ...trimmed.map((line, i) => `${i + 1}. ${line}`),
    "</derived-focus>",
  ].join("\n");
}

function buildReflectionOpenLoopsBlock(openLoopLines: string[]): string {
  const trimmed = openLoopLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
  if (trimmed.length === 0) return "";
  return [
    "<open-loops>",
    "Fresh open loops / next actions from this reflection run:",
    ...trimmed.map((line, i) => `${i + 1}. ${line}`),
    "</open-loops>",
  ].join("\n");
}

function buildSelfImprovementResetNote(params?: { openLoopsBlock?: string; derivedFocusBlock?: string }): string {
  const openLoopsBlock = typeof params?.openLoopsBlock === "string" ? params.openLoopsBlock : "";
  const derivedFocusBlock = typeof params?.derivedFocusBlock === "string" ? params.derivedFocusBlock : "";
  const base = [
    SELF_IMPROVEMENT_NOTE_PREFIX,
    "- If anything was learned/corrected, log it now:",
    "  - .learnings/LEARNINGS.md (corrections/best practices)",
    "  - .learnings/ERRORS.md (failures/root causes)",
    "- Distill reusable rules to AGENTS.md / SOUL.md / TOOLS.md.",
    "- If reusable across tasks, extract a new skill from the learning.",
  ];
  if (openLoopsBlock) {
    base.push("- Fresh run handoff:");
    base.push(openLoopsBlock);
  }
  if (derivedFocusBlock) {
    base.push("- Historical reflection-derived focus:");
    base.push(derivedFocusBlock);
  }
  base.push("- Then proceed with the new session.");
  return base.join("\n");
}

type ReflectionErrorSignal = {
  at: number;
  toolName: string;
  summary: string;
  source: "tool_error" | "tool_output";
  signature: string;
  signatureHash: string;
};

type ReflectionErrorState = {
  entries: ReflectionErrorSignal[];
  lastInjectedCount: number;
  signatureSet: Set<string>;
  updatedAt: number;
};

type EmbeddedPiRunner = (params: Record<string, unknown>) => Promise<unknown>;

const requireFromHere = createRequire(import.meta.url);
let embeddedPiRunnerPromise: Promise<EmbeddedPiRunner> | null = null;

function toImportSpecifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) return trimmed;
  if (trimmed.startsWith("/")) return pathToFileURL(trimmed).href;
  return trimmed;
}

function getExtensionApiImportSpecifiers(): string[] {
  const envPath = process.env.OPENCLAW_EXTENSION_API_PATH?.trim();
  const specifiers: string[] = [];

  if (envPath) specifiers.push(toImportSpecifier(envPath));
  specifiers.push("openclaw/dist/extensionAPI.js");

  try {
    specifiers.push(toImportSpecifier(requireFromHere.resolve("openclaw/dist/extensionAPI.js")));
  } catch {
    // ignore resolve failures and continue fallback probing
  }

  specifiers.push(toImportSpecifier("/usr/lib/node_modules/openclaw/dist/extensionAPI.js"));
  specifiers.push(toImportSpecifier("/usr/local/lib/node_modules/openclaw/dist/extensionAPI.js"));

  return [...new Set(specifiers.filter(Boolean))];
}

async function loadEmbeddedPiRunner(): Promise<EmbeddedPiRunner> {
  if (!embeddedPiRunnerPromise) {
    embeddedPiRunnerPromise = (async () => {
      const importErrors: string[] = [];
      for (const specifier of getExtensionApiImportSpecifiers()) {
        try {
          const mod = await import(specifier);
          const runner = (mod as Record<string, unknown>).runEmbeddedPiAgent;
          if (typeof runner === "function") return runner as EmbeddedPiRunner;
          importErrors.push(`${specifier}: runEmbeddedPiAgent export not found`);
        } catch (err) {
          importErrors.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(
        `Unable to load OpenClaw embedded runtime API. ` +
        `Set OPENCLAW_EXTENSION_API_PATH if runtime layout differs. ` +
        `Attempts: ${importErrors.join(" | ")}`
      );
    })();
  }

  try {
    return await embeddedPiRunnerPromise;
  } catch (err) {
    embeddedPiRunnerPromise = null;
    throw err;
  }
}

function clipDiagnostic(text: string, maxLen = 400): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractJsonObjectFromOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("empty stdout");

  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("{")) continue;
    const candidate = lines.slice(i).join("\n");
    const parsed = tryParseJsonObject(candidate);
    if (parsed) return parsed;
  }

  throw new Error(`unable to parse JSON from CLI output: ${clipDiagnostic(trimmed, 280)}`);
}

function extractReflectionTextFromCliResult(resultObj: Record<string, unknown>): string | null {
  const result = resultObj.result as Record<string, unknown> | undefined;
  const payloads = Array.isArray(resultObj.payloads)
    ? resultObj.payloads
    : Array.isArray(result?.payloads)
      ? result.payloads
      : [];
  const firstWithText = payloads.find(
    (p) => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" && ((p as Record<string, unknown>).text as string).trim().length
  ) as Record<string, unknown> | undefined;
  const text = typeof firstWithText?.text === "string" ? firstWithText.text.trim() : "";
  return text || null;
}

async function runReflectionViaCli(params: {
  prompt: string;
  agentId: string;
  workspaceDir: string;
  timeoutMs: number;
  thinkLevel: ReflectionThinkLevel;
}): Promise<string> {
  const cliBin = process.env.OPENCLAW_CLI_BIN?.trim() || "openclaw";
  const outerTimeoutMs = Math.max(params.timeoutMs + 5000, 15000);
  const agentTimeoutSec = Math.max(1, Math.ceil(params.timeoutMs / 1000));
  const sessionId = `memory-reflection-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const args = [
    "agent",
    "--local",
    "--agent",
    params.agentId,
    "--message",
    params.prompt,
    "--json",
    "--thinking",
    params.thinkLevel,
    "--timeout",
    String(agentTimeoutSec),
    "--session-id",
    sessionId,
  ];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cliBin, args, {
      cwd: params.workspaceDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, outerTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn ${cliBin} failed: ${err.message}`));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`${cliBin} timed out after ${outerTimeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new Error(`${cliBin} exited by signal ${signal}. stderr=${clipDiagnostic(stderr)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${cliBin} exited with code ${code}. stderr=${clipDiagnostic(stderr)}`));
        return;
      }

      try {
        const parsed = extractJsonObjectFromOutput(stdout);
        const text = extractReflectionTextFromCliResult(parsed);
        if (!text) {
          reject(new Error(`CLI JSON returned no text payload. stdout=${clipDiagnostic(stdout)}`));
          return;
        }
        resolve(text);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

async function loadSelfImprovementReminderContent(workspaceDir?: string): Promise<string> {
  const baseDir = typeof workspaceDir === "string" && workspaceDir.trim().length ? workspaceDir.trim() : "";
  if (!baseDir) return DEFAULT_SELF_IMPROVEMENT_REMINDER;

  const reminderPath = join(baseDir, "SELF_IMPROVEMENT_REMINDER.md");
  try {
    const content = await readFile(reminderPath, "utf-8");
    const trimmed = content.trim();
    return trimmed.length ? trimmed : DEFAULT_SELF_IMPROVEMENT_REMINDER;
  } catch {
    return DEFAULT_SELF_IMPROVEMENT_REMINDER;
  }
}

function parseAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const sk = (sessionKey ?? "").trim();
  const parts = sk.split(":");
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]) return parts[1];
  return undefined;
}

function resolveAgentPrimaryModelRef(cfg: unknown, agentId: string): string | undefined {
  try {
    const root = cfg as Record<string, unknown>;
    const agents = root.agents as Record<string, unknown> | undefined;
    const list = agents?.list as unknown;

    if (Array.isArray(list)) {
      const found = list.find((x) => {
        if (!x || typeof x !== "object") return false;
        return (x as Record<string, unknown>).id === agentId;
      }) as Record<string, unknown> | undefined;
      const model = found?.model as Record<string, unknown> | undefined;
      const primary = model?.primary;
      if (typeof primary === "string" && primary.trim()) return primary.trim();
    }

    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const defModel = defaults?.model as Record<string, unknown> | undefined;
    const defPrimary = defModel?.primary;
    if (typeof defPrimary === "string" && defPrimary.trim()) return defPrimary.trim();
  } catch {
    // ignore
  }
  return undefined;
}

function isAgentDeclaredInConfig(cfg: unknown, agentId: string): boolean {
  const target = agentId.trim();
  if (!target) return false;
  try {
    const root = cfg as Record<string, unknown>;
    const agents = root.agents as Record<string, unknown> | undefined;
    const list = agents?.list as unknown;
    if (!Array.isArray(list)) return false;
    return list.some((x) => {
      if (!x || typeof x !== "object") return false;
      return (x as Record<string, unknown>).id === target;
    });
  } catch {
    return false;
  }
}

function splitProviderModel(modelRef: string): { provider?: string; model?: string } {
  const s = modelRef.trim();
  if (!s) return {};
  const idx = s.indexOf("/");
  if (idx > 0) {
    const provider = s.slice(0, idx).trim();
    const model = s.slice(idx + 1).trim();
    return { provider: provider || undefined, model: model || undefined };
  }
  return { model: s };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isInternalReflectionSessionKey(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().startsWith("temp:memory-reflection");
}

function extractTextContent(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text" && typeof (c as Record<string, unknown>).text === "string"
    ) as Record<string, unknown> | undefined;
    const text = block?.text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function shouldSkipReflectionMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/")) return true;

  if (role === "user") {
    if (
      trimmed.includes("<relevant-memories>") ||
      trimmed.includes("UNTRUSTED DATA") ||
      trimmed.includes("END UNTRUSTED DATA")
    ) {
      return true;
    }
  }

  return false;
}

function redactSecrets(text: string): string {
  const patterns: RegExp[] = [
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    /\bsk-proj-[A-Za-z0-9\-_]{20,}\b/g,
    /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    /\bghp_[A-Za-z0-9]{36,}\b/g,
    /\bgho_[A-Za-z0-9]{36,}\b/g,
    /\bghu_[A-Za-z0-9]{36,}\b/g,
    /\bghs_[A-Za-z0-9]{36,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bnpm_[A-Za-z0-9]{36,}\b/g,
    /\b(?:token|api[_-]?key|secret|password)\s*[:=]\s*["']?[^\s"',;)}\]]{6,}["']?\b/gi,
    /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
    /\/home\/[^\s"',;)}\]]+/g,
    /\/Users\/[^\s"',;)}\]]+/g,
    /[A-Z]:\\[^\s"',;)}\]]+/g,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ];

  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => (m.startsWith("Bearer") || m.startsWith("bearer") ? "Bearer [REDACTED]" : "[REDACTED]"));
  }
  return out;
}

function containsErrorSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\[error\]|error:|exception:|fatal:|traceback|syntaxerror|typeerror|referenceerror|npm err!/.test(normalized) ||
    /command not found|no such file|permission denied|non-zero|exit code/.test(normalized) ||
    /"status"\s*:\s*"error"|"status"\s*:\s*"failed"|\biserror\b/.test(normalized) ||
    /错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/.test(normalized)
  );
}

function summarizeErrorText(text: string, maxLen = 220): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty tool error)";
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 3)}...`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeErrorSignature(text: string): string {
  return redactSecrets(String(text || ""))
    .toLowerCase()
    .replace(/[a-z]:\\[^ \n\r\t]+/gi, "<path>")
    .replace(/\/[^ \n\r\t]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function extractTextFromToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((c) => c && typeof c === "object")
        .map((c) => (c as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string");
      if (textParts.length > 0) return textParts.join("\n");
    }
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.details === "string") return obj.details;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

async function readSessionConversationForReflection(filePath: string, messageCount: number): Promise<string | null> {
  try {
    const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
    const messages: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || !entry?.message) continue;

        const msg = entry.message as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : "";
        if (role !== "user" && role !== "assistant") continue;

        const text = extractTextContent(msg.content);
        if (!text || shouldSkipReflectionMessage(role, text)) continue;

        messages.push(`${role}: ${redactSecrets(text)}`);
      } catch {
        // ignore JSON parse errors
      }
    }

    if (messages.length === 0) return null;
    return messages.slice(-messageCount).join("\n");
  } catch {
    return null;
  }
}

export async function readSessionConversationWithResetFallback(sessionFilePath: string, messageCount: number): Promise<string | null> {
  const primary = await readSessionConversationForReflection(sessionFilePath, messageCount);
  if (primary) return primary;

  try {
    const dir = dirname(sessionFilePath);
    const resetPrefix = `${basename(sessionFilePath)}.reset.`;
    const files = await readdir(dir);
    const resetCandidates = await sortFileNamesByMtimeDesc(
      dir,
      files.filter((name) => name.startsWith(resetPrefix))
    );
    if (resetCandidates.length > 0) {
      const latestResetPath = join(dir, resetCandidates[0]);
      return await readSessionConversationForReflection(latestResetPath, messageCount);
    }
  } catch {
    // ignore
  }

  return primary;
}

async function ensureDailyLogFile(dailyPath: string, dateStr: string): Promise<void> {
  try {
    await readFile(dailyPath, "utf-8");
  } catch {
    await writeFile(dailyPath, `# ${dateStr}\n\n`, "utf-8");
  }
}

function buildReflectionPrompt(
  conversation: string,
  maxInputChars: number,
  toolErrorSignals: ReflectionErrorSignal[] = []
): string {
  const clipped = conversation.slice(-maxInputChars);
  const errorHints = toolErrorSignals.length > 0
    ? toolErrorSignals
      .map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary} (sig:${e.signatureHash.slice(0, 8)})`)
      .join("\n")
    : "- (none)";
  return [
    "You are generating a durable MEMORY REFLECTION entry for an AI assistant system.",
    "",
    "Output Markdown only. No intro text. No outro text. No extra headings.",
    "",
    "Use these headings exactly once, in this exact order, with exact spelling:",
    "## Context (session background)",
    "## Decisions (durable)",
    "## User model deltas (about the human)",
    "## Agent model deltas (about the assistant/system)",
    "## Lessons & pitfalls (symptom / cause / fix / prevention)",
    "## Learning governance candidates (.learnings / promotion / skill extraction)",
    "## Open loops / next actions",
    "## Retrieval tags / keywords",
    "## Invariants",
    "## Derived",
    "",
    "Hard rules:",
    "- Do not rename, translate, merge, reorder, or omit headings.",
    "- Every section must appear exactly once.",
    "- For bullet sections, use one item per line, starting with '- '.",
    "- Do not wrap one bullet across multiple lines.",
    "- If a bullet section is empty, write exactly: '- (none captured)'",
    "- Do not paste raw transcript.",
    "- Do not invent Logged timestamps, ids, file paths, commit hashes, session ids, or storage metadata unless they already appear in the input.",
    "- If secrets/tokens/passwords appear, keep them as [REDACTED].",
    "",
    "Section rules:",
    "- Context / Decisions / User model / Agent model / Open loops / Retrieval tags / Invariants / Derived = bullet lists only.",
    "- Lessons & pitfalls = bullet list only; each bullet must be one single line in this shape:",
    "  - Symptom: ... Cause: ... Fix: ... Prevention: ...",
    "- Invariants = stable cross-session rules only; prefer bullets starting with Always / Never / When / If / Before / After / Prefer / Avoid / Require.",
    "- Derived = recent-run distilled learnings, adjustments, and follow-up heuristics that may help the next several runs, but should decay over time.",
    "- Keep Invariants stable and long-lived; keep Derived recent, reusable across near-term runs, and decayable.",
    "- Start Derived bullets with varied lead-ins (for example: Next run..., When..., If..., To avoid...) instead of repeating one opening phrase.",
    "- Keep Derived phrasing non-redundant; do not start every bullet with the same words.",
    "- Do not restate long-term rules in Derived.",
    "",
    "Governance section rules:",
    "- If empty, write exactly:",
    "  - (none captured)",
    "- Otherwise, do NOT use bullet lists there.",
    "- Use one or more entries in exactly this format:",
    "",
    "### Entry 1",
    "**Priority**: low|medium|high|critical",
    "**Status**: pending|triage|promoted_to_skill|done",
    "**Area**: frontend|backend|infra|tests|docs|config|<custom area>",
    "### Summary",
    "<one concise candidate>",
    "### Details",
    "<short supporting details>",
    "### Suggested Action",
    "<one concrete next action>",
    "",
    "Notes:",
    "- Keep writer-owned metadata out of the output. The writer generates Logged and IDs.",
    "- Prefer structured, machine-parseable output over elegant prose.",
    "",
    "OUTPUT TEMPLATE (copy this structure exactly):",
    "## Context (session background)",
    "- ...",
    "",
    "## Decisions (durable)",
    "- ...",
    "",
    "## User model deltas (about the human)",
    "- ...",
    "",
    "## Agent model deltas (about the assistant/system)",
    "- ...",
    "",
    "## Lessons & pitfalls (symptom / cause / fix / prevention)",
    "- Symptom: ... Cause: ... Fix: ... Prevention: ...",
    "",
    "## Learning governance candidates (.learnings / promotion / skill extraction)",
    "### Entry 1",
    "**Priority**: medium",
    "**Status**: pending",
    "**Area**: config",
    "### Summary",
    "...",
    "### Details",
    "...",
    "### Suggested Action",
    "...",
    "",
    "## Open loops / next actions",
    "- ...",
    "",
    "## Retrieval tags / keywords",
    "- ...",
    "",
    "## Invariants",
    "- Always ...",
    "",
    "## Derived",
    "- Next run, ...",
    "",
    "Recent tool error signals:",
    errorHints,
    "",
    "INPUT:",
    "```",
    clipped,
    "```",
  ].join("\n");
}

function buildReflectionFallbackText(): string {
  return [
    "## Context (session background)",
    `- ${REFLECTION_FALLBACK_MARKER}`,
    "",
    "## Decisions (durable)",
    "- (none captured)",
    "",
    "## User model deltas (about the human)",
    "- (none captured)",
    "",
    "## Agent model deltas (about the assistant/system)",
    "- (none captured)",
    "",
    "## Lessons & pitfalls (symptom / cause / fix / prevention)",
    "- (none captured)",
    "",
    "## Learning governance candidates (.learnings / promotion / skill extraction)",
    "### Entry 1",
    "**Priority**: medium",
    "**Status**: triage",
    "**Area**: config",
    "### Summary",
    "Investigate last failed tool execution and decide whether it belongs in .learnings/ERRORS.md.",
    "### Details",
    "The reflection pipeline fell back; confirm the failure is reproducible before treating it as a durable error record.",
    "### Suggested Action",
    "Reproduce the latest failed tool execution, classify it as triage or error, and then log it with the appropriate tool/file path evidence.",
    "",
    "## Open loops / next actions",
    "- Investigate why embedded reflection generation failed.",
    "",
    "## Retrieval tags / keywords",
    "- memory-reflection",
    "",
    "## Invariants",
    "- (none captured)",
    "",
    "## Derived",
    "- If embedded reflection generation fails again, investigate root cause before trusting any next-run delta.",
  ].join("\n");
}

async function generateReflectionText(params: {
  conversation: string;
  maxInputChars: number;
  cfg: unknown;
  agentId: string;
  workspaceDir: string;
  timeoutMs: number;
  thinkLevel: ReflectionThinkLevel;
  toolErrorSignals?: ReflectionErrorSignal[];
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ text: string; usedFallback: boolean; promptHash: string; error?: string; runner: "embedded" | "cli" | "fallback" }> {
  const prompt = buildReflectionPrompt(
    params.conversation,
    params.maxInputChars,
    params.toolErrorSignals ?? []
  );
  const promptHash = sha256Hex(prompt);
  const tempSessionFile = join(
    tmpdir(),
    `memory-reflection-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  let reflectionText: string | null = null;
  const errors: string[] = [];
  const retryState = { count: 0 };
  const onRetryLog = (level: "info" | "warn", message: string) => {
    if (level === "warn") params.logger?.warn?.(message);
    else params.logger?.info?.(message);
  };

  try {
    const result: unknown = await runWithReflectionTransientRetryOnce({
      scope: "reflection",
      runner: "embedded",
      retryState,
      onLog: onRetryLog,
      execute: async () => {
        const runEmbeddedPiAgent = await loadEmbeddedPiRunner();
        const modelRef = resolveAgentPrimaryModelRef(params.cfg, params.agentId);
        const { provider, model } = modelRef ? splitProviderModel(modelRef) : {};
        const embeddedTimeoutMs = Math.max(params.timeoutMs + 5000, 15000);

        return await withTimeout(
          runEmbeddedPiAgent({
            sessionId: `reflection-${Date.now()}`,
            sessionKey: "temp:memory-reflection",
            agentId: params.agentId,
            sessionFile: tempSessionFile,
            workspaceDir: params.workspaceDir,
            config: params.cfg,
            prompt,
            disableTools: true,
            disableMessageTool: true,
            timeoutMs: params.timeoutMs,
            runId: `memory-reflection-${Date.now()}`,
            bootstrapContextMode: "lightweight",
            thinkLevel: params.thinkLevel,
            provider,
            model,
          }),
          embeddedTimeoutMs,
          "embedded reflection run"
        );
      },
    });

    const payloads = (() => {
      if (!result || typeof result !== "object") return [];
      const maybePayloads = (result as Record<string, unknown>).payloads;
      return Array.isArray(maybePayloads) ? maybePayloads : [];
    })();

    if (payloads.length > 0) {
      const firstWithText = payloads.find((p) => {
        if (!p || typeof p !== "object") return false;
        const text = (p as Record<string, unknown>).text;
        return typeof text === "string" && text.trim().length > 0;
      }) as Record<string, unknown> | undefined;
      reflectionText = typeof firstWithText?.text === "string" ? firstWithText.text.trim() : null;
    }
  } catch (err) {
    errors.push(`embedded: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  } finally {
    await unlink(tempSessionFile).catch(() => { });
  }

  if (reflectionText) {
    return { text: reflectionText, usedFallback: false, promptHash, error: errors[0], runner: "embedded" };
  }

  try {
    reflectionText = await runWithReflectionTransientRetryOnce({
      scope: "reflection",
      runner: "cli",
      retryState,
      onLog: onRetryLog,
      execute: async () => await runReflectionViaCli({
        prompt,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        timeoutMs: params.timeoutMs,
        thinkLevel: params.thinkLevel,
      }),
    });
  } catch (err) {
    errors.push(`cli: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (reflectionText) {
    return {
      text: reflectionText,
      usedFallback: false,
      promptHash,
      error: errors.length > 0 ? errors.join(" | ") : undefined,
      runner: "cli",
    };
  }

  return {
    text: buildReflectionFallbackText(),
    usedFallback: true,
    promptHash,
    error: errors.length > 0 ? errors.join(" | ") : undefined,
    runner: "fallback",
  };
}

// ============================================================================
// Capture & Category Detection (from old plugin)
// ============================================================================

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
  // Chinese triggers (Traditional & Simplified)
  /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
  /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
  /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
  /我的\S+是|叫我|稱呼|称呼/,
  /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
  /重要|關鍵|关键|注意|千萬別|千万别/,
  /幫我|筆記|存檔|存起來|存一下|重點|原則|底線/,
];

const CAPTURE_EXCLUDE_PATTERNS = [
  // Memory management / meta-ops: do not store as long-term memory
  /\b(memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+memory-pro\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];

export function shouldCapture(text: string): boolean {
  let s = text.trim();

  // Strip OpenClaw metadata headers (Conversation info or Sender)
  const metadataPattern = /^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim;
  s = s.replace(metadataPattern, "");

  // CJK characters carry more meaning per character, use lower minimum threshold
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(
    s,
  );
  const minLen = hasCJK ? 4 : 10;
  if (s.length < minLen || s.length > 500) {
    return false;
  }
  // Skip injected context from memory recall
  if (s.includes("<relevant-memories>")) {
    return false;
  }
  // Skip system-generated content
  if (s.startsWith("<") && s.includes("</")) {
    return false;
  }
  // Skip agent summary responses (contain markdown formatting)
  if (s.includes("**") && s.includes("\n-")) {
    return false;
  }
  // Skip emoji-heavy responses (likely agent output)
  const emojiCount = (s.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  // Exclude obvious memory-management prompts
  if (CAPTURE_EXCLUDE_PATTERNS.some((r) => r.test(s))) return false;

  return MEMORY_TRIGGERS.some((r) => r.test(s));
}

export function detectCategory(
  text: string,
): "preference" | "fact" | "decision" | "entity" | "other" {
  const lower = text.toLowerCase();
  if (
    /prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/i.test(
      lower,
    )
  ) {
    return "preference";
  }
  if (
    /rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|流程|SOP/i.test(
      lower,
    )
  ) {
    return "decision";
  }
  if (
    /\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(
      lower,
    )
  ) {
    return "entity";
  }
  if (
    /\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(
      lower,
    )
  ) {
    return "fact";
  }
  return "other";
}

function sanitizeForContext(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/</g, "\uFF1C")
    .replace(/>/g, "\uFF1E")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ============================================================================
// Session Path Helpers
// ============================================================================

async function sortFileNamesByMtimeDesc(dir: string, fileNames: string[]): Promise<string[]> {
  const candidates = await Promise.all(
    fileNames.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  return candidates
    .filter((x): x is { name: string; mtimeMs: number } => x !== null)
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
    .map((x) => x.name);
}

function sanitizeFileToken(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || fallback;
}

async function findPreviousSessionFile(
  sessionsDir: string,
  currentSessionFile?: string,
  sessionId?: string,
): Promise<string | undefined> {
  try {
    const files = await readdir(sessionsDir);
    const fileSet = new Set(files);

    // Try recovering the non-reset base file
    const baseFromReset = currentSessionFile
      ? stripResetSuffix(basename(currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset))
      return join(sessionsDir, baseFromReset);

    // Try canonical session ID file
    const trimmedId = sessionId?.trim();
    if (trimmedId) {
      const canonicalFile = `${trimmedId}.jsonl`;
      if (fileSet.has(canonicalFile)) return join(sessionsDir, canonicalFile);

      // Try topic variants
      const topicVariants = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter(
          (name) =>
            name.startsWith(`${trimmedId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
      );
      if (topicVariants.length > 0) return join(sessionsDir, topicVariants[0]);
    }

    // Fallback to most recent non-reset JSONL
    if (currentSessionFile) {
      const nonReset = await sortFileNamesByMtimeDesc(
        sessionsDir,
        files.filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      );
      if (nonReset.length > 0) return join(sessionsDir, nonReset[0]);
    }
  } catch {}
}

// ============================================================================
// Markdown Mirror (dual-write)
// ============================================================================

type AgentWorkspaceMap = Record<string, string>;

function resolveAgentWorkspaceMap(api: OpenClawPluginApi): AgentWorkspaceMap {
  const map: AgentWorkspaceMap = {};

  // Try api.config first (runtime config)
  const agents = Array.isArray((api as any).config?.agents?.list)
    ? (api as any).config.agents.list
    : [];

  for (const agent of agents) {
    if (agent?.id && typeof agent.workspace === "string") {
      map[String(agent.id)] = agent.workspace;
    }
  }

  // Fallback: read from openclaw.json (respect OPENCLAW_HOME if set)
  if (Object.keys(map).length === 0) {
    try {
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const configPath = join(openclawHome, "openclaw.json");
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      const list = parsed?.agents?.list;
      if (Array.isArray(list)) {
        for (const agent of list) {
          if (agent?.id && typeof agent.workspace === "string") {
            map[String(agent.id)] = agent.workspace;
          }
        }
      }
    } catch {
      /* silent */
    }
  }

  return map;
}

function createMdMirrorWriter(
  api: OpenClawPluginApi,
  config: PluginConfig,
): MdMirrorWriter | null {
  if (config.mdMirror?.enabled !== true) return null;

  const fallbackDir = api.resolvePath(config.mdMirror.dir || "memory-md");
  const workspaceMap = resolveAgentWorkspaceMap(api);

  if (Object.keys(workspaceMap).length > 0) {
    api.logger.info(
      `mdMirror: resolved ${Object.keys(workspaceMap).length} agent workspace(s)`,
    );
  } else {
    api.logger.warn(
      `mdMirror: no agent workspaces found, writes will use fallback dir: ${fallbackDir}`,
    );
  }

  return async (entry, meta) => {
    try {
      const ts = new Date(entry.timestamp || Date.now());
      const dateStr = ts.toISOString().split("T")[0];

      let mirrorDir = fallbackDir;
      if (meta?.agentId && workspaceMap[meta.agentId]) {
        mirrorDir = join(workspaceMap[meta.agentId], "memory");
      }

      const filePath = join(mirrorDir, `${dateStr}.md`);
      const agentLabel = meta?.agentId ? ` agent=${meta.agentId}` : "";
      const sourceLabel = meta?.source ? ` source=${meta.source}` : "";
      const safeText = entry.text.replace(/\n/g, " ").slice(0, 500);
      const line = `- ${ts.toISOString()} [${entry.category}:${entry.scope}]${agentLabel}${sourceLabel} ${safeText}\n`;

      await mkdir(mirrorDir, { recursive: true });
      await appendFile(filePath, line, "utf8");
    } catch (err) {
      api.logger.warn(`mdMirror: write failed: ${String(err)}`);
    }
  };
}

// ============================================================================
// Version
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
      version?: string;
    };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const pluginVersion = getPluginVersion();

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryLanceDBProPlugin = {
  id: "memory-lancedb-pro",
  name: "Memory (LanceDB Pro)",
  description:
    "Enhanced LanceDB-backed long-term memory with hybrid retrieval, multi-scope isolation, and management CLI",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Parse and validate configuration
    const config = parsePluginConfig(api.pluginConfig);

    const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());

    // Pre-flight: validate storage path (symlink resolution, mkdir, write check).
    // Runs synchronously and logs warnings; does NOT block gateway startup.
    try {
      validateStoragePath(resolvedDbPath);
    } catch (err) {
      api.logger.warn(
        `memory-lancedb-pro: storage path issue — ${String(err)}\n` +
          `  The plugin will still attempt to start, but writes may fail.`,
      );
    }

    const vectorDim = getVectorDimensions(
      config.embedding.model || "text-embedding-3-small",
      config.embedding.dimensions,
    );

    // Initialize core components
    const store = new MemoryStore({ dbPath: resolvedDbPath, vectorDim });
    const embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: config.embedding.apiKey,
      model: config.embedding.model || "text-embedding-3-small",
      baseURL: config.embedding.baseURL,
      dimensions: config.embedding.dimensions,
      taskQuery: config.embedding.taskQuery,
      taskPassage: config.embedding.taskPassage,
      normalized: config.embedding.normalized,
      chunking: config.embedding.chunking,
    });
    const retriever = createRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      ...config.retrieval,
    });

    // Access reinforcement tracker (debounced write-back)
    const accessTracker = new AccessTracker({
      store,
      logger: api.logger,
      debounceMs: 5000,
    });
    retriever.setAccessTracker(accessTracker);

    const scopeManager = createScopeManager(config.scopes);
    const migrator = createMigrator(store);

    const reflectionErrorStateBySession = new Map<string, ReflectionErrorState>();
    const reflectionByAgentCache = new Map<string, { updatedAt: number; invariants: string[]; derived: string[] }>();

    const pruneOldestByUpdatedAt = <T extends { updatedAt: number }>(map: Map<string, T>, maxSize: number) => {
      if (map.size <= maxSize) return;
      const sorted = [...map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const removeCount = map.size - maxSize;
      for (let i = 0; i < removeCount; i++) {
        const key = sorted[i]?.[0];
        if (key) map.delete(key);
      }
    };

    const pruneReflectionSessionState = (now = Date.now()) => {
      for (const [key, state] of reflectionErrorStateBySession.entries()) {
        if (now - state.updatedAt > DEFAULT_REFLECTION_SESSION_TTL_MS) {
          reflectionErrorStateBySession.delete(key);
        }
      }
      pruneOldestByUpdatedAt(reflectionErrorStateBySession, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
    };

    const getReflectionErrorState = (sessionKey: string): ReflectionErrorState => {
      const key = sessionKey.trim();
      const current = reflectionErrorStateBySession.get(key);
      if (current) {
        current.updatedAt = Date.now();
        return current;
      }
      const created: ReflectionErrorState = { entries: [], lastInjectedCount: 0, signatureSet: new Set<string>(), updatedAt: Date.now() };
      reflectionErrorStateBySession.set(key, created);
      return created;
    };

    const addReflectionErrorSignal = (sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean) => {
      if (!sessionKey.trim()) return;
      pruneReflectionSessionState();
      const state = getReflectionErrorState(sessionKey);
      if (dedupeEnabled && state.signatureSet.has(signal.signatureHash)) return;
      state.entries.push(signal);
      state.signatureSet.add(signal.signatureHash);
      state.updatedAt = Date.now();
      if (state.entries.length > 30) {
        const removed = state.entries.length - 30;
        state.entries.splice(0, removed);
        state.lastInjectedCount = Math.max(0, state.lastInjectedCount - removed);
        state.signatureSet = new Set(state.entries.map((e) => e.signatureHash));
      }
    };

    const getPendingReflectionErrorSignalsForPrompt = (sessionKey: string, maxEntries: number): ReflectionErrorSignal[] => {
      pruneReflectionSessionState();
      const state = reflectionErrorStateBySession.get(sessionKey.trim());
      if (!state) return [];
      state.updatedAt = Date.now();
      state.lastInjectedCount = Math.min(state.lastInjectedCount, state.entries.length);
      const pending = state.entries.slice(state.lastInjectedCount);
      if (pending.length === 0) return [];
      const clipped = pending.slice(-maxEntries);
      state.lastInjectedCount = state.entries.length;
      return clipped;
    };

    const loadAgentReflectionSlices = async (agentId: string, scopeFilter: string[]) => {
      const cacheKey = `${agentId}::${[...scopeFilter].sort().join(",")}`;
      const cached = reflectionByAgentCache.get(cacheKey);
      if (cached && Date.now() - cached.updatedAt < 15_000) return cached;

      const entries = await store.list(scopeFilter, undefined, 120, 0);
      const { invariants, derived } = loadAgentReflectionSlicesFromEntries({
        entries,
        agentId,
        deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
      });
      const next = { updatedAt: Date.now(), invariants, derived };
      reflectionByAgentCache.set(cacheKey, next);
      return next;
    };

    const autoRecallState = createDynamicRecallSessionState({
      maxSessions: DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
    });
    const reflectionDynamicRecallState = createDynamicRecallSessionState({
      maxSessions: DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
    });

    const clearDynamicRecallStateForSession = (ctx: { sessionId?: unknown; sessionKey?: unknown }) => {
      const sessionIds = new Set<string>();
      if (typeof ctx.sessionId === "string" && ctx.sessionId.trim()) {
        sessionIds.add(ctx.sessionId.trim());
      }
      if (typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()) {
        sessionIds.add(ctx.sessionKey.trim());
      }
      for (const sessionId of sessionIds) {
        clearDynamicRecallSessionState(autoRecallState, sessionId);
        clearDynamicRecallSessionState(reflectionDynamicRecallState, sessionId);
      }
    };

    api.logger.info(
      `memory-lancedb-pro@${pluginVersion}: plugin registered (db: ${resolvedDbPath}, model: ${config.embedding.model || "text-embedding-3-small"})`,
    );
    api.logger.info(`memory-lancedb-pro: diagnostic build tag loaded (${DIAG_BUILD_TAG})`);

    // ========================================================================
    // Markdown Mirror
    // ========================================================================

    const mdMirror = createMdMirrorWriter(api, config);

    // ========================================================================
    // Register Tools
    // ========================================================================

    registerAllMemoryTools(
      api,
      {
        retriever,
        store,
        scopeManager,
        embedder,
        agentId: undefined, // Will be determined at runtime from context
        workspaceDir: getDefaultWorkspaceDir(),
        mdMirror,
      },
      {
        enableManagementTools: config.enableManagementTools,
        enableSelfImprovementTools: config.selfImprovement?.enabled !== false,
      }
    );

    // ========================================================================
    // Register CLI Commands
    // ========================================================================

    api.registerCli(
      createMemoryCLI({
        store,
        retriever,
        scopeManager,
        migrator,
        embedder,
      }),
      { commands: ["memory-pro"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    api.on("session_end", (_event, ctx) => {
      clearDynamicRecallStateForSession(ctx || {});
    }, { priority: 20 });

    const postProcessAutoRecallResults = (results: RetrievalResult[]): RetrievalResult[] => {
      const allowlisted = config.autoRecallCategories && config.autoRecallCategories.length > 0
        ? results.filter((row) => config.autoRecallCategories!.includes(row.entry.category))
        : results;
      const withoutReflection = config.autoRecallExcludeReflection === true
        ? allowlisted.filter((row) => row.entry.category !== "reflection")
        : allowlisted;
      const maxAgeMs = daysToMs(config.autoRecallMaxAgeDays);
      const withinAge = filterByMaxAge({
        items: withoutReflection,
        maxAgeMs,
        getTimestamp: (row) => row.entry.timestamp,
      });
      const cappedRecent = keepMostRecentPerNormalizedKey({
        items: withinAge,
        maxEntriesPerKey: config.autoRecallMaxEntriesPerKey,
        getTimestamp: (row) => row.entry.timestamp,
        getNormalizedKey: (row) => normalizeRecallTextKey(row.entry.text),
      });
      const allowedIds = new Set(cappedRecent.map((row) => row.entry.id));
      return withinAge.filter((row) => allowedIds.has(row.entry.id));
    };

    // Auto-Recall: inject relevant memories before agent starts.
    // Default is OFF to prevent the model from accidentally echoing injected context.
    if (config.autoRecall === true) {
      api.on("before_agent_start", async (event, ctx) => {
        try {
          const agentId = ctx?.agentId || "main";
          const sessionId = ctx?.sessionId || "default";
          const accessibleScopes = scopeManager.getAccessibleScopes(agentId);
          const topK = config.autoRecallTopK ?? DEFAULT_AUTO_RECALL_TOP_K;
          const fetchLimit = Math.min(20, Math.max(topK * 4, topK, 8));
          return await orchestrateDynamicRecall({
            channelName: "auto-recall",
            prompt: event.prompt,
            minPromptLength: config.autoRecallMinLength,
            minRepeated: config.autoRecallMinRepeated,
            topK,
            sessionId,
            state: autoRecallState,
            outputTag: "relevant-memories",
            headerLines: [],
            wrapUntrustedData: true,
            logger: api.logger,
            loadCandidates: async () => {
              const retrieved = await retriever.retrieve({
                query: event.prompt,
                limit: fetchLimit,
                scopeFilter: accessibleScopes,
                source: "auto-recall",
              });
              return postProcessAutoRecallResults(retrieved).slice(0, topK);
            },
            formatLine: (row) =>
              `- [${row.entry.category}:${row.entry.scope}] ${sanitizeForContext(row.entry.text)} (${(row.score * 100).toFixed(0)}%${row.sources?.bm25 ? ", vector+BM25" : ""}${row.sources?.reranked ? "+reranked" : ""})`,
          });
        } catch (err) {
          api.logger.warn(`memory-lancedb-pro: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: analyze and store important information after agent ends
    if (config.autoCapture !== false) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Determine agent ID and default scope
          const agentId = ctx?.agentId || "main";
          const defaultScope = scopeManager.getDefaultScope(agentId);

          // Extract text content from messages
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") {
              continue;
            }
            const msgObj = msg as Record<string, unknown>;

            const role = msgObj.role;
            const captureAssistant = config.captureAssistant === true;
            if (
              role !== "user" &&
              !(captureAssistant && role === "assistant")
            ) {
              continue;
            }

            const content = msgObj.content;

            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          // Filter for capturable content
          const toCapture = texts.filter((text) => text && shouldCapture(text));
          if (toCapture.length === 0) {
            return;
          }

          // Store each capturable piece (limit to 3 per conversation)
          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const vector = await embedder.embedPassage(text);

            // Check for duplicates using raw vector similarity (bypasses importance/recency weighting)
            // Fail-open by design: dedup should not block auto-capture writes.
            let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
            try {
              existing = await store.vectorSearch(vector, 1, 0.1, [
                defaultScope,
              ]);
            } catch (err) {
              api.logger.warn(
                `memory-lancedb-pro: auto-capture duplicate pre-check failed, continue store: ${String(err)}`,
              );
            }

            if (existing.length > 0 && existing[0].score > 0.95) {
              continue;
            }

            await store.store({
              text,
              vector,
              importance: 0.7,
              category,
              scope: defaultScope,
            });
            stored++;

            // Dual-write to Markdown mirror if enabled
            if (mdMirror) {
              await mdMirror(
                { text, category, scope: defaultScope, timestamp: Date.now() },
                { source: "auto-capture", agentId },
              );
            }
          }

          if (stored > 0) {
            api.logger.info(
              `memory-lancedb-pro: auto-captured ${stored} memories for agent ${agentId} in scope ${defaultScope}`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-lancedb-pro: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Integrated Self-Improvement (inheritance + derived)
    // ========================================================================

    const COMMAND_HOOK_EVENT_MARKER_PREFIX = "__memoryLanceDbProCommandHandled__";
    const markCommandHookEventHandled = (event: unknown, marker: string): boolean => {
      if (!event || typeof event !== "object") return false;
      const target = event as Record<string, unknown>;
      if (target[marker] === true) return true;
      try {
        Object.defineProperty(target, marker, {
          value: true,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch {
        target[marker] = true;
      }
      return false;
    };

    const registerDurableCommandHook = (
      eventName: "command:new" | "command:reset",
      handler: (event: any) => Promise<unknown> | unknown,
      options: { name: string; description: string },
      markerSuffix: string,
    ) => {
      const marker = `${COMMAND_HOOK_EVENT_MARKER_PREFIX}${markerSuffix}:${eventName}`;
      const wrapped = async (event: any) => {
        if (markCommandHookEventHandled(event, marker)) return;
        return await handler(event);
      };

      let registeredViaEventBus = false;
      let registeredViaInternalHook = false;

      const onFn = (api as any).on;
      if (typeof onFn === "function") {
        try {
          onFn.call(api, eventName, wrapped, { priority: 12 });
          registeredViaEventBus = true;
        } catch (err) {
          api.logger.warn(
            `memory-lancedb-pro: failed to register ${eventName} via api.on, continue fallback: ${String(err)}`,
          );
        }
      }

      const registerHookFn = (api as any).registerHook;
      if (typeof registerHookFn === "function") {
        try {
          registerHookFn.call(api, eventName, wrapped, options);
          registeredViaInternalHook = true;
        } catch (err) {
          api.logger.warn(
            `memory-lancedb-pro: failed to register ${eventName} via api.registerHook: ${String(err)}`,
          );
        }
      }

      if (!registeredViaEventBus && !registeredViaInternalHook) {
        api.logger.warn(
          `memory-lancedb-pro: command hook registration failed for ${eventName}; no compatible API method available`,
        );
      }
    };

    if (config.selfImprovement?.enabled !== false) {
      let registeredBeforeResetNoteHooks = false;
      api.registerHook("agent:bootstrap", async (event) => {
        try {
          const context = (event.context || {}) as Record<string, unknown>;
          const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
          const workspaceDir = resolveWorkspaceDirFromContext(context);

          if (isInternalReflectionSessionKey(sessionKey)) {
            return;
          }

          if (config.selfImprovement?.skipSubagentBootstrap !== false && sessionKey.includes(":subagent:")) {
            return;
          }

          if (config.selfImprovement?.ensureLearningFiles !== false) {
            await ensureSelfImprovementLearningFiles(workspaceDir);
          }

          const bootstrapFiles = context.bootstrapFiles;
          if (!Array.isArray(bootstrapFiles)) return;

          const exists = bootstrapFiles.some((f) => {
            if (!f || typeof f !== "object") return false;
            const pathValue = (f as Record<string, unknown>).path;
            return typeof pathValue === "string" && pathValue === "SELF_IMPROVEMENT_REMINDER.md";
          });
          if (exists) return;

          const content = await loadSelfImprovementReminderContent(workspaceDir);
          bootstrapFiles.push({
            path: "SELF_IMPROVEMENT_REMINDER.md",
            content,
            virtual: true,
          });
        } catch (err) {
          api.logger.warn(`self-improvement: bootstrap inject failed: ${String(err)}`);
        }
      }, {
        name: "memory-lancedb-pro.self-improvement.agent-bootstrap",
        description: "Inject self-improvement reminder on agent bootstrap",
      });

      if (config.selfImprovement?.beforeResetNote !== false && config.sessionStrategy !== "memoryReflection") {
        registeredBeforeResetNoteHooks = true;
        const appendSelfImprovementNote = async (event: any) => {
          try {
            const action = String(event?.action || "unknown");
            const sessionKeyForLog = typeof event?.sessionKey === "string" ? event.sessionKey : "";
            const contextForLog = (event?.context && typeof event.context === "object")
              ? (event.context as Record<string, unknown>)
              : {};
            const commandSource = typeof contextForLog.commandSource === "string" ? contextForLog.commandSource : "";
            const contextKeys = Object.keys(contextForLog).slice(0, 8).join(",");
            api.logger.info(
              `self-improvement: command:${action} hook start; sessionKey=${sessionKeyForLog || "(none)"}; source=${commandSource || "(unknown)"}; hasMessages=${Array.isArray(event?.messages)}; contextKeys=${contextKeys || "(none)"}`
            );

            if (!Array.isArray(event.messages)) {
              api.logger.warn(`self-improvement: command:${action} missing event.messages array; skip note inject`);
              return;
            }

            const exists = event.messages.some((m: unknown) => typeof m === "string" && m.includes(SELF_IMPROVEMENT_NOTE_PREFIX));
            if (exists) {
              api.logger.info(`self-improvement: command:${action} note already present; skip duplicate inject`);
              return;
            }

            event.messages.push(buildSelfImprovementResetNote());
            api.logger.info(
              `self-improvement: command:${action} injected note; messages=${event.messages.length}`
            );
          } catch (err) {
            api.logger.warn(`self-improvement: note inject failed: ${String(err)}`);
          }
        };

        const selfImprovementNewHookOptions = {
          name: "memory-lancedb-pro.self-improvement.command-new",
          description: "Append self-improvement note before /new",
        } as const;
        const selfImprovementResetHookOptions = {
          name: "memory-lancedb-pro.self-improvement.command-reset",
          description: "Append self-improvement note before /reset",
        } as const;
        registerDurableCommandHook("command:new", appendSelfImprovementNote, selfImprovementNewHookOptions, "self-improvement");
        registerDurableCommandHook("command:reset", appendSelfImprovementNote, selfImprovementResetHookOptions, "self-improvement");
        api.on("gateway_start", () => {
          registerDurableCommandHook("command:new", appendSelfImprovementNote, selfImprovementNewHookOptions, "self-improvement");
          registerDurableCommandHook("command:reset", appendSelfImprovementNote, selfImprovementResetHookOptions, "self-improvement");
          api.logger.info("self-improvement: command hooks refreshed after gateway_start");
        }, { priority: 12 });
      }

      api.logger.info(
        registeredBeforeResetNoteHooks
          ? "self-improvement: integrated hooks registered (agent:bootstrap, command:new, command:reset)"
          : "self-improvement: integrated hooks registered (agent:bootstrap)"
      );
    }

    // ========================================================================
    // Integrated Memory Reflection (reflection)
    // ========================================================================

    if (config.sessionStrategy === "memoryReflection") {
      const reflectionMessageCount = config.memoryReflection?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
      const reflectionMaxInputChars = config.memoryReflection?.maxInputChars ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS;
      const reflectionTimeoutMs = config.memoryReflection?.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
      const reflectionThinkLevel = config.memoryReflection?.thinkLevel ?? DEFAULT_REFLECTION_THINK_LEVEL;
      const reflectionAgentId = asNonEmptyString(config.memoryReflection?.agentId);
      const reflectionErrorReminderMaxEntries =
        parsePositiveInt(config.memoryReflection?.errorReminderMaxEntries) ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES;
      const reflectionDedupeErrorSignals = config.memoryReflection?.dedupeErrorSignals !== false;
      const reflectionInjectMode = config.memoryReflection?.injectMode ?? "inheritance+derived";
      const reflectionStoreToLanceDB = config.memoryReflection?.storeToLanceDB !== false;
      const reflectionRecallMode = config.memoryReflection?.recall?.mode ?? DEFAULT_REFLECTION_RECALL_MODE;
      const reflectionRecallTopK = config.memoryReflection?.recall?.topK ?? DEFAULT_REFLECTION_RECALL_TOP_K;
      const reflectionRecallIncludeKinds = config.memoryReflection?.recall?.includeKinds ?? DEFAULT_REFLECTION_RECALL_INCLUDE_KINDS;
      const reflectionRecallMaxAgeDays = config.memoryReflection?.recall?.maxAgeDays ?? DEFAULT_REFLECTION_RECALL_MAX_AGE_DAYS;
      const reflectionRecallMaxEntriesPerKey = config.memoryReflection?.recall?.maxEntriesPerKey ?? DEFAULT_REFLECTION_RECALL_MAX_ENTRIES_PER_KEY;
      const reflectionRecallMinRepeated = config.memoryReflection?.recall?.minRepeated ?? DEFAULT_REFLECTION_RECALL_MIN_REPEATED;
      const reflectionRecallMinScore = config.memoryReflection?.recall?.minScore ?? DEFAULT_REFLECTION_RECALL_MIN_SCORE;
      const reflectionRecallMinPromptLength = config.memoryReflection?.recall?.minPromptLength ?? DEFAULT_REFLECTION_RECALL_MIN_PROMPT_LENGTH;
      const warnedInvalidReflectionAgentIds = new Set<string>();
      const reflectionTriggerSeenAt = new Map<string, number>();
      const REFLECTION_TRIGGER_DEDUPE_MS = 12_000;

      const pruneReflectionTriggerSeenAt = () => {
        const now = Date.now();
        for (const [key, ts] of reflectionTriggerSeenAt.entries()) {
          if (now - ts > REFLECTION_TRIGGER_DEDUPE_MS * 3) {
            reflectionTriggerSeenAt.delete(key);
          }
        }
      };

      const isDuplicateReflectionTrigger = (key: string): boolean => {
        pruneReflectionTriggerSeenAt();
        const now = Date.now();
        const prev = reflectionTriggerSeenAt.get(key);
        reflectionTriggerSeenAt.set(key, now);
        return typeof prev === "number" && (now - prev) < REFLECTION_TRIGGER_DEDUPE_MS;
      };

      const parseSessionIdFromSessionFile = (sessionFile: string | undefined): string | undefined => {
        if (!sessionFile) return undefined;
        const fileName = basename(sessionFile);
        const stripped = fileName.replace(/\.jsonl(?:\.reset\..+)?$/i, "");
        if (!stripped || stripped === fileName) return undefined;
        return stripped;
      };

      const resolveReflectionRunAgentId = (cfg: unknown, sourceAgentId: string): string => {
        if (!reflectionAgentId) return sourceAgentId;
        if (isAgentDeclaredInConfig(cfg, reflectionAgentId)) return reflectionAgentId;

        if (!warnedInvalidReflectionAgentIds.has(reflectionAgentId)) {
          api.logger.warn(
            `memory-reflection: memoryReflection.agentId "${reflectionAgentId}" not found in cfg.agents.list; ` +
            `fallback to runtime agent "${sourceAgentId}".`
          );
          warnedInvalidReflectionAgentIds.add(reflectionAgentId);
        }
        return sourceAgentId;
      };

      api.on("after_tool_call", (event, ctx) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        if (isInternalReflectionSessionKey(sessionKey)) return;
        if (!sessionKey) return;
        pruneReflectionSessionState();

        if (typeof event.error === "string" && event.error.trim().length > 0) {
          const signature = normalizeErrorSignature(event.error);
          addReflectionErrorSignal(sessionKey, {
            at: Date.now(),
            toolName: event.toolName || "unknown",
            summary: summarizeErrorText(event.error),
            source: "tool_error",
            signature,
            signatureHash: sha256Hex(signature).slice(0, 16),
          }, reflectionDedupeErrorSignals);
          return;
        }

        const resultTextRaw = extractTextFromToolResult(event.result);
        const resultText = resultTextRaw.length > DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS
          ? resultTextRaw.slice(0, DEFAULT_REFLECTION_ERROR_SCAN_MAX_CHARS)
          : resultTextRaw;
        if (resultText && containsErrorSignal(resultText)) {
          const signature = normalizeErrorSignature(resultText);
          addReflectionErrorSignal(sessionKey, {
            at: Date.now(),
            toolName: event.toolName || "unknown",
            summary: summarizeErrorText(resultText),
            source: "tool_output",
            signature,
            signatureHash: sha256Hex(signature).slice(0, 16),
          }, reflectionDedupeErrorSignals);
        }
      }, { priority: 15 });

      api.on("before_agent_start", async (event, ctx) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        if (isInternalReflectionSessionKey(sessionKey)) return;
        if (reflectionInjectMode !== "inheritance-only" && reflectionInjectMode !== "inheritance+derived") return;
        try {
          pruneReflectionSessionState();
          const agentId = typeof ctx.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : "main";
          const scopes = scopeManager.getAccessibleScopes(agentId);
          if (reflectionRecallMode === "fixed") {
            const slices = await loadAgentReflectionSlices(agentId, scopes);
            if (slices.invariants.length === 0) return;
            const body = slices.invariants.slice(0, 6).map((line, i) => `${i + 1}. ${line}`).join("\n");
            return {
              prependContext: [
                "<inherited-rules>",
                "Stable rules inherited from memory-lancedb-pro reflections. Treat as long-term behavioral constraints unless user overrides.",
                body,
                "</inherited-rules>",
              ].join("\n"),
            };
          }

          const sessionId = ctx?.sessionId || "default";
          const topK = Math.max(1, reflectionRecallTopK);
          const listLimit = Math.min(800, Math.max(topK * 40, 240));
          const result = await orchestrateDynamicRecall({
            channelName: "reflection-recall",
            prompt: event.prompt,
            minPromptLength: reflectionRecallMinPromptLength,
            minRepeated: reflectionRecallMinRepeated,
            topK,
            sessionId,
            state: reflectionDynamicRecallState,
            outputTag: "inherited-rules",
            headerLines: [
              "Dynamic rules selected by Reflection-Recall. Treat as long-term behavioral constraints unless user overrides.",
            ],
            logger: api.logger,
            loadCandidates: async () => {
              const entries = await store.list(scopes, "reflection", listLimit, 0);
              return rankDynamicReflectionRecallFromEntries(entries, {
                agentId,
                includeKinds: reflectionRecallIncludeKinds,
                topK,
                maxAgeMs: daysToMs(reflectionRecallMaxAgeDays),
                maxEntriesPerKey: reflectionRecallMaxEntriesPerKey,
                minScore: reflectionRecallMinScore,
              });
            },
            formatLine: (row, index) =>
              `${index + 1}. ${sanitizeForContext(row.text)} (${(row.score * 100).toFixed(0)}%)`,
          });
          if (!result) return;
          return { prependContext: result.prependContext };
        } catch (err) {
          api.logger.warn(`memory-reflection: reflection-recall injection failed: ${String(err)}`);
        }
      }, { priority: 12 });

      api.on("before_prompt_build", async (_event, ctx) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        if (isInternalReflectionSessionKey(sessionKey)) return;
        pruneReflectionSessionState();

        if (!sessionKey) return;
        const pending = getPendingReflectionErrorSignalsForPrompt(sessionKey, reflectionErrorReminderMaxEntries);
        if (pending.length === 0) return;
        return {
          prependContext: [
            "<error-detected>",
            "A tool error was detected. Consider logging this to `.learnings/ERRORS.md` if it is non-trivial or likely to recur.",
            "Recent error signals:",
            ...pending.map((e, i) => `${i + 1}. [${e.toolName}] ${e.summary}`),
            "</error-detected>",
          ].join("\n"),
        };
      }, { priority: 15 });

      api.on("session_end", (_event, ctx) => {
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
        if (!sessionKey) return;
        reflectionErrorStateBySession.delete(sessionKey);
        pruneReflectionSessionState();
      }, { priority: 20 });

      const runMemoryReflection = async (event: any) => {
        const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
        try {
          pruneReflectionSessionState();
          const action = String(event?.action || "unknown");
          const context = (event.context || {}) as Record<string, unknown>;
          const cfg = context.cfg;
          const workspaceDir = resolveWorkspaceDirFromContext(context);
          if (!cfg) {
            api.logger.warn(`memory-reflection: command:${action} missing cfg in hook context; skip reflection`);
            return;
          }

          const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
          const currentSessionId = typeof sessionEntry.sessionId === "string" ? sessionEntry.sessionId : "unknown";
          let currentSessionFile = typeof sessionEntry.sessionFile === "string" ? sessionEntry.sessionFile : undefined;
          const sourceAgentId = parseAgentIdFromSessionKey(sessionKey) || "main";
          const commandSource = typeof context.commandSource === "string" ? context.commandSource : "";
          const triggerKey = `${String(event?.action || "unknown")}|${sessionKey || "(none)"}|${currentSessionFile || currentSessionId || "unknown"}`;
          if (isDuplicateReflectionTrigger(triggerKey)) {
            api.logger.info(
              `memory-reflection: duplicate trigger skipped; key=${triggerKey}`
            );
            return;
          }
          api.logger.info(
            `memory-reflection: command:${action} hook start; sessionKey=${sessionKey || "(none)"}; source=${commandSource || "(unknown)"}; sessionId=${currentSessionId}; sessionFile=${currentSessionFile || "(none)"}`
          );

          if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
            const searchDirs = resolveReflectionSessionSearchDirs({
              context,
              cfg,
              workspaceDir,
              currentSessionFile,
              sourceAgentId,
            });
            api.logger.info(
              `memory-reflection: command:${action} session recovery start for session ${currentSessionId}; initial=${currentSessionFile || "(none)"}; dirs=${searchDirs.join(" | ") || "(none)"}`
            );
            for (const sessionsDir of searchDirs) {
              const recovered = await findPreviousSessionFile(sessionsDir, currentSessionFile, currentSessionId);
              if (recovered) {
                api.logger.info(
                  `memory-reflection: command:${action} recovered session file ${recovered} from ${sessionsDir}`
                );
                currentSessionFile = recovered;
                break;
              }
            }
          }

          if (!currentSessionFile) {
            const searchDirs = resolveReflectionSessionSearchDirs({
              context,
              cfg,
              workspaceDir,
              currentSessionFile,
              sourceAgentId,
            });
            api.logger.warn(
              `memory-reflection: command:${action} missing session file after recovery for session ${currentSessionId}; dirs=${searchDirs.join(" | ") || "(none)"}`
            );
            return;
          }

          const conversation = await readSessionConversationWithResetFallback(currentSessionFile, reflectionMessageCount);
          if (!conversation) {
            api.logger.warn(
              `memory-reflection: command:${action} conversation empty/unusable for session ${currentSessionId}; file=${currentSessionFile}`
            );
            return;
          }

          const now = new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now());
          const nowTs = now.getTime();
          const dateStr = now.toISOString().split("T")[0];
          const timeIso = now.toISOString().split("T")[1].replace("Z", "");
          const timeHms = timeIso.split(".")[0];
          const timeCompact = timeIso.replace(/[:.]/g, "");
          const reflectionRunAgentId = resolveReflectionRunAgentId(cfg, sourceAgentId);
          const targetScope = scopeManager.getDefaultScope(sourceAgentId);
          const toolErrorSignals = sessionKey
            ? (reflectionErrorStateBySession.get(sessionKey)?.entries ?? []).slice(-reflectionErrorReminderMaxEntries)
            : [];

          api.logger.info(
            `memory-reflection: command:${action} reflection generation start for session ${currentSessionId}; timeoutMs=${reflectionTimeoutMs}`
          );
          const reflectionGenerated = await generateReflectionText({
            conversation,
            maxInputChars: reflectionMaxInputChars,
            cfg,
            agentId: reflectionRunAgentId,
            workspaceDir,
            timeoutMs: reflectionTimeoutMs,
            thinkLevel: reflectionThinkLevel,
            toolErrorSignals,
            logger: api.logger,
          });
          api.logger.info(
            `memory-reflection: command:${action} reflection generation done for session ${currentSessionId}; runner=${reflectionGenerated.runner}; usedFallback=${reflectionGenerated.usedFallback ? "yes" : "no"}`
          );
          const reflectionText = reflectionGenerated.text;
          if (reflectionGenerated.runner === "cli") {
            api.logger.warn(
              `memory-reflection: embedded runner unavailable, used openclaw CLI fallback for session ${currentSessionId}` +
              (reflectionGenerated.error ? ` (${reflectionGenerated.error})` : "")
            );
          } else if (reflectionGenerated.usedFallback) {
            api.logger.warn(
              `memory-reflection: fallback used for session ${currentSessionId}` +
              (reflectionGenerated.error ? ` (${reflectionGenerated.error})` : "")
            );
          }

          let openLoopsBlock = "";
          let derivedFocusBlock = "";
          if (reflectionInjectMode === "inheritance+derived") {
            openLoopsBlock = buildReflectionOpenLoopsBlock(extractReflectionOpenLoops(reflectionText));
            try {
              const scopes = scopeManager.getAccessibleScopes(sourceAgentId);
              const historicalEntries = await store.list(scopes, undefined, 160, 0);
              const historicalDerivedRows = loadAgentDerivedFocusRowsForHandoffFromEntries({
                entries: historicalEntries,
                agentId: sourceAgentId,
                now: nowTs,
                deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
                shortlistLimit: DEFAULT_REFLECTION_DERIVED_SHORTLIST_LIMIT,
                finalLimit: DEFAULT_REFLECTION_DERIVED_FINAL_LIMIT,
              });
              const historicalDerivedLines = historicalDerivedRows
                .map((row) => row.text);
              derivedFocusBlock = buildReflectionDerivedFocusBlock(historicalDerivedLines);
            } catch (err) {
              api.logger.warn(`memory-reflection: derived-focus note build failed: ${String(err)}`);
            }
          }

          if (config.selfImprovement?.enabled !== false && config.selfImprovement?.beforeResetNote !== false) {
            if (!Array.isArray(event.messages)) {
              api.logger.warn(`memory-reflection: command:${action} missing event.messages array; skip note inject`);
            } else {
              const exists = event.messages.some((m: unknown) => typeof m === "string" && m.includes(SELF_IMPROVEMENT_NOTE_PREFIX));
              if (!exists) {
                event.messages.push(buildSelfImprovementResetNote({ openLoopsBlock, derivedFocusBlock }));
                api.logger.info(`memory-reflection: command:${action} injected handoff note; messages=${event.messages.length}`);
              }
            }
          }

          const header = [
            `# Reflection: ${dateStr} ${timeHms} UTC`,
            "",
            `- Session Key: ${sessionKey}`,
            `- Session ID: ${currentSessionId || "unknown"}`,
            `- Command: ${String(event.action || "unknown")}`,
            `- Error Signatures: ${toolErrorSignals.length ? toolErrorSignals.map((s) => s.signatureHash).join(", ") : "(none)"}`,
            "",
          ].join("\n");
          const reflectionBody = `${header}${reflectionText.trim()}\n`;

          const outDir = join(workspaceDir, "memory", "reflections", dateStr);
          await mkdir(outDir, { recursive: true });
          const agentToken = sanitizeFileToken(sourceAgentId, "agent");
          const sessionToken = sanitizeFileToken(currentSessionId || "unknown", "session");
          let relPath = "";
          let writeOk = false;
          for (let attempt = 0; attempt < 10; attempt++) {
            const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 8)}`;
            const fileName = `${timeCompact}-${agentToken}-${sessionToken}${suffix}.md`;
            const candidateRelPath = join("memory", "reflections", dateStr, fileName);
            const candidateOutPath = join(workspaceDir, candidateRelPath);
            try {
              await writeFile(candidateOutPath, reflectionBody, { encoding: "utf-8", flag: "wx" });
              relPath = candidateRelPath;
              writeOk = true;
              break;
            } catch (err: any) {
              if (err?.code === "EEXIST") continue;
              throw err;
            }
          }
          if (!writeOk) {
            throw new Error(`Failed to allocate unique reflection file for ${dateStr} ${timeCompact}`);
          }

          const reflectionGovernanceCandidates = extractReflectionLearningGovernanceCandidates(reflectionText);
          if (config.selfImprovement?.enabled !== false && reflectionGovernanceCandidates.length > 0) {
            for (const candidate of reflectionGovernanceCandidates) {
              await appendSelfImprovementEntry({
                baseDir: workspaceDir,
                type: "learning",
                summary: candidate.summary,
                details: candidate.details,
                suggestedAction: candidate.suggestedAction,
                category: "best_practice",
                area: candidate.area || "config",
                priority: candidate.priority || "medium",
                status: candidate.status || "pending",
                source: `memory-lancedb-pro/reflection:${relPath}`,
              });
            }
          }

          const reflectionEventId = createReflectionEventId({
            runAt: nowTs,
            sessionKey,
            sessionId: currentSessionId || "unknown",
            agentId: sourceAgentId,
            command: String(event.action || "unknown"),
          });

          const mappedReflectionMemories = extractReflectionMappedMemoryItems(reflectionText);
          for (const mapped of mappedReflectionMemories) {
            const vector = await embedder.embedPassage(mapped.text);
            let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
            try {
              existing = await store.vectorSearch(vector, 1, 0.1, [targetScope]);
            } catch (err) {
              api.logger.warn(
                `memory-reflection: mapped memory duplicate pre-check failed, continue store: ${String(err)}`,
              );
            }

            if (existing.length > 0 && existing[0].score > 0.95) {
              continue;
            }

            const importance = mapped.category === "decision" ? 0.85 : 0.8;
            const metadata = JSON.stringify(buildReflectionMappedMetadata({
              mappedItem: mapped,
              eventId: reflectionEventId,
              agentId: sourceAgentId,
              sessionKey,
              sessionId: currentSessionId || "unknown",
              runAt: nowTs,
              usedFallback: reflectionGenerated.usedFallback,
              toolErrorSignals,
              sourceReflectionPath: relPath,
            }));

            const storedEntry = await store.store({
              text: mapped.text,
              vector,
              importance,
              category: mapped.category,
              scope: targetScope,
              metadata,
            });

            if (mdMirror) {
              await mdMirror(
                { text: mapped.text, category: mapped.category, scope: targetScope, timestamp: storedEntry.timestamp },
                { source: `reflection:${mapped.heading}`, agentId: sourceAgentId },
              );
            }
          }

          if (reflectionStoreToLanceDB) {
            await storeReflectionToLanceDB({
              reflectionText,
              sessionKey,
              sessionId: currentSessionId || "unknown",
              agentId: sourceAgentId,
              command: String(event.action || "unknown"),
              scope: targetScope,
              toolErrorSignals,
              runAt: nowTs,
              usedFallback: reflectionGenerated.usedFallback,
              eventId: reflectionEventId,
              sourceReflectionPath: relPath,
              embedPassage: (text) => embedder.embedPassage(text),
              store: (entry) => store.store(entry),
            });
            for (const cacheKey of reflectionByAgentCache.keys()) {
              if (cacheKey.startsWith(`${sourceAgentId}::`)) reflectionByAgentCache.delete(cacheKey);
            }
          }

          const dailyPath = join(workspaceDir, "memory", `${dateStr}.md`);
          await ensureDailyLogFile(dailyPath, dateStr);
          await appendFile(dailyPath, `- [${timeHms} UTC] Reflection generated: \`${relPath}\`\n`, "utf-8");

          api.logger.info(`memory-reflection: wrote ${relPath} for session ${currentSessionId}`);
        } catch (err) {
          api.logger.warn(`memory-reflection: hook failed: ${String(err)}`);
        } finally {
          if (sessionKey) {
            reflectionErrorStateBySession.delete(sessionKey);
          }
          pruneReflectionSessionState();
        }
      };

      const memoryReflectionNewHookOptions = {
        name: "memory-lancedb-pro.memory-reflection.command-new",
        description: "Generate reflection log before /new",
      } as const;
      const memoryReflectionResetHookOptions = {
        name: "memory-lancedb-pro.memory-reflection.command-reset",
        description: "Generate reflection log before /reset",
      } as const;
      registerDurableCommandHook("command:new", runMemoryReflection, memoryReflectionNewHookOptions, "memory-reflection");
      registerDurableCommandHook("command:reset", runMemoryReflection, memoryReflectionResetHookOptions, "memory-reflection");
      api.on("gateway_start", () => {
        registerDurableCommandHook("command:new", runMemoryReflection, memoryReflectionNewHookOptions, "memory-reflection");
        registerDurableCommandHook("command:reset", runMemoryReflection, memoryReflectionResetHookOptions, "memory-reflection");
        api.logger.info("memory-reflection: command hooks refreshed after gateway_start");
      }, { priority: 12 });
      api.on("before_reset", async (event, ctx) => {
        try {
          const actionRaw = typeof event.reason === "string" ? event.reason.trim().toLowerCase() : "reset";
          const action = actionRaw === "new" ? "new" : "reset";
          const sessionFile = typeof event.sessionFile === "string" ? event.sessionFile : undefined;
          const sessionId = parseSessionIdFromSessionFile(sessionFile) ?? "unknown";
          await runMemoryReflection({
            action,
            sessionKey: typeof ctx.sessionKey === "string" ? ctx.sessionKey : "",
            timestamp: Date.now(),
            messages: Array.isArray(event.messages) ? event.messages : [],
            context: {
              cfg: api.config,
              workspaceDir: ctx.workspaceDir,
              commandSource: `lifecycle:before_reset:${action}`,
              sessionEntry: {
                sessionId,
                sessionFile,
              },
            },
          });
        } catch (err) {
          api.logger.warn(`memory-reflection: before_reset fallback failed: ${String(err)}`);
        }
      }, { priority: 12 });
      api.logger.info("memory-reflection: integrated hooks registered (command:new, command:reset, after_tool_call, before_agent_start, before_prompt_build)");
    }

    if (config.sessionStrategy === "systemSessionMemory") {
      api.logger.info("session-strategy: using systemSessionMemory (plugin memory-reflection hooks disabled)");
    }
    if (config.sessionStrategy === "none") {
      api.logger.info("session-strategy: using none (plugin memory-reflection hooks disabled)");
    }

    // ========================================================================
    // Auto-Backup (daily JSONL export)
    // ========================================================================

    let backupTimer: ReturnType<typeof setInterval> | null = null;
    const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    async function runBackup() {
      try {
        const backupDir = api.resolvePath(
          join(resolvedDbPath, "..", "backups"),
        );
        await mkdir(backupDir, { recursive: true });

        const allMemories = await store.list(undefined, undefined, 10000, 0);
        if (allMemories.length === 0) return;

        const dateStr = new Date().toISOString().split("T")[0];
        const backupFile = join(backupDir, `memory-backup-${dateStr}.jsonl`);

        const lines = allMemories.map((m) =>
          JSON.stringify({
            id: m.id,
            text: m.text,
            category: m.category,
            scope: m.scope,
            importance: m.importance,
            timestamp: m.timestamp,
            metadata: m.metadata,
          }),
        );

        await writeFile(backupFile, lines.join("\n") + "\n");

        // Keep only last 7 backups
        const files = (await readdir(backupDir))
          .filter((f) => f.startsWith("memory-backup-") && f.endsWith(".jsonl"))
          .sort();
        if (files.length > 7) {
          const { unlink } = await import("node:fs/promises");
          for (const old of files.slice(0, files.length - 7)) {
            await unlink(join(backupDir, old)).catch(() => {});
          }
        }

        api.logger.info(
          `memory-lancedb-pro: backup completed (${allMemories.length} entries → ${backupFile})`,
        );
      } catch (err) {
        api.logger.warn(`memory-lancedb-pro: backup failed: ${String(err)}`);
      }
    }

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService({
      id: "memory-lancedb-pro",
      start: async () => {
        // IMPORTANT: Do not block gateway startup on external network calls.
        // If embedding/retrieval tests hang (bad network / slow provider), the gateway
        // may never bind its HTTP port, causing restart timeouts.

        const withTimeout = async <T>(
          p: Promise<T>,
          ms: number,
          label: string,
        ): Promise<T> => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${label} timed out after ${ms}ms`)),
              ms,
            );
          });
          try {
            return await Promise.race([p, timeoutPromise]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        };

        const runStartupChecks = async () => {
          try {
            // Test components (bounded time)
            const embedTest = await withTimeout(
              embedder.test(),
              8_000,
              "embedder.test()",
            );
            const retrievalTest = await withTimeout(
              retriever.test(),
              8_000,
              "retriever.test()",
            );

            api.logger.info(
              `memory-lancedb-pro: initialized successfully ` +
                `(embedding: ${embedTest.success ? "OK" : "FAIL"}, ` +
                `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
                `mode: ${retrievalTest.mode}, ` +
                `FTS: ${retrievalTest.hasFtsSupport ? "enabled" : "disabled"})`,
            );

            if (!embedTest.success) {
              api.logger.warn(
                `memory-lancedb-pro: embedding test failed: ${embedTest.error}`,
              );
            }
            if (!retrievalTest.success) {
              api.logger.warn(
                `memory-lancedb-pro: retrieval test failed: ${retrievalTest.error}`,
              );
            }
          } catch (error) {
            api.logger.warn(
              `memory-lancedb-pro: startup checks failed: ${String(error)}`,
            );
          }
        };

        // Fire-and-forget: allow gateway to start serving immediately.
        setTimeout(() => void runStartupChecks(), 0);

        // Run initial backup after a short delay, then schedule daily
        setTimeout(() => void runBackup(), 60_000); // 1 min after start
        backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);
      },
      stop: async () => {
        // Flush pending access reinforcement data before shutdown
        try {
          await accessTracker.flush();
        } catch (err) {
          api.logger.warn("memory-lancedb-pro: flush failed on stop:", err);
        }
        accessTracker.destroy();

        if (backupTimer) {
          clearInterval(backupTimer);
          backupTimer = null;
        }
        api.logger.info("memory-lancedb-pro: stopped");
      },
    });
  },
};

export function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory-lancedb-pro config required");
  }
  const cfg = value as Record<string, unknown>;

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding) {
    throw new Error("embedding config is required");
  }

  // Accept single key (string) or array of keys for round-robin rotation
  let apiKey: string | string[];
  if (typeof embedding.apiKey === "string") {
    apiKey = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0) {
    // Validate every element is a non-empty string
    const invalid = embedding.apiKey.findIndex(
      (k: unknown) => typeof k !== "string" || (k as string).trim().length === 0,
    );
    if (invalid !== -1) {
      throw new Error(
        `embedding.apiKey[${invalid}] is invalid: expected non-empty string`,
      );
    }
    apiKey = embedding.apiKey as string[];
  } else if (embedding.apiKey !== undefined) {
    // apiKey is present but wrong type — throw, don't silently fall back
    throw new Error("embedding.apiKey must be a string or non-empty array of strings");
  } else {
    apiKey = process.env.OPENAI_API_KEY || "";
  }

  if (!apiKey || (Array.isArray(apiKey) && apiKey.length === 0)) {
    throw new Error("embedding.apiKey is required (set directly or via OPENAI_API_KEY env var)");
  }

  const memoryReflectionRaw = typeof cfg.memoryReflection === "object" && cfg.memoryReflection !== null
    ? cfg.memoryReflection as Record<string, unknown>
    : null;
  const sessionMemoryRaw = typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
    ? cfg.sessionMemory as Record<string, unknown>
    : null;
  const sessionStrategyRaw = cfg.sessionStrategy;
  const legacySessionMemoryEnabled = typeof sessionMemoryRaw?.enabled === "boolean"
    ? sessionMemoryRaw.enabled
    : undefined;
  const sessionStrategy: SessionStrategy =
    sessionStrategyRaw === "systemSessionMemory" || sessionStrategyRaw === "memoryReflection" || sessionStrategyRaw === "none"
      ? sessionStrategyRaw
      : legacySessionMemoryEnabled === true
        ? "systemSessionMemory"
      : legacySessionMemoryEnabled === false
          ? "none"
      : "systemSessionMemory";
  const reflectionMessageCount = parsePositiveInt(memoryReflectionRaw?.messageCount ?? sessionMemoryRaw?.messageCount) ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
  const injectModeRaw = memoryReflectionRaw?.injectMode;
  const reflectionInjectMode: ReflectionInjectMode =
    injectModeRaw === "inheritance-only" || injectModeRaw === "inheritance+derived"
      ? injectModeRaw
      : "inheritance+derived";
  const reflectionStoreToLanceDB =
    sessionStrategy === "memoryReflection" &&
    (memoryReflectionRaw?.storeToLanceDB !== false);
  const memoryReflectionRecallRaw = typeof memoryReflectionRaw?.recall === "object" && memoryReflectionRaw.recall !== null
    ? memoryReflectionRaw.recall as Record<string, unknown>
    : null;
  const reflectionRecallMode: ReflectionRecallMode =
    memoryReflectionRecallRaw?.mode === "dynamic" ? "dynamic" : DEFAULT_REFLECTION_RECALL_MODE;
  const reflectionRecallTopK = parsePositiveInt(memoryReflectionRecallRaw?.topK) ?? DEFAULT_REFLECTION_RECALL_TOP_K;
  const reflectionRecallIncludeKinds = parseReflectionRecallKinds(
    memoryReflectionRecallRaw?.includeKinds,
    DEFAULT_REFLECTION_RECALL_INCLUDE_KINDS
  );
  const reflectionRecallMaxAgeDays = parsePositiveInt(memoryReflectionRecallRaw?.maxAgeDays) ?? DEFAULT_REFLECTION_RECALL_MAX_AGE_DAYS;
  const reflectionRecallMaxEntriesPerKey = parsePositiveInt(memoryReflectionRecallRaw?.maxEntriesPerKey) ?? DEFAULT_REFLECTION_RECALL_MAX_ENTRIES_PER_KEY;
  const reflectionRecallMinRepeated = parsePositiveInt(memoryReflectionRecallRaw?.minRepeated) ?? DEFAULT_REFLECTION_RECALL_MIN_REPEATED;
  const reflectionRecallMinScore = parseNonNegativeNumber(memoryReflectionRecallRaw?.minScore) ?? DEFAULT_REFLECTION_RECALL_MIN_SCORE;
  const reflectionRecallMinPromptLength = parsePositiveInt(memoryReflectionRecallRaw?.minPromptLength) ?? DEFAULT_REFLECTION_RECALL_MIN_PROMPT_LENGTH;

  return {
    embedding: {
      provider: "openai-compatible",
      apiKey,
      model:
        typeof embedding.model === "string"
          ? embedding.model
          : "text-embedding-3-small",
      baseURL:
        typeof embedding.baseURL === "string"
          ? resolveEnvVars(embedding.baseURL)
          : undefined,
      // Accept number, numeric string, or env-var string (e.g. "${EMBED_DIM}").
      // Also accept legacy top-level `dimensions` for convenience.
      dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions),
      taskQuery:
        typeof embedding.taskQuery === "string"
          ? embedding.taskQuery
          : undefined,
      taskPassage:
        typeof embedding.taskPassage === "string"
          ? embedding.taskPassage
          : undefined,
      normalized:
        typeof embedding.normalized === "boolean"
          ? embedding.normalized
          : undefined,
      chunking:
        typeof embedding.chunking === "boolean"
          ? embedding.chunking
          : undefined,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    autoCapture: cfg.autoCapture !== false,
    // Default OFF: only enable when explicitly set to true.
    autoRecall: cfg.autoRecall === true,
    autoRecallMinLength: parsePositiveInt(cfg.autoRecallMinLength),
    autoRecallMinRepeated: parsePositiveInt(cfg.autoRecallMinRepeated),
    autoRecallTopK: parsePositiveInt(cfg.autoRecallTopK) ?? DEFAULT_AUTO_RECALL_TOP_K,
    autoRecallCategories: parseMemoryCategories(cfg.autoRecallCategories, DEFAULT_AUTO_RECALL_CATEGORIES),
    autoRecallExcludeReflection: typeof cfg.autoRecallExcludeReflection === "boolean"
      ? cfg.autoRecallExcludeReflection
      : DEFAULT_AUTO_RECALL_EXCLUDE_REFLECTION,
    autoRecallMaxAgeDays: parsePositiveInt(cfg.autoRecallMaxAgeDays) ?? DEFAULT_AUTO_RECALL_MAX_AGE_DAYS,
    autoRecallMaxEntriesPerKey: parsePositiveInt(cfg.autoRecallMaxEntriesPerKey) ?? DEFAULT_AUTO_RECALL_MAX_ENTRIES_PER_KEY,
    captureAssistant: cfg.captureAssistant === true,
    retrieval:
      typeof cfg.retrieval === "object" && cfg.retrieval !== null
        ? (cfg.retrieval as any)
        : undefined,
    scopes:
      typeof cfg.scopes === "object" && cfg.scopes !== null
        ? (cfg.scopes as any)
        : undefined,
    enableManagementTools: cfg.enableManagementTools === true,
    sessionStrategy,
    selfImprovement: typeof cfg.selfImprovement === "object" && cfg.selfImprovement !== null
      ? {
        enabled: (cfg.selfImprovement as Record<string, unknown>).enabled !== false,
        beforeResetNote: (cfg.selfImprovement as Record<string, unknown>).beforeResetNote !== false,
        skipSubagentBootstrap: (cfg.selfImprovement as Record<string, unknown>).skipSubagentBootstrap !== false,
        ensureLearningFiles: (cfg.selfImprovement as Record<string, unknown>).ensureLearningFiles !== false,
      }
      : {
        enabled: true,
        beforeResetNote: true,
        skipSubagentBootstrap: true,
        ensureLearningFiles: true,
      },
    memoryReflection: memoryReflectionRaw
      ? {
        enabled: sessionStrategy === "memoryReflection",
        storeToLanceDB: reflectionStoreToLanceDB,
        injectMode: reflectionInjectMode,
        agentId: asNonEmptyString(memoryReflectionRaw.agentId),
        messageCount: reflectionMessageCount,
        maxInputChars: parsePositiveInt(memoryReflectionRaw.maxInputChars) ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS,
        timeoutMs: parsePositiveInt(memoryReflectionRaw.timeoutMs) ?? DEFAULT_REFLECTION_TIMEOUT_MS,
        thinkLevel: (() => {
          const raw = memoryReflectionRaw.thinkLevel;
          if (raw === "off" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
          return DEFAULT_REFLECTION_THINK_LEVEL;
        })(),
        errorReminderMaxEntries: parsePositiveInt(memoryReflectionRaw.errorReminderMaxEntries) ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
        dedupeErrorSignals: memoryReflectionRaw.dedupeErrorSignals !== false,
        recall: {
          mode: reflectionRecallMode,
          topK: reflectionRecallTopK,
          includeKinds: reflectionRecallIncludeKinds,
          maxAgeDays: reflectionRecallMaxAgeDays,
          maxEntriesPerKey: reflectionRecallMaxEntriesPerKey,
          minRepeated: reflectionRecallMinRepeated,
          minScore: reflectionRecallMinScore,
          minPromptLength: reflectionRecallMinPromptLength,
        },
      }
      : {
        enabled: sessionStrategy === "memoryReflection",
        storeToLanceDB: reflectionStoreToLanceDB,
        injectMode: "inheritance+derived",
        agentId: undefined,
        messageCount: reflectionMessageCount,
        maxInputChars: DEFAULT_REFLECTION_MAX_INPUT_CHARS,
        timeoutMs: DEFAULT_REFLECTION_TIMEOUT_MS,
        thinkLevel: DEFAULT_REFLECTION_THINK_LEVEL,
        errorReminderMaxEntries: DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
        dedupeErrorSignals: DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS,
        recall: {
          mode: DEFAULT_REFLECTION_RECALL_MODE,
          topK: DEFAULT_REFLECTION_RECALL_TOP_K,
          includeKinds: [...DEFAULT_REFLECTION_RECALL_INCLUDE_KINDS],
          maxAgeDays: DEFAULT_REFLECTION_RECALL_MAX_AGE_DAYS,
          maxEntriesPerKey: DEFAULT_REFLECTION_RECALL_MAX_ENTRIES_PER_KEY,
          minRepeated: DEFAULT_REFLECTION_RECALL_MIN_REPEATED,
          minScore: DEFAULT_REFLECTION_RECALL_MIN_SCORE,
          minPromptLength: DEFAULT_REFLECTION_RECALL_MIN_PROMPT_LENGTH,
        },
      },
    sessionMemory:
      typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
        ? {
            enabled:
              (cfg.sessionMemory as Record<string, unknown>).enabled !== false,
            messageCount:
              typeof (cfg.sessionMemory as Record<string, unknown>)
                .messageCount === "number"
                ? ((cfg.sessionMemory as Record<string, unknown>)
                    .messageCount as number)
                : undefined,
          }
        : undefined,
    mdMirror:
      typeof cfg.mdMirror === "object" && cfg.mdMirror !== null
        ? {
            enabled:
              (cfg.mdMirror as Record<string, unknown>).enabled === true,
            dir:
              typeof (cfg.mdMirror as Record<string, unknown>).dir === "string"
                ? ((cfg.mdMirror as Record<string, unknown>).dir as string)
                : undefined,
          }
        : undefined,
  };
}

export default memoryLanceDBProPlugin;
