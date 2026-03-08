/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadLanceDB, type MemoryEntry, type MemoryStore } from "./src/store.js";
import type { MemoryRetriever } from "./src/retriever.js";
import type { MemoryScopeManager } from "./src/scopes.js";
import type { MemoryMigrator } from "./src/migrate.js";
import { createWorkspaceDocsMaterializer } from "./src/workspace-docs.js";
import { applyPromotionPolicy } from "./src/promotion-policy.js";
import type { GraphitiBridge } from "./src/graphiti/bridge.js";
import type { GraphitiSyncService } from "./src/graphiti/sync.js";
import type { GraphitiPluginConfig } from "./src/graphiti/types.js";

// ============================================================================
// Types
// ============================================================================

interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  migrator: MemoryMigrator;
  embedder?: import("./src/embedder.js").Embedder;
  graphitiBridge?: GraphitiBridge;
  graphitiSync?: GraphitiSyncService;
  graphitiConfig?: GraphitiPluginConfig;
  graphInferenceRun?: (options: {
    reason: string;
    dryRun?: boolean;
    includeScopes?: string[];
    excludeScopes?: string[];
    forceRun?: boolean;
  }) => Promise<{
    reason: string;
    dryRun: boolean;
    scopesScanned: number;
    scopeFilterApplied: string[];
    candidates: number;
    stored: number;
    skippedDuplicate: number;
  }>;
}

// ============================================================================
// Utility Functions
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = String(memory.text || "");
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}

function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
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

function parseScopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0))];
  }
  if (typeof value === "string") {
    return [...new Set(value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0))];
  }
  return [];
}

function normalizeTarget(value: unknown): "USER" | "AGENTS" | "IDENTITY" | "SOUL" | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === "USER" || upper === "AGENTS" || upper === "IDENTITY" || upper === "SOUL") {
    return upper;
  }
  return undefined;
}

function detectPromotionTarget(entry: MemoryEntry): "USER" | "AGENTS" | "IDENTITY" | "SOUL" | undefined {
  const policy = applyPromotionPolicy([entry]);
  for (const [target, rows] of Object.entries(policy.promotedByTarget)) {
    if (rows.some((row) => row.id === entry.id)) {
      return normalizeTarget(target);
    }
  }
  const queued = policy.queue.find((row) => row.entry.id === entry.id);
  return queued ? queued.target : undefined;
}

async function resolveMemoryById(
  store: MemoryStore,
  idOrPrefix: string,
  scope?: string,
): Promise<MemoryEntry | null> {
  const trimmed = String(idOrPrefix || "").trim();
  if (!trimmed) return null;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) {
    const row = await store.getById(trimmed);
    if (!row) return null;
    if (scope && row.scope !== scope) return null;
    return row;
  }

  const scopeFilter = scope ? [scope] : undefined;
  const rows = await store.list(scopeFilter, undefined, 2000, 0);
  const matched = rows.filter((row) => row.id.startsWith(trimmed));
  if (matched.length === 0) return null;
  if (matched.length > 1) {
    throw new Error(`Ambiguous id prefix ${trimmed}; ${matched.length} matches found.`);
  }
  return matched[0];
}

// ============================================================================
// CLI Command Implementations
// ============================================================================

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  const memory = program
    .command("memory-pro")
    .description("Enhanced memory management commands (LanceDB Pro)");

  // Version
  memory
    .command("version")
    .description("Print plugin version")
    .action(() => {
      console.log(getPluginVersion());
    });

  // List memories
  memory
    .command("list")
    .description("List memories with optional filtering")
    .option("--scope <scope>", "Filter by scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--offset <n>", "Number of results to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit) || 20;
        const offset = parseInt(options.offset) || 0;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          limit,
          offset
        );

        if (options.json) {
          console.log(formatJson(memories));
        } else {
          if (memories.length === 0) {
            console.log("No memories found.");
          } else {
            console.log(`Found ${memories.length} memories:\n`);
            memories.forEach((memory, i) => {
              console.log(formatMemory(memory, offset + i));
            });
          }
        }
      } catch (error) {
        console.error("Failed to list memories:", error);
        process.exit(1);
      }
    });

  // Search memories
  memory
    .command("search <query>")
    .description("Search memories using hybrid retrieval")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const results = await context.retriever.retrieve({
          query,
          limit,
          scopeFilter,
          category: options.category,
        });

        if (options.json) {
          console.log(formatJson(results));
        } else {
          if (results.length === 0) {
            console.log("No relevant memories found.");
          } else {
            console.log(`Found ${results.length} memories:\n`);
            results.forEach((result, i) => {
              const sources = [];
              if (result.sources.vector) sources.push("vector");
              if (result.sources.bm25) sources.push("BM25");
              if (result.sources.reranked) sources.push("reranked");

              console.log(
                `${i + 1}. [${result.entry.id}] [${result.entry.category}:${result.entry.scope}] ${result.entry.text} ` +
                `(${(result.score * 100).toFixed(0)}%, ${sources.join('+')})`
              );
            });
          }
        }
      } catch (error) {
        console.error("Search failed:", error);
        process.exit(1);
      }
    });

  // Memory statistics
  memory
    .command("stats")
    .description("Show memory statistics")
    .option("--scope <scope>", "Stats for specific scope")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const scopeStats = context.scopeManager.getStats();
        const retrievalConfig = context.retriever.getConfig();

        const summary = {
          memory: stats,
          scopes: scopeStats,
          retrieval: {
            mode: retrievalConfig.mode,
            hasFtsSupport: context.store.hasFtsSupport,
          },
        };

        if (options.json) {
          console.log(formatJson(summary));
        } else {
          console.log(`Memory Statistics:`);
          console.log(`• Total memories: ${stats.totalCount}`);
          console.log(`• Available scopes: ${scopeStats.totalScopes}`);
          console.log(`• Retrieval mode: ${retrievalConfig.mode}`);
          console.log(`• FTS support: ${context.store.hasFtsSupport ? 'Yes' : 'No'}`);
          console.log();

          console.log("Memories by scope:");
          Object.entries(stats.scopeCounts).forEach(([scope, count]) => {
            console.log(`  • ${scope}: ${count}`);
          });
          console.log();

          console.log("Memories by category:");
          Object.entries(stats.categoryCounts).forEach(([category, count]) => {
            console.log(`  • ${category}: ${count}`);
          });
        }
      } catch (error) {
        console.error("Failed to get statistics:", error);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .action(async (id, options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const deleted = await context.store.delete(id, scopeFilter);

        if (deleted) {
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          console.log(`Memory ${id} not found or access denied.`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Failed to delete memory:", error);
        process.exit(1);
      }
    });

  // Bulk delete
  memory
    .command("delete-bulk")
    .description("Bulk delete memories with filters")
    .option("--scope <scopes...>", "Scopes to delete from (required)")
    .option("--before <date>", "Delete memories before this date (YYYY-MM-DD)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options) => {
      try {
        if (!options.scope || options.scope.length === 0) {
          console.error("At least one scope must be specified for safety.");
          process.exit(1);
        }

        let beforeTimestamp: number | undefined;
        if (options.before) {
          const date = new Date(options.before);
          if (isNaN(date.getTime())) {
            console.error("Invalid date format. Use YYYY-MM-DD.");
            process.exit(1);
          }
          beforeTimestamp = date.getTime();
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be deleted");
          console.log(`Filters: scopes=${options.scope.join(',')}, before=${options.before || 'none'}`);

          // Show what would be deleted
          const stats = await context.store.stats(options.scope);
          console.log(`Would delete from ${stats.totalCount} memories in matching scopes.`);
        } else {
          const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
          console.log(`Deleted ${deletedCount} memories.`);
        }
      } catch (error) {
        console.error("Bulk delete failed:", error);
        process.exit(1);
      }
    });

  // Export memories
  memory
    .command("export")
    .description("Export memories to JSON")
    .option("--scope <scope>", "Export specific scope")
    .option("--category <category>", "Export specific category")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          1000 // Large limit for export
        );

        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: memories.length,
          filters: {
            scope: options.scope,
            category: options.category,
          },
          memories: memories.map(m => ({
            ...m,
            vector: undefined, // Exclude vectors to reduce size
          })),
        };

        const output = formatJson(exportData);

        if (options.output) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(options.output, output);
          console.log(`Exported ${memories.length} memories to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (error) {
        console.error("Export failed:", error);
        process.exit(1);
      }
    });

  // Import memories
  memory
    .command("import <file>")
    .description("Import memories from JSON file")
    .option("--scope <scope>", "Import into specific scope")
    .option("--dry-run", "Show what would be imported without actually importing")
    .action(async (file, options) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(file, "utf-8");
        const data = JSON.parse(content);

        if (!data.memories || !Array.isArray(data.memories)) {
          throw new Error("Invalid import file format");
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be imported");
          console.log(`Would import ${data.memories.length} memories`);
          if (options.scope) {
            console.log(`Target scope: ${options.scope}`);
          }
          return;
        }

        console.log(`Importing ${data.memories.length} memories...`);

        let imported = 0;
        let skipped = 0;

        if (!context.embedder) {
          console.error("Import requires an embedder (not available in basic CLI mode).");
          console.error("Use the plugin's memory_store tool or pass embedder to createMemoryCLI.");
          return;
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();

        for (const memory of data.memories) {
          try {
            const text = memory.text;
            if (!text || typeof text !== "string" || text.length < 2) {
              skipped++;
              continue;
            }

            const categoryRaw = memory.category;
            const category: MemoryEntry["category"] =
              categoryRaw === "preference" ||
              categoryRaw === "fact" ||
              categoryRaw === "decision" ||
              categoryRaw === "entity" ||
              categoryRaw === "other"
                ? categoryRaw
                : "other";

            const importanceRaw = Number(memory.importance);
            const importance = Number.isFinite(importanceRaw)
              ? Math.max(0, Math.min(1, importanceRaw))
              : 0.7;

            const timestampRaw = Number(memory.timestamp);
            const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

            const metadataRaw = memory.metadata;
            const metadata =
              typeof metadataRaw === "string"
                ? metadataRaw
                : metadataRaw != null
                  ? JSON.stringify(metadataRaw)
                  : "{}";

            const idRaw = memory.id;
            const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;

            // Idempotency: if the import file includes an id and we already have it, skip.
            if (id && (await context.store.hasId(id))) {
              skipped++;
              continue;
            }

            // Back-compat dedupe: if no id provided, do a best-effort similarity check.
            if (!id) {
              const existing = await context.retriever.retrieve({
                query: text,
                limit: 1,
                scopeFilter: [targetScope],
              });
              if (existing.length > 0 && existing[0].score > 0.95) {
                skipped++;
                continue;
              }
            }

            const vector = await context.embedder.embedPassage(text);

            if (id) {
              await context.store.importEntry({
                id,
                text,
                vector,
                category,
                scope: targetScope,
                importance,
                timestamp,
                metadata,
              });
            } else {
              await context.store.store({
                text,
                vector,
                importance,
                category,
                scope: targetScope,
                metadata,
              });
            }

            imported++;
          } catch (error) {
            console.warn(`Failed to import memory: ${error}`);
            skipped++;
          }
        }

        console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
      } catch (error) {
        console.error("Import failed:", error);
        process.exit(1);
      }
    });

  // Re-embed an existing LanceDB into the current target DB (A/B testing)
  memory
    .command("reembed")
    .description("Re-embed memories from a source LanceDB database into the current target database")
    .requiredOption("--source-db <path>", "Source LanceDB database directory")
    .option("--batch-size <n>", "Batch size for embedding calls", "32")
    .option("--limit <n>", "Limit number of rows to process (for testing)")
    .option("--dry-run", "Show what would be re-embedded without writing")
    .option("--skip-existing", "Skip entries whose id already exists in the target DB")
    .option("--force", "Allow using the same source-db as the target dbPath (DANGEROUS)")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("Re-embed requires an embedder (not available in basic CLI mode).");
          return;
        }

        const fs = await import("node:fs/promises");

        const sourceDbPath = options.sourceDb as string;
        const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
        const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1000000) : undefined;
        const dryRun = options.dryRun === true;
        const skipExisting = options.skipExisting === true;
        const force = options.force === true;

        // Safety: prevent accidental in-place re-embedding
        let sourceReal = sourceDbPath;
        let targetReal = context.store.dbPath;
        try {
          sourceReal = await fs.realpath(sourceDbPath);
        } catch {}
        try {
          targetReal = await fs.realpath(context.store.dbPath);
        } catch {}

        if (!force && sourceReal === targetReal) {
          console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
          process.exit(1);
        }

        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        const table = await db.openTable("memories");

        let query = table
          .query()
          .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]);

        if (limit) query = query.limit(limit);

        const rows = (await query.toArray())
          .filter((r: any) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .filter((r: any) => r.id && r.id !== "__schema__");

        if (rows.length === 0) {
          console.log("No source memories found.");
          return;
        }

        console.log(
          `Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`
        );

        if (dryRun) {
          console.log("DRY RUN - No memories will be written");
          console.log(`First example: ${rows[0].id?.slice?.(0, 8)} ${String(rows[0].text).slice(0, 80)}`);
          return;
        }

        let processed = 0;
        let imported = 0;
        let skipped = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const texts = batch.map((r: any) => String(r.text));
          const vectors = await context.embedder.embedBatchPassage(texts);

          for (let j = 0; j < batch.length; j++) {
            processed++;
            const row = batch[j];
            const vector = vectors[j];

            if (!vector || vector.length === 0) {
              skipped++;
              continue;
            }

            const id = String(row.id);
            if (skipExisting) {
              const exists = await context.store.hasId(id);
              if (exists) {
                skipped++;
                continue;
              }
            }

            const entry: MemoryEntry = {
              id,
              text: String(row.text),
              vector,
              category: (row.category as any) || "other",
              scope: (row.scope as string | undefined) || "global",
              importance: (row.importance != null) ? Number(row.importance) : 0.7,
              timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
              metadata: typeof row.metadata === "string" ? row.metadata : "{}",
            };

            await context.store.importEntry(entry);
            imported++;
          }

          if (processed % 100 === 0 || processed === rows.length) {
            console.log(`Progress: ${processed}/${rows.length} processed, ${imported} imported, ${skipped} skipped`);
          }
        }

        console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
      } catch (error) {
        console.error("Re-embed failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("graph-doctor")
    .description("Inspect Graphiti sync metadata health from LanceDB entries")
    .option("--scope <scope>", "Filter by scope")
    .option("--limit <n>", "Max rows to scan", "500")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = clampInt(parseInt(options.limit, 10) || 500, 1, 5000);
        const scopeFilter = options.scope ? [String(options.scope)] : undefined;
        const entries = await context.store.list(scopeFilter, undefined, limit, 0);

        let withGraphiti = 0;
        let stored = 0;
        let failed = 0;
        let skipped = 0;
        let inferred = 0;

        for (const entry of entries) {
          const metadata = safeParseJson(entry.metadata);
          const graphiti = metadata.graphiti && typeof metadata.graphiti === "object"
            ? (metadata.graphiti as Record<string, unknown>)
            : undefined;
          if (graphiti) {
            withGraphiti++;
            const status = typeof graphiti.status === "string" ? graphiti.status : "";
            if (status === "stored") stored++;
            if (status === "failed") failed++;
            if (status === "skipped") skipped++;
          }

          const assertionKind = typeof metadata.assertionKind === "string" ? metadata.assertionKind : "";
          if (assertionKind === "inferred") inferred++;
        }

        const report = {
          scanned: entries.length,
          withGraphiti,
          statuses: {
            stored,
            failed,
            skipped,
          },
          inferredCount: inferred,
          coverage: entries.length > 0 ? Number((withGraphiti / entries.length).toFixed(4)) : 0,
          scope: options.scope || "all",
        };

        if (options.json) {
          console.log(formatJson(report));
          return;
        }

        console.log("Graph Sync Doctor:");
        console.log(`• Scanned: ${report.scanned}`);
        console.log(`• With graphiti metadata: ${report.withGraphiti}`);
        console.log(`• Stored: ${report.statuses.stored}`);
        console.log(`• Failed: ${report.statuses.failed}`);
        console.log(`• Skipped: ${report.statuses.skipped}`);
        console.log(`• Inferred entries: ${report.inferredCount}`);
        console.log(`• Coverage: ${(report.coverage * 100).toFixed(1)}%`);
      } catch (error) {
        console.error("Graph doctor failed:", error);
        process.exit(1);
      }
    });

  const executeGraphSync = async (mode: "backfill" | "resync", options: Record<string, unknown>) => {
    if (!context.graphitiSync || !context.graphitiConfig?.enabled) {
      throw new Error("Graph sync is unavailable. Enable graphiti config first.");
    }

    const limit = clampInt(parseInt(String(options.limit ?? "500"), 10) || 500, 1, 5000);
    const scopeFilter = typeof options.scope === "string" && options.scope.trim().length > 0
      ? [options.scope.trim()]
      : undefined;
    const dryRun = options.dryRun === true;

    const entries = await context.store.list(scopeFilter, undefined, limit, 0);
    const candidates = entries.filter((entry) => {
      if (entry.category === "reflection") return false;
      if (mode === "resync") return true;
      const metadata = safeParseJson(entry.metadata);
      const graphiti = metadata.graphiti && typeof metadata.graphiti === "object"
        ? (metadata.graphiti as Record<string, unknown>)
        : undefined;
      return !graphiti || graphiti.status !== "stored";
    });

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    for (const entry of candidates) {
      if (dryRun) {
        synced++;
        continue;
      }
      const result = await context.graphitiSync.syncMemory(
        {
          id: entry.id,
          text: entry.text,
          scope: entry.scope,
          category: entry.category,
          metadata: entry.metadata,
        },
        {
          mode: "memoryStore",
          source: `graph_sync:${mode}`,
          mutation: `graph_sync_${mode}`,
          extraMetadata: {
            trigger: "memory-pro graph-sync",
          },
        },
      );

      if (!result || result.status === "skipped") skipped++;
      else if (result.status === "failed") failed++;
      else synced++;
    }

    return {
      mode,
      dryRun,
      scanned: entries.length,
      candidates: candidates.length,
      synced,
      failed,
      skipped,
      scope: scopeFilter?.[0] || "all",
    };
  };

  const executeGraphImport = async (options: Record<string, unknown>) => {
    if (!context.graphitiBridge) {
      throw new Error("Graph import is unavailable. Graphiti bridge is not initialized.");
    }
    if (!context.embedder) {
      throw new Error("Graph import requires embedder support.");
    }

    const modeRaw = String(options.mode || "recall").trim().toLowerCase();
    if (modeRaw !== "recall" && modeRaw !== "list") {
      throw new Error("Invalid --mode. Use recall or list.");
    }

    const scope = typeof options.scope === "string" && options.scope.trim().length > 0
      ? options.scope.trim()
      : "global";
    const query = typeof options.query === "string"
      ? options.query.trim()
      : "";
    const limit = clampInt(parseInt(String(options.limit ?? "40"), 10) || 40, 1, 200);
    const dryRun = options.dryRun === true;

    const graph = modeRaw === "list"
      ? await context.graphitiBridge.list(scope, limit, limit)
      : await context.graphitiBridge.recall({
          scope,
          query: query || "memory",
          limitNodes: limit,
          limitFacts: limit,
        });

    const candidates = [
      ...graph.facts.map((fact) => ({
        text: fact.text,
        category: "fact" as const,
        sourceKind: "fact",
      })),
      ...graph.nodes.map((node) => ({
        text: node.label,
        category: "entity" as const,
        sourceKind: "node",
      })),
    ]
      .map((row) => ({
        ...row,
        normalized: row.text.replace(/\s+/g, " ").trim(),
      }))
      .filter((row) => row.normalized.length > 0)
      .slice(0, limit * 2);

    let imported = 0;
    let skippedDuplicate = 0;
    let skippedEmpty = 0;

    for (const row of candidates) {
      if (row.normalized.length < 2) {
        skippedEmpty++;
        continue;
      }

      const vector = await context.embedder.embedPassage(row.normalized);
      const existing = await context.store.vectorSearch(vector, 1, 0.1, [scope]);
      if (existing.length > 0 && existing[0].score > 0.97) {
        skippedDuplicate++;
        continue;
      }

      if (dryRun) {
        imported++;
        continue;
      }

      await context.store.store({
        text: row.normalized,
        vector,
        importance: 0.62,
        category: row.category,
        scope,
        metadata: JSON.stringify({
          source: "graphiti_import",
          importMode: modeRaw,
          sourceKind: row.sourceKind,
          groupId: graph.groupId,
          query: query || undefined,
          assertionKind: "inferred",
          confidence: 0.66,
          importedAt: Date.now(),
        }),
      });
      imported++;
    }

    return {
      mode: modeRaw,
      dryRun,
      scope,
      groupId: graph.groupId,
      query: query || undefined,
      scanned: candidates.length,
      imported,
      skippedDuplicate,
      skippedEmpty,
      factsFetched: graph.facts.length,
      nodesFetched: graph.nodes.length,
    };
  };

  memory
    .command("graph-infer")
    .description("Run Graphiti inference once for validation or manual refresh")
    .option("--once", "Run one-shot inference (default behavior)", true)
    .option("--dry-run", "Analyze candidates without storing inferred memories")
    .option("--scope <scope>", "Single scope filter")
    .option("--include-scopes <csv>", "Comma-separated scope allowlist")
    .option("--exclude-scopes <csv>", "Comma-separated scope denylist")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        if (!context.graphInferenceRun) {
          console.error("Graph inference runner is unavailable. Start via plugin runtime with Graphiti enabled.");
          process.exit(1);
        }

        const includeScopes = parseScopeList(options.includeScopes);
        const excludeScopes = parseScopeList(options.excludeScopes);
        if (typeof options.scope === "string" && options.scope.trim()) {
          includeScopes.push(options.scope.trim());
        }

        const result = await context.graphInferenceRun({
          reason: options.once === false ? "cli" : "cli:once",
          dryRun: options.dryRun === true,
          includeScopes,
          excludeScopes,
          forceRun: true,
        });

        if (options.json) {
          console.log(formatJson(result));
          return;
        }

        console.log("Graph Inference Run:");
        console.log(`• Reason: ${result.reason}`);
        console.log(`• Dry run: ${result.dryRun ? "Yes" : "No"}`);
        console.log(`• Scopes scanned: ${result.scopesScanned}`);
        console.log(`• Scope filter applied: ${result.scopeFilterApplied.length > 0 ? result.scopeFilterApplied.join(", ") : "(none)"}`);
        console.log(`• Candidates: ${result.candidates}`);
        console.log(`• Stored: ${result.stored}`);
        console.log(`• Skipped duplicates: ${result.skippedDuplicate}`);
      } catch (error) {
        console.error("Graph inference failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("graph-sync")
    .description("Backfill/resync LanceDB memories into Graphiti")
    .option("--mode <mode>", "backfill or resync", "backfill")
    .option("--scope <scope>", "Scope filter")
    .option("--limit <n>", "Max memories scanned", "500")
    .option("--dry-run", "Show sync results without writing to Graphiti")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const mode = String(options.mode || "backfill").trim().toLowerCase();
        if (mode !== "backfill" && mode !== "resync") {
          console.error("Invalid --mode. Use backfill or resync.");
          process.exit(1);
        }
        const report = await executeGraphSync(mode, options);

        if (options.json) {
          console.log(formatJson(report));
          return;
        }

        console.log("Graph Sync Run:");
        console.log(`• Mode: ${report.mode}`);
        console.log(`• Dry run: ${report.dryRun ? "Yes" : "No"}`);
        console.log(`• Scanned: ${report.scanned}`);
        console.log(`• Candidates: ${report.candidates}`);
        console.log(`• Synced: ${report.synced}`);
        console.log(`• Failed: ${report.failed}`);
        console.log(`• Skipped: ${report.skipped}`);
      } catch (error) {
        console.error("Graph sync failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("graph-import")
    .description("Reverse import Graphiti recall/list results into LanceDB")
    .option("--mode <mode>", "recall or list", "recall")
    .option("--scope <scope>", "Target scope", "global")
    .option("--query <query>", "Recall query (used when mode=recall)")
    .option("--limit <n>", "Max nodes/facts fetched", "40")
    .option("--dry-run", "Analyze without writing to LanceDB")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const report = await executeGraphImport(options);
        if (options.json) {
          console.log(formatJson(report));
          return;
        }

        console.log("Graph Import Run:");
        console.log(`• Mode: ${report.mode}`);
        console.log(`• Dry run: ${report.dryRun ? "Yes" : "No"}`);
        console.log(`• Scope: ${report.scope}`);
        console.log(`• Group ID: ${report.groupId}`);
        console.log(`• Facts fetched: ${report.factsFetched}`);
        console.log(`• Nodes fetched: ${report.nodesFetched}`);
        console.log(`• Candidates scanned: ${report.scanned}`);
        console.log(`• Imported: ${report.imported}`);
        console.log(`• Skipped duplicates: ${report.skippedDuplicate}`);
        console.log(`• Skipped empty: ${report.skippedEmpty}`);
      } catch (error) {
        console.error("Graph import failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("graph-backfill")
    .description("Backfill LanceDB memories into Graphiti")
    .option("--scope <scope>", "Scope filter")
    .option("--limit <n>", "Max memories scanned", "500")
    .option("--dry-run", "Show sync results without writing to Graphiti")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const report = await executeGraphSync("backfill", options);
        if (options.json) {
          console.log(formatJson(report));
          return;
        }
        console.log(`Graph backfill complete: synced=${report.synced}, failed=${report.failed}, skipped=${report.skipped}, dryRun=${report.dryRun ? "yes" : "no"}`);
      } catch (error) {
        console.error("Graph backfill failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("graph-resync")
    .description("Resync LanceDB memories into Graphiti (re-mirror)")
    .option("--scope <scope>", "Scope filter")
    .option("--limit <n>", "Max memories scanned", "500")
    .option("--dry-run", "Show sync results without writing to Graphiti")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const report = await executeGraphSync("resync", options);
        if (options.json) {
          console.log(formatJson(report));
          return;
        }
        console.log(`Graph resync complete: synced=${report.synced}, failed=${report.failed}, skipped=${report.skipped}, dryRun=${report.dryRun ? "yes" : "no"}`);
      } catch (error) {
        console.error("Graph resync failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("promotion-queue")
    .description("Inspect promotion queue with reason stats")
    .option("--scope <scope>", "Scope filter")
    .option("--limit <n>", "Max queue rows", "40")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = clampInt(parseInt(options.limit, 10) || 40, 1, 200);
        const scopeFilter = typeof options.scope === "string" && options.scope.trim().length > 0
          ? [options.scope.trim()]
          : undefined;
        const entries = await context.store.list(scopeFilter, undefined, 600, 0);
        const policy = applyPromotionPolicy(entries);

        const report = {
          scope: scopeFilter?.[0] || "all",
          queued: policy.queue.slice(0, limit).map((item) => ({
            id: item.entry.id,
            scope: item.entry.scope,
            category: item.entry.category,
            target: item.target,
            reason: item.reason,
            confidence: Number(item.confidence.toFixed(2)),
            repeatCount: item.repeatCount,
            text: item.entry.text,
          })),
          reasonStats: policy.reasonStats,
          contradictions: policy.contradictions,
        };

        if (options.json) {
          console.log(formatJson(report));
          return;
        }

        console.log("Promotion Queue:");
        console.log(`• Scope: ${report.scope}`);
        console.log(`• Queue size (shown): ${report.queued.length}`);
        console.log("• Reason stats:");
        const reasonRows = Object.entries(report.reasonStats).sort((a, b) => b[1] - a[1]);
        if (reasonRows.length === 0) console.log("  - none");
        for (const [reason, count] of reasonRows) {
          console.log(`  - ${reason}: ${count}`);
        }
        if (report.contradictions.length > 0) {
          console.log("• Contradictions:");
          for (const c of report.contradictions.slice(0, 8)) {
            console.log(`  - ${c.positive} <-> ${c.negative}`);
          }
        }
        if (report.queued.length > 0) {
          console.log("• Pending rows:");
          for (const row of report.queued) {
            console.log(`  - [${row.id}] [${row.target}] reason=${row.reason} confidence=${row.confidence} repeat=${row.repeatCount} ${row.text.slice(0, 120)}`);
          }
        }
      } catch (error) {
        console.error("Promotion queue failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("promotion-approve <id>")
    .description("Approve a queued promotion and persist metadata")
    .option("--target <target>", "Override target: USER|AGENTS|IDENTITY|SOUL")
    .option("--scope <scope>", "Optional scope guard")
    .action(async (id, options) => {
      try {
        const entry = await resolveMemoryById(context.store, id, options.scope);
        if (!entry) {
          console.error(`Memory ${id} not found.`);
          process.exit(1);
        }

        const target = normalizeTarget(options.target) || detectPromotionTarget(entry);
        if (!target) {
          console.error("Unable to infer promotion target; pass --target USER|AGENTS|IDENTITY|SOUL");
          process.exit(1);
        }

        const metadata = safeParseJson(entry.metadata);
        metadata.promotion = {
          ...(metadata.promotion && typeof metadata.promotion === "object" ? metadata.promotion as Record<string, unknown> : {}),
          status: "approved",
          target,
          actedAt: new Date().toISOString(),
          actedBy: "memory-pro",
        };

        await context.store.update(entry.id, { metadata: JSON.stringify(metadata) }, [entry.scope]);
        console.log(`Approved promotion for ${entry.id} -> ${target}`);
      } catch (error) {
        console.error("Promotion approve failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("promotion-reject <id>")
    .description("Reject a queued promotion and persist metadata")
    .option("--reason <reason>", "Optional rejection reason", "manual_reject")
    .option("--scope <scope>", "Optional scope guard")
    .action(async (id, options) => {
      try {
        const entry = await resolveMemoryById(context.store, id, options.scope);
        if (!entry) {
          console.error(`Memory ${id} not found.`);
          process.exit(1);
        }

        const metadata = safeParseJson(entry.metadata);
        metadata.promotion = {
          ...(metadata.promotion && typeof metadata.promotion === "object" ? metadata.promotion as Record<string, unknown> : {}),
          status: "rejected",
          reason: String(options.reason || "manual_reject"),
          actedAt: new Date().toISOString(),
          actedBy: "memory-pro",
        };

        await context.store.update(entry.id, { metadata: JSON.stringify(metadata) }, [entry.scope]);
        console.log(`Rejected promotion for ${entry.id}`);
      } catch (error) {
        console.error("Promotion reject failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("docs-refresh")
    .description("Refresh managed workspace markdown sections")
    .option("--workspace <path>", "Workspace directory", join(homedir(), ".openclaw", "workspace"))
    .option("--reason <reason>", "Refresh reason label", "cli")
    .action(async (options) => {
      try {
        const workspaceDir = String(options.workspace);
        const materializer = createWorkspaceDocsMaterializer({
          store: context.store,
          workspaceDir,
          markerPrefix: "memory-lancedb-pro",
        });
        await materializer.refresh({ reason: String(options.reason || "cli") });
        console.log(`Workspace docs refreshed at ${workspaceDir}`);
      } catch (error) {
        console.error("Docs refresh failed:", error);
        process.exit(1);
      }
    });

  // Migration commands
  const migrate = memory
    .command("migrate")
    .description("Migration utilities");

  migrate
    .command("check")
    .description("Check if migration is needed from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const check = await context.migrator.checkMigrationNeeded(options.source);

        console.log("Migration Check Results:");
        console.log(`• Legacy database found: ${check.sourceFound ? 'Yes' : 'No'}`);
        if (check.sourceDbPath) {
          console.log(`• Source path: ${check.sourceDbPath}`);
        }
        if (check.entryCount !== undefined) {
          console.log(`• Entries to migrate: ${check.entryCount}`);
        }
        console.log(`• Migration needed: ${check.needed ? 'Yes' : 'No'}`);
      } catch (error) {
        console.error("Migration check failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("run")
    .description("Run migration from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .option("--default-scope <scope>", "Default scope for migrated data", "global")
    .option("--dry-run", "Show what would be migrated without actually migrating")
    .option("--skip-existing", "Skip entries that already exist")
    .action(async (options) => {
      try {
        const result = await context.migrator.migrate({
          sourceDbPath: options.source,
          defaultScope: options.defaultScope,
          dryRun: options.dryRun,
          skipExisting: options.skipExisting,
        });

        console.log("Migration Results:");
        console.log(`• Status: ${result.success ? 'Success' : 'Failed'}`);
        console.log(`• Migrated: ${result.migratedCount}`);
        console.log(`• Skipped: ${result.skippedCount}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
        console.log(`• Summary: ${result.summary}`);

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("verify")
    .description("Verify migration results")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const result = await context.migrator.verifyMigration(options.source);

        console.log("Migration Verification:");
        console.log(`• Valid: ${result.valid ? 'Yes' : 'No'}`);
        console.log(`• Source count: ${result.sourceCount}`);
        console.log(`• Target count: ${result.targetCount}`);

        if (result.issues.length > 0) {
          console.log("• Issues:");
          result.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
      }
    });
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => registerMemoryCLI(program, context);
}
