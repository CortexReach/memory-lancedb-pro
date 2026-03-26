/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */

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
  api?: "openai-completions" | "anthropic-messages";
  anthropicVersion?: string;
  auth?: "api-key" | "oauth";
  oauthPath?: string;
  oauthProvider?: string;
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

  if (config.api === "anthropic-messages") {
    return createAnthropicApiKeyClient(config, log);
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

function normalizeAnthropicMessagesEndpoint(baseURL?: string): string {
  const trimmed = baseURL?.trim();
  if (!trimmed) return "https://api.anthropic.com/v1/messages";
  if (/\/messages\/?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/messages`;
}

function extractAnthropicText(payload: Record<string, unknown>): string | null {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => String((part as Record<string, unknown>).text))
    .join("");
  return text.trim() || null;
}

// TODO: anthropicGenerateJson in examples/new-session-distill/worker/lesson-extract-worker.mjs
// builds Anthropic requests independently of this function. The two may diverge over time
// (e.g. retry logic, model defaults, streaming). Consider unifying into a shared module.
function createAnthropicApiKeyClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
  let lastError: string | null = null;
  const endpoint = normalizeAnthropicMessagesEndpoint(config.baseURL);
  const anthropicVersion = config.anthropicVersion?.trim() || "2023-06-01";

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      const { signal, dispose } = createTimeoutSignal(config.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-api-key": config.apiKey!,
            "anthropic-version": anthropicVersion,
          },
          signal,
          body: JSON.stringify({
            model: config.model,
            system:
              "You are a memory extraction assistant. Always respond with valid JSON only.",
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
            max_tokens: 2048,
            temperature: 0.1,
          }),
        });

        const bodyText = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText.slice(0, 500)}`);
        }

        let raw: string | null = null;
        try {
          raw = extractAnthropicText(JSON.parse(bodyText) as Record<string, unknown>);
        } catch (error) {
          throw new Error(
            `Failed to parse Anthropic response JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!raw) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] empty Anthropic response content from model ${config.model}`;
          log(lastError);
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] no JSON object found in Anthropic response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
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
                `memory-lancedb-pro: llm-client [${label}] recovered malformed Anthropic JSON via heuristic repair (jsonChars=${jsonStr.length})`,
              );
              return repaired;
            } catch (repairErr) {
              lastError =
                `memory-lancedb-pro: llm-client [${label}] Anthropic JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
              log(lastError);
              return null;
            }
          }
          lastError =
            `memory-lancedb-pro: llm-client [${label}] Anthropic JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
          log(lastError);
          return null;
        }
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] Anthropic request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        log(lastError);
        return null;
      } finally {
        dispose();
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
    if (config.api === "anthropic-messages") {
      throw new Error("LLM oauth mode only supports llm.api=openai-completions");
    }
    return createOauthClient(config, log);
  }
  return createApiKeyClient(config, log);
}

export { extractJsonFromResponse, repairCommonJson };
