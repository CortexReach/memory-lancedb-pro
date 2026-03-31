/**
 * LLM Client for memory extraction and dedup decisions.
 * Supports OpenAI-compatible API, Claude Code subprocess, and OAuth.
 */

import { execSync } from "node:child_process";
import { mkdirSync, existsSync, accessSync, constants as fsConstants } from "node:fs";
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
  /** Plugin state directory. Used by claude-code auth to create an isolated cwd for subprocess sessions. */
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

  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;
  return text.substring(firstBrace, lastBrace + 1);
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

function looksLikeSseResponse(bodyText: string): boolean {
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function createTimeoutSignal(timeoutMs?: number): { signal: AbortSignal; dispose: () => void } {
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function createApiKeyClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
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
          log(lastError);
          return null;
        }
        if (typeof raw !== "string") {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${config.model}`;
          log(lastError);
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] no JSON object found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
          log(lastError);
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          const repairedJsonStr = repairCommonJson(jsonStr);
          if (repairedJsonStr !== jsonStr) {
            try {
              const repaired = JSON.parse(repairedJsonStr) as T;
              log(
                `memory-lancedb-pro: llm-client [${label}] recovered malformed JSON via heuristic repair (jsonChars=${jsonStr.length})`,
              );
              return repaired;
            } catch (repairErr) {
              lastError =
                `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
              log(lastError);
              return null;
            }
          }
          lastError =
            `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
          log(lastError);
          return null;
        }
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        log(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
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
                  log(lastError);
                  return null;
                }
              })();

          if (!raw) {
            lastError =
              `memory-lancedb-pro: llm-client [${label}] empty OAuth response content from model ${config.model}`;
            log(lastError);
            return null;
          }

          const jsonStr = extractJsonFromResponse(raw);
          if (!jsonStr) {
            lastError =
              `memory-lancedb-pro: llm-client [${label}] no JSON object found in OAuth response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
            log(lastError);
            return null;
          }

          try {
            return JSON.parse(jsonStr) as T;
          } catch (err) {
            const repairedJsonStr = repairCommonJson(jsonStr);
            if (repairedJsonStr !== jsonStr) {
              try {
                const repaired = JSON.parse(repairedJsonStr) as T;
                log(
                  `memory-lancedb-pro: llm-client [${label}] recovered malformed OAuth JSON via heuristic repair (jsonChars=${jsonStr.length})`,
                );
                return repaired;
              } catch (repairErr) {
                lastError =
                  `memory-lancedb-pro: llm-client [${label}] OAuth JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
                log(lastError);
                return null;
              }
            }
            lastError =
              `memory-lancedb-pro: llm-client [${label}] OAuth JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
            log(lastError);
            return null;
          }
        } finally {
          dispose();
        }
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        log(lastError);
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
const CLAUDE_CODE_STRIP_EXACT = new Set(["CLAUDECODE", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_ENTRYPOINT", "MCP_SESSION_ID"]);
/** Keys that start with CLAUDE_CODE_ but must be preserved for subprocess auth */
const CLAUDE_CODE_PRESERVE = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"]);
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
 * @param log - Optional logger; used to emit a warning when stripping ambient ANTHROPIC_API_KEY.
 */
export function buildClaudeCodeEnv(
  explicitApiKey?: string,
  log?: (msg: string) => void,
): Record<string, string> {
  const hasExplicitKey = !!explicitApiKey;
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Strip ambient ANTHROPIC_API_KEY only when an explicit key is provided
    if (k === "ANTHROPIC_API_KEY" && hasExplicitKey) continue;
    if (CLAUDE_CODE_PRESERVE.has(k)) { env[k] = v; continue; }
    if (CLAUDE_CODE_STRIP_EXACT.has(k)) continue;
    if (CLAUDE_CODE_STRIP_PREFIXES.some(p => k.startsWith(p))) continue;
    env[k] = v;
  }

  // Mark as SDK subprocess to prevent "nested Claude Code" errors
  env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts";

  if (hasExplicitKey) {
    // Explicit key takes precedence; warn so operators know which auth path is active
    log?.("memory-lancedb-pro: llm-client [claude-code] using explicit llm.apiKey; ambient ANTHROPIC_API_KEY suppressed");
    env["ANTHROPIC_API_KEY"] = explicitApiKey!;
  } else if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    // No auth source at all — warn early rather than letting the subprocess fail silently
    log?.("memory-lancedb-pro: llm-client [claude-code] WARNING: no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN found; Claude Code subprocess may fail to authenticate");
  }

  return env;
}

function resolveClaudeExecutable(configuredPath?: string): string {
  if (configuredPath) {
    try {
      accessSync(configuredPath, fsConstants.X_OK);
    } catch {
      throw new Error(`claude executable not found or not executable at configured path: ${configuredPath}`);
    }
    return configuredPath;
  }
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (execErr) {
    const reason = execErr instanceof Error ? execErr.message : String(execErr);
    throw new Error(
      `Could not find the 'claude' executable (${reason}). ` +
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

function createClaudeCodeClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
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
        log(lastError);
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
          log(lastError);
          return null;
        }
      }
      const queryFn = cachedQueryFn;

      // Resolve claude binary (cached per client instance; failure also cached).
      // The error is stored without a label so replayed errors are not misleadingly
      // tagged with the label from the first failing call.
      if (cachedClaudePathError) {
        lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedClaudePathError}`;
        log(lastError);
        return null;
      }
      if (!cachedClaudePath) {
        try {
          cachedClaudePath = resolveClaudeExecutable(config.claudeCodePath);
        } catch (err) {
          cachedClaudePathError = err instanceof Error ? err.message : String(err);
          lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedClaudePathError}`;
          log(lastError);
          return null;
        }
      }
      const claudePath = cachedClaudePath;

      // Isolated cwd to keep memory-agent sessions out of user's claude history
      const sessionDir = join(config.stateDir ?? join(homedir(), ".openclaw", "memory-lancedb-pro"), "claude-code-sessions");
      try {
        mkdirSync(sessionDir, { recursive: true }); // no-op if already exists
      } catch (err) {
        lastError = `memory-lancedb-pro: llm-client [${label}] failed to create session dir ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`;
        log(lastError);
        return null;
      }

      const env = buildClaudeCodeEnv(config.apiKey, log);
      const model = config.model;

      const effectiveTimeoutMs =
        typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
          ? config.timeoutMs
          : 30_000;
      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => abortController.abort(), effectiveTimeoutMs);
      const disposeTimeout = () => clearTimeout(timeoutTimer);
      try {
        const result = queryFn({
          prompt,
          options: {
            model,
            cwd: sessionDir,
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
        for await (const message of result) {
          if (message.type === "result") {
            const msg = message as { subtype?: string; result?: string; errors?: unknown[] };
            if (msg.subtype !== "success") {
              // Subprocess reported an error (auth failure, budget exceeded, etc.)
              const errorDetail = Array.isArray(msg.errors) && msg.errors.length > 0
                ? msg.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ")
                : (msg.subtype ?? "unknown");
              lastError = `memory-lancedb-pro: llm-client [${label}] claude-code subprocess failed (subtype=${msg.subtype ?? "unknown"}): ${errorDetail}`;
              log(lastError);
              return null;
            }
            raw = typeof msg.result === "string" ? msg.result : null;
            break;
          }
          if (message.type === "assistant") {
            const content = (message as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              const text = content
                .filter((b: unknown) => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
                .map((b: unknown) => (b as { text?: string }).text ?? "")
                .join("\n");
              if (text) raw = text; // keep last assistant text as fallback
            } else if (typeof content === "string") {
              raw = content;
            }
          }
        }

        if (!raw) {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code returned empty response for model ${model}`;
          log(lastError);
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          lastError = `memory-lancedb-pro: llm-client [${label}] no JSON found in claude-code response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
          log(lastError);
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          const repairedJsonStr = repairCommonJson(jsonStr);
          if (repairedJsonStr !== jsonStr) {
            try {
              const repaired = JSON.parse(repairedJsonStr) as T;
              log(`memory-lancedb-pro: llm-client [${label}] recovered malformed claude-code JSON via repair (jsonChars=${jsonStr.length})`);
              return repaired;
            } catch (repairErr) {
              lastError = `memory-lancedb-pro: llm-client [${label}] claude-code JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`;
              log(lastError);
              return null;
            }
          }
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (preview=${JSON.stringify(previewText(jsonStr))})`;
          log(lastError);
          return null;
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code timed out after ${effectiveTimeoutMs}ms for model ${model}. Increase llm.timeoutMs if needed.`;
        } else {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code request failed for model ${model}: ${err instanceof Error ? err.message : String(err)}`;
        }
        log(lastError);
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
  if (config.auth === "oauth") {
    return createOauthClient(config, log);
  }
  if (config.auth === "claude-code") {
    return createClaudeCodeClient(config, log);
  }
  return createApiKeyClient(config, log);
}

export { extractJsonFromResponse, repairCommonJson };
