import {
  classifyIdentityAndAddressingMemory,
} from "./identity-addressing.js";
import { parseSmartMetadata } from "./smart-metadata.js";

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

type UserMdExclusiveSlot = "profile" | "name" | "addressing";

type BoundaryEntryLike = {
  text: string;
  metadata?: string;
  category?: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  importance?: number;
  timestamp?: number;
};

const PROFILE_HINT_PATTERNS = [
  /^User profile:/im,
  /^##\s*(?:Background|Profile|Context)$/im,
  /(?:^|\n)-\s*(?:Timezone|Pronouns?|Role|Language|Working style|Collaboration style)\s*:/i,
  /(?:我的时区是|我的代词是|我是|我的身份是|my timezone is|my pronouns are|i am)\b/iu,
  /(?:时区|代词|协作方式|工作方式|语言偏好)/u,
];

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

export function shouldFilterUserMdExclusiveRecall(
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): boolean {
  return resolveUserMdExclusiveConfig(workspaceBoundary).filterRecall;
}

export function isUserMdExclusiveMemory(
  params: {
    memoryCategory?: string;
    factKey?: string;
    text?: string;
    abstract?: string;
    overview?: string;
    content?: string;
  },
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): boolean {
  const config = resolveUserMdExclusiveConfig(workspaceBoundary);
  if (!config.enabled) return false;

  const slots = new Set<UserMdExclusiveSlot>();
  if (params.memoryCategory === "profile") {
    slots.add("profile");
  }

  const semantics = classifyIdentityAndAddressingMemory({
    factKey: params.factKey,
    text: params.text,
    abstract: params.abstract,
    overview: params.overview,
    content: params.content,
  });

  if (semantics.slots.has("name")) {
    slots.add("name");
  }
  if (semantics.slots.has("addressing")) {
    slots.add("addressing");
  }

  const probe = [
    params.text,
    params.abstract,
    params.overview,
    params.content,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join("\n");

  if (probe && PROFILE_HINT_PATTERNS.some((pattern) => pattern.test(probe))) {
    slots.add("profile");
  }

  if (config.routeProfile && slots.has("profile")) {
    return true;
  }

  if (config.routeCanonicalName && slots.has("name")) {
    return true;
  }

  if (config.routeCanonicalAddressing && slots.has("addressing")) {
    return true;
  }

  return false;
}

export function isUserMdExclusiveEntry(
  entry: BoundaryEntryLike,
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): boolean {
  const meta = parseSmartMetadata(entry.metadata, entry);
  return isUserMdExclusiveMemory(
    {
      memoryCategory: meta.memory_category,
      factKey: meta.fact_key,
      text: entry.text,
      abstract: meta.l0_abstract,
      overview: meta.l1_overview,
      content: meta.l2_content,
    },
    workspaceBoundary,
  );
}

export function filterUserMdExclusiveRecallResults<T extends { entry: BoundaryEntryLike }>(
  results: T[],
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): T[] {
  if (!shouldFilterUserMdExclusiveRecall(workspaceBoundary)) {
    return results;
  }

  return results.filter((result) => !isUserMdExclusiveEntry(result.entry, workspaceBoundary));
}
