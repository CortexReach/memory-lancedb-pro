import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
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
  const reflectionHooks = promptHooks.filter((hook) => {
    const priority = hook.meta?.priority;
    return priority === 12 || priority === 15;
  });

  assert.equal(reflectionHooks.length, 2, "expected reflection before_prompt_build hooks (priorities 12 and 15)");

  // Sort by priority: lower priority value runs first (invariants=12, derived=15)
  const sorted = [...reflectionHooks].sort((a, b) => (a.meta?.priority ?? 99) - (b.meta?.priority ?? 99));
  const ctx = { sessionKey: `agent:${agentId}:test`, agentId: explicitAgentId };
  const startResult = await sorted[0].handler({}, ctx);   // invariants (priority 12)
  const promptResult = await sorted[1].handler({}, ctx);   // derived (priority 15)

  return { harness, startResult, promptResult };
}

describe("reflection hooks tolerate bypass scope filters", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflection-bypass-hook-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
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
    assert.match(
      startResult?.prependContext || "",
      /Treat as long-term behavioral constraints unless user overrides\.\n\n1\./,
      "inherited-rules block should have a blank line between the header and the first numbered item",
    );
    assert.match(
      promptResult?.prependContext || "",
      /Weighted recent derived execution deltas from reflection memory:\n\n1\./,
      "derived-focus block should have a blank line between the header and the first numbered item",
    );
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

  it("suppresses derived reflection on the fresh prompt after command:new", async () => {
    const pluginConfig = makePluginConfig(workDir);
    await seedReflection(pluginConfig.dbPath, "main");

    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig,
    });

    memoryLanceDBProPlugin.register(harness.api);

    const commandHooks = harness.eventHandlers.get("command:new") || [];
    const reflectionCommandHook = commandHooks.find((hook) =>
      hook.meta?.name === "memory-lancedb-pro.memory-reflection.command-new"
    );
    assert.ok(reflectionCommandHook, "expected memory reflection command:new hook");

    const sessionKey = "agent:main:fresh-after-new";
    await reflectionCommandHook.handler({
      sessionKey,
      timestamp: 1_800_000_000_000,
      action: "command:new",
      context: {},
    }, { sessionKey, agentId: "main" });

    const promptHooks = harness.eventHandlers.get("before_prompt_build") || [];
    const reflectionHooks = promptHooks
      .filter((hook) => hook.meta?.priority === 12 || hook.meta?.priority === 15)
      .sort((a, b) => (a.meta?.priority ?? 99) - (b.meta?.priority ?? 99));

    assert.equal(reflectionHooks.length, 2, "expected reflection before_prompt_build hooks");

    const ctx = { sessionKey, agentId: "main" };
    const inheritedResult = await reflectionHooks[0].handler({}, ctx);
    const derivedResult = await reflectionHooks[1].handler({}, ctx);

    assert.match(inheritedResult?.prependContext || "", /<inherited-rules>/);
    assert.match(inheritedResult?.prependContext || "", /Always verify reflection hook coverage for main\./);
    assert.doesNotMatch(derivedResult?.prependContext || "", /<derived-focus>/);
    assert.ok(
      harness.logs.some(([, msg]) => msg.includes("derived injection suppressed after command:new")),
      "expected derived suppression to be logged",
    );
  });

  it("does not append learning governance entries when reflection generation falls back", async () => {
    const pluginConfig = {
      ...makePluginConfig(workDir),
      selfImprovement: { enabled: true, beforeResetNote: false, ensureLearningFiles: false },
      memoryReflection: {
        storeToLanceDB: false,
        writeLegacyCombined: false,
        timeoutMs: 1,
      },
    };

    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig,
    });
    harness.api.runtime = {
      agent: {
        async runEmbeddedPiAgent() {
          throw new Error("forced embedded fallback");
        },
      },
    };

    memoryLanceDBProPlugin.register(harness.api);

    const sessionFile = path.join(workDir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "Please remember this fallback test." } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on it." } }),
      ].join("\n"),
      "utf-8",
    );

    const originalCliBin = process.env.OPENCLAW_CLI_BIN;
    process.env.OPENCLAW_CLI_BIN = "/usr/bin/false";
    try {
      const commandHooks = harness.eventHandlers.get("command:new") || [];
      const reflectionCommandHook = commandHooks.find((hook) =>
        hook.meta?.name === "memory-lancedb-pro.memory-reflection.command-new"
      );
      assert.ok(reflectionCommandHook, "expected memory reflection command:new hook");

      await reflectionCommandHook.handler({
        sessionKey: "agent:main:fallback-learning-noise",
        timestamp: 1_800_000_000_000,
        action: "command:new",
        context: {
          cfg: pluginConfig,
          workspaceDir: workDir,
          sessionEntry: {
            sessionId: "fallback-session",
            sessionFile,
          },
        },
      }, { sessionKey: "agent:main:fallback-learning-noise", agentId: "main" });
    } finally {
      if (originalCliBin === undefined) delete process.env.OPENCLAW_CLI_BIN;
      else process.env.OPENCLAW_CLI_BIN = originalCliBin;
    }

    const learningsPath = path.join(workDir, ".learnings", "LEARNINGS.md");
    assert.equal(existsSync(learningsPath), false, "fallback reflection should not append .learnings entries");

    const reflectionPath = path.join(
      workDir,
      "memory",
      "reflections",
      "2027-01-15",
      "080000000-main-fallback-session.md",
    );
    const reflectionBody = readFileSync(reflectionPath, "utf-8");
    assert.match(reflectionBody, /## Learning governance candidates \(\.learnings \/ promotion \/ skill extraction\)\n- \(none captured\)/);
    assert.doesNotMatch(reflectionBody, /Investigate last failed tool execution/);
  });
});
