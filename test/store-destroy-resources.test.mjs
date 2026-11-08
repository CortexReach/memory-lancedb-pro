// test/store-destroy-resources.test.mjs
/**
 * Verifies destroy() releases native LanceDB resources safely.
 *
 * Must-fix F2: destroy() must wait for an in-flight update (delete + re-add,
 * with rollback) instead of nulling/closing the table between the delete and
 * its re-add, which would lose the row.
 * MR1: the native table handle is closed explicitly instead of waiting for GC.
 * MR2: using the store after destroy() throws a clear "destroyed" error.
 * MR3: a failing native close is reported instead of swallowed.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MemoryStore.destroy resource cleanup (real LanceDB backend)", () => {
  let workDir;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  async function createStoreWithEntry(overrides = {}) {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-destroy-"));
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });

    const entry = await store.store({
      text: "original memory",
      vector: [0, 0, 0, 0],
      category: "fact",
      scope: "global",
      importance: 0.7,
      metadata: "{}",
      ...overrides,
    });

    return { store, entry };
  }

  function wrapTableMethod(store, methodName, wrapper) {
    const table = store.table;
    assert.ok(table, `expected initialized table for ${methodName}`);
    const original = table[methodName].bind(table);
    table[methodName] = wrapper(original);
    return () => {
      table[methodName] = original;
    };
  }

  it("waits for an in-flight update before closing the connection (F2)", async () => {
    const { store, entry } = await createStoreWithEntry();

    const addStarted = deferred();
    const addGate = deferred();
    let addCount = 0;
    let reAddCompleted = false;
    const restore = wrapTableMethod(store, "add", (original) => async (...args) => {
      addCount += 1;
      if (addCount === 1) {
        addStarted.resolve();
        await addGate.promise;
      }
      const result = await original(...args);
      if (addCount === 1) reAddCompleted = true;
      return result;
    });

    // Spy on the native connection close so we can assert destroy() did not
    // tear it down while the update was still between delete and re-add.
    let closedWhileReAddInFlight = null;
    const db = store.db;
    assert.ok(db, "expected initialized connection");
    const originalDbClose = db.close.bind(db);
    db.close = () => {
      closedWhileReAddInFlight = !reAddCompleted;
      return originalDbClose();
    };

    const updatePromise = store.update(entry.id, {
      text: "updated memory",
      vector: [1, 1, 1, 1],
    });

    await addStarted.promise; // update is now between its delete and re-add

    const destroyPromise = store.destroy();
    addGate.resolve(); // let the in-flight re-add finish

    const updated = await updatePromise;
    assert.equal(updated?.text, "updated memory");

    await destroyPromise;

    assert.equal(
      closedWhileReAddInFlight,
      false,
      "destroy() closed the connection while an update was still in flight",
    );

    restore();
  });

  it("closes the native table handle and clears references (MR1)", async () => {
    const { store } = await createStoreWithEntry();

    const table = store.table;
    assert.ok(table, "expected initialized table");

    let closed = 0;
    const originalClose = table.close.bind(table);
    table.close = () => {
      closed += 1;
      return originalClose();
    };

    await store.destroy();

    assert.equal(closed, 1, "expected the native table handle to be closed once");
    assert.equal(store.table, null);
    assert.equal(store.db, null);
  });

  it("throws a clear error when used after destroy (MR2)", async () => {
    const { store, entry } = await createStoreWithEntry();

    await store.destroy();

    await assert.rejects(
      () => store.getById(entry.id),
      /MemoryStore instance has been destroyed/,
    );
    await assert.rejects(
      () => store.update(entry.id, { text: "nope" }),
      /MemoryStore instance has been destroyed/,
    );
    await assert.rejects(
      () =>
        store.store({
          text: "nope",
          vector: [1, 1, 1, 1],
          category: "fact",
          scope: "global",
          importance: 0.5,
          metadata: "{}",
        }),
      /MemoryStore instance has been destroyed/,
    );
  });

  it("reports native close failures instead of swallowing them (MR3)", async () => {
    const { store } = await createStoreWithEntry();

    const table = store.table;
    assert.ok(table, "expected initialized table");
    const originalClose = table.close.bind(table);
    table.close = () => {
      throw new Error("injected table close failure");
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(" "));
    };
    try {
      await store.destroy();
    } finally {
      console.warn = originalWarn;
      table.close = originalClose;
    }

    assert.ok(
      warnings.some((message) => /failed to close LanceDB table/.test(message)),
      `expected a close failure warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(store.table, null);
  });
});
