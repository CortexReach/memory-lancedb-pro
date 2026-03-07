import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { loadLanceDB, MemoryStore } = jiti("../src/store.ts");
const { createMigrator } = jiti("../src/migrate.ts");

describe("legacy LanceDB migration", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-migrate-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function createLegacyDb(rows) {
    const legacyPath = path.join(workDir, "legacy-db");
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(legacyPath);
    await db.createTable("memories", rows);
    return legacyPath;
  }

  async function createTargetStore() {
    return new MemoryStore({
      dbPath: path.join(workDir, "target-db"),
      vectorDim: 4,
    });
  }

  it("migrates legacy rows with Arrow vectors and preserves id/timestamp", async () => {
    const legacyPath = await createLegacyDb([
      {
        id: "legacy-1",
        text: "hello from legacy memory",
        importance: 0.8,
        category: "fact",
        createdAt: 1234567890,
        vector: [0, 0, 0, 0],
      },
    ]);

    const store = await createTargetStore();
    const migrator = createMigrator(store);

    const result = await migrator.migrate({
      sourceDbPath: legacyPath,
      skipExisting: false,
    });

    assert.equal(result.success, true, result.summary);
    assert.equal(result.migratedCount, 1);
    assert.equal(result.skippedCount, 0);
    assert.deepEqual(result.errors, []);

    const memories = await store.list(undefined, undefined, 10, 0);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, "legacy-1");
    assert.equal(memories[0].timestamp, 1234567890);
    assert.equal(memories[0].scope, "global");

    const metadata = JSON.parse(memories[0].metadata || "{}");
    assert.equal(metadata.migratedFrom, "memory-lancedb");
    assert.equal(metadata.originalId, "legacy-1");
    assert.equal(metadata.originalCreatedAt, 1234567890);
  });

  it("skips re-import when skipExisting is enabled and the legacy id already exists", async () => {
    const legacyPath = await createLegacyDb([
      {
        id: "legacy-keep-id",
        text: "keep the original identifier",
        importance: 0.6,
        category: "decision",
        createdAt: 2222222222,
        vector: [1, 0, 0, 0],
        scope: "agent:main",
      },
    ]);

    const store = await createTargetStore();
    await store.importEntry({
      id: "legacy-keep-id",
      text: "already migrated",
      vector: [1, 0, 0, 0],
      category: "decision",
      scope: "agent:main",
      importance: 0.6,
      timestamp: 2222222222,
      metadata: "{}",
    });

    const migrator = createMigrator(store);
    const result = await migrator.migrate({
      sourceDbPath: legacyPath,
      skipExisting: true,
    });

    assert.equal(result.success, true, result.summary);
    assert.equal(result.migratedCount, 0);
    assert.equal(result.skippedCount, 1);

    const memories = await store.list(undefined, undefined, 10, 0);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, "legacy-keep-id");
    assert.equal(memories[0].text, "already migrated");
  });
});
