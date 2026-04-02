import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { MemoryStore } = jiti("../src/store.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding",
        index,
        embedding: FIXED_VECTOR,
      })),
      model: payload.model || "mock-embedding-model",
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    }));
  });
}

function createApiHarness({ dbPath, embeddingBaseURL }) {
  return {
    pluginConfig: {
      dbPath,
      autoCapture: false,
      autoRecall: false,
      sessionStrategy: "systemSessionMemory",
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
    },
    hooks: {},
    toolFactories: {},
    services: [],
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    resolvePath(value) {
      return value;
    },
    registerTool() {},
    registerCli() {},
    registerService(service) {
      this.services.push(service);
    },
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

describe("systemSessionMemory before_reset", () => {
  let workDir;
  let embeddingServer;
  let embeddingBaseURL;

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-session-summary-"));
    embeddingServer = createEmbeddingServer();
    await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
    const port = embeddingServer.address().port;
    embeddingBaseURL = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise((resolve) => embeddingServer.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  it("stores a session-summary row for /new using before_reset messages", async () => {
    const dbPath = path.join(workDir, "db");
    const api = createApiHarness({ dbPath, embeddingBaseURL });

    memoryLanceDBProPlugin.register(api);

    assert.equal(typeof api.hooks.before_reset, "function");
    // selfImprovement registers command:new by default (#391)
    assert.equal(typeof api.hooks["command:new"], "function");

    await api.hooks.before_reset(
      {
        reason: "new",
        messages: [
          { role: "user", content: "Need to fix the OAuth endpoint." },
          { role: "assistant", content: "Patched the endpoint and verified the login flow." },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100123:topic:42",
        sessionId: "session-42",
        workspaceDir: workDir,
      },
    );

    const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const entries = await store.list(undefined, undefined, 10, 0);
    assert.equal(entries.length, 1);

    const [entry] = entries;
    const metadata = JSON.parse(entry.metadata || "{}");
    assert.equal(metadata.type, "session-summary");
    assert.equal(metadata.sessionId, "session-42");
    assert.equal(metadata.sessionKey, "agent:main:telegram:group:-100123:topic:42");
    assert.match(entry.text, /Source: telegram/);
    assert.match(entry.text, /Conversation Summary:/);
    assert.match(entry.text, /user: Need to fix the OAuth endpoint\./);
    assert.match(entry.text, /assistant: Patched the endpoint and verified the login flow\./);
  });

  it("skips writes for /reset", async () => {
    const dbPath = path.join(workDir, "db-reset");
    const api = createApiHarness({ dbPath, embeddingBaseURL });

    memoryLanceDBProPlugin.register(api);

    await api.hooks.before_reset(
      {
        reason: "reset",
        messages: [
          { role: "user", content: "This should not be stored." },
          { role: "assistant", content: "Correct, reset should skip session-summary writes." },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:discord:dm:99",
        sessionId: "session-reset",
        workspaceDir: workDir,
      },
    );

    const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const entries = await store.list(undefined, undefined, 10, 0);
    assert.equal(entries.length, 0);
  });
});
