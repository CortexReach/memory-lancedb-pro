// src/redis-lock.ts
/**
 * Redis Lock Manager
 * 
 * 實現分散式 lock，用於解決高並發寫入時的 lock contention 問題
 */

import Redis from 'ioredis';
import path from 'node:path';
import fs from 'node:fs';

// 用 lazy import 避免 ESM 問題
let properLockfile: any = null;

async function loadProperLockfile(): Promise<any> {
  if (!properLockfile) {
    properLockfile = await import('proper-lockfile');
  }
  return properLockfile;
}

// 生成唯一 token
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
        if (times > 3) return null; // 放棄重連
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

    // 如果 Redis 可用但沒有進一步使用，這裡可以加強確認

    let attempts = 0;
    while (true) {
      attempts++;
      
      try {
        // 使用 SET NX + token (原子操作)
        const result = await this.redis.set(lockKey, token, 'PX', lockTTL, 'NX');
        
        if (result === 'OK') {
          // 成功取得 lock
          console.log(`[RedisLock] Acquired lock ${key} after ${attempts} attempts`);
          
          // 回傳帶 token 的 release function
          return async () => {
            // 用 Lua script 確保只刪除自己的 lock
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            try {
              await this.redis.eval(script, 1, lockKey, token);
              console.log(`[RedisLock] Released lock ${key}`);
            } catch (err) {
              console.warn(`[RedisLock] Failed to release lock: ${err}`);
            }
          };
        }
      } catch (err) {
        // 記錄 Redis 錯誤，避免 silent swallow
        console.warn(`[RedisLock] Redis error during acquire (attempt ${attempts}): ${err}`);
      }

      // 檢查是否超時
      if (Date.now() - startTime > this.maxWait) {
        throw new Error(`Lock acquisition timeout: ${key} after ${attempts} attempts`);
      }

      // 指數退避等待
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 建立 file lock（Redis 不可用時的 fallback）
   */
  private createFileLock(key: string, ttl?: number): () => Promise<void> {
    // Windows tmp 目錄
    const tmpDir = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
    const lockPath = path.join(tmpDir, `.memory-lock-${key}.lock`);
    const lockTTL = (ttl || this.defaultTTL) / 1000; // proper-lockfile 用秒

    // 確保目錄存在
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 同步取得 file lock（不支援 retries）
    try {
      const lockfile = require('proper-lockfile');
      lockfile.lockSync(lockPath, {
        stale: lockTTL,
      });
      console.log(`[RedisLock] ✅ File lock acquired: key=${key}, path=${lockPath}`);
    } catch (err) {
      console.warn(`[RedisLock] ❌ Failed to acquire file lock: key=${key}, err=${err}`);
    }

    // 回傳 release function
    return async () => {
      try {
        const lockfile = require('proper-lockfile');
        await lockfile.unlock(lockPath);
        console.log(`[RedisLock] ✅ File lock released: key=${key}`);
      } catch (err) {
        // 忽略 ENOENT（檔案不存在）
        if (!err.message.includes('ENOENT')) {
          console.warn(`[RedisLock] ❌ Failed to release file lock: key=${key}, err=${err}`);
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
      console.log('[RedisLock] Redis lock manager initialized');
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