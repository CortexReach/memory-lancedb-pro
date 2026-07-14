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
  auth?: "api-key" | "oauth";
  oauthPath?: string;
  oauthProvider?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Warn-level logger for user-visible failures (timeouts, retries, network errors). */
  warnLog?: (msg: string) => void;
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
  text = stripReasoningTrace(text);

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

function stripReasoningTrace(text: string): string {
  const closingThinkTag = text.toLowerCase().lastIndexOf("</think>");
  if (closingThinkTag === -1) return text;
  return text.slice(closingThinkTag + "</think>".length).trim();
}

/**
 * Best-effort recovery when a model streams its answer only into a reasoning
 * field and leaves the regular content empty (e.g. a gateway that doesn't
 * honor enable_thinking:false). Checks both naming conventions seen across
 * providers: OpenAI/DeepSeek's `reasoning_content` and vLLM's `reasoning`.
 */
function pickReasoningText(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  const reasoningContent = record.reasoning_content;
  if (typeof reasoningContent === "string" && reasoningContent.trim()) return reasoningContent;
  const reasoning = record.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
  return undefined;
}

function recoverJsonFromReasoning<T>(reasoningText: string | undefined): T | null {
  if (!reasoningText) return null;
  const jsonStr = extractJsonFromResponse(reasoningText);
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}

/**
 * Per-model-family rules for disabling thinking/reasoning in JSON extraction
 * requests. Different providers honor different request-body parameter shapes,
 * and the same model can require a different parameter depending on which
 * endpoint hosts it — e.g. `deepseek-v4-flash` uses
 * `chat_template_kwargs.enable_thinking=false` on Aliyun DashScope but
 * `thinking.type="disabled"` on DeepSeek's own API.
 *
 * Each rule maps a model-name pattern to a list of provider entries; the first
 * entry whose `baseURL` pattern matches the configured base URL wins, with a
 * `default` entry as the fallback for unknown aggregators (most vLLM-based
 * aggregators follow the DashScope `chat_template_kwargs` convention).
 *
 * When no rule matches, no parameter is injected and the
 * `recoverJsonFromReasoning` fallback (PR #914) handles models that stream
 * their answer only into a reasoning field.
 *
 * Parameters are sourced from each provider's official API documentation:
 *  - DashScope (qwen3/qwq/deepseek-r1/deepseek-v4): chat_template_kwargs.enable_thinking — verified
 *  - DeepSeek official (deepseek-v4-pro/flash): thinking.type=disabled — api-docs.deepseek.com
 *  - Zhipu GLM-4.6/GLM-Z1: thinking.type=disabled — docs.bigmodel.cn
 *  - Volcano Ark doubao-thinking/seed: thinking.type=disabled — docs.volcengine.com (OpenAI-compat /api/v3)
 *  - Moonshot Kimi K1.5/K2: thinking.type=disabled — platform.kimi.com
 *  - MiniMax M2/abab: thinking_budget=0 — api.minimax.chat
 *  - Tencent Hunyuan T1/Turbo-S: enable_thinking=false — cloud.tencent.com
 *  - StepFun step-3/step-2: thinking=false — developer.stepfun.com
 */
interface ReasoningDisableProviderEntry {
  /** Matched against the configured baseURL (case-insensitive). "default" = fallback. */
  baseURL: RegExp | "default";
  params: Record<string, unknown>;
}

interface ReasoningDisableRule {
  modelPattern: RegExp;
  providers: ReasoningDisableProviderEntry[];
}

const REASONING_DISABLE_RULES: ReasoningDisableRule[] = [
  {
    // Qwen3 / QwQ — DashScope chat_template_kwargs (verified). vLLM-based
    // aggregators (SiliconFlow, etc.) follow the same convention.
    modelPattern: /qwen3|qwq/i,
    providers: [
      { baseURL: "default", params: { chat_template_kwargs: { enable_thinking: false } } },
    ],
  },
  {
    // DeepSeek V4 / R1 family.
    //  - DashScope (Aliyun) hosts deepseek-v4-flash and uses chat_template_kwargs
    //    (verified, issue #929 — reasoning drops to 0, completion tokens -82%).
    //  - DeepSeek's own API (api.deepseek.com) uses thinking.type=disabled for
    //    v4-pro/v4-flash. deepseek-reasoner (R1) on the official API is a pure
    //    reasoning model and cannot disable thinking.
    modelPattern: /deepseek.*(v\d|r1)/i,
    providers: [
      { baseURL: /dashscope|aliyun/i, params: { chat_template_kwargs: { enable_thinking: false } } },
      { baseURL: /deepseek\.com/i, params: { thinking: { type: "disabled" } } },
      { baseURL: "default", params: { chat_template_kwargs: { enable_thinking: false } } },
    ],
  },
  {
    // Zhipu GLM-4.6 / GLM-Z1 — thinking.type=disabled (docs.bigmodel.cn).
    modelPattern: /glm.*(4\.6|z1)|glm.*thinking/i,
    providers: [
      { baseURL: "default", params: { thinking: { type: "disabled" } } },
    ],
  },
  {
    // Volcano Ark doubao thinking/seed models — thinking.type=disabled on the
    // OpenAI-compatible /api/v3/chat/completions endpoint (docs.volcengine.com).
    // Non-thinking variants (doubao-1.5-pro, etc.) are intentionally excluded.
    modelPattern: /doubao.*(thinking|seed)/i,
    providers: [
      { baseURL: "default", params: { thinking: { type: "disabled" } } },
    ],
  },
  {
    // Moonshot Kimi K1.5 / K2 — thinking.type=disabled (platform.kimi.com).
    // Note: kimi-k2.7-code cannot disable thinking.
    modelPattern: /kimi.*k[12]|kimi.*thinking/i,
    providers: [
      { baseURL: "default", params: { thinking: { type: "disabled" } } },
    ],
  },
  {
    // MiniMax M2 / abab — thinking_budget=0 (api.minimax.chat).
    modelPattern: /minimax.*m2|abab/i,
    providers: [
      { baseURL: "default", params: { thinking_budget: 0 } },
    ],
  },
  {
    // Tencent Hunyuan T1 / Turbo-S — enable_thinking=false (cloud.tencent.com).
    modelPattern: /hunyuan.*(t1|turbo)/i,
    providers: [
      { baseURL: "default", params: { enable_thinking: false } },
    ],
  },
  {
    // StepFun step-3 / step-2 — thinking=false (developer.stepfun.com).
    modelPattern: /step-[32]/i,
    providers: [
      { baseURL: "default", params: { thinking: false } },
    ],
  },
];

/**
 * Build the request-body parameters that disable thinking/reasoning for the
 * given model on the given provider endpoint, or `null` if the model is not a
 * known reasoning model. The provider (baseURL) is consulted so that models
 * hosted on different endpoints receive the correct parameter shape.
 */
function buildDisableReasoningParams(
  model: string,
  baseURL?: string,
): Record<string, unknown> | null {
  for (const rule of REASONING_DISABLE_RULES) {
    if (!rule.modelPattern.test(model)) continue;
    let defaultParams: Record<string, unknown> | null = null;
    for (const entry of rule.providers) {
      if (entry.baseURL === "default") {
        defaultParams = entry.params;
      } else if (baseURL && entry.baseURL.test(baseURL)) {
        return entry.params;
      }
    }
    return defaultParams;
  }
  return null;
}

function shouldDisableReasoningForJson(model: string): boolean {
  return buildDisableReasoningParams(model) !== null;
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

function createApiKeyClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
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
        const request = {
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
          ...(buildDisableReasoningParams(config.model, config.baseURL) ?? {}),
        };

        const response = await client.chat.completions.create(request as any);

        const message = response.choices?.[0]?.message;
        const raw = message?.content;
        if (!raw) {
          const recovered = recoverJsonFromReasoning<T>(pickReasoningText(message));
          if (recovered !== null) {
            log(
              `memory-lancedb-pro: llm-client [${label}] recovered JSON from reasoning field (model ${config.model})`,
            );
            return recovered;
          }
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
        (warnLog ?? log)(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
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
        (warnLog ?? log)(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  const warnLog = config.warnLog;
  if (config.auth === "oauth") {
    return createOauthClient(config, log, warnLog);
  }
  return createApiKeyClient(config, log, warnLog);
}

export { buildDisableReasoningParams, extractJsonFromResponse, repairCommonJson, shouldDisableReasoningForJson, stripReasoningTrace };
