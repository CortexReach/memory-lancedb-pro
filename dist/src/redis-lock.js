import { createHash, randomUUID } from "node:crypto";
export class RedisLockUnavailableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "RedisLockUnavailableError";
    }
}
export class RedisLockAcquisitionError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "RedisLockAcquisitionError";
    }
}
export class RedisLockLeaseLostError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "RedisLockLeaseLostError";
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
function clampPositiveInt(value, fallback) {
    if (!Number.isFinite(value) || value === undefined || value <= 0)
        return fallback;
    return Math.floor(value);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class RedisLockManager {
    injectedClient;
    config;
    clientPromise = null;
    constructor(config, injectedClient) {
        this.injectedClient = injectedClient;
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
    async withLock(resource, fn) {
        const client = await this.getClient();
        this.assertClientSupportsLocking(client);
        const key = this.makeKey(resource);
        const token = randomUUID();
        await this.acquire(client, key, token);
        let leaseLost = null;
        let rejectLeaseLost = () => { };
        const leaseLostPromise = new Promise((_resolve, reject) => {
            rejectLeaseLost = reject;
        });
        const markLeaseLost = (error) => {
            if (leaseLost)
                return;
            leaseLost = error;
            rejectLeaseLost(error);
        };
        const renewIntervalMs = Math.max(1, Math.floor(this.config.ttlMs / 2));
        const renewTimer = setInterval(() => {
            void this.renew(client, key, token).catch((err) => {
                markLeaseLost(new RedisLockLeaseLostError(`Redis lock renewal failed for ${key}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
            }).then((renewed) => {
                if (renewed === false) {
                    markLeaseLost(new RedisLockLeaseLostError(`Redis lock ${key} is no longer owned by this writer`));
                }
            });
        }, renewIntervalMs);
        if (typeof renewTimer.unref === "function")
            renewTimer.unref();
        try {
            const operation = fn();
            operation.catch(() => { });
            return await Promise.race([operation, leaseLostPromise]);
        }
        finally {
            clearInterval(renewTimer);
            try {
                await client.eval(RELEASE_SCRIPT, 1, key, token);
            }
            catch (err) {
                this.config.onWarning?.(`memory-lancedb-pro: Redis lock release failed for ${key}; lock will expire by TTL: ${String(err)}`);
            }
        }
    }
    async close() {
        if (!this.clientPromise)
            return;
        const client = await this.clientPromise.catch(() => null);
        this.clientPromise = null;
        if (!client)
            return;
        if (typeof client.quit === "function") {
            await client.quit().catch(() => {
                client.disconnect?.();
            });
            return;
        }
        client.disconnect?.();
    }
    async getClient() {
        if (this.injectedClient)
            return this.injectedClient;
        if (!this.config.url) {
            throw new RedisLockUnavailableError("Redis lock is enabled but no Redis URL was configured");
        }
        if (!this.clientPromise) {
            this.clientPromise = this.createClient();
        }
        return this.clientPromise;
    }
    async createClient() {
        try {
            const mod = await import("ioredis");
            const redisModule = mod;
            const Redis = redisModule.default ?? redisModule.Redis;
            if (!Redis) {
                throw new Error("ioredis did not export a Redis constructor");
            }
            const client = new Redis(this.config.url, {
                connectTimeout: this.config.connectTimeoutMs,
                enableOfflineQueue: false,
                lazyConnect: true,
                maxRetriesPerRequest: 1,
            });
            if (typeof client.connect === "function") {
                await client.connect();
            }
            return client;
        }
        catch (err) {
            this.clientPromise = null;
            throw new RedisLockUnavailableError(`Redis lock connection failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
    }
    makeKey(resource) {
        const digest = createHash("sha256").update(resource || "default").digest("hex");
        return `${this.config.keyPrefix}:${digest}`;
    }
    assertClientSupportsLocking(client) {
        if (typeof client.set !== "function" || typeof client.eval !== "function") {
            throw new RedisLockUnavailableError("Redis lock client does not provide required SET/EVAL commands");
        }
    }
    async acquire(client, key, token) {
        const deadline = Date.now() + this.config.acquireTimeoutMs;
        let attempt = 0;
        let lastError;
        while (Date.now() <= deadline) {
            try {
                const result = await client.set(key, token, "PX", this.config.ttlMs, "NX");
                if (result === "OK")
                    return;
            }
            catch (err) {
                lastError = err;
            }
            const delayMs = Math.min(this.config.retryDelayMs * 2 ** attempt, Math.max(this.config.retryDelayMs, 1_000));
            attempt += 1;
            await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
        }
        if (lastError) {
            throw new RedisLockAcquisitionError(`Timed out acquiring Redis lock ${key} after ${this.config.acquireTimeoutMs}ms; last Redis error: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
        }
        throw new RedisLockAcquisitionError(`Timed out acquiring Redis lock ${key} after ${this.config.acquireTimeoutMs}ms`);
    }
    async renew(client, key, token) {
        const result = await client.eval(RENEW_SCRIPT, 1, key, token, String(this.config.ttlMs));
        return result === 1;
    }
}
