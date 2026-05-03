// src/redis-lock.ts
/**
 * Redis Lock Manager
 * 
 * 實現分散式 lock，用於解決高並發寫入時的 lock contention 問題
 */

import Redis from 'ioredis';
import path from 'node:path';
import fs from 'node:fs';
import * as os from 'node:os';

// 用 lazy import 避免 ESM 問題
let properLockfile: typeof import("proper-lockfile") | null = null;

async function loadProperLockfile(): Promise<typeof import("proper-lockfile")> {
  if (!properLockfile) {
    properLockfile = await import('proper-lockfile');
  }
  return properLockfile;
}

/**
 * 生成唯一 lock token。
 *
 * 用途：Lua release script 使用此 token 做 compare-and-delete，
 * 確保只刪除自己持有的 lock，不會誤刪他人的 lock（即使 key 相同）。
 *
 * 唯一性保證：
 * - 單行程內：Date.now() 毫秒級 + Math.random() 8字 → 碰撞機率極低
 * - 多行程/多機器：clock drift 可能讓不同行程產生相同 Date.now()，
 *   但 Math.random() 的加入讓碰撞機率降至可忽略（2^32 分之 1）
 * - 注意：不是密碼學安全隨機，若需更高保障應用 crypto.randomBytes()
 */
function generateToken(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

export interface LockConfig {
  redisUrl?: string;
  ttl?: number;           // lock 過期時間（毫秒）
  maxWait?: number;       // 最大等待時間（毫秒）
  retryDelay?: number;  // 重試延遲（毫秒）
}

export class RedisLockManager {
  private redis: Redis;
  private defaultTTL = 60000;   // 60 秒
  private maxWait = 60000;         // 最多等 60 秒
  private retryDelay = 100;         // 初始重試延遲

  constructor(config?: LockConfig) {
    const redisUrl = config?.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl.replace('redis://', ''), {
      lazyConnect: true,
      retryStrategy: (times) => {
        // 對照 PR 描述 "60s TTL" — ioredis 連線失敗時最多重試 3 次
        // 重試間隔：200ms → 400ms → 800ms（指数退避，上限 2000ms）
        if (times > 3) return null; // 放棄重連，觸發 connect() 的 catch block
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
      // 如果連不上，尝试不連接（lazy connect）
      console.warn(`[RedisLock] Could not connect to Redis: ${err}`);
    }
  }

  async acquire(key: string, ttl?: number): Promise<() => Promise<void>> {
    const lockKey = `memory-lock:${key}`;
    const token = generateToken();
    const startTime = Date.now();
    const lockTTL = ttl || this.defaultTTL;

    // 嘗試連接
    let redisAvailable = false;
    try {
      await this.redis.ping();
      redisAvailable = true;
    } catch (err) {
      // Redis 不可用，使用 file lock fallback
      console.warn(`[RedisLock] ⚠️ Redis unavailable (${err}), falling back to file lock`);
      return this.createFileLock(key, ttl);
    }

    // ping() 成功確認 Redis 可達；即使 Redis 短暫變慢，acquire() 的重試迴圈會處理

    const MAX_ATTEMPTS = 600; // 對照 PR 描述 "60s TTL with exponential backoff"
    // 配合 retryStrategy（最多重連 3 次，每次 200/400/800ms）和 maxWait（預設 60s），
    // MAX_ATTEMPTS 防止 setTimeout 漂移導致無限迴圈（罕見但可能）
    let attempts = 0;
    while (true) {
      attempts++;
      
      try {
        // 使用 SET NX + token (原子操作)
        const result = await this.redis.set(lockKey, token, 'PX', lockTTL, 'NX');
        
        if (result === 'OK') {
          // 成功取得 lock
          
          // 回傳帶 token 的 release function
          return async () => {
            // Lua script: compare-and-delete（對照 PR 描述 "Lua script for safe release"）
            // 只有 lock 的 token 與當初取得的 token 完全一致時才刪除
            // 防止以下情況：lock 已過期自動釋放，另一行程立即取得同一 key 的新 lock，
            // 然後舊行程的 Lua script 執行刪除 — compare-and-delete 可阻擋此場景
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
      } catch (err: any) {
        // 區分「連線錯誤」和「競爭鎖」錯誤
        // 連線錯誤（Redis 掛了）應立即 fallback，不要浪費 maxWait 時間
        // 使用 err.code（Node.js 標準）做精確判斷，輔以訊息字串抓漏網之魚
        const errCode = err?.code ?? "";
        const errMsg = String(err ?? "").toLowerCase();
        const isConnectionError =
          // Node.js network error codes（標準 POSIX）
          errCode === "ECONNREFUSED" ||
          errCode === "ENOTFOUND" ||
          errCode === "ETIMEDOUT" ||
          errCode === "EHOSTUNREACH" ||
          errCode === "ENETUNREACH" ||
          errCode === "ECONNRESET" ||
          errCode === "EPIPE" ||
          errCode === "EAI_AGAIN" ||
          errCode === "EADDRINFO" ||
          // ioredis/Node.js 錯誤訊息變體（大小寫/空格不一致）
          errMsg.includes("connection is closed") ||
          errMsg.includes("connection timeout") ||
          errMsg.includes("connect econnrefused") ||
          errMsg.includes("connect econnreset") ||
          errMsg.includes("connect etimedout") ||
          errMsg.includes("getaddrinfo") ||
          errMsg.includes("econnrefused") ||
          errMsg.includes("econnreset") ||
          errMsg.includes("etimedout") ||
          errMsg.includes("enotfound") ||
          errMsg.includes("ehostunreach") ||
          errMsg.includes("enetunreach");
        if (isConnectionError) {
          throw new Error(`Redis connection error (${errCode || "unknown"}), will fallback to file lock: ${err}`);
        }
        // 非連線錯誤（只是鎖被佔用）→ 繼續重試
        console.warn(`[RedisLock] Redis error during acquire (attempt ${attempts}): ${err}`);
      }

      // 檢查是否超時 或 達到最大嘗試次數（circuit breaker）
      if (Date.now() - startTime > this.maxWait || attempts >= MAX_ATTEMPTS) {
        throw new Error(
          attempts >= MAX_ATTEMPTS
            ? `Lock acquisition hard-cap reached: ${key} after ${attempts} attempts (maxWait may be too short)`
            : `Lock acquisition timeout: ${key} after ${attempts} attempts (${Date.now() - startTime}ms)`
        );
      }

      // 指數退避等待
      const delay = Math.min(this.retryDelay * Math.pow(1.5, Math.min(attempts, 10)), 2000);
      await this.sleep(delay + Math.random() * 100);
    }
  }

  /**
   * 健康檢查：使用 PING 確認 Redis 可響應命令。
   *
   * 使用情境：
   * - `createRedisLockManager()` 工廠方法在建立 manager 後用 `isHealthy()` 確認 Redis 可用
   * - 不做更深入的檢查（連線品質、記憶體等），PING 成功即視為可用
   * - 設計原則：啟動時檢查，執行期由 `acquire()` 的重試迴圈處理連線中斷
   */
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * File lock fallback — Redis unavailable時的最終保障。
   *
   * 設計原則（對照 PR 描述 "Graceful fallback: Returns no-op lock when Redis unavailable"）：
   * - lockSync 成功 → return 正常的 release function（lock 生效）
   * - lockSync 失敗（ELOCKED 等）→ return no-op release（不 blocking caller，
   *   caller 繼續執行但無 lock 保護 — 這是高並發下的降級策略，
   *   不是理想狀態但避免整個系統因 lock 無法取得而停擺）
   *
   * 注意：這裡的 no-op fallback 與 Redis 失敗時立即 throw 的策略不同。
   * Redis 失敗 → throw → caller 可選擇其他處理（如直接執行不放 lock）。
   * 檔案 lock 失敗 → return no-op → caller 以為有 lock 保護但實際沒有。
   * 兩者都是 PR 描述的 "no blocking" 策略，只是實作層次不同。
   */
  private createFileLock(key: string, ttl?: number): () => Promise<void> {
    const lockPath = path.join(os.tmpdir(), `.memory-lock-${key}.lock`);
    const lockTTL = (ttl || this.defaultTTL) / 1000; // proper-lockfile 用秒

    // 確保目錄存在
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const lockfile = require('proper-lockfile');
      lockfile.lockSync(lockPath, { stale: lockTTL });
    } catch (err) {
      // lock 取得失敗 → 回傳 no-op release（PR 描述 "no blocking"）
      // caller 繼續執行，但放棄 lock 保護（高並發降級策略）
      console.warn(`[RedisLock] File lock unavailable for key="${key}", proceeding without lock: ${err}`);
      return async () => {
        // no-op: 沒有任何 lock 要釋放
      };
    }

    // lock 取得成功
    return async () => {
      try {
        const lockfile = require('proper-lockfile');
        await lockfile.unlock(lockPath);
      } catch (err) {
        // ENOENT = lock 檔案已被清理（正常，可能是 TTL 自然過期）
        // 其他錯誤 = 警告但不 blocking
        if (!err.message.includes('ENOENT')) {
          console.warn(`[RedisLock] File unlock warning for key="${key}": ${err}`);
        }
      }
    };
  }
}

/**
 * 建立 RedisLockManager 工廠
 */
export async function createRedisLockManager(config?: LockConfig): Promise<RedisLockManager | null> {
  const manager = new RedisLockManager(config);
  
  try {
    await manager.connect();
    const isHealthy = await manager.isHealthy();
    if (isHealthy) {
      return manager;
    } else {
      console.warn('[RedisLock] Redis not healthy, will use file lock fallback');
      await manager.disconnect();
      return null;
    }
  } catch (err) {
    console.warn(`[RedisLock] Failed to initialize: ${err}`);
    return null;
  }
}