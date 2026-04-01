/**
 * LLM Client for memory extraction and dedup decisions.
 * Supports OpenAI-compatible API, OAuth, and Claude Code subprocess.
 */

import { execSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync } from "node:fs";
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
   * Authentication mode:
   * - "api-key" (default): OpenAI-compatible endpoint with API key
   * - "oauth": OAuth-based endpoint (e.g. ChatGPT)
   * - "claude-code": Local Claude Code subprocess (requires @anthropic-ai/claude-agent-sdk)
   */
  auth?: "api-key" | "oauth" | "claude-code";
  oauthPath?: string;
  oauthProvider?: string;
  /** Path to the claude executable. Only used when auth="claude-code". Auto-detected if not set. */
  claudeCodePath?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
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
                } catch {
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
 */
const CLAUDE_CODE_STRIP_PREFIXES = ["CLAUDECODE_", "CLAUDE_CODE_"];
const CLAUDE_CODE_STRIP_EXACT = new Set(["CLAUDECODE", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_ENTRYPOINT", "MCP_SESSION_ID"]);
/** Keys that start with CLAUDE_CODE_ but must be preserved for subprocess auth */
const CLAUDE_CODE_PRESERVE = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"]);

function shouldStripClaudeCodeEnvKey(key: string): boolean {
  if (CLAUDE_CODE_PRESERVE.has(key)) return false;
  if (CLAUDE_CODE_STRIP_EXACT.has(key)) return true;
  return CLAUDE_CODE_STRIP_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Build a sanitized environment for the Claude Code subprocess.
 * Strips CLAUDECODE_* / CLAUDE_CODE_* vars to prevent nested-session errors,
 * but preserves auth tokens and re-injects CLAUDE_CODE_ENTRYPOINT=sdk-ts.
 */
export function buildClaudeCodeEnv(explicitApiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};
  const hasExplicitKey = !!explicitApiKey;

  // Try loading settings.json for OAuth tokens / base URL
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const settingsRaw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw) as { env?: Record<string, string> };
    if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) {
      for (const [k, v] of Object.entries(settings.env)) {
        if (typeof v === "string" && !shouldStripClaudeCodeEnvKey(k)) {
          env[k] = v;
        }
      }
    }
  } catch {
    // ENOENT or parse error → ignore silently (settings.json is optional)
  }

  // Hoist outside loop to avoid re-reading process.env on every iteration
  const envAuthPriority = process.env["CLAUDE_CODE_ENV_AUTH_PRIORITY"] === "1";

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" && hasExplicitKey) continue;
    if (shouldStripClaudeCodeEnvKey(k)) continue;
    // settings.json auth keys take precedence over ambient env by default
    const isAuthKey = k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDE_CODE_OAUTH_TOKEN";
    if (isAuthKey && env[k] && !envAuthPriority) continue; // settings.json wins
    env[k] = v;
  }

  // Mark as SDK subprocess to prevent "nested Claude Code" errors
  env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-ts";

  if (hasExplicitKey) {
    env["ANTHROPIC_API_KEY"] = explicitApiKey!;
  }

  return env;
}

/**
 * Resolve the path to the claude executable.
 * Uses `which` (Unix) / `where` (Windows) if claudeCodePath not provided.
 */
function resolveClaudeExecutable(claudeCodePath?: string): string {
  if (claudeCodePath) return claudeCodePath;

  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const output = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const firstLine = output.split("\n")[0].trim();
    if (!firstLine) throw new Error("empty output from which/where");
    return firstLine;
  } catch (execErr) {
    const errNode = execErr as { code?: string; status?: number };
    const isNotFound = errNode.code === "ENOENT" || errNode.status === 127;
    if (isNotFound) {
      throw new Error(
        "The 'claude' executable was not found. " +
        "Install Claude Code (npm i -g @anthropic-ai/claude-code) or set llm.claudeCodePath in your config."
      );
    }
    throw new Error(
      `Could not locate the 'claude' executable: ${execErr instanceof Error ? execErr.message : String(execErr)}`
    );
  }
}

// Tools we never want the memory subprocess to use
const CLAUDE_CODE_DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob",
  "WebFetch", "WebSearch", "Task", "NotebookEdit",
  "AskUserQuestion", "TodoWrite", "TodoRead", "LS",
];

function createClaudeCodeClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
  let lastError: string | null = null;
  let cachedSdkError: string | null = null; // Cache SDK import failure
  let cachedQueryFn: any = null;
  let claudePath: string | null = null;
  let cachedClaudePathError: string | null = null;

  return {
    async completeJson<T>(prompt: string, label = "extract"): Promise<T | null> {
      lastError = null;

      // One-time SDK import (cached on success or failure)
      if (!cachedQueryFn && !cachedSdkError) {
        try {
          const sdk = await import("@anthropic-ai/claude-agent-sdk");
          cachedQueryFn = sdk.query;
        } catch (importErr: any) {
          const isModuleNotFound =
            ("code" in importErr && importErr.code === "MODULE_NOT_FOUND") ||
            importErr.message?.includes("Cannot find module");
          if (isModuleNotFound) {
            cachedSdkError =
              "@anthropic-ai/claude-agent-sdk not found. Install it with: npm i @anthropic-ai/claude-agent-sdk";
          } else {
            cachedSdkError = `SDK import failed: ${importErr.message ?? String(importErr)}`;
          }
        }
      }

      if (cachedSdkError) {
        lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedSdkError}`;
        log(lastError);
        return null;
      }

      // One-time claude path resolution (cached on success or failure)
      if (!claudePath && !cachedClaudePathError) {
        try {
          claudePath = resolveClaudeExecutable(config.claudeCodePath);
        } catch (pathErr) {
          cachedClaudePathError = pathErr instanceof Error ? pathErr.message : String(pathErr);
        }
      }

      if (cachedClaudePathError) {
        lastError = `memory-lancedb-pro: llm-client [${label}] ${cachedClaudePathError}`;
        log(lastError);
        return null;
      }

      const env = buildClaudeCodeEnv(config.apiKey);
      const model = config.model;
      const effectiveTimeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 30_000;

      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

      try {
        const result = cachedQueryFn({
          prompt,
          options: {
            model,
            pathToClaudeCodeExecutable: claudePath,
            disallowedTools: CLAUDE_CODE_DISALLOWED_TOOLS,
            env,
            abortController,
          },
        });

        let raw: string | null = null;
        let sawResultMessage = false;

        for await (const message of result) {
          if (message.type === "result") {
            sawResultMessage = true;
            const msg = message as { subtype?: string; result?: string; errors?: unknown[] };
            if (msg.subtype !== "success") {
              const errorDetail = Array.isArray(msg.errors) ? JSON.stringify(msg.errors) : msg.subtype ?? "unknown";
              lastError = `memory-lancedb-pro: llm-client [${label}] claude-code subprocess failed (subtype=${msg.subtype ?? "unknown"}): ${errorDetail}`;
              log(lastError);
              return null;
            }
            if (typeof msg.result === "string") {
              raw = msg.result;
            } else {
              const nonStringResultError = `memory-lancedb-pro: llm-client [${label}] result.result is not a string (type=${typeof msg.result})`;
              log(nonStringResultError);
              lastError = nonStringResultError;
              raw = null;
            }
            break;
          }
          if (message.type === "assistant") {
            // Fallback: extract text from assistant message if no result message received
            const content = (message as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              const text = content
                .filter((b: unknown) => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
                .map((b: unknown) => (b as { text?: string }).text ?? "")
                .join("\n");
              if (text) raw = text;
            } else if (typeof content === "string") {
              raw = content;
            }
          } else if (message.type === "error") {
            const errMsg = message as { error?: string; message?: string };
            lastError = `memory-lancedb-pro: llm-client [${label}] SDK error: ${errMsg.error ?? errMsg.message ?? JSON.stringify(message)}`;
            log(lastError);
            return null;
          }
        }

        if (!sawResultMessage && raw) {
          log(`memory-lancedb-pro: llm-client [${label}] no result message received, using assistant text fallback`);
        }

        if (!raw) {
          if (!lastError) {
            lastError = `memory-lancedb-pro: llm-client [${label}] claude-code returned empty response for model ${model}`;
            log(lastError);
          }
          return null;
        }

        // JSON extraction + parse (duplicated from extractJsonFromResponse to avoid refactor dependency)
        const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        const jsonStr = fenceMatch ? fenceMatch[1].trim() : (() => {
          const firstBrace = raw.indexOf("{");
          if (firstBrace === -1) return null;
          let depth = 0;
          let lastBrace = -1;
          for (let i = firstBrace; i < raw.length; i++) {
            if (raw[i] === "{") depth++;
            else if (raw[i] === "}") {
              depth--;
              if (depth === 0) {
                lastBrace = i;
                break;
              }
            }
          }
          return lastBrace === -1 ? null : raw.substring(firstBrace, lastBrace + 1);
        })();

        if (!jsonStr) {
          lastError = `memory-lancedb-pro: llm-client [${label}] no JSON found in claude-code response`;
          log(lastError);
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          lastError = `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`;
          log(lastError);
          return null;
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code timed out after ${effectiveTimeoutMs}ms for model ${model}`;
        } else {
          lastError = `memory-lancedb-pro: llm-client [${label}] claude-code request failed for model ${model}: ${err instanceof Error ? err.message : String(err)}`;
        }
        log(lastError);
        return null;
      } finally {
        clearTimeout(timeoutTimer);
      }
    },

    getLastError(): string | null {
      return lastError;
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  if (config.auth === "claude-code") {
    return createClaudeCodeClient(config, log);
  }
  if (config.auth === "oauth") {
    return createOauthClient(config, log);
  }
  return createApiKeyClient(config, log);
}

export { extractJsonFromResponse, repairCommonJson };
