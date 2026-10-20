import type { LlmClient } from "./llm-client.js";
import {
  computeReflectionRetryDelayMs,
  isReflectionNonRetryError,
  isTransientReflectionUpstreamError,
} from "./reflection-retry.js";

export type TransientRetryOutcome<T> = {
  value: T | null;
  /** The model never answered (upstream failure), so the run is deferrable rather than judged. */
  unavailable: boolean;
  error?: string;
};

export type TransientRetryLlm = Pick<LlmClient, "completeJson"> & Partial<Pick<LlmClient, "getLastError">>;

// Every client records an upstream failure with this phrase; parse failures
// and empty answers use other wording, so the last error tells silence apart
// from an unusable answer even though both surface as null.
const UPSTREAM_REQUEST_FAILURE_RE = /request failed for model/i;

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isUpstreamRequestFailure(lastError: string | null | undefined): boolean {
  return typeof lastError === "string" && UPSTREAM_REQUEST_FAILURE_RE.test(lastError);
}

function clipSingleLine(text: string, maxLen = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

export async function completeJsonWithTransientRetry<T>(params: {
  llm: TransientRetryLlm;
  prompt: string;
  label: string;
  systemPrompt?: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<TransientRetryOutcome<T>> {
  const log = params.log ?? (() => {});
  const attempt = () => params.llm.completeJson<T>(params.prompt, params.label, params.systemPrompt);

  const first = await attempt();
  if (first !== null) return { value: first, unavailable: false };

  const firstError = params.llm.getLastError?.() ?? "";
  if (!isUpstreamRequestFailure(firstError)) {
    return { value: null, unavailable: false, error: firstError || undefined };
  }
  if (isReflectionNonRetryError(firstError) || !isTransientReflectionUpstreamError(firstError)) {
    log(
      `memory-lancedb-pro: smart-extractor: [${params.label}] upstream request failed with a non-retryable class; the run is deferred, not judged. error=${clipSingleLine(firstError)}`,
    );
    return { value: null, unavailable: true, error: firstError };
  }

  const delayMs = computeReflectionRetryDelayMs(params.random);
  log(
    `memory-lancedb-pro: smart-extractor: [${params.label}] transient upstream failure; retrying once in ${delayMs}ms. error=${clipSingleLine(firstError)}`,
  );
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
  log(
    `memory-lancedb-pro: smart-extractor: [${params.label}] retry exhausted; the run is deferred, not judged. error=${clipSingleLine(secondError)}`,
  );
  return { value: null, unavailable: true, error: secondError };
}
