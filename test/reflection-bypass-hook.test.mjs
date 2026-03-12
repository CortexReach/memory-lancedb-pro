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

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
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
      debug() {},
      error() {},
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on(eventName, handler, meta) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta });
      eventHandlers.set(eventName, list);
    },
    registerHook() {},
  };

  return { api, eventHandlers };
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
    it(`does not throw when before_agent_start/before_prompt_build run with agentId=${reservedAgentId}`, async () => {
      const harness = createPluginApiHarness({
        resolveRoot: workDir,
        pluginConfig: {
          dbPath: path.join(workDir, "db"),
          embedding: { apiKey: "test-api-key" },
          sessionStrategy: "memoryReflection",
          smartExtraction: false,
          autoCapture: false,
          autoRecall: false,
          selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
        },
      });

      memoryLanceDBProPlugin.register(harness.api);

      const startHooks = harness.eventHandlers.get("before_agent_start") || [];
      const promptHooks = harness.eventHandlers.get("before_prompt_build") || [];

      assert.ok(startHooks.length >= 1, "expected before_agent_start hooks");
      assert.ok(promptHooks.length >= 1, "expected before_prompt_build hooks");

      for (const { handler } of startHooks) {
        await assert.doesNotReject(async () => {
          await handler({}, { sessionKey: `agent:${reservedAgentId}:test`, agentId: reservedAgentId });
        });
      }

      for (const { handler } of promptHooks) {
        await assert.doesNotReject(async () => {
          await handler({}, { sessionKey: `agent:${reservedAgentId}:test`, agentId: reservedAgentId });
        });
      }
    });
  });
});
