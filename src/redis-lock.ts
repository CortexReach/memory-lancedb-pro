/**
 * Redis Lock Manager
 *
 * 實現分散式 lock，用於解決高並發寫入時的 lock contention 問題。
 */

// Issue 1 fix: 改用 dynamic import，ioredis 只在真的需要時才載入
// 不再是 top-level static import，避免 consumer 沒裝 ioredis 時就 crash
import type { Redis as IORedisType } from "ioredis";

// ============================================================================
// isRedisConnectionError：判斷錯誤是否為 Redis 連線問題（包含 wrapped error 遞迴檢查）
// ============================================================================

/**
 * 判斷 err 是否為 Redis 連線錯誤。
 * 包含 wrapped error（ioredis errors[] / cause）遞迴檢查，最多遞迴 depth=3 層。
 *
 * 注意：ReplyError（如 WRONGTYPE、NOPERM）不是連線錯誤，是 Redis 指令語法/權限問題，
 * 不進 fallback，直接 throw。
 */
export function isRedisConnectionError(err: unknown, depth = 0): boolean {
  if (depth >= 3) return false;
  if (!(err instanceof Error)) return false;

  const code = (err as any).code || "";
  const name = err.name || "";

  if (["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND"].includes(code)) return true;
  if (
    ["MaxRetriesPerRequestError", "ConnectionTimeoutError", "ReconnectionAttemptsLimitError", "AbortedError"].includes(
      name,
    )
  )
    return true;

  // 檢查 wrapped errors（ioredis 常見：errors[] 陣列或 cause）
  const inner: unknown[] = Array.isArray((err as any).errors)
    ? (err as any).errors
    : (err as any).cause
      ? [(err as any).cause]
      : [];
  return inner.some((e: unknown) => isRedisConnectionError(e, depth + 1));
}

// ============================================================================
// RedisUnavailableError：Redis 連線失敗時的專用錯誤類型
// ============================================================================

/**
 * Symbol.for 確保跨 module boundary 都能取得同一個 Symbol。
 * store.ts 用 Symbol.for("RedisUnavailableError") in err 檢查，ESM-safe。
 */
const _MARKER = Symbol.for("RedisUnavailableError");

export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisUnavailableError";
  }
  /** Symbol marker — store.ts 用 Symbol.for("RedisUnavailableError") in err 檢查 */
  get [_MARKER]() {
    return true;
  }
}

// ============================================================================
// RedisOptions & parseRedisUrl
// ============================================================================

interface RedisOptions {
  host: string;
  port: number;
  db: number;
}

/**
 * Issue 3 fix: parseRedisUrl() now uses URL API to extract hostname/port/db
 * separately. DB selection (/0, /1, /2...) is preserved instead of being
 * eaten by replace().
 *
 * Examples:
 *   redis://localhost:6379/0      → { host: "localhost", port: 6379, db: 0 }
 *   redis://:password@host:6379/1 → { host: "host", port: 6379, db: 1 }  (password stripped)
 *   localhost:6379              → { host: "localhost", port: 6379, db: 0 }  (legacy fallback)
 */
function parseRedisUrl(redisUrl: string): RedisOptions {
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = Number(url.port) || 6379;
    const rawDb = url.pathname.replace("/", "");
    // Issue 3 fix: 驗證 db 必須是數字，否則 fallback 到 0（不靜默接受 NaN）
    const db = /^\d+$/.test(rawDb)
      ? Number(rawDb)
      : rawDb
        ? (console.warn(`[RedisLock] Invalid DB in URL: ${rawDb}, fallback to 0`), 0)
        : 0;
    return { host, port, db };
  } catch {
    // Fallback：可能是 legacy 格式 "localhost:6379"，直接用 string constructor
    const parts = redisUrl.replace("redis://", "").split(":");
    return {
      host: parts[0] || "localhost",
      port: Number(parts[1]) || 6379,
      db: 0,
    };
  }
}

// ============================================================================
// LockConfig & RedisLockManager
// ============================================================================

export interface LockConfig {
  redisUrl?: string;
  ttl?: number; // lock 持有時間（毫秒）
  maxWait?: number; // 最大等待時間（毫秒）
  retryDelay?: number; // 重試延遲（毫秒）
  /** Issue 4 fix: 用於 namespace Redis lock key，避免不同 dbPath 的 store 互相 blocking */
  dbPath?: string;
}

export class RedisLockManager {
  // ioredis client — 用 any 避免 type 不匹配問題
  private redis: any = null;
  private defaultTTL = 60000; // 60 秒
  private maxWait = 60000; // 60 秒
  private retryDelay = 100; // 初始重試延遲
  private _connectionError: unknown = null;
  private readonly _lockNamespace: string;

  constructor(private readonly config?: LockConfig) {
    // Issue 4 fix: namespace key with dbPath hash，避免不同 dbPath 的 store 互相 blocking
    this._lockNamespace = config?.dbPath ? hashString(config.dbPath) : "default";
  }

  /**
   * Issue 1 fix: 動態載入 ioredis，只在 connect() 時才 import。
   * Issue 3 fix: 正確解析 URL，保留 DB selection（/0, /1, /2...）
   * 用 any 避免 type cast 問題。
   */
  async connect(): Promise<void> {
    try {
      // Dynamic import — 用 any 避免 type mismatches
      const RedisModule = await import("ioredis") as any;
      const Redis = RedisModule.default;
      const redisUrl = this.config?.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
      const parsed = parseRedisUrl(redisUrl);

      this.redis = new Redis({
        host: parsed.host,
        port: parsed.port,
        db: parsed.db,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (times > 3) return null; // 停止重連
          return Math.min(times * 200, 2000);
        },
      });

      // N5：注册 error event listener，捕捉非同步連線錯誤
      this.redis.on("error", (err: unknown) => {
        if (isRedisConnectionError(err)) {
          this._connectionError = err;
        }
      });

      await this.redis.connect();
    } catch (err) {
      console.warn(`[RedisLock] Could not connect to Redis: ${err}`);
      this.redis = null;
    }
  }

  /**
   * 取得 lock。
   * 連線錯誤（如 ECONNREFUSED、ETIMEDOUT）時立即 throw RedisUnavailableError，
   * 讓 store.ts 進 file-lock fallback。
   *
   * H4 fix: 移除 pre-flight ping，直接讓第一個 SET() 自然失敗
   * 避免 TOCTOU (ping ok 但 set 前 Redis 掛掉)，並節省一次 round-trip
   */
  async acquire(key: string, ttl?: number): Promise<() => Promise<void>> {
    if (!this.redis) {
      throw new RedisUnavailableError("Redis client not initialized");
    }

    const lockKey = `memory-lock:${this._lockNamespace}:${key}`;
    const token = generateToken();
    const startTime = Date.now();
    const lockTTL = ttl || this.defaultTTL;

    // MAX_ATTEMPTS circuit breaker：防止無限期重試
    const MAX_ATTEMPTS = 600;
    let attempts = 0;

    while (true) {
      attempts++;

      try {
        const result = await this.redis.set(lockKey, token, "PX", lockTTL, "NX");

        if (result === "OK") {
          return async () => {
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            try {
              await this.redis.eval(script, 1, lockKey, token);
            } catch (err) {
              console.warn(`[RedisLock] Failed to release lock: ${err}`);
            }
          };
        }
      } catch (err) {
        // M4：連線錯誤立即進 fallback，不走一般重試
        if (isRedisConnectionError(err)) {
          throw new RedisUnavailableError(`Redis connection failed: ${err}`);
        }
        console.warn(`[RedisLock] Redis error during acquire (attempt ${attempts}): ${err}`);
      }

      if (Date.now() - startTime > this.maxWait || attempts >= MAX_ATTEMPTS) {
        throw new Error(
          attempts >= MAX_ATTEMPTS
            ? `Lock acquisition hard-cap reached: ${key} after ${attempts} attempts`
            : `Lock acquisition timeout: ${key} after ${attempts} attempts (${Date.now() - startTime}ms)`,
        );
      }

      const delay = Math.min(this.retryDelay * Math.pow(1.5, Math.min(attempts, 10)), 2000);
      await this.sleep(delay + Math.random() * 100);
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  get connectionError(): unknown {
    return this._connectionError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Token Generator
// ============================================================================

function generateToken(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

// ============================================================================
// String Hash（Issue 4 fix）
// ============================================================================

/**
 * Issue 4 fix: 將 dbPath 轉為短 hash，用於 namespace Redis lock key。
 * 避免不同 dbPath 的 store instances 互相 blocking。
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // convert to 32bit integer
  }
  // 轉為正數並取末 8 位，轉成 base36
  return Math.abs(hash).toString(36).padStart(4, "0");
}

// ============================================================================
// Factory
// ============================================================================

/**
 * 建立 RedisLockManager 工廠。
 *
 * 重要：這個工廠的回傳值決定了「整個 process 的 lock domain」。
 * createRedisLockManager() 回傳 null → 這個 process 用 file lock
 * createRedisLockManager() 回傳 manager → 這個 process 用 Redis lock
 * 一旦決定，整個 process 生命週期內不再改變（Option E）。
 *
 * 區分兩種失敗模式：
 * - Init failure（連不上 Redis）：回傳 null → file lock fallback（合理）
 * - Runtime failure（acquire() 時 Redis 瞬斷）：拋出 RedisUnavailableError → 直接 throw（安全）
 */
export async function createRedisLockManager(config?: LockConfig): Promise<RedisLockManager | null> {
  const manager = new RedisLockManager(config);

  try {
    await manager.connect();
    const isHealthy = await manager.isHealthy();
    if (isHealthy) {
      return manager;
    } else {
      console.warn("[RedisLock] Redis not healthy, will use file lock fallback");
      await manager.disconnect();
      return null;
    }
  } catch (err) {
    console.warn(`[RedisLock] Failed to initialize: ${err}`);
    return null;
  }
}