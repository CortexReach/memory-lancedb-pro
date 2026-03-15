import {
  CANONICAL_ADDRESSING_FACT_KEY,
  CANONICAL_NAME_FACT_KEY,
  extractIdentityAndAddressingValues,
} from "./identity-addressing.js";

export interface UserMdExclusiveConfig {
  enabled?: boolean;
  routeProfile?: boolean;
  routeCanonicalName?: boolean;
  routeCanonicalAddressing?: boolean;
  filterRecall?: boolean;
}

export interface WorkspaceBoundaryConfig {
  userMdExclusive?: UserMdExclusiveConfig;
}

export interface ResolvedUserMdExclusiveConfig {
  enabled: boolean;
  routeProfile: boolean;
  routeCanonicalName: boolean;
  routeCanonicalAddressing: boolean;
  filterRecall: boolean;
}

function normalizeTextProbe(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveUserMdExclusiveConfig(
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): ResolvedUserMdExclusiveConfig {
  const raw = workspaceBoundary?.userMdExclusive;
  const enabled = raw?.enabled === true;
  return {
    enabled,
    routeProfile: enabled && raw?.routeProfile !== false,
    routeCanonicalName: enabled && raw?.routeCanonicalName !== false,
    routeCanonicalAddressing: enabled && raw?.routeCanonicalAddressing !== false,
    filterRecall: enabled && raw?.filterRecall !== false,
  };
}

export function isUserMdExclusiveMemory(
  params: {
    memoryCategory?: string;
    factKey?: string;
    text?: string;
    abstract?: string;
    content?: string;
  },
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): boolean {
  const config = resolveUserMdExclusiveConfig(workspaceBoundary);
  if (!config.enabled) return false;

  if (config.routeProfile && params.memoryCategory === "profile") {
    return true;
  }

  if (config.routeCanonicalName && params.factKey === CANONICAL_NAME_FACT_KEY) {
    return true;
  }
  if (
    config.routeCanonicalAddressing &&
    params.factKey === CANONICAL_ADDRESSING_FACT_KEY
  ) {
    return true;
  }

  const probe = [
    normalizeTextProbe(params.text),
    normalizeTextProbe(params.abstract),
    normalizeTextProbe(params.content),
  ]
    .filter(Boolean)
    .join("\n");

  if (!probe) return false;

  if (
    config.routeCanonicalName &&
    (/^姓名[:：]/m.test(probe) || !!extractIdentityAndAddressingValues(probe).name)
  ) {
    return true;
  }

  if (
    config.routeCanonicalAddressing &&
    (/^称呼偏好[:：]/m.test(probe) ||
      !!extractIdentityAndAddressingValues(probe).addressing)
  ) {
    return true;
  }

  return false;
}
