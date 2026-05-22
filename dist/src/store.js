/**
 * LanceDB Storage Layer with Multi-Scope Support
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, accessSync, constants, mkdirSync, realpathSync, lstatSync, statSync, unlinkSync, rmdirSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmartMetadata, isMemoryActiveAt, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
// ============================================================================
// LanceDB Dynamic Import
// ============================================================================
let lancedbImportPromise = null;
const requireCJS = createRequire(import.meta.url);
// =========================================================================
// Cross-Process File Lock (proper-lockfile)
// =========================================================================
let lockfileModule = null;
async function loadLockfile() {
    if (!lockfileModule) {
        lockfileModule = await import("proper-lockfile");
    }
    return lockfileModule;
}
/** For unit testing: override the lockfile module with a mock. */
export function __setLockfileModuleForTests(module) {
    lockfileModule = module;
}
export const loadLanceDB = async () => {
    if (!lancedbImportPromise) {
        // Use a createRequire-built require() so LanceDB's CommonJS native bindings
        // keep Windows-safe CJS semantics while still working in pure ESM runtimes.
        // Do not name this binding "require": bundlers may rewrite bare require()
        // calls to their ESM shim, which is what broke OpenClaw 2026.5+ loading.
        lancedbImportPromise = Promise.resolve(requireCJS("@lancedb/lancedb"));
    }
    try {
        return await lancedbImportPromise;
    }
    catch (err) {
        throw new Error(`memory-lancedb-pro: failed to load LanceDB. ${String(err)}`, { cause: err });
    }
};
// ============================================================================
// Utility Functions
// ============================================================================
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
const LEGACY_SECONDS_TIMESTAMP_MAX = 1_000_000_000_000;
export function normalizeMemoryTimestamp(value, fallback = Date.now()) {
    const raw = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
            ? value
            : Number(value);
    if (!Number.isFinite(raw) || raw <= 0) {
        return fallback;
    }
    const timestamp = Math.floor(raw);
    return timestamp < LEGACY_SECONDS_TIMESTAMP_MAX ? timestamp * 1000 : timestamp;
}
function normalizePredicateTimestamp(value) {
    const raw = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
            ? value
            : Number(value);
    if (!Number.isFinite(raw) || raw <= 0) {
        return null;
    }
    return normalizeMemoryTimestamp(raw);
}
function isLegacySecondTimestamp(value) {
    const raw = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
            ? value
            : Number(value);
    return Number.isFinite(raw) && raw > 0 && Math.floor(raw) < LEGACY_SECONDS_TIMESTAMP_MAX;
}
function timestampBeforePredicate(column, value) {
    const maxTimestamp = normalizePredicateTimestamp(value);
    if (maxTimestamp == null) {
        return "(FALSE)";
    }
    const legacySecondsCutoff = Math.ceil(maxTimestamp / 1000);
    return `((${column} >= ${LEGACY_SECONDS_TIMESTAMP_MAX} AND ${column} < ${maxTimestamp}) OR ` +
        `(${column} > 0 AND ${column} < ${LEGACY_SECONDS_TIMESTAMP_MAX} AND ${column} < ${legacySecondsCutoff}))`;
}
function parseMetadataObject(value) {
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
        }
        catch {
            return null;
        }
    }
    else if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ...value };
    }
    else {
        return {};
    }
}
function metadataHasLegacySecondTimestamp(value) {
    const metadata = parseMetadataObject(value);
    return metadata != null &&
        Object.prototype.hasOwnProperty.call(metadata, "last_accessed_at") &&
        isLegacySecondTimestamp(metadata.last_accessed_at);
}
function normalizeLegacyTimestampMetadata(value) {
    const metadata = parseMetadataObject(value);
    if (metadata == null) {
        return typeof value === "string" ? value : "{}";
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "last_accessed_at")) {
        metadata.last_accessed_at = normalizeMemoryTimestamp(metadata.last_accessed_at, 0);
    }
    return JSON.stringify(metadata);
}
function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}
function normalizeSearchText(value) {
    return value.toLowerCase().trim();
}
function isExplicitDenyAllScopeFilter(scopeFilter) {
    return Array.isArray(scopeFilter) && scopeFilter.length === 0;
}
function scoreLexicalHit(query, candidates) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery)
        return 0;
    let score = 0;
    for (const candidate of candidates) {
        const normalized = normalizeSearchText(candidate.text);
        if (!normalized)
            continue;
        if (normalized.includes(normalizedQuery)) {
            score = Math.max(score, Math.min(0.95, 0.72 + normalizedQuery.length * 0.02) * candidate.weight);
        }
    }
    return score;
}
// ============================================================================
// Storage Path Validation
// ============================================================================
function fileUrlToWindowsPath(url) {
    const host = url.hostname && url.hostname !== "localhost" ? url.hostname : "";
    const pathname = decodeURIComponent(url.pathname);
    if (host) {
        return `\\\\${host}${pathname.replace(/\//g, "\\")}`;
    }
    const withoutDriveSlash = /^\/[a-zA-Z]:/.test(pathname)
        ? pathname.slice(1)
        : pathname;
    return withoutDriveSlash.replace(/\//g, "\\");
}
export function normalizeStoragePath(dbPath, platform = process.platform) {
    const trimmed = dbPath.trim();
    if (!trimmed.startsWith("file://"))
        return dbPath;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "file:")
            return dbPath;
        return platform === "win32"
            ? fileUrlToWindowsPath(url)
            : fileURLToPath(url);
    }
    catch {
        return dbPath;
    }
}
/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath) {
    let resolvedPath = normalizeStoragePath(dbPath);
    // Resolve symlinks (including dangling symlinks)
    try {
        const stats = lstatSync(dbPath);
        if (stats.isSymbolicLink()) {
            try {
                resolvedPath = realpathSync(dbPath);
            }
            catch (err) {
                throw new Error(`dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
                    `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
                    `  Details: ${err.code || ""} ${err.message}`);
            }
        }
    }
    catch (err) {
        // Missing path is OK (it will be created below)
        if (err?.code === "ENOENT") {
            // no-op
        }
        else if (typeof err?.message === "string" &&
            err.message.includes("symlink whose target does not exist")) {
            throw err;
        }
        else {
            // Other lstat failures — continue with original path
        }
    }
    // Create directory if it doesn't exist
    if (!existsSync(resolvedPath)) {
        try {
            mkdirSync(resolvedPath, { recursive: true });
        }
        catch (err) {
            throw new Error(`Failed to create dbPath directory "${resolvedPath}".\n` +
                `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
                `       or create it manually: mkdir -p "${resolvedPath}"\n` +
                `  Details: ${err.code || ""} ${err.message}`);
        }
    }
    // Check write permissions
    try {
        accessSync(resolvedPath, constants.W_OK);
    }
    catch (err) {
        throw new Error(`dbPath directory "${resolvedPath}" is not writable.\n` +
            `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
            `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
            `  Details: ${err.code || ""} ${err.message}`);
    }
    return resolvedPath;
}
// ============================================================================
// Memory Store
// ============================================================================
const TABLE_NAME = "memories";
export class MemoryStore {
    db = null;
    table = null;
    initPromise = null;
    ftsIndexCreated = false;
    updateQueue = Promise.resolve();
    // Cross-call batch accumulator（Issue #690）
    // 多個 concurrent bulkStore() 會先累積在這裡，每 100ms flush 一次，
    // 合併成一個 lock acquisition，大幅降低 lock contention。
    pendingBatch = [];
    flushTimer = null;
    flushLock = Promise.resolve(); // Promise-based lock，防止 concurrent doFlush()
    // 【MR4 fix】標記實例已摧毀，防止 destroy() 後 bulkStore() 悄悄重啟 timer
    destroyed = false;
    // 【F2 fix】儲存最近一次 background timer flush 的錯誤，
    // 讓 explicit flush() 可以 rethrow 這個錯誤，避免 timer flush 失敗被吞掉
    lastBackgroundError = null;
    static FLUSH_INTERVAL_MS = 100;
    // 單次 lock acquisition 上限。將大量 entries 拆分多個 chunk 寫入，
    // 每個 chunk 獨立 lock acquisition，失敗時只影響該 chunk（per-chunk isolation）。
    // LanceDB 本身無批次上限，此值參考 LanceDB 預設 row-group size（256）
    // 訂定，在兼顧併發吞吐與記憶體佔用下是一個合理的經驗值。
    static MAX_BATCH_SIZE = 250;
    // 【MR2 fix】pendingBatch 上限，防止高生產率時無限增長。
    // 當 pending callers 超過此值時，block 並同步 flush，確保 pendingBatch 不會無限膨胀。
    static MAX_PENDING_BATCH_SIZE = 1000;
    config;
    constructor(config) {
        this.config = {
            ...config,
            dbPath: normalizeStoragePath(config.dbPath),
        };
    }
    async runWithFileLock(fn) {
        const lockfile = await loadLockfile();
        const lockPath = join(this.config.dbPath, ".memory-write.lock");
        const lockArtifactPath = `${lockPath}.lock`;
        const ensureLockTargetExists = async () => {
            if (!existsSync(lockPath)) {
                try {
                    mkdirSync(dirname(lockPath), { recursive: true });
                }
                catch { }
                try {
                    const { writeFileSync } = await import("node:fs");
                    writeFileSync(lockPath, "", { flag: "wx" });
                }
                catch { }
            }
        };
        await ensureLockTargetExists();
        // 【修復 #415】調整 retries：max wait 從 ~3100ms → ~151秒
        // 指數退避：1s, 2s, 4s, 8s, 16s, 30s×5，總計約 151 秒
        // ECOMPROMISED 透過 onCompromised callback 觸發（非 throw），使用 flag 機制正確處理
        let isCompromised = false;
        let compromisedErr = null;
        let fnSucceeded = false;
        let fnError = null;
        // Proactive cleanup of stale proper-lockfile artifacts（from PR #626）.
        // proper-lockfile locks the target by creating `${target}.lock`; the
        // target file itself is expected to persist and must not be treated stale.
        if (existsSync(lockArtifactPath)) {
            try {
                const stat = statSync(lockArtifactPath);
                const ageMs = Date.now() - stat.mtimeMs;
                const staleThresholdMs = 5 * 60 * 1000;
                if (ageMs > staleThresholdMs) {
                    try {
                        if (stat.isDirectory()) {
                            rmdirSync(lockArtifactPath);
                        }
                        else {
                            unlinkSync(lockArtifactPath);
                        }
                        console.warn(`[memory-lancedb-pro] cleared stale lock artifact: ${lockArtifactPath} ageMs=${ageMs}`);
                    }
                    catch { }
                }
            }
            catch { }
        }
        const acquireLock = async () => lockfile.lock(lockPath, {
            // 【修復 #670】realpath:false — 避免 proactive cleanup 刪除 stale lock artifact 後，
            // proper-lockfile v4 的 realpath() 在已刪除檔案上被呼叫，導致 ENOENT。
            // 情境：T=0 proactive cleanup 刪除 stale lock → T=3ms lock() 的 realpath() → ENOENT
            // 根本原因：v4 proper-lockfile 的 resolveCanonicalPath 預設呼叫 fs.realpath()。
            // 解決：realpath:false 完全繞過 realpath()，對 lock file 場景完全無副作用。
            realpath: false,
            retries: {
                retries: 10,
                factor: 2,
                minTimeout: 1000, // James 保守設定：避免高負載下過度密集重試
                maxTimeout: 30000, // James 保守設定：支撐更久的 event loop 阻塞
            },
            stale: 10000, // 10 秒後視為 stale，觸發 ECOMPROMISED callback
            // 注意：ECOMPROMISED 是 ambiguous degradation 訊號，mtime 無法區分
            // "holder 崩潰" vs "holder event loop 阻塞"，所以不嘗試區分
            onCompromised: (err) => {
                // 【修復 #415 關鍵】必須是同步 callback
                // setLockAsCompromised() 不等待 Promise，async throw 無法傳回 caller
                isCompromised = true;
                compromisedErr = err;
            },
        });
        let release;
        try {
            release = await acquireLock();
        }
        catch (err) {
            if (err.code === "ENOENT") {
                await ensureLockTargetExists();
                release = await acquireLock();
            }
            else {
                throw err;
            }
        }
        try {
            const result = await fn();
            fnSucceeded = true;
            return result;
        }
        catch (e) {
            fnError = e;
            throw e;
        }
        finally {
            // 【修復 #415 BUG】release() 必須在 isCompromised 判斷之前呼叫
            // 否則當 fnError !== null 且 isCompromised === true 時，release() 不會被呼叫，lock 永久洩漏
            try {
                await release();
            }
            catch (e) {
                if (e.code === 'ERELEASED') {
                    // ERELEASED 是預期行為（compromised lock release），忽略
                }
                else {
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
                    throw compromisedErr;
                }
                // fn() 成功執行，但 lock 在執行期間被標記 compromised
                // 正確行為：回傳成功結果（資料已寫入），明確告知 caller 不要重試
                console.warn(`[memory-lancedb-pro] Returning successful result despite compromised lock at "${lockPath}". ` +
                    `Callers must not retry this operation automatically.`);
            }
        }
    }
    get dbPath() {
        return this.config.dbPath;
    }
    async ensureInitialized() {
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
    async doInitialize() {
        const lancedb = await loadLanceDB();
        let db;
        try {
            db = await lancedb.connect(this.config.dbPath);
        }
        catch (err) {
            const code = err.code || "";
            const message = err.message || String(err);
            throw new Error(`Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
                `  Fix: Verify the path exists and is writable. Check parent directory permissions.`);
        }
        let table;
        // Idempotent table init: try openTable first, create only if missing,
        // and handle the race where tableNames() misses an existing table but
        // createTable then sees it (LanceDB eventual consistency).
        try {
            table = await db.openTable(TABLE_NAME);
            // Migrate legacy tables: add missing columns for backward compatibility
            try {
                const schema = await table.schema();
                const fieldNames = new Set(schema.fields.map((f) => f.name));
                const missingColumns = [];
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
                    console.warn(`memory-lancedb-pro: migrating legacy table — adding columns: ${missingColumns.map((c) => c.name).join(", ")}`);
                    await table.addColumns(missingColumns);
                    console.log(`memory-lancedb-pro: migration complete — ${missingColumns.length} column(s) added`);
                }
            }
            catch (err) {
                const msg = String(err);
                if (msg.includes("already exists")) {
                    // Concurrent initialization race — another process already added the columns
                    console.log("memory-lancedb-pro: migration columns already exist (concurrent init)");
                }
                else {
                    console.warn("memory-lancedb-pro: could not check/migrate table schema:", err);
                }
            }
        }
        catch (_openErr) {
            // Table doesn't exist yet — create it
            const schemaEntry = {
                id: "__schema__",
                text: "",
                vector: Array.from({ length: this.config.vectorDim }).fill(0),
                category: "other",
                scope: "global",
                importance: 0,
                timestamp: 0,
                metadata: "{}",
            };
            try {
                table = await db.createTable(TABLE_NAME, [schemaEntry]);
                await table.delete('id = "__schema__"');
            }
            catch (createErr) {
                // Race: another caller (or eventual consistency) created the table
                // between our failed openTable and this createTable — just open it.
                if (String(createErr).includes("already exists")) {
                    table = await db.openTable(TABLE_NAME);
                }
                else {
                    throw createErr;
                }
            }
        }
        await this.backfillLegacySecondTimestamps(table);
        // Validate vector dimensions
        // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
        // Array.isArray() returns false for Arrow Vectors, so use .length instead.
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && sample[0]?.vector?.length) {
            const existingDim = sample[0].vector.length;
            if (existingDim !== this.config.vectorDim) {
                throw new Error(`Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`);
            }
        }
        // Create FTS index for BM25 search (graceful fallback if unavailable)
        try {
            await this.createFtsIndex(table);
            this.ftsIndexCreated = true;
        }
        catch (err) {
            console.warn("Failed to create FTS index, falling back to vector-only search:", err);
            this.ftsIndexCreated = false;
        }
        this.db = db;
        this.table = table;
    }
    async backfillLegacySecondTimestamps(table) {
        try {
            let normalizedCount = 0;
            await this.runWithFileLock(async () => {
                const candidateRows = await table.query()
                    .where(`(timestamp > 0 AND timestamp < ${LEGACY_SECONDS_TIMESTAMP_MAX}) OR ` +
                    `(metadata IS NOT NULL AND metadata != '{}' AND metadata != '')`)
                    .toArray();
                if (candidateRows.length === 0)
                    return;
                const legacyRows = candidateRows.filter((row) => isLegacySecondTimestamp(row.timestamp) ||
                    metadataHasLegacySecondTimestamp(row.metadata));
                if (legacyRows.length === 0)
                    return;
                for (const row of legacyRows) {
                    const originalRow = {
                        ...row,
                        vector: Array.from(row.vector),
                        scope: row.scope ?? "global",
                        metadata: row.metadata || "{}",
                    };
                    const normalizedRow = {
                        ...originalRow,
                        metadata: normalizeLegacyTimestampMetadata(row.metadata),
                        timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
                    };
                    const safeId = escapeSqlLiteral(row.id);
                    const backupPath = this.writeLegacyTimestampBackfillBackup(originalRow);
                    await table.delete(`id = '${safeId}'`);
                    try {
                        await table.add([normalizedRow]);
                        this.clearLegacyTimestampBackfillBackup(backupPath);
                        normalizedCount += 1;
                    }
                    catch (addError) {
                        const currentRows = await table.query()
                            .where(`id = '${safeId}'`)
                            .limit(1)
                            .toArray()
                            .catch(() => []);
                        if (currentRows.length > 0) {
                            this.clearLegacyTimestampBackfillBackup(backupPath);
                            throw new Error(`legacy timestamp normalization failed for ${row.id}: replacement write failed after delete, but an existing record was preserved. ` +
                                `Write error: ${addError instanceof Error ? addError.message : String(addError)}`);
                        }
                        if (currentRows.length === 0) {
                            try {
                                await table.add([originalRow]);
                                this.clearLegacyTimestampBackfillBackup(backupPath);
                            }
                            catch (rollbackError) {
                                throw new Error(`legacy timestamp normalization failed for ${row.id}: replacement write failed after delete, and rollback also failed. ` +
                                    `Durable backup saved at ${backupPath}. ` +
                                    `Write error: ${addError instanceof Error ? addError.message : String(addError)}. ` +
                                    `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
                            }
                        }
                        throw new Error(`legacy timestamp normalization failed for ${row.id}: replacement write failed after delete, original row restored. ` +
                            `Write error: ${addError instanceof Error ? addError.message : String(addError)}`);
                    }
                }
            });
            if (normalizedCount > 0) {
                console.log(`memory-lancedb-pro: normalized ${normalizedCount} legacy second timestamp row(s)`);
            }
        }
        catch (err) {
            console.warn("memory-lancedb-pro: could not normalize legacy second timestamps:", err);
            if (String(err).includes("Durable backup saved at")) {
                throw err;
            }
        }
    }
    writeLegacyTimestampBackfillBackup(row) {
        const backupDir = join(this.config.dbPath, ".legacy-timestamp-backfill-backups");
        mkdirSync(backupDir, { recursive: true });
        const backupPath = join(backupDir, `${encodeURIComponent(String(row.id))}.json`);
        writeFileSync(backupPath, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), row }, null, 2)}\n`, "utf8");
        return backupPath;
    }
    clearLegacyTimestampBackfillBackup(backupPath) {
        try {
            unlinkSync(backupPath);
        }
        catch (err) {
            if (err?.code !== "ENOENT") {
                console.warn(`memory-lancedb-pro: could not remove legacy timestamp backup ${backupPath}:`, err);
            }
        }
    }
    async createFtsIndex(table) {
        try {
            // Check if FTS index already exists
            const indices = await table.listIndices();
            const hasFtsIndex = indices?.some((idx) => idx.indexType === "FTS" || idx.columns?.includes("text"));
            if (!hasFtsIndex) {
                // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
                const lancedb = await loadLanceDB();
                await table.createIndex("text", {
                    config: lancedb.Index.fts({ withPosition: true }),
                });
            }
        }
        catch (err) {
            throw new Error(`FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async store(entry) {
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
    async bulkStore(entries) {
        // 【MR4 fix】阻止 destroy() 後的呼叫
        if (this.destroyed) {
            throw new Error("MemoryStore instance has been destroyed");
        }
        await this.ensureInitialized();
        // Filter out invalid entries（undefined, null, missing text/vector）
        const validEntries = entries.filter((entry) => {
            const candidate = entry;
            return (!!candidate &&
                typeof candidate.text === "string" &&
                candidate.text.length > 0 &&
                Array.isArray(candidate.vector) &&
                candidate.vector.length > 0);
        });
        // Early return for empty array（skip accumulation）
        if (validEntries.length === 0) {
            return [];
        }
        // 附加 id/timestamp
        const fullEntries = validEntries.map((entry) => ({
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
                return new Promise((resolve, reject) => {
                    // chunkIdx=0：此 caller 的 entries 從 chunk 0 開始
                    this.pendingBatch.push({ entries: fullEntries, resolve, reject, chunkIdx: 0 });
                    // Immediate flush, no timer needed for single caller
                    // 【F2 fix】doFlush() 回傳 { hasError, lastError } 而非 throw，所以用 .then() + .catch()
                    // .catch(): doFlush() 同步階段 throw（如 flushLock acquisition 失敗）
                    // .then(): settlement loop 內部 catch 並回傳 { hasError: true } 的情況
                    this.doFlush().then((result) => {
                        if (result.hasError && result.lastError) {
                            this.lastBackgroundError = { hasError: true, lastError: result.lastError };
                            console.error(`[memory-lancedb-pro] immediate doFlush() error: ${result.lastError instanceof Error ? result.lastError.message : String(result.lastError)}`);
                        }
                    }).catch((err) => {
                        // 【F2 fix】同步 throw 的情況（很少見）
                        this.lastBackgroundError = { hasError: true, lastError: err };
                        console.error(`[memory-lancedb-pro] immediate doFlush() error: ${err instanceof Error ? err.message : String(err)}`);
                    });
                });
            }
            // Another caller pushed while we waited — fall through to timer path
        }
        // 回錄小型 Promise，實際寫入在背景 flush 完成
        return new Promise((resolve, reject) => {
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
                    this.doFlush().then((result) => {
                        if (result.hasError && result.lastError) {
                            this.lastBackgroundError = { hasError: true, lastError: result.lastError };
                            console.error(`[memory-lancedb-pro] doFlush() timer callback error: ${result.lastError instanceof Error ? result.lastError.message : String(result.lastError)}`);
                        }
                    }).catch((err) => {
                        // 同步 throw 的情況
                        this.lastBackgroundError = { hasError: true, lastError: err };
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
    async doFlush() {
        const prevLock = this.flushLock;
        let releaseLock;
        this.flushLock = new Promise((resolve) => { releaseLock = resolve; });
        await prevLock; // 等上一個 flush 完成後才開始
        let lastError;
        try {
            if (this.pendingBatch.length === 0)
                return { hasError: false };
            // splice out the current batch（保護新進的 pending calls）
            const batch = this.pendingBatch.splice(0, this.pendingBatch.length);
            // 合併所有 entries（攤平每個 caller 的 entries，保持 caller 邊界資訊）
            const allEntries = batch.flatMap((b) => b.entries);
            // 【F5/MR1 fix】用 Map 儲存每個 chunk 的錯誤，而非只留 lastError
            // 這樣 settlement 時每個 caller 都能拿到自己所屬 chunk 的正確錯誤
            const chunkErrors = new Map();
            // failedCallers 追蹤哪些 caller 有 chunk 寫入失敗
            const failedCallers = new Set();
            // 【修復 Issue #2: 自動分塊】
            // LanceDB 內部並無批次上限，本層主動分塊避免實際的底層限制
            for (let i = 0; i < allEntries.length; i += MemoryStore.MAX_BATCH_SIZE) {
                const chunk = allEntries.slice(i, i + MemoryStore.MAX_BATCH_SIZE);
                const chunkIdx = Math.floor(i / MemoryStore.MAX_BATCH_SIZE);
                try {
                    await this.runWithFileLock(async () => {
                        await this.table.add(chunk);
                    });
                }
                catch (err) {
                    lastError = err;
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
                    const chunkError = new Error(`batch flush failed at chunk [${chunkStart}, ${chunkEnd}): ${errorMsg}`, { cause: err });
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
                    }
                    catch (rejectErr) {
                        console.error(`[memory-lancedb-pro] caller.reject() 拋出（可能被重複結算忽略）: ${rejectErr instanceof Error ? rejectErr.message : String(rejectErr)}`);
                    }
                }
                else {
                    caller.resolve(caller.entries);
                }
                callerIdx++;
            }
            return { hasError: failedCallers.size > 0, lastError };
        }
        finally {
            releaseLock(); // 釋放 lock，讓下一個 flush 可以跑
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
    async flush() {
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
        // 【F2 fix — flush() edge case: 當 explicit flush() 失敗且 lastBackgroundError 也有值時】
        // 鏡像 destroy() 的 composite error 處理（lines 783-798）
        if (result.hasError && result.lastError) {
            if (this.lastBackgroundError?.hasError) {
                // 兩個錯誤都保留，包成 composite error
                const timerError = this.lastBackgroundError.lastError ?? new Error("background flush failed");
                this.lastBackgroundError = null;
                // throw explicit flush() 的錯誤（更新、更直接），timer 歷史錯誤放在 message 讓 caller 知道
                const compositeError = new Error(`flush failed (${result.lastError.message}); background flush also failed: ${timerError.message}`, { cause: result.lastError });
                throw compositeError;
            }
            // 只有 explicit flush() 自己的錯誤
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
    async destroy() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // 【MR4 fix】設定 destroyed flag，阻止後續 bulkStore() 呼叫
        this.destroyed = true;
        const result = await this.doFlush();
        // 【F1 fix】等待所有已排程的 timer callback 完成
        // 透過 await flushLock 確保排隊中的 doFlush 都結束
        // 防止：timer callback 已排程 → destroy() 清除 timer → destroy() 返回
        //       → timer callback 稍後執行並失敗 → 錯誤被靜音
        await this.flushLock;
        // 【方案 D fix：兩全其美 — 保留兩個錯誤，不丟失任何一個】
        //
        // 三種情境：
        // 1. destroy() 自己有錯 + lastBackgroundError 也有值 → composite error（兩個都保留）
        // 2. 只有 destroy() 自己有錯 → 只 throw destroy 的錯誤
        // 3. 只有 lastBackgroundError 有值 → throw timer 歷史錯誤
        if (result.hasError && result.lastError) {
            if (this.lastBackgroundError?.hasError) {
                // 情境 1：兩個錯誤都保留，包成 composite error
                const timerError = this.lastBackgroundError.lastError ?? new Error("background flush failed");
                this.lastBackgroundError = null;
                // throw destroy 自己錯誤，因為更新、更直接
                // timer 歷史錯誤放在 message 裡讓 caller 知道（cause chain 保留）
                const compositeError = new Error(`destroy flush failed (${result.lastError.message}); background flush also failed: ${timerError.message}`, { cause: result.lastError });
                throw compositeError;
            }
            // 情境 2：只有 destroy 自己有錯
            throw result.lastError;
        }
        // 【F1 fix】檢查 lastBackgroundError（timers 錯誤的最後堡壘）
        // 情境 3：只有 lastBackgroundError 有值
        if (this.lastBackgroundError?.hasError) {
            const err = this.lastBackgroundError.lastError ?? new Error("background flush failed");
            this.lastBackgroundError = null;
            throw err;
        }
    }
    /**
     * Import a pre-built entry while preserving its id/timestamp.
     * Used for re-embedding / migration / A/B testing across embedding models.
     * Intentionally separate from `store()` to keep normal writes simple.
     */
    async importEntry(entry) {
        await this.ensureInitialized();
        if (!entry.id || typeof entry.id !== "string") {
            throw new Error("importEntry requires a stable id");
        }
        const vector = entry.vector || [];
        if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
            throw new Error(`Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`);
        }
        const full = {
            ...entry,
            scope: entry.scope || "global",
            importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
            timestamp: normalizeMemoryTimestamp(entry.timestamp),
            metadata: entry.metadata || "{}",
        };
        return this.runWithFileLock(async () => {
            await this.table.add([full]);
            return full;
        });
    }
    async hasId(id) {
        await this.ensureInitialized();
        const safeId = escapeSqlLiteral(id);
        const res = await this.table.query()
            .select(["id"])
            .where(`id = '${safeId}'`)
            .limit(1)
            .toArray();
        return res.length > 0;
    }
    /** Lightweight total row count via LanceDB countRows(). */
    async count() {
        await this.ensureInitialized();
        return await this.table.countRows();
    }
    async getById(id, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return null;
        const safeId = escapeSqlLiteral(id);
        const rows = await this.table
            .query()
            .where(`id = '${safeId}'`)
            .limit(1)
            .toArray();
        if (rows.length === 0)
            return null;
        const row = rows[0];
        const rowScope = row.scope ?? "global";
        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            return null;
        }
        return {
            id: row.id,
            text: row.text,
            vector: Array.from(row.vector),
            category: row.category,
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
            metadata: row.metadata || "{}",
        };
    }
    async vectorSearch(vector, limit = 5, minScore = 0.3, scopeFilter, options) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        // Over-fetch more aggressively when filtering inactive records,
        // because superseded historical rows can crowd out active ones.
        const inactiveFilter = options?.excludeInactive ?? false;
        const overFetchMultiplier = inactiveFilter ? 20 : 10;
        const fetchLimit = Math.min(safeLimit * overFetchMultiplier, 200);
        let query = this.table.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);
        // Apply scope filter if provided
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            query = query.where(`(${scopeConditions}) OR scope IS NULL`); // NULL for backward compatibility
        }
        const results = await query.toArray();
        const mapped = [];
        for (const row of results) {
            const distance = Number(row._distance ?? 0);
            const score = 1 / (1 + distance);
            if (score < minScore)
                continue;
            const rowScope = row.scope ?? "global";
            // Double-check scope filter in application layer
            if (scopeFilter &&
                scopeFilter.length > 0 &&
                !scopeFilter.includes(rowScope)) {
                continue;
            }
            const entry = {
                id: row.id,
                text: row.text,
                vector: row.vector,
                category: row.category,
                scope: rowScope,
                importance: Number(row.importance),
                timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
                metadata: row.metadata || "{}",
            };
            // Skip inactive (superseded) records when requested
            if (inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                continue;
            }
            mapped.push({ entry, score });
            if (mapped.length >= safeLimit)
                break;
        }
        return mapped;
    }
    async bm25Search(query, limit = 5, scopeFilter, options) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        const inactiveFilter = options?.excludeInactive ?? false;
        // Over-fetch when filtering inactive records to avoid crowding
        const fetchLimit = inactiveFilter ? Math.min(safeLimit * 20, 200) : safeLimit;
        if (!this.ftsIndexCreated) {
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
        try {
            // Use FTS query type explicitly
            let searchQuery = this.table.search(query, "fts").limit(fetchLimit);
            // Apply scope filter if provided
            if (scopeFilter && scopeFilter.length > 0) {
                const scopeConditions = scopeFilter
                    .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                    .join(" OR ");
                searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
            }
            const results = await searchQuery.toArray();
            const mapped = [];
            for (const row of results) {
                const rowScope = row.scope ?? "global";
                // Double-check scope filter in application layer
                if (scopeFilter &&
                    scopeFilter.length > 0 &&
                    !scopeFilter.includes(rowScope)) {
                    continue;
                }
                // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
                // LanceDB may return BigInt for numeric columns; coerce safely.
                const rawScore = row._score != null ? Number(row._score) : 0;
                const normalizedScore = rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;
                const entry = {
                    id: row.id,
                    text: row.text,
                    vector: row.vector,
                    category: row.category,
                    scope: rowScope,
                    importance: Number(row.importance),
                    timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
                    metadata: row.metadata || "{}",
                };
                // Skip inactive (superseded) records when requested
                if (inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                    continue;
                }
                mapped.push({ entry, score: normalizedScore });
                if (mapped.length >= safeLimit)
                    break;
            }
            if (mapped.length > 0) {
                return mapped;
            }
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
        catch (err) {
            console.warn("BM25 search failed, falling back to empty results:", err);
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
    }
    async lexicalFallbackSearch(query, limit, scopeFilter, options) {
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const trimmedQuery = query.trim();
        if (!trimmedQuery)
            return [];
        let searchQuery = this.table.query().select([
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
        const matches = [];
        for (const row of rows) {
            const rowScope = row.scope ?? "global";
            if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
                continue;
            }
            const entry = {
                id: row.id,
                text: row.text,
                vector: row.vector,
                category: row.category,
                scope: rowScope,
                importance: Number(row.importance),
                timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
                metadata: row.metadata || "{}",
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
            if (score <= 0)
                continue;
            matches.push({ entry, score });
        }
        return matches
            .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
            .slice(0, limit);
    }
    async delete(id, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        // Support both full UUID and short prefix (8+ hex chars)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const prefixRegex = /^[0-9a-f]{8,}$/i;
        const isFullId = uuidRegex.test(id);
        const isPrefix = !isFullId && prefixRegex.test(id);
        if (!isFullId && !isPrefix) {
            throw new Error(`Invalid memory ID format: ${id}`);
        }
        let candidates;
        if (isFullId) {
            candidates = await this.table.query()
                .where(`id = '${id}'`)
                .limit(1)
                .toArray();
        }
        else {
            // Prefix match: fetch candidates and filter in app layer
            const all = await this.table.query()
                .select(["id", "scope"])
                .limit(1000)
                .toArray();
            candidates = all.filter((r) => r.id.startsWith(id));
            if (candidates.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
            }
        }
        if (candidates.length === 0) {
            return false;
        }
        const resolvedId = candidates[0].id;
        const rowScope = candidates[0].scope ?? "global";
        // Check scope permissions
        if (scopeFilter &&
            scopeFilter.length > 0 &&
            !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
        }
        return this.runWithFileLock(async () => {
            await this.table.delete(`id = '${resolvedId}'`);
            return true;
        });
    }
    async list(scopeFilter, category, limit = 20, offset = 0) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        let query = this.table.query();
        // Build where conditions
        const conditions = [];
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
            .map((row) => ({
            id: row.id,
            text: row.text,
            vector: [], // Don't include vectors in list results for performance
            category: row.category,
            scope: row.scope ?? "global",
            importance: Number(row.importance),
            timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
            metadata: row.metadata || "{}",
        }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(offset, offset + limit);
    }
    async stats(scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            return {
                totalCount: 0,
                scopeCounts: {},
                categoryCounts: {},
            };
        }
        let query = this.table.query();
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
        }
        const results = await query.select(["scope", "category"]).toArray();
        const scopeCounts = {};
        const categoryCounts = {};
        for (const row of results) {
            const scope = row.scope ?? "global";
            const category = row.category;
            scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        }
        return {
            totalCount: results.length,
            scopeCounts,
            categoryCounts,
        };
    }
    async update(id, updates, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        return this.runWithFileLock(() => this.runSerializedUpdate(async () => {
            // Support both full UUID and short prefix (8+ hex chars), same as delete()
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const prefixRegex = /^[0-9a-f]{8,}$/i;
            const isFullId = uuidRegex.test(id);
            const isPrefix = !isFullId && prefixRegex.test(id);
            if (!isFullId && !isPrefix) {
                throw new Error(`Invalid memory ID format: ${id}`);
            }
            let rows;
            if (isFullId) {
                const safeId = escapeSqlLiteral(id);
                rows = await this.table.query()
                    .where(`id = '${safeId}'`)
                    .limit(1)
                    .toArray();
            }
            else {
                // Prefix match
                const all = await this.table.query()
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
                rows = all.filter((r) => r.id.startsWith(id));
                if (rows.length > 1) {
                    throw new Error(`Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`);
                }
            }
            if (rows.length === 0)
                return null;
            const row = rows[0];
            const rowScope = row.scope ?? "global";
            // Check scope permissions
            if (scopeFilter &&
                scopeFilter.length > 0 &&
                !scopeFilter.includes(rowScope)) {
                throw new Error(`Memory ${id} is outside accessible scopes`);
            }
            const original = {
                id: row.id,
                text: row.text,
                vector: Array.from(row.vector),
                category: row.category,
                scope: rowScope,
                importance: Number(row.importance),
                timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
                metadata: row.metadata || "{}",
            };
            // Build updated entry, preserving original timestamp
            const updated = {
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
            const rollbackCandidate = (await this.getById(original.id).catch(() => null)) ?? original;
            const resolvedId = escapeSqlLiteral(row.id);
            await this.table.delete(`id = '${resolvedId}'`);
            try {
                await this.table.add([updated]);
            }
            catch (addError) {
                const current = await this.getById(original.id).catch(() => null);
                if (current) {
                    throw new Error(`Failed to update memory ${id}: write failed after delete, but an existing record was preserved. ` +
                        `Write error: ${addError instanceof Error ? addError.message : String(addError)}`);
                }
                try {
                    await this.table.add([rollbackCandidate]);
                }
                catch (rollbackError) {
                    throw new Error(`Failed to update memory ${id}: write failed after delete, and rollback also failed. ` +
                        `Write error: ${addError instanceof Error ? addError.message : String(addError)}. ` +
                        `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
                }
                throw new Error(`Failed to update memory ${id}: write failed after delete, latest available record restored. ` +
                    `Write error: ${addError instanceof Error ? addError.message : String(addError)}`);
            }
            return updated;
        }));
    }
    async runSerializedUpdate(action) {
        const previous = this.updateQueue;
        let release;
        const lock = new Promise((resolve) => {
            release = resolve;
        });
        this.updateQueue = previous.then(() => lock);
        await previous;
        try {
            return await action();
        }
        finally {
            release?.();
        }
    }
    async patchMetadata(id, patch, scopeFilter) {
        const existing = await this.getById(id, scopeFilter);
        if (!existing)
            return null;
        const metadata = buildSmartMetadata(existing, patch);
        return this.update(id, { metadata: stringifySmartMetadata(metadata) }, scopeFilter);
    }
    async bulkDelete(scopeFilter, beforeTimestamp) {
        await this.ensureInitialized();
        const conditions = [];
        if (scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            conditions.push(`(${scopeConditions})`);
        }
        if (beforeTimestamp != null) {
            conditions.push(timestampBeforePredicate("timestamp", beforeTimestamp));
        }
        if (conditions.length === 0) {
            throw new Error("Bulk delete requires at least scope or timestamp filter for safety");
        }
        const whereClause = conditions.join(" AND ");
        return this.runWithFileLock(async () => {
            // Count first
            const countResults = await this.table.query().where(whereClause).toArray();
            const deleteCount = countResults.length;
            // Then delete
            if (deleteCount > 0) {
                await this.table.delete(whereClause);
            }
            return deleteCount;
        });
    }
    get hasFtsSupport() {
        return this.ftsIndexCreated;
    }
    /** Last FTS error for diagnostics */
    _lastFtsError = null;
    get lastFtsError() {
        return this._lastFtsError;
    }
    /** Get FTS index health status */
    getFtsStatus() {
        return {
            available: this.ftsIndexCreated,
            lastError: this._lastFtsError,
        };
    }
    /** Rebuild FTS index (drops and recreates). Useful for recovery after corruption. */
    async rebuildFtsIndex() {
        await this.ensureInitialized();
        try {
            // Drop existing FTS index if any
            const indices = await this.table.listIndices();
            for (const idx of indices) {
                if (idx.indexType === "FTS" || idx.columns?.includes("text")) {
                    try {
                        await this.table.dropIndex(idx.name || "text");
                    }
                    catch (err) {
                        console.warn(`memory-lancedb-pro: dropIndex(${idx.name || "text"}) failed:`, err);
                    }
                }
            }
            // Recreate
            await this.createFtsIndex(this.table);
            this.ftsIndexCreated = true;
            this._lastFtsError = null;
            return { success: true };
        }
        catch (err) {
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
    async fetchForCompaction(maxTimestamp, scopeFilter, limit = 200) {
        await this.ensureInitialized();
        const conditions = [timestampBeforePredicate("timestamp", maxTimestamp)];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
        }
        const whereClause = conditions.join(" AND ");
        const results = await this.table
            .query()
            .where(whereClause)
            .toArray();
        return results
            .slice(0, limit)
            .map((row) => ({
            id: row.id,
            text: row.text,
            vector: Array.isArray(row.vector) ? row.vector : [],
            category: row.category,
            scope: row.scope ?? "global",
            importance: Number(row.importance),
            timestamp: normalizeMemoryTimestamp(row.timestamp, 0),
            metadata: row.metadata || "{}",
        }));
    }
}
