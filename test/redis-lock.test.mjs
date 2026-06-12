import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const {
  RedisLockManager,
  RedisLockAcquisitionError,
  RedisLockLeaseLostError,
  RedisLockUnavailableError,
} = jiti("../src/redis-lock.ts");
const {
  MemoryStore,
  __setLockfileModuleForTests,
} = jiti("../src/store.ts");
const { parsePluginConfig } = jiti("../index.ts");

const tempDirs = [];
const originalRedisUrl = process.env.MEMORY_LANCEDB_REDIS_URL;

afterEach(() => {
  if (originalRedisUrl === undefined) {
    delete process.env.MEMORY_LANCEDB_REDIS_URL;
  } else {
    process.env.MEMORY_LANCEDB_REDIS_URL = originalRedisUrl;
  }
  __setLockfileModuleForTests({
    lock: async () => async () => {},
  });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-redis-lock-"));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RedisLockManager", () => {
  it("acquires Redis locks with token ownership and releases with Lua", async () => {
    const setCalls = [];
    const evalCalls = [];
    const client = {
      async set(...args) {
        setCalls.push(args);
        return "OK";
      },
      async eval(...args) {
        evalCalls.push(args);
        return 1;
      },
    };
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      keyPrefix: "test-lock",
      ttlMs: 1234,
      acquireTimeoutMs: 50,
      retryDelayMs: 1,
    }, client);

    const result = await manager.withLock("/tmp/db", async () => "written");

    assert.equal(result, "written");
    assert.equal(setCalls.length, 1);
    assert.match(setCalls[0][0], /^test-lock:[a-f0-9]{64}$/);
    assert.equal(typeof setCalls[0][1], "string");
    assert.deepEqual(setCalls[0].slice(2), ["PX", 1234, "NX"]);
    assert.equal(evalCalls.length, 1);
    assert.match(String(evalCalls[0][0]), /redis\.call\("get", KEYS\[1\]\)/);
    assert.equal(evalCalls[0][1], 1);
    assert.equal(evalCalls[0][2], setCalls[0][0]);
    assert.equal(evalCalls[0][3], setCalls[0][1]);
  });

  it("retries transient Redis command errors until acquisition succeeds", async () => {
    let attempts = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 50,
      retryDelayMs: 1,
    }, {
      async set() {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary network blip");
        return "OK";
      },
      async eval() {
        return 1;
      },
    });

    const result = await manager.withLock("/tmp/db", async () => "ok");

    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("throws RedisLockAcquisitionError when Redis SET keeps failing after protocol starts", async () => {
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        throw new Error("connection refused");
      },
      async eval() {
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => undefined),
      RedisLockAcquisitionError,
    );
  });

  it("throws RedisLockUnavailableError when Redis commands are unavailable", async () => {
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {});

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => undefined),
      RedisLockUnavailableError,
    );
  });

  it("times out when another Redis owner keeps the lock", async () => {
    let attempts = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 5,
      retryDelayMs: 1,
    }, {
      async set() {
        attempts += 1;
        return null;
      },
      async eval() {
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => undefined),
      RedisLockAcquisitionError,
    );
    assert.ok(attempts >= 1);
  });

  it("renews the Redis lease so another writer cannot acquire during a long write", async () => {
    let token = null;
    let expiresAt = 0;
    let renewals = 0;
    let overlaps = 0;
    const client = {
      async set(_key, nextToken, _px, ttlMs, _nx) {
        const now = Date.now();
        if (!token || expiresAt <= now) {
          token = nextToken;
          expiresAt = now + Number(ttlMs);
          return "OK";
        }
        overlaps += 1;
        return null;
      },
      async eval(script, _keyCount, _key, nextToken, ttlArg) {
        if (script.includes("pexpire")) {
          if (token === nextToken) {
            renewals += 1;
            expiresAt = Date.now() + Number(ttlArg);
            return 1;
          }
          return 0;
        }
        if (token === nextToken) {
          token = null;
          expiresAt = 0;
          return 1;
        }
        return 0;
      },
    };
    const first = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 20,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, client);
    const second = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 20,
      acquireTimeoutMs: 5,
      retryDelayMs: 1,
    }, client);

    await first.withLock("/tmp/db", async () => {
      await sleep(45);
      await assert.rejects(
        () => second.withLock("/tmp/db", async () => {
          throw new Error("second writer should not enter");
        }),
        RedisLockAcquisitionError,
      );
      return "done";
    });

    assert.ok(renewals >= 1);
    assert.ok(overlaps >= 1);
  });

  it("fails the write if Redis lease renewal loses ownership", async () => {
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 5,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        return "OK";
      },
      async eval(script) {
        if (script.includes("pexpire")) return 0;
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => {
        await sleep(20);
      }),
      RedisLockLeaseLostError,
    );
  });

  it("does not mask a successful write when Redis release fails", async () => {
    const warnings = [];
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      onWarning: (message) => warnings.push(message),
    }, {
      async set() {
        return "OK";
      },
      async eval() {
        throw new Error("release failed");
      },
    });

    const result = await manager.withLock("/tmp/db", async () => 42);

    assert.equal(result, 42);
    assert.match(warnings.join("\n"), /Redis lock release failed/);
  });
});

describe("MemoryStore Redis fallback", () => {
  it("falls back to the file lock when Redis is unavailable before the write runs", async () => {
    const dbPath = tempDbPath();
    const warnings = [];
    let fileLocks = 0;
    let fileReleases = 0;
    const added = [];
    __setLockfileModuleForTests({
      lock: async () => {
        fileLocks += 1;
        return async () => {
          fileReleases += 1;
        };
      },
    });

    const store = new MemoryStore({
      dbPath,
      vectorDim: 3,
      redisLock: { enabled: true, url: "redis://localhost:6379" },
      onLockWarning: (message) => warnings.push(message),
    });
    store.table = {
      add: async (entries) => {
        added.push(...entries);
      },
    };
    store.redisLock = {
      withLock: async () => {
        throw new RedisLockUnavailableError("redis down");
      },
      close: async () => {},
    };

    await store.importEntry({
      id: "memory-1",
      text: "stored through fallback",
      vector: [0.1, 0.2, 0.3],
      category: "fact",
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    });

    assert.equal(added.length, 1);
    assert.equal(fileLocks, 1);
    assert.equal(fileReleases, 1);
    assert.match(warnings.join("\n"), /falling back to file lock/i);
  });

  it("does not fall back to file locking when Redis lock acquisition times out", async () => {
    const dbPath = tempDbPath();
    let fileLocks = 0;
    const added = [];
    __setLockfileModuleForTests({
      lock: async () => {
        fileLocks += 1;
        return async () => {};
      },
    });

    const store = new MemoryStore({
      dbPath,
      vectorDim: 3,
      redisLock: { enabled: true, url: "redis://localhost:6379" },
    });
    store.table = {
      add: async (entries) => {
        added.push(...entries);
      },
    };
    store.redisLock = {
      withLock: async () => {
        throw new RedisLockAcquisitionError("lock held by another writer");
      },
      close: async () => {},
    };

    await assert.rejects(
      () => store.importEntry({
        id: "memory-1",
        text: "must not write through fallback",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      }),
      RedisLockAcquisitionError,
    );

    assert.equal(added.length, 0);
    assert.equal(fileLocks, 0);
  });
});

describe("Redis lock configuration", () => {
  it("parses nested Redis lock config", () => {
    delete process.env.MEMORY_LANCEDB_REDIS_URL;
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      locking: {
        redis: {
          enabled: true,
          url: "redis://localhost:6379/1",
          keyPrefix: "custom-prefix",
          ttlMs: "45000",
          acquireTimeoutMs: 2500,
          retryDelayMs: 25,
          connectTimeoutMs: 750,
        },
      },
    });

    assert.deepEqual(parsed.locking.redis, {
      enabled: true,
      url: "redis://localhost:6379/1",
      keyPrefix: "custom-prefix",
      ttlMs: 45000,
      acquireTimeoutMs: 2500,
      retryDelayMs: 25,
      connectTimeoutMs: 750,
    });
  });

  it("enables Redis locking from redisUrl shortcut", () => {
    delete process.env.MEMORY_LANCEDB_REDIS_URL;
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      redisUrl: "redis://localhost:6379/2",
    });

    assert.equal(parsed.redisUrl, "redis://localhost:6379/2");
    assert.equal(parsed.locking.redis.enabled, true);
    assert.equal(parsed.locking.redis.url, "redis://localhost:6379/2");
  });

  it("declares Redis lock schema, ui hints, and dependency", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    assert.equal(manifest.configSchema.properties.locking.properties.redis.properties.enabled.default, false);
    assert.equal(manifest.configSchema.properties.locking.properties.redis.properties.ttlMs.default, 60000);
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.uiHints, "locking.redis.enabled"));
    assert.equal(manifest.uiHints["locking.redis.url"].sensitive, true);
    assert.ok(pkg.dependencies.ioredis, "package.json should declare ioredis");
  });
});
