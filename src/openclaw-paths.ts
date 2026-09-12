import { homedir } from "node:os";
import { join } from "node:path";

export function resolveOpenClawStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return stateDir;
  const openclawHome = process.env.OPENCLAW_HOME?.trim();
  if (openclawHome) return openclawHome;
  return join(homedir(), ".openclaw");
}

export function resolveOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit || join(resolveOpenClawStateDir(), "openclaw.json");
}
