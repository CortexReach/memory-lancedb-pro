import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { parsePluginConfig } = pluginModule;
const retrieverModuleForMock = jiti("../src/retriever.js");
const embedderModuleForMock = jiti("../src/embedder.js");
const origCreateRetriever = retrieverModuleForMock.createRetriever;
const origCreateEmbedder = embedderModuleForMock.createEmbedder;


function createPluginApiHarness({ pluginConfig, resolveRoot, debugLogs = [] }) {
  const eventHandlers = new Map();

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
      debug(message) {
        debugLogs.push(String(message));
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

  return { api, eventHandlers };
}

function baseConfig() {
  return {
    embedding: {
      apiKey: "test-api-key",
    },
  };
}

describe("autoRecallExcludeAgents", () => {
  it("defaults to undefined when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallExcludeAgents, undefined);
  });

  it("parses a valid array of agent IDs", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", "maple", "matcha"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple", "matcha"]);
  });

  it("filters out non-string entries", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", null, 123, "maple", undefined, ""],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("filters out whitespace-only strings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["saffron", "   ", "\t", "maple"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("trims agent IDs during parsing", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: [" saffron ", "\tmaple\n"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["saffron", "maple"]);
  });

  it("trims agent IDs during parsing", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: [" saffron ", "\tmaple\n"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("returns empty array for empty array input (not undefined)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: [],
    });
    // Empty array stays as [] — falsy check via length is the right way to handle
    assert.ok(Array.isArray(parsed.autoRecallExcludeAgents));
    assert.equal(parsed.autoRecallExcludeAgents.length, 0);
  });

  it("handles single agent ID", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallExcludeAgents: ["cron-worker"],
    });
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["cron-worker"]);
  });
});

describe("autoRecallIncludeAgents", () => {
  it("defaults to undefined when not specified", () => {
    const parsed = parsePluginConfig(baseConfig());
    assert.equal(parsed.autoRecallIncludeAgents, undefined);
  });

  it("parses a valid array of agent IDs", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("filters out non-string entries", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", null, 123, "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("filters out whitespace-only strings", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron", "   ", "maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron", "maple"]);
  });

  it("returns empty array for empty array input (not undefined)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: [],
    });
    assert.ok(Array.isArray(parsed.autoRecallIncludeAgents));
    assert.equal(parsed.autoRecallIncludeAgents.length, 0);
  });

  it("handles single agent ID (whitelist mode)", () => {
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["sage"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["sage"]);
  });

  it("include takes precedence over exclude in parsing (both specified)", () => {
    // Note: logic precedence is handled at runtime in before_prompt_build,
    // not in the config parser. Parser accepts both.
    const parsed = parsePluginConfig({
      ...baseConfig(),
      autoRecallIncludeAgents: ["saffron"],
      autoRecallExcludeAgents: ["maple"],
    });
    assert.deepEqual(parsed.autoRecallIncludeAgents, ["saffron"]);
    assert.deepEqual(parsed.autoRecallExcludeAgents, ["maple"]);
  });
});

describe("mixed-agent scenarios", () => {
  // Simulate the runtime logic for agent inclusion/exclusion
  function shouldInjectMemory({ agentId, autoRecallIncludeAgents, autoRecallExcludeAgents }) {
    if (agentId === undefined) return true; // no agent context, allow

    // autoRecallIncludeAgents takes precedence (whitelist mode)
    if (Array.isArray(autoRecallIncludeAgents) && autoRecallIncludeAgents.length > 0) {
      return autoRecallIncludeAgents.includes(agentId);
    }

    // Fall back to exclude list (blacklist mode)
    if (Array.isArray(autoRecallExcludeAgents) && autoRecallExcludeAgents.length > 0) {
      return !autoRecallExcludeAgents.includes(agentId);
    }

    return true; // no include/exclude configured, allow all
  }

  it("whitelist mode: only included agents receive auto-recall", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron", "maple"] };
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "matcha", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "cron-worker", ...cfg }), false);
  });

  it("blacklist mode: all agents except excluded receive auto-recall", () => {
    const cfg = { autoRecallExcludeAgents: ["cron-worker", "matcha"] };
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
    assert.equal(shouldInjectMemory({ agentId: "cron-worker", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "matcha", ...cfg }), false);
  });

  it("whitelist takes precedence over blacklist when both set", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron"], autoRecallExcludeAgents: ["saffron", "maple"] };
    // Include wins — saffron is in include list
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), true);
    // Exclude is ignored because include is set
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), false);
  });

  it("no include/exclude: all agents receive auto-recall", () => {
    assert.equal(shouldInjectMemory({ agentId: "saffron" }), true);
    assert.equal(shouldInjectMemory({ agentId: "maple" }), true);
    assert.equal(shouldInjectMemory({ agentId: "matcha" }), true);
  });

  it("agentId='main': whitelist does not match unless main is included", () => {
    const cfg = { autoRecallIncludeAgents: ["saffron"] };
    assert.equal(shouldInjectMemory({ agentId: "main", ...cfg }), false);
  });

  it("empty include list treated as no include configured", () => {
    const cfg = { autoRecallIncludeAgents: [], autoRecallExcludeAgents: ["saffron"] };
    // Empty include array = not configured, fall through to exclude
    assert.equal(shouldInjectMemory({ agentId: "saffron", ...cfg }), false);
    assert.equal(shouldInjectMemory({ agentId: "maple", ...cfg }), true);
  });
});


describe("real before_prompt_build hook", () => {
  it("skips auto-recall for fallback 'main' when whitelist excludes it", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "per-agent-auto-recall-"));
    const debugLogs = [];

    retrieverModuleForMock.createRetriever = function mockCreateRetriever() {
      return {
        async retrieve() {
          throw new Error("retrieve should not run when whitelist blocks agent");
        },
        getConfig() {
          return { mode: "hybrid" };
        },
        setAccessTracker() {},
        setStatsCollector() {},
      };
    };

    embedderModuleForMock.createEmbedder = function mockCreateEmbedder() {
      return {
        async embedQuery() {
          return new Float32Array(384).fill(0);
        },
        async embedPassage() {
          return new Float32Array(384).fill(0);
        },
      };
    };

    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      debugLogs,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: false,
        autoRecall: true,
        autoRecallMinLength: 1,
        autoRecallIncludeAgents: ["saffron"],
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });

    try {
      memoryLanceDBProPlugin.register(harness.api);
      const hooks = harness.eventHandlers.get("before_prompt_build") || [];
      assert.equal(hooks.length, 1, "expected one before_prompt_build hook");
      const [{ handler: autoRecallHook }] = hooks;

      const output = await autoRecallHook(
        { prompt: "Please recall my preferences.", sessionKey: "agent:main:session:test-main" },
        { sessionId: "test-main", sessionKey: "agent:main:session:test-main" },
      );

      assert.equal(output, undefined);
      assert.ok(
        debugLogs.some((line) => line.includes("auto-recall skipped for agent 'main' not in autoRecallIncludeAgents")),
        "expected whitelist skip debug log for fallback 'main'",
      );
    } finally {
      retrieverModuleForMock.createRetriever = origCreateRetriever;
      embedderModuleForMock.createEmbedder = origCreateEmbedder;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
