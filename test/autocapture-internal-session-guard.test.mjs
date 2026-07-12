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
const resetRegistration = pluginModule.resetRegistration ?? (() => {});

// The reflection distiller's embedded sub-session key shape
// (see runEmbeddedPiAgent's sessionKey: `temp:memory-reflection:${agentId}`).
const DISTILLER_SESSION_KEY = "temp:memory-reflection:dave";
// A memory sub-completion key shape (isMemorySubsessionKey).
const SUBAGENT_SESSION_KEY = "agent:dave:subagent:recall-1";
const CONTROL_SESSION_KEY = "agent:dave:main";

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = { info: [], warn: [], debug: [] };

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) {
        logs.info.push(String(message));
      },
      warn(message) {
        logs.warn.push(String(message));
      },
      debug(message) {
        logs.debug.push(String(message));
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

// The auto-capture hook is the first agent_end handler the plugin registers
// (the second is the usage-tracking responseText writer). Identify it
// structurally: it is the one that assigns __lastRun when it runs work.
function getAutoCaptureHook(eventHandlers) {
  const hooks = eventHandlers.get("agent_end") || [];
  assert.ok(hooks.length >= 1, "expected at least one agent_end handler");
  return hooks[0].handler;
}

function userMessages(...texts) {
  return texts.map((text) => ({ role: "user", content: text }));
}

describe("auto-capture internal memory sub-session guard", () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "autocapture-guard-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function pluginConfigWithAutoCapture() {
    return {
      dbPath: path.join(workspaceDir, "db"),
      embedding: { apiKey: "test-api-key" },
      smartExtraction: false,
      autoCapture: true,
      autoRecall: false,
      selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    };
  }

  it("skips auto-capture entirely for the reflection distiller's own sub-session", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: pluginConfigWithAutoCapture(),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    hook(
      {
        success: true,
        messages: userMessages(
          "Summarize this session into invariants and derived focus.",
          "## Recent Conversation\nUser prefers rhyming roleplay.",
        ),
      },
      { sessionKey: DISTILLER_SESSION_KEY, agentId: "dave" },
    );

    assert.equal(
      hook.__lastRun,
      undefined,
      "the distiller sub-session must return before any background capture work starts",
    );
    assert.ok(
      harness.logs.debug.some(
        (line) => line.includes("auto-capture skip") && line.includes(DISTILLER_SESSION_KEY),
      ),
      "expected a debug log recording the internal-session skip",
    );
  });

  it("skips auto-capture for memory sub-completion (:subagent:) sessions", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: pluginConfigWithAutoCapture(),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    hook(
      { success: true, messages: userMessages("recall block build content") },
      { sessionKey: SUBAGENT_SESSION_KEY, agentId: "dave" },
    );

    assert.equal(
      hook.__lastRun,
      undefined,
      "memory sub-completions must return before any background capture work starts",
    );
    assert.ok(
      harness.logs.debug.some(
        (line) => line.includes("auto-capture skip") && line.includes(SUBAGENT_SESSION_KEY),
      ),
      "expected a debug log recording the internal-session skip",
    );
  });

  it("proceeds with auto-capture for an ordinary session", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: pluginConfigWithAutoCapture(),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    hook(
      { success: true, messages: userMessages("Remember that I use vitest for this repo.") },
      { sessionKey: CONTROL_SESSION_KEY, agentId: "dave" },
    );

    const backgroundRun = hook.__lastRun;
    assert.ok(
      backgroundRun && typeof backgroundRun.then === "function",
      "an ordinary session must start the background capture run",
    );
    await backgroundRun;

    assert.ok(
      harness.logs.debug.some((line) => line.includes("auto-capture agent_end payload")),
      "an ordinary session must reach the capture pipeline",
    );
    assert.ok(
      !harness.logs.debug.some(
        (line) => line.includes("auto-capture skip") && line.includes(CONTROL_SESSION_KEY),
      ),
      "an ordinary session must not be skipped by the internal-session guard",
    );
  });

  it("falls back to the event sessionKey when ctx carries none", async () => {
    const harness = createPluginApiHarness({
      resolveRoot: workspaceDir,
      pluginConfig: pluginConfigWithAutoCapture(),
    });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = getAutoCaptureHook(harness.eventHandlers);

    hook(
      {
        success: true,
        sessionKey: DISTILLER_SESSION_KEY,
        messages: userMessages("distillate scaffolding text"),
      },
      { agentId: "dave" },
    );

    assert.equal(
      hook.__lastRun,
      undefined,
      "the guard must also catch internal keys carried on the event payload",
    );
  });
});
