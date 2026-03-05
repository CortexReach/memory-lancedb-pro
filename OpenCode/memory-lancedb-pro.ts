import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";

import { createEmbedder, getVectorDimensions } from "../src/embedder.js";
import { isNoise } from "../src/noise-filter.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  createRetriever,
  type RetrievalConfig,
} from "../src/retriever.js";
import { createScopeManager, type ScopeConfig } from "../src/scopes.js";
import { MemoryStore, validateStoragePath, type MemoryEntry } from "../src/store.js";

const SERVICE_NAME = "memory-lancedb-pro-opencode";
const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;

type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

interface PluginConfig {
  embedding: {
    apiKey: string | string[];
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath: string;
  retrieval: Partial<RetrievalConfig>;
  scopes?: Partial<ScopeConfig>;
  enableManagementTools: boolean;
}

interface Runtime {
  config: PluginConfig;
  store: MemoryStore;
  retriever: ReturnType<typeof createRetriever>;
  scopeManager: ReturnType<typeof createScopeManager>;
  embedder: ReturnType<typeof createEmbedder>;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function formatPreview(text: string, max = 100): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envName) => {
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(`Environment variable ${envName} is not set`);
    }
    return envValue;
  });
}

function resolveDeepEnv<T>(value: T): T {
  if (typeof value === "string") {
    return resolveEnvVars(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeepEnv(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeepEnv(v);
    }
    return out as T;
  }
  return value;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolvePathFromWorktree(worktree: string, pathValue: string): string {
  const expanded = expandHomePath(pathValue);
  if (isAbsolute(expanded)) return expanded;
  return resolve(worktree, expanded);
}

function looksLikeMemoryId(value: string): boolean {
  const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const shortPrefix = /^[0-9a-f]{8,}$/i;
  return fullUuid.test(value) || shortPrefix.test(value);
}

async function loadRawConfig(worktree: string): Promise<Record<string, unknown>> {
  const explicitPath = process.env.OPENCODE_MEMORY_LANCEDB_PRO_CONFIG?.trim();
  const configPath = explicitPath
    ? resolvePathFromWorktree(worktree, explicitPath)
    : join(worktree, "OpenCode", "config.json");

  try {
    await access(configPath);
  } catch (error) {
    if (!explicitPath) {
      return {};
    }
    throw new Error(`Config file not found: ${configPath} (${String(error)})`);
  }

  const rawText = await readFile(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${String(error)}`);
  }

  const record = toRecord(parsed);
  if (!record) {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }

  return resolveDeepEnv(record);
}

function parsePluginConfig(rawConfig: Record<string, unknown>, worktree: string): PluginConfig {
  const embedding = toRecord(rawConfig.embedding) ?? {};

  let apiKey: string | string[] | undefined;
  if (typeof embedding.apiKey === "string") {
    apiKey = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey)) {
    const keys = embedding.apiKey
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (keys.length > 0) {
      apiKey = keys;
    }
  }

  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  }

  if (!apiKey) {
    apiKey = "ollama";
  }

  if (typeof apiKey === "string") {
    apiKey = apiKey.trim();
  }

  if (typeof apiKey === "string" && apiKey.length === 0) {
    apiKey = "ollama";
  }

  if (Array.isArray(apiKey) && apiKey.length === 0) {
    apiKey = "ollama";
  }

  const model =
    typeof embedding.model === "string" && embedding.model.trim().length > 0
      ? embedding.model
      : "nomic-embed-text";

  const baseURL =
    typeof embedding.baseURL === "string" && embedding.baseURL.trim().length > 0
      ? embedding.baseURL
      : "http://localhost:11434/v1";

  const dbPathRaw =
    typeof rawConfig.dbPath === "string" && rawConfig.dbPath.trim().length > 0
      ? rawConfig.dbPath
      : "~/.opencode/memory/lancedb-pro";

  const dbPath = resolvePathFromWorktree(worktree, dbPathRaw);
  const retrieval = (toRecord(rawConfig.retrieval) ?? {}) as Partial<RetrievalConfig>;
  const scopes = toRecord(rawConfig.scopes) as Partial<ScopeConfig> | undefined;

  const enableManagementTools =
    typeof rawConfig.enableManagementTools === "boolean"
      ? rawConfig.enableManagementTools
      : true;

  return {
    embedding: {
      apiKey,
      model,
      baseURL,
      dimensions:
        typeof embedding.dimensions === "number" && embedding.dimensions > 0
          ? Math.floor(embedding.dimensions)
          : undefined,
      taskQuery:
        typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
      taskPassage:
        typeof embedding.taskPassage === "string"
          ? embedding.taskPassage
          : undefined,
      normalized:
        typeof embedding.normalized === "boolean"
          ? embedding.normalized
          : undefined,
      chunking:
        typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
    },
    dbPath,
    retrieval,
    scopes,
    enableManagementTools,
  };
}

async function appLog(
  ctx: PluginInput,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    });
  } catch {
    // keep tools usable even if app logging is unavailable
  }
}

async function buildRuntime(ctx: PluginInput): Promise<Runtime> {
  const rawConfig = await loadRawConfig(ctx.worktree);
  const config = parsePluginConfig(rawConfig, ctx.worktree);

  validateStoragePath(config.dbPath);

  const vectorDim = getVectorDimensions(
    config.embedding.model,
    config.embedding.dimensions,
  );

  const store = new MemoryStore({ dbPath: config.dbPath, vectorDim });

  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
  });

  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...config.retrieval,
  });

  const scopeManager = createScopeManager(config.scopes);

  await appLog(ctx, "info", "plugin runtime initialized", {
    dbPath: config.dbPath,
    embeddingModel: config.embedding.model,
    retrievalMode: retriever.getConfig().mode,
  });

  return {
    config,
    store,
    retriever,
    scopeManager,
    embedder,
  };
}

function ensureCategory(value?: string): MemoryCategory | undefined {
  if (!value) return undefined;
  if (MEMORY_CATEGORIES.includes(value as MemoryCategory)) {
    return value as MemoryCategory;
  }
  return undefined;
}

function resolveScopeFilter(
  runtime: Runtime,
  agentId: string,
  requestedScope?: string,
): { scopeFilter?: string[]; error?: string } {
  const scopeManager = runtime.scopeManager;
  if (requestedScope) {
    if (!scopeManager.isAccessible(requestedScope, agentId)) {
      return { error: `Access denied to scope: ${requestedScope}` };
    }
    return { scopeFilter: [requestedScope] };
  }
  return { scopeFilter: scopeManager.getAccessibleScopes(agentId) };
}

function requireManagement(runtime: Runtime): string | null {
  if (runtime.config.enableManagementTools) {
    return null;
  }
  return "Management tools are disabled. Set enableManagementTools=true in OpenCode/config.json.";
}

export const MemoryLanceDBProPlugin: Plugin = async (ctx) => {
  let runtimePromise: Promise<Runtime> | null = null;

  const getRuntime = async (): Promise<Runtime> => {
    if (!runtimePromise) {
      runtimePromise = buildRuntime(ctx).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  };

  return {
    tool: {
      memory_recall: tool({
        description:
          "Search long-term memories using hybrid retrieval (vector + BM25).",
        args: {
          query: tool.schema.string().min(1).describe("Search query"),
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results (default 5)"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Optional category filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const results = await runtime.retriever.retrieve({
            query: args.query,
            limit: args.limit ?? 5,
            scopeFilter,
            category: ensureCategory(args.category),
            source: "manual",
          });

          if (results.length === 0) {
            return "No relevant memories found.";
          }

          const lines = results.map((item, index) => {
            const sourceTags: string[] = [];
            if (item.sources.vector) sourceTags.push("vector");
            if (item.sources.bm25) sourceTags.push("bm25");
            if (item.sources.reranked) sourceTags.push("reranked");
            const sourceText = sourceTags.length > 0 ? `, ${sourceTags.join("+")}` : "";
            return `${index + 1}. [${item.entry.id}] [${item.entry.category}:${item.entry.scope}] ${formatPreview(item.entry.text, 140)} (${(item.score * 100).toFixed(0)}%${sourceText})`;
          });

          return `Found ${results.length} memories:\n${lines.join("\n")}`;
        },
      }),

      memory_store: tool({
        description: "Store a new long-term memory entry.",
        args: {
          text: tool.schema.string().min(1).describe("Memory text"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Importance score 0-1"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Memory category"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Target scope (optional)"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";

          const targetScope =
            args.scope || runtime.scopeManager.getDefaultScope(agentId);
          if (!runtime.scopeManager.isAccessible(targetScope, agentId)) {
            return `Access denied to scope: ${targetScope}`;
          }

          if (isNoise(args.text)) {
            return "Skipped: text detected as noise (greetings/meta/boilerplate).";
          }

          const category = ensureCategory(args.category) || "other";
          const importance = clamp01(args.importance ?? 0.7, 0.7);

          const vector = await runtime.embedder.embedPassage(args.text);
          const existing = await runtime.store.vectorSearch(vector, 1, 0.1, [
            targetScope,
          ]);

          if (existing.length > 0 && existing[0].score > 0.98) {
            return `Similar memory already exists: [${existing[0].entry.id}] ${formatPreview(existing[0].entry.text)}`;
          }

          const entry = await runtime.store.store({
            text: args.text,
            vector,
            importance,
            category,
            scope: targetScope,
          });

          return `Stored memory [${entry.id}] in scope '${entry.scope}' as ${entry.category}.`;
        },
      }),

      memory_forget: tool({
        description: "Delete memory by id, or find-and-delete by query.",
        args: {
          memoryId: tool.schema
            .string()
            .optional()
            .describe("Memory ID (full UUID or 8+ prefix)"),
          query: tool.schema
            .string()
            .optional()
            .describe("Query used to find memory candidates"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          if (args.memoryId) {
            const deleted = await runtime.store.delete(args.memoryId, scopeFilter);
            if (!deleted) {
              return `Memory ${args.memoryId} not found (or inaccessible).`;
            }
            return `Memory ${args.memoryId} deleted.`;
          }

          if (!args.query) {
            return "Provide either memoryId or query.";
          }

          const results = await runtime.retriever.retrieve({
            query: args.query,
            limit: 5,
            scopeFilter,
            source: "manual",
          });

          if (results.length === 0) {
            return "No matching memories found.";
          }

          if (results.length === 1 && results[0].score > 0.9) {
            await runtime.store.delete(results[0].entry.id, scopeFilter);
            return `Deleted matched memory [${results[0].entry.id}].`;
          }

          const candidates = results
            .map(
              (item) =>
                `- [${item.entry.id.slice(0, 8)}] ${formatPreview(item.entry.text, 120)} (${(item.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          return `Found ${results.length} candidates. Re-run with memoryId:\n${candidates}`;
        },
      }),

      memory_update: tool({
        description:
          "Update an existing memory entry (text/importance/category) while keeping its original timestamp.",
        args: {
          memoryId: tool.schema
            .string()
            .min(1)
            .describe("Memory ID or search text"),
          text: tool.schema
            .string()
            .optional()
            .describe("New memory text"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("New importance score"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("New category"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const agentId = toolCtx.agent || "main";
          const scopeFilter = runtime.scopeManager.getAccessibleScopes(agentId);

          if (
            args.text === undefined &&
            args.importance === undefined &&
            args.category === undefined
          ) {
            return "Nothing to update. Provide text, importance, or category.";
          }

          let resolvedId = args.memoryId;
          if (!looksLikeMemoryId(args.memoryId)) {
            const candidates = await runtime.retriever.retrieve({
              query: args.memoryId,
              limit: 3,
              scopeFilter,
              source: "manual",
            });

            if (candidates.length === 0) {
              return `No memory found for '${args.memoryId}'.`;
            }

            if (candidates.length === 1 || candidates[0].score > 0.85) {
              resolvedId = candidates[0].entry.id;
            } else {
              const lines = candidates
                .map(
                  (item) =>
                    `- [${item.entry.id.slice(0, 8)}] ${formatPreview(item.entry.text, 110)} (${(item.score * 100).toFixed(0)}%)`,
                )
                .join("\n");
              return `Multiple matches found. Use memoryId:\n${lines}`;
            }
          }

          if (args.text && isNoise(args.text)) {
            return "Skipped: updated text detected as noise.";
          }

          const updates: {
            text?: string;
            vector?: number[];
            importance?: number;
            category?: MemoryEntry["category"];
          } = {};

          if (args.text) {
            updates.text = args.text;
            updates.vector = await runtime.embedder.embedPassage(args.text);
          }
          if (args.importance !== undefined) {
            updates.importance = clamp01(args.importance, 0.7);
          }
          if (args.category) {
            updates.category = args.category;
          }

          const updated = await runtime.store.update(resolvedId, updates, scopeFilter);
          if (!updated) {
            return `Memory ${resolvedId} not found (or inaccessible).`;
          }

          return `Updated memory [${updated.id}] (${updated.category}, importance=${updated.importance.toFixed(2)}).`;
        },
      }),

      memory_list: tool({
        description: "List memory entries with optional filters.",
        args: {
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Page size, default 10"),
          offset: tool.schema
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe("Offset, default 0"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Optional category filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const managementError = requireManagement(runtime);
          if (managementError) return managementError;

          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const limit = clampInt(args.limit ?? 10, 1, 50);
          const offset = clampInt(args.offset ?? 0, 0, 1000);
          const entries = await runtime.store.list(
            scopeFilter,
            ensureCategory(args.category),
            limit,
            offset,
          );

          if (entries.length === 0) {
            return "No memories found.";
          }

          const lines = entries.map((entry, index) => {
            const date = new Date(entry.timestamp).toISOString().slice(0, 10);
            return `${offset + index + 1}. [${entry.id}] [${entry.category}:${entry.scope}] ${formatPreview(entry.text, 120)} (${date})`;
          });

          return `Listed ${entries.length} memories:\n${lines.join("\n")}`;
        },
      }),

      memory_stats: tool({
        description: "Show memory statistics across scopes and categories.",
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Optional scope filter"),
        },
        async execute(args, toolCtx) {
          const runtime = await getRuntime();
          const managementError = requireManagement(runtime);
          if (managementError) return managementError;

          const agentId = toolCtx.agent || "main";
          const { scopeFilter, error } = resolveScopeFilter(
            runtime,
            agentId,
            args.scope,
          );
          if (error || !scopeFilter) return error || "Invalid scope";

          const stats = await runtime.store.stats(scopeFilter);
          const retrievalCfg = runtime.retriever.getConfig();

          const scopeLines = Object.entries(stats.scopeCounts)
            .map(([scope, count]) => `- ${scope}: ${count}`)
            .join("\n");
          const categoryLines = Object.entries(stats.categoryCounts)
            .map(([category, count]) => `- ${category}: ${count}`)
            .join("\n");

          return [
            "Memory statistics:",
            `- total: ${stats.totalCount}`,
            `- retrieval mode: ${retrievalCfg.mode}`,
            `- FTS enabled: ${runtime.store.hasFtsSupport ? "yes" : "no"}`,
            "",
            "By scope:",
            scopeLines || "- (none)",
            "",
            "By category:",
            categoryLines || "- (none)",
          ].join("\n");
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await appLog(ctx, "info", "plugin loaded", {
          directory: ctx.directory,
          worktree: ctx.worktree,
        });
      }
    },
  };
};

export default MemoryLanceDBProPlugin;
