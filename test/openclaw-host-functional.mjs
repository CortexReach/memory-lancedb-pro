import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function toVector(text) {
  const s = String(text || "").toLowerCase();
  return [
    s.includes("乌龙茶") || s.includes("oolong") ? 1 : 0,
    s.includes("咖啡") || s.includes("coffee") ? 1 : 0,
    s.includes("typescript") ? 1 : 0,
    Math.min(1, s.length / 1000),
  ];
}

function createEmbeddingResponse(input, model) {
  const values = Array.isArray(input) ? input : [input];
  return {
    object: "list",
    data: values.map((value, index) => ({
      object: "embedding",
      index,
      embedding: toVector(value),
    })),
    model,
    usage: {
      prompt_tokens: values.length,
      total_tokens: values.length,
    },
  };
}

async function startMockEmbeddingServer() {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const payload = createEmbeddingResponse(body.input, body.model || "mock-embed-4d");

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function stripPluginLogs(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("[plugins]"))
    .join("\n")
    .trim();
}

function parseJsonOutput(output) {
  const cleaned = stripPluginLogs(output);
  return JSON.parse(cleaned);
}

function runOpenClaw(profile, args, options = {}) {
  console.log(`RUN: openclaw --profile ${profile} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "openclaw",
      ["--profile", profile, "--no-color", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 120_000;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`openclaw ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      if ((code ?? 1) !== 0) {
        reject(new Error(`openclaw ${args.join(" ")} failed with code ${code ?? "unknown"}\n${combined}`));
        return;
      }
      resolve(combined);
    });
  });
}

async function createLegacyDb(baseDir) {
  const legacyPath = path.join(baseDir, "legacy-db");
  const { loadLanceDB } = jiti("../src/store.ts");
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(legacyPath);
  await db.createTable("memories", [
    {
      id: "legacy-1",
      text: "hello from legacy memory",
      importance: 0.8,
      category: "fact",
      createdAt: 1234567890,
      vector: [0, 0, 0, 0],
    },
  ]);
  return legacyPath;
}

async function main() {
  const runDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-openclaw-host-"));
  const profile = `mempro-host-${Date.now()}`;
  const profileDir = path.join(os.homedir(), `.openclaw-${profile}`);
  const configFile = path.join(profileDir, "openclaw.json");
  const importFile = path.join(runDir, "import.json");
  const exportFile = path.join(runDir, "export.json");
  let server;

  try {
    server = await startMockEmbeddingServer();

    const config = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
      plugins: {
        allow: ["memory-lancedb-pro"],
        load: {
          paths: [repoRoot],
        },
        slots: {
          memory: "memory-lancedb-pro",
        },
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              embedding: {
                provider: "openai-compatible",
                apiKey: "local-noauth",
                model: "mock-embed-4d",
                baseURL: server.baseURL,
                dimensions: 4,
                chunking: true,
              },
              dbPath: path.join(runDir, "db"),
              sessionStrategy: "none",
              autoCapture: false,
              autoRecall: false,
              captureAssistant: false,
              smartExtraction: false,
              retrieval: {
                mode: "vector",
                rerank: "none",
                minScore: 0,
                hardMinScore: 0,
              },
              sessionMemory: {
                enabled: false,
              },
            },
          },
        },
      },
    };

    writeFileSync(importFile, JSON.stringify({
      version: "1.0",
      exportedAt: new Date().toISOString(),
      count: 2,
      filters: {},
      memories: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          text: "用户偏好是乌龙茶，不喜欢冰美式咖啡。",
          category: "preference",
          scope: "global",
          importance: 0.9,
          timestamp: 1772931900000,
          metadata: "{}",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          text: "当前项目统一使用 TypeScript 编写插件逻辑。",
          category: "decision",
          scope: "global",
          importance: 0.85,
          timestamp: 1772931960000,
          metadata: "{}",
        },
      ],
    }, null, 2));

    rmSync(profileDir, { recursive: true, force: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2));

    const validateOutput = await runOpenClaw(profile, ["config", "validate"]);
    assert.match(validateOutput, /Config valid/);

    const infoOutput = await runOpenClaw(profile, ["plugins", "info", "memory-lancedb-pro"]);
    assert.match(infoOutput, /Status:\s+loaded/);
    assert.match(infoOutput, /CLI commands:\s+memory-pro/);

    const versionOutput = stripPluginLogs(await runOpenClaw(profile, ["memory-pro", "version"]));
    assert.equal(versionOutput, packageJson.version);

    const importOutput = await runOpenClaw(profile, ["memory-pro", "import", importFile, "--scope", "global"]);
    assert.match(importOutput, /Import completed: 2 imported, 0 skipped/);

    const listBeforeDelete = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "list", "--scope", "global", "--json"]));
    assert.equal(listBeforeDelete.length, 2);

    const searchOutput = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "search", "乌龙茶", "--scope", "global", "--json"]));
    assert.ok(searchOutput.length >= 1);
    assert.equal(searchOutput[0].entry.id, "11111111-1111-4111-8111-111111111111");

    const statsBeforeDelete = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "stats", "--scope", "global", "--json"]));
    assert.equal(statsBeforeDelete.memory.totalCount, 2);

    const statusOutput = parseJsonOutput(await runOpenClaw(profile, ["status", "--json", "--all"]));
    assert.ok(statusOutput.memory);
    assert.equal(statusOutput.memoryPlugin.slot, "memory-lancedb-pro");
    assert.equal(statusOutput.memory.provider, "openai-compatible");
    assert.equal(statusOutput.memory.model, "mock-embed-4d");
    assert.equal(statusOutput.memory.files, 2);
    assert.equal(statusOutput.memory.chunks, 2);
    assert.equal(statusOutput.memory.vector.enabled, true);
    assert.equal(statusOutput.memory.vector.available, true);
    assert.equal(statusOutput.memory.fts.enabled, true);
    assert.equal(statusOutput.memory.custom.plugin, "memory-lancedb-pro");

    const exportOutput = await runOpenClaw(profile, ["memory-pro", "export", "--scope", "global", "--output", exportFile]);
    assert.match(exportOutput, /Exported 2 memories/);
    const exported = JSON.parse(readFileSync(exportFile, "utf8"));
    assert.equal(exported.count, 2);

    const deleteOutput = await runOpenClaw(profile, ["memory-pro", "delete", "22222222-2222-4222-8222-222222222222", "--scope", "global"]);
    assert.match(deleteOutput, /deleted successfully/i);

    const listAfterDelete = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "list", "--scope", "global", "--json"]));
    assert.equal(listAfterDelete.length, 1);
    assert.equal(listAfterDelete[0].id, "11111111-1111-4111-8111-111111111111");

    const statsAfterDelete = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "stats", "--scope", "global", "--json"]));
    assert.equal(statsAfterDelete.memory.totalCount, 1);

    const legacyPath = await createLegacyDb(runDir);
    const migrateOutput = await runOpenClaw(profile, ["memory-pro", "migrate", "run", "--source", legacyPath]);
    assert.match(migrateOutput, /Status:\s+Success/);
    assert.match(migrateOutput, /Migrated:\s+1/);

    const verifyOutput = await runOpenClaw(profile, ["memory-pro", "migrate", "verify", "--source", legacyPath]);
    assert.match(verifyOutput, /Valid:\s+Yes/);

    const listAfterMigrate = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "list", "--scope", "global", "--json"]));
    assert.equal(listAfterMigrate.length, 2);
    assert.ok(listAfterMigrate.some((entry) => entry.id === "legacy-1"));

    const statsAfterMigrate = parseJsonOutput(await runOpenClaw(profile, ["memory-pro", "stats", "--scope", "global", "--json"]));
    assert.equal(statsAfterMigrate.memory.totalCount, 2);

    console.log("OK: openclaw host functional test passed");
  } finally {
    if (server) {
      await server.close();
    }
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
