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
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { buildSmartMetadata, isMemoryActiveAt, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";

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

export interface MetadataPatch {
  [key: string]: unknown;
}

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;

// =========================================================================
// Cross-Process File Lock (proper-lockfile)
// =========================================================================

let lockfileModule: any = null;

async function loadLockfile(): Promise<any> {
  if (!lockfileModule) {
    lockfileModule = await import("proper-lockfile");
  }
  return lockfileModule;
}

/** For unit testing: override the lockfile module with a mock. */
export function __setLockfileModuleForTests(module: any): void {
  lockfileModule = module;
}

export const loadLanceDB = async (): Promise<
  typeof import("@lancedb/lancedb")
> => {
  if (!lancedbImportPromise) {
    // Use require() for CommonJS modules on Windows to avoid ESM URL scheme issues
    lancedbImportPromise = Promise.resolve(require("@lancedb/lancedb"));
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

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

function isExplicitDenyAllScopeFilter(scopeFilter?: string[]): boolean {
  return Array.isArray(scopeFilter) && scopeFilter.length === 0;
}

function scoreLexicalHit(query: string, candidates: Array<{ text: string; weight: number }>): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  let score = 0;
  for (const candidate of candidates) {
    const normalized = normalizeSearchText(candidate.text);
    if (!normalized) continue;
    if (normalized.includes(normalizedQuery)) {
      score = Math.max(score, Math.min(0.95, 0.72 + normalizedQuery.length * 0.02) * candidate.weight);
    }
  }

  return score;
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
  private updateQueue: Promise<void> = Promise.resolve();

  // Cross-call batch accumulator（Issue #690）
  // 多個 concurrent bulkStore() 會先累積在這裡，每 100ms flush 一次，
  // 合併成一個 lock acquisition，大幅降低 lock contention。
  private pendingBatch: Array<{
    entries: MemoryEntry[];
    resolve: (entries: MemoryEntry[]) => void;
    reject: (err: Error) => void;
    // 【F5/MR1 fix】記錄此 caller 的起始 chunk idx，用於 settlement 時查詢正確的 chunk error
    chunkIdx: number;
  }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushLock: Promise<void> = Promise.resolve(); // Promise-based lock，防止 concurrent doFlush()
  // 【MR4 fix】標記實例已摧毀，防止 destroy() 後 bulkStore() 悄悄重啟 timer
  private destroyed = false;
  // 【F2 fix】儲存最近一次 background timer flush 的錯誤，
  // 讓 explicit flush() 可以 rethrow 這個錯誤，避免 timer flush 失敗被吞掉
  private lastBackgroundError: { hasError: boolean; lastError?: Error } | null = null;
  private static readonly FLUSH_INTERVAL_MS = 100;
  // 單次 lock acquisition 上限。將大量 entries 拆分多個 chunk 寫入，
  // 每個 chunk 獨立 lock acquisition，失敗時只影響該 chunk（per-chunk isolation）。
  // LanceDB 本身無批次上限，此值參考 LanceDB 預設 row-group size（256）
  // 訂定，在兼顧併發吞吐與記憶體佔用下是一個合理的經驗值。
  private static readonly MAX_BATCH_SIZE = 250;
  // 【MR2 fix】pendingBatch 上限，防止高生產率時無限增長。
  // 當 pending callers 超過此值時，block 並同步 flush，確保 pendingBatch 不會無限膨胀。
  private static readonly MAX_PENDING_BATCH_SIZE = 1000;

  constructor(private readonly config: StoreConfig) { }

  private async runWithFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockfile = await loadLockfile();
    const lockPath = join(this.config.dbPath, ".memory-write.lock");
    if (!existsSync(lockPath)) {
      try { mkdirSync(dirname(lockPath), { recursive: true }); } catch {}
      try { const { writeFileSync } = await import("node:fs"); writeFileSync(lockPath, "", { flag: "wx" }); } catch {}
    }
    // 【修復 #415】調整 retries：max wait 從 ~3100ms → ~151秒
    // 指數退避：1s, 2s, 4s, 8s, 16s, 30s×5，總計約 151 秒
    // ECOMPROMISED 透過 onCompromised callback 觸發（非 throw），使用 flag 機制正確處理
    let isCompromised = false;
    let compromisedErr: unknown = null;
    let fnSucceeded = false;
    let fnError: unknown = null;

    // Proactive cleanup of stale lock artifacts（from PR #626）
    // 根本避免 >5 分鐘的 lock artifact 導致 ECOMPROMISED
    if (existsSync(lockPath)) {
      try {
        const stat = statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        const staleThresholdMs = 5 * 60 * 1000;
        if (ageMs > staleThresholdMs) {
          try { unlinkSync(lockPath); } catch {}
          console.warn(`[memory-lancedb-pro] cleared stale lock: ${lockPath} ageMs=${ageMs}`);
        }
      } catch {}
    }

    const release = await lockfile.lock(lockPath, {
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 1000, // James 保守設定：避免高負載下過度密集重試
        maxTimeout: 30000, // James 保守設定：支撐更久的 event loop 阻塞
      },
      stale: 10000, // 10 秒後視為 stale，觸發 ECOMPROMISED callback
                     // 注意：ECOMPROMISED 是 ambiguous degradation 訊號，mtime 無法區分
                     // "holder 崩潰" vs "holder event loop 阻塞"，所以不嘗試區分
      onCompromised: (err: unknown) => {
        // 【修復 #415 關鍵】必須是同步 callback
        // setLockAsCompromised() 不等待 Promise，async throw 無法傳回 caller
        isCompromised = true;
        compromisedErr = err;
      },
    });

    try {
      const result = await fn();
      fnSucceeded = true;
      return result;
    } catch (e: unknown) {
      fnError = e;
      throw e;
    } finally {
      // 【修復 #415 BUG】release() 必須在 isCompromised 判斷之前呼叫
      // 否則當 fnError !== null 且 isCompromised === true 時，release() 不會被呼叫，lock 永久洩漏
      try {
        await release();
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ERELEASED') {
          // ERELEASED 是預期行為（compromised lock release），忽略
        } else {
          // release() 錯誤優先於 fn() 錯誤：若 release 本身失敗，視為更嚴重的問題
          // 而非靜默忽略（這是有意的設計選擇，不反映 fn 的錯誤）
          throw e;
        }
      }
      if (isCompromised) {
        // fnError 優先：fn() 失敗時，fn 的錯誤比 compromised 重要
        if (fnError !== null) {
          throw fnError;
        }
        // fn() 尚未完成就 compromised → throw，讓 caller 知道要重試
        if (!fnSucceeded) {
          throw compromisedErr as Error;
        }
        // fn() 成功執行，但 lock 在執行期間被標記 compromised
        // 正確行為：回傳成功結果（資料已寫入），明確告知 caller 不要重試
        console.warn(
          `[memory-lancedb-pro] Returning successful result despite compromised lock at "${lockPath}". ` +
          `Callers must not retry this operation automatically.`,
        );
      }
    }
  }

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

      // Migrate legacy tables: add missing columns for backward compatibility
      try {
        const schema = await table.schema();
        const fieldNames = new Set(schema.fields.map((f: { name: string }) => f.name));

        const missingColumns: Array<{ name: string; valueSql: string }> = [];
        if (!fieldNames.has("scope")) {
          missingColumns.push({ name: "scope", valueSql: "'global'" });
        }
        if (!fieldNames.has("timestamp")) {
          missingColumns.push({ name: "timestamp", valueSql: "CAST(0 AS DOUBLE)" });
        }
        if (!fieldNames.has("metadata")) {
          missingColumns.push({ name: "metadata", valueSql: "'{}'" });
        }

        if (missingColumns.length > 0) {
          console.warn(
            `memory-lancedb-pro: migrating legacy table — adding columns: ${missingColumns.map((c) => c.name).join(", ")}`,
          );
          await table.addColumns(missingColumns);
          console.log(
            `memory-lancedb-pro: migration complete — ${missingColumns.length} column(s) added`,
          );
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes("already exists")) {
          // Concurrent initialization race — another process already added the columns
          console.log("memory-lancedb-pro: migration columns already exist (concurrent init)");
        } else {
          console.warn("memory-lancedb-pro: could not check/migrate table schema:", err);
        }
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
          config: (lancedb as any).Index.fts({ withPosition: true }),
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
    // F1 fix: store() now routes through bulkStore() accumulator
    // for consistent lock contention behavior (no per-call file lock).
    // MR2 fix: when pendingBatch is empty, immediate flush avoids 100ms delay.
    const results = await this.bulkStore([entry]);
    return results[0];
  }

  /**
   * Store multiple memory entries in a single batch operation.
   *
   * @param entries — array of entries to store (id/timestamp are auto-generated)
   * @returns resolved with persisted entries, or rejected on failure
   *
   * @remarks
   * Entries are accumulated and flushed every {@link FLUSH_INTERVAL_MS} (default 100ms),
   * or when {@link flush} is called. Multiple concurrent {@link bulkStore} calls are
   * automatically batched together for efficiency.
   *
   * **Non-atomicity for large batches**: When the total entry count exceeds
   * {@link MAX_BATCH_SIZE} (250), entries are split into multiple chunks and written
   * sequentially. If a later chunk fails, earlier chunks may already be persisted
   * in LanceDB — the Promise will be rejected but those entries will NOT be rolled back.
   * Callers should handle partial-success by catching the rejection and querying
   * by the returned entry IDs to determine which entries were actually persisted.
   *
   * @public
   */
  async bulkStore(
    entries: Omit<MemoryEntry, "id" | "timestamp">[],
  ): Promise<MemoryEntry[]> {
    // 【MR4 fix】阻止 destroy() 後的呼叫
    if (this.destroyed) {
      throw new Error("MemoryStore instance has been destroyed");
    }
    await this.ensureInitialized();

    // Filter out invalid entries（undefined, null, missing text/vector）
    const validEntries = entries.filter(
      (entry) => entry && entry.text && entry.text.length > 0 && entry.vector && entry.vector.length > 0
    );

    // Early return for empty array（skip accumulation）
    if (validEntries.length === 0) {
      return [];
    }

    // 附加 id/timestamp
    const fullEntries: MemoryEntry[] = validEntries.map((entry) => ({
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    }));

    // 【MR2 fix】當 pendingBatch 達到上限時，等待前一個 flush 完成後再加入
    // 這確保 pendingBatch 有上限，不會无限增长
    if (this.pendingBatch.length >= MemoryStore.MAX_PENDING_BATCH_SIZE) {
      // 等 flushLock 釋放（即上一個 doFlush 完成後）
      await this.flushLock;
    }

    // 【MR2 fix】單 caller fast path：當 pendingBatch 為空（無其他 caller 等待）時，
    // 立即 flush 不等 100ms timer，讓單次 store() call 無需額外延遲
    // TOCTOU fix: 先 await flushLock 再檢查 length，確保無 concurrent 兩個 caller
    // 同時通過 length===0 check 而導致 second doFlush() 跑空 batch（entries 消失）
    if (this.pendingBatch.length === 0) {
      await this.flushLock;
      // Double-check after await: another caller may have pushed while we were waiting
      if (this.pendingBatch.length === 0) {
        return new Promise<MemoryEntry[]>((resolve, reject) => {
          // chunkIdx=0：此 caller 的 entries 從 chunk 0 開始
          this.pendingBatch.push({ entries: fullEntries, resolve, reject, chunkIdx: 0 });
          // Immediate flush, no timer needed for single caller
          this.doFlush().catch((err) => {
            // 【F2 fix】，即使是 immediate flush 也保存錯誤
            this.lastBackgroundError = { hasError: true, lastError: err as Error };
            console.error(`[memory-lancedb-pro] immediate doFlush() error: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
      }
      // Another caller pushed while we waited — fall through to timer path
    }

    // 回錄小型 Promise，實際寫入在背景 flush 完成
    return new Promise<MemoryEntry[]>((resolve, reject) => {
      // 【F5/MR1 fix】計算此 caller 的起始 chunk idx
      // 現有 entries 總數決定了批次從哪個 chunk 開始
      const existingEntryCount = this.pendingBatch.reduce((sum, b) => sum + b.entries.length, 0);
      const chunkIdx = Math.floor(existingEntryCount / MemoryStore.MAX_BATCH_SIZE);
      this.pendingBatch.push({ entries: fullEntries, resolve, reject, chunkIdx });

      // 啟動定時 flush timer（若尚未啟動）
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          // 【MR3 fix】doFlush() 可能同步拋出（例如 LanceDB 同步錯誤），
          // fire-and-forget 若無 .catch() 會觸發 Node.js unhandled promise rejection
          // 【F2 fix】儲存錯誤，讓 explicit flush() 可 catch 並 rethrow
          // 避免 fire-and-forget timer error 被 Node.js unhandled rejection 吞掉
          this.doFlush().catch((err) => {
            this.lastBackgroundError = { hasError: true, lastError: err as Error };
            console.error(`[memory-lancedb-pro] doFlush() timer callback error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }, MemoryStore.FLUSH_INTERVAL_MS);
      }
    });
  }

  /**
   * Flush all pending batch entries in a single lock acquisition.
   * Called by the flush timer and on shutdown.
   * @returns {hasError: boolean, lastError?: Error} — error info so callers
   *   (flush/destroy) can rethrow without relying on shared instance state.
   */
  private async doFlush(): Promise<{ hasError: boolean; lastError?: Error }> {
    const prevLock = this.flushLock;
    let releaseLock: () => void;
    this.flushLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    await prevLock; // 等上一個 flush 完成後才開始
    let lastError: Error | undefined;
    try {
      if (this.pendingBatch.length === 0) return { hasError: false };

      // splice out the current batch（保護新進的 pending calls）
      const batch = this.pendingBatch.splice(0, this.pendingBatch.length);

      // 合併所有 entries（攤平每個 caller 的 entries，保持 caller 邊界資訊）
      const allEntries = batch.flatMap((b) => b.entries);

      // 【F5/MR1 fix】用 Map 儲存每個 chunk 的錯誤，而非只留 lastError
      // 這樣 settlement 時每個 caller 都能拿到自己所屬 chunk 的正確錯誤
      const chunkErrors = new Map<number, Error>();
      // failedCallers 追蹤哪些 caller 有 chunk 寫入失敗
      const failedCallers = new Set<number>();

      // 【修復 Issue #2: 自動分塊】
      // LanceDB 內部並無批次上限，本層主動分塊避免實際的底層限制
      for (let i = 0; i < allEntries.length; i += MemoryStore.MAX_BATCH_SIZE) {
        const chunk = allEntries.slice(i, i + MemoryStore.MAX_BATCH_SIZE);
        const chunkIdx = Math.floor(i / MemoryStore.MAX_BATCH_SIZE);
        try {
          await this.runWithFileLock(async () => {
            await this.table!.add(chunk);
          });
        } catch (err) {
          lastError = err as Error;
          // 標記此 chunk 區間內的所有 caller 為失敗
          let callerIdx = 0;
          let entryOffset = 0;
          for (const caller of batch) {
            const callerEnd = entryOffset + caller.entries.length;
            // 正確邏輯：chunk [i, i+MAX_BATCH_SIZE) 與 caller [entryOffset, callerEnd) 是否有交集
            // 交集條件：chunk.start < caller.end AND chunk.end > caller.start
            // 即 i < callerEnd AND i + MAX_BATCH_SIZE > entryOffset
            // entryOffset < callerEnd 在 for 迴圈中恆成立（callerEnd = entryOffset + caller.entries.length）
            if (i < callerEnd && i + MemoryStore.MAX_BATCH_SIZE > entryOffset) {
              failedCallers.add(callerIdx);
            }
            entryOffset = callerEnd;
            callerIdx++;
          }
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[memory-lancedb-pro] doFlush chunk [${chunkIdx}] failed: ${errorMsg}`);

          // 【F5/MR1 fix + Issue #5 fix】每個 chunk 錯誤儲存到 Map，讓 caller settlement
          // 時能查到自己的 chunk 錯誤，而非都用 lastError（一律都是最後一個 chunk 的錯誤）
          const chunkStart = i;
          const chunkEnd = Math.min(i + MemoryStore.MAX_BATCH_SIZE, allEntries.length);
          const chunkError = new Error(
            `batch flush failed at chunk [${chunkStart}, ${chunkEnd}): ${errorMsg}`,
            { cause: err as Error },
          );
          chunkErrors.set(chunkIdx, chunkError);
          lastError = chunkError;
        }
      }

      // 統一結算：根據 failedCallers 決定 resolve 或 reject
      // D7 fix: caller.reject() 可能拋出（當 caller promise 已被 resolve/reject 處理過），
      // 必須用 try/catch 包住，否則 for 迴圈會被中斷，導致後續 caller 完全未被結算
      // 【F5/MR1 fix】每個 caller 查自己的 chunkIdx 取得正確的 chunk error
      let callerIdx = 0;
      for (const caller of batch) {
        if (failedCallers.has(callerIdx)) {
          // 從 caller.chunkIdx 查這個 caller 所屬 chunk 的實際錯誤
          const callerError = chunkErrors.get(caller.chunkIdx) ?? lastError ?? new Error("flush failed");
          const chunkInfo = callerError.message.includes("chunk [")
            ? ` (${callerError.message.match(/chunk \[(\d+), (\d+)\]/)?.[0]})`
            : "";
          try {
            caller.reject(new Error(`batch flush failed${chunkInfo}`, { cause: callerError }));
          } catch (rejectErr) {
            console.error(`[memory-lancedb-pro] caller.reject() 拋出（可能被重複結算忽略）: ${rejectErr instanceof Error ? rejectErr.message : String(rejectErr)}`);
          }
        } else {
          caller.resolve(caller.entries);
        }
        callerIdx++;
      }
      return { hasError: failedCallers.size > 0, lastError };
    } finally {
      releaseLock!(); // 釋放 lock，讓下一個 flush 可以跑
    }
  }

  /**
   * Force flush all pending entries immediately.
   *
   * @remarks
   * By default, entries are flushed automatically every {@link FLUSH_INTERVAL_MS} (100ms).
   * Call this method when you need to ensure entries are persisted before a process exits
   * or before the {@link MemoryStore} instance becomes unreachable.
   *
   * **Error behavior**: If the flush fails, this method throws the last error from
   * the underlying LanceDB write operation. Partial entries may have been written
   * before the error occurred.
   *
   * @public
   */
  async flush(): Promise<void> {
    // D4 fix: 清除 timer 後等前一個 doFlush 完成
    // 避免 timer callback 已排程但清除動作在它執行前發生，導致重複 doFlush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushLock;
    // 【F2 fix】如果 background timer flush 失敗後又有新 entries 進來，
    // explicit flush() 這次 doFlush() 會成功並清除 lastBackgroundError
    // 如果 explicit flush() 呼叫時 pendingBatch 為空（代表上次 timer 失敗
    // 的 entries 已通過其他 retry 機制處理完），此時 rethrow lastBackgroundError
    // 讓 timer flush failure 不被吞掉
    if (this.pendingBatch.length === 0 && this.lastBackgroundError?.hasError) {
      const err = this.lastBackgroundError.lastError ?? new Error("background flush failed");
      this.lastBackgroundError = null;
      throw err;
    }
    const result = await this.doFlush();
    // 【F2 fix】成功後清除 background error（表示 error 已被 caller 看到）
    if (!result.hasError) {
      this.lastBackgroundError = null;
    }
    // 【修復 Issue #3: flush() error propagation】
    // doFlush() 回傳 error info，flush() 據此重新拋出（只保留最後一個以維持行為相容）
    if (result.hasError && result.lastError) {
      throw result.lastError;
    }
  }

  /**
   * Destroy the store instance and release all resources.
   *
   * @remarks
   * This method flushes all pending entries, clears the flush timer, and releases
   * the underlying LanceDB connection. After calling this method, the {@link MemoryStore}
   * instance must not be used.
   *
   * **Error behavior**: If the final flush fails, this method throws the last error from
   * the underlying LanceDB write operation. Callers should treat this as a critical error —
   * some entries may have been persisted but the instance is no longer usable.
   *
   * @public
   */
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // 【MR4 fix】設定 destroyed flag，阻止後續 bulkStore() 呼叫
    this.destroyed = true;
    const result = await this.doFlush();
    // 【修復 Issue #3: destroy() error propagation】
    if (result.hasError && result.lastError) {
      throw result.lastError;
    }
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

    return this.runWithFileLock(async () => {
      await this.table!.add([full]);
      return full;
    });
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

  /** Lightweight total row count via LanceDB countRows(). */
  async count(): Promise<number> {
    await this.ensureInitialized();
    return await this.table!.countRows();
  }

  async getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return null;

    const safeId = escapeSqlLiteral(id);
    const rows = await this.table!
      .query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "global";
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
      return null;
    }

    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: rowScope,
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[], options?: { excludeInactive?: boolean }): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const safeLimit = clampInt(limit, 1, 20);
    // Over-fetch more aggressively when filtering inactive records,
    // because superseded historical rows can crowd out active ones.
    const inactiveFilter = options?.excludeInactive ?? false;
    const overFetchMultiplier = inactiveFilter ? 20 : 10;
    const fetchLimit = Math.min(safeLimit * overFetchMultiplier, 200);

    let query = this.table!.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);

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

      const entry: MemoryEntry = {
        id: row.id as string,
        text: row.text as string,
        vector: row.vector as number[],
        category: row.category as MemoryEntry["category"],
        scope: rowScope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      };

      // Skip inactive (superseded) records when requested
      if (inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
        continue;
      }

      mapped.push({ entry, score });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const safeLimit = clampInt(limit, 1, 20);
    const inactiveFilter = options?.excludeInactive ?? false;
    // Over-fetch when filtering inactive records to avoid crowding
    const fetchLimit = inactiveFilter ? Math.min(safeLimit * 20, 200) : safeLimit;

    if (!this.ftsIndexCreated) {
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    }

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(fetchLimit);

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

        const entry: MemoryEntry = {
            id: row.id as string,
            text: row.text as string,
            vector: row.vector as number[],
            category: row.category as MemoryEntry["category"],
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: (row.metadata as string) || "{}",
        };

        // Skip inactive (superseded) records when requested
        if (inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
          continue;
        }

        mapped.push({ entry, score: normalizedScore });

        if (mapped.length >= safeLimit) break;
      }

      if (mapped.length > 0) {
        return mapped;
      }
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    } catch (err) {
      console.warn("BM25 search failed, falling back to empty results:", err);
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
    }
  }

  private async lexicalFallbackSearch(query: string, limit: number, scopeFilter?: string[], options?: { excludeInactive?: boolean }): Promise<MemorySearchResult[]> {
    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let searchQuery = this.table!.query().select([
      "id",
      "text",
      "vector",
      "category",
      "scope",
      "importance",
      "timestamp",
      "metadata",
    ]);

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
    }

    const rows = await searchQuery.toArray();
    const matches: MemorySearchResult[] = [];

    for (const row of rows) {
      const rowScope = (row.scope as string | undefined) ?? "global";
      if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
        continue;
      }

      const entry: MemoryEntry = {
        id: row.id as string,
        text: row.text as string,
        vector: row.vector as number[],
        category: row.category as MemoryEntry["category"],
        scope: rowScope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      };

      const metadata = parseSmartMetadata(entry.metadata, entry);

      // Skip inactive (superseded) records when requested
      if (options?.excludeInactive && !isMemoryActiveAt(metadata)) {
        continue;
      }

      const score = scoreLexicalHit(trimmedQuery, [
        { text: entry.text, weight: 1 },
        { text: metadata.l0_abstract, weight: 0.98 },
        { text: metadata.l1_overview, weight: 0.92 },
        { text: metadata.l2_content, weight: 0.96 },
      ]);

      if (score <= 0) continue;
      matches.push({ entry, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit);
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

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

    return this.runWithFileLock(async () => {
      await this.table!.delete(`id = '${resolvedId}'`);
      return true;
    });
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    if (isExplicitDenyAllScopeFilter(scopeFilter)) return [];

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

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      return {
        totalCount: 0,
        scopeCounts: {},
        categoryCounts: {},
      };
    }

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

    if (isExplicitDenyAllScopeFilter(scopeFilter)) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    return this.runWithFileLock(() => this.runSerializedUpdate(async () => {
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

      const original: MemoryEntry = {
        id: row.id as string,
        text: row.text as string,
        vector: Array.from(row.vector as Iterable<number>),
        category: row.category as MemoryEntry["category"],
        scope: rowScope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      };

      // Build updated entry, preserving original timestamp
      const updated: MemoryEntry = {
        ...original,
        text: updates.text ?? original.text,
        vector: updates.vector ?? original.vector,
        category: updates.category ?? original.category,
        scope: rowScope,
        importance: updates.importance ?? original.importance,
        timestamp: original.timestamp, // preserve original
        metadata: updates.metadata ?? original.metadata,
      };

      // LanceDB doesn't support in-place update; delete + re-add.
      // Serialize updates per store instance to avoid stale rollback races.
      // If the add fails after delete, attempt best-effort recovery without
      // overwriting a newer concurrent successful update.
      const rollbackCandidate =
        (await this.getById(original.id).catch(() => null)) ?? original;
      const resolvedId = escapeSqlLiteral(row.id as string);
      await this.table!.delete(`id = '${resolvedId}'`);
      try {
        await this.table!.add([updated]);
      } catch (addError) {
        const current = await this.getById(original.id).catch(() => null);
        if (current) {
          throw new Error(
            `Failed to update memory ${id}: write failed after delete, but an existing record was preserved. ` +
            `Write error: ${addError instanceof Error ? addError.message : String(addError)}`,
          );
        }

        try {
          await this.table!.add([rollbackCandidate]);
        } catch (rollbackError) {
          throw new Error(
            `Failed to update memory ${id}: write failed after delete, and rollback also failed. ` +
            `Write error: ${addError instanceof Error ? addError.message : String(addError)}. ` +
            `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }

        throw new Error(
          `Failed to update memory ${id}: write failed after delete, latest available record restored. ` +
          `Write error: ${addError instanceof Error ? addError.message : String(addError)}`,
        );
      }

      return updated;
    }));
  }

  private async runSerializedUpdate<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.updateQueue;
    let release: (() => void) | undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.updateQueue = previous.then(() => lock);

    await previous;
    try {
      return await action();
    } finally {
      release?.();
    }
  }

  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    const existing = await this.getById(id, scopeFilter);
    if (!existing) return null;

    const metadata = buildSmartMetadata(existing, patch);
    return this.update(
      id,
      { metadata: stringifySmartMetadata(metadata) },
      scopeFilter,
    );
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
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

    return this.runWithFileLock(async () => {
      // Count first
      const countResults = await this.table!.query().where(whereClause).toArray();
      const deleteCount = countResults.length;

      // Then delete
      if (deleteCount > 0) {
        await this.table!.delete(whereClause);
      }

      return deleteCount;
    });
  }

  get hasFtsSupport(): boolean {
    return this.ftsIndexCreated;
  }

  /** Last FTS error for diagnostics */
  private _lastFtsError: string | null = null;

  get lastFtsError(): string | null {
    return this._lastFtsError;
  }

  /** Get FTS index health status */
  getFtsStatus(): { available: boolean; lastError: string | null } {
    return {
      available: this.ftsIndexCreated,
      lastError: this._lastFtsError,
    };
  }

  /** Rebuild FTS index (drops and recreates). Useful for recovery after corruption. */
  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized();
    try {
      // Drop existing FTS index if any
      const indices = await this.table!.listIndices();
      for (const idx of indices) {
        if (idx.indexType === "FTS" || idx.columns?.includes("text")) {
          try {
            await this.table!.dropIndex((idx as any).name || "text");
          } catch (err) {
            console.warn(`memory-lancedb-pro: dropIndex(${(idx as any).name || "text"}) failed:`, err);
          }
        }
      }
      // Recreate
      await this.createFtsIndex(this.table!);
      this.ftsIndexCreated = true;
      this._lastFtsError = null;
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastFtsError = msg;
      this.ftsIndexCreated = false;
      return { success: false, error: msg };
    }
  }

  /**
   * Fetch memories older than `maxTimestamp` including their raw vectors.
   * Used exclusively by the memory compactor; vectors are intentionally
   * omitted from `list()` for performance, but compaction needs them for
   * cosine-similarity clustering.
   */
  async fetchForCompaction(
    maxTimestamp: number,
    scopeFilter?: string[],
    limit = 200,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const conditions: string[] = [`timestamp < ${maxTimestamp}`];

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
    }

    const whereClause = conditions.join(" AND ");

    const results = await this.table!
      .query()
      .where(whereClause)
      .toArray();

    return results
      .slice(0, limit)
      .map(
        (row): MemoryEntry => ({
          id: row.id as string,
          text: row.text as string,
          vector: Array.isArray(row.vector) ? (row.vector as number[]) : [],
          category: row.category as MemoryEntry["category"],
          scope: (row.scope as string | undefined) ?? "global",
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        }),
      );
  }
}
