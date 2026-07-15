/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */
import OpenAI from "openai";
import { buildOauthEndpoint, extractOutputTextFromSse, loadOAuthSession, needsRefresh, normalizeOauthModel, refreshOAuthSession, saveOAuthSession, } from "./llm-oauth.js";
/**
 * Strips a core-style provider prefix (e.g. "openrouter/anthropic/claude-...")
 * down to the bare "<vendor>/<model>" form a direct OpenRouter-compatible API
 * needs. Any other prefix, or a string with no "/", passes through unchanged.
 * Shared by the host->direct transport fallback (see createLlmClient) and by
 * admission-control.ts's per-lane model resolution, so both paths agree on
 * exactly one definition of "what a direct client can accept."
 */
export function normalizeDirectModelRef(modelRef) {
    const trimmed = modelRef.trim();
    const idx = trimmed.indexOf("/");
    if (idx <= 0)
        return trimmed;
    const provider = trimmed.slice(0, idx).trim().toLowerCase();
    if (provider !== "openrouter")
        return trimmed;
    const rest = trimmed.slice(idx + 1).trim();
    return rest || trimmed;
}
/**
 * Default reasoning effort sent on the host transport when llm.thinkLevel
 * (or its deprecated llm.reasoningEffort alias) is not configured. "medium"
 * is a universally-supported effort level across
 * the model families OpenClaw's core reasoning-effort normalization knows
 * about, and it never disables reasoning outright the way an omitted field
 * has been observed to (core's own "adaptive" shorthand maps to this same
 * value). Chosen over leaving the field unset, which is what caused the
 * incident this constant documents.
 */
const DEFAULT_HOST_REASONING_EFFORT = "medium";
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
/**
 * Bounds a host-transport call with an application-level timer. The runtime
 * LLM surface has no AbortSignal parameter, so this cannot cancel the
 * underlying request -- it only stops waiting on it, mirroring the direct
 * transport's timeoutMs contract from the caller's point of view.
 */
function raceWithTimeout(promise, timeoutMs) {
    const effectiveTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${effectiveTimeoutMs}ms`)), effectiveTimeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
function createHostClient(config, runtimeLlmComplete, log, warnLog) {
    let lastError = null;
    return {
        async completeJson(prompt, label = "generic", systemPrompt) {
            lastError = null;
            try {
                const result = await raceWithTimeout(runtimeLlmComplete({
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt ??
                                "You are a memory extraction assistant. Always respond with valid JSON only.",
                        },
                        { role: "user", content: prompt },
                    ],
                    model: config.model,
                    temperature: 0.1,
                    purpose: `memory-lancedb-pro:${label}`,
                    reasoning: config.thinkLevel?.trim() || DEFAULT_HOST_REASONING_EFFORT,
                }), config.timeoutMs);
                const raw = result?.text;
                if (!raw || typeof raw !== "string") {
                    lastError =
                        `memory-lancedb-pro: llm-client [${label}] empty host-transport response content from model ${config.model}`;
                    log(lastError);
                    return null;
                }
                const jsonStr = extractJsonFromResponse(raw);
                if (!jsonStr) {
                    lastError =
                        `memory-lancedb-pro: llm-client [${label}] no JSON object found in host-transport response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
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
                            log(`memory-lancedb-pro: llm-client [${label}] recovered malformed host-transport JSON via heuristic repair (jsonChars=${jsonStr.length})`);
                            return repaired;
                        }
                        catch (repairErr) {
                            lastError =
                                `memory-lancedb-pro: llm-client [${label}] host-transport JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
                            log(lastError);
                            return null;
                        }
                    }
                    lastError =
                        `memory-lancedb-pro: llm-client [${label}] host-transport JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
                    log(lastError);
                    return null;
                }
            }
            catch (err) {
                lastError =
                    `memory-lancedb-pro: llm-client [${label}] host-transport request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
                (warnLog ?? log)(lastError);
                return null;
            }
        },
        getLastError() {
            return lastError;
        },
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
        async completeJson(prompt, label = "generic") {
            lastError = null;
            try {
                const request = {
                    model: config.model,
                    messages: [
                        {
                            role: "system",
                            content: "You are a memory extraction assistant. Always respond with valid JSON only.",
                        },
                        { role: "user", content: prompt },
                    ],
                    temperature: 0.1,
                    ...(config.thinkLevel?.trim()
                        ? { reasoning: { effort: config.thinkLevel.trim() } }
                        : {}),
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
        async completeJson(prompt, label = "generic") {
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
                            instructions: "You are a memory extraction assistant. Always respond with valid JSON only.",
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
/** OpenRouter's direct API base URL, used as the host->direct fallback's default when llm.baseURL is not configured. */
const OPENROUTER_DIRECT_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Resolves the baseURL for a host->direct fallback client: an explicitly
 * configured llm.baseURL passes through unchanged, otherwise the fallback
 * defaults to OpenRouter rather than inheriting whatever baseURL happened
 * to be on the config (which, for a host-transport setup, should not be
 * the embedding lane's baseURL -- see the credential-hygiene fix at the
 * createLlmClient callsite).
 */
export function resolveDirectFallbackBaseURL(configuredBaseURL) {
    return configuredBaseURL?.trim() || OPENROUTER_DIRECT_BASE_URL;
}
// Module-level (not per-client) so the "runtime surface unavailable"
// warning is emitted once per process even though createLlmClient is
// called once per lane (extraction, admission, CLI) and each call would
// otherwise re-detect and re-warn about the same missing host surface.
let hostTransportFallbackWarned = false;
/** Test-only: resets the process-level fallback-warn dedupe flag. */
export function resetHostTransportFallbackWarnForTests() {
    hostTransportFallbackWarned = false;
}
// Module-level, same rationale as hostTransportFallbackWarned above: these
// two warnings are about the *raw config*, not the resolved client, so they
// must dedupe across all lanes (extraction, admission, CLI) that each build
// their own LlmClientConfig from the same underlying llm.thinkLevel /
// llm.reasoningEffort settings.
let thinkLevelBothKeysWarned = false;
let thinkLevelDeprecatedAliasWarned = false;
/** Test-only: resets the process-level thinkLevel/reasoningEffort alias-warn dedupe flags. */
export function resetThinkLevelDeprecationWarnForTests() {
    thinkLevelBothKeysWarned = false;
    thinkLevelDeprecatedAliasWarned = false;
}
/**
 * Resolves the canonical llm.thinkLevel value, honoring the deprecated
 * llm.reasoningEffort alias: llm.thinkLevel wins when both are configured
 * (a single once-per-process warning, not a hard failure -- config may
 * straddle both keys during a migration), and llm.reasoningEffort-only
 * usage keeps working unchanged, with its own once-per-process deprecation
 * warning naming the new key. Blank/whitespace-only values are treated as
 * unset for both keys, matching reasoningEffort's pre-existing semantics.
 */
export function resolveThinkLevel(config, warnLog) {
    const thinkLevel = config.thinkLevel?.trim();
    const reasoningEffort = config.reasoningEffort?.trim();
    if (thinkLevel) {
        if (reasoningEffort && !thinkLevelBothKeysWarned) {
            thinkLevelBothKeysWarned = true;
            warnLog("memory-lancedb-pro: both llm.thinkLevel and the deprecated llm.reasoningEffort are configured; llm.thinkLevel wins. Remove llm.reasoningEffort.");
        }
        return thinkLevel;
    }
    if (reasoningEffort) {
        if (!thinkLevelDeprecatedAliasWarned) {
            thinkLevelDeprecatedAliasWarned = true;
            warnLog("memory-lancedb-pro: llm.reasoningEffort is deprecated, use llm.thinkLevel instead. llm.reasoningEffort will keep working as an alias.");
        }
        return reasoningEffort;
    }
    return undefined;
}
export function createLlmClient(config) {
    const log = config.log ?? (() => { });
    const warnLog = config.warnLog;
    config = { ...config, thinkLevel: resolveThinkLevel(config, warnLog ?? log) };
    if (config.transport === "host") {
        if (typeof config.runtimeLlmComplete === "function") {
            return createHostClient(config, config.runtimeLlmComplete, log, warnLog);
        }
        if (!hostTransportFallbackWarned) {
            hostTransportFallbackWarned = true;
            (warnLog ?? log)("memory-lancedb-pro: llm-client transport \"host\" is configured but the OpenClaw runtime.llm.complete surface is unavailable on this host; falling back to the direct transport");
        }
        if (!config.apiKey) {
            throw new Error("memory-lancedb-pro: llm-client transport \"host\" fell back to the direct transport, but no llm.apiKey is configured. " +
                "The direct fallback does not inherit embedding.apiKey when transport is \"host\" -- set llm.apiKey explicitly.");
        }
        // The configured model may be a core-style catalog reference (e.g.
        // "openrouter/anthropic/claude-...") that only the host-managed runtime
        // resolves; the direct transport needs the bare provider-stripped id.
        // Only this fallback path normalizes -- an explicitly configured direct
        // transport keeps sending whatever model string it was given, unchanged.
        config = {
            ...config,
            model: normalizeDirectModelRef(config.model),
            baseURL: resolveDirectFallbackBaseURL(config.baseURL),
        };
    }
    if (config.auth === "oauth") {
        return createOauthClient(config, log, warnLog);
    }
    return createApiKeyClient(config, log, warnLog);
}
export { extractJsonFromResponse, repairCommonJson, shouldDisableReasoningForJson, stripReasoningTrace };
