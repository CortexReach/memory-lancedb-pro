/**
 * LLM Client for memory extraction and dedup decisions.
 * Supports OpenAI-compatible API, Claude Code subprocess, and OAuth.
 */

import { execSync } from "node:child_process";
import { mkdirSync, accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import {
  buildOauthEndpoint,
  extractOutputTextFromSse,
  loadOAuthSession,
  needsRefresh,
  normalizeOauthModel,
  refreshOAuthSession,
  saveOAuthSession,
} from "./llm-oauth.js";

export interface LlmClientConfig {
  apiKey?: string;
  model: string;
  baseURL?: string;
  /**
   * LLM provider type.
   * - "api-key" (default): OpenAI-compatible endpoint (openai npm package)
   * - "claude-code": Spawn a local Claude Code subprocess via @anthropic-ai/claude-agent-sdk.
   *     No apiKey/baseURL required; uses ambient Claude Code auth (subscription or ANTHROPIC_API_KEY).
   *     Requires @anthropic-ai/claude-agent-sdk to be installed.
   * - "oauth": OAuth-based endpoint (e.g. ChatGPT)
   */
  auth?: "api-key" | "claude-code" | "oauth";
  /** Path to the claude executable. Only used when auth="claude-code". Auto-detected if not set. */
  claudeCodePath?: string;
  oauthPath?: string;
  oauthProvider?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Optional warn-level logger. Used for errors / warnings; falls back to `log` if not provided. */
  logWarn?: (msg: string) => void;
  /** Plugin state directory. Reserved for future use (isolated cwd currently disabled due to OAuth issues). */
  stateDir?: string;
}

export interface LlmClient {
  /** Send a prompt and parse the JSON response. Returns null on failure. */
  completeJson<T>(prompt: string, label?: string): Promise<T | null>;
  /** Best-effort diagnostics for the most recent failure, if any. */
  getLastError(): string | null;
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find the first JSON structure (object or array)
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  
  let startIdx: number;
  let openChar: string;
  let closeChar: string;
  
  if (firstBrace === -1 && firstBracket === -1) return null;
  if (firstBrace === -1) {
    startIdx = firstBracket;
    openChar = "[";
    closeChar = "]";
  } else if (firstBracket === -1) {
    startIdx = firstBrace;
    openChar = "{";
    closeChar = "}";
  } else {
    // Use whichever comes first
    if (firstBrace < firstBracket) {
      startIdx = firstBrace;
      openChar = "{";
      closeChar = "}";
    } else {
      startIdx = firstBracket;
      openChar = "[";
      closeChar = "]";
    }
  }

  // Track depth, ignoring brackets inside strings
  let depth = 0;
  let lastClose = -1;
  let inString = false;
  let escapeNext = false;
  
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    
    if (inString) continue;
    
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        lastClose = i;
        break;
      }
    }
  }

  if (lastClose === -1) return null;
  return text.substring(startIdx, lastClose + 1);
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function nextNonWhitespaceChar(text: string, start: number): string | undefined {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) return ch;
  }
  return undefined;
}

/**
 * Best-effort repair for common LLM JSON issues:
 * - unescaped quotes inside string values
 * - raw newlines / tabs inside strings
 * - trailing commas before } or ]
 */
function repairCommonJson(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }

      if (ch === "\"") {
        const nextCh = nextNonWhitespaceChar(text, i + 1);
        if (
          nextCh === undefined ||
          nextCh === "," ||
          nextCh === "}" ||
          nextCh === "]" ||
          nextCh === ":"
        ) {
          result += ch;
          inString = false;
        } else {
          result += "\\\"";
        }
        continue;
      }

      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === "\"") {
      result += ch;
      inString = true;
      continue;
    }

    if (ch === ",") {
      const nextCh = nextNonWhitespaceChar(text, i + 1);
      if (nextCh === "}" || nextCh === "]") {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/**
 * Extract JSON from raw LLM text, parse it, and attempt heuristic repair on failure.
 * Returns { value, error } — exactly one will be set.
 * Shared by all client implementations to eliminate the duplicated parse-repair block.
 */
function parseJsonWithRepair<T>(
  raw: string,
  label: string,
  context: string,
  log: (msg: string) => void,
): { value: T; error: null } | { value: null; error: string } {
  const jsonStr = extractJsonFromResponse(raw);
  if (!jsonStr) {
    const error = `memory-lancedb-pro: llm-client [${label}] no JSON found in ${context} response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
    return { value: null, error };
  }

  try {
    return { value: JSON.parse(jsonStr) as T, error: null };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const repairedJsonStr = repairCommonJson(jsonStr);
    if (repairedJsonStr !== jsonStr) {
      try {
        const repaired = JSON.parse(repairedJsonStr) as T;
        log(
          `memory-lancedb-pro: llm-client [${label}] recovered malformed ${context} JSON via heuristic repair (jsonChars=${jsonStr.length})`,
        );
        return { value: repaired, error: null };
      } catch (repairErr) {
        const repairMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
        const error = `memory-lancedb-pro: llm-client [${label}] ${context} JSON.parse failed: ${errMsg}; repair failed: ${repairMsg} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
        return { value: null, error };
      }
    }
    const error = `memory-lancedb-pro: llm-client [${label}] ${context} JSON.parse failed: ${errMsg} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
    return { value: null, error };
  }
}

function looksLikeSseResponse(bodyText: string): boolean {
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function resolveTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
}

function createTimeoutSignal(timeoutMs?: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeoutMs(timeoutMs));
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function createApiKeyClient(config: LlmClientConfig, log: (msg: string) => void, logWarn: (msg: string) => void): LlmClient {
  if (!config.apiKey) {
    throw new Error("LLM api-key mode requires llm.apiKey or embedding.apiKey");
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 30000,
  });
  let lastError: string | null = null;

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      try {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "You are a memory extraction assistant. Always respond with valid JSON only.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
        });

        const raw = response.choices?.[0]?.message?.content;
        if (!raw) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] empty response content from model ${config.model}`;
          logWarn(lastError);
          return null;
        }
        if (typeof raw !== "string") {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${config.model}`;
          logWarn(lastError);
          return null;
        }

        const parsed = parseJsonWithRepair<T>(raw, label, "api-key", log);
        if (parsed.error) {
          lastError = parsed.error;
          logWarn(lastError);
          return null;
        }
        return parsed.value;
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        logWarn(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void, logWarn: (msg: string) => void): LlmClient {
  if (!config.oauthPath) {
    throw new Error("LLM oauth mode requires llm.oauthPath");
  }

  let cachedSessionPromise: Promise<Awaited<ReturnType<typeof loadOAuthSession>>> | null = null;
  let lastError: string | null = null;

  async function getSession() {
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(config.oauthPath!).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      session = await refreshOAuthSession(session, config.timeoutMs);
      await saveOAuthSession(config.oauthPath!, session);
      cachedSessionPromise = Promise.resolve(session);
    }
    return session;
  }

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      try {
        const session = await getSession();
        const { signal, dispose } = createTimeoutSignal(config.timeoutMs);
        const endpoint = buildOauthEndpoint(config.baseURL, config.oauthProvider);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.accessToken}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "OpenAI-Beta": "responses=experimental",
              "chatgpt-account-id": session.accountId,
              originator: "codex_cli_rs",
            },
            signal,
            body: JSON.stringify({
              model: normalizeOauthModel(config.model),
              instructions:
                "You are a memory extraction assistant. Always respond with valid JSON only.",
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: prompt,
                    },
                  ],
                },
              ],
              store: false,
              stream: true,
              text: {
                format: { type: "text" },
              },
            }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
          }

          const bodyText = await response.text();
          const raw = (
            response.headers.get("content-type")?.includes("text/event-stream") ||
            looksLikeSseResponse(bodyText)
          )
            ? extractOutputTextFromSse(bodyText)
            : (() => {
                try {
                  const parsed = JSON.parse(bodyText) as Record<string, unknown>;
                  const output = Array.isArray(parsed.output) ? parsed.output : [];
                  const first = output.find(
                    (item) =>
                      item &&
                      typeof item === "object" &&
                      Array.isArray((item as Record<string, unknown>).content),
                  ) as Record<string, unknown> | undefined;
                  if (!first) return null;
                  const content = (first.content as Array<Record<string, unknown>>).find(
                    (part) => part?.type === "output_text" && typeof part.text === "string",
                  );
                  return typeof content?.text === "string" ? content.text : null;
                } catch (parseErr) {
                  lastError = `memory-lancedb-pro: llm-client [${label}] failed to parse OAuth response body: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} (preview=${JSON.stringify(previewText(bodyText))})`;
                  logWarn(lastError);
                  return null;
                }
              })();

          if (!raw) {
            lastError =
              `memory-lancedb-pro: llm-client [${label}] empty OAuth response content from model ${config.model}`;
            logWarn(lastError);
            return null;
          }

          const parsed = parseJsonWithRepair<T>(raw, label, "OAuth", log);
          if (parsed.error) {
            lastError = parsed.error;
            logWarn(lastError);
            return null;
          }
          return parsed.value;
        } finally {
          dispose();
        }
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        logWarn(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code subprocess client
// ---------------------------------------------------------------------------

/** Env var prefixes / exact keys that must be stripped to avoid
 *  "cannot be launched inside another Claude Code session" errors.
 *  Mirrors the logic in claude-mem's env-sanitizer.ts.
 */
const CLAUDE_CODE_STRIP_PREFIXES = ["CLAUDECODE_", "CLAUDE_CODE_"];
// CLAUDE_CODE_ENTRYPOINT is intentionally stripped from the parent process env and
// then re-injected with value "sdk-ts" below. Stripping prevents the parent's
// value from leaking into the subprocess; re-injecting marks this subprocess as
// an SDK session so Claude Code does not refuse to launch inside another session.
const CLAUDE_CODE_STRIP_EXACT = new Set(["CLAUDECODE", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_ENTRYPOINT", "MCP_SESSION_ID"]);
/** Keys that start with CLAUDE_CODE_ but must be preserved for subprocess auth */
const CLAUDE_CODE_PRESERVE = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"]);
/** Returns true if the env key should be stripped for Claude Code subprocess isolation. */
function shouldStripClaudeCodeEnvKey(key: string): boolean {
  if (CLAUDE_CODE_PRESERVE.has(key)) return false;
  if (CLAUDE_CODE_STRIP_EXACT.has(key)) return true;
  return CLAUDE_CODE_STRIP_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Build a sanitized environment for the Claude Code subprocess.
 *
 * Strategy (mirrors claude-mem's env-sanitizer + EnvManager):
 * - If `explicitApiKey` is provided: strip ambient ANTHROPIC_API_KEY and re-inject
 *   the explicit one so the configured key takes precedence.
 * - If `explicitApiKey` is NOT provided: preserve ambient ANTHROPIC_API_KEY so that
 *   users relying on an environment-level key (e.g. CI) still authenticate correctly.
 *   CLI subscription auth (ANTHROPIC_AUTH_TOKEN) also passes through.
 * - Always strip CLAUDECODE_* / CLAUDE_CODE_* vars (except preserved ones) to prevent
 *   "cannot be launched inside another Claude Code session" errors.
 *
 * @param explicitApiKey - API key from llm.apiKey config. Pass undefined to rely on ambient auth.
 * @param log - Optional debug-level logger.
 * @param logWarn - Optional warn-level logger; used for auth-related warnings. Falls back to `log`.
 */
export function buildClaudeCodeEnv(
  explicitApiKey?: string,
  log?: (msg: string) => void,
  logWarn?: (msg: string) => void,
  /** Override path for ~/.claude/settings.json — used in tests to bypass real settings. */
  settingsPathOverride?: string,
): Record<string, string> {
  const hasExplicitKey = !!explicitApiKey;
  const env: Record<string, string> = {};

  // Load Claude Code's settings.json env (OAuth tokens, ANTHROPIC_BASE_URL, etc.)
  const warn = logWarn ?? log;
  try {
    const settingsPath = settingsPathOverride ?? join(homedir(), ".claude", "settings.json");
    const settingsRaw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw) as { env?: Record<string, string> };
    if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) {
      for (const [k, v] of Object.entries(settings.env)) {
        // Skip strip-listed keys to prevent nested session issues
        if (typeof v === "string" && !shouldStripClaudeCodeEnvKey(k)) {
          env[k] = v;
        }
      }
    }
  } catch (settingsErr) {
    const code = (settingsErr as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // ENOENT (file not found) is expected; other errors (SyntaxError, permission) should warn
      const errType = settingsErr instanceof SyntaxError ? "JSON parse error" : 
                      code === "EACCES" ? "permission denied" : "read error";
      const msg = `memory-lancedb-pro: llm-client [claude-code] failed to load ~/.claude/settings.json (${errType}: ${settingsErr instanceof Error ? settingsErr.message : String(settingsErr)}) — OAuth tokens from settings.json will NOT be available; falling back to ambient environment only`;
      (warn ?? console.warn)(msg);
    }
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" && hasExplicitKey) continue;
    if (shouldStripClaudeCodeEnvKey(k)) continue;
    // settings.json takes precedence for auth keys to prevent stale env vars from overriding fresh tokens
    const isAuthKey = k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDE_CODE_OAUTH_TOKEN";
    if (isAuthKey && env[k]) continue; // already set from settings.json
    env[k] = v;
  }

  // Mark as SDK subprocess to prevent "nested Claude Code" errors
  env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts";

  if (hasExplicitKey) {
    // Explicit key takes precedence; warn so operators know which auth path is active
    log?.("memory-lancedb-pro: llm-client [claude-code] using explicit llm.apiKey; ambient ANTHROPIC_API_KEY suppressed");
    env["ANTHROPIC_API_KEY"] = explicitApiKey!;
  } else if (!env["ANTHROPIC_API_KEY"] && !env["ANTHROPIC_AUTH_TOKEN"] && !env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    // No auth source at all (neither settings.json nor ambient env) — warn early
    warn?.("memory-lancedb-pro: llm-client [claude-code] no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN found; Claude Code subprocess may fail to authenticate");
  }

  return env;
}

function resolveClaudeExecutable(configuredPath?: string): string {
  if (configuredPath) {
    try {
      accessSync(configuredPath, fsConstants.X_OK);
    } catch (accessErr) {
      const reason = accessErr instanceof Error ? accessErr.message : String(accessErr);
      throw new Error(`claude executable at configured path ${configuredPath} is not accessible: ${reason}`);
    }
    return configuredPath;
  }
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const firstLine = output.split(/\r?\n/)[0].trim();
    if (!firstLine) {
      throw new Error(
        "which/where claude returned an empty path. " +
        "Install Claude Code (npm i -g @anthropic-ai/claude-code) or set llm.claudeCodePath in your config.",
      );
    }
    return firstLine;
  } catch (execErr) {
    const errNode = execErr as NodeJS.ErrnoException & { status?: number };
    const reason = execErr instanceof Error ? execErr.message : String(execErr);
    // Distinguish "not found" (exit 127 / ENOENT) from runtime errors (ENOMEM, EACCES, etc.)
    const isNotFound =
      errNode.code === "ENOENT" ||
      errNode.status === 127 ||
      reason.includes("not found") ||
      reason.includes("no such file");
    if (isNotFound) {
      throw new Error(
        "The 'claude' executable was not found. " +
        "Install Claude Code (npm i -g @anthropic-ai/claude-code) or set llm.claudeCodePath in your config.",
      );
    }
    throw new Error(
      `Could not locate the 'claude' executable due to a system error (${reason}). ` +
      "Install Claude Code (npm i -g @anthropic-ai/claude-code) or set llm.claudeCodePath in your config.",
    );
  }
}

// Tools we never want the memory subprocess to use (static — hoisted out of completeJson)
const CLAUDE_CODE_DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob",
  "WebFetch", "WebSearch", "Task", "NotebookEdit",
  "AskUserQuestion", "TodoWrite", "TodoRead", "LS",
];

/** Extract text from an SDK assistant message (content may be a block array or plain string). */
function extractTextFromSdkMessage(message: unknown): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
      .map((b: unknown) => (b as { text?: string }).text ?? "")
      .join("\n");
    return text || null;
  }
  if (typeof content === "string") return content;
  return null;
}

function createClaudeCodeClient(config: LlmClientConfig, log: (msg: string) => void, logWarn: (msg: string) => void): LlmClient {
  let lastError: string | null = null;
  // Cache the resolved claude path — and any resolution failure — so we don't
  // fork a shell on every request even after a permanent failure.
  // NOTE: cachedClaudePathError is stored WITHOUT a per-call label to avoid
  // replaying a stale label from the first failing call into subsequent calls.
  let cachedClaudePath: string | undefined;
  let cachedClaudePathError: string | null = null;
  // Cache SDK import result (both success and failure) — no need to re-import
  // on every call. Error stored as bare message (no label) to match cachedClaudePathError pattern.
  let cachedQueryFn: ((typeof import("@anthropic-ai/claude-agent-sdk"))["query"]) | undefined;
  let cachedSdkError: string | null = null;

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;

      // Dynamic import — optional dep; gives a clear error if not installed.
      // Both success (queryFn) and failure (cachedSdkError) are cached so
      // repeated calls don't re-import or retry a broken/missing module.
      if (cachedSdkError) {
        lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedSdkError}`;
        logWarn(lastError);
        return null;
      }
      if (!cachedQueryFn) {
        try {
          const sdk = await import("@anthropic-ai/claude-agent-sdk");
          if (typeof sdk.query !== "function") {
            throw new Error("sdk.query is not a function — package may be corrupted or incompatible");
          }
          cachedQueryFn = sdk.query;
        } catch (importErr) {
          const isNotFound =
            importErr instanceof Error &&
            (("code" in importErr && (importErr as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") ||
              importErr.message.includes("Cannot find module") ||
              importErr.message.includes("Cannot find package"));
          if (isNotFound) {
            cachedSdkError = "@anthropic-ai/claude-agent-sdk is not installed. Run: npm i @anthropic-ai/claude-agent-sdk";
          } else {
            cachedSdkError = `failed to load @anthropic-ai/claude-agent-sdk: ${importErr instanceof Error ? importErr.message : String(importErr)}`;
          }
          lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedSdkError}`;
          logWarn(lastError);
          return null;
        }
      }
      const queryFn = cachedQueryFn;

      // Resolve claude binary (cached per client instance; failure also cached).
      // The error is stored without a label so replayed errors are not misleadingly
      // tagged with the label from the first failing call.
      if (cachedClaudePathError) {
        lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedClaudePathError}`;
        logWarn(lastError);
        return null;
      }
      if (!cachedClaudePath) {
        try {
          cachedClaudePath = resolveClaudeExecutable(config.claudeCodePath);
        } catch (err) {
          cachedClaudePathError = err instanceof Error ? err.message : String(err);
          lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedClaudePathError}`;
          logWarn(lastError);
          return null;
        }
      }
      const claudePath = cachedClaudePath;

      // Isolated cwd to keep memory-agent sessions out of user's claude history
      let baseDir: string;
      if (config.stateDir && config.stateDir.length > 1) {
        baseDir = config.stateDir;
      } else {
        if (config.stateDir !== undefined && config.stateDir.length <= 1) {
          logWarn(`memory-lancedb-pro: llm-client [claude-code] ignoring unsafe stateDir="${config.stateDir}" (path too short); using default path`);
        }
        baseDir = join(homedir(), ".openclaw", "memory-lancedb-pro");
      }
      const sessionDir = join(baseDir, "claude-code-sessions");
      try {
        mkdirSync(sessionDir, { recursive: true }); // no-op if already exists
      } catch (err) {
        lastError = `memory-lancedb-pro: llm-client [${label}] failed to create session dir ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`;
        logWarn(lastError);
        return null;
      }

      const env = buildClaudeCodeEnv(config.apiKey, log, logWarn);
      const model = config.model;

      const effectiveTimeoutMs = resolveTimeoutMs(config.timeoutMs);
      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => abortController.abort(), effectiveTimeoutMs);
      const disposeTimeout = () => clearTimeout(timeoutTimer);
      try {
        const result = queryFn({
          prompt,
          options: {
            model,
            // cwd: sessionDir, // Temporarily disabled: isolated cwd may cause Claude Code auth issues
            pathToClaudeCodeExecutable: claudePath,
            disallowedTools: CLAUDE_CODE_DISALLOWED_TOOLS,
            env,
            abortController,
          },
        });

        // Collect the final result from the SDK stream.
        // We prefer the `result` message (subtype=success) which contains the
        // aggregated assistant output. SDKResultError subtypes (error_during_execution,
        // error_max_turns, error_max_budget_usd) are surfaced explicitly.
        // Falling back to the last `assistant` message handles edge cases where `result` is absent.
        let raw: string | null = null;
        let sawResultMessage = false;
        for await (const message of result) {
          if (message.type === "result") {
            sawResultMessage = true;
            const msg = message as { subtype?: string; result?: string; errors?: unknown[] };
            if (msg.subtype !== "success") {
              // Subprocess reported an error (auth failure, budget exceeded, etc.)
              const errorDetail = Array.isArray(msg.errors) && msg.errors.length > 0
                ? msg.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ")
                : (msg.subtype ?? "unknown");
              lastError = `memory-lancedb-pro: llm-client [${label}] claude-code subprocess failed (subtype=${msg.subtype ?? "unknown"}): ${errorDetail}`;
              logWarn(lastError);
              return null;
            }
            if (typeof msg.result === "string") {
              raw = msg.result;
            } else {
              // SDK returned non-string result - log as warning and set lastError for debugging
              lastError = `memory-lancedb-pro: llm-client [${label}] result.result is not a string (type=${typeof msg.result}), will attempt assistant fallback`;
              logWarn(lastError);
              raw = null;
            }
            break;
          }
          if (message.type === "assistant") {
            const text = extractTextFromSdkMessage(message);
            if (text) raw = text; // keep last assistant text as fallback
          } else if (message.type === "error") {
            // SDK error message type - treat as fatal, not debug
            const errMsg = message as { error?: string; message?: string };
            lastError = `memory-lancedb-pro: llm-client [${label}] SDK error: ${errMsg.error ?? errMsg.message ?? JSON.stringify(message)}`;
            logWarn(lastError);
            return null;
          } else if (message.type !== "system" && message.type !== "user") {
            // Log unknown message types for debugging SDK changes
            log?.(`memory-lancedb-pro: llm-client [${label}] unknown SDK message type=${message.type}`);
          }
        }
        
        // If we used assistant fallback without a result message, log it
        if (!sawResultMessage && raw) {
          log?.(`memory-lancedb-pro: llm-client [${label}] no result message received, using assistant text fallback`);
        }

        if (!raw) {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code returned empty response for model ${model}`;
          logWarn(lastError);
          return null;
        }

        const parsed = parseJsonWithRepair<T>(raw, label, "claude-code", log);
        if (parsed.error) {
          lastError = parsed.error;
          logWarn(lastError);
          return null;
        }
        return parsed.value;
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code timed out after ${effectiveTimeoutMs}ms for model ${model}. Increase llm.timeoutMs if needed.`;
        } else {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code request failed for model ${model}: ${err instanceof Error ? err.message : String(err)}`;
        }
        logWarn(lastError);
        return null;
      } finally {
        disposeTimeout();
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  const logWarn = config.logWarn ?? log;
  if (config.auth === "oauth") {
    return createOauthClient(config, log, logWarn);
  }
  if (config.auth === "claude-code") {
    return createClaudeCodeClient(config, log, logWarn);
  }
  return createApiKeyClient(config, log, logWarn);
}

export { extractJsonFromResponse, repairCommonJson };
