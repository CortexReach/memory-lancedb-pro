import { dirname, join } from "node:path";
function asNonEmptyString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}
export function stripResetSuffix(fileName) {
    const resetIndex = fileName.indexOf(".reset.");
    return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}
function deriveOpenClawHomeFromWorkspacePath(workspacePath) {
    const normalized = workspacePath.trim().replace(/[\\/]+$/, "");
    if (!normalized)
        return undefined;
    const matched = normalized.match(/^(.*?)[\\/]workspace(?:[\\/].*)?$/);
    if (!matched || !matched[1])
        return undefined;
    const home = matched[1].trim();
    return home.length ? home : undefined;
}
function deriveOpenClawHomeFromSessionFilePath(sessionFilePath) {
    const normalized = sessionFilePath.trim();
    if (!normalized)
        return undefined;
    const matched = normalized.match(/^(.*?)[\\/]agents[\\/][^\\/]+[\\/]sessions(?:[\\/][^\\/]+)?$/);
    if (!matched || !matched[1])
        return undefined;
    const home = matched[1].trim();
    return home.length ? home : undefined;
}
function listConfiguredAgentIds(cfg) {
    try {
        const root = cfg;
        const agents = root.agents;
        const list = agents?.list;
        if (!Array.isArray(list))
            return [];
        const ids = [];
        for (const item of list) {
            if (!item || typeof item !== "object")
                continue;
            const id = asNonEmptyString(item.id);
            if (id)
                ids.push(id);
        }
        return ids;
    }
    catch {
        return [];
    }
}
export function resolveReflectionSessionSearchDirs(params) {
    const out = [];
    const seen = new Set();
    const addDir = (value) => {
        const dir = asNonEmptyString(value);
        if (!dir || seen.has(dir))
            return;
        seen.add(dir);
        out.push(dir);
    };
    const addHome = (homes, value) => {
        const home = asNonEmptyString(value);
        if (!home || homes.includes(home))
            return;
        homes.push(home);
    };
    const addAgentId = (agentIds, value) => {
        const agentId = asNonEmptyString(value);
        if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentIds.includes(agentId))
            return;
        agentIds.push(agentId);
    };
    const previousSessionEntry = (params.context.previousSessionEntry || {});
    const sessionEntry = (params.context.sessionEntry || {});
    const sessionEntries = [previousSessionEntry, sessionEntry];
    if (params.currentSessionFile)
        addDir(dirname(params.currentSessionFile));
    for (const entry of sessionEntries) {
        const file = asNonEmptyString(entry.sessionFile);
        if (file)
            addDir(dirname(file));
        addDir(asNonEmptyString(entry.sessionsDir));
        addDir(asNonEmptyString(entry.sessionDir));
    }
    addDir(join(params.workspaceDir, "sessions"));
    const openclawHomes = [];
    addHome(openclawHomes, asNonEmptyString(process.env.OPENCLAW_HOME));
    addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(params.workspaceDir));
    if (params.currentSessionFile) {
        addHome(openclawHomes, deriveOpenClawHomeFromSessionFilePath(params.currentSessionFile));
    }
    for (const entry of sessionEntries) {
        const entryFile = asNonEmptyString(entry.sessionFile);
        if (entryFile)
            addHome(openclawHomes, deriveOpenClawHomeFromSessionFilePath(entryFile));
    }
    try {
        const root = params.cfg;
        const agents = root.agents;
        const defaults = agents?.defaults;
        const defaultWorkspace = asNonEmptyString(defaults?.workspace);
        if (defaultWorkspace)
            addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(defaultWorkspace));
        const list = agents?.list;
        if (Array.isArray(list)) {
            for (const item of list) {
                if (!item || typeof item !== "object")
                    continue;
                const workspace = asNonEmptyString(item.workspace);
                if (workspace)
                    addHome(openclawHomes, deriveOpenClawHomeFromWorkspacePath(workspace));
            }
        }
    }
    catch {
        // ignore
    }
    const agentIds = [];
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
