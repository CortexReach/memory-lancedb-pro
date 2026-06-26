import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function makeDeterministicEmbedder() {
  const toVector = (text) => {
    const s = String(text || "").toLowerCase();
    return [
      s.includes("乌龙茶") || s.includes("oolong") ? 1 : 0,
      s.includes("咖啡") || s.includes("coffee") ? 1 : 0,
      s.includes("typescript") ? 1 : 0,
      Math.min(1, s.length / 1000),
    ];
  };

  return {
    async embedQuery(text) {
      return toVector(text);
    },
    async embedPassage(text) {
      return toVector(text);
    },
    async embedBatchPassage(texts) {
      return texts.map((text) => toVector(text));
    },
    async test() {
      return { success: true, dimensions: 4 };
    },
  };
}

async function createLegacyDb(baseDir, rows) {
  const legacyPath = path.join(baseDir, "legacy-db");
  const { loadLanceDB } = jiti("../src/store.ts");
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(legacyPath);
  await db.createTable("memories", rows);
  return legacyPath;
}

async function captureStdout(run) {
  const logs = [];
  const stdout = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };
  process.stdout.write = function write(chunk, encoding, callback) {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk));
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return stdout.join("") || logs.join("\n");
}

async function runFunctionalE2E() {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-e2e-"));

  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const { createMemoryCLI } = jiti("../cli.ts");
    const { MemoryStore } = jiti("../src/store.ts");
    const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
    const { createScopeManager } = jiti("../src/scopes.ts");
    const { createMigrator } = jiti("../src/migrate.ts");

    const embedder = makeDeterministicEmbedder();
    const store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: 4,
    });
    const retriever = createRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rerank: "none",
      minScore: 0,
      hardMinScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
      filterNoise: false,
      candidatePoolSize: 10,
    });
    const scopeManager = createScopeManager({
      default: "global",
      definitions: {
        global: { description: "shared" },
        "agent:e2e": { description: "functional test scope" },
      },
      agentAccess: {
        e2e: ["global", "agent:e2e"],
      },
    });
    const migrator = createMigrator(store);

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store,
      retriever,
      scopeManager,
      migrator,
      embedder,
    })({ program });

    const importFile = path.join(workDir, "import.json");
    const exportFile = path.join(workDir, "export.json");
    const importMemories = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "用户偏好是乌龙茶，不喜欢冰美式咖啡。",
        category: "preference",
        scope: "agent:e2e",
        importance: 0.9,
        timestamp: Date.now(),
        metadata: "{}",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "当前项目统一使用 TypeScript 编写插件逻辑。",
        category: "decision",
        scope: "agent:e2e",
        importance: 0.85,
        timestamp: Date.now(),
        metadata: "{}",
      },
    ];
    writeFileSync(
      importFile,
      JSON.stringify(
        {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: importMemories.length,
          filters: {},
          memories: importMemories,
        },
        null,
        2,
      ),
    );

    const versionOutput = await captureStdout(async () => {
      await program.parseAsync(["node", "openclaw", "memory-pro", "version"]);
    });
    assert.match(versionOutput, new RegExp(pkg.version.replaceAll(".", "\\.")));

    const importOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "import",
        importFile,
        "--scope",
        "agent:e2e",
      ]);
    });
    assert.match(importOutput, /Import completed: 2 imported, 0 skipped/);

    const listOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "list",
        "--scope",
        "agent:e2e",
        "--json",
      ]);
    });
    const listed = JSON.parse(listOutput);
    assert.equal(listed.length, 2);

    const searchOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "search",
        "乌龙茶",
        "--scope",
        "agent:e2e",
        "--json",
      ]);
    });
    const searchResults = JSON.parse(searchOutput);
    assert.ok(searchResults.length >= 1);
    assert.equal(searchResults[0].entry.id, "11111111-1111-4111-8111-111111111111");

    const statsOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "stats",
        "--scope",
        "agent:e2e",
        "--json",
      ]);
    });
    const stats = JSON.parse(statsOutput);
    assert.equal(stats.memory.totalCount, 2);

    const exportOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "export",
        "--scope",
        "agent:e2e",
        "--output",
        exportFile,
      ]);
    });
    assert.match(exportOutput, /Exported 2 memories/);
    const exported = JSON.parse(readFileSync(exportFile, "utf8"));
    assert.equal(exported.count, 2);

    const deleteOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "delete",
        "22222222-2222-4222-8222-222222222222",
        "--scope",
        "agent:e2e",
      ]);
    });
    assert.match(deleteOutput, /deleted successfully/);

    const postDeleteListOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "list",
        "--scope",
        "agent:e2e",
        "--json",
      ]);
    });
    const postDeleteListed = JSON.parse(postDeleteListOutput);
    assert.equal(postDeleteListed.length, 1);
    assert.equal(postDeleteListed[0].id, "11111111-1111-4111-8111-111111111111");

    const legacyPath = await createLegacyDb(workDir, [
      {
        id: "legacy-func-1",
        text: "legacy migration remembers oolong tea preference",
        importance: 0.7,
        category: "fact",
        createdAt: 1234567890,
        vector: [1, 0, 0, 0],
        scope: "agent:e2e",
      },
    ]);

    const migrateOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "migrate",
        "run",
        "--source",
        legacyPath,
        "--default-scope",
        "agent:e2e",
      ]);
    });
    assert.match(migrateOutput, /Status: Success/);
    assert.match(migrateOutput, /Migrated: 1/);

    const verifyOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "migrate",
        "verify",
        "--source",
        legacyPath,
      ]);
    });
    assert.match(verifyOutput, /Valid: Yes|Valid: true/);

    const finalListOutput = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "list",
        "--scope",
        "agent:e2e",
        "--json",
      ]);
    });
    const finalListed = JSON.parse(finalListOutput);
    assert.equal(finalListed.length, 2);
    assert.ok(finalListed.some((item) => item.id === "11111111-1111-4111-8111-111111111111"));
    assert.ok(finalListed.some((item) => item.id === "legacy-func-1"));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

runFunctionalE2E()
  .then(() => {
    console.log("OK: functional e2e test passed");
  })
  .catch((error) => {
    console.error("FAIL: functional e2e test failed");
    console.error(error);
    process.exit(1);
  });
