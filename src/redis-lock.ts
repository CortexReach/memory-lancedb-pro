import { createHash, randomUUID } from "node:crypto";

export interface RedisLockConfig {
  enabled?: boolean;
  url?: string;
  keyPrefix?: string;
  ttlMs?: number;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  connectTimeoutMs?: number;
  onWarning?: (message: string) => void;
}

export interface RedisClientLike {
  set(...args: unknown[]): Promise<unknown>;
  eval(...args: unknown[]): Promise<unknown>;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export class RedisLockUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisLockUnavailableError";
  }
}

export class RedisLockAcquisitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisLockAcquisitionError";
  }
}

export class RedisLockLeaseLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisLockLeaseLostError";
  }
}

export class RedisLockLeaseIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisLockLeaseIntegrityError";
  }
}

const DEFAULT_KEY_PREFIX = "memory-lancedb-pro:write-lock";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RedisLockManager {
  private readonly config: Required<Omit<RedisLockConfig, "url" | "onWarning">> & Pick<RedisLockConfig, "url" | "onWarning">;
  private clientPromise: Promise<RedisClientLike> | null = null;
  private isClosed = false;
  private readonly activeLocks = new Set<Promise<unknown>>();

  constructor(config: RedisLockConfig, private readonly injectedClient?: RedisClientLike) {
    this.config = {
      enabled: config.enabled ?? true,
      url: config.url,
      keyPrefix: config.keyPrefix || DEFAULT_KEY_PREFIX,
      ttlMs: clampPositiveInt(config.ttlMs, DEFAULT_TTL_MS),
      acquireTimeoutMs: clampPositiveInt(config.acquireTimeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS),
      retryDelayMs: clampPositiveInt(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
      connectTimeoutMs: clampPositiveInt(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
      onWarning: config.onWarning,
    };
  }

  async withLock<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    if (this.isClosed) {
      throw new RedisLockUnavailableError("Redis lock manager has been closed");
    }
    const activeLock = this.runLockLifecycle(resource, fn);
    this.activeLocks.add(activeLock);
    try {
      return await activeLock;
    } finally {
      this.activeLocks.delete(activeLock);
    }
  }

  private async runLockLifecycle<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    const key = this.makeKey(resource);
    const client = await this.getClient();
    this.assertClientSupportsLocking(client);
    const token = randomUUID();

    await this.acquire(client, key, token);
    return this.runLockedCallback(client, key, token, fn);
  }

  private async runLockedCallback<T>(
    client: RedisClientLike,
    key: string,
    token: string,
    fn: () => Promise<T>,
  ): Promise<T> {

    let leaseLost: RedisLockLeaseLostError | null = null;
    let leaseExpiresAt = Date.now() + this.config.ttlMs;
    const markLeaseLost = (error: RedisLockLeaseLostError) => {
      if (leaseLost) return;
      leaseLost = error;
    };
    const throwPostWriteLeaseError = (error: RedisLockLeaseLostError, callbackError?: unknown): never => {
      const callbackDetail = callbackError
        ? `; callback also failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`
        : "";
      throw new RedisLockLeaseIntegrityError(
        `Redis lock ${key} was lost before the write settled; the write outcome is ambiguous and must not be retried automatically${callbackDetail}`,
        { cause: error },
      );
    };
    const renewIntervalMs = Math.max(100, Math.floor(this.config.ttlMs / 5));
    const renewTimer = setInterval(() => {
      void this.renew(client, key, token).then((renewed) => {
        if (renewed === false) {
          markLeaseLost(
            new RedisLockLeaseLostError(`Redis lock ${key} is no longer owned by this writer`),
          );
          return;
        }
        leaseExpiresAt = Date.now() + this.config.ttlMs;
      }).catch((err) => {
        if (Date.now() >= leaseExpiresAt) {
          markLeaseLost(
            new RedisLockLeaseLostError(
              `Redis lock renewal failed for ${key} before the lease could be extended: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err as Error },
            ),
          );
          return;
        }
        this.config.onWarning?.(
          `memory-lancedb-pro: transient Redis lock renewal failure for ${key}; retrying before TTL expiry: ${String(err)}`,
        );
      });
    }, renewIntervalMs);
    if (typeof renewTimer.unref === "function") renewTimer.unref();

    let callbackError: unknown;
    try {
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        callbackError = err;
      }
      if (leaseLost) {
        throwPostWriteLeaseError(leaseLost, callbackError);
      }
      if (Date.now() >= leaseExpiresAt) {
        throwPostWriteLeaseError(
          new RedisLockLeaseLostError(`Redis lock ${key} expired before the write settled`),
          callbackError,
        );
      }
      if (callbackError) {
        throw callbackError;
      }
      return result;
    } finally {
      clearInterval(renewTimer);
      try {
        const releaseResult = await client.eval(RELEASE_SCRIPT, 1, key, token);
        if (releaseResult !== 1) {
          throwPostWriteLeaseError(
            new RedisLockLeaseLostError(`Redis lock ${key} was no longer owned by this writer at release`),
            callbackError,
          );
        }
      } catch (err) {
        if (err instanceof RedisLockLeaseIntegrityError) {
          throw err;
        }
        this.config.onWarning?.(
          `memory-lancedb-pro: Redis lock release failed for ${key}; lock will expire by TTL: ${String(err)}`,
        );
      }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.activeLocks.size > 0) {
      await Promise.allSettled([...this.activeLocks]);
    }
    if (!this.injectedClient && !this.clientPromise) return;

    const client = this.injectedClient ?? (await this.clientPromise?.catch(() => null));
    if (!this.injectedClient) {
      this.clientPromise = null;
    }
    if (!client) return;

    if (typeof client.quit === "function") {
      await client.quit().catch(() => {
        client.disconnect?.();
      });
      return;
    }
    client.disconnect?.();
  }

  private async getClient(): Promise<RedisClientLike> {
    if (this.isClosed) {
      throw new RedisLockUnavailableError("Redis lock manager has been closed");
    }
    if (this.injectedClient) return this.injectedClient;
    if (!this.config.url) {
      throw new RedisLockUnavailableError("Redis lock is enabled but no Redis URL was configured");
    }
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<RedisClientLike> {
    try {
      const mod = await import("ioredis");
      type RedisConstructor = new (url: string, options?: Record<string, unknown>) => RedisClientLike;
      const redisModule = mod as unknown as {
        default?: RedisConstructor;
        Redis?: RedisConstructor;
      };
      const Redis = redisModule.default ?? redisModule.Redis;
      if (!Redis) {
        throw new Error("ioredis did not export a Redis constructor");
      }
      const client = new Redis(this.config.url!, {
        connectTimeout: this.config.connectTimeoutMs,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      if (typeof client.connect === "function") {
        await client.connect();
      }
      return client;
    } catch (err) {
      this.clientPromise = null;
      this.config.onWarning?.(
        `memory-lancedb-pro: Redis lock connection failed; writes will fail closed until Redis locking is available: ${String(err)}`,
      );
      throw new RedisLockUnavailableError(
        `Redis lock connection failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err as Error },
      );
    }
  }

  private makeKey(resource: string): string {
    if (typeof resource !== "string" || resource.length === 0) {
      throw new RedisLockAcquisitionError("Redis lock resource must be a non-empty string");
    }
    const digest = createHash("sha256").update(resource).digest("hex");
    return `${this.config.keyPrefix}:${digest}`;
  }

  private assertClientSupportsLocking(client: RedisClientLike): void {
    if (typeof client.set !== "function" || typeof client.eval !== "function") {
      throw new RedisLockUnavailableError(
        "Redis lock client does not provide required SET/EVAL commands",
      );
    }
  }

  private async acquire(client: RedisClientLike, key: string, token: string): Promise<void> {
    const deadline = Date.now() + this.config.acquireTimeoutMs;
    let attempt = 0;
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        const result = await client.set(key, token, "PX", this.config.ttlMs, "NX");
        if (result === "OK") return;
      } catch (err) {
        lastError = err;
      }

      const maxDelayMs = Math.max(this.config.retryDelayMs, 100);
      const delayMs = Math.min(this.config.retryDelayMs * 2 ** attempt, maxDelayMs);
      attempt += 1;
      await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
    }

    if (lastError) {
      throw new RedisLockAcquisitionError(
        `Timed out acquiring Redis lock ${key} after ${this.config.acquireTimeoutMs}ms; last Redis error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        { cause: lastError as Error },
      );
    }
    throw new RedisLockAcquisitionError(
      `Timed out acquiring Redis lock ${key} after ${this.config.acquireTimeoutMs}ms`,
    );
  }

  private async renew(client: RedisClientLike, key: string, token: string): Promise<boolean> {
    const result = await client.eval(RENEW_SCRIPT, 1, key, token, String(this.config.ttlMs));
    return result === 1;
  }
}
