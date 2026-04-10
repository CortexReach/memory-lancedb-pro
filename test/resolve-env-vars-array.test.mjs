import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");
const { parsePluginConfig } = plugin;

const EMBEDDING_DIMENSIONS = 64;

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const value = 1 / Math.sqrt(EMBEDDING_DIMENSIONS);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding", index,
        embedding: new Array(EMBEDDING_DIMENSIONS).fill(value),
      })),
      model: body.model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
}

function createLlmServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ memories: [] }) }, finish_reason: "stop" }],
    }));
  });
}

async function withTestEnv(apiKeyConfig, fn) {
  const workDir = mkdtempSync(path.join(tmpdir(), "env-vars-array-test-"));
  const dbPath = path.join(workDir, "test.db");
  const embeddingServer = createEmbeddingServer();
  const llmServer = createLlmServer();
  await new Promise((r) => embeddingServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => llmServer.listen(0, "127.0.0.1", r));
  const ePort = embeddingServer.address().port;
  const lPort = llmServer.address().port;

  try {
    const logs = [];
    const api = {
      pluginConfig: {
        dbPath,
        autoCapture: false,
        autoRecall: false,
        smartExtraction: true,
        embedding: {
          apiKey: apiKeyConfig,
          model: "mock-model",
          baseURL: `http://127.0.0.1:${ePort}/v1`,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        llm: {
          model: "mock-llm",
          baseURL: `http://127.0.0.1:${lPort}`,
        },
        retrieval: { mode: "hybrid" },
        scopes: {
          default: "global",
          definitions: { global: { description: "shared" } },
        },
      },
      hooks: {},
      toolFactories: {},
      services: [],
      logger: {
        info(...args) { logs.push(["info", args.join(" ")]); },
        warn(...args) { logs.push(["warn", args.join(" ")]); },
        error(...args) { logs.push(["error", args.join(" ")]); },
        debug(...args) { logs.push(["debug", args.join(" ")]); },
      },
      resolvePath(v) { return v; },
      registerTool(t, m) { this.toolFactories[m.name] = typeof t === "function" ? t : () => t; },
      registerCli() {},
      registerService(s) { this.services.push(s); },
      on(name, handler) { this.hooks[name] = handler; },
      registerHook(name, handler) { this.hooks[name] = handler; },
    };

    plugin.register(api);
    await fn(logs);
  } finally {
    await new Promise((r) => embeddingServer.close(r));
    await new Promise((r) => llmServer.close(r));
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("smart extraction initializes with string[] apiKey (no llm.apiKey fallback)", async () => {
  await withTestEnv(["key-alpha", "key-beta"], (logs) => {
    const warnLogs = logs.filter(([level]) => level === "warn").map(([, msg]) => msg);
    const infoLogs = logs.filter(([level]) => level === "info").map(([, msg]) => msg);

    assert.ok(
      !warnLogs.some((msg) => msg.includes("smart extraction init failed")),
      `should not fail with array apiKey, got: ${JSON.stringify(warnLogs)}`,
    );
    assert.ok(
      infoLogs.some((msg) => msg.includes("smart extraction enabled")),
      `smart extraction should be enabled, got: ${JSON.stringify(infoLogs)}`,
    );
  });
});

test("smart extraction initializes with single-element array apiKey", async () => {
  await withTestEnv(["only-key"], (logs) => {
    const warnLogs = logs.filter(([level]) => level === "warn").map(([, msg]) => msg);
    assert.ok(
      !warnLogs.some((msg) => msg.includes("smart extraction init failed")),
      `single-element array should work, got: ${JSON.stringify(warnLogs)}`,
    );
  });
});

test("smart extraction initializes with env var in array apiKey", async () => {
  process.env.__TEST_MEMORY_KEY = "resolved-from-env";
  try {
    await withTestEnv(["${__TEST_MEMORY_KEY}"], (logs) => {
      const warnLogs = logs.filter(([level]) => level === "warn").map(([, msg]) => msg);
      assert.ok(
        !warnLogs.some((msg) => msg.includes("smart extraction init failed")),
        `env var in array should resolve, got: ${JSON.stringify(warnLogs)}`,
      );
    });
  } finally {
    delete process.env.__TEST_MEMORY_KEY;
  }
});

test("parsePluginConfig preserves string[] apiKey", () => {
  const config = parsePluginConfig({
    embedding: {
      apiKey: ["key-one", "key-two"],
      model: "text-embedding-3-small",
      baseURL: "https://api.example.com/v1",
    },
  });
  assert.ok(Array.isArray(config.embedding.apiKey));
  assert.equal(config.embedding.apiKey.length, 2);
});

test("parsePluginConfig preserves single string apiKey", () => {
  const config = parsePluginConfig({
    embedding: {
      apiKey: "single-key",
      model: "text-embedding-3-small",
    },
  });
  assert.equal(config.embedding.apiKey, "single-key");
});

test("parsePluginConfig rejects empty array apiKey", () => {
  assert.throws(
    () => parsePluginConfig({
      embedding: {
        apiKey: [],
        model: "text-embedding-3-small",
      },
    }),
    /apiKey/,
  );
});

test("parsePluginConfig resolves env vars in retrieval rerank config", () => {
  process.env.__TEST_RERANK_KEY = "rerank-key-from-env";
  process.env.__TEST_RERANK_ENDPOINT = "https://api.jina.ai/v1/rerank";
  process.env.__TEST_RERANK_MODEL = "jina-reranker-v2-base-multilingual";
  process.env.__TEST_RERANK_PROVIDER = "jina";
  try {
    const config = parsePluginConfig({
      embedding: {
        apiKey: "embed-key",
        model: "text-embedding-3-small",
      },
      retrieval: {
        rerank: "cross-encoder",
        rerankApiKey: "${__TEST_RERANK_KEY}",
        rerankEndpoint: "${__TEST_RERANK_ENDPOINT}",
        rerankModel: "${__TEST_RERANK_MODEL}",
        rerankProvider: "${__TEST_RERANK_PROVIDER}",
      },
    });
    assert.equal(config.retrieval.rerankApiKey, "rerank-key-from-env");
    assert.equal(config.retrieval.rerankEndpoint, "https://api.jina.ai/v1/rerank");
    assert.equal(config.retrieval.rerankModel, "jina-reranker-v2-base-multilingual");
    assert.equal(config.retrieval.rerankProvider, "jina");
  } finally {
    delete process.env.__TEST_RERANK_KEY;
    delete process.env.__TEST_RERANK_ENDPOINT;
    delete process.env.__TEST_RERANK_MODEL;
    delete process.env.__TEST_RERANK_PROVIDER;
  }
});
