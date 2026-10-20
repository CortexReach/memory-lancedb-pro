import { computeReflectionRetryDelayMs, isReflectionNonRetryError, isTransientReflectionUpstreamError, } from "./reflection-retry.js";
// Every client records an upstream failure with this phrase; parse failures
// and empty answers use other wording, so the last error tells silence apart
// from an unusable answer even though both surface as null.
const UPSTREAM_REQUEST_FAILURE_RE = /request failed for model/i;
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function isUpstreamRequestFailure(lastError) {
    return typeof lastError === "string" && UPSTREAM_REQUEST_FAILURE_RE.test(lastError);
}
function clipSingleLine(text, maxLen = 220) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLen)
        return oneLine;
    return `${oneLine.slice(0, maxLen - 3)}...`;
}
export async function completeJsonWithTransientRetry(params) {
    const log = params.log ?? (() => { });
    const attempt = () => params.llm.completeJson(params.prompt, params.label, params.systemPrompt);
    const first = await attempt();
    if (first !== null)
        return { value: first, unavailable: false };
    const firstError = params.llm.getLastError?.() ?? "";
    if (!isUpstreamRequestFailure(firstError)) {
        return { value: null, unavailable: false, error: firstError || undefined };
    }
    if (isReflectionNonRetryError(firstError) || !isTransientReflectionUpstreamError(firstError)) {
        log(`memory-lancedb-pro: smart-extractor: [${params.label}] upstream request failed with a non-retryable class; the run is deferred, not judged. error=${clipSingleLine(firstError)}`);
        return { value: null, unavailable: true, error: firstError };
    }
    const delayMs = computeReflectionRetryDelayMs(params.random);
    log(`memory-lancedb-pro: smart-extractor: [${params.label}] transient upstream failure; retrying once in ${delayMs}ms. error=${clipSingleLine(firstError)}`);
    await (params.sleep ?? DEFAULT_SLEEP)(delayMs);
    const second = await attempt();
    if (second !== null) {
        log(`memory-lancedb-pro: smart-extractor: [${params.label}] retry succeeded`);
        return { value: second, unavailable: false };
    }
    const secondError = params.llm.getLastError?.() ?? "";
    if (!isUpstreamRequestFailure(secondError)) {
        log(`memory-lancedb-pro: smart-extractor: [${params.label}] retry answered unusably; judging the answer as given`);
        return { value: null, unavailable: false, error: secondError || undefined };
    }
    log(`memory-lancedb-pro: smart-extractor: [${params.label}] retry exhausted; the run is deferred, not judged. error=${clipSingleLine(secondError)}`);
    return { value: null, unavailable: true, error: secondError };
}
