/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { MemoryEntry, MemoryStore } from "./store.js";
import { isNoise, ENVELOPE_NOISE_PATTERNS } from "./noise-filter.js";
import { stripEnvelopeMetadata } from "./smart-extractor.js";
import { isSystemBypassId, resolveScopeFilter, parseAgentIdFromSessionKey, type MemoryScopeManager } from "./scopes.js";
import type { Embedder } from "./embedder.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  isMemoryActiveAt,
  isMemoryExpired,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";
import { classifyTemporal, inferExpiry } from "./temporal-classifier.js";
import {
  matchesMemoryCategoryFilter,
  resolveToolMemoryCategory,
  TEMPORAL_VERSIONED_CATEGORIES,
  TOOL_MEMORY_CATEGORIES,
  type MemoryCategory,
} from "./memory-categories.js";
import {
  appendSelfImprovementEntry,
  countSelfImprovementEntries,
  DEFAULT_SELF_IMPROVEMENT_MAX_ENTRIES,
  ensureSelfImprovementLearningFiles,
} from "./self-improvement-files.js";
import { getDisplayCategoryTag, parseReflectionMetadata } from "./reflection-metadata.js";
import type { RetrievalTrace } from "./retrieval-trace.js";
import {
  filterUserMdExclusiveRecallResults,
  isUserMdExclusiveMemory,
  type WorkspaceBoundaryConfig,
} from "./workspace-boundary.js";
import { isSuppressed as isTier1Suppressed } from "./auto-recall-tier1.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = TOOL_MEMORY_CATEGORIES;

function stringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}
export type MdMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: Embedder;
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  selfImprovementMaxEntries?: number;
  // Mirrors MemoryCliContext's onMemoriesDeleted (cli.ts): lets the host invalidate
  // in-process reflection caches after a live delete, not just CLI delete/delete-bulk.
  onMemoriesDeleted?: (info: { scopeFilter?: string[] }) => void;
}

function resolveAgentId(runtimeAgentId: unknown, fallback?: string): string | undefined {
  if (typeof runtimeAgentId === "string" && runtimeAgentId.trim().length > 0) return runtimeAgentId;
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback;
  return undefined;
}

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function deriveManualMemoryLayer(category: MemoryCategory): "durable" | "working" {
  if (category === "profile" || category === "preferences" || category === "events") {
    return "durable";
  }
  return "working";
}

function sanitizeMemoryForSerialization(
  results: RetrievalResult[],
  options: { includeNeighbors?: boolean } = {},
) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: getDisplayCategoryTag(r.entry),
    rawCategory: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
    ...(options.includeNeighbors && r.neighbors && r.neighbors.length > 0
      ? {
        neighbors: r.neighbors.map((neighbor) => ({
          id: neighbor.entry.id,
          text: neighbor.entry.text,
          category: getDisplayCategoryTag(neighbor.entry),
          rawCategory: neighbor.entry.category,
          scope: neighbor.entry.scope,
          importance: neighbor.entry.importance,
          score: neighbor.score,
          sources: neighbor.sources,
        })),
      }
      : {}),
  }));
}

function isManualRecallNeighborGovernanceEligible(
  result: RetrievalResult,
  nowMs: number,
): boolean {
  const meta = parseSmartMetadata(result.entry.metadata, result.entry);
  if (meta.state !== "confirmed") return false;
  if (meta.memory_layer === "archive" || meta.memory_layer === "reflection") return false;
  if (isTier1Suppressed(meta, nowMs)) return false;
  return true;
}

function filterManualRecallResultNeighbors(
  results: RetrievalResult[],
  workspaceBoundary?: WorkspaceBoundaryConfig,
  nowMs = Date.now(),
): RetrievalResult[] {
  return results.map((result) => {
    if (!result.neighbors || result.neighbors.length === 0) return result;

    const neighbors = filterUserMdExclusiveRecallResults(
      result.neighbors.filter((neighbor) => isManualRecallNeighborGovernanceEligible(neighbor, nowMs)),
      workspaceBoundary,
    );
    if (neighbors.length === result.neighbors.length) return result;
    if (neighbors.length > 0) return { ...result, neighbors };

    const { neighbors: _neighbors, ...withoutNeighbors } = result;
    return withoutNeighbors;
  });
}

function isUnresolvedReflectionItem(entry: MemoryEntry): boolean {
  const metadata = parseReflectionMetadata(entry.metadata);
  return metadata.type === "memory-reflection-item" && metadata.resolvedAt === undefined;
}

function formatReflectionResolveCandidate(result: {
  entry: MemoryEntry;
  score?: number;
}): Record<string, unknown> {
  const metadata = parseReflectionMetadata(result.entry.metadata);
  return {
    id: result.entry.id,
    text: truncateText(normalizeInlineText(result.entry.text), 220),
    itemKind: metadata.itemKind,
    agentId: metadata.agentId,
    score: result.score,
  };
}

function formatReflectionResolvePreview(candidates: Array<{ entry: MemoryEntry; score?: number }>): string {
  const lines = candidates.map((candidate, idx) => {
    const metadata = parseReflectionMetadata(candidate.entry.metadata);
    const itemKind = typeof metadata.itemKind === "string" ? metadata.itemKind : "item";
    const scoreText = typeof candidate.score === "number" ? ` score=${candidate.score.toFixed(3)}` : "";
    return `${idx + 1}. [${candidate.entry.id}] ${itemKind}${scoreText}: ${truncateText(normalizeInlineText(candidate.entry.text), 180)}`;
  });
  return [
    `Reflection resolve preview: ${candidates.length} candidate(s). No changes made.`,
    ...lines,
  ].join("\n");
}

function parseFactQueryTimestamp(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) return Date.now();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid at timestamp: ${value}`);
  }
  return parsed;
}

function formatFactTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function parseMetadataObject(rawMetadata: string | undefined): Record<string, unknown> {
  if (!rawMetadata) return {};
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hasExplicitMetadataField(entry: MemoryEntry, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(parseMetadataObject(entry.metadata), field);
}

function factQueryMatches(entry: MemoryEntry, query: string | undefined, factKey: string | undefined): boolean {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const normalizedFactKey = factKey?.trim().toLowerCase();
  if (normalizedFactKey && meta.fact_key?.toLowerCase() !== normalizedFactKey) return false;

  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    meta.fact_key,
    meta.memory_category,
    meta.l0_abstract,
    meta.l1_overview,
    entry.text,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(normalizedQuery));
}

function isTemporalFactEntry(entry: MemoryEntry, hasFactKeySelector: boolean): boolean {
  const rawMetadata = parseMetadataObject(entry.metadata);
  if (hasFactKeySelector) return true;

  return Boolean(
    hasExplicitMetadataField(entry, "supersedes") ||
    hasExplicitMetadataField(entry, "superseded_by") ||
    hasExplicitMetadataField(entry, "invalidated_at") ||
    hasExplicitMetadataField(entry, "valid_until") ||
    rawMetadata.memory_temporal_type === "dynamic",
  );
}

function serializeFactEntry(entry: MemoryEntry, atMs: number) {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const activeAt = isMemoryActiveAt(meta, atMs) && !isMemoryExpired(meta, atMs);
  return {
    id: entry.id,
    text: entry.text,
    scope: entry.scope,
    category: entry.category,
    memoryCategory: meta.memory_category,
    factKey: meta.fact_key,
    activeAt,
    validFrom: formatFactTimestamp(meta.valid_from),
    validUntil: formatFactTimestamp(meta.valid_until),
    invalidatedAt: formatFactTimestamp(meta.invalidated_at),
    supersedes: meta.supersedes,
    supersededBy: meta.superseded_by,
  };
}

const FACT_QUERY_PAGE_SIZE = 500;

type FactQueryCandidate = {
  entry: MemoryEntry;
  meta: ReturnType<typeof parseSmartMetadata>;
  fact: ReturnType<typeof serializeFactEntry>;
};

function compareFactQueryCandidates(a: FactQueryCandidate, b: FactQueryCandidate): number {
  if (a.fact.activeAt !== b.fact.activeAt) return a.fact.activeAt ? -1 : 1;
  return (b.meta.valid_from || 0) - (a.meta.valid_from || 0)
    || (b.entry.timestamp || 0) - (a.entry.timestamp || 0);
}

async function collectFactQueryMatches(
  store: MemoryStore,
  scopeFilter: string[] | undefined,
  query: string | undefined,
  factKey: string | undefined,
  atMs: number,
  includeHistory: boolean,
  limit: number,
  workspaceBoundary?: WorkspaceBoundaryConfig | null,
): Promise<FactQueryCandidate[]> {
  const matches: FactQueryCandidate[] = [];
  const seenIds = new Set<string>();
  const hasFactKeySelector = Boolean(factKey?.trim());

  for (let offset = 0; ; offset += FACT_QUERY_PAGE_SIZE) {
    const page = await store.list(scopeFilter, undefined, FACT_QUERY_PAGE_SIZE, offset);
    if (page.length === 0) break;

    let newRows = 0;
    const pageMatches: FactQueryCandidate[] = [];
    for (const entry of page) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      newRows += 1;
      if (isTemporalFactEntry(entry, hasFactKeySelector) && factQueryMatches(entry, query, factKey)) {
        const meta = parseSmartMetadata(entry.metadata, entry);
        const fact = serializeFactEntry(entry, atMs);
        if (meta.valid_from <= atMs && (includeHistory || fact.activeAt)) {
          pageMatches.push({ entry, meta, fact });
        }
      }
    }

    matches.push(...filterUserMdExclusiveRecallResults(pageMatches, workspaceBoundary));
    matches.sort(compareFactQueryCandidates);
    if (matches.length > limit) {
      matches.length = limit;
    }

    if (page.length < FACT_QUERY_PAGE_SIZE || newRows === 0) break;
  }

  return matches;
}

const _warnedMissingAgentId = new Set<string>();

/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState(): void {
  _warnedMissingAgentId.clear();
}

function resolveRuntimeAgentId(
  staticAgentId: string | undefined,
  runtimeCtx: unknown,
): string {
  if (!runtimeCtx || typeof runtimeCtx !== "object") {
    const fallback = staticAgentId?.trim();
    if (!fallback && !_warnedMissingAgentId.has("no-context")) {
      _warnedMissingAgentId.add("no-context");
      console.warn(
        "resolveRuntimeAgentId: no runtime context or static agentId, defaulting to 'main'. " +
        "Tool callers without explicit agentId will be scoped to agent:main + global + reflection:agent:main."
      );
    }
    return fallback || "main";
  }
  const ctx = runtimeCtx as Record<string, unknown>;
  const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
  const trimmed = resolved?.trim();
  if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
    _warnedMissingAgentId.add("empty-resolved");
    console.warn(
      "resolveRuntimeAgentId: resolved agentId is empty after trim, defaulting to 'main'."
    );
  }
  return trimmed ? trimmed : "main";
}

function resolveToolContext(
  base: ToolContext,
  runtimeCtx: unknown,
): ToolContext {
  return {
    ...base,
    agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function retrieveWithRetry(
  retriever: MemoryRetriever,
  params: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    category?: string;
    source?: "manual" | "auto-recall" | "cli";
  },
  countStore?: () => Promise<number>,
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(params);
  if (results.length === 0) {
    // Skip retry if store is empty — nothing to catch up via write-ahead lag.
    if (countStore) {
      const total = await countStore();
      if (total === 0) return results;
    }
    await sleep(75);
    results = await retriever.retrieve(params);
  }
  return results;
}

function resolveReadableToolScopeFilter(
  scopeManager: MemoryScopeManager,
  agentId: string | undefined,
  scope?: string,
): {
  scopeFilter: string[] | undefined;
  ignoredScope?: string;
  accessibleScopes?: string[];
} {
  if (scope) {
    if (scopeManager.isAccessible(scope, agentId)) {
      return { scopeFilter: [scope] };
    }
    const accessibleScopes = scopeManager.getAccessibleScopes(agentId);
    return {
      scopeFilter: resolveScopeFilter(scopeManager, agentId),
      ignoredScope: scope,
      accessibleScopes,
    };
  }

  return { scopeFilter: resolveScopeFilter(scopeManager, agentId) };
}

function formatIgnoredScopeNotice(resolvedScopes: {
  ignoredScope?: string;
  accessibleScopes?: string[];
}): string | undefined {
  if (!resolvedScopes.ignoredScope) return undefined;
  const scopes = resolvedScopes.accessibleScopes?.length
    ? resolvedScopes.accessibleScopes.join(", ")
    : "(none)";
  return `Ignored inaccessible scope "${resolvedScopes.ignoredScope}" and searched accessible scopes instead: ${scopes}.`;
}

export async function resolveMemoryId(
  context: ToolContext,
  memoryRef: string,
  scopeFilter: string[],
): Promise<
  | { ok: true; id: string }
  | { ok: false; message: string; details?: Record<string, unknown> }
> {
  // Agents copy ids out of injected context, which truncates them and often
  // appends an ellipsis ("407dec9c..."); strip that before classifying.
  const trimmed = memoryRef.trim().replace(/[.…]+$/u, "");
  if (!trimmed) {
    return {
      ok: false,
      message: "memoryId/query 不能为空。",
      details: { error: "empty_memory_ref" },
    };
  }

  const isFullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
  if (isFullUuid) {
    return { ok: true, id: trimmed };
  }

  // Documented contract: "full UUID or 8+ char prefix". A hex-shaped ref
  // that is not a complete UUID resolves as an id prefix within accessible
  // scopes — unique match wins, multiple matches list candidates, and zero
  // matches is an honest not-found (never a scan-match or a semantic guess).
  const isIdPrefix = /^[0-9a-f][0-9a-f-]{7,35}$/i.test(trimmed);
  if (isIdPrefix) {
    const matches = await context.store.findByIdPrefix(trimmed, scopeFilter);
    if (matches.length === 1) {
      return { ok: true, id: matches[0].id };
    }
    if (matches.length > 1) {
      const list = matches
        .map(
          (entry) =>
            `- [${entry.id.slice(0, 8)}] ${entry.text.slice(0, 60)}${entry.text.length > 60 ? "..." : ""}`,
        )
        .join("\n");
      return {
        ok: false,
        message: `Id prefix "${trimmed}" matches multiple memories. Use a longer prefix or the full id:\n${list}`,
        details: { error: "ambiguous_id_prefix", prefix: trimmed },
      };
    }
    return {
      ok: false,
      message: `Memory ${trimmed} not found or access denied.`,
      details: { error: "not_found", id: trimmed },
    };
  }

  const results = await retrieveWithRetry(context.retriever, {
    query: trimmed,
    limit: 5,
    scopeFilter,
  }, () => context.store.count());
  if (results.length === 0) {
    return {
      ok: false,
      message: `No memory found matching "${trimmed}".`,
      details: { error: "not_found", query: trimmed },
    };
  }
  if (results.length === 1 || results[0].score > 0.85) {
    return { ok: true, id: results[0].entry.id };
  }

  const list = results
    .map(
      (r) =>
        `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
    )
    .join("\n");
  return {
    ok: false,
    message: `Multiple matches. Specify memoryId:\n${list}`,
    details: {
      action: "candidates",
      candidates: sanitizeMemoryForSerialization(results),
    },
  };
}

function resolveWorkspaceDir(toolCtx: unknown, fallback?: string): string {
  const runtime = toolCtx as Record<string, unknown> | undefined;
  const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
  if (runtimePath) return runtimePath;
  if (fallback && fallback.trim()) return fallback;
  return join(homedir(), ".openclaw", "workspace");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerSelfImprovementLogTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_log",
      label: "Self-Improvement Log",
      description: "Log structured learning/error entries into .learnings for governance and later distillation.",
      parameters: Type.Object({
        type: stringEnum(["learning", "error"]),
        summary: Type.String({ description: "One-line summary" }),
        details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
        suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
        category: Type.Optional(Type.String({ description: "learning category (correction/best_practice/knowledge_gap) when type=learning" })),
        area: Type.Optional(Type.String({ description: "frontend|backend|infra|tests|docs|config or custom area" })),
        priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
      }),
      async execute(_toolCallId, params) {
        const {
          type,
          summary,
          details = "",
          suggestedAction = "",
          category = "best_practice",
          area = "config",
          priority = "medium",
        } = params as {
          type: "learning" | "error";
          summary: string;
          details?: string;
          suggestedAction?: string;
          category?: string;
          area?: string;
          priority?: string;
        };
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          const result = await appendSelfImprovementEntry({
            baseDir: workspaceDir,
            type,
            summary,
            details,
            suggestedAction,
            category,
            area,
            priority,
            source: "memory-lancedb-pro/self_improvement_log",
            maxEntries: context.selfImprovementMaxEntries,
          });
          const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
          if (result.skipped) {
            return {
              content: [{
                type: "text",
                text:
                  `Skipped ${type} entry: .learnings/${fileName} already has ` +
                  `${result.entryCount}/${result.maxEntries} entries. Review, archive, or raise selfImprovement.maxEntries.`,
              }],
              details: {
                action: "skipped_limit",
                type,
                filePath: result.filePath,
                entryCount: result.entryCount,
                maxEntries: result.maxEntries,
              },
            };
          }

          return {
            content: [{ type: "text", text: `Logged ${type} entry ${result.id} to .learnings/${fileName}` }],
            details: {
              action: "logged",
              type,
              id: result.id,
              filePath: result.filePath,
              entryCount: result.entryCount,
              maxEntries: result.maxEntries,
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_log_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_log" }
  );
}

export function registerSelfImprovementExtractSkillTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_extract_skill",
      label: "Extract Skill From Learning",
      description: "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
      parameters: Type.Object({
        learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001" }),
        skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
        sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md"])),
        outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
      }),
      async execute(_toolCallId, params) {
        const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params as {
          learningId: string;
          skillName: string;
          sourceFile?: "LEARNINGS.md" | "ERRORS.md";
          outputDir?: string;
        };
        try {
          if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
            return {
              content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
              details: { error: "invalid_learning_id" },
            };
          }
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
            return {
              content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
              details: { error: "invalid_skill_name" },
            };
          }

          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const learningsPath = join(workspaceDir, ".learnings", sourceFile);
          const learningBody = await readFile(learningsPath, "utf-8");
          const escapedLearningId = escapeRegExp(learningId.trim());
          const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
          const match = learningBody.match(entryRegex);
          if (!match) {
            return {
              content: [{ type: "text", text: `Learning entry ${learningId} not found in .learnings/${sourceFile}` }],
              details: { error: "learning_not_found", learningId, sourceFile },
            };
          }

          const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
          const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
          const safeOutputDir = outputDir
            .replace(/\\/g, "/")
            .split("/")
            .filter((segment) => segment && segment !== "." && segment !== "..")
            .join("/");
          const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
          await mkdir(skillDir, { recursive: true });
          const skillPath = join(skillDir, "SKILL.md");
          const skillTitle = skillName
            .split("-")
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(" ");
          const skillContent = [
            "---",
            `name: ${skillName}`,
            `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
            "---",
            "",
            `# ${skillTitle}`,
            "",
            "## Why",
            summary,
            "",
            "## When To Use",
            "- [TODO] Define trigger conditions",
            "",
            "## Steps",
            "1. [TODO] Add repeatable workflow steps",
            "2. [TODO] Add verification steps",
            "",
            "## Source Learning",
            `- Learning ID: ${learningId}`,
            `- Source File: .learnings/${sourceFile}`,
            "",
          ].join("\n");
          await writeFile(skillPath, skillContent, "utf-8");

          const promotedMarker = `**Status**: promoted_to_skill`;
          const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
          let updatedEntry = match[0];
          updatedEntry = updatedEntry.includes("**Status**:")
            ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
            : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
          if (!updatedEntry.includes("Skill-Path:")) {
            updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
          }
          const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
          await writeFile(learningsPath, updatedLearningBody, "utf-8");

          return {
            content: [{ type: "text", text: `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.` }],
            details: {
              action: "skill_extracted",
              learningId,
              sourceFile,
              skillPath: `${safeOutputDir || "skills"}/${skillName}/SKILL.md`,
            },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to extract skill: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_extract_skill_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_extract_skill" }
  );
}

export function registerSelfImprovementReviewTool(api: OpenClawPluginApi, context: ToolContext) {
  api.registerTool(
    (toolCtx) => ({
      name: "self_improvement_review",
      label: "Self-Improvement Review",
      description: "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
      parameters: Type.Object({}),
      async execute() {
        try {
          const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
          await ensureSelfImprovementLearningFiles(workspaceDir);
          const learningsDir = join(workspaceDir, ".learnings");
          const files = ["LEARNINGS.md", "ERRORS.md"] as const;
          const maxEntries = context.selfImprovementMaxEntries ?? DEFAULT_SELF_IMPROVEMENT_MAX_ENTRIES;
          const stats = {
            pending: 0,
            high: 0,
            promoted: 0,
            total: 0,
            files: {} as Record<string, { entries: number; maxEntries: number; atLimit: boolean }>,
          };

          for (const f of files) {
            const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
            const entries = countSelfImprovementEntries(content);
            stats.files[f] = {
              entries,
              maxEntries,
              atLimit: entries >= maxEntries,
            };
            stats.total += entries;
            stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
            stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
            stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
          }

          const text = [
            "Self-Improvement Governance Snapshot:",
            `- Total entries: ${stats.total}`,
            `- Pending: ${stats.pending}`,
            `- High/Critical: ${stats.high}`,
            `- Promoted: ${stats.promoted}`,
            `- LEARNINGS.md: ${stats.files["LEARNINGS.md"].entries}/${maxEntries}`,
            `- ERRORS.md: ${stats.files["ERRORS.md"].entries}/${maxEntries}`,
            "",
            "Recommended loop:",
            "1) Resolve high-priority pending entries",
            "2) Distill reusable rules into AGENTS.md / SOUL.md / TOOLS.md",
            "3) Extract repeatable patterns as skills",
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: { action: "review", stats },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to review self-improvement backlog: ${error instanceof Error ? error.message : String(error)}` }],
            details: { error: "self_improvement_review_failed", message: String(error) },
          };
        }
      },
    }),
    { name: "self_improvement_review" }
  );
}

// ============================================================================
// Core Tools (Backward Compatible)
// ============================================================================

const MEMORY_RECALL_PARAMETERS = Type.Object({
  query: Type.String({
    description: "Search query for finding relevant memories",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
    }),
  ),
  includeFullText: Type.Optional(
    Type.Boolean({
      description: "Return full memory text when true (default: false returns summary previews)",
    }),
  ),
  maxCharsPerItem: Type.Optional(
    Type.Number({
      description: "Maximum characters per returned memory in summary mode (default: 180)",
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description: "Specific memory scope to search in (optional)",
    }),
  ),
  category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
});

function createMemoryRecallTool(
  runtimeContext: ToolContext,
  options: {
    name: string;
    label: string;
    description: string;
  },
) {
  return {
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: MEMORY_RECALL_PARAMETERS,
    async execute(_toolCallId: unknown, params: unknown) {
        const {
          query,
          limit = 3,
          includeFullText = false,
          maxCharsPerItem = 180,
          scope,
          category,
        } = params as {
          query: string;
          limit?: number;
          includeFullText?: boolean;
          maxCharsPerItem?: number;
          scope?: string;
          category?: string;
        };

        try {
          const safeLimit = includeFullText
            ? clampInt(limit, 1, 20)
            : clampInt(limit, 1, 6);
          const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);
          const agentId = runtimeContext.agentId;

          const resolvedScopes = resolveReadableToolScopeFilter(
            runtimeContext.scopeManager,
            agentId,
            scope,
          );
          const { scopeFilter } = resolvedScopes;
          const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);

          const retrievedResults = await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
            category,
            source: "manual",
          }, () => runtimeContext.store.count());
          const results = filterManualRecallResultNeighbors(
            filterUserMdExclusiveRecallResults(retrievedResults, runtimeContext.workspaceBoundary),
            runtimeContext.workspaceBoundary,
          );

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: [ignoredScopeNotice, "No relevant memories found."].filter(Boolean).join("\n") }],
              details: {
                count: 0,
                query,
                scopes: scopeFilter,
                ignoredScope: resolvedScopes.ignoredScope,
                accessibleScopes: resolvedScopes.accessibleScopes,
              },
            };
          }

          const now = Date.now();
          await Promise.allSettled(
            results.map((result) => {
              const meta = parseSmartMetadata(result.entry.metadata, result.entry);
              return runtimeContext.store.patchMetadata(
                result.entry.id,
                {
                  access_count: meta.access_count + 1,
                  last_accessed_at: now,
                  last_confirmed_use_at: now,
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                  // Manual recall is a strong positive signal — clear active
                  // ms-based suppression too, matching pre-Tier1 semantics
                  // where zeroing the turn field cleared the only suppression
                  // mechanism. Without this, governance keeps suppressing a
                  // memory the user just explicitly searched for.
                  suppressed_until_ms: 0,
                },
                scopeFilter,
              );
            }),
          );

          const text = results
            .map((r, i) => {
              const categoryTag = getDisplayCategoryTag(r.entry);
              const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
              const base = includeFullText
                ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
                : (metadata.l0_abstract || r.entry.text);
              const inline = normalizeInlineText(base);
              const neighborText = r.neighbors && r.neighbors.length > 0
                ? ` Neighbors: ${r.neighbors
                  .map((neighbor) => `[${neighbor.entry.id}] ${truncateText(normalizeInlineText(neighbor.entry.text), 120)}`)
                  .join("; ")}`
                : "";
              const rendered = includeFullText
                ? `${inline}${neighborText}`
                : truncateText(`${inline}${neighborText}`, safeCharsPerItem);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${rendered}`;
            })
            .join("\n");

          const serializedMemories = sanitizeMemoryForSerialization(results, { includeNeighbors: true });
          if (includeFullText) {
            for (let i = 0; i < results.length; i++) {
              const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
              (serializedMemories[i] as Record<string, unknown>).fullText =
                metadata.l2_content || metadata.l1_overview || results[i].entry.text;
            }
          }

          return {
            content: [
              {
                type: "text",
                text: [
                  ignoredScopeNotice,
                  `<relevant-memories>\n<mode:${includeFullText ? "full" : "summary"}>\nFound ${results.length} memories:\n\n${text}\n</relevant-memories>`,
                ].filter(Boolean).join("\n"),
              },
            ],
            details: {
              count: results.length,
              memories: serializedMemories,
              query,
              scopes: scopeFilter,
              ignoredScope: resolvedScopes.ignoredScope,
              accessibleScopes: resolvedScopes.accessibleScopes,
              retrievalMode: runtimeContext.retriever.getConfig().mode,
              recallMode: includeFullText ? "full" : "summary",
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "recall_failed", message: String(error) },
          };
        }
    },
  };
}

export function registerMemoryRecallTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return createMemoryRecallTool(runtimeContext, {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
      });
    },
    { name: "memory_recall" },
  );
}

export function registerMemoryRecallAliasTool(
  api: OpenClawPluginApi,
  context: ToolContext,
  alias: "memory_search" | "memory_get",
) {
  const label = alias === "memory_get" ? "Memory Get" : "Memory Search";
  const description = alias === "memory_get"
    ? "Compatibility alias for memory_recall. Search and return relevant long-term memories for OpenClaw profiles that request memory_get."
    : "Compatibility alias for memory_recall. Search through long-term memories for OpenClaw profiles that request memory_search.";

  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return createMemoryRecallTool(runtimeContext, {
        name: alias,
        label,
        description,
      });
    },
    { name: alias },
  );
}

export function registerMemoryFactQueryTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_fact_query",
        label: "Memory Fact Query",
        description:
          "Deterministically query current or historical temporal facts by fact key or text without semantic reranking.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Text to match against fact keys and fact summaries." })),
          factKey: Type.Optional(Type.String({ description: "Exact temporal fact key, such as preferences:drink." })),
          at: Type.Optional(Type.String({ description: "ISO timestamp/date for as-of lookup. Defaults to now." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          includeHistory: Type.Optional(Type.Boolean({ description: "Include inactive superseded/expired facts (default false)." })),
          limit: Type.Optional(Type.Number({ description: "Maximum facts to return (default 10, max 100)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const {
            query,
            factKey,
            at,
            scope,
            includeHistory = false,
            limit = 10,
          } = params as {
            query?: string;
            factKey?: string;
            at?: string;
            scope?: string;
            includeHistory?: boolean;
            limit?: number;
          };

          try {
            const safeLimit = clampInt(limit, 1, 100);
            const trimmedQuery = query?.trim();
            const trimmedFactKey = factKey?.trim();
            if (!trimmedQuery && !trimmedFactKey) {
              return {
                content: [{
                  type: "text",
                  text: "Fact query requires a query or exact factKey selector.",
                }],
                details: {
                  action: "fact_query",
                  error: "missing_selector",
                },
              };
            }
            const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
            const resolvedScopes = resolveReadableToolScopeFilter(runtimeContext.scopeManager, agentId, scope);
            const atMs = parseFactQueryTimestamp(at);
            const entries = await collectFactQueryMatches(
              runtimeContext.store,
              resolvedScopes.scopeFilter,
              trimmedQuery,
              trimmedFactKey,
              atMs,
              includeHistory,
              safeLimit,
              runtimeContext.workspaceBoundary,
            );

            const facts = entries
              .map(({ fact }) => fact);

            const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);
            const lines = facts.map((fact, index) => {
              const status = fact.activeAt ? "active" : "historical";
              const datePart = [fact.validFrom ? `from=${fact.validFrom}` : undefined, fact.validUntil ? `until=${fact.validUntil}` : undefined]
                .filter(Boolean)
                .join(" ");
              return `${index + 1}. [${status}] ${fact.factKey ?? fact.memoryCategory ?? fact.category} ${datePart} ${truncateText(normalizeInlineText(fact.text), 180)}`.trim();
            });

            return {
              content: [{
                type: "text",
                text: [
                  ignoredScopeNotice,
                  lines.length > 0
                    ? `Fact query returned ${facts.length} result(s) as of ${new Date(atMs).toISOString()}:\n${lines.join("\n")}`
                    : `Fact query returned 0 result(s) as of ${new Date(atMs).toISOString()}.`,
                ].filter(Boolean).join("\n"),
              }],
              details: {
                action: "fact_query",
                query: trimmedQuery,
                factKey: trimmedFactKey,
                asOf: new Date(atMs).toISOString(),
                includeHistory,
                count: facts.length,
                ignoredScope: resolvedScopes.ignoredScope,
                accessibleScopes: resolvedScopes.accessibleScopes,
                facts,
              },
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Fact query failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: { error: "fact_query_failed", message: String(error) },
            };
          }
        },
      };
    },
    { name: "memory_fact_query" },
  );
}

export function registerMemoryStoreTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(
          Type.Number({ description: "Importance score 0-1 (default: 0.7)" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        scope: Type.Optional(
          Type.String({
            description: "Memory scope (optional, defaults to agent scope)",
          }),
        ),
        force: Type.Optional(
          Type.Boolean({
            description: "Store even when the duplicate pre-check finds a very similar existing memory",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          text,
          importance = 0.7,
          category = "other",
          scope,
          force = false,
        } = params as {
          text: string;
          importance?: number;
          category?: string;
          scope?: string;
          force?: boolean;
        };

        try {
          // Guard: strip envelope metadata first, reject only if nothing remains (P2 fix)
          const stripped = stripEnvelopeMetadata(text);
          if (!stripped.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Skipped: text is purely envelope metadata with no extractable memory content.",
                },
              ],
              details: { action: "envelope_metadata_rejected", text: text.slice(0, 60) },
            };
          }

          const agentId = runtimeContext.agentId;
          // Determine target scope
          let targetScope = scope;
          if (!targetScope) {
            if (isSystemBypassId(agentId)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Reserved bypass agent IDs must provide an explicit scope for memory_store writes.",
                  },
                ],
                details: {
                  error: "explicit_scope_required",
                  agentId,
                },
              };
            }
            targetScope = runtimeContext.scopeManager.getDefaultScope(agentId);
          }

          // Validate scope access
          if (!runtimeContext.scopeManager.isAccessible(targetScope, agentId)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Access denied to scope: ${targetScope}`,
                },
              ],
              details: {
                error: "scope_access_denied",
                requestedScope: targetScope,
              },
            };
          }

          // Reject noise before wasting an embedding API call
          if (isNoise(text)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
                },
              ],
              details: { action: "noise_filtered", text: text.slice(0, 60) },
            };
          }

          if (
            isUserMdExclusiveMemory(
              { text },
              runtimeContext.workspaceBoundary,
            )
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Skipped: this fact belongs in USER.md, not plugin memory.",
                },
              ],
              details: {
                action: "skipped_by_workspace_boundary",
                boundary: "user_md_exclusive",
              },
            };
          }

          const safeImportance = clamp01(importance, 0.7);
          const { memoryCategory, storageCategory } =
            resolveToolMemoryCategory(category);
          const vector = await runtimeContext.embedder.embedPassage(stripped);

          // Temporal awareness: classify and infer expiry
          const temporalType = classifyTemporal(stripped);
          const validUntil = inferExpiry(stripped);
          // Check for duplicates / supersede candidates using raw vector similarity
          // (bypasses importance/recency weighting).
          // Fail-open by design: dedup must never block a legitimate memory write.
          // excludeInactive: superseded historical records must not block new writes.
          // Align with TEMPORAL_VERSIONED_CATEGORIES at the smart-category
          // layer so legacy storage categories like "fact" don't cross-match
          // unrelated profile/case memories.
          let existing: Awaited<ReturnType<MemoryStore["vectorSearch"]>> = [];
          try {
            existing = await runtimeContext.store.vectorSearch(vector, 3, 0.1, [
              targetScope,
            ], { excludeInactive: true });
          } catch (err) {
            console.warn(
              `memory-lancedb-pro: duplicate pre-check failed, continue store: ${String(err)}`,
            );
          }

          const duplicateCandidate = existing[0]?.score > 0.98 ? existing[0] : undefined;
          if (duplicateCandidate && !force) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${duplicateCandidate.entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: duplicateCandidate.entry.id,
                existingText: duplicateCandidate.entry.text,
                existingScope: duplicateCandidate.entry.scope,
                similarity: duplicateCandidate.score,
              },
            };
          }

          // Auto-supersede: if a similar memory exists (0.95-0.98 similarity),
          // same storage-layer category, and category is eligible, mark the old
          // one as superseded and store the new one with a supersedes link.
          const supersedeCandidate = existing.find(
            (r) =>
              r.score > 0.95 &&
              r.score <= 0.98 &&
              TEMPORAL_VERSIONED_CATEGORIES.has(memoryCategory) &&
              matchesMemoryCategoryFilter(r.entry.category, memoryCategory, r.entry.metadata),
          );

          if (supersedeCandidate) {
            const oldEntry = supersedeCandidate.entry;
            const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
            const now = Date.now();
            const factKey =
              oldMeta.fact_key ?? deriveFactKey(oldMeta.memory_category, text);

            // Store new memory with supersedes link, preserving canonical fields
            // from the old entry (aligns with memory_update supersede path).
            const newMeta = buildSmartMetadata(
              { text, category: storageCategory, importance: safeImportance },
              {
                l0_abstract: text,
                l1_overview: oldMeta.l1_overview || `- ${text}`,
                l2_content: text,
                memory_category: oldMeta.memory_category,
                tier: oldMeta.tier,
                source: "manual",
                state: "confirmed",
                memory_layer: deriveManualMemoryLayer(oldMeta.memory_category),
                last_confirmed_use_at: now,
                bad_recall_count: 0,
                suppressed_until_turn: 0,
                valid_from: now,
                fact_key: factKey,
                supersedes: oldEntry.id,
                relations: appendRelation([], {
                  type: "supersedes",
                  targetId: oldEntry.id,
                }),
              },
            );

            const newEntry = await runtimeContext.store.store({
              text,
              vector,
              importance: safeImportance,
              category: storageCategory,
              scope: targetScope,
              metadata: stringifySmartMetadata(newMeta),
            });

            // Invalidate old record
            try {
              await runtimeContext.store.patchMetadata(
                oldEntry.id,
                {
                  fact_key: factKey,
                  invalidated_at: now,
                  superseded_by: newEntry.id,
                  relations: appendRelation(oldMeta.relations, {
                    type: "superseded_by",
                    targetId: newEntry.id,
                  }),
                },
                [targetScope],
              );
            } catch (patchErr) {
              // New record is already the source of truth; log but don't fail
              console.warn(
                `memory-pro: failed to patch superseded record ${oldEntry.id.slice(0, 8)}: ${patchErr}`,
              );
            }

            // Dual-write to Markdown mirror if enabled
            if (context.mdMirror) {
              await context.mdMirror(
                { text, category: storageCategory, scope: targetScope, timestamp: newEntry.timestamp },
                { source: "memory_store", agentId },
              );
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Superseded memory ${oldEntry.id.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                },
              ],
              details: {
                action: "superseded",
                id: newEntry.id,
                supersededId: oldEntry.id,
                scope: newEntry.scope,
                category: memoryCategory,
                rawCategory: newEntry.category,
                importance: newEntry.importance,
                similarity: supersedeCandidate.score,
              },
            };
          }

          const entry = await runtimeContext.store.store({
            text,
            vector,
            importance: safeImportance,
            category: storageCategory,
            scope: targetScope,
            metadata: stringifySmartMetadata(
              buildSmartMetadata(
                {
                  text,
                  category: storageCategory,
                  importance: safeImportance,
                },
                {
                  l0_abstract: text,
                  l1_overview: `- ${text}`,
                  l2_content: text,
                  memory_category: memoryCategory,
                  source: "manual",
                  state: "confirmed",
                  memory_layer: deriveManualMemoryLayer(memoryCategory),
                  last_confirmed_use_at: Date.now(),
                  bad_recall_count: 0,
                  suppressed_until_turn: 0,
                  memory_temporal_type: temporalType,
                  valid_until: validUntil,
                },
              ),
            ),
          });

          // Dual-write to Markdown mirror if enabled
          if (context.mdMirror) {
            await context.mdMirror(
              { text, category: storageCategory, scope: targetScope, timestamp: entry.timestamp },
              { source: "memory_store", agentId },
            );
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${targetScope}'`,
              },
            ],
            details: {
              action: "created",
              id: entry.id,
              scope: entry.scope,
              category: memoryCategory,
              rawCategory: entry.category,
              importance: entry.importance,
              ...(duplicateCandidate && force
                ? { duplicateOverride: {
                  existingId: duplicateCandidate.entry.id,
                  existingText: duplicateCandidate.entry.text,
                  existingScope: duplicateCandidate.entry.scope,
                  similarity: duplicateCandidate.score,
                } }
                : {}),
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "store_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_store" },
  );
}

export function registerMemoryForgetTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete specific memories. Supports both search-based and direct ID-based deletion.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "Search query to find memory to delete" }),
        ),
        memoryId: Type.Optional(
          Type.String({ description: "Specific memory ID to delete" }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Scope to search/delete from (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { query, memoryId, scope } = params as {
          query?: string;
          memoryId?: string;
          scope?: string;
        };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          // Determine accessible scopes
          let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
          if (scope) {
            if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
              scopeFilter = [scope];
            } else {
              return {
                content: [
                  { type: "text", text: `Access denied to scope: ${scope}` },
                ],
                details: {
                  error: "scope_access_denied",
                  requestedScope: scope,
                },
              };
            }
          }

          if (memoryId) {
            const resolved = await resolveMemoryId(context, memoryId, scopeFilter);
            if (resolved.ok === false) {
              return {
                content: [{ type: "text", text: resolved.message }],
                details: resolved.details ?? { error: "not_found", id: memoryId },
              };
            }
            const deleted = await context.store.delete(resolved.id, scopeFilter);
            if (deleted) {
              context.onMemoriesDeleted?.({ scopeFilter });
              return {
                content: [
                  { type: "text", text: `Memory ${resolved.id} forgotten.` },
                ],
                details: { action: "deleted", id: resolved.id },
              };
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${resolved.id} not found or access denied.`,
                  },
                ],
                details: { error: "not_found", id: resolved.id },
              };
            }
          }

          if (query) {
            const results = await retrieveWithRetry(context.retriever, {
              query,
              limit: 5,
              scopeFilter,
            }, () => context.store.count());

            if (results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { found: 0, query },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              const deleted = await context.store.delete(
                results[0].entry.id,
                scopeFilter,
              );
              if (deleted) {
                context.onMemoriesDeleted?.({ scopeFilter });
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].entry.text}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].entry.id },
                };
              }
            }

            const list = results
              .map(
                (r) =>
                  `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: sanitizeMemoryForSerialization(results),
              },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: "Provide either 'query' to search for memories or 'memoryId' to delete specific memory.",
              },
            ],
            details: { error: "missing_param" },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory deletion failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "delete_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_forget" },
  );
}

// ============================================================================
// Update Tool
// ============================================================================

export function registerMemoryUpdateTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_update",
      label: "Memory Update",
      description:
        "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history. Metadata-only changes (importance, category) update in-place.",
      parameters: Type.Object({
        memoryId: Type.String({
          description:
            "ID of the memory to update (full UUID or 8+ char prefix)",
        }),
        text: Type.Optional(
          Type.String({
            description: "New text content (triggers re-embedding)",
          }),
        ),
        importance: Type.Optional(
          Type.Number({ description: "New importance score 0-1" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { memoryId, text, importance, category } = params as {
          memoryId: string;
          text?: string;
          importance?: number;
          category?: string;
        };

        try {
          if (!text && importance === undefined && !category) {
            return {
              content: [
                {
                  type: "text",
                  text: "Nothing to update. Provide at least one of: text, importance, category.",
                },
              ],
              details: { error: "no_updates" },
            };
          }
          const categoryResolution = category
            ? resolveToolMemoryCategory(category)
            : undefined;

          // Determine accessible scopes
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);

          // Resolve memoryId through the shared resolver: full UUID passes
          // through, an 8+ char id prefix resolves against accessible rows
          // (the tool's documented contract), anything else falls back to
          // semantic search.
          const resolution = await resolveMemoryId(context, memoryId, scopeFilter);
          if (resolution.ok === false) {
            return {
              content: [{ type: "text", text: resolution.message }],
              details: resolution.details ?? { error: "not_found", id: memoryId },
            };
          }
          const resolvedId = resolution.id;

          // If text changed, re-embed; reject noise
          let newVector: number[] | undefined;
          if (text) {
            if (isNoise(text)) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Skipped: updated text detected as noise",
                  },
                ],
                details: { action: "noise_filtered" },
              };
            }
            newVector = await context.embedder.embedPassage(text);
          }

          // Fetch existing entry once when we may need it (text change, or
          // importance-only change that still needs metadata sync). Shared by
          // the temporal supersede guard and the normal-path metadata rebuild.
          let existing: MemoryEntry | null = null;
          if (text || importance !== undefined || categoryResolution) {
            existing = await context.store.getById(resolvedId, scopeFilter);
          }

          // --- Temporal supersede guard ---
          // For temporal-versioned categories (preferences/entities), changing
          // text must go through supersede to preserve the history chain.
          if (text && newVector && existing) {
            const meta = parseSmartMetadata(existing.metadata, existing);
            if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
                const effectiveMemoryCategory =
                  categoryResolution?.memoryCategory ?? meta.memory_category;
                const effectiveStorageCategory =
                  categoryResolution?.storageCategory ?? existing.category;
                const now = Date.now();
                const factKey =
                  meta.fact_key ?? deriveFactKey(effectiveMemoryCategory, text);

                // Create new superseding record
                const newMeta = buildSmartMetadata(
                  { text, category: effectiveStorageCategory },
                  {
                    l0_abstract: text,
                    l1_overview: meta.l1_overview,
                    l2_content: text,
                    memory_category: effectiveMemoryCategory,
                    tier: meta.tier,
                    access_count: 0,
                    confidence: importance !== undefined ? clamp01(importance, 0.7) : meta.confidence,
                    valid_from: now,
                    fact_key: factKey,
                    supersedes: resolvedId,
                    relations: appendRelation([], {
                      type: "supersedes",
                      targetId: resolvedId,
                    }),
                  },
                );

                const newEntry = await context.store.store({
                  text,
                  vector: newVector,
                  category: effectiveStorageCategory,
                  scope: existing.scope,
                  importance:
                    importance !== undefined
                      ? clamp01(importance, 0.7)
                      : existing.importance,
                  metadata: stringifySmartMetadata(newMeta),
                });

                // Invalidate old record (metadata-only patch — safe)
                try {
                  const invalidatedMeta = buildSmartMetadata(existing, {
                    fact_key: factKey,
                    invalidated_at: now,
                    superseded_by: newEntry.id,
                    relations: appendRelation(meta.relations, {
                      type: "superseded_by",
                      targetId: newEntry.id,
                    }),
                  });
                  await context.store.update(
                    resolvedId,
                    { metadata: stringifySmartMetadata(invalidatedMeta) },
                    scopeFilter,
                  );
                } catch (patchErr) {
                  // New record is already the source of truth; log but don't fail
                  console.warn(
                    `memory-pro: failed to patch superseded record ${resolvedId.slice(0, 8)}: ${patchErr}`,
                  );
                }

                return {
                  content: [
                    {
                      type: "text",
                      text: `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                    },
                  ],
                  details: {
                    action: "superseded",
                    oldId: resolvedId,
                    newId: newEntry.id,
                    category: effectiveMemoryCategory,
                  },
                };
            }
          }
          // --- End temporal supersede guard ---

          const updates: Record<string, any> = {};
          if (text) updates.text = text;
          if (newVector) updates.vector = newVector;
          if (importance !== undefined)
            updates.importance = clamp01(importance, 0.7);
          if (categoryResolution) updates.category = categoryResolution.storageCategory;

          // Rebuild smart metadata when text or importance changes (#544)
          if (text && existing) {
            const meta = parseSmartMetadata(existing.metadata, existing);
            const effectiveCategory =
              categoryResolution?.memoryCategory ?? meta.memory_category;
            const updatedMeta = buildSmartMetadata(existing, {
              l0_abstract: text,
              l1_overview: `- ${text}`,
              l2_content: text,
              memory_category: effectiveCategory,
              fact_key: deriveFactKey(effectiveCategory, text),
              memory_temporal_type: classifyTemporal(text),
              confidence:
                importance !== undefined
                  ? clamp01(importance, 0.7)
                  : meta.confidence,
            });
            // Re-derive valid_until from the new text. Explicit override
            // (not via patch.valid_until) so the absence of a new expiry
            // clears any stale value inherited from the previous text.
            updatedMeta.valid_until = inferExpiry(text);
            updates.metadata = stringifySmartMetadata(updatedMeta);
          } else if ((importance !== undefined || categoryResolution) && existing) {
            // Sync metadata for importance/category-only changes
            const updatedMeta = buildSmartMetadata(existing, {
              ...(importance !== undefined
                ? { confidence: clamp01(importance, 0.7) }
                : {}),
              ...(categoryResolution
                ? { memory_category: categoryResolution.memoryCategory }
                : {}),
            });
            updates.metadata = stringifySmartMetadata(updatedMeta);
          }

          const updated = await context.store.update(
            resolvedId,
            updates,
            scopeFilter,
          );

          if (!updated) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                },
              ],
              details: { error: "not_found", id: resolvedId },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "updated",
              id: updated.id,
              scope: updated.scope,
              category: updated.category,
              importance: updated.importance,
              fieldsUpdated: Object.keys(updates),
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "update_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_update" },
  );
}

// ============================================================================
// Management Tools (Optional)
// ============================================================================

export function registerMemoryStatsTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_stats",
      label: "Memory Statistics",
      description: "Get statistics about memory usage, scopes, and categories. Defaults to the caller's accessible scopes when scope is omitted.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: "Specific scope to get stats for (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const { scope } = params as { scope?: string };

        try {
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const resolvedScopes = resolveReadableToolScopeFilter(context.scopeManager, agentId, scope);
          const { scopeFilter } = resolvedScopes;
          const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);

          const stats = await context.store.stats(scopeFilter);
          const scopeManagerStats = context.scopeManager.getStats();
          const retrievalConfig = context.retriever.getConfig();

          const textLines = [
            `Memory Statistics:`,
            `\u2022 Total memories: ${stats.totalCount}`,
            `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
            `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
            `\u2022 FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
            ``,
            `Memories by scope:`,
            ...Object.entries(stats.scopeCounts).map(
              ([s, count]) => `  \u2022 ${s}: ${count}`,
            ),
            ``,
            `Memories by category:`,
            ...Object.entries(stats.categoryCounts).map(
              ([c, count]) => `  \u2022 ${c}: ${count}`,
            ),
          ];

          // Include retrieval quality metrics if stats collector is available
          const statsCollector = context.retriever.getStatsCollector();
          let retrievalStats = undefined;
          if (statsCollector && statsCollector.count > 0) {
            retrievalStats = statsCollector.getStats();
            textLines.push(
              ``,
              `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`,
              `  \u2022 Zero-result queries: ${retrievalStats.zeroResultQueries}`,
              `  \u2022 Avg latency: ${retrievalStats.avgLatencyMs}ms`,
              `  \u2022 P95 latency: ${retrievalStats.p95LatencyMs}ms`,
              `  \u2022 Avg result count: ${retrievalStats.avgResultCount}`,
              `  \u2022 Rerank used: ${retrievalStats.rerankUsed}`,
              `  \u2022 Noise filtered: ${retrievalStats.noiseFiltered}`,
            );
            if (retrievalStats.topDropStages.length > 0) {
              textLines.push(`  Top drop stages:`);
              for (const ds of retrievalStats.topDropStages) {
                textLines.push(`    \u2022 ${ds.name}: ${ds.totalDropped} dropped`);
              }
            }
          }

          const text = [ignoredScopeNotice, textLines.join("\n")].filter(Boolean).join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              stats,
              scopeManagerStats,
              scopes: scopeFilter,
              ignoredScope: resolvedScopes.ignoredScope,
              accessibleScopes: resolvedScopes.accessibleScopes,
              retrievalConfig: {
                ...retrievalConfig,
                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
              },
              hasFtsSupport: context.store.hasFtsSupport,
              retrievalStats,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "stats_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_stats" },
  );
}

export function registerMemoryDebugTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const staticAgentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId);
      return {
        name: "memory_debug",
        label: "Memory Debug",
        description:
          "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query to debug" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results to return (default: 5, max: 20)" }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Specific memory scope to search in (optional)" }),
          ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope } = params as {
            query: string; limit?: number; scope?: string;
          };
          try {
            const safeLimit = clampInt(limit, 1, 20);
            const agentId = resolveRuntimeAgentId(staticAgentId, runtimeCtx);
            const resolvedScopes = resolveReadableToolScopeFilter(context.scopeManager, agentId, scope);
            const { scopeFilter } = resolvedScopes;
            const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);

            const { results, trace } = await context.retriever.retrieveWithTrace({
              query, limit: safeLimit, scopeFilter, source: "manual",
            });

            const traceLines: string[] = [
              ...(ignoredScopeNotice ? [ignoredScopeNotice, ""] : []),
              `Retrieval Debug Trace:`,
              `  Mode: ${trace.mode}`,
              `  Total: ${trace.totalMs}ms`,
              `  Stages:`,
            ];
            for (const stage of trace.stages) {
              if (stage.kind === "operation") {
                traceLines.push(
                  `    ${stage.name}: completed ${stage.durationMs}ms`,
                );
                continue;
              }
              const dropped = Math.max(0, stage.inputCount - stage.outputCount);
              const scoreStr = stage.scoreRange
                ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
                : "";
              // For search stages (input=0), show "found N" instead of "dropped -N"
              const dropStr = stage.inputCount === 0
                ? `found ${stage.outputCount}`
                : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
              traceLines.push(
                `    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`,
              );
              if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
                traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
              } else if (stage.droppedIds.length > 3) {
                traceLines.push(
                  `      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`,
                );
              }
            }

            if (results.length === 0) {
              traceLines.push(``, `No results survived the pipeline.`);
              return {
                content: [{ type: "text", text: traceLines.join("\n") }],
                details: {
                  count: 0,
                  query,
                  trace,
                  ignoredScope: resolvedScopes.ignoredScope,
                  accessibleScopes: resolvedScopes.accessibleScopes,
                },
              };
            }

            const resultLines = results.map((r, i) => {
              const sources: string[] = [];
              if (r.sources.vector) sources.push("vector");
              if (r.sources.bm25) sources.push("BM25");
              if (r.sources.reranked) sources.push("reranked");
              const categoryTag = getDisplayCategoryTag(r.entry);
              const neighborText = r.neighbors && r.neighbors.length > 0
                ? ` neighbors=${r.neighbors.map((neighbor) => neighbor.entry.id).join(",")}`
                : "";
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""}${neighborText})`;
            });

            const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
            return {
              content: [{ type: "text", text }],
              details: {
                count: results.length,
                memories: sanitizeMemoryForSerialization(results),
                query,
                trace,
                ignoredScope: resolvedScopes.ignoredScope,
                accessibleScopes: resolvedScopes.accessibleScopes,
              },
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Memory debug failed: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: { error: "debug_failed", message: String(error) },
            };
          }
        },
      };
    },
    { name: "memory_debug" },
  );
}

export function registerMemoryListTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_list",
      label: "Memory List",
      description:
        "List recent memories with optional filtering by scope and category. Defaults to the caller's accessible scopes when scope is omitted.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Max memories to list (default: 10, max: 50)",
          }),
        ),
        scope: Type.Optional(
          Type.String({ description: "Filter by specific scope (optional)" }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        offset: Type.Optional(
          Type.Number({
            description: "Number of memories to skip (default: 0)",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
        const {
          limit = 10,
          scope,
          category,
          offset = 0,
        } = params as {
          limit?: number;
          scope?: string;
          category?: string;
          offset?: number;
        };

        try {
          const safeLimit = clampInt(limit, 1, 50);
          const safeOffset = clampInt(offset, 0, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);

          const resolvedScopes = resolveReadableToolScopeFilter(context.scopeManager, agentId, scope);
          const { scopeFilter } = resolvedScopes;
          const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);

          const entries = await context.store.list(
            scopeFilter,
            category,
            safeLimit,
            safeOffset,
          );

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: [ignoredScopeNotice, "No memories found."].filter(Boolean).join("\n") }],
              details: {
                count: 0,
                filters: {
                  scope,
                  scopes: scopeFilter,
                  ignoredScope: resolvedScopes.ignoredScope,
                  accessibleScopes: resolvedScopes.accessibleScopes,
                  category,
                  limit: safeLimit,
                  offset: safeOffset,
                },
              },
            };
          }

          const text = entries
            .map((entry, i) => {
              const date = new Date(entry.timestamp)
                .toISOString()
                .split("T")[0];
              const categoryTag = getDisplayCategoryTag(entry);
              return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: [ignoredScopeNotice, `Recent memories (showing ${entries.length}):\n\n${text}`].filter(Boolean).join("\n"),
              },
            ],
            details: {
              count: entries.length,
              memories: entries.map((e) => ({
                id: e.id,
                text: e.text,
                category: getDisplayCategoryTag(e),
                rawCategory: e.category,
                scope: e.scope,
                importance: e.importance,
                timestamp: e.timestamp,
              })),
              filters: {
                scope,
                scopes: scopeFilter,
                ignoredScope: resolvedScopes.ignoredScope,
                accessibleScopes: resolvedScopes.accessibleScopes,
                category,
                limit: safeLimit,
                offset: safeOffset,
              },
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { error: "list_failed", message: String(error) },
          };
        }
      },
    };
    },
    { name: "memory_list" },
  );
}

export function registerMemoryPromoteTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_promote",
        label: "Memory Promote",
        description:
          "Promote a memory into confirmed/durable governance state so it can participate in conservative auto-recall.",
        parameters: Type.Object({
          memoryId: Type.Optional(
            Type.String({ description: "Memory id (UUID/prefix). Optional when query is provided." }),
          ),
          query: Type.Optional(
            Type.String({ description: "Search query to locate a memory when memoryId is omitted." }),
          ),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          state: Type.Optional(Type.Union([
            Type.Literal("pending"),
            Type.Literal("confirmed"),
            Type.Literal("archived"),
          ])),
          layer: Type.Optional(Type.Union([
            Type.Literal("durable"),
            Type.Literal("working"),
            Type.Literal("reflection"),
            Type.Literal("archive"),
          ])),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const {
            memoryId,
            query,
            scope,
            state = "confirmed",
            layer = "durable",
          } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            state?: "pending" | "confirmed" | "archived";
            layer?: "durable" | "working" | "reflection" | "archive";
          };

          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter,
          );
          if (resolved.ok === false) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const before = await runtimeContext.store.getById(resolved.id, scopeFilter);
          if (!before) {
            return {
              content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
              details: { error: "not_found", id: resolved.id },
            };
          }

          const now = Date.now();
          const updated = await runtimeContext.store.patchMetadata(
            resolved.id,
            {
              source: "manual",
              state,
              memory_layer: layer,
              last_confirmed_use_at: state === "confirmed" ? now : undefined,
              bad_recall_count: 0,
              suppressed_until_turn: 0,
              // Promotion is a manual confirmation — clear active ms-based
              // suppression alongside the legacy turn field (parallel to
              // memory_recall above).
              suppressed_until_ms: 0,
            },
            scopeFilter,
          );
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "promote_failed", id: resolved.id },
            };
          }

          return {
            content: [{
              type: "text",
              text: `Promoted memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${layer}.`,
            }],
            details: {
              action: "promoted",
              id: resolved.id,
              state,
              layer,
            },
          };
        },
      };
    },
    { name: "memory_promote" },
  );
}

export function registerMemoryArchiveTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_archive",
        label: "Memory Archive",
        description:
          "Archive a memory to remove it from default auto-recall while preserving history.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
          query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          reason: Type.Optional(Type.String({ description: "Archive reason for audit trail." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { memoryId, query, scope, reason = "manual_archive" } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            reason?: string;
          };
          if (!memoryId && !query) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const resolved = await resolveMemoryId(
            runtimeContext,
            memoryId ?? query ?? "",
            scopeFilter,
          );
          if (resolved.ok === false) {
            return {
              content: [{ type: "text", text: resolved.message }],
              details: resolved.details ?? { error: "resolve_failed" },
            };
          }

          const patch = {
            state: "archived" as const,
            memory_layer: "archive" as const,
            archive_reason: reason,
            archived_at: Date.now(),
          };
          const updated = await runtimeContext.store.patchMetadata(resolved.id, patch, scopeFilter);
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
              details: { error: "archive_failed", id: resolved.id },
            };
          }

          return {
            content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
            details: { action: "archived", id: resolved.id, reason },
          };
        },
      };
    },
    { name: "memory_archive" },
  );
}

export function registerMemoryReflectionResolveTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_reflection_resolve",
        label: "Memory Reflection Resolve",
        description:
          "Mark a single memory-reflection item resolved so it stops participating in reflection recall.",
        parameters: Type.Object({
          memoryId: Type.Optional(Type.String({ description: "Reflection item id or id prefix." })),
          query: Type.Optional(Type.String({ description: "Search query to preview matching unresolved reflection items." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview only. Defaults to true for query mode and false for memoryId mode." })),
          note: Type.Optional(Type.String({ description: "Optional resolution note for audit trail." })),
          limit: Type.Optional(Type.Number({ description: "Maximum query candidates to preview (default 5, max 20)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const {
            memoryId,
            query,
            scope,
            dryRun,
            note,
            limit = 5,
          } = params as {
            memoryId?: string;
            query?: string;
            scope?: string;
            dryRun?: boolean;
            note?: string;
            limit?: number;
          };

          const trimmedMemoryId = memoryId?.trim();
          const trimmedQuery = query?.trim();
          if (!trimmedMemoryId && !trimmedQuery) {
            return {
              content: [{ type: "text", text: "Provide memoryId or query." }],
              details: { error: "missing_selector" },
            };
          }
          if (trimmedMemoryId && trimmedQuery) {
            return {
              content: [{ type: "text", text: "Provide only one of memoryId or query." }],
              details: { error: "ambiguous_selector" },
            };
          }

          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const shouldDryRun = dryRun ?? Boolean(trimmedQuery);
          const safeLimit = clampInt(limit, 1, 20);
          let candidates: Array<{ entry: MemoryEntry; score?: number }> = [];

          if (trimmedMemoryId) {
            const exactMatch = await runtimeContext.store.getById(trimmedMemoryId, scopeFilter);
            if (exactMatch) {
              const metadata = parseReflectionMetadata(exactMatch.metadata);
              if (metadata.type !== "memory-reflection-item") {
                return {
                  content: [{ type: "text", text: `Memory ${trimmedMemoryId.slice(0, 8)} is not a reflection item.` }],
                  details: { error: "not_reflection_item", memoryId: trimmedMemoryId },
                };
              }
              if (metadata.resolvedAt !== undefined) {
                return {
                  content: [{ type: "text", text: `Reflection item ${trimmedMemoryId.slice(0, 8)} is already resolved.` }],
                  details: { error: "already_resolved", memoryId: trimmedMemoryId, resolvedAt: metadata.resolvedAt },
                };
              }
              candidates = [{ entry: exactMatch }];
            } else {
              const entries = await runtimeContext.store.list(scopeFilter, "reflection", 1000, 0);
              const reflectionItemMatches = entries
                .filter((entry) => entry.id.startsWith(trimmedMemoryId))
                .filter((entry) => parseReflectionMetadata(entry.metadata).type === "memory-reflection-item");
              const matches = reflectionItemMatches
                .filter(isUnresolvedReflectionItem);
              if (matches.length === 0) {
                const alreadyResolved = reflectionItemMatches[0];
                if (alreadyResolved) {
                  return {
                    content: [{ type: "text", text: `Reflection item ${trimmedMemoryId.slice(0, 8)} is already resolved.` }],
                    details: {
                      error: "already_resolved",
                      memoryId: trimmedMemoryId,
                      resolvedAt: parseReflectionMetadata(alreadyResolved.metadata).resolvedAt,
                    },
                  };
                }
                return {
                  content: [{ type: "text", text: `Unresolved reflection item ${trimmedMemoryId.slice(0, 8)} not found.` }],
                  details: { error: "not_found", memoryId: trimmedMemoryId },
                };
              }
              if (matches.length > 1) {
                return {
                  content: [{ type: "text", text: `Reflection item prefix ${trimmedMemoryId} is ambiguous; use a longer id.` }],
                  details: {
                    error: "ambiguous_memory_id",
                    memoryId: trimmedMemoryId,
                    matches: matches.map((entry) => entry.id).slice(0, 20),
                  },
                };
              }
              candidates = [{ entry: matches[0] }];
            }
          } else if (trimmedQuery) {
            const results = await retrieveWithRetry(runtimeContext.retriever, {
              query: trimmedQuery,
              limit: safeLimit,
              scopeFilter,
              category: "reflection",
              source: "cli",
            }, () => runtimeContext.store.count());
            candidates = results
              .filter((result) => isUnresolvedReflectionItem(result.entry))
              .map((result) => ({ entry: result.entry, score: result.score }));
            if (candidates.length === 0) {
              return {
                content: [{ type: "text", text: "No unresolved reflection items matched." }],
                details: { action: "empty", query: trimmedQuery, scopeFilter },
              };
            }
          }

          if (shouldDryRun) {
            return {
              content: [{ type: "text", text: formatReflectionResolvePreview(candidates) }],
              details: {
                action: "preview",
                query: trimmedQuery,
                memoryId: trimmedMemoryId,
                candidates: candidates.map(formatReflectionResolveCandidate),
              },
            };
          }

          if (trimmedQuery && candidates.length !== 1) {
            return {
              content: [{
                type: "text",
                text: `Query matched ${candidates.length} unresolved reflection items. Preview first, then resolve a specific memoryId.`,
              }],
              details: {
                error: "ambiguous_query",
                query: trimmedQuery,
                candidates: candidates.map(formatReflectionResolveCandidate),
              },
            };
          }

          const target = candidates[0]?.entry;
          if (!target) {
            return {
              content: [{ type: "text", text: "No unresolved reflection item selected." }],
              details: { error: "not_found" },
            };
          }

          const patch = {
            resolvedAt: Date.now(),
            resolvedBy: agentId,
            ...(typeof note === "string" && note.trim() ? { resolutionNote: note.trim() } : {}),
          };
          const updated = await runtimeContext.store.patchMetadata(target.id, patch, scopeFilter);
          if (!updated) {
            return {
              content: [{ type: "text", text: `Failed to resolve reflection item ${target.id.slice(0, 8)}.` }],
              details: { error: "resolve_failed", id: target.id },
            };
          }

          return {
            content: [{ type: "text", text: `Resolved reflection item ${target.id.slice(0, 8)}.` }],
            details: {
              action: "resolved",
              id: target.id,
              resolvedBy: agentId,
              note: patch.resolutionNote,
            },
          };
        },
      };
    },
    { name: "memory_reflection_resolve" },
  );
}

export function registerMemoryCompactTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_compact",
        label: "Memory Compact",
        description:
          "Compact duplicate low-value memories by archiving redundant entries and linking them to a canonical memory.",
        parameters: Type.Object({
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only (default true)." })),
          limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200)." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { scope, dryRun = true, limit = 200 } = params as {
            scope?: string;
            dryRun?: boolean;
            limit?: number;
          };

          const safeLimit = clampInt(limit, 20, 1000);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
          if (scope) {
            if (!context.scopeManager.isAccessible(scope, agentId)) {
              return {
                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                details: { error: "scope_access_denied", requestedScope: scope },
              };
            }
            scopeFilter = [scope];
          }

          const entries = await runtimeContext.store.list(scopeFilter, undefined, safeLimit, 0);
          const canonicalByKey = new Map<string, typeof entries[number]>();
          const duplicates: Array<{ duplicateId: string; canonicalId: string; key: string }> = [];

          for (const entry of entries) {
            const meta = parseSmartMetadata(entry.metadata, entry);
            if (meta.state === "archived") continue;
            const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
            const existing = canonicalByKey.get(key);
            if (!existing) {
              canonicalByKey.set(key, entry);
              continue;
            }
            const keep =
              existing.timestamp >= entry.timestamp ? existing : entry;
            const drop =
              keep.id === existing.id ? entry : existing;
            canonicalByKey.set(key, keep);
            duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
          }

          let archivedCount = 0;
          if (!dryRun) {
            for (const item of duplicates) {
              await runtimeContext.store.patchMetadata(
                item.duplicateId,
                {
                  state: "archived",
                  memory_layer: "archive",
                  canonical_id: item.canonicalId,
                  archive_reason: "compact_duplicate",
                  archived_at: Date.now(),
                },
                scopeFilter,
              );
              archivedCount++;
            }
          }

          return {
            content: [{
              type: "text",
              text: dryRun
                ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
                : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
            }],
            details: {
              action: dryRun ? "compact_preview" : "compact_applied",
              scanned: entries.length,
              duplicates: duplicates.length,
              archived: archivedCount,
              sample: duplicates.slice(0, 20),
            },
          };
        },
      };
    },
    { name: "memory_compact" },
  );
}

export function registerMemoryExplainRankTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const runtimeContext = resolveToolContext(context, toolCtx);
      return {
        name: "memory_explain_rank",
        label: "Memory Explain Rank",
        description:
          "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
        parameters: Type.Object({
          query: Type.String({ description: "Query used for ranking analysis." }),
          limit: Type.Optional(Type.Number({ description: "How many items to explain (default 5)." })),
          scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
          const { query, limit = 5, scope } = params as {
            query: string;
            limit?: number;
            scope?: string;
          };

          const safeLimit = clampInt(limit, 1, 20);
          const agentId = resolveRuntimeAgentId(runtimeContext.agentId, runtimeCtx);
          const resolvedScopes = resolveReadableToolScopeFilter(context.scopeManager, agentId, scope);
          const { scopeFilter } = resolvedScopes;
          const ignoredScopeNotice = formatIgnoredScopeNotice(resolvedScopes);

          const results = await retrieveWithRetry(runtimeContext.retriever, {
            query,
            limit: safeLimit,
            scopeFilter,
            source: "manual",
          }, () => runtimeContext.store.count());
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: [ignoredScopeNotice, "No relevant memories found."].filter(Boolean).join("\n") }],
              details: {
                action: "empty",
                query,
                scopeFilter,
                ignoredScope: resolvedScopes.ignoredScope,
                accessibleScopes: resolvedScopes.accessibleScopes,
              },
            };
          }

          const lines = results.map((r, idx) => {
            const meta = parseSmartMetadata(r.entry.metadata, r.entry);
            const sourceBreakdown = [];
            if (r.sources.vector) sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
            if (r.sources.bm25) sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
            if (r.sources.reranked) sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
            if (r.neighbors && r.neighbors.length > 0) sourceBreakdown.push(`neighbors=${r.neighbors.length}`);
            return [
              `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
              `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
              `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilMs=${meta.suppressed_until_ms ?? "—"}`,
              `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
            ].join("\n");
          });

          return {
            content: [{ type: "text", text: [ignoredScopeNotice, lines.join("\n")].filter(Boolean).join("\n") }],
            details: {
              action: "explain_rank",
              query,
              count: results.length,
              ignoredScope: resolvedScopes.ignoredScope,
              accessibleScopes: resolvedScopes.accessibleScopes,
              results: sanitizeMemoryForSerialization(results),
            },
          };
        },
      };
    },
    { name: "memory_explain_rank" },
  );
}

// ============================================================================
// Tool Registration Helper
// ============================================================================

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    enableManagementTools?: boolean;
    enableSelfImprovementTools?: boolean;
  } = {},
) {
  // Core tools (always enabled)
  registerMemoryRecallTool(api, context);
  registerMemoryRecallAliasTool(api, context, "memory_search");
  registerMemoryRecallAliasTool(api, context, "memory_get");
  registerMemoryFactQueryTool(api, context);
  registerMemoryStoreTool(api, context);
  registerMemoryForgetTool(api, context);
  registerMemoryUpdateTool(api, context);

  // Management tools (optional)
  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryDebugTool(api, context);
    registerMemoryListTool(api, context);
    registerMemoryPromoteTool(api, context);
    registerMemoryArchiveTool(api, context);
    registerMemoryReflectionResolveTool(api, context);
    registerMemoryCompactTool(api, context);
    registerMemoryExplainRankTool(api, context);
  }
  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    if (options.enableManagementTools) {
      registerSelfImprovementExtractSkillTool(api, context);
      registerSelfImprovementReviewTool(api, context);
    }
  }
}
