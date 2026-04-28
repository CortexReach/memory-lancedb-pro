// src/redis-lock.ts
/**
 * Redis Lock Manager（基礎設施）
 *
 * 本檔案為 PR-1 基礎設施，RedisLockManager 完整實作見後續 PR。
 * 目前工廠函式在 Redis 不可用時正確返回 null，確保現有 file lock 行為不受影響。
 */

import Redis from 'ioredis';

// ============================================================================
// URL 解析（修復 PR-1 問題：原本的 .replace('redis://', '') 破壞 auth/TLS URL）
// ============================================================================

/**
 * 解析 Redis URL，處理三種格式：
 * 1. Legacy（無 scheme）：host:port → redis://host:port
 * 2. 標準（redis://）：完整保留，交給 ioredis 自己解析
 * 3. TLS（rediss://）：完整保留
 *
 * 原本的錯誤實作：
 *   new Redis(redisUrl.replace('redis://', ''))
 * 會破壞：
 *   - redis://user:pass@host:6379 → "user:pass@host:6379"（ioredis 解析錯誤）
 *   - rediss://host:6379 → "rediss://host:6379"（scheme 被當成 hostname）
 *   - redis://host:6379?tls=true → "host:6379?tls=true"（query string 被當路徑）
 */
export function parseRedisUrl(url: string): string {
  if (!url.includes('://')) {
    // Legacy 格式（無 scheme）：host:port → redis://host:port
    return `redis://${url}`;
  }
  // 有 scheme：直接傳給 ioredis，讓它自己解析 auth / TLS / query string
  return url;
}

// ============================================================================
// Lock Domain Decision（single-flight，全程序只決定一次）
// ============================================================================

export type LockDomain = 'redis' | 'file';

let _lockDomainDecision: LockDomain | null = null;
let _lockDomainPromise: Promise<LockDomain> | null = null;

/**
 * 決定全程序使用哪種 lock domain。
 *
 * 採用 single-flight 模式：所有 concurrent caller 共享同一個 Promise，
 * 確保整個 process 在啟動時只會執行一次 init 邏輯，
 * 之後所有請求直接取用已決定的 domain，不會再改變。
 *
 * 一旦決定用 Redis，就永遠用 Redis（即使後來 Redis 掛了，也不重試）。
 * 一旦決定用 File lock，就永遠用 File lock。
 * 這樣可以避免「req-A 用 Redis lock，req-B 用 file lock」的 domain 分裂問題。
 */
export async function determineLockDomain(): Promise<LockDomain> {
  if (_lockDomainDecision !== null) return _lockDomainDecision;
  if (_lockDomainPromise !== null) return _lockDomainPromise;

  _lockDomainPromise = (async () => {
    try {
      const manager = await createRedisLockManager();
      if (manager && await manager.isHealthy()) {
        _lockDomainDecision = 'redis';
        return 'redis';
      }
    } catch {
      // ignore — fallback to file
    }
    _lockDomainDecision = 'file';
    return 'file';
  })();

  return _lockDomainPromise;
}

// ============================================================================
// RedisLockManager 工廠（骨架，完整實作見後續 PR）
// ============================================================================

export interface LockConfig {
  redisUrl?: string;
  ttl?: number;
  maxWait?: number;
  retryDelay?: number;
}

export class RedisLockManager {
  private redis: Redis;
  private defaultTTL = 60000;
  private maxWait = 60000;
  private retryDelay = 100;

  constructor(config?: LockConfig) {
    const redisUrl = config?.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(parseRedisUrl(redisUrl), {
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });

    if (config?.ttl) this.defaultTTL = config.ttl;
    if (config?.maxWait) this.maxWait = config.maxWait;
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      console.warn(`[RedisLock] Could not connect to Redis: ${err}`);
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
}

/**
 * 建立 RedisLockManager 工廠。
 * 若 Redis 初始化失敗或無法連線，返回 null（ caller 應 fallback 到 file lock）。
 *
 * 目前本函式在 Redis 不可用時直接返回 null，不嘗試重連。
 * 完整實作（acquire / release / fallback）在後續 PR。
 */
export async function createRedisLockManager(
  config?: LockConfig
): Promise<RedisLockManager | null> {
  const manager = new RedisLockManager(config);

  try {
    await manager.connect();
    const isHealthy = await manager.isHealthy();
    if (isHealthy) {
      return manager;
    } else {
      await manager.disconnect();
      return null;
    }
  } catch (err) {
    console.warn(`[RedisLock] Failed to initialize: ${err}`);
    return null;
  }
}
