import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

async function createSourceDb(sourceDbPath) {
  // Create a minimal LanceDB database with a `memories` table and 1 row.
  const { loadLanceDB } = jiti("../src/store.ts");
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(sourceDbPath);

  // Create table if missing.
  // LanceDB JS API supports createTable(name, data).
  const row = {
    id: "test_smoke_1",
    text: "hello from smoke test",
    category: "other",
    scope: "global",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
    vector: [0, 0, 0, 0],
  };

  try {
    await db.createTable("memories", [row]);
  } catch {
    // If already exists, ignore.
    const table = await db.openTable("memories");
    await table.add([row]);
  }
}

async function runCliSmoke() {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-smoke-"));
  const sourceDbPath = path.join(workDir, "source-db");

  await createSourceDb(sourceDbPath);

  const { createMemoryCLI } = jiti("../cli.ts");

  const program = new Command();
  program.exitOverride();

  const { MemoryStore } = jiti("../src/store.ts");

  const store = new MemoryStore({
    dbPath: path.join(workDir, "target-db"),
    vectorDim: 4,
  });

  const context = {
    store,
    // Only used for similarity-based dedupe when the import file has no id.
    retriever: { retrieve: async () => [] },
    scopeManager: { getDefaultScope: () => "global" },
    migrator: {},
    // Stub embedder used by import/reembed.
    embedder: {
      embedPassage: async () => [0, 0, 0, 0],
    },
  };

  // Register commands under `memory-pro`
  createMemoryCLI(context)({ program });

  // 1) version command should not throw
  await program.parseAsync(["node", "openclaw", "memory-pro", "version"]);

  // 2) reembed dry-run should not crash (regression test for clampInt)
  await program.parseAsync([
    "node",
    "openclaw",
    "memory-pro",
    "reembed",
    "--source-db",
    sourceDbPath,
    "--limit",
    "1",
    "--batch-size",
    "999",
    "--dry-run",
  ]);

  // 3) import should preserve id and be idempotent (skip on second import)
  const importId = "smoke_import_id_1";
  const importPhrase = `smoke-import-${Date.now()}`;
  const importFile = path.join(workDir, "import-test.json");

  writeFileSync(
    importFile,
    JSON.stringify(
      {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        count: 1,
        filters: {},
        memories: [
          {
            id: importId,
            text: `Import smoke test. UniquePhrase=${importPhrase}.`,
            category: "other",
            scope: "global",
            importance: 0.3,
            timestamp: Date.now(),
            metadata: "{}",
          },
        ],
      },
      null,
      2,
    ),
  );

  const captureLogs = async (argv) => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync(argv);
    } finally {
      console.log = origLog;
    }
    return logs.join("\n");
  };

  const out1 = await captureLogs([
    "node",
    "openclaw",
    "memory-pro",
    "import",
    importFile,
    "--scope",
    "agent:smoke",
  ]);
  assert.match(out1, /Import completed: 1 imported/, out1);

  const out2 = await captureLogs([
    "node",
    "openclaw",
    "memory-pro",
    "import",
    importFile,
    "--scope",
    "agent:smoke",
  ]);
  assert.match(out2, /Import completed: 0 imported, 1 skipped/, out2);

  // 4) Access reinforcement formula smoke test
  const { parseAccessMetadata, buildUpdatedMetadata, computeEffectiveHalfLife } =
    jiti("../src/access-tracker.ts");

  // Verify formula basics
  const hl0 = computeEffectiveHalfLife(60, 0, 0, 0.5, 3);
  assert.equal(hl0, 60, "zero access = base half-life");

  const hl10 = computeEffectiveHalfLife(60, 10, Date.now(), 0.5, 3);
  assert.ok(hl10 > 60 && hl10 < 180, `10 accesses: ${hl10} should be between 60 and 180`);

  const hlCapped = computeEffectiveHalfLife(60, 100000, Date.now(), 0.5, 3);
  assert.equal(hlCapped, 180, "capped at 3x");

  // Verify metadata round-trip
  const meta = buildUpdatedMetadata("{}", 5);
  const parsed = parseAccessMetadata(meta);
  assert.equal(parsed.accessCount, 5);
  assert.ok(parsed.lastAccessedAt > 0);

  console.log("OK: Access reinforcement formula verified");

  rmSync(workDir, { recursive: true, force: true });
}

runCliSmoke()
  .then(() => {
    console.log("OK: CLI smoke test passed");
  })
  .catch((err) => {
    console.error("FAIL: CLI smoke test failed");
    console.error(err);
    process.exit(1);
  });
