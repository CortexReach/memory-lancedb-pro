import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type SecretExecFileResult = {
  stdout: string;
  stderr: string;
};

export type SecretExecFile = (
  file: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
) => Promise<SecretExecFileResult>;

export type SecretResolverOptions = {
  env?: NodeJS.ProcessEnv;
  execFileImpl?: SecretExecFile;
  timeoutMs?: number;
};

export type SecretResolverSyncOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type BitwardenSecretRef = {
  id: string;
  accessToken?: string;
  configFile?: string;
  profile?: string;
  serverUrl?: string;
};

function getEnv(options?: SecretResolverOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

export function resolveEnvVarsSync(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parseBitwardenSecretRef(value: string, env: NodeJS.ProcessEnv): BitwardenSecretRef | null {
  const trimmed = value.trim();
  if (!/^bws:\/\//i.test(trimmed)) return null;

  const parsed = new URL(trimmed);
  const rawId = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, "");
  const normalizedId = rawId.replace(/^secret\//i, "");
  if (!normalizedId) {
    throw new Error(`Invalid Bitwarden secret reference: ${value}`);
  }

  const accessTokenRaw = parsed.searchParams.get("accessToken");
  const configFileRaw = parsed.searchParams.get("configFile");
  const profileRaw = parsed.searchParams.get("profile");
  const serverUrlRaw = parsed.searchParams.get("serverUrl");

  return {
    id: normalizedId,
    accessToken: accessTokenRaw ? resolveEnvVarsSync(accessTokenRaw, env) : undefined,
    configFile: configFileRaw ? resolveEnvVarsSync(configFileRaw, env) : undefined,
    profile: profileRaw ? resolveEnvVarsSync(profileRaw, env) : undefined,
    serverUrl: serverUrlRaw ? resolveEnvVarsSync(serverUrlRaw, env) : undefined,
  };
}

async function resolveBitwardenSecret(
  ref: BitwardenSecretRef,
  options?: SecretResolverOptions,
): Promise<string> {
  const execImpl = options?.execFileImpl ?? execFile;
  const env = getEnv(options);
  const args = ["secret", "get", ref.id, "--output", "json"];
  if (ref.accessToken) args.push("--access-token", ref.accessToken);
  if (ref.configFile) args.push("--config-file", ref.configFile);
  if (ref.profile) args.push("--profile", ref.profile);
  if (ref.serverUrl) args.push("--server-url", ref.serverUrl);

  let stdout = "";
  let stderr = "";
  try {
    const result = await execImpl("bws", args, {
      env,
      timeout: options?.timeoutMs ?? 10_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to resolve Bitwarden secret ${ref.id} via bws secret get: ${msg}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Bitwarden secret ${ref.id} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}; stderr=${stderr.trim() || "(none)"}`,
    );
  }

  const value =
    typeof parsed.value === "string"
      ? parsed.value
      : typeof parsed.note === "string"
        ? parsed.note
        : null;
  if (!value || !value.trim()) {
    throw new Error(`Bitwarden secret ${ref.id} has no value`);
  }
  return value;
}

function resolveBitwardenSecretSync(
  ref: BitwardenSecretRef,
  options?: SecretResolverSyncOptions,
): string {
  const env = options?.env ?? process.env;
  const args = ["secret", "get", ref.id, "--output", "json"];
  if (ref.accessToken) args.push("--access-token", ref.accessToken);
  if (ref.configFile) args.push("--config-file", ref.configFile);
  if (ref.profile) args.push("--profile", ref.profile);
  if (ref.serverUrl) args.push("--server-url", ref.serverUrl);

  let stdout = "";
  try {
    stdout = execFileSync("bws", args, {
      env,
      timeout: options?.timeoutMs ?? 10_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve Bitwarden secret ${ref.id} via bws secret get: ${msg}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Bitwarden secret ${ref.id} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const value =
    typeof parsed.value === "string"
      ? parsed.value
      : typeof parsed.note === "string"
        ? parsed.note
        : null;
  if (!value || !value.trim()) {
    throw new Error(`Bitwarden secret ${ref.id} has no value`);
  }
  return value;
}

export async function resolveSecretValue(
  value: string,
  options?: SecretResolverOptions,
): Promise<string> {
  const env = getEnv(options);
  const envResolved = resolveEnvVarsSync(value, env);
  const bitwardenRef = parseBitwardenSecretRef(envResolved, env);
  if (!bitwardenRef) {
    return envResolved;
  }
  return resolveBitwardenSecret(bitwardenRef, options);
}

export function resolveSecretValueSync(
  value: string,
  options?: SecretResolverSyncOptions,
): string {
  const env = options?.env ?? process.env;
  const envResolved = resolveEnvVarsSync(value, env);
  const bitwardenRef = parseBitwardenSecretRef(envResolved, env);
  if (!bitwardenRef) {
    return envResolved;
  }
  return resolveBitwardenSecretSync(bitwardenRef, options);
}

export async function resolveSecretValues(
  value: string | string[],
  options?: SecretResolverOptions,
): Promise<string[]> {
  const values = Array.isArray(value) ? value : [value];
  return Promise.all(values.map((entry) => resolveSecretValue(entry, options)));
}

export function resolveSecretValuesSync(
  value: string | string[],
  options?: SecretResolverSyncOptions,
): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => resolveSecretValueSync(entry, options));
}
