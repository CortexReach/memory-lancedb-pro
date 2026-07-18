// Live-caught H1 bug (2026-07-18 night shift): memory_update's contract says
// "full UUID or 8+ char prefix", and injected context shows agents truncated
// row ids — but the uuid-detection regex treated an 8-char prefix as a FULL
// id, so prefix-based forget/update always failed "not found or access
// denied". These tests drive the real registered tools against a real temp
// LanceDB store and pin the prefix contract end to end.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const embedderModuleForMock = jiti("../src/embedder.js");
embedderModuleForMock.createEmbedder = () => ({
  async embedPassage() { return [0.5, 0.5, 0.5, 0.5]; },
  async embedQuery() { return [0.5, 0.5, 0.5, 0.5]; },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { MemoryStore } = jiti("../src/store.ts");
const { resolveMemoryId } = jiti("../src/tools.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const toolFactories = [];
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    on() {},
    registerCli() {},
    registerService() {},
    registerCommand() {},
    registerMemoryCapability() {},
    registerTool(toolFactory, meta) {
      toolFactories.push({ toolFactory, meta });
    },
  };
  return { api, toolFactories };
}

function makePluginConfig(workDir) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: {
      apiKey: "test-api-key",
      dimensions: EMBEDDING_DIMENSIONS,
    },
    smartExtraction: false,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
  };
}

async function callTool(toolFactories, name, params) {
  const entry = toolFactories.find(({ meta }) => meta?.name === name);
  assert.ok(entry, `expected a registered ${name} tool`);
  const tool = entry.toolFactory({});
  return tool.execute("test-call-id", params, undefined, undefined, { agentId: "agent-one" });
}

describe("memory id-prefix resolution (forget/update contract)", () => {
  let workDir;
  let harness;
  let store;
  let seeded;

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "lancedb-prefix-test-"));
    resetRegistration();
    harness = createPluginApiHarness({
      pluginConfig: makePluginConfig(workDir),
      resolveRoot: workDir,
    });
    await memoryLanceDBProPlugin.register(harness.api);

    store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    seeded = await store.store({
      text: "Spice jars are labeled in the kitchen drawer",
      vector: FIXED_VECTOR,
      category: "entity",
      scope: "agent:agent-one",
      importance: 0.8,
      metadata: JSON.stringify({ memory_category: "entities", l0_abstract: "Spice jars labeled" }),
    });
    assert.ok(seeded?.id, "seed row must store");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("memory_forget deletes a row addressed by an 8-char id prefix", async () => {
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: seeded.id.slice(0, 8),
    });
    assert.equal(result?.details?.action, "deleted", JSON.stringify(result?.content));
    // Fresh store instance: the plugin deleted through its own handle, and a
    // second handle's read view can lag; a new instance sees current state.
    const reader = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    assert.equal(await reader.getById(seeded.id, ["agent:agent-one"]), null);
  });

  it("memory_forget tolerates the trailing ellipsis agents copy from injected context", async () => {
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: `${seeded.id.slice(0, 8)}...`,
    });
    assert.equal(result?.details?.action, "deleted", JSON.stringify(result?.content));
  });

  it("memory_forget still deletes by full UUID exactly as before", async () => {
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: seeded.id,
    });
    assert.equal(result?.details?.action, "deleted");
  });

  it("resolveMemoryId reports ambiguity when a prefix matches multiple rows, resolving nothing", async () => {
    const rows = [
      { id: "aabbccdd-1111-4111-8111-111111111111", text: "row one", vector: [], category: "entity", scope: "agent:agent-one", importance: 0.5, timestamp: 1, metadata: "{}" },
      { id: "aabbccdd-2222-4222-8222-222222222222", text: "row two", vector: [], category: "entity", scope: "agent:agent-one", importance: 0.5, timestamp: 2, metadata: "{}" },
    ];
    const stubContext = {
      store: {
        async findByIdPrefix() { return rows; },
        async count() { return rows.length; },
      },
      retriever: { async retrieve() { throw new Error("semantic search must not run for a hex prefix"); } },
    };
    const resolution = await resolveMemoryId(stubContext, "aabbccdd", ["agent:agent-one"]);
    assert.equal(resolution.ok, false);
    assert.match(resolution.message, /matches multiple memories/);
    assert.match(resolution.message, /aabbccdd/);
  });

  it("memory_update resolves an id prefix and supersedes the row with the new text", async () => {
    const result = await callTool(harness.toolFactories, "memory_update", {
      memoryId: seeded.id.slice(0, 13),
      text: "Spice jars are labeled and alphabetized in the kitchen drawer",
    });
    // A text change supersedes (temporal versioning): the reply names the
    // RESOLVED id, proving the prefix reached the real row.
    const replyText = JSON.stringify(result?.content ?? "");
    assert.ok(
      replyText.includes(seeded.id.slice(0, 8)),
      `update reply must reference the prefix-resolved row: ${replyText}`,
    );
    const reader = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    const rows = await reader.list(["agent:agent-one"], undefined, 50, 0);
    assert.ok(
      rows.some((row) => /alphabetized/.test(row.text)),
      "the superseding row must carry the new text",
    );
  });

  it("a prefix matching nothing reports not-found without touching other rows", async () => {
    const before = await store.count();
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: "ffffffff",
    });
    assert.notEqual(result?.details?.action, "deleted");
    assert.equal(await store.count(), before);
  });
});
