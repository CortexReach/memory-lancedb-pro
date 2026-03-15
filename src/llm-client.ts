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
}

export interface LlmClient {
  /** Send a prompt and parse the JSON response. Returns null on failure. */
  completeJson<T>(prompt: string, label?: string): Promise<T | null>;
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text: string): string | null {
  // Try markdown code fence first (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try balanced brace extraction
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

function looksLikeSseResponse(bodyText: string): boolean {
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
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

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
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
          log(
            `memory-lancedb-pro: llm-client [${label}] empty response content from model ${config.model}`,
          );
          return null;
        }
        if (typeof raw !== "string") {
          log(
            `memory-lancedb-pro: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${config.model}`,
          );
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          log(
            `memory-lancedb-pro: llm-client [${label}] no JSON object found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`,
          );
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          log(
            `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
          );
          return null;
        }
      } catch (err) {
        log(
          `memory-lancedb-pro: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void): LlmClient {
  if (!config.oauthPath) {
    throw new Error("LLM oauth mode requires llm.oauthPath");
  }

  let cachedSessionPromise: Promise<Awaited<ReturnType<typeof loadOAuthSession>>> | null = null;

  async function getSession() {
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(config.oauthPath!);
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      session = await refreshOAuthSession(session);
      cachedSessionPromise = Promise.resolve(session);
    }
    return session;
  }

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      try {
        const session = await getSession();
        const endpoint = buildOauthEndpoint(config.baseURL, config.oauthProvider);
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
          log(
            `memory-lancedb-pro: llm-client [${label}] empty OAuth response content from model ${config.model}`,
          );
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          log(
            `memory-lancedb-pro: llm-client [${label}] no JSON object found in OAuth response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`,
          );
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          log(
            `memory-lancedb-pro: llm-client [${label}] OAuth JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
          );
          return null;
        }
      } catch (err) {
        log(
          `memory-lancedb-pro: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  if (config.auth === "oauth") {
    return createOauthClient(config, log);
  }
  return createApiKeyClient(config, log);
}

export { extractJsonFromResponse };
