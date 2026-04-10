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

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const { MemoryStore } = jiti("../src/store.ts");
const { storeReflectionToLanceDB } = jiti("../src/reflection-store.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];
const DAY_MS = 24 * 60 * 60 * 1000;

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = [];

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) {
        logs.push(["info", String(message)]);
      },
      warn(message) {
        logs.push(["warn", String(message)]);
      },
      debug(message) {
        logs.push(["debug", String(message)]);
      },
      error(message) {
        logs.push(["error", String(message)]);
      },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook(eventName, handler, opts) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta: opts });
      eventHandlers.set(eventName, list);
    },
  };

  return { api, eventHandlers, logs };
}

function makePluginConfig(workDir) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: {
      apiKey: "test-api-key",
      dimensions: EMBEDDING_DIMENSIONS,
    },
    sessionStrategy: "memoryReflection",
    smartExtraction: false,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
  };
}

async function seedReflection(dbPath, agentId, runAt = Date.now() - 2 * DAY_MS) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  await storeReflectionToLanceDB({
    reflectionText: [
      "## Invariants",
      `- Always verify reflection hook coverage for ${agentId}.`,
      "## Derived",
      `- Next run exercise the reflection injection path for ${agentId}.`,
    ].join("\n"),
    sessionKey: `agent:${agentId}:session:test`,
    sessionId: `session-${agentId}`,
    agentId,
    command: "command:new",
    scope: "global",
    toolErrorSignals: [],
    runAt,
    usedFallback: false,
    embedPassage: async () => FIXED_VECTOR,
    vectorSearch: async () => [],
    store: async (entry) => store.store(entry),
  });
}

async function invokeReflectionHooks({ workDir, agentId, explicitAgentId = agentId }) {
  const pluginConfig = makePluginConfig(workDir);
  await seedReflection(pluginConfig.dbPath, agentId);

  const harness = createPluginApiHarness({
    resolveRoot: workDir,
    pluginConfig,
  });

  memoryLanceDBProPlugin.register(harness.api);

  const promptHooks = harness.eventHandlers.get("before_prompt_build") || [];

  assert.equal(promptHooks.length, 2, "expected exactly two before_prompt_build hooks (invariants + derived)");

  // Sort by priority: lower priority value runs first (invariants=12, derived=15)
  const sorted = [...promptHooks].sort((a, b) => (a.meta?.priority ?? 99) - (b.meta?.priority ?? 99));
  const ctx = { sessionKey: `agent:${agentId}:test`, agentId: explicitAgentId };
  const startResult = await sorted[0].handler({}, ctx);   // invariants (priority 12)
  const promptResult = await sorted[1].handler({}, ctx);   // derived (priority 15)

  return { harness, startResult, promptResult };
}

describe("reflection hooks tolerate bypass scope filters", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflection-bypass-hook-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  ["system", "undefined"].forEach((reservedAgentId) => {
    it(`injects inherited and derived reflection context for bypass agentId=${reservedAgentId}`, async () => {
      const { harness, startResult, promptResult } = await invokeReflectionHooks({
        workDir,
        agentId: reservedAgentId,
      });

      assert.match(startResult?.prependContext || "", /<inherited-rules>/);
      assert.match(startResult?.prependContext || "", new RegExp(`Always verify reflection hook coverage for ${reservedAgentId}\\.`));
      assert.match(promptResult?.prependContext || "", /<derived-focus>/);
      assert.match(promptResult?.prependContext || "", new RegExp(`Next run exercise the reflection injection path for ${reservedAgentId}\\.`));
      assert.deepStrictEqual(
        harness.logs.filter(([level]) => level === "warn"),
        [],
        "hooks should not fall back to swallowed warning paths",
      );
    });
  });

  it("injects reflection context for a normal non-bypass agent id", async () => {
    const { harness, startResult, promptResult } = await invokeReflectionHooks({
      workDir,
      agentId: "main",
    });

    assert.match(startResult?.prependContext || "", /<inherited-rules>/);
    assert.match(startResult?.prependContext || "", /Always verify reflection hook coverage for main\./);
    assert.match(promptResult?.prependContext || "", /<derived-focus>/);
    assert.match(promptResult?.prependContext || "", /Next run exercise the reflection injection path for main\./);
    assert.deepStrictEqual(
      harness.logs.filter(([level]) => level === "warn"),
      [],
      "normal-agent hooks should not emit warning fallbacks",
    );
  });

  it("resolves reflection agent id from sessionKey when ctx.agentId is missing", async () => {
    const { harness, startResult, promptResult } = await invokeReflectionHooks({
      workDir,
      agentId: "main",
      explicitAgentId: undefined,
    });

    assert.match(startResult?.prependContext || "", /Always verify reflection hook coverage for main\./);
    assert.match(promptResult?.prependContext || "", /Next run exercise the reflection injection path for main\./);
    assert.deepStrictEqual(
      harness.logs.filter(([level]) => level === "warn"),
      [],
      "sessionKey-only resolution should not emit warning fallbacks",
    );
  });
});
