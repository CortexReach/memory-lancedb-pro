// src/redis-lock.ts
/**
 * Redis Lock Manager
 * 
 * 實現分散式 lock，用於解決高並發寫入時的 lock contention 問題
 */

import Redis from 'ioredis';
import path from 'node:path';
import fs from 'node:fs';
import { tmpdir as nodeTmpdir } from 'node:os';

// 用 lazy import 避免 ESM 問題
let properLockfile: typeof import("proper-lockfile") | null = null;

async function loadProperLockfile(): Promise<typeof import("proper-lockfile")> {
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

    const MAX_ATTEMPTS = 600; // Hard cap: prevents infinite loop if clock drift / setTimeout drift
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
            } catch (err) {
              console.warn(`[RedisLock] Failed to release lock: ${err}`);
            }
          };
        }
      } catch (err) {
        // 記錄 Redis 錯誤，避免 silent swallow
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
    // Uses nodeTmpdir from top-level ESM import (line 9)
    const lockPath = path.join(nodeTmpdir, `.memory-lock-${key}.lock`);
    const lockTTL = (ttl || this.defaultTTL) / 1000; // proper-lockfile 用秒

    // 確保目錄存在
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Synchronous lock acquisition — no retries. If this fails, throw immediately.
    // If we return a no-op release when lockSync fails, the caller proceeds without
    // any lock, which can cause data corruption under concurrent writes.
    let lockAcquired = false;
    try {
      const lockfile = require('proper-lockfile');
      lockfile.lockSync(lockPath, { stale: lockTTL });
      lockAcquired = true;
    } catch (err) {
      // Propagate: do NOT swallow this — caller must know the lock path failed
      throw new Error(`File lock unavailable for key="${key}" (path=${lockPath}): ${err}`);
    }

    if (!lockAcquired) {
      throw new Error(`File lock returned without error but lockAcquired=false for key="${key}"`);
    }

    // Only reached when lockSync succeeded
    return async () => {
      try {
        const lockfile = require('proper-lockfile');
        await lockfile.unlock(lockPath);
      } catch (err) {
        if (!err.message.includes('ENOENT')) {
          console.warn(`[RedisLock] File unlock failed: key=${key}: ${err}`);
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