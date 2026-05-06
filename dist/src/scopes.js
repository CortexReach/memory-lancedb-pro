/**
 * Multi-Scope Access Control System
 * Manages memory isolation and access permissions
 */
// ============================================================================
// Default Configuration
// ============================================================================
export const DEFAULT_SCOPE_CONFIG = {
    default: "global",
    definitions: {
        global: {
            description: "Shared knowledge across all agents",
        },
    },
    agentAccess: {},
};
// ============================================================================
// Built-in Scope Patterns
// ============================================================================
const SCOPE_PATTERNS = {
    GLOBAL: "global",
    AGENT: (agentId) => `agent:${agentId}`,
    CUSTOM: (name) => `custom:${name}`,
    REFLECTION: (agentId) => `reflection:agent:${agentId}`,
    PROJECT: (projectId) => `project:${projectId}`,
    USER: (userId) => `user:${userId}`,
};
const SYSTEM_BYPASS_IDS = new Set(["system", "undefined"]);
const warnedLegacyFallbackBypassIds = new Set();
export function isSystemBypassId(agentId) {
    return typeof agentId === "string" && SYSTEM_BYPASS_IDS.has(agentId);
}
/** @internal Exported for testing only — resets the legacy warning throttle. */
export function _resetLegacyFallbackWarningState() {
    warnedLegacyFallbackBypassIds.clear();
}
/**
 * Extract agentId from an OpenClaw session key.
 * Supports both formats:
 *   - "agent:main:discord:channel:123" (with trailing segments)
 *   - "agent:main" (two-segment, no trailing colon)
 * Returns undefined for missing keys, non-agent keys, or reserved bypass IDs.
 * This is the single canonical implementation — do not duplicate inline.
 */
export function parseAgentIdFromSessionKey(sessionKey) {
    if (!sessionKey)
        return undefined;
    const sk = sessionKey.trim();
    // Match "agent:<id>" with or without trailing segments
    if (!sk.startsWith("agent:"))
        return undefined;
    const rest = sk.slice("agent:".length);
    const colonIdx = rest.indexOf(":");
    const candidate = (colonIdx === -1 ? rest : rest.slice(0, colonIdx)).trim();
    if (!candidate || isSystemBypassId(candidate)) {
        return undefined;
    }
    return candidate;
}
function withOwnReflectionScope(scopes, agentId) {
    const reflectionScope = SCOPE_PATTERNS.REFLECTION(agentId);
    return scopes.includes(reflectionScope) ? [...scopes] : [...scopes, reflectionScope];
}
function normalizeAgentAccessMap(agentAccess) {
    const normalized = {};
    if (!agentAccess)
        return normalized;
    for (const [rawAgentId, scopes] of Object.entries(agentAccess)) {
        const agentId = rawAgentId.trim();
        if (!agentId)
            continue;
        normalized[agentId] = Array.isArray(scopes) ? [...scopes] : [];
    }
    return normalized;
}
// ============================================================================
// Scope Manager Implementation
// ============================================================================
export class MemoryScopeManager {
    config;
    constructor(config = {}) {
        this.config = {
            default: config.default || DEFAULT_SCOPE_CONFIG.default,
            definitions: {
                ...DEFAULT_SCOPE_CONFIG.definitions,
                ...config.definitions,
            },
            agentAccess: {
                ...normalizeAgentAccessMap(DEFAULT_SCOPE_CONFIG.agentAccess),
                ...normalizeAgentAccessMap(config.agentAccess),
            },
        };
        // Ensure global scope always exists
        if (!this.config.definitions.global) {
            this.config.definitions.global = {
                description: "Shared knowledge across all agents",
            };
        }
        this.validateConfiguration();
    }
    validateConfiguration() {
        // Validate default scope exists in definitions
        if (!this.config.definitions[this.config.default]) {
            throw new Error(`Default scope '${this.config.default}' not found in definitions`);
        }
        // Validate agent access scopes exist in definitions + reject reserved bypass IDs
        for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
            // Trim before checking to prevent space-padded bypass IDs like " system "
            const trimmedAgentId = agentId.trim();
            if (isSystemBypassId(trimmedAgentId)) {
                throw new Error(`Reserved bypass agent ID '${trimmedAgentId}' cannot have explicit access configured. ` +
                    `This is rejected in both constructor and importConfig paths.`);
            }
            for (const scope of scopes) {
                if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
                    console.warn(`Agent '${agentId}' has access to undefined scope '${scope}'`);
                }
            }
        }
    }
    isBuiltInScope(scope) {
        return (scope === "global" ||
            scope.startsWith("agent:") ||
            scope.startsWith("custom:") ||
            scope.startsWith("project:") ||
            scope.startsWith("user:") ||
            scope.startsWith("reflection:"));
    }
    getAccessibleScopes(agentId) {
        if (isSystemBypassId(agentId) || !agentId) {
            // Keep enumeration semantics consistent for callers that inspect the list.
            // This enumerates registered scopes, not every valid built-in pattern.
            return this.getAllScopes();
        }
        // Explicit ACLs still inherit the agent's own reflection scope.
        const normalizedAgentId = agentId.trim();
        const explicitAccess = this.config.agentAccess[normalizedAgentId];
        if (explicitAccess) {
            return withOwnReflectionScope(explicitAccess, normalizedAgentId);
        }
        // Agent and reflection scopes are built-in and provisioned implicitly.
        return withOwnReflectionScope([
            "global",
            SCOPE_PATTERNS.AGENT(normalizedAgentId),
        ], normalizedAgentId);
    }
    /**
     * Store-layer scope filter semantics:
     *
     * | Return value        | Store behavior                          | When                                   |
     * |---------------------|-----------------------------------------|----------------------------------------|
     * | `undefined`         | No scope filtering (full bypass)        | Reserved bypass ids (system/undefined) |
     * | `[]`                | Deny all reads / match nothing          | Explicit empty filter                  |
     * | `["global", ...]`   | Restrict reads to listed scopes         | Normal agent with explicit access      |
     *
     * IMPORTANT: Returning `[]` is now an explicit deny-all signal.
     * Custom ScopeManager implementations should return `undefined` for bypass
     * and `[]` only when they intend reads to match nothing.
     */
    getScopeFilter(agentId) {
        if (!agentId || isSystemBypassId(agentId)) {
            // No agent specified or internal system tasks bypass store-level scope
            // filtering entirely.  This aligns with isAccessible(scope, undefined)
            // which also uses bypass semantics for missing agentId.
            return undefined;
        }
        return this.getAccessibleScopes(agentId);
    }
    getDefaultScope(agentId) {
        if (!agentId) {
            return this.config.default;
        }
        if (isSystemBypassId(agentId)) {
            throw new Error(`Reserved bypass agent ID '${agentId}' must provide an explicit write scope instead of using getDefaultScope().`);
        }
        // For agents, default to their private scope if they have access to it
        const agentScope = SCOPE_PATTERNS.AGENT(agentId);
        const accessibleScopes = this.getAccessibleScopes(agentId);
        if (accessibleScopes.includes(agentScope)) {
            return agentScope;
        }
        return this.config.default;
    }
    isAccessible(scope, agentId) {
        if (!agentId || isSystemBypassId(agentId)) {
            // No agent specified, or internal bypass identifier: allow any valid scope.
            return this.validateScope(scope);
        }
        const accessibleScopes = this.getAccessibleScopes(agentId);
        return accessibleScopes.includes(scope);
    }
    validateScope(scope) {
        if (!scope || typeof scope !== "string" || scope.trim().length === 0) {
            return false;
        }
        const trimmedScope = scope.trim();
        // Check if scope is defined or is a built-in pattern
        return (this.config.definitions[trimmedScope] !== undefined ||
            this.isBuiltInScope(trimmedScope));
    }
    getAllScopes() {
        return Object.keys(this.config.definitions);
    }
    getScopeDefinition(scope) {
        return this.config.definitions[scope];
    }
    // Management methods
    addScopeDefinition(scope, definition) {
        if (!this.validateScopeFormat(scope)) {
            throw new Error(`Invalid scope format: ${scope}`);
        }
        this.config.definitions[scope] = definition;
    }
    removeScopeDefinition(scope) {
        if (scope === "global") {
            throw new Error("Cannot remove global scope");
        }
        if (!this.config.definitions[scope]) {
            return false;
        }
        delete this.config.definitions[scope];
        // Clean up agent access references
        for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
            const filtered = scopes.filter(s => s !== scope);
            if (filtered.length !== scopes.length) {
                this.config.agentAccess[agentId] = filtered;
            }
        }
        return true;
    }
    setAgentAccess(agentId, scopes) {
        if (!agentId || typeof agentId !== "string") {
            throw new Error("Invalid agent ID");
        }
        const normalizedAgentId = agentId.trim();
        if (!normalizedAgentId) {
            throw new Error("Invalid agent ID");
        }
        if (isSystemBypassId(normalizedAgentId)) {
            throw new Error(`Reserved bypass agent ID cannot have explicit access configured: ${agentId}`);
        }
        // Note: an agent's own reflection scope is still auto-granted by getAccessibleScopes().
        // This setter can add access, but it does not revoke `reflection:agent:${normalizedAgentId}`.
        // Validate all scopes
        for (const scope of scopes) {
            if (!this.validateScope(scope)) {
                throw new Error(`Invalid scope: ${scope}`);
            }
        }
        this.config.agentAccess[normalizedAgentId] = [...scopes];
    }
    removeAgentAccess(agentId) {
        const normalizedAgentId = agentId.trim();
        if (!this.config.agentAccess[normalizedAgentId]) {
            return false;
        }
        delete this.config.agentAccess[normalizedAgentId];
        return true;
    }
    validateScopeFormat(scope) {
        if (!scope || typeof scope !== "string") {
            return false;
        }
        const trimmed = scope.trim();
        // Basic format validation
        if (trimmed.length === 0 || trimmed.length > 100) {
            return false;
        }
        // Allow alphanumeric, hyphens, underscores, colons, and dots
        const validFormat = /^[a-zA-Z0-9._:-]+$/.test(trimmed);
        return validFormat;
    }
    // Export/Import configuration
    exportConfig() {
        return JSON.parse(JSON.stringify(this.config));
    }
    importConfig(config) {
        const previous = this.config;
        const next = {
            default: config.default || previous.default,
            definitions: {
                ...previous.definitions,
                ...config.definitions,
            },
            agentAccess: {
                ...normalizeAgentAccessMap(previous.agentAccess),
                ...normalizeAgentAccessMap(config.agentAccess),
            },
        };
        // Suppress warnings until validation succeeds
        const originalWarn = console.warn;
        const warnings = [];
        console.warn = (msg) => warnings.push(msg);
        this.config = next;
        try {
            this.validateConfiguration();
            // Emit warnings only after successful validation
            warnings.forEach(w => originalWarn(w));
        }
        catch (err) {
            this.config = previous;
            throw err;
        }
        finally {
            console.warn = originalWarn;
        }
    }
    // Statistics
    getStats() {
        const scopes = this.getAllScopes();
        const scopesByType = {
            global: 0,
            agent: 0,
            custom: 0,
            project: 0,
            user: 0,
            other: 0,
        };
        for (const scope of scopes) {
            if (scope === "global") {
                scopesByType.global++;
            }
            else if (scope.startsWith("agent:")) {
                scopesByType.agent++;
            }
            else if (scope.startsWith("custom:")) {
                scopesByType.custom++;
            }
            else if (scope.startsWith("project:")) {
                scopesByType.project++;
            }
            else if (scope.startsWith("user:") || scope.startsWith("reflection:")) {
                // TODO: add a dedicated `reflection` bucket once downstream dashboards accept it.
                // For now, reflection scopes are counted under `user` for schema compatibility.
                scopesByType.user++;
            }
            else {
                scopesByType.other++;
            }
        }
        return {
            totalScopes: scopes.length,
            agentsWithCustomAccess: Object.keys(this.config.agentAccess).length,
            scopesByType,
        };
    }
}
// ============================================================================
// Factory Functions
// ============================================================================
export function createScopeManager(config) {
    return new MemoryScopeManager(config);
}
export function createAgentScope(agentId) {
    return SCOPE_PATTERNS.AGENT(agentId);
}
export function createCustomScope(name) {
    return SCOPE_PATTERNS.CUSTOM(name);
}
export function createProjectScope(projectId) {
    return SCOPE_PATTERNS.PROJECT(projectId);
}
export function createUserScope(userId) {
    return SCOPE_PATTERNS.USER(userId);
}
// ============================================================================
// Utility Functions
// ============================================================================
export function parseScopeId(scope) {
    if (scope === "global") {
        return { type: "global", id: "" };
    }
    const colonIndex = scope.indexOf(":");
    if (colonIndex === -1) {
        return null;
    }
    return {
        type: scope.substring(0, colonIndex),
        id: scope.substring(colonIndex + 1),
    };
}
export function isScopeAccessible(scope, allowedScopes) {
    return allowedScopes.includes(scope);
}
export function resolveScopeFilter(scopeManager, agentId) {
    if (typeof scopeManager.getScopeFilter === "function") {
        return scopeManager.getScopeFilter(agentId);
    }
    // Legacy/custom managers without getScopeFilter fall back to enumeration semantics.
    // For reserved bypass IDs, any array return is treated as a legacy bypass encoding and
    // normalized to undefined so callers see a consistent explicit-bypass contract.
    const fallbackScopes = scopeManager.getAccessibleScopes(agentId);
    if (!isSystemBypassId(agentId) && Array.isArray(fallbackScopes) && fallbackScopes.length === 0) {
        console.warn("resolveScopeFilter: non-bypass agent resolved to an empty scope list; downstream store reads will deny all access.");
        return [];
    }
    if (isSystemBypassId(agentId) && Array.isArray(fallbackScopes)) {
        const key = String(agentId);
        if (!warnedLegacyFallbackBypassIds.has(key)) {
            warnedLegacyFallbackBypassIds.add(key);
            const shape = fallbackScopes.length === 0 ? "[]" : `[${fallbackScopes.join(", ")}]`;
            console.warn(`resolveScopeFilter: legacy ScopeManager returned ${shape} for reserved bypass id '${key}'. ` +
                "Implement getScopeFilter() to make store-level bypass semantics explicit. " +
                "Normalizing legacy array return to undefined for bypass consistency.");
        }
        return undefined;
    }
    return fallbackScopes;
}
export function filterScopesForAgent(scopes, agentId, scopeManager) {
    if (!scopeManager || !agentId) {
        return scopes;
    }
    return scopes.filter(scope => scopeManager.isAccessible(scope, agentId));
}
