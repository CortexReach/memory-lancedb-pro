// src/redis-lock.ts
/**
 * Redis Lock Manager
 *
 * 實現分散式 lock，用於解決高並發寫入時的 lock contention 問題。
 */

import Redis from "ioredis";

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
  // H2 fix: depth=3 假設文件化
  // ioredis error chain 通常: MaxRetriesPerRequestError → AggregateError → errors[] → individual errors
  // 若 depth 到達上限仍未確認為連線錯誤，回傳 false（不誤判，維持既有行為）
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

/**
 * 檢查 err 是否為 RedisUnavailableError（使用 Symbol.for，ESM-safe）。
 */
export function isRedisUnavailableError(err: unknown): boolean {
  return err != null && typeof err === "object" && _MARKER in err;
}

// ============================================================================
// LockConfig & RedisLockManager
// ============================================================================

export interface LockConfig {
  redisUrl?: string;
  ttl?: number; // lock 持有時間（毫秒）
  maxWait?: number; // 最大等待時間（毫秒）
  retryDelay?: number; // 重試延遲（毫秒）
}

export class RedisLockManager {
  private redis: Redis;
  private defaultTTL = 60000; // 60 秒
  private maxWait = 60000; // 最多等 60 秒
  private retryDelay = 100; // 初始重試延遲
  private _connectionError: unknown = null;

  constructor(config?: LockConfig) {
    const redisUrl = config?.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
    this.redis = new Redis(redisUrl.replace("redis://", ""), {
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null; // 停止重連
        return Math.min(times * 200, 2000);
      },
    });

    // N5：注册 error event listener，捕捉非同步連線錯誤
    this.redis.on("error", (err) => {
      if (isRedisConnectionError(err)) {
        this._connectionError = err;
      }
    });

    if (config?.ttl) this.defaultTTL = config.ttl;
    if (config?.maxWait) this.maxWait = config.maxWait;
    if (config?.retryDelay) this.retryDelay = config.retryDelay;
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      console.warn(`[RedisLock] Could not connect to Redis: ${err}`);
    }
  }

  /**
   * 取得 lock。
   * 連線錯誤（如 ECONNREFUSED、ETIMEDOUT）時立即 throw RedisUnavailableError，
   * 讓 store.ts 進 file-lock fallback。
   */
  async acquire(key: string, ttl?: number): Promise<() => Promise<void>> {
    const lockKey = `memory-lock:${key}`;
    const token = generateToken();
    const startTime = Date.now();
    const lockTTL = ttl || this.defaultTTL;

    // H4 fix: 移除 pre-flight ping，直接讓第一個 SET() 自然失敗
    // 避免 TOCTOU (ping ok 但 set 前 Redis 掛掉)，並節省一次 round-trip
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
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
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
// Factory
// ============================================================================

/**
 * 建立 RedisLockManager 工廠。
 * 連線失敗時回傳 null，讓 caller 知道要進 file lock fallback。
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
