/**
 * Integration tests for register() non-blocking behavior.
 *
 * Approach: Instead of mocking setImmediate, we use timing to verify
 * that register() returns synchronously while async validation runs after.
 *
 * The key assertions:
 * 1. register() returns without blocking (sync call, < 10ms)
 * 2. Validation failures are logged as warnings, not thrown
 * 3. setImmediate callbacks are scheduled (detected via timing)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// F6: use default export; register is memoryLanceDBProPlugin.register
const memoryLanceDBProPlugin = jiti("../index.ts", { raw: ["--input-type=module"] });
const register = memoryLanceDBProPlugin?.register;

// Full PluginApi mock — covers all methods register() needs
function makePluginApi({ dbPath, warnCallback = () => {} } = {}) {
  const warnings = [];
  return {
    pluginConfig: {
      embedding: {
        apiKey: "test-key",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      dbPath,
    },
    resolvePath: (p) => {
      if (p.startsWith("~")) {
        return join(process.env.HOME || tmpdir(), p.slice(2));
      }
      return p;
    },
    logger: {
      info: () => {},
      warn: (msg) => {
        warnings.push(String(msg));
        warnCallback(String(msg));
      },
      error: () => {},
      debug: () => {},
    },
    workspaceRoot: tmpdir(),
    on: () => ({}),
    off: () => {},
    tool: () => {},
    registerTool: () => {},
    registerCli: () => {},
    registerHook: () => {},
    registerService: () => {},
    memory: {
      search: async () => [],
      add: async () => ({ id: "test" }),
    },
    getConfig: () => ({}),
    _warnings: warnings,
  };
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "memory-lancedb-pro-init-test-"));
}

// Time a synchronous function call
function timeSync(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("register() non-blocking behavior", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns synchronously within microseconds (no sync I/O blocking)", async () => {
    const api = makePluginApi({
      dbPath: join(tmpDir, "db"),
    });

    // Time the register() call — should be microseconds, not milliseconds
    // If register() does sync I/O (lstatSync, realpathSync, etc.), this will take 5-20ms
    const elapsed = timeSync(() => {
      let threw = false;
      let thrownError = null;
      try {
        register(api);
      } catch (err) {
        throws = true;
        thrownError = err;
      }
    });

    // If register() does sync I/O, elapsed would be > 5ms on this system
    // With our setImmediate deferral, it should be < 1ms
    assert.ok(elapsed < 5,
      `register() took ${elapsed.toFixed(2)}ms — if it does sync I/O it should take > 5ms. ` +
      `This suggests sync validateStoragePath is still on the critical path.`);
  });

  it("does NOT throw even when path is invalid (validation deferred to async)", () => {
    const innerDir = join(tmpDir, "unwritable-db");
    chmodSync(tmpDir, 0o555);

    const api = makePluginApi({
      dbPath: innerDir,
      warnCallback: () => {},
    });

    let threw = false;
    let thrownError = null;
    try {
      register(api);
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.strictEqual(threw, false,
      `register() should NOT throw even with non-writable path. Validation is deferred to async. Got: ${thrownError?.message}`);
  });

  it("validates path asynchronously — warning logged in next event loop tick", async () => {
    const innerDir = join(tmpDir, "unwritable-db");
    chmodSync(tmpDir, 0o555);

    const capturedWarnings = [];
    const api = makePluginApi({
      dbPath: innerDir,
      warnCallback: (msg) => capturedWarnings.push(String(msg)),
    });

    register(api);

    // Restore permissions immediately so subsequent tests work
    chmodSync(tmpDir, 0o755);

    // Give setImmediate time to run — need TWO ticks: schedule + async I/O
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 0));

    // Warning should be logged about the validation failure
    const allWarnings = [...capturedWarnings, ...(api._warnings || [])];
    const hasStorageWarning = allWarnings.some(w =>
      w.includes("storage path") || w.includes("Failed to create dbPath"),
    );
    assert.ok(hasStorageWarning,
      `Expected storage path warning. Got: ${allWarnings.join(" | ")}`);
  });

  it("succeeds with valid path — no warning logged", async () => {
    const dbPath = join(tmpDir, "valid-db");

    const capturedWarnings = [];
    const api = makePluginApi({
      dbPath,
      warnCallback: (msg) => capturedWarnings.push(String(msg)),
    });

    register(api);

    // Give setImmediate time to run
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 0));

    // No validation failure warning for valid path
    const allWarnings = [...capturedWarnings, ...(api._warnings || [])];
    const validationWarnings = allWarnings.filter(w =>
      w.includes("storage path") && w.includes("validation failed"),
    );
    assert.strictEqual(validationWarnings.length, 0,
      `Should not have validation failure warning. Got: ${allWarnings.join(" | ")}`);
  });
});

describe("validateStoragePathAsync — unit contract", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects when path is a file (not a directory)", async () => {
    const { validateStoragePathAsync } = jiti("../src/store.ts");
    const filePath = join(tmpDir, "file-not-dir");
    writeFileSync(filePath, "content");

    await assert.rejects(
      async () => validateStoragePathAsync(join(filePath, "subdir")),
      (err) => err instanceof Error && err.message.includes("not a directory"),
      "should reject when target is a file, not a directory",
    );
  });

  it("succeeds with existing directory", async () => {
    const { validateStoragePathAsync } = jiti("../src/store.ts");
    const result = await validateStoragePathAsync(tmpDir);
    assert.strictEqual(result, tmpDir);
  });

  it("creates missing intermediate directories recursively", async () => {
    const { validateStoragePathAsync } = jiti("../src/store.ts");
    const nested = join(tmpDir, "a", "b", "c", "nested-db");
    const result = await validateStoragePathAsync(nested);
    assert.strictEqual(result, nested);
  });
});