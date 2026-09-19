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
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});

const ORDINARY_SESSION_KEY = "agent:agent-one:main";
const DISTILLER_SESSION_KEY = "temp:memory-reflection:agent-one";

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string" || path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe("agent_end auto-capture hands its run back to the host", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-owned-run-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function register() {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: {
        dbPath: path.join(workspaceDir, "db"),
        embedding: { apiKey: "test-api-key" },
        smartExtraction: false,
        autoCapture: true,
        autoRecall: false,
        selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
      },
    });
    memoryLanceDBProPlugin.register(harness.api);
    const registration = (harness.eventHandlers.get("agent_end") || [])[0];
    assert.ok(registration, "expected the auto-capture agent_end registration");
    return { harness, registration };
  }

  it("returns the tracked run so the host keeps the async work scope open until capture finishes", async () => {
    const { registration } = register();
    const hook = registration.handler;

    const returned = hook(
      { success: true, messages: [{ role: "user", content: "ok" }] },
      { sessionKey: ORDINARY_SESSION_KEY, agentId: "agent-one" },
    );

    assert.ok(returned && typeof returned.then === "function", "the hook must return its run");
    assert.equal(returned, hook.__lastRun, "the returned promise is the tracked run");
    await withTimeout(returned, 10_000, "the tracked run");
  });

  it("registers with a hook timeout that covers a slow extraction", () => {
    const { registration } = register();
    assert.equal(registration.meta?.timeoutMs, 120_000);
  });

  it("still returns nothing when the session is skipped before any work starts", () => {
    const { registration } = register();
    const hook = registration.handler;

    const returned = hook(
      { success: true, messages: [{ role: "user", content: "distilled" }] },
      { sessionKey: DISTILLER_SESSION_KEY, agentId: "agent-one" },
    );

    assert.equal(returned, undefined);
    assert.equal(hook.__lastRun, undefined);
  });
});
