/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string; // JSON string for extensible metadata
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
}

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;

export const loadLanceDB = async (): Promise<
  typeof import("@lancedb/lancedb")
> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(
      `memory-lancedb-pro: failed to load LanceDB. ${String(err)}`,
      { cause: err },
    );
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// ============================================================================
// Storage Path Validation
// ============================================================================

/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;

  // Resolve symlinks (including dangling symlinks)
  try {
    const stats = lstatSync(dbPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(dbPath);
      } catch (err: any) {
        throw new Error(
          `dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
            `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
            `  Details: ${err.code || ""} ${err.message}`,
        );
      }
    }
  } catch (err: any) {
    // Missing path is OK (it will be created below)
    if (err?.code === "ENOENT") {
      // no-op
    } else if (
      typeof err?.message === "string" &&
      err.message.includes("symlink whose target does not exist")
    ) {
      throw err;
    } else {
      // Other lstat failures — continue with original path
    }
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err: any) {
      throw new Error(
        `Failed to create dbPath directory "${resolvedPath}".\n` +
          `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
          `       or create it manually: mkdir -p "${resolvedPath}"\n` +
          `  Details: ${err.code || ""} ${err.message}`,
      );
    }
  }

  // Check write permissions
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err: any) {
    throw new Error(
      `dbPath directory "${resolvedPath}" is not writable.\n` +
        `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
        `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
        `  Details: ${err.code || ""} ${err.message}`,
    );
  }

  return resolvedPath;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsIndexCreated = false;

  constructor(private readonly config: StoreConfig) {}

  get dbPath(): string {
    return this.config.dbPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();

    let db: LanceDB.Connection;
    try {
      db = await lancedb.connect(this.config.dbPath);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
          `  Fix: Verify the path exists and is writable. Check parent directory permissions.`,
      );
    }

    let table: LanceDB.Table;

    // Idempotent table init: try openTable first, create only if missing,
    // and handle the race where tableNames() misses an existing table but
    // createTable then sees it (LanceDB eventual consistency).
    try {
      table = await db.openTable(TABLE_NAME);

      // Check if we need to add scope column for backward compatibility
      try {
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && !("scope" in sample[0])) {
          console.warn(
            "Adding scope column for backward compatibility with existing data",
          );
        }
      } catch (err) {
        console.warn("Could not check table schema:", err);
      }
    } catch (_openErr) {
      // Table doesn't exist yet — create it
      const schemaEntry: MemoryEntry = {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.config.vectorDim }).fill(
          0,
        ) as number[],
        category: "other",
        scope: "global",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
      };

      try {
        table = await db.createTable(TABLE_NAME, [schemaEntry]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        // Race: another caller (or eventual consistency) created the table
        // between our failed openTable and this createTable — just open it.
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Validate vector dimensions
    // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
    // Array.isArray() returns false for Arrow Vectors, so use .length instead.
    const sample = await table.query().limit(1).toArray();
    if (sample.length > 0 && sample[0]?.vector?.length) {
      const existingDim = sample[0].vector.length;
      if (existingDim !== this.config.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`,
        );
      }
    }

    // Create FTS index for BM25 search (graceful fallback if unavailable)
    try {
      await this.createFtsIndex(table);
      this.ftsIndexCreated = true;
    } catch (err) {
      console.warn(
        "Failed to create FTS index, falling back to vector-only search:",
        err,
      );
      this.ftsIndexCreated = false;
    }

    this.db = db;
    this.table = table;
  }

  private async createFtsIndex(table: LanceDB.Table): Promise<void> {
    try {
      // Check if FTS index already exists
      const indices = await table.listIndices();
      const hasFtsIndex = indices?.some(
        (idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );

      if (!hasFtsIndex) {
        // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
        const lancedb = await loadLanceDB();
        await table.createIndex("text", {
          config: (lancedb as any).Index.fts(),
        });
      }
    } catch (err) {
      throw new Error(
        `FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    };

    try {
      await this.table!.add([fullEntry]);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`,
      );
    }
    return fullEntry;
  }

  /**
   * Batch store multiple entries at once for better performance.
   * Returns all stored entries with their generated IDs.
   */
  async storeBatch(
    entries: Array<Omit<MemoryEntry, "id" | "timestamp">>,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const fullEntries: MemoryEntry[] = entries.map((entry) => ({
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    }));

    if (fullEntries.length === 0) {
      return [];
    }

    try {
      await this.table!.add(fullEntries);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to batch store ${fullEntries.length} memories in "${this.config.dbPath}": ${code} ${message}`,
      );
    }

    return fullEntries;
  }

  /**
   * Import a pre-built entry while preserving its id/timestamp.
   * Used for re-embedding / migration / A/B testing across embedding models.
   * Intentionally separate from `store()` to keep normal writes simple.
   */
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (!entry.id || typeof entry.id !== "string") {
      throw new Error("importEntry requires a stable id");
    }

    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`,
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope || "global",
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
      timestamp: Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : Date.now(),
      metadata: entry.metadata || "{}",
    };

    await this.table!.add([full]);
    return full;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const res = await this.table!.query()
      .select(["id"])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    return res.length > 0;
  }

  /**
   * Read a single memory entry by exact ID without any mutation.
   * Unlike update(id, {}), this performs a pure read (no delete+add cycle).
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const rows = await this.table!.query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: (row.scope as string | undefined) ?? "global",
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  async vectorSearch(
    vector: number[],
    limit = 5,
    minScore = 0.3,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const safeLimit = clampInt(limit, 1, 20);
    const fetchLimit = Math.min(safeLimit * 10, 200); // Over-fetch for scope filtering

    let query = this.table!.vectorSearch(vector).limit(fetchLimit);

    // Apply scope filter if provided
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      query = query.where(`(${scopeConditions}) OR scope IS NULL`); // NULL for backward compatibility
    }

    const results = await query.toArray();
    const mapped: MemorySearchResult[] = [];

    for (const row of results) {
      const distance = Number(row._distance ?? 0);
      const score = 1 / (1 + distance);

      if (score < minScore) continue;

      const rowScope = (row.scope as string | undefined) ?? "global";

      // Double-check scope filter in application layer
      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(rowScope)
      ) {
        continue;
      }

      mapped.push({
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          category: row.category as MemoryEntry["category"],
          scope: rowScope,
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        },
        score,
      });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (!this.ftsIndexCreated) {
      return []; // Fallback to vector-only if FTS unavailable
    }

    const safeLimit = clampInt(limit, 1, 20);

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(safeLimit);

      // Apply scope filter if provided
      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter
          .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
          .join(" OR ");
        searchQuery = searchQuery.where(
          `(${scopeConditions}) OR scope IS NULL`,
        );
      }

      const results = await searchQuery.toArray();
      const mapped: MemorySearchResult[] = [];

      for (const row of results) {
        const rowScope = (row.scope as string | undefined) ?? "global";

        // Double-check scope filter in application layer
        if (
          scopeFilter &&
          scopeFilter.length > 0 &&
          !scopeFilter.includes(rowScope)
        ) {
          continue;
        }

        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        // LanceDB may return BigInt for numeric columns; coerce safely.
        const rawScore = row._score != null ? Number(row._score) : 0;
        const normalizedScore =
          rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;

        mapped.push({
          entry: {
            id: row.id as string,
            text: row.text as string,
            vector: row.vector as number[],
            category: row.category as MemoryEntry["category"],
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: (row.metadata as string) || "{}",
          },
          score: normalizedScore,
        });
      }

      return mapped;
    } catch (err) {
      console.warn("BM25 search failed, falling back to empty results:", err);
      return [];
    }
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let candidates: any[];
    if (isFullId) {
      candidates = await this.table!.query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();
    } else {
      // Prefix match: fetch candidates and filter in app layer
      const all = await this.table!.query()
        .select(["id", "scope"])
        .limit(1000)
        .toArray();
      candidates = all.filter((r: any) => (r.id as string).startsWith(id));
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }
    if (candidates.length === 0) {
      return false;
    }

    const resolvedId = candidates[0].id as string;
    const rowScope = (candidates[0].scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
    }

    await this.table!.delete(`id = '${resolvedId}'`);
    return true;
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    let query = this.table!.query();

    // Build where conditions
    const conditions: string[] = [];

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
    }

    if (category) {
      conditions.push(`category = '${escapeSqlLiteral(category)}'`);
    }

    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    // Fetch all matching rows (no pre-limit) so app-layer sort is correct across full dataset
    const results = await query
      .select([
        "id",
        "text",
        "category",
        "scope",
        "importance",
        "timestamp",
        "metadata",
      ])
      .toArray();

    return results
      .map(
        (row): MemoryEntry => ({
          id: row.id as string,
          text: row.text as string,
          vector: [], // Don't include vectors in list results for performance
          category: row.category as MemoryEntry["category"],
          scope: (row.scope as string | undefined) ?? "global",
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        }),
      )
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(offset, offset + limit);
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    await this.ensureInitialized();

    let query = this.table!.query();

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
    }

    const results = await query.select(["scope", "category"]).toArray();

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const row of results) {
      const scope = (row.scope as string | undefined) ?? "global";
      const category = row.category as string;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    return {
      totalCount: results.length,
      scopeCounts,
      categoryCounts,
    };
  }

  async update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars), same as delete()
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let rows: any[];
    if (isFullId) {
      const safeId = escapeSqlLiteral(id);
      rows = await this.table!.query()
        .where(`id = '${safeId}'`)
        .limit(1)
        .toArray();
    } else {
      // Prefix match
      const all = await this.table!.query()
        .select([
          "id",
          "text",
          "vector",
          "category",
          "scope",
          "importance",
          "timestamp",
          "metadata",
        ])
        .limit(1000)
        .toArray();
      rows = all.filter((r: any) => (r.id as string).startsWith(id));
      if (rows.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    // Build updated entry, preserving original timestamp
    const updated: MemoryEntry = {
      id: row.id as string,
      text: updates.text ?? (row.text as string),
      vector: updates.vector ?? Array.from(row.vector as Iterable<number>),
      category: updates.category ?? (row.category as MemoryEntry["category"]),
      scope: rowScope,
      importance: updates.importance ?? Number(row.importance),
      timestamp: Number(row.timestamp), // preserve original
      metadata: updates.metadata ?? ((row.metadata as string) || "{}"),
    };

    // LanceDB doesn't support in-place update; delete + re-add
    const resolvedId = escapeSqlLiteral(row.id as string);
    await this.table!.delete(`id = '${resolvedId}'`);
    await this.table!.add([updated]);

    return updated;
  }

  async bulkDelete(
    scopeFilter: string[],
    beforeTimestamp?: number,
  ): Promise<number> {
    await this.ensureInitialized();

    const conditions: string[] = [];

    if (scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`(${scopeConditions})`);
    }

    if (beforeTimestamp) {
      conditions.push(`timestamp < ${beforeTimestamp}`);
    }

    if (conditions.length === 0) {
      throw new Error(
        "Bulk delete requires at least scope or timestamp filter for safety",
      );
    }

    const whereClause = conditions.join(" AND ");

    // Count first
    const countResults = await this.table!.query().where(whereClause).toArray();
    const deleteCount = countResults.length;

    // Then delete
    if (deleteCount > 0) {
      await this.table!.delete(whereClause);
    }

    return deleteCount;
  }

  /**
   * Decay old memories based on age, access count, and importance.
   * Returns the IDs of deleted memories.
   * Uses reinforcement-based decay: frequently accessed memories decay slower.
   */
  async decayOldMemories(options: {
    halfLifeDays?: number;
    minAgeDays?: number;
    minScoreThreshold?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
    dryRun?: boolean;
  } = {}): Promise<{ deletedIds: string[]; deletedCount: number }> {
    await this.ensureInitialized();

    const {
      halfLifeDays = 60,
      minAgeDays = 7,
      minScoreThreshold = 0.2,
      reinforcementFactor = 0.5,
      maxHalfLifeMultiplier = 3,
      dryRun = false,
    } = options;

    const now = Date.now();
    const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

    const allRows = await this.table!.query().toArray() as any[];
    const toDelete: string[] = [];

    for (const row of allRows) {
      const age = now - (row.timestamp as number);
      if (age < minAgeMs) continue;

      const ageDays = age / (24 * 60 * 60 * 1000);
      const importance = (row.importance as number) ?? 0.5;

      // Parse access count from metadata
      let accessCount = 0;
      let lastAccessedAt = 0;
      try {
        const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
        accessCount = metadata?.accessCount ?? 0;
        lastAccessedAt = metadata?.lastAccessedAt ?? 0;
      } catch { /* ignore parse errors */ }

      // Compute effective half-life with access reinforcement
      const effectiveHalfLife = this.computeEffectiveHalfLife(
        halfLifeDays,
        accessCount,
        lastAccessedAt,
        reinforcementFactor,
        maxHalfLifeMultiplier,
      );

      // Decay score: importance * access factor * age factor
      const accessFactor = 1 + Math.log10(accessCount + 1);
      const ageFactor = Math.max(0, 1 - ageDays / effectiveHalfLife);
      const score = importance * accessFactor * ageFactor;

      if (score < minScoreThreshold) {
        toDelete.push(row.id as string);
      }
    }

    if (!dryRun && toDelete.length > 0) {
      for (const id of toDelete) {
        const safeId = escapeSqlLiteral(id);
        await this.table!.delete(`id = '${safeId}'`);
      }
    }

    return { deletedIds: toDelete, deletedCount: toDelete.length };
  }

  /**
   * Compute effective half-life with access reinforcement.
   * Frequently accessed memories get longer effective half-lives.
   */
  private computeEffectiveHalfLife(
    baseHalfLifeDays: number,
    accessCount: number,
    lastAccessedAt: number,
    reinforcementFactor: number,
    maxMultiplier: number,
  ): number {
    if (reinforcementFactor === 0 || accessCount <= 0) {
      return baseHalfLifeDays;
    }

    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceLastAccess = lastAccessedAt > 0
      ? (now - lastAccessedAt) / msPerDay
      : 30; // Default to 30 days if never accessed

    // Access freshness: recent accesses count more
    const accessDecayHalfLife = 30; // days
    const accessFreshness = Math.pow(0.5, daysSinceLastAccess / accessDecayHalfLife);

    // Effective access count (decayed by time since last access)
    const effectiveAccessCount = accessCount * accessFreshness;

    // Reinforcement multiplier: log scale, capped at maxMultiplier
    const rawMultiplier = 1 + reinforcementFactor * Math.log2(effectiveAccessCount + 1);
    const multiplier = Math.min(maxMultiplier, Math.max(1, rawMultiplier));

    return baseHalfLifeDays * multiplier;
  }

  /**
   * Compute memory quality score for a single entry.
   * Quality = relevance * uniqueness * freshness * reinforcement
   */
  computeQualityScore(entry: MemoryEntry, options: {
    baseHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
  } = {}): {
    relevance: number;
    uniqueness: number;
    freshness: number;
    reinforcement: number;
    overall: number;
  } {
    const {
      baseHalfLifeDays = 60,
      reinforcementFactor = 0.5,
      maxHalfLifeMultiplier = 3,
    } = options;

    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    // 1. Relevance (based on importance field)
    const relevance = (entry.importance ?? 0.5);

    // 2. Uniqueness (based on vector norm - longer vectors tend to be more specific)
    let uniqueness = 0.5;
    if (entry.vector && entry.vector.length > 0) {
      const norm = Math.sqrt(entry.vector.reduce((sum, v) => sum + v * v, 0));
      uniqueness = Math.min(1, norm / 10); // Normalize to 0-1
    }

    // 3. Freshness (time decay)
    const ageDays = entry.timestamp ? (now - entry.timestamp) / msPerDay : 30;
    const freshness = Math.pow(0.5, ageDays / baseHalfLifeDays);

    // 4. Reinforcement (access count)
    let accessCount = 0;
    let lastAccessedAt = 0;
    try {
      const metadata = typeof entry.metadata === "string"
        ? JSON.parse(entry.metadata)
        : entry.metadata;
      accessCount = metadata?.accessCount ?? 0;
      lastAccessedAt = metadata?.lastAccessedAt ?? 0;
    } catch { /* ignore */ }

    const effectiveHalfLife = this.computeEffectiveHalfLife(
      baseHalfLifeDays,
      accessCount,
      lastAccessedAt,
      reinforcementFactor,
      maxHalfLifeMultiplier,
    );
    const reinforcement = Math.min(1, effectiveHalfLife / (baseHalfLifeDays * maxHalfLifeMultiplier));

    // 5. Overall quality score
    const overall = (relevance * 0.3 + uniqueness * 0.2 + freshness * 0.3 + reinforcement * 0.2);

    return { relevance, uniqueness, freshness, reinforcement, overall };
  }

  /**
   * Get memory quality statistics for all entries.
   */
  async getQualityStats(options: {
    scope?: string;
    category?: string;
    minScore?: number;
    sortBy?: "overall" | "relevance" | "freshness" | "reinforcement";
    limit?: number;
  } = {}): Promise<Array<MemoryEntry & { quality: ReturnType<MemoryStore["computeQualityScore"]> }>> {
    await this.ensureInitialized();

    const { scope, category, minScore = 0, sortBy = "overall", limit = 100 } = options;

    let rows = await this.table!.query().toArray() as MemoryEntry[];

    // Filter by scope/category if provided
    if (scope) {
      rows = rows.filter(r => r.scope === scope);
    }
    if (category) {
      rows = rows.filter(r => r.category === category);
    }

    // Compute quality scores
    const results = rows.map(entry => ({
      ...entry,
      quality: this.computeQualityScore(entry),
    }));

    // Filter by minimum score
    const filtered = results.filter(r => r.quality.overall >= minScore);

    // Sort
    filtered.sort((a, b) => b.quality[sortBy] - a.quality[sortBy]);

    return filtered.slice(0, limit);
  }

  /**
   * Deduplicate memories by semantic similarity.
   * Enhanced with:
   * - Semantic merge: combine similar memories into one
   * - Temporal merge: keep newer info when values change (e.g., IP addresses)
   * - Quality-based selection: keep higher quality entry
   */
  async deduplicateBySimilarity(options: {
    similarityThreshold?: number;
    mergeStrategy?: "keep-newer" | "keep-higher-quality" | "merge";
    dryRun?: boolean;
    onMerge?: (kept: MemoryEntry, removed: MemoryEntry) => void;
  } = {}): Promise<{
    removedIds: string[];
    removedCount: number;
    mergedPairs: Array<{ kept: string; removed: string; similarity: number }>;
  }> {
    await this.ensureInitialized();

    const {
      similarityThreshold = 0.95,
      mergeStrategy = "keep-higher-quality",
      dryRun = false,
      onMerge,
    } = options;

    const allRows = await this.table!.query().toArray() as MemoryEntry[];
    const toRemove: string[] = [];
    const mergedPairs: Array<{ kept: string; removed: string; similarity: number }> = [];
    const seen = new Map<string, MemoryEntry>();

    const cosineSimilarity = (a: number[], b: number[]): number => {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
    };

    // Detect if two texts represent the same entity with different values
    const detectValueChange = (text1: string, text2: string): {
      isValueChange: boolean;
      entity?: string;
      oldValue?: string;
      newValue?: string;
    } => {
      // Pattern: "X is Y" or "X = Y" or "X: Y"
      const patterns = [
        // IP addresses
        { regex: /(IP|ip_address|地址|服务器).*?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/gi, extract: (m: RegExpMatchArray) => ({ entity: m[1], value: m[2] }) },
        // URLs
        { regex: /(URL|url|链接|网站).*?(https?:\/\/[^\s]+)/gi, extract: (m: RegExpMatchArray) => ({ entity: m[1], value: m[2] }) },
        // Status
        { regex: /(状态|status).*?(running|stopped|error|success|active|inactive)/gi, extract: (m: RegExpMatchArray) => ({ entity: m[1], value: m[2] }) },
      ];

      for (const { regex, extract } of patterns) {
        const match1 = text1.match(regex);
        const match2 = text2.match(regex);

        if (match1 && match2) {
          const val1 = extract(match1);
          const val2 = extract(match2);
          if (val1.entity === val2.entity && val1.value !== val2.value) {
            return { isValueChange: true, entity: val1.entity, oldValue: val1.value, newValue: val2.value };
          }
        }
      }

      return { isValueChange: false };
    };

    for (const entry of allRows) {
      if (!entry.vector || entry.vector.length === 0) continue;

      let isDuplicate = false;
      let bestMatch: { entry: MemoryEntry; similarity: number } | null = null;

      for (const [_, existing] of seen) {
        if (!existing.vector) continue;
        const sim = cosineSimilarity(entry.vector, existing.vector);

        if (sim >= similarityThreshold) {
          isDuplicate = true;
          bestMatch = { entry: existing, similarity: sim };
          break;
        }
      }

      if (isDuplicate && bestMatch) {
        const existing = bestMatch.entry;

        // Check for value change (e.g., IP address updated)
        const valueChange = detectValueChange(existing.text, entry.text);

        let keepEntry: MemoryEntry;
        let removeEntry: MemoryEntry;

        if (valueChange.isValueChange && mergeStrategy === "keep-newer") {
          // Value changed - keep newer entry
          keepEntry = entry.timestamp > existing.timestamp ? entry : existing;
          removeEntry = entry.timestamp > existing.timestamp ? existing : entry;
        } else if (mergeStrategy === "keep-higher-quality") {
          // Keep higher quality entry
          const qualityExisting = this.computeQualityScore(existing);
          const qualityNew = this.computeQualityScore(entry);
          keepEntry = qualityNew.overall > qualityExisting.overall ? entry : existing;
          removeEntry = qualityNew.overall > qualityExisting.overall ? existing : entry;
        } else {
          // Default: keep higher importance
          keepEntry = (entry.importance ?? 0.5) > (existing.importance ?? 0.5) ? entry : existing;
          removeEntry = (entry.importance ?? 0.5) > (existing.importance ?? 0.5) ? existing : entry;
        }

        toRemove.push(removeEntry.id);
        mergedPairs.push({ kept: keepEntry.id, removed: removeEntry.id, similarity: bestMatch.similarity });

        // Update seen map
        seen.delete(existing.id);
        seen.set(keepEntry.id, keepEntry);

        onMerge?.(keepEntry, removeEntry);
      } else {
        seen.set(entry.id, entry);
      }
    }

    if (!dryRun && toRemove.length > 0) {
      for (const id of toRemove) {
        const safeId = escapeSqlLiteral(id);
        await this.table!.delete(`id = '${safeId}'`);
      }
    }

    return { removedIds: toRemove, removedCount: toRemove.length, mergedPairs };
  }

  /**
   * Filter sensitive information from text.
   * Returns sanitized text and list of removed patterns.
   */
  sanitizeText(text: string): { sanitized: string; removed: string[] } {
    const SENSITIVE_PATTERNS = [
      { name: "password", regex: /(password|passwd|pwd)[=:]\s*\S+/gi },
      { name: "api_key", regex: /(api[_-]?key|apikey)[=:]\s*\S+/gi },
      { name: "secret", regex: /(secret|token)[=:]\s*[a-zA-Z0-9_-]{10,}/gi },
      { name: "bearer", regex: /Bearer\s+[a-zA-Z0-9_-]{20,}/gi },
      { name: "private_key", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END/gi },
      { name: "connection_string", regex: /(mongodb|mysql|postgres|redis):\/\/[^\s]+/gi },
    ];

    let sanitized = text;
    const removed: string[] = [];

    for (const { name, regex } of SENSITIVE_PATTERNS) {
      const matches = text.match(regex);
      if (matches) {
        for (const match of matches) {
          removed.push(`[${name}] ${match.slice(0, 20)}...`);
          sanitized = sanitized.replace(match, `[${name}_REDACTED]`);
        }
      }
    }

    return { sanitized, removed };
  }

  /**
   * Store a memory entry with automatic sensitive info sanitization.
   */
  async storeSanitized(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
    options: { sanitize?: boolean } = {},
  ): Promise<MemoryEntry> {
    const { sanitize = true } = options;

    if (sanitize) {
      const { sanitized, removed } = this.sanitizeText(entry.text);
      if (removed.length > 0) {
        console.warn(`[memory-lancedb-pro] Sanitized ${removed.length} sensitive patterns`);
        entry.text = sanitized;
      }
    }

    return this.store(entry);
  }

  /**
   * Audit existing memories for sensitive information.
   */
  async auditSensitiveInfo(options: {
    dryRun?: boolean;
    onFound?: (entry: MemoryEntry, patterns: string[]) => void;
  } = {}): Promise<{ count: number; entries: Array<{ id: string; patterns: string[] }> }> {
    await this.ensureInitialized();

    const { dryRun = true, onFound } = options;
    const allRows = await this.table!.query().toArray() as MemoryEntry[];
    const findings: Array<{ id: string; patterns: string[] }> = [];

    for (const entry of allRows) {
      const { removed } = this.sanitizeText(entry.text);
      if (removed.length > 0) {
        findings.push({ id: entry.id, patterns: removed });
        onFound?.(entry, removed);

        if (!dryRun) {
          const { sanitized } = this.sanitizeText(entry.text);
          await this.update(entry.id, { text: sanitized });
        }
      }
    }

    return { count: findings.length, entries: findings };
  }

  get hasFtsSupport(): boolean {
    return this.ftsIndexCreated;
  }
}
