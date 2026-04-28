/**
 * Test: release() must be called when fn() throws AND isCompromised=true
 *
 * Bug scenario (Issue #415):
 * High load: event loop blocks past stale threshold (10s) while fn() is running.
 * Result: onCompromised fires (isCompromised=true) AND fn() throws (fnError=err).
 * Bug: finally block throws fnError but never calls release() → lock permanently leaked.
 *
 * This test uses jiti to access private runWithFileLock() directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore, __setLockfileModuleForTests } = jiti("../src/store.ts");

describe("lock release on fn() error + isCompromised=true", { concurrency: 1 }, () => {
  let workDir;

  it("REPRO: release() not called when fn() throws AND isCompromised=true", async () => {
    workDir = mkdtempSync(join(tmpdir(), "memory-lock-release-bug-"));
    const dbPath = join(workDir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.doInitialize(); // Ensure table exists so add() doesn't fail for wrong reason

    let releaseCalled = false;
    let onCompromisedCalled = false;

    // Mock proper-lockfile:
    // - Fire onCompromised IMMEDIATELY when lock() is called
    // - This simulates: event loop was already blocked >10s before lock was acquired
    const mockLockfile = {
      lock: async (lockPath, options = {}) => {
        if (typeof options.onCompromised === "function") {
          onCompromisedCalled = true;
          // Fire immediately — simulates stale detection before or during fn()
          options.onCompromised(new Error("ECOMPROMISED"));
        }
        return async () => {
          releaseCalled = true;
        };
      },
    };

    __setLockfileModuleForTests(mockLockfile);

    try {
      // Access private runWithFileLock via jiti + Reflect
      const Reflect_get = Reflect.get;
      const runWithFileLock = Reflect_get(store, "runWithFileLock").bind(store);

      // Call runWithFileLock with a function that THROWS (simulates table.add() failing under load)
      // Bug path: isCompromised=true (from onCompromised), fnError=err (from throw)
      await runWithFileLock(async () => {
        throw new Error("Simulated load-induced failure");
      });

      assert.fail("Expected runWithFileLock to throw");
    } catch (err) {
      // Expected: runWithFileLock throws because fnError !== null
      // BUG: release() was never called → lock leaked!
      console.log(`  [bug repro] fn() threw: "${err.message}"`);
      console.log(`  [bug repro] onCompromised fired: ${onCompromisedCalled}`);
      console.log(`  [bug repro] release() called: ${releaseCalled}`);

      assert.strictEqual(onCompromisedCalled, true, "onCompromised should have fired");
      // This assert FAILS on the buggy version → confirms the bug exists
      assert.strictEqual(releaseCalled, true,
        "BUG CONFIRMED: release() was NOT called when fn() threw AND isCompromised=true. " +
        "Lock is leaked! Fix: move release() to the start of finally block.");
    } finally {
      __setLockfileModuleForTests(null);
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("PASS: release() called when fn() throws but isCompromised=false", async () => {
    workDir = mkdtempSync(join(tmpdir(), "memory-lock-release-ok-"));
    const dbPath = join(workDir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.doInitialize();

    let releaseCalled = false;

    // Mock: onCompromised NEVER fires (normal scenario)
    const mockLockfile = {
      lock: async (lockPath, options = {}) => {
        return async () => { releaseCalled = true; };
      },
    };

    __setLockfileModuleForTests(mockLockfile);

    try {
      const Reflect_get = Reflect.get;
      const runWithFileLock = Reflect_get(store, "runWithFileLock").bind(store);

      await runWithFileLock(async () => {
        throw new Error("Normal failure");
      });
      assert.fail("Expected throw");
    } catch (err) {
      // release() should have been called even though fn() threw
      assert.strictEqual(releaseCalled, true,
        "release() should be called when fn() throws (normal error path)");
    } finally {
      __setLockfileModuleForTests(null);
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
