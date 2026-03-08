type RetryClassifierInput = {
  inReflectionScope: boolean;
  retryCount: number;
  usefulOutputChars: number;
  error: unknown;
};

type RetryClassifierResult = {
  retryable: boolean;
  reason:
  | "not_reflection_scope"
  | "retry_already_used"
  | "useful_output_present"
  | "non_retry_error"
  | "non_transient_error"
  | "transient_upstream_failure";
  normalizedError: string;
};

type RetryState = { count: number };

type RetryRunnerParams<T> = {
  scope: "reflection" | "distiller";
  runner: "embedded" | "cli";
  retryState: RetryState;
  execute: () => Promise<T>;
  onLog?: (level: "info" | "warn", message: string) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const REFLECTION_TRANSIENT_PATTERNS: RegExp[] = [
  /unexpected eof/i,
  /\beconnreset\b/i,
  /\beconnaborted\b/i,
  /\betimedout\b/i,
  /\bepipe\b/i,
  /connection reset/i,
  /socket hang up/i,
  /socket (?:closed|disconnected)/i,
  /connection (?:closed|aborted|dropped)/i,
  /early close/i,
  /stream (?:ended|closed) unexpectedly/i,
  /temporar(?:y|ily).*unavailable/i,
  /upstream.*unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /\b(?:http|status)\s*(?:502|503|504)\b/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bund_err_(?:socket|headers_timeout|body_timeout)\b/i,
  /network error/i,
  /fetch failed/i,
];

const REFLECTION_NON_RETRY_PATTERNS: RegExp[] = [
  /\b401\b/i,
  /\bunauthorized\b/i,
  /invalid api key/i,
  /invalid[_ -]?token/i,
  /\bauth(?:entication)?_?unavailable\b/i,
  /insufficient (?:credit|credits|balance)/i,
  /\bbilling\b/i,
  /\bquota exceeded\b/i,
  /payment required/i,
  /model .*not found/i,
  /no such model/i,
  /unknown model/i,
  /context length/i,
  /context window/i,
  /request too large/i,
  /payload too large/i,
  /too many tokens/i,
  /token limit/i,
  /prompt too long/i,
  /session expired/i,
  /invalid session/i,
  /refusal/i,
  /content policy/i,
  /safety policy/i,
  /content filter/i,
  /disallowed/i,
];

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = `${error.name}: ${error.message}`.trim();
    return msg || "Error";
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function clipSingleLine(text: string, maxLen = 260): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

export function isTransientReflectionUpstreamError(error: unknown): boolean {
  const msg = toErrorMessage(error);
  return REFLECTION_TRANSIENT_PATTERNS.some((pattern) => pattern.test(msg));
}

export function isReflectionNonRetryError(error: unknown): boolean {
  const msg = toErrorMessage(error);
  return REFLECTION_NON_RETRY_PATTERNS.some((pattern) => pattern.test(msg));
}

export function classifyReflectionRetry(input: RetryClassifierInput): RetryClassifierResult {
  const normalizedError = clipSingleLine(toErrorMessage(input.error), 260);

  if (!input.inReflectionScope) {
    return { retryable: false, reason: "not_reflection_scope", normalizedError };
  }
  if (input.retryCount > 0) {
    return { retryable: false, reason: "retry_already_used", normalizedError };
  }
  if (input.usefulOutputChars > 0) {
    return { retryable: false, reason: "useful_output_present", normalizedError };
  }
  if (isReflectionNonRetryError(input.error)) {
    return { retryable: false, reason: "non_retry_error", normalizedError };
  }
  if (isTransientReflectionUpstreamError(input.error)) {
    return { retryable: true, reason: "transient_upstream_failure", normalizedError };
  }
  return { retryable: false, reason: "non_transient_error", normalizedError };
}

export function computeReflectionRetryDelayMs(random: () => number = Math.random): number {
  const raw = random();
  const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return 1000 + Math.floor(clamped * 2000);
}

export async function runWithReflectionTransientRetryOnce<T>(
  params: RetryRunnerParams<T>
): Promise<T> {
  try {
    return await params.execute();
  } catch (error) {
    const decision = classifyReflectionRetry({
      inReflectionScope: params.scope === "reflection" || params.scope === "distiller",
      retryCount: params.retryState.count,
      usefulOutputChars: 0,
      error,
    });
    if (!decision.retryable) throw error;

    const delayMs = computeReflectionRetryDelayMs(params.random);
    params.retryState.count += 1;
    params.onLog?.(
      "warn",
      `memory-${params.scope}: transient upstream failure detected (${params.runner}); ` +
      `retrying once in ${delayMs}ms (${decision.reason}). error=${decision.normalizedError}`
    );
    await (params.sleep ?? DEFAULT_SLEEP)(delayMs);

    try {
      const result = await params.execute();
      params.onLog?.("info", `memory-${params.scope}: retry succeeded (${params.runner})`);
      return result;
    } catch (retryError) {
      params.onLog?.(
        "warn",
        `memory-${params.scope}: retry exhausted (${params.runner}). ` +
        `error=${clipSingleLine(toErrorMessage(retryError), 260)}`
      );
      throw retryError;
    }
  }
}
