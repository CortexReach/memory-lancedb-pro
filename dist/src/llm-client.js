/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */
import OpenAI from "openai";
import { buildOauthEndpoint, extractOutputTextFromSse, loadOAuthSession, needsRefresh, normalizeOauthModel, refreshOAuthSession, saveOAuthSession, } from "./llm-oauth.js";
/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text) {
    text = stripReasoningTrace(text);
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    const firstBrace = text.indexOf("{");
    if (firstBrace === -1)
        return null;
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < text.length; i++) {
        if (text[i] === "{")
            depth++;
        else if (text[i] === "}") {
            depth--;
            if (depth === 0) {
                lastBrace = i;
                break;
            }
        }
    }
    if (lastBrace === -1)
        return null;
    return text.substring(firstBrace, lastBrace + 1);
}
function stripReasoningTrace(text) {
    const closingThinkTag = text.toLowerCase().lastIndexOf("</think>");
    if (closingThinkTag === -1)
        return text;
    return text.slice(closingThinkTag + "</think>".length).trim();
}
/**
 * Best-effort recovery when a model streams its answer only into a reasoning
 * field and leaves the regular content empty (e.g. a gateway that doesn't
 * honor enable_thinking:false). Checks both naming conventions seen across
 * providers: OpenAI/DeepSeek's `reasoning_content` and vLLM's `reasoning`.
 */
function pickReasoningText(source) {
    if (!source || typeof source !== "object")
        return undefined;
    const record = source;
    const reasoningContent = record.reasoning_content;
    if (typeof reasoningContent === "string" && reasoningContent.trim())
        return reasoningContent;
    const reasoning = record.reasoning;
    if (typeof reasoning === "string" && reasoning.trim())
        return reasoning;
    return undefined;
}
function recoverJsonFromReasoning(reasoningText) {
    if (!reasoningText)
        return null;
    const jsonStr = extractJsonFromResponse(reasoningText);
    if (!jsonStr)
        return null;
    try {
        return JSON.parse(jsonStr);
    }
    catch {
        return null;
    }
}
function shouldDisableReasoningForJson(model) {
    return /qwen3|deepseek.*r1|qwq/i.test(model);
}
/** Restrict a call label to header-safe characters (labels are internal literals). */
function sanitizeLabelHeader(label) {
    const cleaned = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    return cleaned || "generic";
}
function previewText(value, maxLen = 200) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen)
        return normalized;
    return `${normalized.slice(0, maxLen - 3)}...`;
}
function nextNonWhitespaceChar(text, start) {
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (!/\s/.test(ch))
            return ch;
    }
    return undefined;
}
/**
 * Best-effort repair for common LLM JSON issues:
 * - unescaped quotes inside string values
 * - raw newlines / tabs inside strings
 * - trailing commas before } or ]
 */
function repairCommonJson(text) {
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
                if (nextCh === undefined ||
                    nextCh === "," ||
                    nextCh === "}" ||
                    nextCh === "]" ||
                    nextCh === ":") {
                    result += ch;
                    inString = false;
                }
                else {
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
function looksLikeSseResponse(bodyText) {
    const trimmed = bodyText.trimStart();
    return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}
function createTimeoutSignal(timeoutMs) {
    const effectiveTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
    };
}
function createApiKeyClient(config, log, warnLog) {
    if (!config.apiKey) {
        throw new Error("LLM api-key mode requires llm.apiKey or embedding.apiKey");
    }
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: config.timeoutMs ?? 30000,
    });
    let lastError = null;
    return {
        async completeJson(prompt, label = "generic", systemPrompt) {
            lastError = null;
            try {
                const request = {
                    model: config.model,
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt ??
                                "You are a memory extraction assistant. Always respond with valid JSON only.",
                        },
                        { role: "user", content: prompt },
                    ],
                    temperature: 0.1,
                    ...(shouldDisableReasoningForJson(config.model)
                        ? { chat_template_kwargs: { enable_thinking: false } }
                        : {}),
                };
                // Transmit the internal call label as a request header so gateway-side
                // observability (tracing UIs, proxy logs) can distinguish call sites
                // without any change to the prompt or sampling parameters. Applied on
                // the openai-compatible path only; the OAuth path posts to a foreign
                // endpoint with a fixed request shape and is left untouched.
                const response = await client.chat.completions.create(request, {
                    headers: { "x-memory-call-label": sanitizeLabelHeader(label) },
                });
                const message = response.choices?.[0]?.message;
                const raw = message?.content;
                if (!raw) {
                    const recovered = recoverJsonFromReasoning(pickReasoningText(message));
                    if (recovered !== null) {
                        log(`memory-lancedb-pro: llm-client [${label}] recovered JSON from reasoning field (model ${config.model})`);
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
                    return JSON.parse(jsonStr);
                }
                catch (err) {
                    const repairedJsonStr = repairCommonJson(jsonStr);
                    if (repairedJsonStr !== jsonStr) {
                        try {
                            const repaired = JSON.parse(repairedJsonStr);
                            log(`memory-lancedb-pro: llm-client [${label}] recovered malformed JSON via heuristic repair (jsonChars=${jsonStr.length})`);
                            return repaired;
                        }
                        catch (repairErr) {
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
            }
            catch (err) {
                lastError =
                    `memory-lancedb-pro: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
                (warnLog ?? log)(lastError);
                return null;
            }
        },
        getLastError() {
            return lastError;
        },
    };
}
function createOauthClient(config, log, warnLog) {
    if (!config.oauthPath) {
        throw new Error("LLM oauth mode requires llm.oauthPath");
    }
    let cachedSessionPromise = null;
    let lastError = null;
    async function getSession() {
        if (!cachedSessionPromise) {
            cachedSessionPromise = loadOAuthSession(config.oauthPath).catch((error) => {
                cachedSessionPromise = null;
                throw error;
            });
        }
        let session = await cachedSessionPromise;
        if (needsRefresh(session)) {
            session = await refreshOAuthSession(session, config.timeoutMs);
            await saveOAuthSession(config.oauthPath, session);
            cachedSessionPromise = Promise.resolve(session);
        }
        return session;
    }
    return {
        async completeJson(prompt, label = "generic", systemPrompt) {
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
                            instructions: systemPrompt ??
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
                    const raw = (response.headers.get("content-type")?.includes("text/event-stream") ||
                        looksLikeSseResponse(bodyText))
                        ? extractOutputTextFromSse(bodyText)
                        : (() => {
                            try {
                                const parsed = JSON.parse(bodyText);
                                const output = Array.isArray(parsed.output) ? parsed.output : [];
                                const first = output.find((item) => item &&
                                    typeof item === "object" &&
                                    Array.isArray(item.content));
                                if (!first)
                                    return null;
                                const content = first.content.find((part) => part?.type === "output_text" && typeof part.text === "string");
                                return typeof content?.text === "string" ? content.text : null;
                            }
                            catch {
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
                        return JSON.parse(jsonStr);
                    }
                    catch (err) {
                        const repairedJsonStr = repairCommonJson(jsonStr);
                        if (repairedJsonStr !== jsonStr) {
                            try {
                                const repaired = JSON.parse(repairedJsonStr);
                                log(`memory-lancedb-pro: llm-client [${label}] recovered malformed OAuth JSON via heuristic repair (jsonChars=${jsonStr.length})`);
                                return repaired;
                            }
                            catch (repairErr) {
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
                }
                finally {
                    dispose();
                }
            }
            catch (err) {
                lastError =
                    `memory-lancedb-pro: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
                (warnLog ?? log)(lastError);
                return null;
            }
        },
        getLastError() {
            return lastError;
        },
    };
}
export function createLlmClient(config) {
    const log = config.log ?? (() => { });
    const warnLog = config.warnLog;
    if (config.auth === "oauth") {
        return createOauthClient(config, log, warnLog);
    }
    return createApiKeyClient(config, log, warnLog);
}
export { extractJsonFromResponse, repairCommonJson, shouldDisableReasoningForJson, stripReasoningTrace };
