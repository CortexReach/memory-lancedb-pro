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
const { MemoryStore, __setLockfileModuleForTests } = jiti("../src/store.ts");
const { parsePluginConfig } = jiti("../index.ts");

const tempDirs = [];

afterEach(() => {
  __setLockfileModuleForTests({
    lock: async () => async () => {},
  });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStoreWithMockTable(table) {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-maintenance-"));
  tempDirs.push(dir);
  const store = new MemoryStore({ dbPath: dir, vectorDim: 3 });
  store.table = table;
  return store;
}

describe("LanceDB storage maintenance", () => {
  it("runs table.optimize under the store write lock", async () => {
    const calls = [];
    let releases = 0;
    __setLockfileModuleForTests({
      lock: async () => {
        calls.push("lock");
        return async () => {
          releases += 1;
        };
      },
    });

    let optimizeOptions;
    const store = makeStoreWithMockTable({
      optimize: async (options) => {
        optimizeOptions = options;
        return { removedFiles: 2 };
      },
    });

    const startedAt = Date.now();
    const result = await store.runStorageMaintenance(3);

    assert.deepEqual(calls, ["lock"]);
    assert.equal(releases, 1);
    assert.equal(result.retentionDays, 3);
    assert.deepEqual(result.stats, { removedFiles: 2 });
    assert.ok(optimizeOptions.cleanupOlderThan instanceof Date);
    assert.ok(
      Math.abs(optimizeOptions.cleanupOlderThan.getTime() - (startedAt - 3 * 24 * 60 * 60 * 1000)) < 5000,
      "cleanup cutoff should be based on the requested retention days",
    );
    assert.equal(result.cleanupOlderThan, optimizeOptions.cleanupOlderThan.toISOString());
  });

  it("uses the Redis write lock domain when Redis locking is enabled", async () => {
    let fileLocks = 0;
    let redisLocks = 0;
    __setLockfileModuleForTests({
      lock: async () => {
        fileLocks += 1;
        return async () => {};
      },
    });

    const store = makeStoreWithMockTable({
      optimize: async () => ({ removedFiles: 1 }),
    });
    store.redisLock = {
      withLock: async (_resource, fn) => {
        redisLocks += 1;
        return fn();
      },
      close: async () => {},
    };

    const result = await store.runStorageMaintenance(7);

    assert.equal(result.retentionDays, 7);
    assert.equal(redisLocks, 1);
    assert.equal(fileLocks, 0);
  });

  it("clamps unsafe retention values before cleanup", async () => {
    __setLockfileModuleForTests({
      lock: async () => async () => {},
    });
    const store = makeStoreWithMockTable({
      optimize: async () => ({ ok: true }),
    });

    const result = await store.runStorageMaintenance(0);

    assert.equal(result.retentionDays, 1);
  });

  it("keeps optimize failures observable", async () => {
    let releases = 0;
    __setLockfileModuleForTests({
      lock: async () => async () => {
        releases += 1;
      },
    });
    const store = makeStoreWithMockTable({
      optimize: async () => {
        throw new Error("optimize failed");
      },
    });

    await assert.rejects(
      () => store.runStorageMaintenance(7),
      /optimize failed/,
    );
    assert.equal(releases, 1, "lock should still be released after optimize failure");
  });
});

describe("storage maintenance config", () => {
  it("parses auto-cleanup defaults and explicit values", () => {
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      storageMaintenance: {
        autoCleanup: {
          enabled: true,
          intervalHours: "12",
          retentionDays: 5,
          initialDelayMs: 0,
        },
      },
    });

    assert.deepEqual(parsed.storageMaintenance, {
      autoCleanup: {
        enabled: true,
        intervalHours: 12,
        retentionDays: 5,
        initialDelayMs: 0,
      },
    });
  });

  it("declares schema and ui hints for auto-cleanup", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );

    assert.equal(
      manifest.configSchema.properties.storageMaintenance.properties.autoCleanup.properties.enabled.default,
      false,
    );
    assert.equal(
      manifest.configSchema.properties.storageMaintenance.properties.autoCleanup.properties.intervalHours.default,
      24,
    );
    assert.equal(
      manifest.configSchema.properties.storageMaintenance.properties.autoCleanup.properties.retentionDays.default,
      7,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.uiHints, "storageMaintenance.autoCleanup.enabled"),
      "storage maintenance should be discoverable in ui hints",
    );
  });
});

describe("read consistency interval config", () => {
  it("parses an explicit non-zero interval alongside auto-cleanup", () => {
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      storageMaintenance: {
        autoCleanup: { enabled: true, intervalHours: 12, retentionDays: 5, initialDelayMs: 0 },
        readConsistencyIntervalSeconds: 15,
      },
    });

    assert.deepEqual(parsed.storageMaintenance, {
      autoCleanup: {
        enabled: true,
        intervalHours: 12,
        retentionDays: 5,
        initialDelayMs: 0,
      },
      readConsistencyIntervalSeconds: 15,
    });
  });

  it("preserves an explicit 0 (strong consistency) rather than treating it as unset", () => {
    const parsed = parsePluginConfig({
      embedding: { apiKey: "test-key" },
      storageMaintenance: { readConsistencyIntervalSeconds: 0 },
    });

    assert.deepEqual(parsed.storageMaintenance, { readConsistencyIntervalSeconds: 0 });
  });

  it("omits storageMaintenance entirely when neither knob is configured", () => {
    const parsed = parsePluginConfig({ embedding: { apiKey: "test-key" } });
    assert.equal(parsed.storageMaintenance, undefined);
  });

  it("declares schema and ui hints for the read consistency interval", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );

    assert.equal(
      manifest.configSchema.properties.storageMaintenance.properties.readConsistencyIntervalSeconds.default,
      0,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.uiHints, "storageMaintenance.readConsistencyIntervalSeconds"),
      "read consistency interval should be discoverable in ui hints",
    );
  });
});
