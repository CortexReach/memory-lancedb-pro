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

describe("memory_forget direct-id references stay exact (destructive-path guard)", () => {
  let workDir;
  let harness;
  let store;
  let seeded;

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "lancedb-exact-ref-test-"));
    resetRegistration();
    harness = createPluginApiHarness({
      // management tools on: memory_promote / memory_archive share the
      // destructive-path exact-reference contract under test here
      pluginConfig: { ...makePluginConfig(workDir), enableManagementTools: true },
      resolveRoot: workDir,
    });
    await memoryLanceDBProPlugin.register(harness.api);
    store = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    seeded = await store.store({
      text: "Unrelated durable note that must survive malformed forget calls",
      vector: FIXED_VECTOR,
      category: "fact",
      scope: "agent:agent-one",
      importance: 0.8,
      metadata: JSON.stringify({ memory_category: "cases", l0_abstract: "Unrelated durable note" }),
    });
    assert.ok(seeded?.id);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("a malformed direct memoryId is rejected and cannot delete an unrelated row", async () => {
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: "not-an-id",
    });
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /not a memory id|not found/i, `unexpected response: ${text}`);
    const survivors = await store.list(undefined, undefined, 10, 0);
    assert.equal(survivors.length, 1, "the unrelated row must survive a malformed direct-id forget");
    assert.equal(survivors[0].id, seeded.id);
  });

  it("a supported legacy mem-md-N direct id goes through exact handling and cannot delete an unrelated row", async () => {
    const result = await callTool(harness.toolFactories, "memory_forget", {
      memoryId: "mem-md-42",
    });
    const text = result.content?.[0]?.text ?? "";
    assert.doesNotMatch(text, /(deleted|removed).*Unrelated durable note/i, "must not claim deletion of the unrelated row");
    const survivors = await store.list(undefined, undefined, 10, 0);
    assert.equal(survivors.length, 1, "the unrelated row must survive a legacy-id forget that matches nothing");
    assert.equal(survivors[0].id, seeded.id);
  });

  it("memory_update with a malformed UUID-shaped id cannot modify an unrelated row", async () => {
    // The probe input: UUID-shaped but malformed (trailing comma). It fails
    // the anchored exact classifiers, and before the fix it fell through to
    // semantic retrieval, where a sole result is accepted with no minimum
    // score — letting update mutate or supersede a completely unrelated row.
    const result = await callTool(harness.toolFactories, "memory_update", {
      memoryId: "12345678-1234-1234-1234-123456789012,",
      text: "Poisoned replacement text that must never land",
    });
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /not a memory id|not found/i, `unexpected response: ${text}`);
    const rows = await store.list(undefined, undefined, 10, 0);
    assert.equal(rows.length, 1, "no supersede row may appear from a malformed update reference");
    assert.equal(rows[0].id, seeded.id);
    assert.match(rows[0].text, /Unrelated durable note/, "the unrelated row's text must be untouched");
  });

  it("memory_archive with a malformed direct memoryId cannot archive an unrelated row", async () => {
    const result = await callTool(harness.toolFactories, "memory_archive", {
      memoryId: "not-an-id",
    });
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /not a memory id|not found/i, `unexpected response: ${text}`);
    const reader = new MemoryStore({ dbPath: path.join(workDir, "db"), vectorDim: EMBEDDING_DIMENSIONS });
    const row = await reader.getById(seeded.id, ["agent:agent-one"]);
    const meta = JSON.parse(row?.metadata ?? "{}");
    assert.notEqual(meta.state, "archived", "the unrelated row must not be archived");
  });

  it("memory_promote with a malformed direct memoryId cannot touch an unrelated row, while the explicit query selector still resolves semantically", async () => {
    const malformed = await callTool(harness.toolFactories, "memory_promote", {
      memoryId: "12345678-1234-1234-1234-123456789012,",
    });
    const malformedText = malformed.content?.[0]?.text ?? "";
    assert.match(malformedText, /not a memory id|not found/i, `unexpected response: ${malformedText}`);

    // The dual selector keeps its documented contract: an explicit `query`
    // is the deliberate semantic path and must still resolve.
    const byQuery = await callTool(harness.toolFactories, "memory_promote", {
      query: "unrelated durable note",
    });
    const byQueryText = JSON.stringify(byQuery?.content ?? "");
    assert.ok(
      byQueryText.includes(seeded.id.slice(0, 8)),
      `promote by explicit query must still resolve semantically: ${byQueryText}`,
    );
  });
});
