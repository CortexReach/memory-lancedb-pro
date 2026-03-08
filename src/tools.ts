/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { isNoise } from "./noise-filter.js";
import type { MemoryScopeManager } from "./scopes.js";
import type { Embedder } from "./embedder.js";
import type { GraphitiBridge } from "./graphiti/bridge.js";
import type { GraphitiPluginConfig } from "./graphiti/types.js";
import { registerMemoryGraphRecallTool } from "./tools-graphiti.js";
import { ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export type MdMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: Embedder;
  workspaceDir?: string;
  graphitiBridge?: GraphitiBridge;
  graphitiConfig?: GraphitiPluginConfig;
  logger?: {
    warn?: (message: string) => void;
  };
  agentId?: string;
  workspaceDir?: string;
  mdMirror?: MdMirrorWriter | null;
}

function resolveAgentId(runtimeAgentId: unknown, fallback?: string): string | undefined {
  if (typeof runtimeAgentId === "string" && runtimeAgentId.trim().length > 0) return runtimeAgentId;
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback;
  return undefined;
}

interface RuntimeToolContext {
  agentId?: string;
  workspaceDir?: string;
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

function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: getDisplayCategoryTag(r.entry),
    rawCategory: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
}

function resolveToolContext(baseContext: ToolContext, runtimeContext: RuntimeToolContext): ToolContext {
  return {
    ...baseContext,
    agentId: runtimeContext.agentId,
    workspaceDir: runtimeContext.workspaceDir ?? baseContext.workspaceDir,
  };
}

function resolveWorkspaceDir(toolCtx: RuntimeToolContext, fallback?: string): string {
  const runtimePath = typeof toolCtx.workspaceDir === "string" ? toolCtx.workspaceDir.trim() : "";
  if (runtimePath) return runtimePath;
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback.trim();
  return join(homedir(), ".openclaw", "workspace");
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const fileWriteQueues = new Map<string, Promise<void>>();

async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  fileWriteQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  }
}

async function nextLearningId(filePath: string, prefix: "LRN" | "ERR" | "FEAT"): Promise<string> {
  const date = todayYmd();
  let count = 0;
  try {
    const content = await readFile(filePath, "utf-8");
    const matches = content.match(new RegExp(`\\[${prefix}-${date}-\\d{3}\\]`, "g"));
    count = matches?.length ?? 0;
  } catch {
    // ignore
  }
  return `${prefix}-${date}-${String(count + 1).padStart(3, "0")}`;
}
// ============================================================================
// Core Tools (Backward Compatible)
// ============================================================================

export function registerMemoryRecallTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query for finding relevant memories",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Max results to return (default: 5, max: 20)",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Specific memory scope to search in (optional)",
          }),
        ),
        category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
      }),
      async execute(_toolCallId, params) {
        const {
          query,
          limit = 5,
          scope,
          category,
        } = params as {
          query: string;
          limit?: number;
          scope?: string;
          category?: string;
        };

        try {
          const safeLimit = clampInt(limit, 1, 20);

          // Determine accessible scopes
          let scopeFilter = context.scopeManager.getAccessibleScopes(agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
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

          const results = await context.retriever.retrieve({
            query,
            limit: safeLimit,
            scopeFilter,
            category,
            source: "manual",
          });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, query, scopes: scopeFilter },
            };
          }

          const text = results
            .map((r, i) => {
              const sources = [];
              if (r.sources.vector) sources.push("vector");
              if (r.sources.bm25) sources.push("BM25");
              if (r.sources.reranked) sources.push("reranked");

              const categoryTag = getDisplayCategoryTag(r.entry);
              return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: {
              count: results.length,
              memories: sanitizeMemoryForSerialization(results),
              query,
              scopes: scopeFilter,
              retrievalMode: context.retriever.getConfig().mode,
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
    },
    { name: "memory_recall" },
  );
}

export function registerMemoryStoreTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
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
      }),
      async execute(_toolCallId, params) {
        const {
          text,
          importance = 0.7,
          category = "other",
          scope,
        } = params as {
          text: string;
          importance?: number;
          category?: string;
          scope?: string;
        };

        try {
          // Determine target scope
          let targetScope = scope || context.scopeManager.getDefaultScope(agentId);

          // Validate scope access
          if (!context.scopeManager.isAccessible(targetScope, agentId)) {
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

          const safeImportance = clamp01(importance, 0.7);
          const vector = await context.embedder.embedPassage(text);

          // Check for duplicates using raw vector similarity (bypasses importance/recency weighting)
          // Fail-open by design: dedup must never block a legitimate memory write.
          let existing: Awaited<ReturnType<typeof context.store.vectorSearch>> = [];
          try {
            existing = await context.store.vectorSearch(vector, 1, 0.1, [
              targetScope,
            ]);
          } catch (err) {
            console.warn(
              `memory-lancedb-pro: duplicate pre-check failed, continue store: ${String(err)}`,
            );
          }

          if (existing.length > 0 && existing[0].score > 0.98) {
            return {
              content: [
                {
                  type: "text",
                  text: `Similar memory already exists: "${existing[0].entry.text}"`,
                },
              ],
              details: {
                action: "duplicate",
                existingId: existing[0].entry.id,
                existingText: existing[0].entry.text,
                existingScope: existing[0].entry.scope,
                similarity: existing[0].score,
              },
            };
          }

          const entry = await context.store.store({
            text,
            vector,
            importance: safeImportance,
            category: category as any,
            scope: targetScope,
          });

          let graphitiDetails:
            | {
                status: "stored" | "failed" | "skipped";
                groupId: string;
                episodeRef?: string;
                error?: string;
              }
            | undefined;

          if (
            context.graphitiBridge &&
            context.graphitiConfig?.enabled &&
            context.graphitiConfig.write.memoryStore
          ) {
            graphitiDetails = await context.graphitiBridge.addEpisode({
              text,
              scope: targetScope,
              metadata: {
                source: "memory_store",
                memoryId: entry.id,
                category: entry.category,
                scope: entry.scope,
              },
            });

            if (graphitiDetails.status !== "skipped") {
              try {
                const currentMetadata = safeParseJson(entry.metadata);
                const nextMetadata = {
                  ...currentMetadata,
                  graphiti: {
                    groupId: graphitiDetails.groupId,
                    episodeRef: graphitiDetails.episodeRef,
                    status: graphitiDetails.status,
                    error: graphitiDetails.error,
                    updatedAt: new Date().toISOString(),
                  },
                };
                const metadata = JSON.stringify(nextMetadata);
                await context.store.update(entry.id, { metadata }, [targetScope]);
                entry.metadata = metadata;
              } catch (err) {
                context.logger?.warn?.(`memory-lancedb-pro: graphiti metadata update failed: ${String(err)}`);
              }
            }
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
              category: entry.category,
              importance: entry.importance,
              graphiti: graphitiDetails,
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
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
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
      async execute(_toolCallId, params) {
        const { query, memoryId, scope } = params as {
          query?: string;
          memoryId?: string;
          scope?: string;
        };

        try {
          // Determine accessible scopes
          let scopeFilter = context.scopeManager.getAccessibleScopes(agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
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
            const deleted = await context.store.delete(memoryId, scopeFilter);
            if (deleted) {
              return {
                content: [
                  { type: "text", text: `Memory ${memoryId} forgotten.` },
                ],
                details: { action: "deleted", id: memoryId },
              };
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} not found or access denied.`,
                  },
                ],
                details: { error: "not_found", id: memoryId },
              };
            }
          }

          if (query) {
            const results = await context.retriever.retrieve({
              query,
              limit: 5,
              scopeFilter,
            });

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
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_update",
      label: "Memory Update",
      description:
        "Update an existing memory in-place. Preserves original timestamp. Use when correcting outdated info or adjusting importance/category without losing creation date.",
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
      async execute(_toolCallId, params) {
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

          // Determine accessible scopes
          const scopeFilter = context.scopeManager.getAccessibleScopes(agentId);

          // Resolve memoryId: if it doesn't look like a UUID, try search
          let resolvedId = memoryId;
          const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
          if (!uuidLike) {
            // Treat as search query
            const results = await context.retriever.retrieve({
              query: memoryId,
              limit: 3,
              scopeFilter,
            });
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No memory found matching "${memoryId}".`,
                  },
                ],
                details: { error: "not_found", query: memoryId },
              };
            }
            if (results.length === 1 || results[0].score > 0.85) {
              resolvedId = results[0].entry.id;
            } else {
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
                    text: `Multiple matches. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizeMemoryForSerialization(results),
                },
              };
            }
          }

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

          const updates: Record<string, any> = {};
          if (text) updates.text = text;
          if (newVector) updates.vector = newVector;
          if (importance !== undefined)
            updates.importance = clamp01(importance, 0.7);
          if (category) updates.category = category;

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
// Self-Improvement Tools (Compatibility)
// ============================================================================

export function registerSelfImprovementLogTool(api: OpenClawPluginApi, baseContext: ToolContext) {
  api.registerTool(
    (runtimeContext) => {
      const context = resolveToolContext(baseContext, runtimeContext);
      return {
        name: "self_improvement_log",
        label: "Self-Improvement Log",
        description: "Log structured learning/error/feature-request entries into .learnings files.",
        parameters: Type.Object({
          type: stringEnum(["learning", "error", "feature"]),
          summary: Type.String({ description: "One-line summary" }),
          details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
          suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
          category: Type.Optional(Type.String({ description: "Learning category when type=learning" })),
          area: Type.Optional(Type.String({ description: "Area tag (tests/docs/config/etc.)" })),
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
            type: "learning" | "error" | "feature";
            summary: string;
            details?: string;
            suggestedAction?: string;
            category?: string;
            area?: string;
            priority?: string;
          };

          try {
            const workspaceDir = resolveWorkspaceDir(runtimeContext, context.workspaceDir);
            await ensureSelfImprovementLearningFiles(workspaceDir);
            const learningsDir = join(workspaceDir, ".learnings");
            const fileName = type === "learning" ? "LEARNINGS.md" : type === "error" ? "ERRORS.md" : "FEATURE_REQUESTS.md";
            const filePath = join(learningsDir, fileName);
            const idPrefix = type === "learning" ? "LRN" : type === "error" ? "ERR" : "FEAT";
            const entryId = await withFileWriteQueue(filePath, async () => {
              const id = await nextLearningId(filePath, idPrefix);
              const nowIso = new Date().toISOString();
              const titleSuffix = type === "learning" ? ` ${category}` : "";
              const entry = [
                `## [${id}]${titleSuffix}`,
                "",
                `**Logged**: ${nowIso}`,
                `**Priority**: ${priority}`,
                `**Status**: pending`,
                `**Area**: ${area}`,
                "",
                "### Summary",
                summary.trim(),
                "",
                "### Details",
                details.trim() || "-",
                "",
                "### Suggested Action",
                suggestedAction.trim() || "-",
                "",
                "### Metadata",
                "- Source: memory-lancedb-pro/self_improvement_log",
                "---",
                "",
              ].join("\n");
              const prev = await readFile(filePath, "utf-8").catch(() => "");
              const separator = prev.trimEnd().length > 0 ? "\n\n" : "";
              await appendFile(filePath, `${separator}${entry}`, "utf-8");
              return id;
            });

            return {
              content: [{ type: "text", text: `Logged ${type} entry ${entryId} to .learnings/${fileName}` }],
              details: { action: "logged", type, id: entryId, filePath },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
              details: { error: "self_improvement_log_failed", message: String(error) },
            };
          }
        },
      };
    },
    { name: "self_improvement_log" }
  );
}

export function registerSelfImprovementExtractSkillTool(api: OpenClawPluginApi, baseContext: ToolContext) {
  api.registerTool(
    (runtimeContext) => {
      const context = resolveToolContext(baseContext, runtimeContext);
      return {
        name: "self_improvement_extract_skill",
        label: "Extract Skill From Learning",
        description: "Create a skill scaffold from a learning entry and mark the source as promoted.",
        parameters: Type.Object({
          learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001" }),
          skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
          sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"])),
          outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
        }),
        async execute(_toolCallId, params) {
          const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params as {
            learningId: string;
            skillName: string;
            sourceFile?: "LEARNINGS.md" | "ERRORS.md" | "FEATURE_REQUESTS.md";
            outputDir?: string;
          };

          try {
            if (!/^(LRN|ERR|FEAT)-\d{8}-\d{3}$/.test(learningId)) {
              return {
                content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-... / FEAT-..." }],
                details: { error: "invalid_learning_id" },
              };
            }
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
              return {
                content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
                details: { error: "invalid_skill_name" },
              };
            }

            const workspaceDir = resolveWorkspaceDir(runtimeContext, context.workspaceDir);
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

            const promotedMarker = "**Status**: promoted_to_skill";
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
      };
    },
    { name: "self_improvement_extract_skill" }
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
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_stats",
      label: "Memory Statistics",
      description: "Get statistics about memory usage, scopes, and categories.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description: "Specific scope to get stats for (optional)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { scope } = params as { scope?: string };

        try {
          // Determine accessible scopes
          let scopeFilter = context.scopeManager.getAccessibleScopes(agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
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

          const stats = await context.store.stats(scopeFilter);
          const scopeManagerStats = context.scopeManager.getStats();
          const retrievalConfig = context.retriever.getConfig();

          const text = [
            `Memory Statistics:`,
            `• Total memories: ${stats.totalCount}`,
            `• Available scopes: ${scopeManagerStats.totalScopes}`,
            `• Retrieval mode: ${retrievalConfig.mode}`,
            `• FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
            ``,
            `Memories by scope:`,
            ...Object.entries(stats.scopeCounts).map(
              ([s, count]) => `  • ${s}: ${count}`,
            ),
            ``,
            `Memories by category:`,
            ...Object.entries(stats.categoryCounts).map(
              ([c, count]) => `  • ${c}: ${count}`,
            ),
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              stats,
              scopeManagerStats,
              retrievalConfig: {
                ...retrievalConfig,
                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
              },
              hasFtsSupport: context.store.hasFtsSupport,
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

export function registerMemoryListTool(
  api: OpenClawPluginApi,
  context: ToolContext,
) {
  api.registerTool(
    (toolCtx) => {
      const agentId = resolveAgentId((toolCtx as any)?.agentId, context.agentId) ?? "main";
      return {
        name: "memory_list",
      label: "Memory List",
      description:
        "List recent memories with optional filtering by scope and category.",
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
      async execute(_toolCallId, params) {
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

          // Determine accessible scopes
          let scopeFilter = context.scopeManager.getAccessibleScopes(agentId);
          if (scope) {
            if (context.scopeManager.isAccessible(scope, agentId)) {
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

          const entries = await context.store.list(
            scopeFilter,
            category,
            safeLimit,
            safeOffset,
          );

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: {
                count: 0,
                filters: {
                  scope,
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
                text: `Recent memories (showing ${entries.length}):\n\n${text}`,
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

// ============================================================================
// Tool Registration Helper
// ============================================================================

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    enableManagementTools?: boolean;
    enableGraphRecallTool?: boolean;
  } = {},
) {
  // Core tools (always enabled)
  registerMemoryRecallTool(api, context);
  registerMemoryStoreTool(api, context);
  registerMemoryForgetTool(api, context);
  registerMemoryUpdateTool(api, context);
  if (options.enableGraphRecallTool) {
    registerMemoryGraphRecallTool(api, context);
  }

  // Management tools (optional)
  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryListTool(api, context);
    registerSelfImprovementLogTool(api, context);
    registerSelfImprovementExtractSkillTool(api, context);
  }
  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    if (options.enableManagementTools) {
      registerSelfImprovementExtractSkillTool(api, context);
      registerSelfImprovementReviewTool(api, context);
    }
  }
}
function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
