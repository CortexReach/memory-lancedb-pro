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
  RedisLockLeaseIntegrityError,
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

  it("rejects new writes after the lock manager is closed", async () => {
    let setCalls = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        setCalls += 1;
        return "OK";
      },
      async eval() {
        return 1;
      },
    });

    await manager.close();

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => "should not run"),
      RedisLockUnavailableError,
    );
    assert.equal(setCalls, 0);
  });

  it("waits for active Redis-locked writes before closing the client", async () => {
    const events = [];
    let releaseWrite;
    const writeMayFinish = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 5_000,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        events.push("acquired");
        return "OK";
      },
      async eval() {
        events.push("released");
        return 1;
      },
      async quit() {
        events.push("quit");
      },
    });

    const write = manager.withLock("/tmp/db", async () => {
      events.push("write-started");
      await writeMayFinish;
      events.push("write-finished");
    });

    while (!events.includes("write-started")) {
      await sleep(1);
    }
    const close = manager.close();
    await sleep(10);
    assert.deepEqual(events, ["acquired", "write-started"]);

    releaseWrite();
    await Promise.all([write, close]);

    assert.deepEqual(events, ["acquired", "write-started", "write-finished", "released", "quit"]);
  });

  it("waits for in-flight Redis lock acquisition before closing the client", async () => {
    const events = [];
    let finishAcquire;
    const acquireMayFinish = new Promise((resolve) => {
      finishAcquire = resolve;
    });
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 5_000,
      acquireTimeoutMs: 200,
      retryDelayMs: 1,
    }, {
      async set() {
        events.push("acquire-started");
        await acquireMayFinish;
        events.push("acquired");
        return "OK";
      },
      async eval() {
        events.push("released");
        return 1;
      },
      async quit() {
        events.push("quit");
      },
    });

    const write = manager.withLock("/tmp/db", async () => {
      events.push("write-started");
    });

    while (!events.includes("acquire-started")) {
      await sleep(1);
    }
    const close = manager.close();
    await sleep(10);
    assert.deepEqual(events, ["acquire-started"]);

    finishAcquire();
    await Promise.all([write, close]);

    assert.deepEqual(events, ["acquire-started", "acquired", "write-started", "released", "quit"]);
  });

  it("rejects empty Redis lock resources without acquiring a client", async () => {
    let setCalls = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        setCalls += 1;
        return "OK";
      },
      async eval() {
        return 1;
      },
    });

    await assert.rejects(
      () => manager.withLock("", async () => "should not run"),
      RedisLockAcquisitionError,
    );
    assert.equal(setCalls, 0);
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
      ttlMs: 200,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, client);
    const second = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 200,
      acquireTimeoutMs: 5,
      retryDelayMs: 1,
    }, client);

    await first.withLock("/tmp/db", async () => {
      await sleep(130);
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

  it("waits for the active write before reporting Redis lease integrity loss", async () => {
    const events = [];
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 120,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        return "OK";
      },
      async eval(script) {
        if (script.includes("pexpire")) {
          events.push("lease-lost");
          return 0;
        }
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => {
        events.push("write-started");
        await sleep(150);
        events.push("write-settled");
      }),
      RedisLockLeaseIntegrityError,
    );
    assert.deepEqual(events.at(-1), "write-settled");
    assert.ok(events.includes("lease-lost"));
  });

  it("reports Redis lease integrity loss even when the locked callback throws", async () => {
    const events = [];
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 120,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        return "OK";
      },
      async eval(script) {
        if (script.includes("pexpire")) {
          events.push("lease-lost");
          return 0;
        }
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => {
        events.push("write-started");
        await sleep(150);
        events.push("write-throwing");
        throw new Error("callback failed");
      }),
      (err) => {
        assert.ok(err instanceof RedisLockLeaseIntegrityError);
        assert.match(err.message, /callback also failed: callback failed/);
        assert.equal(err.cause?.name, "RedisLockLeaseLostError");
        return true;
      },
    );
    assert.deepEqual(events.at(-1), "write-throwing");
    assert.ok(events.includes("lease-lost"));
  });

  it("does not lose the lease after a single transient renewal failure", async () => {
    const warnings = [];
    let renewAttempts = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 700,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
      onWarning: (message) => warnings.push(message),
    }, {
      async set() {
        return "OK";
      },
      async eval(script) {
        if (script.includes("pexpire")) {
          renewAttempts += 1;
          if (renewAttempts === 1) {
            throw new Error("temporary Redis timeout");
          }
          return 1;
        }
        return 1;
      },
    });

    const result = await manager.withLock("/tmp/db", async () => {
      const deadline = Date.now() + 350;
      while (renewAttempts < 2 && Date.now() < deadline) {
        await sleep(5);
      }
      return "committed";
    });

    assert.equal(result, "committed");
    assert.ok(renewAttempts >= 2);
    assert.match(warnings.join("\n"), /transient Redis lock renewal failure/);
  });

  it("does not renew sub-second leases more aggressively than every 100ms", async () => {
    let renewAttempts = 0;
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 1_000,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        return "OK";
      },
      async eval(script) {
        if (script.includes("pexpire")) {
          renewAttempts += 1;
          return 1;
        }
        return 1;
      },
    });

    const result = await manager.withLock("/tmp/db", async () => {
      await sleep(90);
      return "committed";
    });

    assert.equal(result, "committed");
    assert.equal(renewAttempts, 0);
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

  it("reports lease integrity loss when final release no longer owns the token", async () => {
    const manager = new RedisLockManager({
      url: "redis://localhost:6379",
      ttlMs: 5_000,
      acquireTimeoutMs: 20,
      retryDelayMs: 1,
    }, {
      async set() {
        return "OK";
      },
      async eval() {
        return 0;
      },
    });

    await assert.rejects(
      () => manager.withLock("/tmp/db", async () => 42),
      RedisLockLeaseIntegrityError,
    );
  });
});

describe("MemoryStore Redis fail-closed locking", () => {
  it("fails closed instead of falling back to file locking when Redis is unavailable", async () => {
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
        throw new RedisLockUnavailableError("redis down");
      },
      close: async () => {},
    };

    await assert.rejects(
      () => store.importEntry({
        id: "memory-1",
        text: "must not write through local fallback",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      }),
      RedisLockUnavailableError,
    );

    assert.equal(added.length, 0);
    assert.equal(fileLocks, 0);
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

  it("fails closed when Redis locking is explicitly enabled without a URL", async () => {
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
      redisLock: { enabled: true },
    });
    store.table = {
      add: async (entries) => {
        added.push(...entries);
      },
    };

    await assert.rejects(
      () => store.importEntry({
        id: "memory-1",
        text: "must not write without redis url",
        vector: [0.1, 0.2, 0.3],
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        metadata: "{}",
      }),
      RedisLockUnavailableError,
    );

    assert.equal(added.length, 0);
    assert.equal(fileLocks, 0);
  });

  it("runs automatic index folding inside the Redis write-lock domain", async () => {
    const dbPath = tempDbPath();
    let fileLocks = 0;
    const redisEvents = [];
    __setLockfileModuleForTests({
      lock: async () => {
        fileLocks += 1;
        return async () => {};
      },
    });

    let optimizeCalls = 0;
    const store = new MemoryStore({
      dbPath,
      vectorDim: 3,
      redisLock: { enabled: true, url: "redis://localhost:6379" },
    });
    store.table = {
      optimize: async (options) => {
        optimizeCalls += 1;
        redisEvents.push(options.cleanupOlderThan?.getTime?.());
        return {};
      },
    };
    store.redisLock = {
      withLock: async (_resource, fn) => {
        redisEvents.push("redis-lock");
        return fn();
      },
      close: async () => {},
    };

    for (let i = 0; i < 20; i++) {
      store.noteDataModification();
    }

    const deadline = Date.now() + 250;
    while (optimizeCalls === 0 && Date.now() < deadline) {
      await sleep(5);
    }

    assert.equal(optimizeCalls, 1);
    assert.deepEqual(redisEvents, ["redis-lock", 0]);
    assert.equal(fileLocks, 0);
  });

  it("rebuilds the FTS index inside the Redis write-lock domain", async () => {
    const dbPath = tempDbPath();
    let fileLocks = 0;
    const events = [];
    __setLockfileModuleForTests({
      lock: async () => {
        fileLocks += 1;
        return async () => {};
      },
    });

    let indices = [{ indexType: "FTS", columns: ["text"], name: "text_idx" }];
    const store = new MemoryStore({
      dbPath,
      vectorDim: 3,
      redisLock: { enabled: true, url: "redis://localhost:6379" },
    });
    store.table = {
      listIndices: async () => {
        events.push("list");
        return indices;
      },
      dropIndex: async (name) => {
        events.push(`drop:${name}`);
        indices = [];
      },
      createIndex: async (column) => {
        events.push(`create:${column}`);
        indices = [{ indexType: "FTS", columns: ["text"], name: "text_idx" }];
      },
    };
    store.redisLock = {
      withLock: async (_resource, fn) => {
        events.push("redis-lock:start");
        const result = await fn();
        events.push("redis-lock:end");
        return result;
      },
      close: async () => {},
    };

    const result = await store.rebuildFtsIndex();

    assert.deepEqual(result, { success: true });
    assert.deepEqual(events, [
      "redis-lock:start",
      "list",
      "drop:text_idx",
      "list",
      "create:text",
      "redis-lock:end",
    ]);
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

  it("enables Redis locking from MEMORY_LANCEDB_REDIS_URL", () => {
    process.env.MEMORY_LANCEDB_REDIS_URL = "redis://localhost:6379/9";

    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
    });

    assert.equal(parsed.redisUrl, undefined);
    assert.equal(parsed.locking.redis.enabled, true);
    assert.equal(parsed.locking.redis.url, "redis://localhost:6379/9");
  });

  it("prefers nested Redis URL before resolving legacy redisUrl", () => {
    delete process.env.REDIS_URL;
    delete process.env.MEMORY_LANCEDB_REDIS_URL;

    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      redisUrl: "${REDIS_URL}",
      locking: {
        redis: {
          enabled: true,
          url: "redis://localhost:6379/3",
        },
      },
    });

    assert.equal(parsed.redisUrl, undefined);
    assert.equal(parsed.locking.redis.enabled, true);
    assert.equal(parsed.locking.redis.url, "redis://localhost:6379/3");
  });

  it("does not resolve Redis URL placeholders when Redis locking is disabled", () => {
    delete process.env.REDIS_URL;
    delete process.env.MEMORY_LANCEDB_REDIS_URL;

    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      redisUrl: "${REDIS_URL}",
      locking: {
        redis: {
          enabled: false,
          url: "${REDIS_URL}",
        },
      },
    });

    assert.equal(parsed.redisUrl, undefined);
    assert.deepEqual(parsed.locking.redis, {
      enabled: false,
      url: undefined,
      keyPrefix: undefined,
      ttlMs: 60000,
      acquireTimeoutMs: 5000,
      retryDelayMs: 50,
      connectTimeoutMs: 1000,
    });
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
    assert.equal(pkg.dependencies.ioredis, undefined, "ioredis should not be a hard dependency");
    assert.ok(pkg.optionalDependencies.ioredis, "package.json should declare ioredis as optional");
  });
});
