import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { MemoryStore } = jiti("../src/store.ts");
const embedderMod = jiti("../src/embedder.js");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];
const originalCreateEmbedder = embedderMod.createEmbedder;

function createApiHarness({ pluginConfig, logs }) {
  return {
    pluginConfig,
    hooks: {},
    toolFactories: {},
    logger: {
      info(message) {
        logs.push(["info", String(message)]);
      },
      warn(message) {
        logs.push(["warn", String(message)]);
      },
      error(message) {
        logs.push(["error", String(message)]);
      },
      debug(message) {
        logs.push(["debug", String(message)]);
      },
    },
    resolvePath(value) {
      return value;
    },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService() {},
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

function createBasePluginConfig({ dbPath }) {
  return {
    dbPath,
    autoCapture: false,
    autoRecall: false,
    smartExtraction: false,
    extractionThrottle: { skipLowValue: false, maxExtractionsPerHour: 200 },
    embedding: {
      apiKey: "dummy",
      dimensions: EMBEDDING_DIMENSIONS,
    },
    scopes: {
      default: "user:${accountId}",
      definitions: {
        global: { description: "shared" },
      },
      agentAccess: {
        main: ["global", "user:*"],
      },
    },
  };
}

function registerPluginForTest({ workDir, dbName, logs, overrides = {} }) {
  const dbPath = path.join(workDir, dbName);
  const api = createApiHarness({
    pluginConfig: {
      ...createBasePluginConfig({ dbPath }),
      ...overrides,
    },
    logs,
  });
  memoryLanceDBProPlugin.register(api);
  return { api, dbPath };
}

async function listEntries(dbPath) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  return store.list(undefined, undefined, 20, 0);
}

async function runAgentEndHook(api, event, ctx) {
  await api.hooks.agent_end(event, ctx);
  const backgroundRun = api.hooks.agent_end?.__lastRun;
  if (backgroundRun && typeof backgroundRun.then === "function") {
    await backgroundRun;
  }
}

describe("template default implicit write scope", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "template-default-scope-"));
    embedderMod.createEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return FIXED_VECTOR;
        },
        async embedPassage() {
          return FIXED_VECTOR;
        },
      };
    };
  });

  afterEach(() => {
    embedderMod.createEmbedder = originalCreateEmbedder;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("skips before_reset writes when a template default scope cannot be resolved", async () => {
    const logs = [];
    const { api, dbPath } = registerPluginForTest({
      workDir,
      dbName: "db-before-reset",
      logs,
      overrides: { sessionMemory: { enabled: true } },
    });

    await api.hooks.before_reset(
      {
        reason: "new",
        messages: [
          { role: "user", content: "请记住我偏好乌龙茶。" },
          { role: "assistant", content: "已记录这个偏好。" },
        ],
      },
      {
        agentId: "main",
        sessionKey: "agent:main:discord:dm:42",
        sessionId: "session-before-reset",
        workspaceDir: workDir,
      },
    );

    const entries = await listEntries(dbPath);
    assert.equal(entries.length, 0);
    assert.equal(
      logs.some((entry) => entry[0] === "warn"),
      true,
      "expected unresolved template scope to emit a warning",
    );
  });

  it("resolves bypass auto-capture writes to a concrete template scope instead of the raw template string", async () => {
    const logs = [];
    const { api, dbPath } = registerPluginForTest({
      workDir,
      dbName: "db-agent-end",
      logs,
      overrides: { autoCapture: true },
    });

    await runAgentEndHook(
      api,
      {
        success: true,
        sessionKey: "agent:system:test",
        messages: [
          { role: "user", content: "请记住，我喜欢乌龙茶。" },
        ],
      },
      {
        agentId: "system",
        sessionKey: "agent:system:test",
        accountId: "alice",
      },
    );

    const entries = await listEntries(dbPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].scope, "user:alice");
    assert.notEqual(entries[0].scope, "user:${accountId}");
    assert.equal(
      logs.some((entry) => entry[1].includes("scope user:alice")),
      true,
      "expected logs to mention the resolved concrete scope",
    );
  });

  it("memory_store resolves a template default scope from runtime tool context", async () => {
    const logs = [];
    const { api, dbPath } = registerPluginForTest({
      workDir,
      dbName: "db-tool-runtime",
      logs,
    });

    const tool = api.toolFactories.memory_store({
      agentId: "main",
      accountId: "alice",
    });
    const result = await tool.execute(null, {
      text: "请记住我喜欢乌龙茶。",
      category: "preference",
    });

    assert.match(result.content[0].text, /Stored:/);
    const entries = await listEntries(dbPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].scope, "user:alice");
  });

  it("memory_store requires an explicit scope when a template default scope cannot be resolved", async () => {
    const logs = [];
    const { api, dbPath } = registerPluginForTest({
      workDir,
      dbName: "db-tool-unresolved",
      logs,
    });

    const tool = api.toolFactories.memory_store({
      agentId: "main",
    });
    const result = await tool.execute(null, {
      text: "请记住我喜欢乌龙茶。",
      category: "preference",
    });

    assert.equal(result.details?.error, "explicit_scope_required");
    assert.match(result.content[0].text, /explicit scope/i);
    const entries = await listEntries(dbPath);
    assert.equal(entries.length, 0);
  });
});
