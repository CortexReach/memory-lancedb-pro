/**
 * Multi-Scope Access Control System
 * Manages memory isolation and access permissions
 */

// ============================================================================
// Types & Configuration
// ============================================================================

export interface ScopeDefinition {
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ScopeConfig {
  default: string;
  definitions: Record<string, ScopeDefinition>;
  agentAccess: Record<string, string[]>;
}

/**
 * Context variables available for template resolution in scope strings.
 * Populated from hook ctx at runtime (e.g. autoCapture / autoRecall).
 */
export interface ScopeContext {
  agentId?: string;
  accountId?: string;
  channelId?: string;
  conversationId?: string;
}

export interface ImplicitWriteScopeResolution {
  scope?: string;
  reason?: "template_unresolved" | "scope_invalid" | "scope_inaccessible";
  candidate?: string;
}

export interface ScopeManager {
  /**
   * Enumerate known scopes for the caller.
   *
   * Note: this is an enumeration API, not a full description of every syntactically-valid built-in
   * pattern accepted by `validateScope()` / `isAccessible()`. In particular, bypass callers may still
   * validate built-in scope patterns that are not explicitly registered in `definitions`.
   */
  getAccessibleScopes(agentId?: string): string[];
  /**
   * Optional store-layer filter hook.
   * Return `undefined` only for intentional full-bypass callers (for example internal system tasks).
   * Custom implementations should keep this distinct from `getAccessibleScopes()`, which is an
   * enumeration API and should remain consistent with `isAccessible()`.
   */
  getScopeFilter?(agentId?: string): string[] | undefined;
  getDefaultScope(agentId?: string): string;
  isAccessible(scope: string, agentId?: string): boolean;
  validateScope(scope: string): boolean;
  getAllScopes(): string[];
  getScopeDefinition(scope: string): ScopeDefinition | undefined;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
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
  AGENT: (agentId: string) => `agent:${agentId}`,
  CUSTOM: (name: string) => `custom:${name}`,
  REFLECTION: (agentId: string) => `reflection:agent:${agentId}`,
  PROJECT: (projectId: string) => `project:${projectId}`,
  USER: (userId: string) => `user:${userId}`,
};

const SYSTEM_BYPASS_IDS = new Set(["system", "undefined"]);
const warnedLegacyFallbackBypassIds = new Set<string>();

// ============================================================================
// Template & Wildcard Utilities
// ============================================================================

const TEMPLATE_VAR_RE = /\$\{(\w+)\}/g;

/** Returns true if the string contains `${...}` template variables. */
export function hasTemplateVars(s: string): boolean {
  return /\$\{\w+\}/.test(s);
}

/**
 * Resolve template variables in a scope string.
 * Unresolved variables (missing or empty in ctx) cause the function to return `undefined`,
 * signalling that the caller should fall back to a safe default.
 */
export function resolveTemplateScope(template: string, ctx: ScopeContext | undefined): string | undefined {
  if (!ctx) return undefined;
  let failed = false;
  const resolved = template.replace(TEMPLATE_VAR_RE, (_match, key: string) => {
    const val = (ctx as Record<string, unknown>)[key];
    if (typeof val === "string" && val.length > 0) return val;
    failed = true;
    return "";
  });
  return failed ? undefined : resolved;
}

/**
 * Check if a concrete scope matches a wildcard pattern.
 * Only trailing `*` is supported: `"user:*"` matches `"user:alice"`.
 * Non-wildcard strings are compared with strict equality.
 */
export function matchesWildcardScope(pattern: string, scope: string): boolean {
  if (!pattern.endsWith(":*")) return pattern === scope;
  const prefix = pattern.slice(0, -1); // "user:*" → "user:"
  return scope.startsWith(prefix) && scope.length > prefix.length;
}

/**
 * Infer the wildcard pattern from a template default scope.
 * e.g. `"user:${accountId}"` → `"user:*"`
 *      `"bot-1:user:${accountId}"` → `"bot-1:user:*"`
 *      `"agent:${agentId}:user:${accountId}"` → `undefined` (prefix contains only a top-level built-in namespace, too broad)
 *      `"${agentId}:user:${accountId}"` → `undefined` (starts with variable)
 *
 * Only produces a wildcard when the template has a static prefix before the first variable,
 * and the prefix is specific enough (not just a top-level built-in like "agent:").
 */
export function inferWildcardFromTemplate(template: string): string | undefined {
  const idx = template.indexOf("${");
  if (idx <= 0) return undefined; // no prefix or starts with variable
  const prefix = template.slice(0, idx);
  // Prefix must end with ":" to form a valid scope namespace
  if (!prefix.endsWith(":")) return undefined;
  // Reject if the prefix is just a top-level built-in namespace — the resulting wildcard
  // (e.g. "agent:*") would be far too broad and break isolation between agents/users/projects.
  const topLevelBuiltins = ["agent:", "user:", "custom:", "project:", "reflection:"];
  if (topLevelBuiltins.includes(prefix)) {
    // Exception: "user:${accountId}" → "user:*" is the primary use case and is safe
    // because user scopes are per-user by definition. But "agent:${agentId}:..." → "agent:*"
    // would grant access to ALL agent scopes.
    // Allow only if the entire remainder after prefix is a single variable (no further segments).
    const remainder = template.slice(idx);
    const isSingleVar = /^\$\{\w+\}$/.test(remainder);
    if (!isSingleVar) return undefined;
  }
  return prefix + "*";
}

function isConcreteWriteScope(scope: string): boolean {
  return !scope.endsWith(":*");
}

export function resolveImplicitWriteScope(
  params: {
    configuredDefaultScope?: string;
    scopeManager: Pick<ScopeManager, "getDefaultScope" | "isAccessible" | "validateScope">;
    agentId?: string;
    context?: ScopeContext;
  },
): ImplicitWriteScopeResolution {
  const {
    configuredDefaultScope,
    scopeManager,
    agentId,
    context,
  } = params;
  const defaultScope = configuredDefaultScope?.trim();

  if (defaultScope && hasTemplateVars(defaultScope)) {
    const resolved = resolveTemplateScope(defaultScope, context);
    if (!resolved) {
      return {
        reason: "template_unresolved",
      };
    }
    if (!isConcreteWriteScope(resolved) || !scopeManager.validateScope(resolved)) {
      return {
        reason: "scope_invalid",
        candidate: resolved,
      };
    }
    if (
      agentId &&
      !isSystemBypassId(agentId) &&
      !scopeManager.isAccessible(resolved, agentId)
    ) {
      return {
        reason: "scope_inaccessible",
        candidate: resolved,
      };
    }
    return {
      scope: resolved,
    };
  }

  const candidate =
    agentId && !isSystemBypassId(agentId)
      ? scopeManager.getDefaultScope(agentId)
      // Reserved bypass IDs must never be passed into getDefaultScope(agentId).
      : (defaultScope || scopeManager.getDefaultScope());

  if (!candidate || !isConcreteWriteScope(candidate) || !scopeManager.validateScope(candidate)) {
    return {
      reason: "scope_invalid",
      candidate,
    };
  }
  if (
    agentId &&
    !isSystemBypassId(agentId) &&
    !scopeManager.isAccessible(candidate, agentId)
  ) {
    return {
      reason: "scope_inaccessible",
      candidate,
    };
  }
  return {
    scope: candidate,
  };
}

export function isSystemBypassId(agentId?: string): boolean {
  return typeof agentId === "string" && SYSTEM_BYPASS_IDS.has(agentId);
}

/** @internal Exported for testing only — resets the legacy warning throttle. */
export function _resetLegacyFallbackWarningState(): void {
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
export function parseAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const sk = sessionKey.trim();
  // Match "agent:<id>" with or without trailing segments
  if (!sk.startsWith("agent:")) return undefined;
  const rest = sk.slice("agent:".length);
  const colonIdx = rest.indexOf(":");
  const candidate = (colonIdx === -1 ? rest : rest.slice(0, colonIdx)).trim();
  if (!candidate || isSystemBypassId(candidate)) {
    return undefined;
  }
  return candidate;
}

function withOwnReflectionScope(scopes: string[], agentId: string): string[] {
  const reflectionScope = SCOPE_PATTERNS.REFLECTION(agentId);
  return scopes.includes(reflectionScope) ? [...scopes] : [...scopes, reflectionScope];
}

function normalizeAgentAccessMap(
  agentAccess: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  if (!agentAccess) return normalized;
  for (const [rawAgentId, scopes] of Object.entries(agentAccess)) {
    const agentId = rawAgentId.trim();
    if (!agentId) continue;
    normalized[agentId] = Array.isArray(scopes) ? [...scopes] : [];
  }
  return normalized;
}

// ============================================================================
// Scope Manager Implementation
// ============================================================================

export class MemoryScopeManager implements ScopeManager {
  private config: ScopeConfig;

  constructor(config: Partial<ScopeConfig> = {}) {
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

  private validateConfiguration(): void {
    // Validate default scope exists in definitions (skip validation for template defaults)
    if (!hasTemplateVars(this.config.default) && !this.config.definitions[this.config.default]) {
      throw new Error(`Default scope '${this.config.default}' not found in definitions`);
    }

    // Validate agent access scopes exist in definitions + reject reserved bypass IDs
    for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
      // Trim before checking to prevent space-padded bypass IDs like " system "
      const trimmedAgentId = agentId.trim();
      if (isSystemBypassId(trimmedAgentId)) {
        throw new Error(
          `Reserved bypass agent ID '${trimmedAgentId}' cannot have explicit access configured. ` +
          `This is rejected in both constructor and importConfig paths.`
        );
      }
      for (const scope of scopes) {
        // Wildcard patterns (e.g. "user:*") are always valid
        if (scope.endsWith(":*")) continue;
        if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
          console.warn(`Agent '${agentId}' has access to undefined scope '${scope}'`);
        }
      }
    }
  }

  private isBuiltInScope(scope: string): boolean {
    // Accept wildcard patterns like "user:*" as valid built-in scopes
    if (scope.endsWith(":*")) {
      const prefix = scope.slice(0, -2); // "user:*" → "user"
      return ["agent", "custom", "project", "user", "reflection"].includes(prefix) ||
        // Also accept compound prefixes like "bot-1:user" → startsWith check
        this.isBuiltInScope(prefix.includes(":") ? prefix.slice(prefix.lastIndexOf(":") + 1) + ":x" : "");
    }
    return (
      scope === "global" ||
      scope.startsWith("agent:") ||
      scope.startsWith("custom:") ||
      scope.startsWith("project:") ||
      scope.startsWith("user:") ||
      scope.startsWith("reflection:")
    );
  }

  getAccessibleScopes(agentId?: string): string[] {
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
  getScopeFilter(agentId?: string): string[] | undefined {
    if (!agentId || isSystemBypassId(agentId)) {
      // No agent specified or internal system tasks bypass store-level scope
      // filtering entirely.  This aligns with isAccessible(scope, undefined)
      // which also uses bypass semantics for missing agentId.
      return undefined;
    }
    return this.getAccessibleScopes(agentId);
  }

  getDefaultScope(agentId?: string): string {
    if (!agentId) {
      // If default is a template, return "global" — callers without agentId
      // should use resolveHookDefaultScope() in the hook layer instead.
      if (hasTemplateVars(this.config.default)) return "global";
      return this.config.default;
    }
    if (isSystemBypassId(agentId)) {
      throw new Error(
        `Reserved bypass agent ID '${agentId}' must provide an explicit write scope instead of using getDefaultScope().`,
      );
    }

    // For agents, default to their private scope if they have access to it
    const agentScope = SCOPE_PATTERNS.AGENT(agentId);
    const accessibleScopes = this.getAccessibleScopes(agentId);

    if (accessibleScopes.some(s => matchesWildcardScope(s, agentScope))) {
      return agentScope;
    }

    // If config default is a template, don't return the raw template string —
    // return agent scope as a safe fallback (hook layer handles template resolution).
    if (hasTemplateVars(this.config.default)) return agentScope;

    return this.config.default;
  }

  isAccessible(scope: string, agentId?: string): boolean {
    if (!agentId || isSystemBypassId(agentId)) {
      // No agent specified, or internal bypass identifier: allow any valid scope.
      return this.validateScope(scope);
    }

    const accessibleScopes = this.getAccessibleScopes(agentId);
    // Exact match first, then wildcard match (e.g. "user:*" matches "user:alice")
    return accessibleScopes.some(s => matchesWildcardScope(s, scope));
  }

  validateScope(scope: string): boolean {
    if (!scope || typeof scope !== "string" || scope.trim().length === 0) {
      return false;
    }

    const trimmedScope = scope.trim();

    // Wildcard patterns are valid scope specifiers
    if (trimmedScope.endsWith(":*")) return true;

    // Check if scope is defined or is a built-in pattern
    return (
      this.config.definitions[trimmedScope] !== undefined ||
      this.isBuiltInScope(trimmedScope)
    );
  }

  getAllScopes(): string[] {
    return Object.keys(this.config.definitions);
  }

  getScopeDefinition(scope: string): ScopeDefinition | undefined {
    return this.config.definitions[scope];
  }

  // Management methods

  addScopeDefinition(scope: string, definition: ScopeDefinition): void {
    if (!this.validateScopeFormat(scope)) {
      throw new Error(`Invalid scope format: ${scope}`);
    }

    this.config.definitions[scope] = definition;
  }

  removeScopeDefinition(scope: string): boolean {
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

  setAgentAccess(agentId: string, scopes: string[]): void {
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

    // Validate all scopes (wildcards are always valid)
    for (const scope of scopes) {
      if (!scope.endsWith(":*") && !this.validateScope(scope)) {
        throw new Error(`Invalid scope: ${scope}`);
      }
    }

    this.config.agentAccess[normalizedAgentId] = [...scopes];
  }

  removeAgentAccess(agentId: string): boolean {
    const normalizedAgentId = agentId.trim();
    if (!this.config.agentAccess[normalizedAgentId]) {
      return false;
    }

    delete this.config.agentAccess[normalizedAgentId];
    return true;
  }

  private validateScopeFormat(scope: string): boolean {
    if (!scope || typeof scope !== "string") {
      return false;
    }

    const trimmed = scope.trim();

    // Basic format validation
    if (trimmed.length === 0 || trimmed.length > 100) {
      return false;
    }

    // Allow alphanumeric, hyphens, underscores, colons, dots, and wildcard asterisk
    const validFormat = /^[a-zA-Z0-9._:*-]+$/.test(trimmed);
    return validFormat;
  }

  // Export/Import configuration

  exportConfig(): ScopeConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  importConfig(config: Partial<ScopeConfig>): void {
    const previous = this.config;
    const next: ScopeConfig = {
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
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    this.config = next;
    try {
      this.validateConfiguration();
      // Emit warnings only after successful validation
      warnings.forEach(w => originalWarn(w));
    } catch (err) {
      this.config = previous;
      throw err;
    } finally {
      console.warn = originalWarn;
    }
  }

  // Statistics

  getStats(): {
    totalScopes: number;
    agentsWithCustomAccess: number;
    scopesByType: Record<string, number>;
  } {
    const scopes = this.getAllScopes();
    const scopesByType: Record<string, number> = {
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
      } else if (scope.startsWith("agent:")) {
        scopesByType.agent++;
      } else if (scope.startsWith("custom:")) {
        scopesByType.custom++;
      } else if (scope.startsWith("project:")) {
        scopesByType.project++;
      } else if (scope.startsWith("user:") || scope.startsWith("reflection:")) {
        // TODO: add a dedicated `reflection` bucket once downstream dashboards accept it.
        // For now, reflection scopes are counted under `user` for schema compatibility.
        scopesByType.user++;
      } else {
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

export function createScopeManager(config?: Partial<ScopeConfig>): MemoryScopeManager {
  return new MemoryScopeManager(config);
}

export function createAgentScope(agentId: string): string {
  return SCOPE_PATTERNS.AGENT(agentId);
}

export function createCustomScope(name: string): string {
  return SCOPE_PATTERNS.CUSTOM(name);
}

export function createProjectScope(projectId: string): string {
  return SCOPE_PATTERNS.PROJECT(projectId);
}

export function createUserScope(userId: string): string {
  return SCOPE_PATTERNS.USER(userId);
}

// ============================================================================
// Utility Functions
// ============================================================================

export function parseScopeId(scope: string): { type: string; id: string } | null {
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

export function isScopeAccessible(scope: string, allowedScopes: string[]): boolean {
  return allowedScopes.includes(scope);
}

export function resolveScopeFilter(
  scopeManager: Pick<ScopeManager, "getAccessibleScopes"> & {
    getScopeFilter?: (agentId?: string) => string[] | undefined;
  },
  agentId?: string,
): string[] | undefined {
  if (typeof scopeManager.getScopeFilter === "function") {
    return scopeManager.getScopeFilter(agentId);
  }
  // Legacy/custom managers without getScopeFilter fall back to enumeration semantics.
  // For reserved bypass IDs, any array return is treated as a legacy bypass encoding and
  // normalized to undefined so callers see a consistent explicit-bypass contract.
  const fallbackScopes = scopeManager.getAccessibleScopes(agentId);
  if (!isSystemBypassId(agentId) && Array.isArray(fallbackScopes) && fallbackScopes.length === 0) {
    console.warn(
      "resolveScopeFilter: non-bypass agent resolved to an empty scope list; downstream store reads will deny all access.",
    );
    return [];
  }
  if (isSystemBypassId(agentId) && Array.isArray(fallbackScopes)) {
    const key = String(agentId);
    if (!warnedLegacyFallbackBypassIds.has(key)) {
      warnedLegacyFallbackBypassIds.add(key);
      const shape = fallbackScopes.length === 0 ? "[]" : `[${fallbackScopes.join(", ")}]`;
      console.warn(
        `resolveScopeFilter: legacy ScopeManager returned ${shape} for reserved bypass id '${key}'. ` +
        "Implement getScopeFilter() to make store-level bypass semantics explicit. " +
        "Normalizing legacy array return to undefined for bypass consistency.",
      );
    }
    return undefined;
  }
  return fallbackScopes;
}

export function filterScopesForAgent(scopes: string[], agentId?: string, scopeManager?: ScopeManager): string[] {
  if (!scopeManager || !agentId) {
    return scopes;
  }

  return scopes.filter(scope => scopeManager.isAccessible(scope, agentId));
}
