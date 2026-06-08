import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { AccessTracker } = jiti("../src/access-tracker.ts");
const legacySlugMemory = JSON.parse(
  readFileSync(new URL("./fixtures/legacy-slug-memory.json", import.meta.url), "utf8"),
);
const upgradedLegacyMetadata = JSON.stringify({ memory_category: "cases" });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MemoryStore update rollback (real LanceDB backend)", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-risk-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function createStoreWithEntry(overrides = {}) {
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

  it("restores the original record if delete succeeds and add fails", async () => {
    const { store, entry } = await createStoreWithEntry();
    let failed = false;
    const restore = wrapTableMethod(store, "add", (original) => async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("injected add failure");
      }
      return original(...args);
    });

    await assert.rejects(
      store.update(entry.id, { text: "updated memory", vector: [1, 1, 1, 1] }),
      /latest available record restored/,
    );

    restore();

    assert.equal((await store.getById(entry.id))?.text, "original memory");
    assert.equal((await store.list(["global"]))[0]?.text, "original memory");
  });

  it("preserves the latest committed value under concurrent update failure", async () => {
    const { store, entry } = await createStoreWithEntry();

    const secondDeleteQueued = deferred();
    const secondDeleteGate = deferred();
    const secondAddGate = deferred();
    let deleteCount = 0;
    let addCount = 0;

    const restoreDelete = wrapTableMethod(
      store,
      "delete",
      (original) => async (...args) => {
        deleteCount += 1;
        if (deleteCount === 2) {
          secondDeleteQueued.resolve();
          await secondDeleteGate.promise;
        }
        return original(...args);
      },
    );

    const restoreAdd = wrapTableMethod(
      store,
      "add",
      (original) => async (...args) => {
        addCount += 1;
        if (addCount === 2) {
          await secondAddGate.promise;
          throw new Error("injected add failure");
        }
        return original(...args);
      },
    );

    const first = store.update(entry.id, {
      text: "update from A",
      vector: [1, 0, 0, 0],
    });
    const second = store.update(entry.id, {
      text: "update from B",
      vector: [0, 1, 0, 0],
    });

    await secondDeleteQueued.promise;
    await first;

    assert.equal((await store.getById(entry.id))?.text, "update from A");

    secondDeleteGate.resolve();
    secondAddGate.resolve();

    await assert.rejects(second, /latest available record restored/);

    restoreDelete();
    restoreAdd();

    assert.equal((await store.getById(entry.id))?.text, "update from A");
    assert.equal((await store.list(["global"]))[0]?.text, "update from A");
  });

  it("access-tracker style metadata update preserves the row on write failure", async () => {
    const { store, entry } = await createStoreWithEntry({
      metadata: "{\"accessCount\":2}",
    });
    const warnings = [];
    let failed = false;

    const restore = wrapTableMethod(store, "add", (original) => async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("injected add failure");
      }
      return original(...args);
    });

    const tracker = new AccessTracker({
      store,
      logger: {
        warn(...args) {
          warnings.push(args.join(" "));
        },
        info() {},
      },
      debounceMs: 60_000,
    });

    tracker.recordAccess([entry.id]);
    await tracker.flush();
    tracker.destroy();
    restore();

    const preserved = await store.getById(entry.id);
    assert.equal(preserved?.text, "original memory");
    assert.equal(preserved?.metadata, "{\"accessCount\":2}");
    assert.ok(warnings.some((msg) => /write-back failed/i.test(msg)));
  });

  it("after a successful update, getById/list can still read the record", async () => {
    const { store, entry } = await createStoreWithEntry();

    const updated = await store.update(entry.id, {
      text: "updated memory",
      vector: [1, 1, 1, 1],
      metadata: "{\"accessCount\":1}",
    });

    assert.equal(updated?.text, "updated memory");

    const byId = await store.getById(entry.id);
    assert.equal(byId?.text, "updated memory");
    assert.equal(byId?.metadata, "{\"accessCount\":1}");

    const listed = await store.list(["global"]);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].text, "updated memory");
  });

  it("updates imported legacy records with stable slug IDs", async () => {
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });

    await store.importEntry(legacySlugMemory);
    await store.importEntry({
      ...legacySlugMemory,
      id: "working-sessions-canonical-path-v2",
      text: "Another imported legacy memory with a stable slug ID.",
    });

    const updated = await store.update(legacySlugMemory.id, {
      text: "upgraded legacy memory",
      metadata: upgradedLegacyMetadata,
    });

    assert.equal(updated?.id, legacySlugMemory.id);
    assert.equal(updated?.text, "upgraded legacy memory");

    const byId = await store.getById(legacySlugMemory.id);
    assert.equal(byId?.text, "upgraded legacy memory");
    assert.equal(byId?.metadata, upgradedLegacyMetadata);

    const updatedV2 = await store.update("working-sessions-canonical-path-v2", {
      text: "upgraded v2 legacy memory",
      metadata: upgradedLegacyMetadata,
    });

    assert.equal(updatedV2?.id, "working-sessions-canonical-path-v2");
    assert.equal(updatedV2?.text, "upgraded v2 legacy memory");
  });

  it("rejects clearly invalid memory IDs instead of treating them as exact legacy IDs", async () => {
    const { store } = await createStoreWithEntry();
    const invalidIds = [
      "",
      "not an id",
      "bad/id",
      "bad'id",
      "bad\nid",
      "-starts-with-symbol",
      "ab",
    ];

    for (const invalidId of invalidIds) {
      await assert.rejects(
        () => store.update(invalidId, { text: "should not update" }),
        /Invalid memory ID format/,
        `expected invalid ID to be rejected: ${JSON.stringify(invalidId)}`,
      );
    }
  });
});
