import { homedir } from "node:os";
import { join } from "node:path";
export function resolveOpenClawStateDir() {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
    if (stateDir)
        return stateDir;
    const openclawHome = process.env.OPENCLAW_HOME?.trim();
    if (openclawHome)
        return openclawHome;
    return join(homedir(), ".openclaw");
}
export function resolveOpenClawConfigPath() {
    const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
    return explicit || join(resolveOpenClawStateDir(), "openclaw.json");
}
