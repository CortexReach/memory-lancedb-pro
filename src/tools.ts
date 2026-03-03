/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import { isNoise } from "./noise-filter.js";
import type { MemoryScopeManager } from "./scopes.js";
import type { Embedder } from "./embedder.js";

// ============================================================================
// Types
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
] as const;

interface ToolContext {
  retriever: MemoryRetriever;
  store: MemoryStore;
  scopeManager: MemoryScopeManager;
  embedder: Embedder;
  agentId?: string;
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

function sanitizeMemoryForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    score: r.score,
    sources: r.sources,
  }));
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

              return `${i + 1}. [${r.entry.id}] [${r.entry.category}:${r.entry.scope}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
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
          const existing = await context.store.vectorSearch(vector, 1, 0.1, [
            targetScope,
          ]);

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
              return `${safeOffset + i + 1}. [${entry.id}] [${entry.category}:${entry.scope}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
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
                category: e.category,
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
  } = {},
) {
  // Core tools (always enabled)
  registerMemoryRecallTool(api, context);
  registerMemoryStoreTool(api, context);
  registerMemoryForgetTool(api, context);
  registerMemoryUpdateTool(api, context);

  // Management tools (optional)
  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryListTool(api, context);
  }
}
