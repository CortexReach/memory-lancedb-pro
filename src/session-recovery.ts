import { dirname, join } from "node:path";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

function deriveOpenClawHomeFromWorkspacePath(workspacePath: string): string | undefined {
  const normalized = workspacePath.trim().replace(/[\\/]+$/, "");
  if (!normalized) return undefined;
  const matched = normalized.match(/^(.*?)[\\/]workspace(?:[\\/].*)?$/);
  if (!matched || !matched[1]) return undefined;
  const home = matched[1].trim();
  return home.length ? home : undefined;
}

function deriveOpenClawHomeFromSessionFilePath(sessionFilePath: string): string | undefined {
  const normalized = sessionFilePath.trim();
  if (!normalized) return undefined;
  const matched = normalized.match(/^(.*?)[\\/]agents[\\/][^\\/]+[\\/]sessions(?:[\\/][^\\/]+)?$/);
  if (!matched || !matched[1]) return undefined;
  const home = matched[1].trim();
  return home.length ? home : undefined;
}

/**
 * Agent definitions come as `agents.list` (an array of `{id, workspace}`) on
 * older hosts and as `agents.entries` (an object keyed by agent id) on newer
 * ones; both shapes are read so neither generation loses its sessions dirs.
 */
function listConfiguredAgents(cfg: unknown): Array<{ id?: string; workspace?: string }> {
  try {
    const root = cfg as Record<string, unknown>;
    const agents = root.agents as Record<string, unknown> | undefined;
    const out: Array<{ id?: string; workspace?: string }> = [];
    const list = agents?.list as unknown;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        out.push({ id: asNonEmptyString(record.id), workspace: asNonEmptyString(record.workspace) });
      }
    }
    const entries = agents?.entries as unknown;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      for (const [key, item] of Object.entries(entries as Record<string, unknown>)) {
        const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        out.push({ id: asNonEmptyString(record.id) ?? asNonEmptyString(key), workspace: asNonEmptyString(record.workspace) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: unknown): string[] {
  const ids: string[] = [];
  for (const agent of listConfiguredAgents(cfg)) {
    if (agent.id && !ids.includes(agent.id)) ids.push(agent.id);
  }
  return ids;
}

export function resolveReflectionSessionSearchDirs(params: {
  context: Record<string, unknown>;
  cfg: unknown;
  workspaceDir: string;
  currentSessionFile?: string;
  sourceAgentId?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addDir = (value: string | undefined) => {
    const dir = asNonEmptyString(value);
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };
  const addHome = (homes: string[], value: string | undefined) => {
    const home = asNonEmptyString(value);
    if (!home || homes.includes(home)) return;
    homes.push(home);
  };
  const addAgentId = (agentIds: string[], value: string | undefined) => {
    const agentId = asNonEmptyString(value);
    if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentIds.includes(agentId)) return;
    agentIds.push(agentId);
  };

  const previousSessionEntry = (params.context.previousSessionEntry || {}) as Record<string, unknown>;
  const sessionEntry = (params.context.sessionEntry || {}) as Record<string, unknown>;
  const sessionEntries = [previousSessionEntry, sessionEntry];

  if (params.currentSessionFile) addDir(dirname(params.currentSessionFile));
  for (const entry of sessionEntries) {
    const file = asNonEmptyString(entry.sessionFile);
    if (file) addDir(dirname(file));
    addDir(asNonEmptyString(entry.sessionsDir));
    addDir(asNonEmptyString(entry.sessionDir));
  }
  addDir(join(params.workspaceDir, "sessions"));

  const openclawHomes: string[] = [];
  addHome(openclawHomes, asNonEmptyString(process.env.OPENCLAW_HOME));
  addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(params.workspaceDir));
  if (params.currentSessionFile) {
    addHome(openclawHomes, deriveOpenClawHomeFromSessionFilePath(params.currentSessionFile));
  }
  for (const entry of sessionEntries) {
    const entryFile = asNonEmptyString(entry.sessionFile);
    if (entryFile) addHome(openclawHomes, deriveOpenClawHomeFromSessionFilePath(entryFile));
  }
  try {
    const root = params.cfg as Record<string, unknown>;
    const agents = root.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const defaultWorkspace = asNonEmptyString(defaults?.workspace);
    if (defaultWorkspace) addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(defaultWorkspace));

    for (const agent of listConfiguredAgents(params.cfg)) {
      if (agent.workspace) addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(agent.workspace));
    }
  } catch {
    // ignore
  }

  const agentIds: string[] = [];
  addAgentId(agentIds, params.sourceAgentId);
  addAgentId(agentIds, asNonEmptyString(params.context.agentId));
  for (const entry of sessionEntries) {
    addAgentId(agentIds, asNonEmptyString(entry.agentId));
  }
  for (const configuredId of listConfiguredAgentIds(params.cfg)) {
    addAgentId(agentIds, configuredId);
  }
  addAgentId(agentIds, "main");

  for (const home of openclawHomes) {
    for (const agentId of agentIds) {
      addDir(join(home, "agents", agentId, "sessions"));
    }
  }

  return out;
}
