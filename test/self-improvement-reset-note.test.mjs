import { afterEach, beforeEach, describe, it } from "node:test";
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
const resetRegistration = pluginModule.resetRegistration ?? (() => {});

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
    autoCapture: false,
    autoRecall: false,
    smartExtraction: false,
    sessionStrategy: "none",
    selfImprovement: {
      enabled: true,
      beforeResetNote: true,
      ensureLearningFiles: false,
    },
    embedding: {
      provider: "openai-compatible",
      apiKey: "test-api-key",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 4,
    },
  };
}

describe("self-improvement reset reminder", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "self-improvement-reset-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("queues a silent reminder after /new without appending a visible note message", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir),
    });
    memoryLanceDBProPlugin.register(harness.api);

    const commandHook = harness.eventHandlers
      .get("command:new")
      ?.find((hook) => hook.meta?.name === "memory-lancedb-pro.self-improvement.command-new");
    assert.ok(commandHook, "expected self-improvement command:new hook");

    const promptHook = harness.eventHandlers
      .get("before_prompt_build")
      ?.find((hook) => hook.meta?.name === "memory-lancedb-pro.self-improvement.before-prompt-build");
    assert.ok(promptHook, "expected self-improvement before_prompt_build hook");

    const messages = ["user content remains user-visible content only"];
    await commandHook.handler({
      action: "command:new",
      sessionKey: "agent:main:test-session",
      timestamp: 1,
      messages,
      context: {},
    });

    assert.deepEqual(messages, ["user content remains user-visible content only"]);

    const result = await promptHook.handler(
      { sessionKey: "agent:main:test-session" },
      { sessionKey: "agent:main:test-session" },
    );
    assert.match(result?.prependContext, /<self-improvement-reminder>/);
    assert.doesNotMatch(result?.prependContext ?? "", /\/note self-improvement/);
    assert.equal(result?.ephemeral, true);

    const secondResult = await promptHook.handler(
      { sessionKey: "agent:main:test-session" },
      { sessionKey: "agent:main:test-session" },
    );
    assert.equal(secondResult, undefined, "reminder should be consumed after one prompt");
  });
});
