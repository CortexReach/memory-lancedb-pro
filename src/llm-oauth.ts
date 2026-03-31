import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { platform } from "node:os";
import { spawn } from "node:child_process";

export interface OAuthLoginOptions {
  authPath: string;
  timeoutMs?: number;
  noBrowser?: boolean;
  model?: string;
  providerId?: string;
  onOpenUrl?: (url: string) => void | Promise<void>;
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
}
const EXPIRY_SKEW_MS = 60_000;

export type OAuthProviderId = "openai-codex";

interface OAuthProviderDefinition {
  id: OAuthProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  accountIdClaim: string;
  backendBaseUrl: string;
  defaultModel: string;
  modelPattern: RegExp;
  extraAuthorizeParams?: Record<string, string>;
}

const DEFAULT_OAUTH_PROVIDER_ID: OAuthProviderId = "openai-codex";
const OAUTH_PROVIDER_ALIASES: Record<string, OAuthProviderId> = {
  openai: "openai-codex",
  codex: "openai-codex",
  "openai-codex": "openai-codex",
};
const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderDefinition> = {
  "openai-codex": {
    id: "openai-codex",
    label: "OpenAI Codex",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    accountIdClaim: "https://api.openai.com/auth",
    backendBaseUrl: "https://chatgpt.com/backend-api",
    defaultModel: "gpt-5.4",
    modelPattern: /^(gpt-|o[1345]\b|o\d-mini\b|gpt-5|gpt-4|gpt-4o|gpt-5-codex|gpt-5\.1-codex)/i,
    extraAuthorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
  },
};

export interface OAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId: string;
  providerId: OAuthProviderId;
  authPath: string;
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function parseNumericTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
    }
  }

  return undefined;
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

function createPkceVerifier(): string {
  return toBase64Url(randomBytes(32));
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function listOAuthProviders(): Array<Pick<OAuthProviderDefinition, "id" | "label" | "defaultModel">> {
  return Object.values(OAUTH_PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    defaultModel: provider.defaultModel,
  }));
}

export function normalizeOAuthProviderId(providerId?: string): OAuthProviderId {
  const raw = providerId?.trim().toLowerCase();
  if (!raw) return DEFAULT_OAUTH_PROVIDER_ID;
  const resolved = OAUTH_PROVIDER_ALIASES[raw];
  if (resolved) return resolved;
  const available = listOAuthProviders().map((provider) => provider.id).join(", ");
  throw new Error(`Unsupported OAuth provider "${providerId}". Available providers: ${available}`);
}

export function getOAuthProvider(providerId?: string): OAuthProviderDefinition {
  return OAUTH_PROVIDERS[normalizeOAuthProviderId(providerId)];
}

export function getOAuthProviderLabel(providerId?: string): string {
  return getOAuthProvider(providerId).label;
}

export function getDefaultOauthModelForProvider(providerId?: string): string {
  return getOAuthProvider(providerId).defaultModel;
}

export function isOauthModelSupported(providerId: string | undefined, value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  const provider = getOAuthProvider(providerId);
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex !== -1) {
    const modelProvider = trimmed.slice(0, slashIndex).trim().toLowerCase();
    if (provider.id === "openai-codex" && modelProvider !== "openai" && modelProvider !== "openai-codex") {
      return false;
    }
  }

  return provider.modelPattern.test(normalizeOauthModel(trimmed));
}

function resolveOauthClientId(providerId?: string): string {
  return process.env.MEMORY_PRO_OAUTH_CLIENT_ID?.trim() || getOAuthProvider(providerId).clientId;
}

function resolveOauthAuthorizeUrl(providerId?: string): string {
  return process.env.MEMORY_PRO_OAUTH_AUTHORIZE_URL?.trim() || getOAuthProvider(providerId).authorizeUrl;
}

function resolveOauthTokenUrl(providerId?: string): string {
  return process.env.MEMORY_PRO_OAUTH_TOKEN_URL?.trim() || getOAuthProvider(providerId).tokenUrl;
}

function resolveOauthRedirectUri(providerId?: string): string {
  return process.env.MEMORY_PRO_OAUTH_REDIRECT_URI?.trim() || getOAuthProvider(providerId).redirectUri;
}

function buildAuthorizationUrl(state: string, verifier: string, providerId?: string): string {
  const provider = getOAuthProvider(providerId);
  const url = new URL(resolveOauthAuthorizeUrl(provider.id));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", resolveOauthClientId(provider.id));
  url.searchParams.set("redirect_uri", resolveOauthRedirectUri(provider.id));
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("code_challenge", createPkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(provider.extraAuthorizeParams || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildSuccessHtml(): string {
  return [
    "<!doctype html>",
    "<html><body>",
    "<h1>memory-pro OAuth complete</h1>",
    "<p>You can close this window and return to your terminal.</p>",
    "</body></html>",
  ].join("");
}

function buildErrorHtml(message: string): string {
  return [
    "<!doctype html>",
    "<html><body>",
    "<h1>memory-pro OAuth failed</h1>",
    `<p>${message}</p>`,
    "</body></html>",
  ].join("");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getJwtExpiry(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  return parseNumericTimestamp(payload?.exp);
}

function getJwtAccountId(token: string, providerId?: string): string | undefined {
  const provider = getOAuthProvider(providerId);
  const payload = decodeJwtPayload(token);
  const claims = payload?.[provider.accountIdClaim];
  if (!claims || typeof claims !== "object") return undefined;

  const accountId = (claims as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

function pickString(container: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = container[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickTimestamp(container: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseNumericTimestamp(container[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function extractSessionFromObject(source: Record<string, unknown>, authPath: string): OAuthSession | null {
  const scopes: Record<string, unknown>[] = [
    source,
    typeof source.tokens === "object" && source.tokens ? source.tokens as Record<string, unknown> : {},
    typeof source.oauth === "object" && source.oauth ? source.oauth as Record<string, unknown> : {},
    typeof source.openai === "object" && source.openai ? source.openai as Record<string, unknown> : {},
    typeof source.chatgpt === "object" && source.chatgpt ? source.chatgpt as Record<string, unknown> : {},
    typeof source.auth === "object" && source.auth ? source.auth as Record<string, unknown> : {},
    typeof source.credentials === "object" && source.credentials ? source.credentials as Record<string, unknown> : {},
  ];

  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let expiresAt: number | undefined;
  let accountId: string | undefined;
  const providerRaw = pickString(source, ["provider", "oauth_provider", "oauthProvider"]);
  let providerId: OAuthProviderId;
  try {
    providerId = normalizeOAuthProviderId(providerRaw);
  } catch {
    return null;
  }

  for (const scope of scopes) {
    accessToken ||= pickString(scope, ["access_token", "accessToken", "access", "token"]);
    refreshToken ||= pickString(scope, ["refresh_token", "refreshToken", "refresh"]);
    expiresAt ||= pickTimestamp(scope, ["expires_at", "expiresAt", "expires", "expires_on"]);
    accountId ||= pickString(scope, ["account_id", "accountId", "chatgpt_account_id", "chatgptAccountId"]);
  }

  const apiKey = pickString(source, ["OPENAI_API_KEY", "api_key", "apiKey"]);
  if (!accessToken && apiKey) {
    return null;
  }

  if (!accessToken) return null;

  accountId ||= getJwtAccountId(accessToken, providerId);
  if (!accountId) return null;

  expiresAt ||= getJwtExpiry(accessToken);

  return {
    accessToken,
    refreshToken,
    expiresAt,
    accountId,
    providerId,
    authPath,
  };
}

export async function loadOAuthSession(authPath: string): Promise<OAuthSession> {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LLM OAuth requires a project OAuth file. Expected ${authPath}. Read failed: ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid project OAuth JSON at ${authPath}: ${reason}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid project OAuth file at ${authPath}: expected a JSON object`);
  }

  const session = extractSessionFromObject(parsed as Record<string, unknown>, authPath);
  if (!session) {
    throw new Error(
      `Project OAuth file at ${authPath} does not contain an OAuth access token and ChatGPT account id.`,
    );
  }

  return session;
}

export function needsRefresh(session: OAuthSession): boolean {
  return !!session.refreshToken && !!session.expiresAt && session.expiresAt - EXPIRY_SKEW_MS <= Date.now();
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

export async function refreshOAuthSession(session: OAuthSession, timeoutMs?: number): Promise<OAuthSession> {
  if (!session.refreshToken) {
    throw new Error(
      `OAuth session from ${session.authPath} is expired and has no refresh token. Re-run \`codex login\`.`,
    );
  }

  const { signal, dispose } = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(resolveOauthTokenUrl(session.providerId), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: resolveOauthClientId(session.providerId),
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OAuth refresh failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    const payload = await response.json() as TokenRefreshResponse;
    if (!payload.access_token) {
      throw new Error("OAuth refresh returned no access token");
    }

    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token || session.refreshToken;
    const expiresAt =
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : getJwtExpiry(accessToken);
    const accountId = getJwtAccountId(accessToken, session.providerId) || session.accountId;

    if (!accountId) {
      throw new Error("OAuth refresh returned a token without a ChatGPT account id");
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
      accountId,
      providerId: session.providerId,
      authPath: session.authPath,
    };
  } finally {
    dispose();
  }
}

async function exchangeAuthorizationCode(code: string, verifier: string, providerId?: string): Promise<OAuthSession> {
  const resolvedProviderId = normalizeOAuthProviderId(providerId);
  const response = await fetch(resolveOauthTokenUrl(resolvedProviderId), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: resolveOauthClientId(resolvedProviderId),
      code,
      code_verifier: verifier,
      redirect_uri: resolveOauthRedirectUri(resolvedProviderId),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const payload = await response.json() as TokenRefreshResponse;
  if (!payload.access_token) {
    throw new Error("OAuth token exchange returned no access token");
  }

  const accountId = getJwtAccountId(payload.access_token, resolvedProviderId);
  if (!accountId) {
    throw new Error("OAuth token exchange returned a token without a ChatGPT account id");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt:
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : getJwtExpiry(payload.access_token),
    accountId,
    providerId: resolvedProviderId,
    authPath: "",
  };
}

export async function saveOAuthSession(authPath: string, session: OAuthSession): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  const payload = {
    provider: session.providerId,
    type: "oauth",
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_at: session.expiresAt,
    account_id: session.accountId,
    updated_at: new Date().toISOString(),
  };
  await writeFile(authPath, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function tryOpenBrowser(url: string): void {
  const targetPlatform = platform();
  if (targetPlatform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  if (targetPlatform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForAuthorizationCode(state: string, timeoutMs: number, providerId?: string): Promise<string> {
  const redirectUri = new URL(resolveOauthRedirectUri(providerId));
  const listenPort = Number(redirectUri.port || 80);
  const callbackPath = redirectUri.pathname || "/";
  const listenHost = resolveOAuthCallbackListenHost(redirectUri);

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out waiting for OAuth callback on ${redirectUri.origin}${callbackPath}`));
    }, timeoutMs);

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildErrorHtml("Missing callback URL."));
        return;
      }

      const url = new URL(req.url, redirectUri.origin);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildErrorHtml("Unknown callback path."));
        return;
      }

      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        clearTimeout(timer);
        server.close();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildErrorHtml(`Authorization failed: ${error}`));
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        clearTimeout(timer);
        server.close();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildErrorHtml("Invalid authorization callback."));
        reject(new Error("OAuth callback did not include a valid code/state pair"));
        return;
      }

      clearTimeout(timer);
      server.close();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildSuccessHtml());
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(listenPort, listenHost);
  });
}

export function resolveOAuthCallbackListenHost(redirectUri: URL | string): string {
  const parsed = typeof redirectUri === "string" ? new URL(redirectUri) : redirectUri;
  const hostname = parsed.hostname.trim();
  if (!hostname) return "127.0.0.1";
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export async function performOAuthLogin(options: OAuthLoginOptions): Promise<{ session: OAuthSession; authorizeUrl: string }> {
  const provider = getOAuthProvider(options.providerId);
  const verifier = createPkceVerifier();
  const state = createState();
  const authorizeUrl = buildAuthorizationUrl(state, verifier, provider.id);

  await options.onAuthorizeUrl?.(authorizeUrl);
  if (!options.noBrowser) {
    if (options.onOpenUrl) {
      await options.onOpenUrl(authorizeUrl);
    } else {
      try {
        tryOpenBrowser(authorizeUrl);
      } catch {
        // Browser opening is best-effort; caller still receives the URL.
      }
    }
  }

  const code = await waitForAuthorizationCode(state, options.timeoutMs ?? 120_000, provider.id);
  const session = await exchangeAuthorizationCode(code, verifier, provider.id);
  session.authPath = options.authPath;
  await saveOAuthSession(options.authPath, session);
  return { session, authorizeUrl };
}

export function normalizeOauthModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) return trimmed;

  const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const modelName = trimmed.slice(slashIndex + 1).trim();
  if (!modelName) return trimmed;

  if (provider === "openai" || provider === "openai-codex") {
    return modelName;
  }

  return trimmed;
}

export function buildOauthEndpoint(baseURL?: string, providerId?: string): string {
  const root = (baseURL?.trim() || getOAuthProvider(providerId).backendBaseUrl).replace(/\/+$/, "");
  if (root.endsWith("/codex/responses")) return root;
  if (root.endsWith("/responses")) return root.replace(/\/responses$/, "/codex/responses");
  return `${root}/codex/responses`;
}

function extractOutputTextFromResponsePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const response = payload as Record<string, unknown>;
  const output = Array.isArray(response.output) ? response.output : null;
  if (!output) return null;

  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
      : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }

  return texts.length ? texts.join("\n") : null;
}

export function extractOutputTextFromSse(bodyText: string): string | null {
  const chunks = bodyText.split(/\r?\n\r?\n/);
  let deltas = "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) continue;

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    if (!payload || typeof payload !== "object") continue;

    const event = payload as Record<string, unknown>;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas += event.delta;
      continue;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      return event.text;
    }

    const nested = typeof event.response === "object" && event.response
      ? extractOutputTextFromResponsePayload(event.response)
      : null;
    if (nested) return nested;

    const direct = extractOutputTextFromResponsePayload(event);
    if (direct) return direct;
  }

  return deltas || null;
}
